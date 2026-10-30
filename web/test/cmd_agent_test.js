// 파이 명령 에이전트(tools/live/cmd_agent.py, dry-run) 시험 — drone01 서버를 띄우고 에이전트를 자식으로 돌린다.
//
//   node web/test/cmd_agent_test.js
//
// 데이터·seen_ids 는 임시 폴더(HOME 을 바꿔서)에만 쓴다. FC·파이로는 아무것도 안 나간다. ~30초.
// 같은 id 재전달·ttl 0 은 진짜 서버가 만들 수 없어 가짜 대기열 서버(FAKE_CMD_PORT)로 본다.

'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const WEB = path.dirname(__dirname);
const ROOT = path.dirname(WEB);
const AGENT = path.join(ROOT, 'tools', 'live', 'cmd_agent.py');
const PY = fs.existsSync(path.join(ROOT, '.venv', 'bin', 'python')) ? path.join(ROOT, '.venv', 'bin', 'python') : 'python3';
const PORT = 4392, FAKE_PORT = 4393, FAKE_CMD_PORT = 4394;
const H = `http://127.0.0.1:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdagent-'));
const DATA = path.join(TMP, 'data'), HOME = path.join(TMP, 'home');
fs.mkdirSync(DATA); fs.mkdirSync(HOME);
const SEEN = path.join(HOME, '.local', 'state', 'drone-cmd', 'seen_ids');
const KEY = 'cmd-key-for-test-0123456789';
const ENV = {
  ...process.env, PORT: String(PORT), DATA_DIR: DATA, UPLOAD_PASSWORD: 'x', LIVE_PUSH_KEY: 'live-key-for-test-0123456789',
  DELIVERY_KEY: 'drone-key-for-test-0123456789', SUGANG_URL: `http://127.0.0.1:${FAKE_PORT}/Default.aspx`,
  DELIVERY_SECRET: 'secret-for-test', CMD_KEY: KEY, CMD_OPERATORS: 'u01',
};
const kids = [];
let pass = 0, fail = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function start(cmd, args, env) {
  const k = spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  k.out = [];
  let buf = '';
  k.stdout.on('data', (d) => { buf += d; const ls = buf.split('\n'); buf = ls.pop(); k.out.push(...ls); });
  k.stderr.on('data', (d) => process.stderr.write(d));
  kids.push(k); return k;
}
function stop(k) {
  if (k.exitCode !== null || k.signalCode !== null) return Promise.resolve();
  return new Promise((r) => { k.once('exit', r); k.kill('SIGTERM'); });
}
async function up(url) { for (let i = 0; i < 50; i++) { try { await fetch(url); return; } catch { await sleep(200); } } throw new Error('안 뜬다 ' + url); }
async function until(f, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(100); } return false; }
function ok(cond, name, extra = '') { if (cond) pass++; else { fail++; console.log('  ✖', name, extra); } }

