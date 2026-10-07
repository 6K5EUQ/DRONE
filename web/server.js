// drone01.shade-signals.com — 비행로그 뷰어
//
// 외부 의존 0. node:http 만 쓴다 (이 호스트의 다른 서비스와 같은 방식).
// Cloudflare 터널 뒤에 있으므로 루프백에만 바인딩한다 — TLS 는 엣지에서 끝난다.
//
// 파싱은 전부 extract.py 서브프로세스가 한다 — 로그 하나가 느리거나 죽어도
// 서버는 산다.
//
// 데이터(업로드·캐시·로그·비밀)는 **워크트리 밖**에 둔다. git clean -fdx 한 번에
// 업로드 원본이 사라지는 경로를 만들지 않는다.

'use strict';

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { execFile } = require('child_process');
const delivery = require('./delivery');

const REPO = path.dirname(__dirname);
const PUBLIC = path.join(__dirname, 'public');
// 라이브 화면은 로컬 트래커와 **같은 파일**을 쓴다 (web/live/public/).
// 사본을 두면 한쪽만 고쳐져 두 화면이 갈라진다 — 그래서 여기서 그대로 낸다.

const PORT = parseInt(process.env.PORT || '4310', 10);
const BIND = process.env.BIND_ADDR || '127.0.0.1';
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data');
const LOGS = process.env.LOG_DIR || path.join(DATA, 'logs');
const CACHE = path.join(DATA, 'cache');
const PY = process.env.PARSE_PYTHON || path.join(REPO, '.venv', 'bin', 'python');
const EXTRACT = path.join(__dirname, 'extract.py');
const UPLOAD_PASSWORD = process.env.UPLOAD_PASSWORD || '';
const MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD || String(64 * 1024 * 1024), 10);
// 라이브 중계용 암호. rim3 의 livepush.py 가 같은 값을 보낸다.
// 🔴 비우면 라이브 **수신**이 막힌다 (보기는 계속 공개다).
const LIVE_PUSH_KEY = process.env.LIVE_PUSH_KEY || '';
// 비행 전 점검. FC 가 꽂힌 PC 의 HTTP 점검 에이전트를 부른다. 이 저장소에는
// 아직 에이전트가 없다 — 생기면 PREFLIGHT_AGENTS 가 그 주소(host:port)를 가리켜야 한다.
// 🔴 비우면 점검이 **막힌 채로** 뜬다. 점검은 읽기 전용이지만 FC 링크를
//    실제로 쓰므로, 공개 조회와 같은 문으로 두지 않는다.
const PREFLIGHT_KEY = process.env.PREFLIGHT_KEY || '';
// 에이전트 후보. 앞에서부터 붙어 보고 먼저 답하는 것을 쓴다.
// 이름이 아니라 주소를 쓰는 이유: 이 서버는 MagicDNS 가 없는 환경에서도 돈다.
const PREFLIGHT_AGENTS = (process.env.PREFLIGHT_AGENTS || '')
  .split(',').map((x) => x.trim()).filter(Boolean);
const PREFLIGHT_TIMEOUT = parseInt(process.env.PREFLIGHT_TIMEOUT || '60000', 10);
// 🔴 화면 접속 암호. **업로드 암호와 따로 둔다** — 업로드는 이 사이트에 로그를
//    영구히 남기는 일이고 점검은 그때뿐인 조회라, 같은 값으로 묶으면 한쪽을
//    현장용으로 쉽게 바꾸는 순간 다른 쪽까지 같이 약해진다.
const PREFLIGHT_PASSWORD = process.env.PREFLIGHT_PASSWORD || '';
const PARSE_TIMEOUT = parseInt(process.env.PARSE_TIMEOUT || '60000', 10);
const MAX_JOBS = parseInt(process.env.MAX_JOBS || '3', 10);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.woff2': 'font/woff2',
};

// ── 캐시 지문 ────────────────────────────────────────────────────────
// 파서나 추출기가 바뀌면 캐시를 통째로 무효화해야 한다. 안 그러면 오늘 고친
// 버그(FC 경고 0건 등)가 캐시에 굳은 채 계속 보인다.
const FINGERPRINT = (() => {
  const h = crypto.createHash('sha1');
  for (const f of [EXTRACT]) {
    try { h.update(fs.readFileSync(f)); } catch { h.update(f); }
  }
  return h.digest('hex').slice(0, 8);
})();
const CACHE_DIR = path.join(CACHE, 'v1.' + FINGERPRINT);

// ── 상태 ─────────────────────────────────────────────────────────────
const catalog = new Map();   // id -> row
let running = 0;
const queue = [];

function log(...a) { console.log(new Date().toISOString(), ...a); }

// ── 파이썬 호출 ──────────────────────────────────────────────────────
function runExtract(mode, file) {
  return new Promise((resolve, reject) => {
    const go = () => {
      running++;
      execFile(PY, [EXTRACT, mode, file],
        { timeout: PARSE_TIMEOUT, maxBuffer: 256 * 1024 * 1024 },
        (err, stdout, stderr) => {
          running--;
          const next = queue.shift();
          if (next) next();
          if (err && !stdout) {
            return reject(new Error(err.killed ? '파싱 시간 초과' :
              (stderr || err.message).slice(0, 300)));
          }
          try { resolve(JSON.parse(stdout)); }
          catch { reject(new Error('추출기 출력이 JSON 이 아니다: ' + stdout.slice(0, 200))); }
        });
    };
    if (running < MAX_JOBS) go(); else queue.push(go);
  });
}

