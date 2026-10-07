// 교내 배송 — 학교 계정 대리 로그인 + 배송 상태머신.
//
// 설계: docs/design/02-delivery-system.md. server.js 의 route() 가 맨 앞에서
// handle() 을 부르고, 이 파일이 /api/auth/* 와 /api/delivery/* 를 맡는다.
//
// 🔴 **기체로 명령을 보내지 않는다.** 기체 쪽 전이(출발·착륙)는 관리자가 누르거나,
//    나중에 기체의 Pi 가 X-Delivery-Key 로 같은 act 를 부른다. Pi 는 /api/delivery/job
//    을 **폴링**해 일감을 가져간다 — LTE 는 NAT 뒤라 서버가 기체로 접속할 수 없다.
//
// 🔴 학교 비밀번호는 학교로 보내는 요청 하나에만 쓴다. 저장·기록·응답에 남기지 않는다.
//    세션은 서명 쿠키라 서버에 세션 파일이 없다.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let C = null;          // init 이 넘긴 것 — dataDir, send, readBody, getLive, log
let FILE = '', LOGF = '';
let S = null;          // 저장되는 상태
let ADMINS = new Set(), KEY = '', SECRET = null, SUGANG_URL = '', SUGANG_LOGOUT = '', ORIGINS = new Set();
let PICKUP_WAIT = 300, DEST_WAIT = 600;

const COOKIE = '__Host-dlv';
const SESSION_S = 12 * 3600;
const LIVE_FRESH_MS = 12000;      // server.js LIVE_STALE_MS 와 같다
const JSON_TYPE = 'application/json; charset=utf-8';