let cookie = '';
async function req(method, p, body) {
  const h = { Cookie: cookie };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(H + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* 본문 없음 */ }
  return { s: r.status, j, r };
}
async function login() {
  const x = await req('POST', '/api/auth/login', { id: 'u01', pw: 'pw' });
  cookie = (x.r.headers.getSetCookie()[0] || '').split(';')[0];
  return x;
}
let cid = 0;
const cmd = (kind, args) => req('POST', '/api/cmd', { kind, args, client_id: 'a' + (++cid) });
const hist = (id) => fs.readFileSync(path.join(DATA, 'cmd-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.id === id);
const agent = (url, key) => start(PY, [AGENT, '--url', url], { ...process.env, HOME, CMD_KEY: key, CMD_URL: '' });
const server = async () => { const s = start(process.execPath, [path.join(WEB, 'server.js')], ENV); await up(H + '/api/health'); return s; };

(async () => {
  start(process.execPath, [path.join(__dirname, 'fake_sugang.js'), String(FAKE_PORT)], process.env);
  await up(`http://127.0.0.1:${FAKE_PORT}/count`);
  let srv = await server();
  ok((await login()).s === 200, 'u01 로그인');

  console.log('— 키 없음 → 시작하며 이유를 말하고 종료');
  const nokey = start(PY, [AGENT, '--url', H], { ...process.env, HOME, CMD_KEY: '' });
  const code = await new Promise((r) => nokey.once('exit', r));
  ok(code !== 0, '키 없으면 종료', code);

  console.log('— (3) 키가 틀리면 못 가져가고, 알림은 한 번만');
  let ag = agent(H, 'wrong-key-wrong-key-wrong-k');
  let c = await cmd('rtl');
  await sleep(7500);   // 백오프 2→4초 — 요청 3번
  ok(hist(c.j.id).map((l) => l.to).join() === 'created,queued', '틀린 키 → 안 가져감(queued 그대로)', JSON.stringify(hist(c.j.id)));
  ok(ag.out.filter((l) => l.includes('키가 맞나')).length === 1, '"키가 맞나?" 한 번', JSON.stringify(ag.out));
  ok(!ag.out.join('\n').includes('wrong-key') && !ag.out.join('\n').includes(KEY), '키를 로그에 안 찍는다');
  await stop(ag);
  await req('POST', `/api/cmd/${c.j.id}/cancel`, {});

  console.log('— (1) rtl → 가져가 rejected(dry-run) ack → 서버 기록 rejected');
  ag = agent(H, KEY);
  await sleep(500);
  c = await cmd('rtl');
  ok(await until(() => hist(c.j.id).some((l) => l.to === 'rejected')), '서버 기록에 rejected', JSON.stringify(hist(c.j.id)));
  const rj = hist(c.j.id).find((l) => l.to === 'rejected') || {};
  ok(rj.from === 'delivered' && rj.by === 'pi' && rj.detail === 'dry-run', 'delivered → rejected, detail dry-run', JSON.stringify(rj));
  ok(await until(() => ag.out.some((l) => l.includes(c.j.id) && l.includes('rejected') && l.includes('ack 200'))), '에이전트 한 줄 로그', JSON.stringify(ag.out));
  ok(fs.readFileSync(SEEN, 'utf8').split('\n').some((l) => l.split('\t')[0] === c.j.id), 'seen_ids 에 남김');
  ok(!ag.out.some((l) => /204/.test(l)), '204 는 안 찍는다');

  console.log('— (4) 서버 끊김 후 복구');
  await stop(srv);
  await sleep(3000);
  ok(ag.out.filter((l) => l.includes('못 닿는다')).length === 1, '끊김 알림 한 번', JSON.stringify(ag.out));
  srv = await server();
  await login();
  c = await cmd('land');
  ok(await until(() => hist(c.j.id).some((l) => l.to === 'rejected'), 35000), '복구 뒤 land 를 가져가 rejected', JSON.stringify(hist(c.j.id)));
  ok(ag.out.some((l) => l.includes('서버 복구')), '복구 알림');
  await stop(ag);

  console.log('— (2)(5) 가짜 대기열 — 같은 id 재전달·ttl 0');
  const give = [{ id: 'aaaaaaaaaaaa', kind: 'rtl', args: {}, ttl_ms: 30000 }, { id: 'aaaaaaaaaaaa', kind: 'rtl', args: {}, ttl_ms: 30000 },
                { id: 'bbbbbbbbbbbb', kind: 'arm', args: {}, ttl_ms: 0 }];
  const acks = [], uas = new Set();
  const fake = http.createServer((q, s) => {
    uas.add(q.headers['user-agent']);
    if (q.headers['x-cmd-key'] !== KEY) return s.writeHead(403).end('{}');
    if (q.url.startsWith('/api/cmd/next')) {
      const g = give.shift();
      if (g) return s.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(g));
      return setTimeout(() => s.writeHead(204).end(), 1000);
    }
    let b = ''; q.on('data', (d) => { b += d; });
    q.on('end', () => { acks.push({ id: q.url.split('/')[3], ...JSON.parse(b) }); s.writeHead(200).end('{}'); });
  }).listen(FAKE_CMD_PORT, '127.0.0.1');
  ag = agent(`http://127.0.0.1:${FAKE_CMD_PORT}`, KEY);
  ok(await until(() => acks.length >= 3), 'ack 3건', JSON.stringify(acks));
  ok(acks[0] && acks[0].state === 'rejected' && acks[0].detail === 'dry-run', '첫 번째 → rejected dry-run', JSON.stringify(acks[0]));
  ok(acks[1] && acks[1].id === 'aaaaaaaaaaaa' && acks[1].state === 'rejected' && acks[1].detail === 'dry-run', '같은 id 재전달 → 실행 없이 같은 결과(rejected dry-run) 재응답', JSON.stringify(acks[1]));
  ok(acks[2] && acks[2].state === 'expired', 'ttl 0 → expired', JSON.stringify(acks[2]));
  ok(uas.size === 1 && uas.has('drone01-cmdagent/1.0'), 'User-Agent', [...uas].join());
  await stop(ag);
  // 재시작해도 seen_ids 로 기억한다
  give.push({ id: 'aaaaaaaaaaaa', kind: 'rtl', args: {}, ttl_ms: 30000 });
  ag = agent(`http://127.0.0.1:${FAKE_CMD_PORT}`, KEY);
  ok(await until(() => acks.length >= 4), '재시작 후 ack');
  ok(acks[3] && acks[3].state === 'rejected' && acks[3].detail === 'dry-run', '재시작 후에도 같은 결과 재응답(재실행 없음)', JSON.stringify(acks[3]));
  await stop(ag);
  // 결과 없이 id 만 남은 경우(실행 중 죽음) → unknown
  fs.appendFileSync(SEEN, 'bbbbbbbbbbbb\n');
  give.push({ id: 'bbbbbbbbbbbb', kind: 'rtl', args: {}, ttl_ms: 30000 });
  ag = agent(`http://127.0.0.1:${FAKE_CMD_PORT}`, KEY);
  ok(await until(() => acks.length >= 5), '결과 없는 id ack');
  ok(acks[4] && acks[4].state === 'unknown' && acks[4].detail === 'duplicate', '결과 없이 id 만 있으면 unknown', JSON.stringify(acks[4]));
  // depart(args.hash)·비상의 preempts 도 dry-run 에서는 실행 없이 거부만
  give.push({ id: 'cccccccccccc', kind: 'depart', args: { hash: 'd906b2c6ff4adfc5' }, ttl_ms: 30000 },
            { id: 'dddddddddddd', kind: 'land', args: {}, ttl_ms: 30000, preempts: ['cccccccccccc'] });
  ok(await until(() => acks.length >= 7), 'depart·land ack');
  ok(acks[5] && acks[5].id === 'cccccccccccc' && acks[5].state === 'rejected' && acks[5].detail === 'dry-run', 'depart → rejected dry-run', JSON.stringify(acks[5]));
  ok(acks[6] && acks[6].id === 'dddddddddddd' && acks[6].state === 'rejected' && acks[6].detail === 'dry-run', 'preempts 있는 land → rejected dry-run', JSON.stringify(acks[6]));
  await stop(ag);
  fake.closeAllConnections(); fake.close();

  console.log(`\n${pass} 통과, ${fail} 실패`);
  for (const k of kids) await stop(k);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error(e); for (const k of kids) await stop(k); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(1); });
