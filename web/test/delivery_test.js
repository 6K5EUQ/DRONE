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
  SUGANG_URL: `http://127.0.0.1:${FAKE_PORT}/Default.aspx`, DELIVERY_ADMINS: 'adm', DELIVERY_KEY: KEY,
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
  ok((await login('adm')).s === 200 && !!cookies.adm, '관리자 로그인');
  ok((await login('u02')).s === 200, 'u02 로그인');
  let me = await state('adm');
  ok(me.me && me.me.admin === true, '관리자 표시');
  ok((await state()).points.length === 0 && (await state()).me === null, '비로그인은 지점 안 보임');

  console.log('— 요청 막이');
  ok((await req('POST', '/api/delivery/act', { who: 'adm', headers: { Origin: 'https://evil.bewe.co.kr' }, body: { act: 'service', rev: me.rev, on: true } })).s === 403, '다른 Origin → 403');
  ok((await req('POST', '/api/delivery/act', { who: 'adm', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ act: 'service', rev: me.rev }) })).s === 415, 'text/plain → 415');
  ok((await req('POST', '/api/delivery/act', { body: { act: 'call', rev: 0 } })).s === 401, '비로그인 act → 401');
  ok((await req('POST', '/api/delivery/act', { who: 'adm', headers: { Origin: 'https://drone01.bewe.co.kr' }, body: { act: 'service', rev: -1, on: false } })).s === 409, '옛 rev → 409');

  console.log('— 지점');
  ok((await act('u02', 'pt_add', { name: 'A', lat: 35.18, lon: 128.55 })).s === 403, '일반 사용자 지점 추가 → 403');
  for (const [name, lat, lon] of [['기지', 35.1801, 128.5531], ['대운동장', 35.1811, 128.5538], ['옥상', 35.1820, 128.5550], ['도서관 앞', 35.1830, 128.5560]]) {
    ok((await act('adm', 'pt_add', { name, lat, lon })).s === 200, `지점 추가 ${name}`);
  }
  let pts = (await state('adm')).points;
  const [B, P1, P2, P3] = pts.map((p) => p.id);
  ok((await act('adm', 'pt_set', { point: B, base: true })).s === 200, '기지 지정');
  ok((await act('u01', 'call', { point: P1 })).s === 401, '로그인 안 한 u01 호출 → 401');
  await login('u01');
  ok((await act('u01', 'call', { point: P1 })).s === 503, '운행 꺼짐 → 503');
  ok((await act('adm', 'service', { on: true })).s === 200, '운행 켬');
  ok((await act('u01', 'call', { point: P1 })).s === 403, '미검증 지점 호출 → 403');
  ok((await act('adm', 'pt_measure', { point: P1 })).s === 409, 'GPS 없으면 실측 409');
  const push = (d) => fetch(H + '/api/live/push', { method: 'POST', headers: { 'X-Live-Key': LIVE, 'Content-Type': 'application/json' }, body: JSON.stringify({ live: true, d }) });
  await push({ lat: 35.18112, lon: 128.55383, alt_msl: 61.2, fix: 3, sats: 14, eph: 0.9 });
  ok((await act('adm', 'pt_measure', { point: P1 })).s === 200, '실측');
  pts = (await state('adm')).points;
  const p1 = pts.find((p) => p.id === P1);
  ok(p1.verified && p1.lat === 35.18112 && p1.alt === 61.2, '실측 좌표·고도로 덮임');
  for (const id of [P2, P3]) { await push({ lat: 35.182, lon: 128.555, alt_msl: 70, fix: 3 }); await act('adm', 'pt_measure', { point: id }); }

  console.log('— 배송 한 바퀴');
  ok((await act('u01', 'call', { point: P1 })).s === 200, 'u01 호출');
  ok((await act('u02', 'call', { point: P2 })).s === 409, '동시 호출 → 409 busy');
  ok((await act('u02', 'cancel')).s === 403, '남의 취소 → 403');
  let st = await state('u02');
  ok(st.job.by === '***', '남의 학번 가림');
  ok((await act('u01', 'depart')).s === 403, '사용자 출발 → 403');
  ok((await act('drone', 'depart')).s === 200, '기체 출발 (키)');
  ok((await act('drone', 'depart')).s === 409, '이미 비행 중 → 409');
  ok((await act('drone', 'land')).s === 200, '픽업 착륙');
  ok((await act('u01', 'send', { point: P1, to: 'u02' })).s === 400, '같은 지점으로 보내기 → 400');
  ok((await act('u01', 'send', { point: P2, to: 'u02' })).s === 200, '목적지 선택, 받는 사람 u02');
  const jb = await (await fetch(H + '/api/delivery/job', { headers: { 'X-Delivery-Key': KEY } })).json();
  ok(jb.job && jb.job.from.id === P1 && jb.job.to.id === P2, '기체 일감 = P1 → P2');
  ok((await act('adm', 'depart')).s === 200 && (await act('adm', 'land')).s === 200, '관리자가 출발·착륙 진행');

  console.log('— 재시작');
  srv.kill(); await sleep(500); srv = await server();
  st = await state('u02');
  ok(st.job && st.job.leg === 'dest' && st.job.phase === 'landed', '재시작 후 배송 유지');
  ok(st.me && st.me.id === 'u02', '재시작 후 로그인 유지');
  ok(st.can.includes('done'), '받는 사람에게 수거완료 버튼');
  ok((await act('u02', 'done')).s === 200, 'u02 수거완료');
  ok((await act('drone', 'depart')).s === 200 && (await act('drone', 'land')).s === 200, '기지 복귀·착륙');
  st = await state('u01');
  ok(st.job === null && st.can.includes('call'), '배송 끝, 다시 호출 가능');

  console.log('— 대기 시간 초과');
  await act('u01', 'call', { point: P3 }); await act('drone', 'depart'); await act('drone', 'land');
  await sleep(4000);
  st = await state('u01');
  ok(st.job && st.job.leg === 'home' && st.job.flags.includes('timeout:pickup'), '픽업 대기 초과 → 복귀');
  await act('drone', 'depart'); await act('drone', 'land');
  ok((await state('u01')).job === null, '복귀 후 끝');

  const lines = fs.readFileSync(path.join(DATA, 'delivery-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  ok(lines.filter((l) => l.act === 'end').length === 2, '기록: 끝난 배송 2건');
  ok(!fs.readFileSync(path.join(DATA, 'delivery-log.jsonl'), 'utf8').includes('"pw"'), '기록에 비밀번호 없음');

  console.log(`\n${pass} 통과, ${fail} 실패`);
  for (const k of kids) k.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); for (const k of kids) k.kill(); process.exit(1); });
