// 시험용 가짜 학교 로그인 서버 — 실제 sugang.kyungnam.ac.kr/Default.aspx 의 폼 꼴을 흉내 낸다.
//
//   node web/test/fake_sugang.js [port]          (기본 4499)
//   SUGANG_URL=http://127.0.0.1:4499/Default.aspx 로 drone01 서버를 띄워 쓴다.
//
// 페이지는 진짜처럼 EUC-KR 이다 (node 는 EUC-KR 로 인코딩을 못 하므로 한글은 바이트 상수).
// 성공·실패 모두 200 + 로그인 폼, 성공만 .ASPXAUTH 쿠키 — 2026-10-07 실계정 실측(sugang_probe.js)과 같은 꼴.
//
// 계정: adm / u01 / u02, 비밀번호는 모두 'pw'. 아이디 'boom' 이면 500.
// GET /count → 지금까지 받은 로그인 POST 수.

'use strict';
const http = require('http');
const crypto = require('crypto');

const PORT = parseInt(process.argv[2] || '4499', 10);
const TITLE = Buffer.from('b0e6b3b2b4ebc7d0b1b3202d20c7d0bbfdc1a4bab8bdc3bdbac5db', 'hex');   // 경남대학교 - 학생정보시스템
const WRONG = Buffer.from('bec6c0ccb5f020b6c7b4c220baf1b9d0b9f8c8a3b0a120b8c2c1f620becabdc0b4cfb4d92e', 'hex');   // 아이디 또는 비밀번호가 맞지 않습니다.
const USERS = { adm: 'pw', u01: 'pw', u02: 'pw' };
// 상단 틀 Top.aspx 의 인사 — 「AI·SW융합대학 컴퓨터공학부 컴퓨터보안 <이름> 님 반갑습니다.」 (실측 꼴, EUC-KR)
const DEPT = Buffer.from('4149a1a45357c0b6c7d5b4ebc7d020c4c4c7bbc5cdb0f8c7d0bace20c4c4c7bbc5cdbab8bec820', 'hex');
const HELLO = Buffer.from('20b4d420b9ddb0a9bdc0b4cfb4d92e', 'hex');
const NAMES = { adm: 'b1e8b0fcb8ae', u01: 'b9dabab8b3bf', u02: 'c0ccb9dec0bd' };   // 김관리 박보냄 이받음
let logouts = 0;
const issued = new Map();   // 세션 쿠키 → 발급한 __VIEWSTATE
let posts = 0;

function page(sid, extra = Buffer.alloc(0)) {
  const vs = crypto.randomBytes(24).toString('base64');
  issued.set(sid, vs);
  return Buffer.concat([
    Buffer.from('<html><head><meta charset="euc-kr"><title>'), TITLE, Buffer.from('</title></head><body>'), extra,
    Buffer.from(`<form name="Login" method="post" action="./Default.aspx" id="Login">
<input type="hidden" name="__VIEWSTATE" id="__VIEWSTATE" value="${vs}" />
<input type="hidden" name="__VIEWSTATEGENERATOR" id="__VIEWSTATEGENERATOR" value="CA0B0334" />
<input type="hidden" name="__EVENTVALIDATION" id="__EVENTVALIDATION" value="ev&amp;1" />
<input name="txtUserID" type="text" id="txtUserID" />
<input name="txtPassword" type="password" id="txtPassword" />
<input type="image" name="ibtnLogin" id="ibtnLogin" src="btn_login.gif" />
</form></body></html>`)]);
}
const sidOf = (req) => (/ASP\.NET_SessionId=([^;]+)/.exec(req.headers.cookie || '') || [])[1];

http.createServer((req, res) => {
  if (req.url === '/count') return res.end(String(posts));
  if (req.url === '/logouts') return res.end(String(logouts));
  if (req.url === '/Logout.aspx') { logouts++; res.writeHead(302, { Location: '/Default.aspx' }); return res.end(); }
  if (req.url === '/Top.aspx') {
    const who = (/\.ASPXAUTH=tok-([A-Za-z0-9]+)/.exec(req.headers.cookie || '') || [])[1];
    if (!who || !NAMES[who]) { res.writeHead(302, { Location: '/Default.aspx' }); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=euc-kr' });
    return res.end(Buffer.concat([Buffer.from('<html><body><td><span>'), DEPT, Buffer.from('<b>'), Buffer.from(NAMES[who], 'hex'), Buffer.from('</b>'), HELLO, Buffer.from('</span></td></body></html>')]));
  }
  if (req.method === 'GET') {
    const sid = crypto.randomBytes(8).toString('hex');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=euc-kr', 'Set-Cookie': `ASP.NET_SessionId=${sid}; path=/; HttpOnly` });
    return res.end(page(sid));
  }
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    posts++;
    const f = new URLSearchParams(b), sid = sidOf(req);
    if (!sid || issued.get(sid) !== f.get('__VIEWSTATE') || f.get('__EVENTVALIDATION') !== 'ev&1' || !f.has('ibtnLogin.x')) {
      res.writeHead(400); return res.end('bad form');
    }
    if (f.get('txtUserID') === 'boom') { res.writeHead(500); return res.end('error'); }
    if (USERS[f.get('txtUserID')] && USERS[f.get('txtUserID')] === f.get('txtPassword')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=euc-kr', 'Set-Cookie': [`ASP.NET_SessionId=${sid}; path=/; HttpOnly`, `.ASPXAUTH=tok-${f.get('txtUserID')}; path=/; HttpOnly`] });
      return res.end(page(sid));
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=euc-kr' });
    res.end(page(sid, Buffer.concat([Buffer.from('<script>alert("'), WRONG, Buffer.from('");</script>')])));
  });
}).listen(PORT, '127.0.0.1', () => console.log(`fake sugang http://127.0.0.1:${PORT}/Default.aspx`));
