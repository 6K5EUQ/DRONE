// 미션 — 절차 탭 저장, 미션 항목 계획·검증, 배송 지점 자동 생성.
//
// server.js 의 route() 가 cmd.handle() 다음에 handle() 을 부르고, 이 파일이 /api/mission/* 를 맡는다.
// cmd.js 는 mission_upload 명령을 만들 때 check()·hashOf() 로 같은 검증을 다시 돌린다.
//
// 🔴 이 파일은 FC 로 아무것도 보내지 않는다. 항목을 만들고 검사할 뿐이다.
//
// 항목은 ArduPilot 미션 꼴이다 (설계 02 §3):
//   seq 0 = 홈 자리 채움(16, alt 0 — FC 가 홈으로 덮는다), 이후 22 이륙 · 16 경유 · 19 호버 · 21 착륙.
//   프레임은 3(GLOBAL_RELATIVE_ALT, 홈 기준 상대고도) 하나. RTL(20)은 쓰지 않는다 — RTL_ALT 가 기체 전역값이라
//   구간별 고도를 못 준다(설계 02 §3). 절차의 rtl 은 「기지 위로 경유 → 착륙」 두 항목으로 푼다.
//
// 🔶 아래 수치는 전부 추정이거나 운영값이다. 실비행으로 검증된 것이 없다.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CATALOG } = require('./delivery');

let C = null;          // init 이 넘긴 것 — dataDir, env, send, readBody, log, session, postGuard
let FILE = '';
let OPERATORS = new Set();
let TABS = { v: 1, users: {} };   // users[학번][탭 id] = 탭

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 64 * 1024;

// ── 한계 ────────────────────────────────────────────────────────────
const RADIUS_M = 500;          // 기지에서 — 운영값 (교내)
const H_MAX = 60;              // 상대고도 상한 m — 운영값
const MAX_ITEMS = 30;          // seq 0 포함
const T_MAX = 240;             // 예상 비행시간 상한 s (4분) — 운영값. 비행시간 추정(설계 01 §5, 12~14분)보다 한참 짧게
const ALLOWED = new Set([16, 19, 21, 22]);
const KEYS = ['alt', 'cmd', 'frame', 'lat', 'lon', 'p1', 'seq'];
const MAX_TABS = 50, MAX_STEPS = 28;

// 속도 — params_20261012-1258_live-usb.param (이전 기체 잔재값, 이 기체에서 검증 안 됨 🔶)
//   WPNAV_SPEED 500 cm/s, WPNAV_SPEED_UP 250, WPNAV_SPEED_DN 150, LAND_SPEED 50, LAND_ALT_LOW 1000 cm, LAND_SPEED_HIGH 0(=DN)
const V = { cruise: 5, up: 2.5, dn: 1.5, land: 0.5, landLow: 10 };

// 자동 생성 — 🔶 추정. 장애물 높이(나무·건물)를 DSM 이 일부만 담으므로 여유를 크게 둔다
const MARGIN = 25;             // 경로 최고 지반 위 여유 m
const CLEAR = 10;              // 착륙 전 「지면 위」 경유 높이 m
const SAMPLE_M = 5;            // 경로 지반 샘플 간격 m (격자는 ~30 m)
const BASIS = `🔶 추정 — 순항 H = max(경로 최고 지반 − 출발 지반, 목적지 지반 − 출발 지반) + 여유 ${MARGIN} m, ` +
  `착륙 전 경유 = 목적지 지면 위 ${CLEAR} m. 지반은 Copernicus GLO-30 DSM(30 m 격자, 쌍선형 보간, ${SAMPLE_M} m 간격 샘플)이라 ` +
  `건물·나무 꼭대기를 다 담지 못한다. 실비행 검증 전`;

