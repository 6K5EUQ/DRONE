// 미션 시험 — 정규화·hash, 자동 생성, 검증 거부, 탭 권한, cmd.js 업로드 연동.
//
//   node web/test/mission_test.js
//
// 데이터는 임시 폴더에만 쓴다. FC·파이로는 아무것도 안 나간다. 자동 생성 결과 표를 찍는다.

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEB = path.dirname(__dirname);
const mission = require(path.join(WEB, 'mission'));
const { CATALOG } = require(path.join(WEB, 'delivery'));
const PORT = 4395, FAKE_PORT = 4396;
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mis-'));
const ENV = {
  ...process.env, PORT: String(PORT), DATA_DIR: DATA, UPLOAD_PASSWORD: 'x', LIVE_PUSH_KEY: 'live-key-for-test-0123456789',
  DELIVERY_KEY: 'drone-key-for-test-0123456789', SUGANG_URL: `http://127.0.0.1:${FAKE_PORT}/Default.aspx`,
  DELIVERY_SECRET: 'secret-for-test', CMD_KEY: 'cmd-key-for-test-0123456789', CMD_OPERATORS: 'u01',
};
const kids = [];
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(file, args, env) {
  const k = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  k.stdout.on('data', () => {}); k.stderr.on('data', (d) => process.stderr.write(d));
  kids.push(k); return k;
}
function stop(k) {
  if (k.exitCode !== null || k.signalCode !== null) return Promise.resolve();
  return new Promise((r) => { k.once('exit', r); k.kill('SIGTERM'); });
}
async function up(url) { for (let i = 0; i < 50; i++) { try { await fetch(url); return; } catch { await sleep(200); } } throw new Error('안 뜬다 ' + url); }
function ok(cond, name, extra = '') { if (cond) pass++; else { fail++; console.log('  ✖', name, extra); } }

const cookies = {};
async function req(method, p, { who, body, headers = {} } = {}) {
  const h = { ...headers };
  if (who && cookies[who]) h.Cookie = cookies[who];
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const r = await fetch(H + p, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* 본문 없음 */ }
  return { s: r.status, j, r };
}
async function login(id) {
  const x = await req('POST', '/api/auth/login', { body: { id, pw: 'pw' } });
  const sc = x.r.headers.getSetCookie();
  if (sc.length) cookies[id] = sc[0].split(';')[0];
  return x;
}
const plan = (who, body) => req('POST', '/api/mission/plan', { who, body });
let cid = 0;
const upload = (items, hash) => req('POST', '/api/cmd', { who: 'u01', body: { kind: 'mission_upload', args: { items, hash }, client_id: 'm' + (++cid) } });
const has = (errs, re) => errs.some((e) => re.test(e));
const BASE = CATALOG.find((p) => p.base);

