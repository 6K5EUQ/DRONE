// 미션 편집·비행 명령 — 화면과 떨어진 순수 함수 (node 로 시험: web/test/misedit_test.js).
//
// 탭 = { id, name, steps:[{ k, lat?, lon?, alt?, sec? }], rev }. 서버는 web/mission.js(/api/mission/*),
// 명령은 web/cmd.js(/api/cmd). 판정(오류·경고·경로)은 서버가 한다 — 여기서는 모양만 맞춘다.

export const KINDS = ['takeoff', 'goto', 'hover', 'land', 'rtl'];
export const KIND_NAME = { takeoff: '이륙', goto: '이동', hover: '호버', land: '착륙', rtl: '복귀' };
// 종류마다 쓰는 칸 — 이 밖의 값은 계획 요청에 싣지 않는다
export const FIELDS = { takeoff: ['alt'], goto: ['alt', 'xy'], hover: ['sec', 'xy'], land: ['xy'], rtl: [] };

const fin = (v) => v != null && v !== '' && Number.isFinite(Number(v));

/** 서버 탭 하나를 화면 모델로 — 모르는 종류의 단계는 버린다 */
export function tabFrom(t) {
  if (!t || typeof t !== 'object' || t.id == null) return null;
  const steps = (Array.isArray(t.steps) ? t.steps : []).filter((s) => s && KINDS.includes(s.k)).map(stepClean);
  return { id: String(t.id), name: String(t.name || ''), steps, rev: t.rev ?? 0, updated: t.updated ?? null };
}
export function tabsFrom(arr) { return (Array.isArray(arr) ? arr : []).map(tabFrom).filter(Boolean); }

/** 단계 하나 — 종류가 쓰는 칸만 숫자로 남긴다 */
export function stepClean(s) {
  const f = FIELDS[s.k] || [], o = { k: s.k };
  if (f.includes('alt') && fin(s.alt)) o.alt = Number(s.alt);
  if (f.includes('sec') && fin(s.sec)) o.sec = Number(s.sec);
  if (f.includes('xy') && fin(s.lat) && fin(s.lon)) { o.lat = Number(s.lat); o.lon = Number(s.lon); }
  return o;
}

/** PUT /api/mission/tabs/:id 본문 */
export function tabBody(t) { return { id: t.id, name: t.name, steps: t.steps.map(stepClean), rev: t.rev }; }

/** POST /api/mission/plan 본문 — 홈은 있으면 싣는다 */
export function planBody(t, home) {
  const b = { steps: t.steps.map(stepClean) };
  const h = homeOf(home);
  if (h) b.home = h;
  return b;
}
/** 라이브 상태의 home([lat, lon] 또는 {lat, lon}) → {lat, lon} */
export function homeOf(h) {
  if (Array.isArray(h) && fin(h[0]) && fin(h[1])) return { lat: Number(h[0]), lon: Number(h[1]) };
  if (h && fin(h.lat) && fin(h.lon)) return { lat: Number(h.lat), lon: Number(h.lon) };
  return null;
}

/** 새 단계 — 고도는 앞 단계의 것을 잇는다. 없으면 비워 둔다(서버 검사가 잡는다) */
export function newStep(k, steps = []) {
  const s = { k };
  if (FIELDS[k].includes('alt')) {
    for (let i = steps.length - 1; i >= 0; i--) if (fin(steps[i].alt)) { s.alt = steps[i].alt; break; }
  }
  return s;
}
export function moveStep(steps, i, d) {
  const j = i + d;
  if (i < 0 || j < 0 || i >= steps.length || j >= steps.length) return steps;
  const a = steps.slice(); [a[i], a[j]] = [a[j], a[i]]; return a;
}
export function delStep(steps, i) { return steps.filter((_, n) => n !== i); }

/** 계획 결과(MAVLink 항목) → 단계. 제목으로 자동 생성한 계획을 탭에 채울 때 쓴다 */
const CMD_KIND = { 22: 'takeoff', 16: 'goto', 19: 'hover', 17: 'hover', 21: 'land', 20: 'rtl' };
export function itemsToSteps(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const k = CMD_KIND[it.cmd];
    if (!k) continue;
    const s = { k };
    if (k === 'takeoff' || k === 'goto') s.alt = it.alt;
    if (k === 'hover' && fin(it.p1)) s.sec = it.p1;
    if (FIELDS[k].includes('xy') && fin(it.lat) && fin(it.lon) && (it.lat || it.lon)) { s.lat = it.lat; s.lon = it.lon; }
    out.push(stepClean(s));
  }
  // ArduPilot 미션의 0번은 홈이다 — 첫 이동이 이륙보다 앞이면 홈으로 보고 뺀다
  if (out.length > 1 && out[0].k === 'goto' && out.some((s) => s.k === 'takeoff')) out.shift();
  return out;
}

