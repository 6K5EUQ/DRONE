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
let SERVICE = false, KEY = '', SECRET = null, SUGANG_URL = '', SUGANG_LOGOUT = '', ORIGINS = new Set();
let PICKUP_WAIT = 300, DEST_WAIT = 600;

const COOKIE = '__Host-dlv';
const SESSION_S = 12 * 3600;
const JSON_TYPE = 'application/json; charset=utf-8';

// ── 배송 지점 — 고정 목록 ───────────────────────────────────────────
// 아무 데나 찍어 추가하지 않고, 관리자 화면·계정도 두지 않는다(2026-10-07 결정).
// 지점·좌표·기지는 **이 소스에서만** 바뀐다 — 고치고 배포한다.
// 좌표 — 사용자 제공 2026-10-07. 기체 GPS 실측이 아니다 — 자동비행(P3) 전에는 실측값으로 바꾼다.
// 기지(충전·보관, 배송 출발·복귀) = 대운동장 (2026-10-07 사용자가 보여 준 출발 지점)
const CATALOG = [
  { id: 'main', name: '본관', lat: 35.180747, lon: 128.554772 },
  { id: 'field', name: '대운동장', lat: 35.181070, lon: 128.553811, base: true },
  { id: 'hwayoung', name: '화영운동장', lat: 35.183980, lon: 128.554076 },
  { id: 'eng', name: '공학관', lat: 35.179436, lon: 128.554206 },
  { id: 'hanma', name: '한마관', lat: 35.182636, lon: 128.552627 },
  { id: 'lib', name: '도서관', lat: 35.181296, lon: 128.552923 },
];
/** 지점은 저장하지 않고 늘 소스의 목록에서 만든다. 옛 저장본의 지점(지도로 찍던 시절)은 버린다 */
function syncCatalog() {
  const gone = S.points.filter((p) => !CATALOG.some((c) => c.id === p.id));
  S.points = CATALOG.map((c) => ({ id: c.id, name: c.name, lat: c.lat ?? null, lon: c.lon ?? null, alt: null, base: !!c.base }));
  if (gone.length) {
    C.log('배송 지점 고정 목록 밖이라 버림:', gone.map((p) => p.name).join(', '));
    const j = S.job;
    if (j && [j.pickup, j.dest, j.at].some((id) => id && !pt(id))) { C.log('그 지점을 쓰던 배송도 끝냄', j.id); S.job = null; }
  }
}
const placed = (p) => p && p.lat != null && p.lon != null;

