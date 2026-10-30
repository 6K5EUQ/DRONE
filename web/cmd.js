// 웹 → 기체 명령 대기열 (1단계 — 서버 대기열과 인증만).
//
// 파이는 LTE NAT 뒤라 서버가 파이로 접속할 수 없다. 그래서 파이가 GET /api/cmd/next 를
// **롱폴**로 걸어 두고 명령을 가져가고, 결과는 POST /api/cmd/:id/ack 로 올린다.
// server.js 의 route() 가 delivery.handle() 다음에 handle() 을 부른다.
//
// 🔴 이 단계에는 명령을 FC 로 보내는 코드가 없다. 파이 쪽 에이전트가 생기기 전까지 이 대기열을
//    가져갈 것은 시험용 가짜 에이전트뿐이다.
//
// 🔴 인증은 셋이 따로다. 웹 사용자 = 배송 로그인 쿠키(__Host-dlv) + CMD_OPERATORS(학번 목록),
//    파이 = CMD_KEY(X-Cmd-Key). LIVE_PUSH_KEY·DELIVERY_KEY 는 이 경로에서 받지 않는다.
//
// 대기열은 메모리에만 둔다. 기록은 DATA_DIR/cmd-log.jsonl 에 추가만 한다.
// 재시작하면 끝나지 않은 명령은 전부 expired 로 기록하고 버린다 — 옛 ARM 이 다시 나가지 않게.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let C = null;          // init 이 넘긴 것 — dataDir, env, send, readBody, log, getLive, session, postGuard
let LOGF = '';
let KEY = '', OPERATORS = new Set();

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 64 * 1024;
const CONFIRM_MS = 15000;          // 위험 명령 확인 창
const DEDUP_MS = 10 * 60e3;        // (사용자, client_id) 중복 방지
const WAIT_MAX = 25;               // 롱폴 최대 초
const ACK_GRACE_MS = 30000;        // 전달 뒤 expires 를 이만큼 넘겨도 결과가 없으면 unknown
const LIVE_FRESH_MS = 3000, READY_VOLT = 14.0;   // 위험 명령 사전조건 — 4S 3.5 V/셀 (delivery.js READY_VOLT 와 같다)
const KEEP = 200;                  // 메모리에 남길 명령 수 (목록용)

// 명령 종류 — 이 목록 밖은 400. ttl 은 queued 된 때부터 센다.
// 🔶 disarm 의 ttl 은 정해지지 않아 arm 과 같은 10초로 두었다.
const TTL = { arm: 10e3, disarm: 10e3, mode: 30e3, rtl: 30e3, land: 30e3, mission_upload: 60e3, mission_start: 60e3 };
const MODES = new Set(['auto', 'guided', 'loiter', 'alt_hold', 'rtl', 'land']);
const DANGER = (c) => ['arm', 'mission_start', 'mission_upload'].includes(c.kind) || (c.kind === 'mode' && c.args.mode === 'auto');
const PRECHECK = new Set(['arm', 'mission_start']);

// 상태 — 전달 전 / 전달 뒤(결과 대기) / 끝
const BEFORE = new Set(['created', 'awaiting_confirm', 'queued']);
const FLIGHT = ['delivered', 'sent', 'fc_ack'];
const END = new Set(['done', 'rejected', 'expired', 'cancelled', 'failed', 'unknown', 'preempted']);
// 파이가 ack 로 알릴 수 있는 것. sent·fc_ack 는 앞으로만, rejected·expired 는 FC 로 보내기 전(delivered)에만
const ACK = new Set(['sent', 'fc_ack', 'done', 'failed', 'unknown', 'rejected', 'expired']);

let cmds = [];                     // 만든 순서 (FIFO)
const dedup = new Map();           // 'u\nclient_id' → { id, at }
let waiters = [];                  // 롱폴 대기 중인 { res, timer }