// ── 캐시 ─────────────────────────────────────────────────────────────
const idOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
const cachePath = (id, kind) => path.join(CACHE_DIR, `${id}.${kind}.json.gz`);

async function writeGz(file, obj) {
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(obj)), { level: 6 });
  const tmp = file + '.tmp';
  await fsp.writeFile(tmp, gz);
  await fsp.rename(tmp, file);          // 원자적 — 반쯤 쓰인 캐시를 읽는 일이 없다
}

async function readGz(file) {
  return JSON.parse(zlib.gunzipSync(await fsp.readFile(file)));
}

/** 로그 하나를 파싱해 캐시에 굽는다. 이미 있으면 건너뛴다. */
async function ensureCached(id, file, force = false) {
  const sumPath = cachePath(id, 'sum');
  const trkPath = cachePath(id, 'trk');
  if (!force) {
    try { await fsp.access(sumPath); await fsp.access(trkPath); return null; }
    catch { /* 없으면 굽는다 */ }
  }
  const out = await runExtract('full', file);
  if (!out.ok) throw new Error(out.error || '알 수 없는 파싱 실패');
  await writeGz(sumPath, out.sum);
  await writeGz(trkPath, out.trk);
  return out.row;
}

/** 디스크의 .BIN 을 훑어 카탈로그를 채운다. 없는 캐시는 백그라운드로 굽는다. */
async function reconcile() {
  let names;
  try { names = (await fsp.readdir(LOGS)).filter((n) => n.toLowerCase().endsWith('.bin')); }
  catch { names = []; }

  const pending = [];
  for (const name of names) {
    const file = path.join(LOGS, name);
    let id;
    try { id = idOf(await fsp.readFile(file)); }
    catch (e) { log('읽기 실패', name, e.message); continue; }

    const rowPath = path.join(CACHE_DIR, `${id}.row.json`);
    try {
      const row = JSON.parse(await fsp.readFile(rowPath, 'utf8'));
      // 🔴 이름은 **디스크가 정본이다.** 캐시 키가 내용 해시라 파일을 개명해도
      //    같은 캐시를 쓰는데, 그 안에는 굽던 때의 옛 이름이 박혀 있다.
      catalog.set(id, { ...row, name, id, file });
      continue;
    } catch { /* row 캐시 없음 */ }

    pending.push({ id, name, file, rowPath });
  }

  if (pending.length) log(`캐시 없는 로그 ${pending.length}개 — 파싱 시작`);
  let done = 0;
  await Promise.all(pending.map(async ({ id, name, file, rowPath }) => {
    try {
      const row = await ensureCached(id, file);
      const r = row || (await runExtract('row', file)).row;
      catalog.set(id, { ...r, name, id, file });
      await fsp.writeFile(rowPath + '.tmp', JSON.stringify(r));
      await fsp.rename(rowPath + '.tmp', rowPath);
    } catch (e) {
      log('파싱 실패', name, e.message);
      catalog.set(id, { id, file, name, error: e.message, size: 0 });
    }
    if (++done % 20 === 0) log(`  ${done}/${pending.length}`);
  }));
  log(`카탈로그 ${catalog.size}개 준비됨`);
}

/** 같은 비행의 사본을 하나로 접는다.
 *
 * 같은 비행이 SD 에서 한 번, 텔레메트리로 한 번 올라올 수 있다. 바이트가 달라
 * 해시로는 안 걸린다 — extract.py 의 `flight` 가 그 열쇠다. 남기는 쪽은 디코딩된
 * 샘플이 많은 사본이다. 전부 보려면 `/api/logs?all=1`.
 */
function dedupe(rows, all) {
  const groups = new Map();
  for (const r of rows) {
    const k = r.flight || ('id:' + r.id);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const [, g] of groups) {
    if (g.length === 1) { out.push(g[0]); continue; }
    g.sort((a, b) => (b.points || 0) - (a.points || 0));
    const [best, ...rest] = g;
    if (all) { out.push({ ...best, copies: g.length }, ...rest.map((r) => ({ ...r, superseded: best.id }))); }
    else out.push({ ...best, copies: g.length, copyNames: rest.map((r) => r.name) });
  }
  return out;
}

// ── HTTP 유틸 ────────────────────────────────────────────────────────
function send(req, res, status, body, type, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { 'Content-Type': type, 'X-Robots-Tag': 'noindex, nofollow', ...extra };

  // 🔴 `no-cache` 는 "캐시하지 마라" 가 아니라 "쓰기 전에 서버에 물어봐라" 다.
  //    물어보려면 지문이 있어야 하는데 ETag 도 Last-Modified 도 안 보내고
  //    있었다 — 검증할 것이 없으니 브라우저는 그냥 옛 사본을 쓴다.
  //
  //    그러면 HTML 과 JS 를 같이 고쳐 배포해도 한쪽만 새것으로 바뀌어,
  //    배포 실패로 오해하기 딱 좋다.
  //
  //    본문 해시를 ETag 로 붙인다. 내용이 그대로면 304 로 끝나 트래픽도 준다.
  //    gzip 여부는 지문에 안 섞는다 — Vary: Accept-Encoding 이 이미 가른다.
  if (status === 200 && !headers['ETag']) {
    headers['ETag'] = '"' + crypto.createHash('sha1').update(buf).digest('base64').slice(0, 22) + '"';
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === headers['ETag'])) {
      delete headers['Content-Encoding'];
      res.writeHead(304, headers).end();
      return;
    }
  }

  const wantsGz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (wantsGz && buf.length > 1024 && !headers['Content-Encoding']) {
    const gz = zlib.gzipSync(buf);
    headers['Content-Encoding'] = 'gzip';
    headers['Vary'] = 'Accept-Encoding';
    headers['Content-Length'] = gz.length;
    res.writeHead(status, headers).end(gz);
    return;
  }
  headers['Vary'] = 'Accept-Encoding';
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers).end(buf);
}