// ── 저장 ────────────────────────────────────────────────────────────
function blank() { return { v: 1, rev: 0, seq: 0, points: [], job: null }; }
function load() {
  try { S = { ...blank(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') C.log('배송 상태를 못 읽었다 — 새로 시작', e.message); S = blank(); }
  delete S.users;   // 이름을 모으던 때의 흔적 — 화면이 학번만 쓰므로 버린다 (2026-10-07)
  syncCatalog();
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
function sign(u, n) {
  const p = b64(JSON.stringify({ u, n: n || null, exp: Math.floor(Date.now() / 1000) + SESSION_S }));
  return p + '.' + mac(p);
}
function verify(tok) {
  const [p, m] = String(tok || '').split('.');
  if (!p || !m) return null;
  const a = Buffer.from(m), b = Buffer.from(mac(p));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    return o.exp > Date.now() / 1000 ? { u: o.u, n: o.n || null } : null;
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
/** 누가 부르나 — 기체(키), 로그인 사용자, 또는 null */
function who(req) {
  if (req.headers['x-delivery-key']) return keyOk(req.headers['x-delivery-key']) ? { id: 'drone', drone: true } : null;
  const v = verify(cookieOf(req, COOKIE));
  return v ? { id: v.u, name: v.n, drone: false } : null;
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
 * 2026-10-07 실계정 실측(tools/delivery/sugang_probe.js): 맞든 틀리든 POST 는 200 이고
 * 로그인 폼이 다시 나온다 — 리다이렉트도 폼 유무도 신호가 아니다. 갈리는 것은 쿠키다.
 *   맞음  → Set-Cookie: ASP.NET_SessionId, **.ASPXAUTH** (ASP.NET 폼 인증 표)
 *   틀림  → 쿠키 없음, alert "사용자 비밀번호가 일치하지 않습니다."
 * 표가 비어 있으면(지우는 쿠키) 성공으로 보지 않는다.
 */
function judge(status, setCookies, html) {
  const auth = (setCookies || []).some((c) => /^\.ASPXAUTH=[^;\s]+/i.test(c));
  if (status === 200 && auth) return 'ok';
  if (status === 200 && !auth && /name=["']?txtPassword/i.test(html)) return 'bad';
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
  const verdict = judge(p.status, p.headers.getSetCookie ? p.headers.getSetCookie() : [], p.status === 200 ? await decode(p) : '');
  let name = null;
  if (verdict === 'ok') {
    const auth = { ...opt.headers, Cookie: [...cookies, ...jar(p)].join('; ') };
    // 이름 — 로그인 뒤 상단 틀(Top.aspx)의 인사 「… 박준서 님 반갑습니다.」 에서 이름만 (2026-10-07 실측).
    // 🔴 신상 페이지(SLW001S: 생년월일 등)는 열지 않는다 — 필요한 것은 이름뿐이다. 이름은 쿠키와 그 사람의 배송에만 남는다.
    try {
      const t = await fetch(new URL('Top.aspx', SUGANG_URL), { ...opt, signal: AbortSignal.timeout(5000), headers: auth });
      if (t.status === 200) name = nameFrom(await decode(t));
    } catch { /* 이름 없이도 로그인은 된다 */ }
    // 사용자의 수강신청 세션과 겹치지 않게 바로 끊는다 (Logout.aspx 실측)
    fetch(SUGANG_LOGOUT || new URL('Logout.aspx', SUGANG_URL), { ...opt, signal: AbortSignal.timeout(5000), headers: auth }).catch(() => {});
  }
  return { v: verdict, name };
}
/** 「AI·SW융합대학 컴퓨터공학부 컴퓨터보안 박준서 님 반갑습니다.」 → 박준서 */
function nameFrom(html) {
  const t = html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const m = /([가-힣]{2,10})\s*님\s*반갑습니다/.exec(t);
  return m ? m[1] : null;
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
  let r;
  try { r = await sugangCheck(id, pw); }
  catch (e) { r = { v: 'error' }; C.log('학교 로그인 요청 실패', e.name); }
  finally { inflight = false; }
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  if (r.v === 'bad') { f.push(now); fails.set(id, f); C.log('배송 로그인 실패', id, ip); return json(req, res, 401, { error: 'auth' }); }
  if (r.v !== 'ok') { C.log('배송 로그인 판정 불가', r.v, id); return json(req, res, 502, { error: 'school' }); }
  fails.delete(id);
  C.log('배송 로그인', id, ip);
  return json(req, res, 200, { id, name: r.name }, { 'Set-Cookie': setCookie(sign(id, r.name), SESSION_S) });
}

// ── 배송 상태머신 ───────────────────────────────────────────────────
// 상태 = leg(pickup·dest·home) × phase(wait·fly·landed). 기체 쪽 동작은 depart·land 둘뿐이다.
const pt = (id) => S.points.find((p) => p.id === id) || null;
const base = () => S.points.find((p) => p.base) || null;
const target = (j) => j.leg === 'pickup' ? j.pickup : j.leg === 'dest' ? j.dest : base() && base().id;
const isReq = (a, j) => a && j && a.id === j.by;

/**
 * 기체가 부를 수 있는 상태인가 — 링크가 살아 있고(12초 안, server.js LIVE_STALE_MS 와 같다), GPS 3D fix,
 * 전압 14.0 V 이상(4S 3.5 V/셀 — 00-progress #4 의 권장 저전압 임계). 하나라도 아니면 「사용 불가」.
 * 배터리 % 는 쓰지 않는다 — ArduCopter 3.6.12 는 배터리를 떼도 99 % 를 보낸다(2026-09-21 실측).
 */
const READY_VOLT = 14.0, LIVE_FRESH_MS = 12000;
function ready() {
  const L = C.getLive(), d = L && L.state && L.state.d;
  return !!(d && Date.now() - L.at <= LIVE_FRESH_MS && d.fix >= 3 && d.volt >= READY_VOLT);
}
/** 화면 오른쪽 위 상태 — 사용 중 / 대기 중 / 사용 불가 */
const status = () => S.job ? 'busy' : SERVICE && ready() ? 'ready' : 'down';

/** 지금 이 사람이 누를 수 있는 동작 — 화면은 이것만 그린다. 출발·착륙은 기체(키)만.
 *  받는 사람은 정하지 않는다 — 학번으로 로그인한 사람이면 누구나 목적지에서 받을 수 있다. */
function can(a) {
  const j = S.job, out = [];
  if (!a || a.drone) return out;
  if (status() === 'ready') out.push('call');
  if (j) {
    if (j.leg === 'pickup' && j.phase === 'landed' && isReq(a, j)) out.push('send');
    if (j.leg === 'dest' && j.phase === 'landed') out.push('done');
    if (j.leg === 'pickup' && isReq(a, j)) out.push('cancel');
  }
  return out;
}

/** 사용자(호출한 사람의 이름·학번)는 로그인한 모두에게 보인다 — 지금 누가 쓰는지 알아야 한다 */
function view(a) {
  const j = S.job;
  return {
    rev: S.rev, service: SERVICE, status: status(),
    me: a && !a.drone ? { id: a.id, name: a.name } : null,
    points: a ? S.points : [],
    job: !j ? null : a ? j : { leg: j.leg, phase: j.phase },
    can: can(a),
  };
}

function finish(how, by) {
  logLine({ rev: S.rev, act: 'end', by, how, job: S.job.id, flags: S.job.flags });
  S.job = null;
}


const ACTS = new Set(['call', 'depart', 'land', 'send', 'done', 'cancel']);
/** 동작 하나. 검사→변경→저장이 await 없이 한 번에 돈다 — 동시에 눌러도 섞이지 않는다. 반환은 [status, error?] */
function apply(a, b) {
  const act = b.act, j = S.job, now = Date.now();
  if (!ACTS.has(act)) return [400, 'act'];
  if (!can(a).includes(act) && !(a.drone && ['depart', 'land'].includes(act))) {
    if (act === 'call' && !SERVICE) return [503, 'off'];
    if (act === 'call' && j) return [409, 'busy'];
    if (act === 'call') return [409, 'down'];
    return [a.drone ? 409 : 403, 'stage'];
  }
  if (a.drone && j == null) return [409, 'stage'];
  if (a.drone && act === 'depart' && j.phase !== 'wait') return [409, 'stage'];
  if (a.drone && act === 'land' && j.phase !== 'fly') return [409, 'stage'];
  const from = j ? [j.leg, j.phase] : null;

  switch (act) {
    case 'call': {
      const p = pt(b.point);
      if (!p || p.base) return [400, 'point'];
      if (!placed(p)) return [400, 'nocoord'];
      if (!placed(base())) return [409, 'nobase'];
      S.job = { id: 'j' + (++S.seq), by: a.id, by_name: a.name || null, pickup: p.id, dest: null, at: base().id,
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
      const p = pt(b.point);
      if (!p || p.base || p.id === j.pickup) return [400, 'point'];
      if (!placed(p)) return [400, 'nocoord'];
      Object.assign(j, { dest: p.id, leg: 'dest', phase: 'wait', since: now, deadline: null });
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
    default: return [400, 'act'];
  }
  S.rev++;
  logLine({ rev: S.rev, act, by: a.id, from, to: S.job ? [S.job.leg, S.job.phase] : null, job: S.job ? S.job.id : null });
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
  SERVICE = env.DELIVERY_SERVICE === 'on';   // 실제 배송 접수 — 조종사·기체가 준비된 때만 켠다. 테스트 탭과는 무관
  KEY = env.DELIVERY_KEY || '';
  SUGANG_URL = env.SUGANG_URL || '';
  SUGANG_LOGOUT = env.SUGANG_LOGOUT || '';
  ORIGINS = new Set(String(env.DELIVERY_ORIGINS || 'https://drone01.bewe.co.kr').split(',').map((x) => x.trim()).filter(Boolean));
  PICKUP_WAIT = parseInt(env.PICKUP_WAIT || '300', 10);
  DEST_WAIT = parseInt(env.DEST_WAIT || '600', 10);
  if (env.DELIVERY_SECRET) SECRET = Buffer.from(env.DELIVERY_SECRET);
  else { SECRET = crypto.randomBytes(32); ctx.log('⚠️  DELIVERY_SECRET 미설정 — 재시작하면 배송 로그인이 모두 풀린다'); }
  if (!SUGANG_URL) ctx.log('⚠️  SUGANG_URL 미설정 — 배송 로그인이 막힌 채로 뜬다');
  if (!SERVICE) ctx.log('배송 운행 꺼짐 (DELIVERY_SERVICE=on 으로 켠다)');
  load();
  setInterval(tick, 5000).unref();
}

function health() {
  return { login: SUGANG_URL ? 'enabled' : 'disabled', service: SERVICE, status: status(), job: !!S.job, points: S.points.length };
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

module.exports = { init, handle, health, judge, hidden, nameFrom };