// ── 명령 상태 → 표시 ─────────────────────────────────────────────────
export const STATE_NAME = {
  created: '접수', awaiting_confirm: '확인 대기', queued: '대기', delivered: '전달', sent: '전송', fc_ack: 'FC 응답',
  done: '완료', rejected: '거부', expired: '만료', cancelled: '취소', failed: '실패', unknown: '결과 모름', preempted: '밀림',
};
export const END = new Set(['done', 'rejected', 'expired', 'cancelled', 'failed', 'unknown', 'preempted']);
export const BAD = new Set(['rejected', 'expired', 'failed', 'unknown', 'preempted']);
// 업로드 단계 막대 — 확인한 뒤부터
export const STAGES = ['queued', 'delivered', 'sent', 'fc_ack', 'done'];
export const STAGE_NAME = ['대기', '전달', '전송', '응답', '완료'];
export const REASON = {
  gps: 'GPS', volt: '전압', armed: '시동 중', 'live-stale': '연결 없음', confirm: '확인 시간 초과', ttl: '시간 초과',
  'no-ack': '응답 없음', restart: '서버 재시작', login: '로그인 필요', operator: '권한 없음', user: '권한 없음',
  kind: '입력 오류', args: '입력 오류', mode: '입력 오류', client_id: '입력 오류', json: '입력 오류', size: '입력 오류', state: '상태 오류', id: '명령 없음',
};
export const CMD_NAME = { mission_upload: '업로드', arm: 'ARM', mission_start: 'AUTO', rtl: 'RTL', land: 'LAND', disarm: 'DISARM', mode: '모드' };

/** 명령 하나 → { stage(막대 칸 수, 0~5), label, bad, reason } */
export function cmdView(c) {
  if (!c) return null;
  const st = c.state, i = STAGES.indexOf(st);
  const bad = BAD.has(st);
  let reason = '';
  if (bad || st === 'cancelled') {
    // preempted 의 reason 은 밀어낸 명령 id 다 — 사유 글자는 상태 이름으로 충분하다
    if (st !== 'preempted' && c.reason) reason = REASON[c.reason] || '';
    if (!reason && c.detail) reason = String(c.detail).slice(0, 60);
  }
  return { stage: st === 'done' ? STAGES.length : i >= 0 ? i + 1 : 0, label: STATE_NAME[st] || st || '', bad, end: END.has(st), reason };
}
/** 한 줄 — "RTL · 전달", 실패면 "ARM · 거부 · 전압" */
export function cmdLine(c) {
  const v = cmdView(c);
  if (!v) return '';
  return [CMD_NAME[c.kind] || c.kind, v.label, v.reason].filter(Boolean).join(' · ');
}

// ── 길게 누르기 → 확인 ───────────────────────────────────────────────
// idle ─down→ press ─(1.5초 tick)→ held ─up→ armed ─up(다시 탭)→ fire → idle
//              └ up/cancel → idle      held ─cancel→ armed     armed ─(5초 tick)→ idle(expire)
export const HOLD_MS = 1500, ARM_MS = 5000;
export const holdInit = () => ({ st: 'idle', t: 0 });
/** 상태기계 한 걸음 — { s, out } 를 돌려준다. out: 'hold'(무장됨) | 'fire'(확정) | 'expire'(시간 초과) | '' */
export function holdStep(s, ev, now) {
  switch (s.st) {
    case 'idle':
      return ev === 'down' ? { s: { st: 'press', t: now }, out: '' } : { s, out: '' };
    case 'press':
      if (ev === 'tick' && now - s.t >= HOLD_MS) return { s: { st: 'held', t: now }, out: 'hold' };
      if (ev === 'up' || ev === 'cancel') return { s: holdInit(), out: '' };
      return { s, out: '' };
    case 'held':   // 손가락이 아직 눌려 있다 — 이 손을 떼는 것은 확정이 아니다
      if (ev === 'up' || ev === 'cancel') return { s: { st: 'armed', t: s.t }, out: '' };
      if (ev === 'tick' && now - s.t >= ARM_MS) return { s: holdInit(), out: 'expire' };
      return { s, out: '' };
    case 'armed':
      if (ev === 'tick' && now - s.t >= ARM_MS) return { s: holdInit(), out: 'expire' };
      if (ev === 'up') return { s: holdInit(), out: 'fire' };
      return { s, out: '' };
    default:
      return { s: holdInit(), out: '' };
  }
}
/** 버튼에 그릴 진행 — 누르는 중 0~1 차오름, 무장 중 1~0 줄어듦 */
export function holdFill(s, now) {
  if (s.st === 'press') return Math.min(1, (now - s.t) / HOLD_MS);
  if (s.st === 'held' || s.st === 'armed') return Math.max(0, 1 - (now - s.t) / ARM_MS);
  return 0;
}