const sendJson = (req, res, status, obj) =>
  send(req, res, status, JSON.stringify(obj), TYPES['.json'], { 'Cache-Control': 'no-store' });

/** 캐시 파일은 내용 해시로 주소가 정해지므로 영구 캐시해도 안전하다. */
async function sendCached(req, res, file) {
  let gz;
  try { gz = await fsp.readFile(file); }
  catch { return sendJson(req, res, 404, { error: '캐시 없음' }); }
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    return send(req, res, 200, gz, TYPES['.json'],
      { 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=31536000, immutable' });
  }
  send(req, res, 200, zlib.gunzipSync(gz), TYPES['.json'],
    { 'Cache-Control': 'public, max-age=31536000, immutable' });
}

// ── 업로드 ───────────────────────────────────────────────────────────
function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > max) { reject(new Error('too-large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bufIndexOf(buf, needle, from) {
  const i = buf.indexOf(needle, from);
  return i;
}

/** multipart/form-data 를 손으로 판다. 의존성을 안 늘리기 위해서다. */
function parseMultipart(contentType, body) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) return null;
  const boundary = Buffer.from('--' + (m[1] || m[2]).trim());
  const parts = [];
  let pos = bufIndexOf(body, boundary, 0);
  if (pos < 0) return null;
  pos += boundary.length;
  while (pos < body.length) {
    if (body.slice(pos, pos + 2).toString() === '--') break;      // 끝
    pos += 2;                                                      // CRLF
    const headEnd = bufIndexOf(body, Buffer.from('\r\n\r\n'), pos);
    if (headEnd < 0) break;
    const head = body.slice(pos, headEnd).toString('utf8');
    const next = bufIndexOf(body, boundary, headEnd);
    if (next < 0) break;
    const data = body.slice(headEnd + 4, next - 2);                // 앞 CRLF 제거
    const name = /name="([^"]*)"/i.exec(head);
    const filename = /filename="([^"]*)"/i.exec(head);
    parts.push({ name: name ? name[1] : '', filename: filename ? filename[1] : null, data });
    pos = next + boundary.length;
  }
  return parts;
}

/** 파일명을 안전하게. 날짜가 담긴 원본 이름은 정렬 키라서 최대한 보존한다. */
function safeName(raw) {
  const base = path.basename(String(raw || '')).replace(/[^\w.\-]/g, '_');
  return /\.bin$/i.test(base) ? base.slice(0, 120) : null;
}