// ── 지형 ────────────────────────────────────────────────────────────
// public/terrain/ (SHADE01 에서 복사, README 참고). 처음 쓸 때 읽는다 — cmd.js 검증도 같은 걸 쓴다
let DEM = null;
function dem() {
  if (DEM) return DEM;
  const dir = path.join(__dirname, 'public', 'terrain');
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'dem.json'), 'utf8'));
  const b = fs.readFileSync(path.join(dir, 'dem.bin'));
  DEM = { ...meta, z: new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)) };
  return DEM;
}
/** 지반 해발 m (EGM2008). 격자 밖이면 null. 둘러싼 네 화소 쌍선형 보간 */
function ground(lat, lon) {
  const D = dem();
  const r = (D.lat0 - lat) / D.step, c = (lon - D.lon0) / D.step;
  if (!(r >= 0 && c >= 0 && r <= D.rows - 1 && c <= D.cols - 1)) return null;
  const r0 = Math.min(Math.floor(r), D.rows - 2), c0 = Math.min(Math.floor(c), D.cols - 2);
  const fr = r - r0, fc = c - c0, at = (i, j) => D.z[(r0 + i) * D.cols + c0 + j] * D.scale;
  return (at(0, 0) * (1 - fc) + at(0, 1) * fc) * (1 - fr) + (at(1, 0) * (1 - fc) + at(1, 1) * fc) * fr;
}
/** 두 점 사이를 SAMPLE_M 간격으로 — 최고 지반과 격자 밖 샘플이 있었는지 */
function pathMax(a, b) {
  const n = Math.max(1, Math.ceil(dist(a, b) / SAMPLE_M));
  let max = -Infinity, out = false;
  for (let i = 0; i <= n; i++) {
    const g = ground(a.lat + (b.lat - a.lat) * i / n, a.lon + (b.lon - a.lon) * i / n);
    if (g == null) out = true; else max = Math.max(max, g);
  }
  return { max, out };
}