(async () => {
  console.log('— 정규화·hash (모듈)');
  const it = mission.toItems([{ k: 'takeoff', alt: 20 }, { k: 'goto', lat: 35.1810123456789, lon: 128.554, alt: 20 }, { k: 'land' }], BASE);
  const h1 = mission.hashOf(it);
  const shuffled = it.map((o) => Object.fromEntries(Object.entries(o).reverse()));
  ok(h1 === mission.hashOf(shuffled), '키 순서가 달라도 같은 hash');
  ok(h1 === mission.hashOf(JSON.parse(JSON.stringify(it))), '직렬화 왕복해도 같은 hash');
  ok(/^[0-9a-f]{16}$/.test(h1), 'hash 16자 16진');
  ok(mission.canonical([{ seq: 0, cmd: 16, frame: 3, lat: 35.18107, lon: 128.553811, alt: -0, p1: 0 }]) ===
    '[{"alt":0.0000000,"cmd":16.0000000,"frame":3.0000000,"lat":35.1810700,"lon":128.5538110,"p1":0.0000000,"seq":0.0000000}]', '정규 JSON 꼴 (키 정렬·7자리·-0)');
  ok(it[2].lat === 35.1810123, '항목 좌표는 7자리로 자른다');
  ok(mission.hashOf([{ ...it[0], lat: it[0].lat + 1e-8 }]) === mission.hashOf([it[0]]), '7자리 밑 차이는 같은 hash');
  ok(mission.hashOf([{ ...it[0], lat: it[0].lat + 1e-6 }]) !== mission.hashOf([it[0]]), '7자리 안 차이는 다른 hash');
  ok(it[0].cmd === 16 && it[0].alt === 0 && it[1].cmd === 22 && it[3].cmd === 21 && it.every((o) => o.frame === 3), '꼴 — 홈 16 / 22 / 16 / 21, 프레임 3');
  const g = mission.ground(BASE.lat, BASE.lon);
  ok(g > 0 && g < 200, '기지 지반 읽힘', String(g));
  ok(mission.ground(36, 128.55) === null, '격자 밖 → null');

  start(path.join(__dirname, 'fake_sugang.js'), [String(FAKE_PORT)], process.env);
  await up(`http://127.0.0.1:${FAKE_PORT}/count`);
  start(path.join(WEB, 'server.js'), [], ENV);
  await up(H + '/api/health');
  ok((await login('u01')).s === 200 && (await login('u02')).s === 200, 'u01·u02 로그인');

  console.log('— 자동 생성');
  const rows = [];
  for (const t of ['본관', '도서관', '화영운동장']) {
    const x = await plan('u01', { title: t });
    const r = x.j.report, gd = r.ground;
    ok(x.s === 200 && x.j.ok, `${t} 자동 생성 통과`, JSON.stringify(r.errors));
    const its = x.j.items;
    ok(its.map((o) => o.cmd).join() === '16,22,16,16,21', `${t} 꼴 홈·이륙·순항·하강·착륙`);
    const H_ = its[1].alt;
    ok(H_ === its[2].alt && H_ === r.h_cruise && H_ <= 60, `${t} 순항 = 이륙 고도, ≤ 60`);
    ok(Math.abs(H_ - (Math.max(gd.path_max_m - gd.home_m, gd.dest_minus_home_m) + 25)) <= 0.2, `${t} H = max(경로 최고, 목적지) − 출발 + 25`);
    ok(Math.abs(its[3].alt - (gd.dest_minus_home_m + 10)) <= 0.1, `${t} 하강 경유 = 목적지 지면 위 10 m`);
    ok(x.j.hash === mission.hashOf(its), `${t} hash 일치`);
    ok(typeof gd.basis === 'string' && gd.basis.startsWith('🔶'), `${t} 근거 문구`);
    ok((gd.dest_minus_home_m > 0) === has(r.warnings, /목적지 지반이 출발보다/), `${t} 목적지가 높으면 경고`);
    rows.push(`| ${t} | ${H_} | ${gd.home_m} | ${gd.dest_m} | ${gd.dest_minus_home_m} | ${gd.path_max_m} | ${r.dist_m} | ${r.est_s} |`);
  }
  console.log('| 목적지 | H m | 출발 지반 | 도착 지반 | 차 | 경로 최고 | 거리 m | 예상 s |\n|---|---|---|---|---|---|---|---|\n' + rows.join('\n'));
  ok((await plan('u01', { title: '없는곳' })).s === 400, '모르는 장소 → 400');
  const fromLib = await plan('u01', { title: '본관', home: { lat: 35.181296, lon: 128.552923 } });
  ok(fromLib.j.items[0].lat === 35.181296, 'home 을 주면 거기서 출발');

  console.log('— 검증 거부');
  const good = (await plan('u01', { title: '본관' })).j.items;
  const bad = (f) => { const c = JSON.parse(JSON.stringify(good)); f(c); return mission.check(c).errors; };
  for (const cmdn of [177, 179, 20]) ok(has(bad((c) => { c[2].cmd = cmdn; }), new RegExp(`명령 ${cmdn} `)), `명령 ${cmdn} 거부`);
  ok(has(bad((c) => { c[2].frame = 0; }), /프레임/), '프레임 0 거부');
  ok(has(bad((c) => { c[2].frame = 10; }), /프레임/), '프레임 10(지형 상대) 거부');
  ok(has(bad((c) => { c[2].lat += 0.006; }), /기지에서 \d+ m/), '기지 500 m 밖 거부');
  ok(has(bad((c) => { c[1].alt = 61; }), /고도 61/), 'H 61 거부');
  ok(has(bad((c) => { c[2].lat = NaN; }), /lat 가 숫자가 아니다/), 'NaN 거부');
  ok(has(bad((c) => { c[2].lat = 95; }), /좌표 범위 밖/), '위도 95 거부');
  ok(has(bad((c) => { c[1].cmd = 16; }), /이륙/), '첫 항목 이륙 아님 거부');
  ok(has(bad((c) => { c.pop(); }), /착륙/), '마지막 착륙 아님 거부');
  ok(has(bad((c) => { c[2].x = 1; }), /모르는 키/), '모르는 키 거부');
  ok(has(bad((c) => { c[2].seq = 7; }), /seq/), 'seq 순서 거부');
  // 시간 초과 — 기지 위 호버 220초 + 이착륙
  let x = await plan('u01', { steps: [{ k: 'takeoff', alt: 20 }, { k: 'hover', sec: 220 }, { k: 'land' }] });
  ok(x.s === 200 && !x.j.ok && has(x.j.report.errors, /예상 비행시간/), '예상 4분 초과 거부', JSON.stringify(x.j.report));
  x = await plan('u01', { steps: [{ k: 'takeoff', alt: 20 }, ...Array.from({ length: 28 }, () => ({ k: 'hover', sec: 1 })), { k: 'land' }] });
  ok(x.s === 400, '절차 28개 초과 → 400');
  const many = mission.toItems([{ k: 'takeoff', alt: 20 }, ...Array.from({ length: 28 }, () => ({ k: 'hover', sec: 1 })), { k: 'land' }], BASE);
  ok(has(mission.check(many).errors, /31개/), '항목 31개 거부');
  x = await plan('u01', { steps: [{ k: 'takeoff', alt: 20 }, { k: 'rtl' }] });
  ok(x.j.ok && x.j.items.map((o) => o.cmd).join() === '16,22,16,21', 'rtl 절차 → 기지 경유 + 착륙 (20 안 씀)');
  x = await plan('u01', { steps: [{ k: 'takeoff', alt: 20 }, { k: 'goto', lat: 35.2, lon: 128.554, alt: 20 }, { k: 'land' }] });
  ok(!x.j.ok && has(x.j.report.errors, /기지에서/), '계획 API 도 반경 밖 거부');
  ok((await plan('u01', { steps: [{ k: 'fly' }] })).s === 400, '모르는 절차 → 400');
  ok((await plan('u02', { title: '본관' })).s === 403, '계획 — 운용자 아님 403');
  ok((await plan(undefined, { title: '본관' })).s === 401, '계획 — 비로그인 401');
  const far = mission.check([{ seq: 0, cmd: 16, frame: 3, lat: BASE.lat, lon: BASE.lon, alt: 0, p1: 0 },
    { seq: 1, cmd: 22, frame: 3, lat: BASE.lat, lon: BASE.lon, alt: 20, p1: 0 }, { seq: 2, cmd: 21, frame: 3, lat: BASE.lat, lon: BASE.lon, alt: 0, p1: 0 }]);
  ok(!far.errors.length && !far.warnings.length, '기지 이착륙만 — 오류·경고 없음', JSON.stringify(far));

  console.log('— 탭 CRUD 권한');
  const tab = { name: '본관 왕복', steps: [{ k: 'takeoff', alt: 30 }, { k: 'goto', lat: 35.180747, lon: 128.554772, alt: 30 }, { k: 'land' }] };
  ok((await req('GET', '/api/mission/tabs')).s === 401, '목록 비로그인 401');
  ok((await req('PUT', '/api/mission/tabs/t1', { body: tab })).s === 401, 'PUT 비로그인 401');
  ok((await req('PUT', '/api/mission/tabs/t1', { who: 'u02', body: tab })).s === 403, 'PUT 운용자 아님 403');
  ok((await req('DELETE', '/api/mission/tabs/t1', { who: 'u02' })).s === 403, 'DELETE 운용자 아님 403');
  ok((await req('PUT', '/api/mission/tabs/t1', { who: 'u01', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(tab) })).s === 415, 'PUT text/plain 415');
  ok((await req('PUT', '/api/mission/tabs/t1', { who: 'u01', headers: { Origin: 'https://evil.bewe.co.kr' }, body: tab })).s === 403, 'PUT 다른 Origin 403');
  x = await req('PUT', '/api/mission/tabs/t1', { who: 'u01', body: tab });
  ok(x.s === 200 && x.j.tab.rev === 1 && x.j.tab.id === 't1' && x.j.tab.steps.length === 3, '새 탭 rev 1');
  ok((await req('PUT', '/api/mission/tabs/t1', { who: 'u01', body: { ...tab, name: '고침' } })).s === 409, '옛 rev 로 고치기 → 409');
  x = await req('PUT', '/api/mission/tabs/t1', { who: 'u01', body: { ...tab, name: '고침', rev: 1 } });
  ok(x.s === 200 && x.j.tab.rev === 2 && x.j.tab.name === '고침', 'rev 맞으면 고침 → rev 2');
  ok((await req('PUT', '/api/mission/tabs/t2', { who: 'u01', body: { name: 'x', steps: [{ k: 'jump' }] } })).s === 400, '잘못된 절차 저장 400');
  x = await req('GET', '/api/mission/tabs', { who: 'u01' });
  ok(x.s === 200 && x.j.tabs.length === 1 && x.j.tabs[0].name === '고침', '목록에 내 탭');
  ok((await req('GET', '/api/mission/tabs', { who: 'u02' })).j.tabs.length === 0, '다른 사람 목록에는 없다');
  const saved = JSON.parse(fs.readFileSync(path.join(DATA, 'mission-tabs.json'), 'utf8'));
  ok(saved.users.u01.t1.rev === 2 && !fs.existsSync(path.join(DATA, 'mission-tabs.json.tmp')), '파일 저장 (임시 파일 안 남음)');
  ok((await req('DELETE', '/api/mission/tabs/t1', { who: 'u01' })).s === 200, '삭제');
  ok((await req('DELETE', '/api/mission/tabs/t1', { who: 'u01' })).s === 404, '없는 탭 삭제 404');

  console.log('— cmd.js 연동');
  const p = (await plan('u01', { title: '도서관' })).j;
  x = await upload(p.items, p.hash);
  ok(x.s === 201 && x.j.state === 'awaiting_confirm', '맞는 항목·hash → 201 awaiting_confirm', JSON.stringify(x.j));
  x = await upload(p.items, '0000000000000000');
  ok(x.s === 400 && x.j.error === 'hash', '잘못된 hash → 400 hash');
  x = await upload(p.items);
  ok(x.s === 400 && x.j.error === 'hash', 'hash 없음 → 400');
  const tampered = JSON.parse(JSON.stringify(p.items)); tampered[2].alt = 59;
  ok((await upload(tampered, p.hash)).j.error === 'hash', '항목을 바꾸면 hash 불일치');
  const evil = JSON.parse(JSON.stringify(p.items)); evil[2].cmd = 177;
  x = await upload(evil, mission.hashOf(evil));
  ok(x.s === 400 && x.j.error === 'mission' && has(x.j.errors, /명령 177/), '금지 명령은 hash 가 맞아도 400 + 사유');
  ok((await upload([], mission.hashOf([]))).s === 400, '빈 항목 400');

  console.log(`\n${pass} 통과, ${fail} 실패`);
  for (const k of kids) await stop(k);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); for (const k of kids) await stop(k); fs.rmSync(DATA, { recursive: true, force: true }); process.exit(1); });