function passwordOk(given) {
  if (!UPLOAD_PASSWORD) return false;                 // 미설정이면 업로드 자체를 막는다
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(UPLOAD_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleUpload(req, res) {
  let body;
  try { body = await readBody(req, MAX_UPLOAD); }
  catch { return sendJson(req, res, 413, { error: `용량 초과 (최대 ${Math.round(MAX_UPLOAD / 1e6)}MB)` }); }

  const parts = parseMultipart(req.headers['content-type'], body);
  if (!parts) return sendJson(req, res, 400, { error: '형식 오류' });

  const pw = parts.find((p) => p.name === 'password');
  if (!passwordOk(pw && pw.data.toString('utf8'))) {
    return sendJson(req, res, 401, { error: '암호 오류' });
  }

  const fp = parts.find((p) => p.filename);
  if (!fp || !fp.data.length) return sendJson(req, res, 400, { error: '파일 없음' });

  const name = safeName(fp.filename);
  if (!name) return sendJson(req, res, 400, { error: '형식 오류' });
  // DataFlash 첫 메시지 머리(0xA3 0x95)와 FMT(0x80). 확장자만 믿지 않는다.
  if (fp.data.length < 16 || fp.data[0] !== 0xA3 || fp.data[1] !== 0x95 || fp.data[2] !== 0x80) {
    return sendJson(req, res, 400, { error: '형식 오류' });
  }

  const id = idOf(fp.data);
  if (catalog.has(id)) {
    return sendJson(req, res, 200, { id, duplicate: true, name: catalog.get(id).name });
  }

  // 같은 이름이 이미 있으면 뒤에 -2, -3 을 붙인다. 내용이 다르니 덮으면 안 된다.
  let final = name;
  for (let i = 2; fs.existsSync(path.join(LOGS, final)); i++) {
    final = name.replace(/\.bin$/i, '') + '-' + i + '.BIN';
  }
  // LOGS 바로 아래 평면으로 둔다.
  const dest = path.join(LOGS, final);
  await fsp.writeFile(dest + '.part', fp.data);
  await fsp.rename(dest + '.part', dest);
  log('업로드', final, fp.data.length, 'bytes');

  try {
    const row = await ensureCached(id, dest, true);
    const r = row || (await runExtract('row', dest)).row;
    catalog.set(id, { ...r, id, file: dest });
    await fsp.writeFile(path.join(CACHE_DIR, `${id}.row.json`), JSON.stringify(r));
    sendJson(req, res, 200, { id, name: final, row: r });
  } catch (e) {
    catalog.set(id, { id, file: dest, name: final, error: e.message, size: fp.data.length });
    sendJson(req, res, 200, { id, name: final, error: '읽기 실패' });
  }
}

// ── 정적 파일 ────────────────────────────────────────────────────────
/** 🔴 CDN 이 ETag 를 떼어 간다 — 그래서 URL 자체에 지문을 박는다.
 *
 *  원본은 `Cache-Control: no-cache` 와 ETag 를 정확히 내는데, Cloudflare 를
 *  거치면 ETag 가 사라진다 (원본 O, 엣지 X). 검증할 지문이
 *  없으면 브라우저는 옛 사본을 그냥 쓴다 — 계기판이 안 바뀌던 원인이다.
 *
 *  그래서 HTML 을 내보낼 때 `/live.js` → `/live.js?v=<본문해시>` 로 바꾼다.
 *  내용이 바뀌면 URL 이 바뀌므로 CDN·브라우저 어느 쪽도 옛것을 못 준다.
 *  HTML 자체는 `no-cache` 로 매번 새로 오므로(엣지도 DYNAMIC 이다) 이
 *  치환 결과가 곧바로 반영된다.
 *
 *  로컬호스트(drone_live.py)는 CDN 이 없어 원래 문제가 없다. 같은 파일을
 *  쓰므로 화면은 양쪽이 동일하고, 여기서 붙는 쿼리는 무시해도 무해하다.
 */
const assetTag = (buf) =>
  crypto.createHash('sha1').update(buf).digest('base64url').slice(0, 10);

const NOT_FOUND_HTML = `<!doctype html>
<meta charset="utf-8">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">
<title>없는 페이지 — DRONE01</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/app.css">
<header>
  <h1><a href="/">DRONE01</a></h1>
  <span class="grow"></span>
  <a class="btn" href="/analysis/log">비행 기록</a>
</header>
<main style="padding:30px 20px"><p class="muted">없는 페이지</p></main>
`;

function redirect(req, res, to) {
  res.writeHead(301, { Location: to, 'Cache-Control': 'no-store' }).end();
}

async function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : decodeURIComponent(urlPath).slice(1);
  const file = path.normalize(path.join(PUBLIC, rel));
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    return send(req, res, 403, '거부', 'text/plain; charset=utf-8');
  }
  let buf;
  try { buf = await fsp.readFile(file); }
  catch {
    // 주소창에서 온 없는 페이지는 사이트 모양으로 답한다 — 흰 바탕에 글자만
    // 두면 돌아갈 길이 없다. API·자산(확장자 있음)은 그대로 글자로 답한다.
    if (!path.extname(urlPath) && !urlPath.startsWith('/api/')) {
      return send(req, res, 404, NOT_FOUND_HTML, 'text/html; charset=utf-8');
    }
    return send(req, res, 404, '없다', 'text/plain; charset=utf-8');
  }
  const isHtml = file.endsWith('.html');
  if (isHtml) {
    // CDN 이 ETag 를 떼고 js 를 4시간 쥐고 있어
    // 새 HTML 이 옛 js 와 붙는다. 자산 URL 에 지문을 박는다.
    let html = buf.toString('utf8');
    for (const ref of new Set(html.match(/"\/[\w-]+\.(?:js|css)"/g) || [])) {
      try {
        const v = assetTag(await fsp.readFile(path.join(PUBLIC, ref.slice(2, -1))));
        html = html.split(ref).join(`${ref.slice(0, -1)}?v=${v}"`);
      } catch { /* 그 파일은 그대로 둔다 */ }
    }
    buf = Buffer.from(html, 'utf8');
  }
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const cache = isHtml ? 'no-store, no-cache, must-revalidate'
    : file.includes(path.sep + 'vendor' + path.sep) ? 'public, max-age=604800' : 'no-cache';
  send(req, res, 200, buf, type, { 'Cache-Control': cache });
}

// ── 라이브 중계 ──────────────────────────────────────────────────────
// 🔴 **현장 노트북은 rim3 다.** 비행 나갈 때 들고 나가는 PC 가 rim3 이고, FC 는
//    거기에 USB 로 붙는다. 이 서버는 FC 를 **직접 못 본다** —
//    rim3 의 livepush.py 가 1초마다 밀어 올리는 것을 받아 들고 있을 뿐이다.
//    그래서 rim3 가 꺼져 있거나 인터넷이 없으면 라이브도 없다. 정상이다.
//
// 🔴 **한 방향뿐이다.** 받기만 하고, 여기서 기체로 나가는 경로는 없다.
//    트래커(drone_live.py)가 FC 로 명령을 안 보낸다는 성질을 웹까지 이어 놓은
//    것이다 — 웹에서 ARM·모드변경을 할 길이 구조적으로 존재하지 않는다.
//
// 메모리에만 둔다. 디스크에 안 쓰는 이유: 라이브는 지금 이 순간의 값이고,
// 재시작하면 rim3 가 다음 초에 다시 보낸다. 정본은 비행 후 .BIN 으로 올라온다.
const live = {
  at: 0,            // 마지막으로 받은 시각 (Date.now)
  state: null,      // 마지막 스냅샷 (항적 제외)
  track: [],        // 누적 항적 [[lat,lon,alt], ...]
  dropped: 0,       // 앞에서 버린 점 개수 (증분 프로토콜의 기준)
  pusher: null,     // 어느 PC 가 올렸나
};

// 항적 상한. 트래커와 같은 값이다 — 5Hz 로 40분이면 12000 점.
const LIVE_TRACK_MAX = 12000;