// ── 기하·수 ─────────────────────────────────────────────────────────
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const r1 = (v) => Math.round(v * 10) / 10;
const r7 = (v) => Math.round(v * 1e7) / 1e7;
function dist(a, b) {
  const R = 6371000, k = Math.PI / 180;
  const dLat = (b.lat - a.lat) * k, dLon = (b.lon - a.lon) * k;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const BASE = () => CATALOG.find((p) => p.base);

// ── 정규 JSON · hash ────────────────────────────────────────────────
// 파이·다른 언어도 같은 값을 내야 한다. 규칙: 항목 배열 순서 그대로, 각 항목은 KEYS(알파벳 순)만,
// 공백 없음, 숫자는 전부 소수 7자리 고정(toFixed(7), 반올림 뒤 -0 은 0). sha256 16진의 앞 16자.
const fix7 = (v) => { const x = r7(v); return (x === 0 ? 0 : x).toFixed(7); };
function canonical(items) {
  return '[' + items.map((it) => '{' + KEYS.map((k) => `"${k}":${fix7(it[k])}`).join(',') + '}').join(',') + ']';
}
const hashOf = (items) => crypto.createHash('sha256').update(canonical(items)).digest('hex').slice(0, 16);

// ── 검증 ────────────────────────────────────────────────────────────
/** 항목 검사 → { errors, warnings, dist_m, est_s, h_cruise, ground }. errors 가 비면 통과 */
function check(items) {
  const errors = [], warnings = [];
  const out = { errors, warnings, dist_m: 0, est_s: 0, h_cruise: 0, ground: null };
  if (!Array.isArray(items) || items.length < 2) { errors.push('항목이 없다 (홈 + 이륙 + … + 착륙)'); return out; }
  if (items.length > MAX_ITEMS) errors.push(`항목 ${items.length}개 — ${MAX_ITEMS}개까지`);
  const base = BASE();
  let shapeOk = true;
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) { errors.push(`${i}번 항목: 객체가 아니다`); shapeOk = false; return; }
    const extra = Object.keys(it).filter((k) => !KEYS.includes(k));
    if (extra.length) errors.push(`${i}번 항목: 모르는 키 ${extra.join('·')}`);
    for (const k of KEYS) if (!num(it[k])) { errors.push(`${i}번 항목: ${k} 가 숫자가 아니다 (${it[k]})`); shapeOk = false; }
    if (!shapeOk) return;
    if (it.seq !== i) errors.push(`${i}번 항목: seq ${it.seq} — 순서대로 0부터`);
    if (!ALLOWED.has(it.cmd)) errors.push(`${i}번 항목: 명령 ${it.cmd} 는 허용 안 됨 (16·19·21·22 만)`);
    if (it.frame !== 3) errors.push(`${i}번 항목: 프레임 ${it.frame} — 3(상대고도)만`);
    if (!(it.lat >= -90 && it.lat <= 90 && it.lon >= -180 && it.lon <= 180)) errors.push(`${i}번 항목: 좌표 범위 밖 (${it.lat}, ${it.lon})`);
    else if (dist(base, it) > RADIUS_M) errors.push(`${i}번 항목: 기지에서 ${Math.round(dist(base, it))} m — ${RADIUS_M} m 이내만`);
    if (it.alt > H_MAX) errors.push(`${i}번 항목: 고도 ${it.alt} m — ${H_MAX} m 이하`);
  });
  if (!shapeOk) return out;
  if (items[0].cmd !== 16 || items[0].alt !== 0) errors.push('0번 항목: 홈 자리(16, alt 0)가 아니다');
  if (items[1].cmd !== 22) errors.push('첫 항목(1번)이 이륙(22)이 아니다');
  if (items[items.length - 1].cmd !== 21) errors.push('마지막 항목이 착륙(21)이 아니다');

  // 지반 — 출발(홈)·목적지(마지막 착륙)·경로 최고
  const home = items[0], dest = items[items.length - 1];
  const g0 = ground(home.lat, home.lon), gD = ground(dest.lat, dest.lon);
  let gMax = -Infinity, outside = g0 == null || gD == null;
  for (let i = 1; i < items.length; i++) {
    const s = pathMax(items[i - 1], items[i]);
    gMax = Math.max(gMax, s.max);
    outside = outside || s.out;
  }
  if (outside) warnings.push('지형 데이터 밖 좌표가 있다 — 지반을 모른다');
  if (g0 != null && gD != null && gD > g0) warnings.push(`목적지 지반이 출발보다 ${r1(gD - g0)} m 높다`);
  out.ground = {
    home_m: g0 == null ? null : r1(g0), dest_m: gD == null ? null : r1(gD),
    path_max_m: Number.isFinite(gMax) ? r1(gMax) : null,
    dest_minus_home_m: g0 == null || gD == null ? null : r1(gD - g0),
    src: 'Copernicus DEM GLO-30 (DSM, EGM2008)',
  };

  // 예상 비행시간 = 상승 + 수평 거리/순항 + 하강 + 호버. 경유점의 수평·수직은 따로 더한다(보수적)
  const gRel = (p) => { const g = ground(p.lat, p.lon); return g == null || g0 == null ? 0 : g - g0; };
  let pos = home, alt = 0, d = 0, t = 0;
  for (const it of items.slice(1)) {
    const h = dist(pos, it);
    if (it.cmd === 22) { t += Math.max(0, it.alt - alt) / V.up; alt = it.alt; continue; }
    d += h; t += h / V.cruise; pos = it;
    if (it.cmd === 21) {
      const z = Math.max(0, alt - gRel(it));                 // 착륙 지점 지면까지
      t += Math.max(0, z - V.landLow) / V.dn + Math.min(z, V.landLow) / V.land;
      alt = gRel(it);
      continue;
    }
    t += it.alt > alt ? (it.alt - alt) / V.up : (alt - it.alt) / V.dn;
    alt = it.alt;
    if (it.cmd === 19) t += Math.max(0, it.p1);
  }
  out.dist_m = r1(d);
  out.est_s = Math.round(t);
  out.h_cruise = r1(Math.max(...items.map((it) => it.alt)));
  if (t > T_MAX) errors.push(`예상 비행시간 ${Math.round(t)} 초 — ${T_MAX} 초(4분) 이하`);
  return out;
}