// ── 저장 ────────────────────────────────────────────────────────────
function blank() { return { v: 1, rev: 0, seq: 0, service: false, points: [], job: null }; }
function load() {
  try { S = { ...blank(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') C.log('배송 상태를 못 읽었다 — 새로 시작', e.message); S = blank(); }
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(S));
  fs.renameSync(tmp, FILE);
}
function logLine(o) { fs.appendFileSync(LOGF, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); }

// ── 응답 ────────────────────────────────────────────────────────────
const json = (req, res, status, obj, extra = {}) =>
  C.send(req, res, status, JSON.stringify(obj), JSON_TYPE, { 'Cache-Control': 'no-store', ...extra });

async function body(req) {
  try { return JSON.parse((await C.readBody(req, 16 * 1024)).toString('utf8') || '{}'); }
  catch { return null; }
}

// ── 세션 ────────────────────────────────────────────────────────────
const b64 = (b) => Buffer.from(b).toString('base64url');
const mac = (s) => crypto.createHmac('sha256', SECRET).update(s).digest('base64url');
function sign(u) {
  const p = b64(JSON.stringify({ u, exp: Math.floor(Date.now() / 1000) + SESSION_S }));
  return p + '.' + mac(p);
}
function verify(tok) {
  const [p, m] = String(tok || '').split('.');
  if (!p || !m) return null;
  const a = Buffer.from(m), b = Buffer.from(mac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return o.exp > Date.now() / 1000 ? o.u : null;
  } catch { return null; }
}
function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function keyOk(given) {
  if (!KEY) return false;
  const a = Buffer.from(String(given || '')), b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** 누가 부르나 — 기체(키), 로그인 사용자, 또는 null. 관리자 여부는 매번 .env 로 다시 본다. */
function who(req) {
  if (req.headers['x-delivery-key']) return keyOk(req.headers['x-delivery-key']) ? { id: 'drone', drone: true, admin: false } : null;
  const u = verify(cookieOf(req, COOKIE));
  return u ? { id: u, admin: ADMINS.has(u), drone: false } : null;
}
const setCookie = (v, age) => `${COOKIE}=${v}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;

// 쿠키로 인증하는 POST 의 CSRF 막이. shade01.bewe.co.kr 가 같은 사이트라 SameSite 만으로는 모자란다.
function postGuard(req, res) {
  if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) { json(req, res, 415, { error: 'json' }); return false; }
  const o = req.headers.origin;
  if (o) {
    let host = null;
    try { host = new URL(o).host; } catch { /* 깨진 Origin */ }
    if (!ORIGINS.has(o) && host !== req.headers.host) { json(req, res, 403, { error: 'origin' }); return false; }
  }
  return true;
}

// ── 학교 대리 로그인 ────────────────────────────────────────────────
// 시도 제한 — 학교 계정 잠금 기준을 모르니 보수적으로. 터널 뒤라 IP 는 cf-connecting-ip.
const fails = new Map();          // id → [실패 시각]
let tries = [];                   // 학교로 나간 요청 시각 (전역)
let inflight = false;
const FAIL_MAX = 3, FAIL_WIN = 15 * 60e3, TRY_MAX = 30, TRY_WIN = 10 * 60e3;

function hidden(html) {
  const out = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    if (!/type=["']?hidden/i.test(tag)) continue;
    const n = /\bname=["']([^"']+)/i.exec(tag), v = /\bvalue=["']([^"']*)/i.exec(tag);
    if (n) out[n[1]] = v ? v[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
  }
  return out;
}
const jar = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split(';')[0]).filter(Boolean);
const decode = async (r) => new TextDecoder('euc-kr').decode(await r.arrayBuffer());

/**
 * 학교 로그인 결과 판정 — fail-closed.
 * 🔶 성공 신호는 실계정으로 아직 실측 전이다 (tools/delivery/sugang_probe.js 로 잰다).
 *    그래서 SUGANG_URL 이 비어 있으면 로그인 자체를 막는다. 실측 후 이 함수를 맞춘다.
 */
function judge(status, location, html) {
  if (status >= 300 && status < 400 && location && !/default\.aspx/i.test(location.split('?')[0])) return 'ok';
  if (status === 200 && /name=["']?txtPassword/i.test(html)) return 'bad';
  return 'unknown';
}

async function sugangCheck(id, pw) {
  const opt = { redirect: 'manual', signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0 (drone01 delivery)' } };
  const g = await fetch(SUGANG_URL, opt);
  const page = await decode(g);
  const form = new URLSearchParams({ ...hidden(page), txtUserID: id, txtPassword: pw, 'ibtnLogin.x': '12', 'ibtnLogin.y': '9' });
  const cookies = jar(g);
  const p = await fetch(SUGANG_URL, {
    ...opt, method: 'POST', signal: AbortSignal.timeout(8000), body: form.toString(),
    headers: { ...opt.headers, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookies.length ? { Cookie: cookies.join('; ') } : {}) },
  });
  const verdict = judge(p.status, p.headers.get('location'), p.status === 200 ? await decode(p) : '');
  // 사용자의 수강신청 세션과 겹치지 않게 바로 끊는다 (주소는 실측 후 .env 에)
  if (verdict === 'ok' && SUGANG_LOGOUT) {
    const all = [...cookies, ...jar(p)];
    fetch(SUGANG_LOGOUT, { ...opt, signal: AbortSignal.timeout(5000), headers: { ...opt.headers, Cookie: all.join('; ') } }).catch(() => {});
  }
  return verdict;
}

async function login(req, res) {
  if (!postGuard(req, res)) return;
  const b = await body(req);
  const id = b && String(b.id || '').trim(), pw = b && String(b.pw || '');
  // 학교 폼이 EUC-KR 이라 ASCII 밖은 그대로 못 보낸다
  if (!id || !/^[A-Za-z0-9]{3,20}$/.test(id) || !pw || !/^[\x20-\x7e]{1,64}$/.test(pw)) return json(req, res, 400, { error: 'input' });
  if (!SUGANG_URL) return json(req, res, 503, { error: 'login-off' });
  const now = Date.now();
  const f = (fails.get(id) || []).filter((t) => now - t < FAIL_WIN);
  tries = tries.filter((t) => now - t < TRY_WIN);
  if (f.length >= FAIL_MAX) return json(req, res, 429, { error: 'rate', retry: Math.ceil((f[0] + FAIL_WIN - now) / 1000) });
  if (tries.length >= TRY_MAX) return json(req, res, 429, { error: 'rate', retry: Math.ceil((tries[0] + TRY_WIN - now) / 1000) });
  if (inflight) return json(req, res, 429, { error: 'busy', retry: 2 });
  inflight = true; tries.push(now);
  let verdict;
  try { verdict = await sugangCheck(id, pw); }
  catch (e) { verdict = 'error'; C.log('학교 로그인 요청 실패', e.name); }
  finally { inflight = false; }
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  if (verdict === 'bad') { f.push(now); fails.set(id, f); C.log('배송 로그인 실패', id, ip); return json(req, res, 401, { error: 'auth' }); }
  if (verdict !== 'ok') { C.log('배송 로그인 판정 불가', verdict, id); return json(req, res, 502, { error: 'school' }); }
  fails.delete(id);
  C.log('배송 로그인', id, ADMINS.has(id) ? '(관리자)' : '', ip);
  return json(req, res, 200, { id, admin: ADMINS.has(id) }, { 'Set-Cookie': setCookie(sign(id), SESSION_S) });
}

// ── 배송 상태머신 ───────────────────────────────────────────────────
// 상태 = leg(pickup·dest·home) × phase(wait·fly·landed). 기체 쪽 동작은 depart·land 둘뿐이다.
const pt = (id) => S.points.find((p) => p.id === id) || null;
const base = () => S.points.find((p) => p.base) || null;
const target = (j) => j.leg === 'pickup' ? j.pickup : j.leg === 'dest' ? j.dest : base() && base().id;
const isReq = (a, j) => a && j && a.id === j.by;

/** 지금 이 사람이 누를 수 있는 동작 — 화면은 이것만 그린다 */
function can(a) {
  const j = S.job, out = [];
  if (!a || a.drone) return out;
  if (!j && S.service) out.push('call');
  if (j) {
    if (a.admin && j.phase === 'wait') out.push('depart');
    if (a.admin && j.phase === 'fly') out.push('land');
    if (j.leg === 'pickup' && j.phase === 'landed' && (isReq(a, j) || a.admin)) out.push('send');
    if (j.leg === 'dest' && j.phase === 'landed' && (a.id === j.to || isReq(a, j) || a.admin)) out.push('done');
    if (j.leg !== 'home' && (a.admin || (isReq(a, j) && j.leg === 'pickup'))) out.push('cancel');
  }
  if (a.admin) out.push('service', 'pt_add', 'pt_set', 'pt_del', 'pt_measure');
  return out;
}

function view(a) {
  const j = S.job;
  const mine = a && (a.admin || (j && (a.id === j.by || a.id === j.to)));
  return {
    rev: S.rev, service: S.service,
    me: a && !a.drone ? { id: a.id, admin: a.admin } : null,
    points: a ? S.points : [],
    job: !j ? null : a ? { ...j, by: mine ? j.by : '***', to: mine ? j.to : (j.to ? '***' : null),
                           flags: mine ? j.flags : j.flags.map((f) => f.split(':')[0]) } : { leg: j.leg, phase: j.phase },
    can: can(a),
  };
}

function finish(how, by) {
  logLine({ rev: S.rev, act: 'end', by, how, job: S.job.id, flags: S.job.flags });
  S.job = null;
}

const NAME_RE = /^[^\x00-\x1f<>]{1,20}$/;
const latOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -90 && v <= 90;
const lonOk = (v) => typeof v === 'number' && Number.isFinite(v) && v >= -180 && v <= 180;
const ID_RE = /^[A-Za-z0-9]{3,20}$/;

/** 동작 하나. 검사→변경→저장이 await 없이 한 번에 돈다 — 동시에 눌러도 섞이지 않는다. 반환은 [status, error?] */
function apply(a, b) {
  const act = b.act, j = S.job, now = Date.now();
  if (!can(a).includes(act) && !(a.drone && ['depart', 'land'].includes(act))) {
    if (act === 'call' && !S.service) return [503, 'off'];
    if (act === 'call' && j) return [409, 'busy'];
    return [a.admin || a.drone ? 409 : 403, 'stage'];
  }
  if (a.drone && j == null) return [409, 'stage'];
  if (a.drone && act === 'depart' && j.phase !== 'wait') return [409, 'stage'];
  if (a.drone && act === 'land' && j.phase !== 'fly') return [409, 'stage'];
  const from = j ? [j.leg, j.phase] : null;

  switch (act) {
    case 'call': {
      const p = pt(b.point);
      if (!p || p.base) return [400, 'point'];
      if (!base()) return [409, 'nobase'];
      if (!p.verified && !a.admin) return [403, 'unverified'];
      S.job = { id: 'j' + (++S.seq), by: a.id, to: null, pickup: p.id, dest: null, at: base().id,
                leg: 'pickup', phase: 'wait', since: now, deadline: null, flags: [] };
      break;
    }
    case 'depart': j.phase = 'fly'; j.since = now; j.deadline = null; break;
    case 'land':
      j.phase = 'landed'; j.since = now; j.at = target(j);
      if (j.leg === 'home') { S.rev++; logLine({ rev: S.rev, act, by: a.id, from, to: ['home', 'landed'], job: j.id }); finish('home', a.id); save(); return [200]; }
      j.deadline = now + (j.leg === 'pickup' ? PICKUP_WAIT : DEST_WAIT) * 1000;
      break;
    case 'send': {
      const p = pt(b.point), to = String(b.to || '').trim();
      if (!p || p.base || p.id === j.pickup) return [400, 'point'];
      if (!p.verified && !a.admin) return [403, 'unverified'];
      if (!ID_RE.test(to)) return [400, 'to'];
      Object.assign(j, { dest: p.id, to, leg: 'dest', phase: 'wait', since: now, deadline: null });
      break;
    }
    case 'done':
      j.flags.push('delivered:' + a.id);
      Object.assign(j, { leg: 'home', phase: 'wait', since: now, deadline: null });
      break;
    case 'cancel':
      if (j.leg === 'pickup' && j.phase === 'wait') { S.rev++; logLine({ rev: S.rev, act, by: a.id, from, to: null, job: j.id }); finish('cancel', a.id); save(); return [200]; }
      j.flags.push('cancel:' + a.id);
      Object.assign(j, { leg: 'home', phase: j.phase === 'fly' ? 'fly' : 'wait', since: now, deadline: null });
      break;
    case 'service':
      S.service = !!b.on;
      break;
    case 'pt_add': {
      const name = String(b.name || '').trim();
      if (!NAME_RE.test(name) || !latOk(b.lat) || !lonOk(b.lon)) return [400, 'input'];
      S.points.push({ id: 'p' + (++S.seq), name, lat: b.lat, lon: b.lon, alt: null, base: false, verified: false });
      break;
    }
    case 'pt_set': {
      const p = pt(b.point);
      if (!p) return [400, 'point'];
      if (b.name !== undefined) { const n = String(b.name).trim(); if (!NAME_RE.test(n)) return [400, 'input']; p.name = n; }
      if (b.lat !== undefined || b.lon !== undefined) {
        if (!latOk(b.lat) || !lonOk(b.lon)) return [400, 'input'];
        if (j && [j.pickup, j.dest, j.at].includes(p.id)) return [409, 'inuse'];
        Object.assign(p, { lat: b.lat, lon: b.lon, alt: null, verified: false, measured: null });   // 옮기면 실측이 무효
      }
      if (b.base === true) {
        if (j) return [409, 'inuse'];
        for (const q of S.points) q.base = q === p;
      }
      break;
    }
    case 'pt_del': {
      const p = pt(b.point);
      if (!p) return [400, 'point'];
      if (j && ([j.pickup, j.dest, j.at].includes(p.id) || p.base)) return [409, 'inuse'];
      S.points = S.points.filter((q) => q !== p);
      break;
    }
    case 'pt_measure': {
      // 기체를 그 자리에 두고 누른다 — 라이브 GPS 를 그대로 지점 좌표로 쓴다
      const p = pt(b.point), L = C.getLive(), d = L && L.state && L.state.d;
      if (!p) return [400, 'point'];
      if (!d || now - L.at > LIVE_FRESH_MS || !(d.fix >= 3) || d.lat == null || d.lon == null) return [409, 'nofix'];
      if (j && [j.pickup, j.dest, j.at].includes(p.id)) return [409, 'inuse'];
      Object.assign(p, { lat: d.lat, lon: d.lon, alt: d.alt_msl ?? null, verified: true,
                         measured: { at: new Date(now).toISOString(), sats: d.sats ?? null, eph: d.eph ?? null } });
      break;
    }
    default: return [400, 'act'];
  }
  S.rev++;
  logLine({ rev: S.rev, act, by: a.id, from, to: S.job ? [S.job.leg, S.job.phase] : null, job: S.job ? S.job.id : null,
            ...(act.startsWith('pt_') || act === 'service' ? { arg: { point: b.point, name: b.name, lat: b.lat, lon: b.lon, base: b.base, on: b.on } } : {}) });
  save();
  return [200];
}

/** 착륙 뒤 아무도 안 오면 기지로 돌려보낸다 */
function tick() {
  const j = S && S.job;
  if (!j || j.phase !== 'landed' || !j.deadline || Date.now() < j.deadline) return;
  const from = [j.leg, j.phase];
  j.flags.push('timeout:' + j.leg);
  Object.assign(j, { leg: 'home', phase: 'wait', since: Date.now(), deadline: null });
  S.rev++;
  logLine({ rev: S.rev, act: 'timeout', by: 'server', from, to: ['home', 'wait'], job: j.id });
  save();
}

async function act(req, res) {
  const a = who(req);
  if (!a) return json(req, res, 401, { error: 'login' });
  if (!a.drone && !postGuard(req, res)) return;
  const b = await body(req);
  if (!b || typeof b.act !== 'string') return json(req, res, 400, { error: 'act' });
  tick();
  if (b.rev !== S.rev) return json(req, res, 409, { error: 'stale', state: view(a) });
  const [status, error] = apply(a, b);
  if (status !== 200) return json(req, res, status, { error, state: view(a) });
  return json(req, res, 200, view(a));
}

/** 기체(Pi)가 가져가는 일감 — 지금 구간의 출발·도착 좌표 */
function job(req, res) {
  if (!keyOk(req.headers['x-delivery-key'])) return json(req, res, 403, { error: 'key' });
  tick();
  const j = S.job, P = (id) => { const p = pt(id); return p && { id: p.id, name: p.name, lat: p.lat, lon: p.lon, alt: p.alt }; };
  return json(req, res, 200, { rev: S.rev, job: j && { id: j.id, leg: j.leg, phase: j.phase, from: P(j.at), to: P(target(j)) } });
}

// ── 바깥 ────────────────────────────────────────────────────────────
function init(ctx) {
  C = ctx;
  const env = ctx.env;
  FILE = path.join(ctx.dataDir, 'delivery.json');
  LOGF = path.join(ctx.dataDir, 'delivery-log.jsonl');
  ADMINS = new Set(String(env.DELIVERY_ADMINS || '').split(',').map((x) => x.trim()).filter(Boolean));
  KEY = env.DELIVERY_KEY || '';
  SUGANG_URL = env.SUGANG_URL || '';
  SUGANG_LOGOUT = env.SUGANG_LOGOUT || '';
  ORIGINS = new Set(String(env.DELIVERY_ORIGINS || 'https://drone01.bewe.co.kr').split(',').map((x) => x.trim()).filter(Boolean));
  PICKUP_WAIT = parseInt(env.PICKUP_WAIT || '300', 10);
  DEST_WAIT = parseInt(env.DEST_WAIT || '600', 10);
  if (env.DELIVERY_SECRET) SECRET = Buffer.from(env.DELIVERY_SECRET);
  else { SECRET = crypto.randomBytes(32); ctx.log('⚠️  DELIVERY_SECRET 미설정 — 재시작하면 배송 로그인이 모두 풀린다'); }
  if (!SUGANG_URL) ctx.log('⚠️  SUGANG_URL 미설정 — 배송 로그인이 막힌 채로 뜬다');
  if (!ADMINS.size) ctx.log('⚠️  DELIVERY_ADMINS 미설정 — 배송 관리자가 없다');
  load();
  setInterval(tick, 5000).unref();
}

function health() {
  return { login: SUGANG_URL ? 'enabled' : 'disabled', service: S.service, job: !!S.job, points: S.points.length };
}

/** 맞는 경로면 처리하고 promise, 아니면 false */
function handle(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p === '/api/auth/login' && m === 'POST') return login(req, res);
  if (p === '/api/auth/logout' && m === 'POST') {
    if (!postGuard(req, res)) return Promise.resolve();
    res.writeHead(204, { 'Set-Cookie': setCookie('', 0), 'Cache-Control': 'no-store' }).end();
    return Promise.resolve();
  }
  if (p === '/api/delivery/state' && m === 'GET') { tick(); return Promise.resolve(json(req, res, 200, view(who(req)))); }
  if (p === '/api/delivery/act' && m === 'POST') return act(req, res);
  if (p === '/api/delivery/job' && m === 'GET') return Promise.resolve(job(req, res));
  if (p.startsWith('/api/auth/') || p.startsWith('/api/delivery/')) return Promise.resolve(json(req, res, 404, { error: 'route' }));
  return false;
}

module.exports = { init, handle, health, judge, hidden };
