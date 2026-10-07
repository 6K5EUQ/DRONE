// 배송 서버 시험 — 가짜 학교 서버와 drone01 서버를 띄워 배송 한 바퀴를 끝까지 돈다.
//
//   node web/test/delivery_test.js
//
// 데이터는 임시 폴더에만 쓴다. 저장소 .venv 의 파이썬이 있어야 서버가 뜬다(server.js 기동 검사).

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEB = path.dirname(__dirname);
const FAKE_PORT = 4499, PORT = 4398;
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'dlv-'));
const KEY = 'drone-key-for-test-0123456789', LIVE = 'live-key-for-test-0123456789';
const ENV = {
  ...process.env, PORT: String(PORT), DATA_DIR: DATA, UPLOAD_PASSWORD: 'x', LIVE_PUSH_KEY: LIVE,
  SUGANG_URL: `http://127.0.0.1:${FAKE_PORT}/Default.aspx`, DELIVERY_KEY: KEY,
  DELIVERY_SECRET: 'secret-for-test', PICKUP_WAIT: '3', DEST_WAIT: '600',
};
const kids = [];
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(file, args, env) {
  const k = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  k.stdout.on('data', () => {}); k.stderr.on('data', (d) => process.stderr.write(d));
  kids.push(k); return k;
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
async function login(id, pw = 'pw') {
  const x = await req('POST', '/api/auth/login', { body: { id, pw } });
  const sc = x.r.headers.getSetCookie();
  if (sc.length) cookies[id] = sc[0].split(';')[0];
  return x;
}
const state = async (who) => (await req('GET', '/api/delivery/state', { who })).j;
async function act(who, a, args = {}) {
  const rev = (await state(who === 'drone' ? undefined : who)).rev;
  const headers = who === 'drone' ? { 'X-Delivery-Key': KEY } : {};
  return req('POST', '/api/delivery/act', { who: who === 'drone' ? undefined : who, headers, body: { act: a, rev, ...args } });
}
// 기체 링크 — 살아 있고 GPS 3D fix, 전압 정상이면 「대기 중」
const link = (o = {}) => fetch(H + '/api/live/push', { method: 'POST', headers: { 'X-Live-Key': LIVE, 'Content-Type': 'application/json' },
  body: JSON.stringify({ live: true, d: { lat: 35.18107, lon: 128.55381, fix: 3, sats: 14, volt: 16.2, ...o } }) });
const fakeCount = async () => parseInt(await (await fetch(`http://127.0.0.1:${FAKE_PORT}/count`)).text(), 10);
async function server() {
  const s = start(path.join(WEB, 'server.js'), [], ENV);
  await up(H + '/api/health');
  return s;
}

(async () => {
  start(path.join(__dirname, 'fake_sugang.js'), [String(FAKE_PORT)], process.env);
  await up(`http://127.0.0.1:${FAKE_PORT}/count`);
  let srv = await server();

  console.log('— 로그인');
  for (let i = 0; i < 3; i++) ok((await login('u09', 'nope')).s === 401, `틀린 비번 ${i + 1} → 401`);
  const before = await fakeCount();
  ok((await login('u09', 'nope')).s === 429, '4회째 → 429');
  ok((await fakeCount()) === before, '429 는 학교로 안 나간다');
  ok((await login('boom')).s === 502, '학교 500 → 502');
  ok((await login('u01', '비번')).s === 400, 'ASCII 아닌 비번 → 400');
  ok((await login('u01')).s === 200 && !!cookies.u01, 'u01 로그인');
  ok((await login('u02')).s === 200, 'u02 로그인');
  let me = await state('u01');
  ok(me.me && me.me.id === 'u01' && me.me.name === '박보냄' && me.me.admin === undefined, '학교 상단 인사에서 이름, 관리자 없음', JSON.stringify(me.me));
  ok(parseInt(await (await fetch(`http://127.0.0.1:${FAKE_PORT}/logouts`)).text(), 10) >= 2, '확인 뒤 학교 세션 끊음');
  ok((await state()).points.length === 6 && (await state()).me === null && (await state()).can.length === 0, '비로그인: 지점은 보이고 동작은 없음');

  console.log('— 요청 막이');
  ok((await req('POST', '/api/delivery/act', { who: 'u01', headers: { Origin: 'https://evil.bewe.co.kr' }, body: { act: 'call', rev: me.rev, point: 'main' } })).s === 403, '다른 Origin → 403');
  ok((await req('POST', '/api/delivery/act', { who: 'u01', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ act: 'call', rev: me.rev }) })).s === 415, 'text/plain → 415');
  ok((await req('POST', '/api/delivery/act', { body: { act: 'call', rev: 0 } })).s === 401, '비로그인 act → 401');
  ok((await req('POST', '/api/delivery/act', { who: 'u01', body: { act: 'call', rev: -1, point: 'main' } })).s === 409, '옛 rev → 409');

  console.log('— 지점 (소스의 고정 목록)');
  let pts = (await state('u01')).points;
  ok(pts.map((p) => p.name).join(',') === '본관,대운동장,화영운동장,공학관,한마관,도서관', '고정 목록 6곳', pts.map((p) => p.name).join(','));
  ok(pts.every((p) => p.lat != null) && pts.find((p) => p.base).id === 'field', '좌표 다 있음, 기지 = 대운동장');
  for (const a of ['pt_add', 'pt_set', 'pt_measure', 'service']) ok((await act('u01', a, { point: 'main', lat: 35, lon: 128, on: true })).s === 400, `없는 동작 ${a} → 400`);
  ok((await act('u01', 'call', { point: 'main' })).s === 503, '운행 꺼짐 → 503');

  console.log('— 운행 켜고 배송 한 바퀴');
  srv.kill(); await sleep(500); ENV.DELIVERY_SERVICE = 'on'; srv = await server();
  ok((await state('u01')).status === 'down', '링크 없음 → 사용 불가');
  ok((await act('u01', 'call', { point: 'main' })).s === 409, '사용 불가면 호출 409');
  await link({ volt: 13.5 });
  ok((await state('u01')).status === 'down', '전압 13.5 V → 사용 불가');
  await link();
  ok((await state('u01')).status === 'ready', '링크·GPS·전압 정상 → 대기 중');
  ok((await act('u01', 'call', { point: 'field' })).s === 400, '기지로 호출 → 400');
  ok((await act('u01', 'call', { point: 'main' })).s === 200, 'u01 본관 호출');
  ok((await state('u02')).status === 'busy', '호출 후 → 사용 중');
  ok((await act('u02', 'call', { point: 'eng' })).s === 409, '동시 호출 → 409 busy');
  ok((await act('u02', 'cancel')).s === 403, '남의 취소 → 403');
  let st = await state('u02');
  ok(st.job.by === 'u01' && st.job.by_name === '박보냄', '다른 사람에게도 사용자 이름(학번)이 보인다');
  ok((await act('u01', 'depart')).s === 403, '사용자 출발 → 403');
  ok((await act('drone', 'depart')).s === 200, '기체 출발 (키)');
  ok((await act('drone', 'depart')).s === 409, '이미 비행 중 → 409');
  ok((await act('drone', 'land')).s === 200, '픽업 착륙');
  ok((await act('u02', 'send', { point: 'eng' })).s === 403, '남이 보내기 → 403');
  ok((await act('u01', 'send', { point: 'main' })).s === 400, '같은 지점으로 보내기 → 400');
  ok((await act('u01', 'send', { point: 'eng' })).s === 200, '공학관으로 (받는 사람 지정 없음)');
  st = await state('u02');
  const jb = await (await fetch(H + '/api/delivery/job', { headers: { 'X-Delivery-Key': KEY } })).json();
  ok(jb.job && jb.job.from.id === 'main' && jb.job.to.id === 'eng', '기체 일감 = 본관 → 공학관');
  ok((await act('drone', 'depart')).s === 200 && (await act('drone', 'land')).s === 200, '목적지 출발·착륙');

  console.log('— 재시작');
  srv.kill(); await sleep(500); srv = await server();
  st = await state('u02');
  ok(st.job && st.job.leg === 'dest' && st.job.phase === 'landed', '재시작 후 배송 유지');
  ok(st.me && st.me.id === 'u02', '재시작 후 로그인 유지');
  ok(st.can.includes('done'), '호출하지 않은 사람에게도 수거완료 버튼');
  ok((await act('u02', 'done')).s === 200, 'u02 수거완료');
  ok((await act('drone', 'depart')).s === 200 && (await act('drone', 'land')).s === 200, '기지 복귀·착륙');
  await link();
  st = await state('u01');
  ok(st.job === null && st.can.includes('call') && st.status === 'ready', '배송 끝 → 대기 중, 다시 호출 가능');

  console.log('— 대기 시간 초과');
  await link(); await act('u01', 'call', { point: 'lib' }); await act('drone', 'depart'); await act('drone', 'land');
  await sleep(4000);
  st = await state('u01');
  ok(st.job && st.job.leg === 'home' && st.job.flags.includes('timeout:pickup'), '픽업 대기 초과 → 복귀');
  await act('drone', 'depart'); await act('drone', 'land');
  ok((await state('u01')).job === null, '복귀 후 끝');

  console.log('— 서버 시뮬레이션 기체 (DELIVERY_SIM=on)');
  srv.kill(); await sleep(500);
  Object.assign(ENV, { DELIVERY_SIM: 'on', SIM_ALT: '4', SIM_SPEED: '200', SIM_CLIMB: '20', SIM_DESC: '20', SIM_WAIT: '0.3' });
  srv = await server();
  await link({ fix: 1, volt: 0.03 });   // rim3 에 FC 만 꽂힌 실내 상태 — 배송은 이걸 보지 않는다
  st = await state('u01');
  ok(st.status === 'ready', '실제 FC 가 비행 불가로 붙어 있어도 시뮬레이션 기체 → 대기 중', st.status);
  let ls = await (await fetch(H + '/api/delivery/live?track=0')).json();
  ok(ls.sim === true && ls.live === false && Math.abs(ls.d.lat - 35.181070) < 1e-6, '배송 기체 = 기지의 시뮬레이션 기체 (live:false)');
  const real = await (await fetch(H + '/api/live/state?track=0')).json();
  ok(real.sim === undefined && real.live === true && real.d.fix === 1, '/api/live/state 는 실제 FC 신호 그대로 (섞이지 않음)');
  ok((await act('u01', 'call', { point: 'main' })).s === 200, '본관 호출');
  const until = async (f, ms = 15000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const x = await state('u01'); if (f(x)) return x; await sleep(250); } return null; };
  ok(!!(await until((x) => x.job && x.job.phase === 'fly')), '스스로 이륙');
  ls = await (await fetch(H + '/api/delivery/live?track=0')).json();
  ok(ls.d.armed === true && ls.d.alt > 0, '날고 있는 기체가 배송 기체 상태에 보인다');
  ok(!!(await until((x) => x.job && x.job.leg === 'pickup' && x.job.phase === 'landed')), '본관 도착·착륙');
  const anon = await state();
  ok(anon.points.length === 6 && anon.job && anon.job.by === 'u01' && anon.job.by_name === '박보냄' && anon.can.length === 0, '비로그인: 사용자까지 다 보이고 동작은 없다');
  ok((await act('u01', 'send', { point: 'field' })).s === 200, '기지(대운동장)로 보내기');
  ok(!!(await until((x) => x.job && x.job.leg === 'dest' && x.job.phase === 'landed')), '기지 도착');
  ok((await act('u02', 'done')).s === 200, '기지에서 수거완료');
  st = await state('u01');
  ok(st.job === null && st.status === 'ready', '기지에서 받으면 바로 끝 → 대기 중');

  const lines = fs.readFileSync(path.join(DATA, 'delivery-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(lines.filter((l) => l.act === 'end').length === 3, '기록: 끝난 배송 3건');
  ok(!fs.readFileSync(path.join(DATA, 'delivery-log.jsonl'), 'utf8').includes('"pw"'), '기록에 비밀번호 없음');

  console.log(`\n${pass} 통과, ${fail} 실패`);
  for (const k of kids) k.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); for (const k of kids) k.kill(); process.exit(1); });
