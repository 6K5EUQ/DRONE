#!/usr/bin/env node
// 학교 로그인 성공 신호 실측 — 배송 로그인(web/delivery.js judge())을 맞추기 위한 한 번짜리 도구.
//
//   node tools/delivery/sugang_probe.js <학번>        비밀번호는 입력해도 화면에 안 보인다
//
// 출력: 각 요청의 status·Location·쿠키 이름·alert 문구·로그인 폼 재등장 여부, 그리고
// 지금 judge() 가 내리는 판정. 🔴 비밀번호·쿠키 값은 출력하지 않는다.
// 맞는 비번으로 한 번, 틀린 비번으로 한 번 돌려 두 결과가 갈리는지 본다.

'use strict';
const { judge, hidden } = require('../../web/delivery');

const URL_ = process.env.SUGANG_URL || 'https://sugang.kyungnam.ac.kr/Default.aspx';
const id = process.argv[2];
if (!id || !/^[A-Za-z0-9]{3,20}$/.test(id)) { console.error('사용법: node tools/delivery/sugang_probe.js <학번>'); process.exit(2); }

function askHidden(q) {
  return new Promise((resolve) => {
    process.stdout.write(q);
    const stdin = process.stdin; let s = '';
    stdin.setRawMode && stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    stdin.on('data', function on(c) {
      for (const ch of c) {
        if (ch === '\r' || ch === '\n') { stdin.setRawMode && stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', on); process.stdout.write('\n'); return resolve(s); }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') s = s.slice(0, -1); else s += ch;
      }
    });
  });
}
const names = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map((c) => c.split('=')[0]);
const decode = async (r) => new TextDecoder('euc-kr').decode(await r.arrayBuffer());

(async () => {
  const pw = await askHidden('비밀번호: ');
  if (!/^[\x20-\x7e]{1,64}$/.test(pw)) { console.error('ASCII 비밀번호만 보낼 수 있다 (학교 폼이 EUC-KR)'); process.exit(2); }
  const opt = { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (drone01 delivery probe)' } };
  const g = await fetch(URL_, { ...opt, signal: AbortSignal.timeout(8000) });
  const page = await decode(g), hid = hidden(page);
  console.log(`GET  ${g.status}  쿠키 ${JSON.stringify(names(g))}  숨은 필드 ${JSON.stringify(Object.keys(hid))}`);
  const cookies = (g.headers.getSetCookie ? g.headers.getSetCookie() : []).map((c) => c.split(';')[0]);
  const form = new URLSearchParams({ ...hid, txtUserID: id, txtPassword: pw, 'ibtnLogin.x': '12', 'ibtnLogin.y': '9' });
  const p = await fetch(URL_, { ...opt, method: 'POST', signal: AbortSignal.timeout(8000), body: form.toString(),
    headers: { ...opt.headers, 'Content-Type': 'application/x-www-form-urlencoded', ...(cookies.length ? { Cookie: cookies.join('; ') } : {}) } });
  const html = p.status === 200 ? await decode(p) : '';
  const alerts = [...html.matchAll(/alert\(\s*["']([^"']{0,120})/g)].map((m) => m[1]);
  console.log(`POST ${p.status}  Location ${JSON.stringify(p.headers.get('location'))}  쿠키 ${JSON.stringify(names(p))}`);
  console.log(`     alert ${JSON.stringify(alerts)}  로그인 폼 다시 나옴 ${/name=["']?txtPassword/i.test(html)}  본문 ${html.length}자`);
  console.log(`judge() 판정: ${judge(p.status, p.headers.getSetCookie ? p.headers.getSetCookie() : [], html)}`);
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
