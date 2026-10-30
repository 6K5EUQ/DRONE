// 미션 편집 순수 함수 시험 — 탭 모델 변환, 단계 → plan 요청 본문, 명령 상태 → 표시, 길게 누르기 상태기계.
//
//   node web/test/misedit_test.js
//
// 브라우저·서버 없이 web/public/misedit.js 만 읽는다.

'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

let pass = 0, fail = 0;
function ok(c, name, got) {
  if (c) pass++; else { fail++; console.log('✖', name, got === undefined ? '' : JSON.stringify(got)); }
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const M = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'misedit.js')).href);

  // ── 탭 모델 ──
  const raw = [{ id: 'a', name: '본관', rev: 3, updated: 9, steps: [
    { k: 'takeoff', alt: '20', lat: 1, lon: 2 }, { k: 'goto', lat: 35.1, lon: 128.5, alt: 20, sec: 4 },
    { k: 'hover', sec: 5, alt: 9 }, { k: 'jump' }, { k: 'land', lat: 35.2, lon: 128.6 }, { k: 'rtl', alt: 5 }] }, { name: 'id 없음' }, null];
  const tabs = M.tabsFrom(raw);
  ok(tabs.length === 1, 'id 없는 탭은 버린다', tabs.length);
  ok(tabs[0].steps.length === 5, '모르는 종류의 단계는 버린다', tabs[0].steps.length);
  ok(eq(tabs[0].steps[0], { k: 'takeoff', alt: 20 }), '이륙은 고도만 (문자열 → 숫자, 좌표 버림)', tabs[0].steps[0]);
  ok(eq(tabs[0].steps[1], { k: 'goto', alt: 20, lat: 35.1, lon: 128.5 }), '이동은 고도·좌표 (시간 버림)', tabs[0].steps[1]);
  ok(eq(tabs[0].steps[2], { k: 'hover', sec: 5 }), '호버는 시간·좌표', tabs[0].steps[2]);
  ok(eq(tabs[0].steps[4], { k: 'rtl' }), '복귀는 칸 없음', tabs[0].steps[4]);
  ok(tabs[0].rev === 3 && tabs[0].name === '본관', 'rev·이름 유지');
  ok(eq(M.tabsFrom({}), []), '배열 아니면 빈 목록');
  ok(eq(M.tabBody(tabs[0]), { id: 'a', name: '본관', steps: tabs[0].steps, rev: 3 }), 'PUT 본문은 탭 전체(updated 빼고)', M.tabBody(tabs[0]));

  // ── plan 요청 본문 ──
  const t = { id: 'x', name: 'n', rev: 0, steps: [{ k: 'takeoff', alt: 15 }, { k: 'goto', alt: '', lat: 35, lon: 128 }, { k: 'goto', lat: 35.1 }, { k: 'land' }] };
  ok(eq(M.planBody(t, null), { steps: [{ k: 'takeoff', alt: 15 }, { k: 'goto', lat: 35, lon: 128 }, { k: 'goto' }, { k: 'land' }] }),
    '빈 고도·반쪽 좌표는 싣지 않는다', M.planBody(t, null));
  ok(eq(M.planBody(t, [35.5, 128.5]).home, { lat: 35.5, lon: 128.5 }), '홈 [lat, lon] → {lat, lon}');
  ok(eq(M.planBody(t, { lat: 1, lon: 2, alt: 3 }).home, { lat: 1, lon: 2 }), '홈 {lat, lon}');
  ok(!('home' in M.planBody(t, { lat: null, lon: 2 })), '홈 반쪽이면 뺀다');
  ok(!('title' in M.planBody(t, null)), '단계가 있으면 title 을 싣지 않는다 (자동 생성과 섞이지 않게)');

  // ── 단계 조작 ──
  ok(eq(M.newStep('goto', [{ k: 'takeoff', alt: 12 }, { k: 'land' }]), { k: 'goto', alt: 12 }), '새 이동은 앞 고도를 잇는다');
  ok(eq(M.newStep('takeoff', []), { k: 'takeoff' }), '앞 고도가 없으면 비운다');
  ok(eq(M.newStep('hover', [{ k: 'takeoff', alt: 12 }]), { k: 'hover' }), '호버는 고도 칸이 없다');
  const st = [{ k: 'takeoff' }, { k: 'goto' }, { k: 'land' }];
  ok(eq(M.moveStep(st, 1, -1).map((s) => s.k), ['goto', 'takeoff', 'land']), '위로');
  ok(eq(M.moveStep(st, 1, 1).map((s) => s.k), ['takeoff', 'land', 'goto']), '아래로');
  ok(M.moveStep(st, 0, -1) === st && M.moveStep(st, 2, 1) === st, '끝에서는 그대로');
  ok(eq(M.delStep(st, 1).map((s) => s.k), ['takeoff', 'land']), '삭제');
  ok(st.length === 3 && st[1].k === 'goto', '원본은 안 바뀐다');

  // ── 계획 항목 → 단계 (자동 생성) ──
  const items = [
    { seq: 0, cmd: 16, frame: 0, lat: 35.18, lon: 128.55, alt: 0, p1: 0 },
    { seq: 1, cmd: 22, frame: 3, lat: 0, lon: 0, alt: 30, p1: 0 },
    { seq: 2, cmd: 16, frame: 3, lat: 35.19, lon: 128.56, alt: 30, p1: 0 },
    { seq: 3, cmd: 19, frame: 3, lat: 35.19, lon: 128.56, alt: 30, p1: 10 },
    { seq: 4, cmd: 21, frame: 3, lat: 0, lon: 0, alt: 0, p1: 0 },
    { seq: 5, cmd: 178, frame: 2, lat: 0, lon: 0, alt: 0, p1: 1 },
    { seq: 6, cmd: 20, frame: 2, lat: 0, lon: 0, alt: 0, p1: 0 }];
  ok(eq(M.itemsToSteps(items), [{ k: 'takeoff', alt: 30 }, { k: 'goto', alt: 30, lat: 35.19, lon: 128.56 },
    { k: 'hover', sec: 10, lat: 35.19, lon: 128.56 }, { k: 'land' }, { k: 'rtl' }]), '홈(0번) 빼고, 0,0 좌표 버리고, 모르는 명령 건너뜀', M.itemsToSteps(items));
  ok(eq(M.itemsToSteps(null), []), '항목 없으면 빈 단계');

  // ── 명령 상태 → 표시 ──
  ok(eq(M.cmdView({ state: 'queued' }), { stage: 1, label: '대기', bad: false, end: false, reason: '' }), 'queued → 막대 1칸');
  ok(M.cmdView({ state: 'fc_ack' }).stage === 4 && M.cmdView({ state: 'done' }).stage === 5, 'fc_ack 4칸, done 5칸');
  ok(M.cmdView({ state: 'awaiting_confirm' }).stage === 0, '확인 대기는 막대 0');
  ok(M.cmdLine({ kind: 'arm', state: 'rejected', reason: 'volt' }) === 'ARM · 거부 · 전압', '거부 사유', M.cmdLine({ kind: 'arm', state: 'rejected', reason: 'volt' }));
  ok(M.cmdLine({ kind: 'rtl', state: 'delivered' }) === 'RTL · 전달', '진행 중 한 줄');
  ok(M.cmdLine({ kind: 'mission_start', state: 'done' }) === 'AUTO · 완료', 'AUTO = mission_start');
  ok(M.cmdLine({ kind: 'arm', state: 'preempted', reason: 'abcdef012345' }) === 'ARM · 밀림', '밀림 — 밀어낸 id 는 안 보인다', M.cmdLine({ kind: 'arm', state: 'preempted', reason: 'abcdef012345' }));
  ok(M.cmdLine({ kind: 'land', state: 'failed', detail: 'MAV_RESULT 4' }) === 'LAND · 실패 · MAV_RESULT 4', '파이 detail 이 사유', M.cmdLine({ kind: 'land', state: 'failed', detail: 'MAV_RESULT 4' }));
  ok(M.cmdView({ state: 'unknown', reason: 'no-ack' }).reason === '응답 없음' && M.cmdView({ state: 'unknown' }).bad, '결과 모름은 실패 쪽');
  ok(!M.cmdView({ state: 'cancelled' }).bad && M.cmdView({ state: 'cancelled' }).end, '취소는 끝이지만 실패는 아님');
  const all = ['created', 'awaiting_confirm', 'queued', 'delivered', 'sent', 'fc_ack', 'done', 'rejected', 'expired', 'cancelled', 'failed', 'unknown', 'preempted'];
  ok(all.every((s) => M.STATE_NAME[s]), '모든 서버 상태에 이름이 있다');
  ok(eq([...M.END].sort(), ['cancelled', 'done', 'expired', 'failed', 'preempted', 'rejected', 'unknown']), 'END 는 cmd.js 와 같다');

  // ── 길게 누르기 ──
  const run = (evs) => { let s = M.holdInit(); const outs = []; for (const [ev, t] of evs) { const r = M.holdStep(s, ev, t); s = r.s; if (r.out) outs.push(r.out); } return { s, outs }; };
  let r = run([['down', 0], ['tick', 1000], ['up', 1200]]);
  ok(r.s.st === 'idle' && !r.outs.length, '1.5초 전에 떼면 아무것도 없다', r);
  r = run([['down', 0], ['tick', 1500], ['up', 1600]]);
  ok(r.s.st === 'armed' && eq(r.outs, ['hold']), '1.5초 누르면 무장, 그 손을 떼도 확정 아님', r);
  r = run([['down', 0], ['tick', 1500], ['up', 1600], ['down', 3000], ['up', 3100]]);
  ok(r.s.st === 'idle' && eq(r.outs, ['hold', 'fire']), '5초 안에 다시 누르면 확정', r);
  r = run([['down', 0], ['tick', 1500], ['up', 1600], ['tick', 6400]]);
  ok(r.s.st === 'armed', '무장 후 4.9초는 아직 무장', r);
  r = run([['down', 0], ['tick', 1500], ['up', 1600], ['tick', 6500], ['down', 6600], ['up', 6700]]);
  ok(eq(r.outs, ['hold', 'expire']) && r.s.st === 'idle', '5초 지나면 풀리고, 그 뒤 탭은 확정 아님', r);
  r = run([['down', 0], ['cancel', 800]]);
  ok(r.s.st === 'idle' && !r.outs.length, '누르는 중 취소(손가락이 미끄러짐) → 처음으로');
  r = run([['down', 0], ['tick', 1500], ['cancel', 1700], ['up', 2500]]);
  ok(eq(r.outs, ['hold', 'fire']), '무장 뒤 손이 미끄러져도 무장은 남는다', r);
  r = run([['up', 0], ['tick', 5000]]);
  ok(r.s.st === 'idle' && !r.outs.length, '누르지 않은 떼기는 무시');
  r = run([['down', 0], ['tick', 1500], ['tick', 6600]]);
  ok(eq(r.outs, ['hold', 'expire']), '무장한 채 계속 누르고 있어도 5초면 풀린다', r);
  ok(M.holdFill({ st: 'press', t: 0 }, 750) === 0.5 && M.holdFill({ st: 'armed', t: 0 }, 2500) === 0.5 && M.holdFill(M.holdInit(), 9) === 0, '채움 비율');

  console.log(`${fail ? '✖' : '✔'} misedit ${pass} 통과 · ${fail} 실패`);
  process.exit(fail ? 1 : 0);
})();
