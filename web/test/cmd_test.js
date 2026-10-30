// 명령 대기열 시험 — 가짜 학교 서버(운용자 로그인)와 drone01 서버를 띄우고, 가짜 에이전트(파이)로 롱폴·ack 를 돈다.
//
//   node web/test/cmd_test.js
//
// 데이터는 임시 폴더에만 쓴다. FC·파이로는 아무것도 안 나간다. ttl·확인 창은 운영값 그대로라 ~40초 걸린다.

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WEB = path.dirname(__dirname);
const FAKE_PORT = 4391, PORT = 4390;
const H = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'cmd-'));
const KEY = 'cmd-key-for-test-0123456789', LIVE = 'live-key-for-test-0123456789', DKEY = 'drone-key-for-test-0123456789';
const ENV = {
  ...process.env, PORT: String(PORT), DATA_DIR: DATA, UPLOAD_PASSWORD: 'x', LIVE_PUSH_KEY: LIVE, DELIVERY_KEY: DKEY,
  SUGANG_URL: `http://127.0.0.1:${FAKE_PORT}/Default.aspx`, DELIVERY_SECRET: 'secret-for-test',
  CMD_KEY: '', CMD_OPERATORS: '',
};
const kids = [];
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(file, args, env) {
  const k = spawn(process.execPath, [file, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  k.stdout.on('data', () => {}); k.stderr.on('data', (d) => process.stderr.write(d));
  kids.push(k); return k;
}
/** 정상 종료(SIGTERM) 하고 끝날 때까지 기다린다 */
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
async function login(id, pw = 'pw') {
  const x = await req('POST', '/api/auth/login', { body: { id, pw } });
  const sc = x.r.headers.getSetCookie();
  if (sc.length) cookies[id] = sc[0].split(';')[0];
  return x;
}
let cid = 0;
const cmd = (who, kind, args, client_id = 'c' + (++cid)) => req('POST', '/api/cmd', { who, body: { kind, args, client_id } });
const confirm = (who, id) => req('POST', `/api/cmd/${id}/confirm`, { who, body: {} });
const list = async (who = 'u01') => (await req('GET', '/api/cmd', { who })).j.cmds;
const stateOf = async (id) => ((await list()).find((c) => c.id === id) || {}).state;
// 가짜 에이전트 — 롱폴과 ack
const next = (wait = 0, key = KEY) => req('GET', `/api/cmd/next?wait=${wait}`, { headers: key == null ? {} : { 'X-Cmd-Key': key } });
const ack = (id, state, o = {}, key = KEY) => req('POST', `/api/cmd/${id}/ack`, { headers: { 'X-Cmd-Key': key }, body: { state, ...o } });
// 기체 링크 — 3초 안에 갱신된 라이브 상태
const link = (o = {}) => fetch(H + '/api/live/push', { method: 'POST', headers: { 'X-Live-Key': LIVE, 'Content-Type': 'application/json' },
  body: JSON.stringify({ live: true, d: { lat: 35.18107, lon: 128.55381, fix: 3, sats: 14, volt: 16.2, armed: false, ...o } }) });
async function server() {
  const s = start(path.join(WEB, 'server.js'), [], ENV);
  await up(H + '/api/health');
  return s;
}

(async () => {
  start(path.join(__dirname, 'fake_sugang.js'), [String(FAKE_PORT)], process.env);
  await up(`http://127.0.0.1:${FAKE_PORT}/count`);
  let srv = await server();

  console.log('— (1) 키·운용자가 비어 있으면 전부 거부');
  ok((await login('u01')).s === 200, 'u01 로그인');
  ok((await cmd('u01', 'rtl')).s === 403, 'CMD_OPERATORS 비어 있음 → 403');
  ok((await next(0, 'anything')).s === 403, 'CMD_KEY 비어 있음 → 아무 키나 403');
  ok((await next(0, '')).s === 403, 'CMD_KEY 비어 있음 + 빈 키 → 403');

  await stop(srv); Object.assign(ENV, { CMD_KEY: KEY, CMD_OPERATORS: 'u01, adm' }); srv = await server();
  ok((await login('u02')).s === 200 && (await login('adm')).s === 200, 'u02·adm 로그인');

  console.log('— (1) 인증·요청 막이');
  ok((await next(0, null)).s === 403, '키 없음 → 403');
  ok((await next(0, 'wrong-key-wrong-key-wrong-k')).s === 403, '틀린 키 → 403');
  ok((await next(0, LIVE)).s === 403 && (await next(0, DKEY)).s === 403, 'LIVE·DELIVERY 키 → 403');
  ok((await req('GET', '/api/cmd/next', { headers: { 'X-Delivery-Key': DKEY } })).s === 403, 'X-Delivery-Key 로는 못 가져간다');
  ok((await cmd(undefined, 'rtl')).s === 401, '비로그인 → 401');
  ok((await cmd('u02', 'rtl')).s === 403, '운용자 목록 밖 → 403');
  ok((await req('GET', '/api/cmd')).s === 401, '비로그인 목록 → 401');
  ok((await cmd('u01', 'takeoff')).s === 400, '허용 목록 밖 kind → 400');
  ok((await cmd('u01', 'mode', { mode: 'stabilize' })).s === 400, '허용 밖 모드 → 400');
  ok((await req('POST', '/api/cmd', { who: 'u01', body: '{nope' })).s === 400, 'JSON 아님 → 400');
  ok((await req('POST', '/api/cmd', { who: 'u01', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).s === 415, 'text/plain → 415');
  ok((await req('POST', '/api/cmd', { who: 'u01', headers: { Origin: 'https://evil.bewe.co.kr' }, body: { kind: 'rtl', client_id: 'x' } })).s === 403, '다른 Origin → 403');
  ok((await req('POST', '/api/cmd', { who: 'u01', body: { kind: 'rtl', client_id: 'big', args: { pad: 'x'.repeat(70 * 1024) } } })).s === 413, '64KB 넘음 → 413');
  ok((await ack('000000000000', 'done', {}, 'wrong-key-wrong-key-wrong-k')).s === 403, '틀린 키 ack → 403');
  ok((await list()).length === 0, '거부된 요청은 명령을 안 만든다');

  console.log('— (3) 롱폴 — 없으면 204, 새 명령엔 즉시');
  let t0 = Date.now(), x = await next(1);
  ok(x.s === 204 && Date.now() - t0 >= 900, '줄 것 없음 → 1초 뒤 204');
  t0 = Date.now();
  const poll = next(10);
  await sleep(500);
  let rtl = await cmd('u01', 'rtl');
  // 기다리던 롱폴이 바로 가져가므로 응답은 이미 delivered 일 수 있다 — 기록으로 확인 없이 queued 였는지 본다
  const hist = (id) => fs.readFileSync(path.join(DATA, 'cmd-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.id === id).map((l) => l.to);
  ok(rtl.s === 201 && ['queued', 'delivered'].includes(rtl.j.state) && hist(rtl.j.id).join() === 'created,queued,delivered', '(2) rtl → 확인 없이 queued', JSON.stringify(rtl.j) + hist(rtl.j.id));
  x = await poll;
  ok(x.s === 200 && x.j.id === rtl.j.id && x.j.kind === 'rtl' && Date.now() - t0 < 2000, '롱폴이 새 명령에 즉시 응답', `${Date.now() - t0}ms`);
  ok(x.j.ttl_ms > 25000 && x.j.ttl_ms <= 30000, 'ttl_ms = 남은 시간 (rtl 30초)', x.j.ttl_ms);
  ok(await stateOf(rtl.j.id) === 'delivered', '가져가면 delivered');

  console.log('— (2) arm 은 확인을 거친다');
  let arm = await cmd('u01', 'arm');
  ok(arm.s === 201 && arm.j.state === 'awaiting_confirm', 'arm → awaiting_confirm');
  ok((await confirm('adm', arm.j.id)).s === 403, '다른 운용자 확인 → 403');
  await link();
  x = await confirm('u01', arm.j.id);
  ok(x.s === 200 && x.j.state === 'queued', '같은 사용자 확인 → queued', JSON.stringify(x.j));
  ok((await confirm('u01', arm.j.id)).s === 409, '두 번 확인 → 409');

  console.log('— (4) 한 번에 1건만');
  t0 = Date.now(); x = await next(1);
  ok(x.s === 204 && Date.now() - t0 >= 900, 'rtl 이 끝나기 전엔 arm 을 안 내준다');
  const poll2 = next(10);
  await sleep(300);
  console.log('— (8) ack 전이');
  ok((await ack(rtl.j.id, 'fc_ack')).s === 200, 'delivered → fc_ack (sent 건너뜀 허용)');
  ok((await ack(rtl.j.id, 'sent')).s === 409, '뒤로 가는 ack → 409');
  ok((await ack(rtl.j.id, 'bogus')).s === 400, '없는 상태 → 400');
  ok((await ack(rtl.j.id, 'done', { mav_result: 0, detail: 'ok' })).s === 200, 'fc_ack → done');
  x = await poll2;
  ok(x.s === 200 && x.j.id === arm.j.id && x.j.ttl_ms <= 10000, '앞 명령이 끝나자 기다리던 롱폴에 arm', JSON.stringify(x.j));
  ok((await ack(arm.j.id, 'sent')).s === 200 && (await ack(arm.j.id, 'failed', { mav_result: 4, detail: 'denied' })).s === 200, 'arm sent → failed');
  let L = await list();
  ok(L.find((c) => c.id === rtl.j.id).state === 'done' && L.find((c) => c.id === arm.j.id).mav_result === 4, '목록에 done / failed(mav_result 4)');
  ok((await ack(arm.j.id, 'done')).s === 409, '끝난 명령 ack → 409');

  console.log('— 사전조건·취소·밀어내기');
  arm = await cmd('u01', 'arm');
  await link({ volt: 13.5 });
  x = await confirm('u01', arm.j.id);
  ok(x.s === 409 && x.j.state === 'rejected' && x.j.reason === 'volt', '전압 13.5 V → rejected volt', JSON.stringify(x.j));
  arm = await cmd('u01', 'arm');
  await link({ armed: true });
  ok((await confirm('u01', arm.j.id)).j.reason === 'armed', '이미 시동 → rejected armed');
  arm = await cmd('u01', 'mission_start');
  await link({ fix: 2, armed: true });
  ok((await confirm('u01', arm.j.id)).j.reason === 'gps', 'fix 2 → rejected gps');
  arm = await cmd('u01', 'mission_start');
  await link({ armed: false });
  ok((await confirm('u01', arm.j.id)).j.reason === 'disarmed', 'mission_start 는 시동이 꺼져 있으면 → rejected disarmed');
  arm = await cmd('u01', 'mission_start');
  await link({ armed: true });
  ok((await confirm('u01', arm.j.id)).j.state === 'queued', '시동 뒤 mission_start → queued');
  arm = await cmd('u01', 'arm');
  await link(); await sleep(3200);
  ok((await confirm('u01', arm.j.id)).j.reason === 'live-stale', '라이브 3초 넘음 → rejected live-stale');
  const loi = await cmd('u01', 'mode', { mode: 'loiter' });
  ok(loi.j.state === 'queued', 'mode loiter → 확인 없이 queued');
  ok((await req('POST', `/api/cmd/${loi.j.id}/cancel`, { who: 'adm', body: {} })).s === 200 && await stateOf(loi.j.id) === 'cancelled', '전달 전 취소 → cancelled');
  const auto = await cmd('u01', 'mode', { mode: 'auto' });
  ok(auto.j.state === 'awaiting_confirm', 'mode auto → awaiting_confirm');
  const land = await cmd('adm', 'land');
  ok(land.j.state === 'queued' && await stateOf(auto.j.id) === 'preempted', 'land 가 전달 전 명령을 밀어냄 → preempted');
  x = await next(0);
  ok(x.j.id === land.j.id, 'land 를 가져감');
  ok((await req('POST', `/api/cmd/${land.j.id}/cancel`, { who: 'adm', body: {} })).s === 409, '전달 뒤 취소 → 409');
  ok((await ack(land.j.id, 'done')).s === 200, 'land done');

  console.log('— (5) client_id 중복 방지');
  const a1 = await cmd('u01', 'disarm', {}, 'same-1'), a2 = await cmd('u01', 'disarm', {}, 'same-1');
  ok(a1.s === 201 && a2.s === 200 && a1.j.id === a2.j.id, '같은 사용자·client_id → 기존 명령');
  const a3 = await cmd('adm', 'disarm', {}, 'same-1');
  ok(a3.s === 201 && a3.j.id !== a1.j.id, '다른 사용자·같은 client_id → 새 명령');
  ok((await next(0)).j.id === a1.j.id, 'FIFO — 먼저 만든 것부터');
  await ack(a1.j.id, 'done');
  ok((await next(0)).j.id === a3.j.id, '그다음');
  await ack(a3.j.id, 'expired');
  ok(await stateOf(a3.j.id) === 'expired', '파이가 받은 뒤 만료 판정 → expired');

  console.log('— (6) ttl 만료 (운영값, ~16초)');
  arm = await cmd('u01', 'arm');
  await link();
  ok((await confirm('u01', arm.j.id)).j.state === 'queued', 'arm queued (안 가져감)');
  // 업로드는 서버가 항목·hash 를 검사한다(mission.js) — 계획에서 받은 그대로 쓴다
  const pl = (await req('POST', '/api/mission/plan', { who: 'u01', body: { title: '본관' } })).j;
  const wait = await cmd('u01', 'mission_upload', { items: pl.items, hash: pl.hash });
  ok(wait.j.state === 'awaiting_confirm', 'mission_upload → awaiting_confirm (확인 안 함)');
  await sleep(11000);
  ok(await stateOf(arm.j.id) === 'expired', 'arm ttl 10초 지남 → expired');
  ok((await next(0)).s === 204, '만료된 명령은 안 내준다');
  await sleep(5000);
  ok(await stateOf(wait.j.id) === 'expired', '확인 15초 지남 → expired');
  ok((await confirm('u01', wait.j.id)).s === 409, '만료 뒤 확인 → 409');

  console.log('— (7) 재시작 — 끝나지 않은 명령은 expired');
  const r1 = await cmd('u01', 'rtl');
  ok((await next(0)).j.id === r1.j.id, 'rtl delivered');
  const r2 = await cmd('u01', 'land');
  ok(r2.j.state === 'queued', 'land queued');
  await stop(srv); srv = await server();
  ok((await list()).length === 0, '재시작 후 대기열 비어 있음');
  ok((await next(1)).s === 204, '재시작 후 아무것도 안 내준다');
  ok((await ack(r1.j.id, 'done')).s === 404, '옛 명령 ack → 404');
  const lines = fs.readFileSync(path.join(DATA, 'cmd-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const restart = lines.filter((l) => l.reason === 'restart');
  ok(restart.length === 2 && restart.every((l) => l.to === 'expired') && restart.map((l) => l.id).sort().join() === [r1.j.id, r2.j.id].sort().join(),
    '기록: 미완료 2건 restart 로 expired', JSON.stringify(restart));
  await stop(srv); srv = await server();
  ok(fs.readFileSync(path.join(DATA, 'cmd-log.jsonl'), 'utf8').trim().split('\n').filter((l) => l.includes('"restart"')).length === 2, '두 번째 재시작은 다시 만료하지 않는다');
  ok(lines.some((l) => l.to === 'created' && l.kind === 'arm' && l.by === 'u01'), '기록: 만든 사람·종류');

  console.log(`\n${pass} 통과, ${fail} 실패`);
  for (const k of kids) await stop(k);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); for (const k of kids) await stop(k); process.exit(1); });