// ── 절차 → 항목 ─────────────────────────────────────────────────────
const KINDS = new Set(['takeoff', 'goto', 'hover', 'land', 'rtl']);
/** 절차 모양 검사 — 저장·계획 둘 다. 사유 목록 */
function stepErrors(steps) {
  if (!Array.isArray(steps)) return ['steps 가 목록이 아니다'];
  const e = [];
  if (steps.length > MAX_STEPS) e.push(`절차 ${steps.length}개 — ${MAX_STEPS}개까지`);
  steps.forEach((s, i) => {
    if (!s || typeof s !== 'object' || !KINDS.has(s.k)) { e.push(`${i}번 절차: k 는 takeoff·goto·hover·land·rtl`); return; }
    for (const k of ['lat', 'lon', 'alt', 'sec']) if (s[k] != null && !num(s[k])) e.push(`${i}번 절차: ${k} 가 숫자가 아니다`);
    if (s.k === 'takeoff' && !num(s.alt)) e.push(`${i}번 절차: 이륙 고도(alt)가 없다`);
    if (s.k === 'goto' && !(num(s.lat) && num(s.lon))) e.push(`${i}번 절차: 경유 좌표가 없다`);
    if (s.k === 'hover' && !(num(s.sec) && s.sec > 0)) e.push(`${i}번 절차: 호버 초(sec)가 없다`);
    if ((s.lat == null) !== (s.lon == null)) e.push(`${i}번 절차: lat·lon 은 같이 준다`);
  });
  return e;
}
/** 좌표·고도를 생략한 절차는 바로 앞 위치·고도를 이어 쓴다 */
function toItems(steps, home) {
  const items = [];
  const add = (cmd, p, alt, p1 = 0) => items.push({ seq: items.length, cmd, frame: 3, lat: r7(p.lat), lon: r7(p.lon), alt: r1(alt), p1 });
  add(16, home, 0);
  let pos = home, alt = 0;
  for (const s of steps) {
    const at = s.lat != null ? { lat: s.lat, lon: s.lon } : pos;
    if (s.k === 'takeoff') { alt = s.alt; add(22, pos, alt); continue; }
    if (s.k === 'rtl') { add(16, home, alt); add(21, home, 0); pos = home; continue; }
    if (s.k === 'land') { add(21, at, 0); pos = at; continue; }
    if (s.alt != null) alt = s.alt;
    add(s.k === 'hover' ? 19 : 16, at, alt, s.k === 'hover' ? s.sec : 0);
    pos = at;
  }
  return items;
}

/** 배송 지점 자동 생성 — 이륙 → 순항 → 도착 상공 → 지면 위 CLEAR → 착륙. { steps, ground } 또는 { error } */
function autoSteps(title, home) {
  const p = CATALOG.find((c) => c.name === title);
  if (!p) return { error: 'title' };
  const g0 = ground(home.lat, home.lon), gD = ground(p.lat, p.lon), path = pathMax(home, p);
  if (g0 == null || gD == null || path.out) return { error: 'terrain' };
  const H = Math.ceil((Math.max(path.max - g0, gD - g0) + MARGIN) * 10) / 10;
  const low = r1(gD - g0 + CLEAR);
  return {
    steps: [{ k: 'takeoff', alt: H }, { k: 'goto', lat: p.lat, lon: p.lon, alt: H },
            { k: 'goto', lat: p.lat, lon: p.lon, alt: low }, { k: 'land' }],
    auto: { title: p.name, h_m: H, margin_m: MARGIN, clear_m: CLEAR, path_max_m: r1(path.max), basis: BASIS },
  };
}

// ── 탭 저장 ─────────────────────────────────────────────────────────
function load() {
  try { TABS = { v: 1, users: {}, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; }
  catch (e) { if (e.code !== 'ENOENT') C.log('미션 탭을 못 읽었다 — 빈 채로 시작', e.message); TABS = { v: 1, users: {} }; }
}
function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(TABS));
  fs.renameSync(tmp, FILE);
}

// ── 응답·요청 ───────────────────────────────────────────────────────
const json = (req, res, status, obj) =>
  C.send(req, res, status, JSON.stringify(obj), JSON_TYPE, { 'Cache-Control': 'no-store' });

/** 본문 JSON 객체 — 아니면 응답하고 undefined */
async function body(req, res) {
  let raw;
  try { raw = await C.readBody(req, MAX_BODY); }
  catch { if (!res.headersSent) json(req, res, 413, { error: 'size' }); return undefined; }
  let b;
  try { b = JSON.parse(raw.toString('utf8') || '{}'); } catch { b = null; }
  if (!b || typeof b !== 'object' || Array.isArray(b)) { json(req, res, 400, { error: 'json' }); return undefined; }
  return b;
}
/** 로그인 사용자 — 비로그인 401, 운용자 아님 403 (cmd.js 와 같은 CMD_OPERATORS) */
function operator(req, res) {
  const u = C.session(req);
  if (!u) { json(req, res, 401, { error: 'login' }); return null; }
  if (!OPERATORS.has(u.id)) { json(req, res, 403, { error: 'operator' }); return null; }
  return u;
}

function listTabs(req, res) {
  const u = C.session(req);
  if (!u) return json(req, res, 401, { error: 'login' });
  const mine = Object.values(TABS.users[u.id] || {}).sort((a, b) => a.updated - b.updated);
  return json(req, res, 200, { tabs: mine });
}