// 이 시간 동안 안 올라오면 「끊김」으로 본다. 중계 주기의 몇 배로 잡는다 —
// 모바일 회선으로 올리면 한두 번은 늦을 수 있다.
const LIVE_STALE_MS = 12000;

function livePushOk(given) {
  if (!LIVE_PUSH_KEY) return false;
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(LIVE_PUSH_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function handleLivePush(req, res) {
  if (!livePushOk(req.headers['x-live-key'])) {
    return sendJson(req, res, 403, { error: '라이브 키가 맞지 않는다' });
  }
  let raw;
  // 스냅샷 하나는 항적을 빼면 1~2KB 다. 1MB 면 넘치고도 남는다.
  try { raw = await readBody(req, 1024 * 1024); }
  catch { return sendJson(req, res, 413, { error: '너무 크다' }); }

  let snap;
  try { snap = JSON.parse(raw.toString('utf8')); }
  catch { return sendJson(req, res, 400, { error: 'JSON 이 아니다' }); }
  if (!snap || typeof snap !== 'object') {
    return sendJson(req, res, 400, { error: '객체가 아니다' });
  }

  // 🔴 항적은 **증분**으로 온다. `track_from` 이 이 묶음의 첫 점이 전체에서
  //    몇 번째인지 말해 준다. 그것이 우리가 가진 개수와 맞을 때만 이어 붙이고,
  //    어긋나면(서버 재시작·rim3 재시작) 통째로 갈아 끼운다 — 안 그러면
  //    지도에 궤적이 조용히 빠지거나 겹친다.
  const inc = Array.isArray(snap.track) ? snap.track : [];
  const from = Number.isInteger(snap.track_from) ? snap.track_from : 0;
  const have = live.dropped + live.track.length;
  if (from === have) {
    for (const pt of inc) live.track.push(pt);
  } else if (from === 0) {
    live.track = inc.slice();
    live.dropped = 0;
  } else if (from < have) {
    // 겹치는 만큼 건너뛰고 나머지만 붙인다.
    const skip = have - from;
    if (skip < inc.length) for (const pt of inc.slice(skip)) live.track.push(pt);
  } else {
    // 구멍이 생겼다 — 다음 푸시에서 처음부터 받도록 0 을 돌려준다.
    live.track = [];
    live.dropped = 0;
  }
  if (live.track.length > LIVE_TRACK_MAX) {
    const cut = live.track.length - LIVE_TRACK_MAX;
    live.track.splice(0, cut);
    live.dropped += cut;
  }

  delete snap.track;
  live.state = snap;
  live.at = Date.now();
  live.pusher = typeof snap.pusher === 'string' ? snap.pusher.slice(0, 40) : null;

  // 다음에 어디서부터 보내면 되는지 알려 준다.
  return sendJson(req, res, 200, { ok: true, track_n: live.dropped + live.track.length });
}

/** 라이브 페이지가 폴링한다. 트래커의 /api/state 와 **같은 모양**이어야 한다 —
 *  같은 live.js 가 로컬에서도 여기서도 돌기 때문이다. */
function handleLiveState(req, res, url) {
  const stale = !live.state || (Date.now() - live.at) > LIVE_STALE_MS;
  if (!live.state) {
    return sendJson(req, res, 200, {
      live: false, seq: 0, age: null, packets: 0, bytes: 0,
      src: null, link: null, links: {}, sysid: null, uptime: 0,
      d: {}, home: null, mission: [],
      track_n: 0, track_from: 0, track: [], messages: [],
      relay: { pusher: null, age: null, note: '아직 아무 PC 도 안 올렸다' },
    });
  }

  let since = parseInt(url.searchParams.get('since') || '0', 10);
  if (!Number.isFinite(since) || since < 0) since = 0;
  const wantTrack = url.searchParams.get('track') !== '0';
  const start = since < live.dropped ? 0 : Math.min(since - live.dropped, live.track.length);

  const ageS = (Date.now() - live.at) / 1000;
  const out = {
    ...live.state,
    // 🔴 중계가 끊기면 화면도 끊긴 것으로 보여야 한다. rim3 가 보낸 마지막
    //    `live: true` 를 그대로 흘리면, 노트북을 닫고 집에 온 뒤에도 웹은
    //    기체가 떠 있는 것처럼 보인다.
    live: stale ? false : !!live.state.live,
    age: stale ? ageS : live.state.age,
    track_n: live.dropped + live.track.length,
    track_from: live.dropped + start,
    track: wantTrack ? live.track.slice(start) : [],
    // 로컬 트래커에는 없는 칸. 어느 PC 가 언제 올렸는지 화면이 말할 수 있게.
    relay: { pusher: live.pusher, age: Math.round(ageS * 10) / 10, note: null },
  };
  return sendJson(req, res, 200, out);
}

// ── 비행 전 점검 ─────────────────────────────────────────────────────
// 🔴 **이 서버는 FC 와 직접 말하지 않는다.** FC 가 꽂힌 PC(rim3)의 에이전트를
//    HTTP 로 부르고 그 JSON 을 그대로 넘긴다. 그래야 FC 로 가는 경로가 그 PC
//    안에 갇힌 채로 남는다 — 공개 웹서버 버그 하나가 FC 까지 닿을 길이 없다.
//
// 🔴 **판정은 여기서 하지 않는다.** 임계값은 tools/preflight/preflight.py 한 곳에만
//    있고, 터미널과 이 화면이 같은 코드로 같은 답을 내야 한다.
//    node 쪽에서 값을 다시 해석하면 그 순간부터 두 벌이 따로 늙는다.

/** 에이전트 하나에 점검을 청한다. addr 는 host:port 다 — 기본 포트는 없다. */
function askAgent(addr, secs) {
  return new Promise((resolve) => {
    const [host, port] = addr.split(':');
    const r = http.request(
      { host, port: Number(port), path: `/preflight?t=${secs}`,
        method: 'GET', timeout: PREFLIGHT_TIMEOUT,
        headers: { 'X-Preflight-Key': PREFLIGHT_KEY, 'Accept-Encoding': 'identity' } },
      (up) => {
        let buf = '';
        up.setEncoding('utf8');
        up.on('data', (d) => { buf += d; });
        up.on('end', () => {
          try { resolve({ addr, status: up.statusCode, body: JSON.parse(buf) }); }
          catch { resolve({ addr, status: 502, error: '에이전트 응답이 JSON 이 아니다' }); }
        });
      });
    r.on('error', (e) => resolve({ addr, status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ addr, status: 0, error: '응답 없음' }); });
    r.end();
  });
}

/** 점검 화면 암호. 길이가 달라도 비교 시간이 안 새게 해시를 맞대 본다. */
function preflightPasswordOk(given) {
  if (!PREFLIGHT_PASSWORD) return false;        // 미설정이면 점검 자체를 막는다
  const h = (v) => crypto.createHash('sha256').update(String(v == null ? '' : v)).digest();
  return crypto.timingSafeEqual(h(given), h(PREFLIGHT_PASSWORD));
}

let preflightBusy = false;

/** 점검을 돌리면서 나오는 NDJSON 을 브라우저로 그대로 흘린다.
 *
 * 🔴 줄을 해석하지 않는다 — 판정도 순서도 preflight.py 가 정한 그대로
 *    넘긴다. 여기서 손대면 "웹에서만 다르게 보이는" 층이 하나 더 생긴다.
 *    붙이는 것은 어느 에이전트가 답했는지 한 줄뿐이고, 그건 스트림이
 *    시작될 때 our-own `agent` 줄로 따로 보낸다. */
function streamFromAgent(addr, secs, res) {
  return new Promise((resolve) => {
    const [host, port] = addr.split(':');
    const r = http.request(
      { host, port: Number(port), path: `/preflight/stream?t=${secs}`,
        method: 'GET', timeout: PREFLIGHT_TIMEOUT,
        headers: { 'X-Preflight-Key': PREFLIGHT_KEY, 'Accept-Encoding': 'identity' } },
      (up) => {
        if (up.statusCode !== 200) {
          // 에이전트가 판정 대신 오류를 냈다. 본문을 모아 한 줄로 넘긴다.
          let buf = '';
          up.setEncoding('utf8');
          up.on('data', (d) => { buf += d; });
          up.on('end', () => resolve({ ok: false, status: up.statusCode, body: buf }));
          return;
        }
        // 🔴 여기부터는 응답이 시작됐다. 다른 후보로 넘어갈 수 없다.
        res.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
          // 프록시가 줄 단위로 흘리도록. 모아 뒀다 한 번에 주면 진행이 안 보인다.
          'X-Accel-Buffering': 'no',
        });
        res.write(JSON.stringify({ t: 'agent', agent_addr: addr }) + '\n');
        up.pipe(res);
        up.on('end', () => resolve({ ok: true, started: true }));
        up.on('error', () => { try { res.end(); } catch { /* 이미 닫혔다 */ } resolve({ ok: true, started: true }); });
      });
    r.on('error', (e) => resolve({ ok: false, status: 0, error: e.code || e.message }));
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 0, error: '응답 없음' }); });
    // 브라우저가 창을 닫으면 에이전트 쪽도 끊는다.
    res.on('close', () => r.destroy());
    r.end();
  });
}