// ── 기록 ────────────────────────────────────────────────────────────
function logLine(o) { fs.appendFileSync(LOGF, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n'); }

/** 상태 전이 하나 — 기록하고 바꾼다 */
function move(c, to, by, extra = {}) {
  logLine({ id: c.id, from: c.state, to, by, ...extra });
  Object.assign(c, extra, { state: to, updated: Date.now() });
}

/** 재시작 — 기록에서 끝나지 않은 명령을 찾아 expired 로 남긴다. 대기열은 빈 채로 시작 */
function recover() {
  let text = '';
  try { text = fs.readFileSync(LOGF, 'utf8'); }
  catch (e) { if (e.code !== 'ENOENT') C.log('명령 기록을 못 읽었다', e.message); return; }
  const last = new Map();
  for (const l of text.split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (o.id && o.to) last.set(o.id, o.to); } catch { /* 깨진 줄 */ }
  }
  let n = 0;
  for (const [id, st] of last) if (!END.has(st)) { logLine({ id, from: st, to: 'expired', by: 'server', reason: 'restart' }); n++; }
  if (n) C.log(`명령 ${n}건 재시작으로 만료 처리`);
}

// ── 응답·요청 ───────────────────────────────────────────────────────
const json = (req, res, status, obj) =>
  C.send(req, res, status, JSON.stringify(obj), JSON_TYPE, { 'Cache-Control': 'no-store' });

/** 본문 JSON — 크면 413, JSON 객체가 아니면 400. 응답을 보냈으면 undefined */
async function body(req, res) {
  if (parseInt(req.headers['content-length'] || '0', 10) > MAX_BODY) { json(req, res, 413, { error: 'size' }); return undefined; }
  let raw;
  try { raw = await C.readBody(req, MAX_BODY); }
  catch { if (!res.headersSent) json(req, res, 413, { error: 'size' }); return undefined; }
  let b;
  try { b = JSON.parse(raw.toString('utf8') || '{}'); } catch { b = null; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) { json(req, res, 400, { error: 'json' }); return undefined; }
  return b;
}

function keyOk(given) {
  if (!KEY) return false;
  const a = Buffer.from(String(given || '')), b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
/** 로그인 사용자 — 비로그인 401, 운용자 아님 403. 응답을 보냈으면 null */
function operator(req, res) {
  const u = C.session(req);
  if (!u) { json(req, res, 401, { error: 'login' }); return null; }
  if (!OPERATORS.has(u.id)) { json(req, res, 403, { error: 'operator' }); return null; }
  return u;
}

const pub = (c) => ({ id: c.id, kind: c.kind, args: c.args, by: c.by, state: c.state, created: c.created, expires: c.expires,
  reason: c.reason || null, mav_result: c.mav_result ?? null, detail: c.detail || null });
const find = (id) => cmds.find((c) => c.id === id) || null;

// ── 시간 ────────────────────────────────────────────────────────────
/** 확인 창·ttl 이 지난 것을 끝낸다. 전달된 것은 결과를 모르므로 unknown (재시도 금지) */
function sweep() {
  const now = Date.now();
  let freed = false;
  for (const c of cmds) {
    if (c.state === 'awaiting_confirm' && now > c.confirm_by) move(c, 'expired', 'server', { reason: 'confirm' });
    else if (c.state === 'queued' && now > c.expires) move(c, 'expired', 'server', { reason: 'ttl' });
    else if (FLIGHT.includes(c.state) && now > c.expires + ACK_GRACE_MS) { move(c, 'unknown', 'server', { reason: 'no-ack' }); freed = true; }
  }
  // 목록용으로 끝난 것을 오래된 것부터 버린다
  while (cmds.length > KEEP) { const i = cmds.findIndex((c) => END.has(c.state)); if (i < 0) break; cmds.splice(i, 1); }
  for (const [k, v] of dedup) if (now - v.at > DEDUP_MS) dedup.delete(k);
  if (freed) wake();
}

function queue(c, by) {
  move(c, 'queued', by, { expires: Date.now() + TTL[c.kind] });
  wake();
}

/** 위험 명령의 사전조건 — 서버가 가진 라이브 상태(3초 안). 맞으면 null, 아니면 사유 */
function precheck() {
  const L = C.getLive();
  if (!L || !L.state || Date.now() - L.at > LIVE_FRESH_MS) return 'live-stale';
  const d = L.state.d || {};
  if (!(d.fix >= 3)) return 'gps';
  if (!(d.volt >= READY_VOLT)) return 'volt';
  if (d.armed !== false) return 'armed';
  return null;
}

// ── 운용자 ──────────────────────────────────────────────────────────
async function create(req, res) {
  if (!C.postGuard(req, res)) return;
  const u = operator(req, res);
  if (!u) return;
  const b = await body(req, res);
  if (!b) return;
  const kind = b.kind, args = b.args == null ? {} : b.args, cid = b.client_id;
  if (typeof kind !== 'string' || !Object.hasOwn(TTL, kind)) return json(req, res, 400, { error: 'kind' });
  if (typeof args !== 'object' || Array.isArray(args)) return json(req, res, 400, { error: 'args' });
  if (kind === 'mode' && !MODES.has(args.mode)) return json(req, res, 400, { error: 'mode' });
  if (typeof cid !== 'string' || !/^[\w.:-]{1,64}$/.test(cid)) return json(req, res, 400, { error: 'client_id' });
  sweep();
  const dk = u.id + '\n' + cid, dup = dedup.get(dk);
  if (dup && find(dup.id)) { const c = find(dup.id); return json(req, res, 200, { id: c.id, state: c.state }); }

  const now = Date.now();
  const c = { id: crypto.randomBytes(6).toString('hex'), kind, args, by: u.id, client_id: cid, state: 'created',
              created: now, updated: now, confirm_by: null, expires: null };
  logLine({ id: c.id, to: 'created', by: u.id, kind, args, client_id: cid });
  cmds.push(c);
  dedup.set(dk, { id: c.id, at: now });
  if (kind === 'rtl' || kind === 'land') {
    // 비상 명령 — 아직 전달 안 된 앞 명령은 밀어낸다(preempted). 전달된 것은 이미 파이 손에 있다
    for (const o of cmds) if (o !== c && BEFORE.has(o.state)) move(o, 'preempted', u.id, { reason: c.id });
    queue(c, u.id);
  } else if (DANGER(c)) move(c, 'awaiting_confirm', u.id, { confirm_by: now + CONFIRM_MS });
  else queue(c, u.id);
  return json(req, res, 201, { id: c.id, state: c.state });
}

async function confirm(req, res, c) {
  if (!C.postGuard(req, res)) return;
  const u = operator(req, res);
  if (!u) return;
  if (!c) return json(req, res, 404, { error: 'id' });
  if (c.by !== u.id) return json(req, res, 403, { error: 'user' });
  sweep();
  if (c.state !== 'awaiting_confirm') return json(req, res, 409, { error: 'state', id: c.id, state: c.state });
  if (PRECHECK.has(c.kind)) {
    const why = precheck();
    if (why) { move(c, 'rejected', 'server', { reason: why }); return json(req, res, 409, { error: 'precheck', id: c.id, state: c.state, reason: why }); }
  }
  queue(c, u.id);
  return json(req, res, 200, { id: c.id, state: c.state });
}

async function cancel(req, res, c) {
  if (!C.postGuard(req, res)) return;
  const u = operator(req, res);
  if (!u) return;
  if (!c) return json(req, res, 404, { error: 'id' });
  sweep();
  if (!BEFORE.has(c.state)) return json(req, res, 409, { error: 'state', id: c.id, state: c.state });
  move(c, 'cancelled', u.id);
  return json(req, res, 200, { id: c.id, state: c.state });
}

function list(req, res) {
  if (!C.session(req)) return json(req, res, 401, { error: 'login' });
  sweep();
  return json(req, res, 200, { cmds: cmds.slice(-50).map(pub) });
}

// ── 파이 ────────────────────────────────────────────────────────────
/** 내줄 명령 — 앞 명령이 끝났을 때만, 가장 먼저 queued 된 것 */
function nextCmd() {
  if (cmds.some((c) => FLIGHT.includes(c.state))) return null;
  const q = cmds.filter((c) => c.state === 'queued');
  return q.length ? q.reduce((a, b) => (a.updated <= b.updated ? a : b)) : null;
}
function give(req, res, c) {
  move(c, 'delivered', 'pi');
  // 남은 시간만 준다 — 파이가 받은 시각에 더해 판정한다 (서버·파이 시계 차이 회피)
  json(req, res, 200, { id: c.id, kind: c.kind, args: c.args, ttl_ms: Math.max(0, c.expires - Date.now()) });
}
/** 기다리는 롱폴에 줄 것이 생겼으면 앞에서부터 하나씩 */
function wake() {
  while (waiters.length) {
    const c = nextCmd();
    if (!c) return;
    const w = waiters.shift();
    clearTimeout(w.timer);
    if (w.res.destroyed || w.res.writableEnded) continue;
    give(w.req, w.res, c);
  }
}

function next(req, res, url) {
  if (!keyOk(req.headers['x-cmd-key'])) return json(req, res, 403, { error: 'key' });
  sweep();
  const c = nextCmd();
  if (c) return give(req, res, c);
  const wait = Math.min(WAIT_MAX, Math.max(0, parseFloat(url.searchParams.get('wait') || '0') || 0));
  if (!wait) { res.writeHead(204, { 'Cache-Control': 'no-store' }).end(); return; }
  const w = { req, res, timer: null };
  const drop = () => { clearTimeout(w.timer); waiters = waiters.filter((x) => x !== w); };
  w.timer = setTimeout(() => { drop(); if (!res.writableEnded) res.writeHead(204, { 'Cache-Control': 'no-store' }).end(); }, wait * 1000);
  res.on('close', drop);   // 연결이 끊기면 타이머·대기열에서 뺀다
  waiters.push(w);
}

async function ack(req, res, c) {
  if (!keyOk(req.headers['x-cmd-key'])) return json(req, res, 403, { error: 'key' });
  const b = await body(req, res);
  if (!b) return;
  if (!c) return json(req, res, 404, { error: 'id' });
  const to = b.state, mr = b.mav_result ?? null, detail = b.detail == null ? null : String(b.detail).slice(0, 200);
  if (!ACK.has(to)) return json(req, res, 400, { error: 'state' });
  if (mr !== null && !Number.isInteger(mr)) return json(req, res, 400, { error: 'mav_result' });
  sweep();
  const at = FLIGHT.indexOf(c.state), step = FLIGHT.indexOf(to);
  const okMove = at >= 0 && (step >= 0 ? step > at : END.has(to) && (!['rejected', 'expired'].includes(to) || c.state === 'delivered'));
  if (!okMove) {
    logLine({ id: c.id, late: to, state: c.state, by: 'pi', mav_result: mr, detail });   // 늦게 온 결과도 기록은 남긴다
    return json(req, res, 409, { error: 'state', id: c.id, state: c.state });
  }
  move(c, to, 'pi', { mav_result: mr, detail });
  if (END.has(to)) wake();
  return json(req, res, 200, { id: c.id, state: c.state });
}

// ── 바깥 ────────────────────────────────────────────────────────────
function init(ctx) {
  C = ctx;
  LOGF = path.join(ctx.dataDir, 'cmd-log.jsonl');
  KEY = ctx.env.CMD_KEY || '';
  OPERATORS = new Set(String(ctx.env.CMD_OPERATORS || '').split(',').map((x) => x.trim()).filter(Boolean));
  if (!KEY) ctx.log('⚠️  CMD_KEY 미설정 — 기체가 명령을 가져갈 수 없다');
  if (!OPERATORS.size) ctx.log('CMD_OPERATORS 비어 있음 — 아무도 명령을 낼 수 없다');
  recover();
  setInterval(sweep, 1000).unref();
}

/** 맞는 경로면 처리하고 promise, 아니면 false */
function handle(req, res, url) {
  const p = url.pathname, m = req.method;
  if (p !== '/api/cmd' && !p.startsWith('/api/cmd/')) return false;
  if (p === '/api/cmd' && m === 'POST') return create(req, res);
  if (p === '/api/cmd' && m === 'GET') return Promise.resolve(list(req, res));
  if (p === '/api/cmd/next' && m === 'GET') return Promise.resolve(next(req, res, url));
  const r = /^\/api\/cmd\/([0-9a-f]{12})\/(confirm|cancel|ack)$/.exec(p);
  if (r && m === 'POST') {
    const c = find(r[1]);
    if (r[2] === 'confirm') return confirm(req, res, c);
    if (r[2] === 'cancel') return cancel(req, res, c);
    return ack(req, res, c);
  }
  return Promise.resolve(json(req, res, 404, { error: 'route' }));
}

module.exports = { init, handle };