async function putTab(req, res, id) {
  if (!C.postGuard(req, res)) return;
  const u = operator(req, res);
  if (!u) return;
  const b = await body(req, res);
  if (!b) return;
  const mine = TABS.users[u.id] || (TABS.users[u.id] = {});
  const old = mine[id];
  if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 40) return json(req, res, 400, { error: 'name' });
  const se = stepErrors(b.steps);
  if (se.length) return json(req, res, 400, { error: 'steps', errors: se });
  // 낙관적 잠금 — 고친 사람이 본 rev 가 지금 것과 다르면 409 (새 탭은 rev 없이/0)
  if ((old ? old.rev : 0) !== (b.rev ?? 0)) return json(req, res, 409, { error: 'rev', tab: old || null });
  if (!old && Object.keys(mine).length >= MAX_TABS) return json(req, res, 409, { error: 'full' });
  const steps = b.steps.map((s) => {
    const o = { k: s.k };
    for (const k of ['lat', 'lon', 'alt', 'sec']) if (s[k] != null) o[k] = s[k];
    return o;
  });
  const tab = { id, name: b.name.trim(), steps, rev: (old ? old.rev : 0) + 1, updated: Date.now() };
  mine[id] = tab;
  save();
  return json(req, res, 200, { tab });
}

function delTab(req, res, id) {
  const u = operator(req, res);
  if (!u) return;
  const mine = TABS.users[u.id];
  if (!mine || !mine[id]) return json(req, res, 404, { error: 'id' });
  delete mine[id];
  save();
  return json(req, res, 200, { ok: true });
}

async function plan(req, res) {
  if (!C.postGuard(req, res)) return;
  const u = operator(req, res);
  if (!u) return;
  const b = await body(req, res);
  if (!b) return;
  let home = BASE();
  if (b.home != null) {
    if (!b.home || !num(b.home.lat) || !num(b.home.lon)) return json(req, res, 400, { error: 'home' });
    home = { lat: b.home.lat, lon: b.home.lon };
  }
  let steps = b.steps, auto = null;
  if (steps == null) {
    if (typeof b.title !== 'string') return json(req, res, 400, { error: 'steps' });
    const a = autoSteps(b.title, home);
    if (a.error) return json(req, res, 400, { error: a.error });
    ({ steps, auto } = a);
  }
  const se = stepErrors(steps);
  if (se.length) return json(req, res, 400, { error: 'steps', errors: se });
  const items = toItems(steps, home);
  const report = check(items);
  if (auto) report.ground = { ...report.ground, ...auto };
  return json(req, res, 200, { ok: !report.errors.length, items, hash: hashOf(items), report, steps });
}

/** cmd.js — mission_upload 의 args. 통과면 null, 아니면 { error, errors? } */
function checkUpload(args) {
  const r = check(args.items);
  if (r.errors.length) return { error: 'mission', errors: r.errors };
  if (typeof args.hash !== 'string' || args.hash !== hashOf(args.items)) return { error: 'hash' };
  return null;
}

// ── 바깥 ────────────────────────────────────────────────────────────
function init(ctx) {
  C = ctx;
  FILE = path.join(ctx.dataDir, 'mission-tabs.json');
  OPERATORS = new Set(String(ctx.env.CMD_OPERATORS || '').split(',').map((x) => x.trim()).filter(Boolean));
  load();
  dem();   // 지형 파일이 없으면 기동 때 바로 드러나게
}

/** 맞는 경로면 처리하고 promise, 아니면 false */
function handle(req, res, url) {
  const p = url.pathname, m = req.method;
  if (!p.startsWith('/api/mission/')) return false;
  if (p === '/api/mission/tabs' && m === 'GET') return Promise.resolve(listTabs(req, res));
  if (p === '/api/mission/plan' && m === 'POST') return plan(req, res);
  const r = /^\/api\/mission\/tabs\/([\w-]{1,40})$/.exec(p);
  if (r && m === 'PUT') return putTab(req, res, r[1]);
  if (r && m === 'DELETE') return Promise.resolve(delTab(req, res, r[1]));
  return Promise.resolve(json(req, res, 404, { error: 'route' }));
}

module.exports = { init, handle, check, checkUpload, hashOf, canonical, ground, toItems, autoSteps };