async function handlePreflightStream(req, res, url) {
  if (!PREFLIGHT_KEY || !PREFLIGHT_PASSWORD) {
    return sendJson(req, res, 503, {
      ok: false, verdict: 'NO-GO', error: '점검 차단',
      groups: [], standing: [],
    });
  }
  if (!preflightPasswordOk(req.headers['x-preflight-password'])) {
    return sendJson(req, res, 401, { ok: false, error: '암호 오류' });
  }
  if (preflightBusy) {
    return sendJson(req, res, 409, {
      ok: false, verdict: 'NO-GO', error: '점검 중',
      groups: [], standing: [],
    });
  }

  let secs = parseFloat(url.searchParams.get('t') || '6');
  if (!Number.isFinite(secs)) secs = 6;
  secs = Math.max(2, Math.min(20, secs));

  preflightBusy = true;
  const tried = [];
  try {
    for (const addr of PREFLIGHT_AGENTS) {
      const got = await streamFromAgent(addr, secs, res);
      if (got.started) return;                       // 흘려보냈다. 끝.
      tried.push({ addr, error: got.error || `HTTP ${got.status}` });
    }
  } finally {
    preflightBusy = false;
  }
  // 어느 주소가 왜 안 붙었는지는 서버 로그에만 남긴다 — 화면에는 주소·오류 코드를 내지 않는다.
  log('점검 서버 없음', tried.map((t) => `${t.addr}: ${t.error}`).join(', '));
  return sendJson(req, res, 503, {
    ok: false, verdict: 'NO-GO',
    error: '점검 서버 없음',
    groups: [], standing: [],
  });
}

async function handlePreflight(req, res, url) {
  if (!PREFLIGHT_KEY || !PREFLIGHT_PASSWORD) {
    return sendJson(req, res, 503, {
      ok: false, verdict: 'NO-GO', error: '점검 차단',
      groups: [], standing: [],
    });
  }
  if (!preflightPasswordOk(req.headers['x-preflight-password'])) {
    return sendJson(req, res, 401, { ok: false, error: '암호 오류' });
  }
  // 점검은 FC 링크를 쓴다. 겹쳐 돌리면 서로 밟으므로 한 번에 하나만 보낸다.
  if (preflightBusy) {
    return sendJson(req, res, 409, {
      ok: false, verdict: 'NO-GO', error: '점검 중',
      groups: [], standing: [],
    });
  }

  let secs = parseFloat(url.searchParams.get('t') || '6');
  if (!Number.isFinite(secs)) secs = 6;
  secs = Math.max(2, Math.min(20, secs));

  preflightBusy = true;
  const tried = [];
  try {
    for (const addr of PREFLIGHT_AGENTS) {
      const got = await askAgent(addr, secs);
      // 200 이든 아니든 **에이전트가 판정을 냈으면** 그대로 넘긴다.
      // 붙지 못했다는 것도 판정이다 (preflight.py 가 NO-GO 로 낸다).
      if (got.body) {
        got.body.agent_addr = addr;
        got.body.tried = tried;
        return sendJson(req, res, got.status === 200 ? 200 : got.status, got.body);
      }
      tried.push({ addr, error: got.error });
    }
  } finally {
    preflightBusy = false;
  }
  // 어느 주소가 왜 안 붙었는지는 서버 로그에만 남긴다 — 화면에는 주소·오류 코드를 내지 않는다.
  log('점검 서버 없음', tried.map((t) => `${t.addr}: ${t.error}`).join(', '));
  return sendJson(req, res, 503, {
    ok: false, verdict: 'NO-GO',
    error: '점검 서버 없음',
    groups: [], standing: [],
  });
}

// ── 라우팅 ───────────────────────────────────────────────────────────
const ID_RE = /^[0-9a-f]{16}$/;

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // 배송 탭의 기체 — 시뮬레이션이 켜져 있으면 그 기체, 아니면 실제 실시간 상태 (같은 모양)
  if (p === '/api/delivery/live' && req.method === 'GET') {
    const sim = delivery.simSnapshot(url);
    return sim ? sendJson(req, res, 200, sim) : handleLiveState(req, res, url);
  }
  // 교내 배송 — 학교 계정 로그인과 배송 상태머신 (delivery.js). 405 차단보다 위에 있어야 한다.
  const dr = delivery.handle(req, res, url);
  if (dr) return dr;

  if (p === '/api/health') {
    return sendJson(req, res, 200, {
      ok: true, logs: catalog.size, fingerprint: FINGERPRINT,
      running, queued: queue.length, upload: UPLOAD_PASSWORD ? 'enabled' : 'disabled',
      preflight: (PREFLIGHT_KEY && PREFLIGHT_PASSWORD) ? 'enabled' : 'disabled',
      delivery: delivery.health(),
    });
  }

  if (p === '/api/logs' && req.method === 'GET') {
    const all = url.searchParams.get('all') === '1';
    const rows = dedupe([...catalog.values()], all)
      .map(({ file, ...r }) => r)                       // 서버 경로는 내보내지 않는다
      .sort((a, b) => String(b.utc || '').localeCompare(String(a.utc || '')));
    return sendJson(req, res, 200, rows);
  }

  // 🔴 `.BIN` 원본은 내보내지 않는다. 조회가 공개라 링크를 아는 누구나 받아갈 수
  //    있게 되고, 로그에는 비행장 좌표와 기체 전체 텔레메트리가 그대로 들어 있다.
  //    분석에 필요한 것은 sum/trk 로 이미 나가므로 원본을 열 이유가 없다.
  //    버튼만 없애는 것으로는 부족하다 — URL 을 직접 치면 받아지므로 여기서 막는다.
  if (/^\/api\/logs\/[^/]+\/file$/.test(p)) {
    return sendJson(req, res, 403, { error: '원본 다운로드는 제공하지 않는다' });
  }

  const m = /^\/api\/logs\/([^/]+)\/(sum|trk)$/.exec(p);
  if (m && req.method === 'GET') {
    const [, id, kind] = m;
    if (!ID_RE.test(id)) return sendJson(req, res, 400, { error: '잘못된 id' });
    const entry = catalog.get(id);
    if (!entry) return sendJson(req, res, 404, { error: '없는 로그' });
    if (entry.error) return sendJson(req, res, 422, { error: entry.error });
    try { await fsp.access(cachePath(id, kind)); }
    catch {
      try { await ensureCached(id, entry.file); }
      catch (e) { return sendJson(req, res, 422, { error: e.message }); }
    }
    return sendCached(req, res, cachePath(id, kind));
  }

  if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res);

  // 비행 전 점검 — 버튼 하나가 FC 를 읽고 GO/NO-GO 를 낸다.
  // 🔴 스트림 쪽은 묶음이 **끝나는 대로** 한 줄씩 나간다. 완료 순서는
  //    정해져 있지 않다 — 자기 데이터가 먼저 온 묶음이 먼저 나간다.
  if (p === '/api/preflight/stream' && req.method === 'POST') return handlePreflightStream(req, res, url);
  if (p === '/api/preflight' && req.method === 'POST') return handlePreflight(req, res, url);

  // 라이브 — rim3 가 밀어 올리고(POST), 브라우저가 폴링한다(GET).
  if (p === '/api/live/push' && req.method === 'POST') return handleLivePush(req, res);
  if (p === '/api/live/state' && req.method === 'GET') return handleLiveState(req, res, url);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(req, res, 405, '허용하지 않는 메서드', 'text/plain; charset=utf-8');
  }
  // 콕핏이 첫 화면이다. /cockpit 은 앱(WebView)이 여는 주소라 같은 페이지로 남긴다.
  if (p === '/' || p === '/cockpit' || p === '/cockpit/') return serveStatic(req, res, '/cockpit.html');
  // 비행 기록 — 목록·분석·비교를 /analysis 아래에 둔다.
  if (p === '/analysis' || p === '/analysis/') return redirect(req, res, '/analysis/log');
  if (p === '/analysis/log' || p === '/analysis/log/') return serveStatic(req, res, '/index.html');
  if (/^\/analysis\/log\/[0-9a-f]{16}$/.test(p)) return serveStatic(req, res, '/log.html');
  if (p === '/analysis/compare') return serveStatic(req, res, '/compare.html');
  // 옛 주소로 공유된 링크는 새 자리로 보낸다.
  const old = /^\/log\/([0-9a-f]{16})$/.exec(p);
  if (old) return redirect(req, res, '/analysis/log/' + old[1] + url.search);
  if (p === '/compare') return redirect(req, res, '/analysis/compare' + url.search);
  // 재생은 drone_live.py 가 한다 (.BIN 을 열어 HUD·차트로 되돌린다).
  // 여기서 다시 짜지 않고 그대로 넘긴다. 랩서버는 데이터 폴더의 logs 를 그 자리에서 읽는다.
  if (p.startsWith('/api/playback/')) return proxyLive(req, res);
  // /intro 는 체계 소개 페이지. 실제 파일은 intro.html 이다.
  if (p === '/intro' || p === '/intro/') return serveStatic(req, res, '/intro.html');
  return serveStatic(req, res, p);
}

/** 재생 요청을 이 기계의 drone_live.py(:4411)로 넘긴다.
 *
 * 🔴 재생 로직을 node 로 옮겨 적지 않는다. drone_live.py 가 .BIN 파싱·시계열
 *    추출·커서 이동을 갖고 있고, 로컬 화면이 쓰는 것과 **같은 코드**여야 웹과
 *    로컬의 동작이 갈리지 않는다.
 *
 * 🔴 읽기 전용 경로만 넘긴다. 재생 서버는 FC 와 연결이 없다.
 */
const PLAYBACK_PORT = Number(process.env.DRONE_PLAYBACK_PORT || 4411);
function proxyLive(req, res) {
  const r = http.request(
    { host: '127.0.0.1', port: PLAYBACK_PORT, path: req.url, method: 'GET',
      headers: { 'Accept-Encoding': 'identity' }, timeout: 120000 },
    (up) => {
      res.writeHead(up.statusCode || 502, {
        'Content-Type': up.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex, nofollow',
      });
      up.pipe(res);
    });
  // 재생 서버가 없어도 화면은 살아 있어야 한다 — 라이브는 별개 경로다.
  r.on('error', () => {
    if (res.headersSent) return res.end();
    sendJson(req, res, 503, { error: '재생 서버가 없다 (drone-playback.service)' });
  });
  r.on('timeout', () => r.destroy());
  r.end();
}

// ── 기동 ─────────────────────────────────────────────────────────────
async function main() {
  for (const d of [DATA, LOGS, CACHE_DIR]) await fsp.mkdir(d, { recursive: true });

  // venv 가 없으면 전부 '파싱 실패' 로 캐시에 굳는다. 아예 뜨지 않는 편이 낫다.
  try {
    const v = require('child_process').execFileSync(
      PY, ['-c', 'import pymavlink, numpy, sys; print(sys.version.split()[0])'],
      { encoding: 'utf8', timeout: 20000 }).trim();
    log(`python ${v} (${PY}) — pymavlink·numpy OK`);
  } catch (e) {
    console.error(`파이썬을 못 쓴다: ${PY}\n  ${e.message}\n` +
      '  venv 를 만들어라 — web/README.md "서버 설치" 참조');
    process.exit(1);
  }

  if (!UPLOAD_PASSWORD) log('⚠️  UPLOAD_PASSWORD 미설정 — 업로드가 막힌 채로 뜬다');
  if (!PREFLIGHT_KEY) log('⚠️  PREFLIGHT_KEY 미설정 — 비행 전 점검이 막힌 채로 뜬다');
  else if (!PREFLIGHT_PASSWORD) log('⚠️  PREFLIGHT_PASSWORD 미설정 — 비행 전 점검이 막힌 채로 뜬다');
  else log(`점검 에이전트 후보: ${PREFLIGHT_AGENTS.join(', ')}`);
  log(`지문 ${FINGERPRINT}, 로그 ${LOGS}`);
  delivery.init({ dataDir: DATA, env: process.env, send, readBody, log, getLive: () => live });
  await reconcile();

  http.createServer((req, res) => {
    route(req, res).catch((e) => {
      log('처리 실패', req.method, req.url, e.message);
      if (!res.headersSent) sendJson(req, res, 500, { error: '서버 오류' });
    });
  }).listen(PORT, BIND, () => log(`http://${BIND}:${PORT} 에서 대기`));
}

process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.message));
process.on('uncaughtException', (e) => log('uncaughtException', e && e.stack));

main().catch((e) => { console.error(e); process.exit(1); });
