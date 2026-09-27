// 라이브 트래킹 프론트.
//
// 폴링이다 (WebSocket 이 아니라). 서버가 상태 하나를 들고 있고 화면은 그것을
// 5Hz 로 긁어 간다. 이유: 잠깐 끊겨도 다음 폴에서 저절로 복구되고, 되감을
// 상태가 없어 재접속 로직이 필요 없다. 텔레메트리 자체가 5Hz 라 더 자주
// 받아도 같은 값이 두 번 온다.
//
// 항적은 증분으로 받는다 (?since=n). 40분 비행이면 점이 만 개가 넘는데
// 매번 전부 보내면 폴 하나가 수백 KB 가 된다.
//
// ── HUD 아키텍처: build-once / mutate-only ───────────────────────────
// buildHUD() 가 기동 시 약 500 노드를 한 번 만들고, 매 폴에는 transform·
// 기하 속성·가드된 textContent 만 쓴다 (프레임당 약 50 write). innerHTML
// 재생성은 HUD 어디에도 없다 — 5Hz 로 500 노드를 다시 만들면 초당 2500 노드
// 생성 + SVG 파싱 + 패널 전체 재래스터이고, clipPath 를 매 프레임 다시 만들면
// Blink 가 SVG 리소스 캐시를 버려 클립 영역을 통째로 다시 굽는다.
// 비용이 눈금 개수와 무관해지므로 나중에 요소를 더 얹어도 안 나빠진다.
//
// 좌표는 전부 원점(0,0) 기준으로 authored 하고, translate(cx,cy) 하나가
// 화면 위치를 담당한다. 리사이즈 때 자식 노드를 하나도 안 건드린다.

'use strict';

// 🔴 같은 파일이 **두 곳에서** 돈다:
//      로컬 트래커 (rim3 :4410)      → /api/state
//      drone01.bewe.co.kr  /live     → /api/live/state   (rim3 가 밀어 올린 것)
//    화면·계기·차트는 완전히 같아야 하므로 파일을 나누지 않고, **어느 API 를
//    두드릴지만** 갈라 놓는다.
const ON_WEB = location.pathname.startsWith('/live');
const API_STATE = ON_WEB ? '/api/live/state' : '/api/state';

const POLL_MS = 50;                   // 화면 폴 20Hz — 아래 CHART_EVERY 주석 참조
const CHART_HZ = 5;                   // 차트 격자는 5Hz 로 유지한다

// ── 계기 스케일 상수. 빌드와 layout() 이 같은 값을 읽는다 (두 벌이 되면 어긋난다) ──
const PPD_PITCH = 6.0;                // 피치 px/도
const PPU_SPD = 12;                   // 대지속도 px/(m/s)
const PPU_ALT = 8;                    // 고도 px/m — AH=807 이면 ±50m 가 보인다
const PPD_HDG = 8.0;                  // 기수 px/도
const PPU_VSI = 22;                   // 상승률 px/(m/s)
const OVER = 2600;                    // 하늘/땅 오버스캔 반폭 (4K 반대각선의 1.7배)

const HDG_H = 34;                     // 상단 기수 테이프 높이

const SVGNS = 'http://www.w3.org/2000/svg';
const $ = (id) => document.getElementById(id);

// ── 레이아웃 변수. layout() 에서만 갱신, 매 프레임 transform 이 이걸 읽는다 ──
let W = 0, H = 0, TAPE_W = 72, AY0 = HDG_H, AY1 = 0, AH = 0;
let cx = 0, cy = 0, ARC_R = 0, CENTER_DY = 0;

const h = {};                         // HUD 노드 참조
let havePos = false;
let winSec = 180;                     // 차트가 보여주는 시간 창 (0 = 전체)
let hoverT = null;                    // 커서가 붙잡고 있는 시각 (없으면 null)

// ── 차트 버퍼 ───────────────────────────────────────────────────────
// 로그 뷰어의 extract.py 가 만드는 trk 와 **같은 모양**이다: 균일 격자(hz, n)
// 위에 채널별 배열. 그래야 web/public/chart.js 의 drawChart 를 고치지 않고
// 그대로 쓸 수 있고, 지난 비행과 지금 비행이 같은 그림으로 나온다.
//
// 폴 한 번이 격자 한 칸이다. 값이 없으면 null 을 넣는다 — 건너뛰면 시간축이
// 밀려 20분 뒤 그래프가 실제보다 짧아진다.
// 🔴 격자 주파수는 POLL_MS 에 매달지 마라. 폴(20Hz)을 따라 올라가면 1시간
//    버퍼가 18000→72000 칸이 되고 차트 시간축이 4배로 늘어난다. 격자는
//    벽시계 5Hz 로 고정한다.
const HZ = CHART_HZ;                  // 5Hz
const KEEP_N = 3600 * HZ;             // 1시간치까지 들고 있는다
// 폴 몇 번에 한 칸이냐 — 20Hz 폴 / 5Hz 격자 = 4
const CHART_EVERY = Math.max(1, Math.round(1000 / POLL_MS / CHART_HZ));
const trk = { hz: HZ, n: 0, dur: 0, modes: [], events: [] };
let lastMode = null;
let lastSeq = -1, lastSeqPoll = 0, pollN = 0;
let warnUntil = 0, warnText = '', warnKoText = '', lastMsgKey = '';

// 🔴 FC 경고의 한글 요약. 이 기체 로그(flights/)에서 실제로 나온 것만 넣었다 —
//    지어내지 않는다: 여기 없으면 아래 줄을 비운다.
//    앞부분만 맞으면 되도록 **접두 일치**로 찾는다 (뒤에 숫자·단위가 붙는다).
const WARN_KO = [
  ['PreArm: Battery failsafe',        '배터리 페일세이프, Arm 거부'],
  ['Flight mode change failed',       '모드 변경 실패'],
  ['EKF2 IMU0 ground mag anomaly',    '지상 자기 이상, 기수 재정렬'],
  ['Battery 1 is low',                '배터리 부족'],
  ['Battery 1 is critical',           '🔴 배터리 위험'],
  ['Crash: Disarming',                '🔴 충돌 감지, 시동 꺼짐'],
];

// 긴 키를 먼저 본다 — 짧은 접두가 구체적인 문구를 가로채지 않게.
const WARN_KO_SORTED = [...WARN_KO].sort((a, b) => b[0].length - a[0].length);

/** 경고 원문 → 한글 한 줄. 모르는 문구면 ''. */
function warnKo(t) {
  if (!t) return '';
  // `[모듈] 본문` 꼴이 흔하다. 대괄호를 떼고 본다.
  const body = t.replace(/^\s*\[[^\]]*\]\s*/, '');
  for (const [k, v] of WARN_KO_SORTED) if (body.startsWith(k)) return v;
  return '';
}

// ── SVG 헬퍼 ────────────────────────────────────────────────────────
// SVG 요소에 innerHTML 로 자식을 넣으면 네임스페이스가 어긋나고, 빌드 코드
// (문자열)와 갱신 코드(DOM)가 갈라져 좌표 상수가 두 벌이 된다. 전부 createElementNS.
function el(tag, attrs, parent) {
  const e = document.createElementNS(SVGNS, tag);
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
// 같은 문자열을 매 프레임 덮어쓰면 불필요한 텍스트 재측정이 난다.
function setText(e, s) { if (e._v !== s) { e._v = s; e.textContent = s; } }
function setAttr(e, k, v) {
  const c = e['_a' + k];
  if (c !== v) { e['_a' + k] = v; e.setAttribute(k, v); }
}
function show(e, on) { e.classList.toggle('off', !on); }

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const wrap180 = (x) => ((x + 180) % 360 + 360) % 360 - 180;
const wrap360 = (x) => ((x % 360) + 360) % 360;
const fmt = (v, n = 1) => (v == null || !isFinite(v) ? '—' : v.toFixed(n));

// ── HUD 생성 (기동 시 1회) ──────────────────────────────────────────
function buildHUD() {
  const svg = $('hud');
  const defs = el('defs', null, svg);
  const clip = (id) => el('rect', {}, el('clipPath', { id }, defs));
  h.clipAll = clip('hudClipAll');
  h.clipCore = clip('hudClipCore');
  h.clipSpd = clip('hudClipSpd');
  h.clipAlt = clip('hudClipAlt');
  h.clipHdg = clip('hudClipHdg');

  // ① 인공수평의 배경 — 테이프 뒤까지 깔린다 (테이프 배경이 반투명이라 비친다).
  // 🔴 클립은 회전하지 않는 바깥 <g> 에 건다. 회전 그룹 안에 걸면 클립 사각형이
  //    같이 돌아 화면 모서리가 샌다. 그래서 자세 transform 이 2쌍이다.
  const bgWrap = el('g', { 'clip-path': 'url(#hudClipAll)' }, svg);
  h.bgCore = el('g', {}, bgWrap);
  h.bgRoll = el('g', {}, h.bgCore);
  h.bgPitch = el('g', {}, h.bgRoll);
  el('rect', { x: -OVER, y: -3300, width: OVER * 2, height: 3300, fill: '#2f6fa8' }, h.bgPitch);
  el('rect', { x: -OVER, y: 0, width: OVER * 2, height: 3300, fill: '#7a5230' }, h.bgPitch);
  el('line', { x1: -OVER, y1: 0, x2: OVER, y2: 0, stroke: '#0d1117', 'stroke-width': 6 }, h.bgPitch);
  el('line', { x1: -OVER, y1: 0, x2: OVER, y2: 0, stroke: '#e6edf3', 'stroke-width': 2 }, h.bgPitch);

  // ② 계기층 — 테이프 안쪽으로 잘린다.
  const coreWrap = el('g', { 'clip-path': 'url(#hudClipCore)' }, svg);
  h.core = el('g', {}, coreWrap);
  h.roll = el('g', {}, h.core);
  // 🔴 피치는 회전 g 의 **자식** 에 translate 로 준다 — '회전 후 이동' 순서를
  //    구조로 강제한다. 순서가 뒤집히면 롤이 걸린 상태에서 피치가 엉뚱한 축으로 움직인다.
  h.pitch = el('g', {}, h.roll);

  // 피치 사다리. 헤일로를 한 벌 먼저 깔고 그 위에 본체 — filter 금지
  // (회전 그룹에 붙이면 매 프레임 래스터 재계산).
  const halo = el('g', { stroke: '#0d1117', 'stroke-width': 6, fill: 'none' }, h.pitch);
  const lad = el('g', { stroke: '#e6edf3', 'stroke-width': 2, fill: 'none' }, h.pitch);
  h.ladLabels = [];
  for (let P = -40; P <= 40; P += 5) {
    if (P === 0) continue;
    const y = -P * PPD_PITCH;
    const w = P % 10 === 0 ? 60 : 30;
    // 음수(하강)는 파선 — 수평선이 화면 밖으로 나가도 하늘/땅 방향을 알려준다.
    const dash = P < 0 ? { 'stroke-dasharray': '8 6' } : {};
    el('line', Object.assign({ x1: -w, y1: y, x2: w, y2: y }, dash), halo);
    el('line', Object.assign({ x1: -w, y1: y, x2: w, y2: y }, dash), lad);
    if (P % 10 === 0) {
      const t = String(Math.abs(P));
      h.ladLabels.push(
        el('text', { x: -66, y: y + 5, 'text-anchor': 'end', 'font-size': 13, fill: '#e6edf3' }, lad),
        el('text', { x: 66, y: y + 5, 'text-anchor': 'start', 'font-size': 13, fill: '#e6edf3' }, lad));
      h.ladLabels[h.ladLabels.length - 2].textContent = t;
      h.ladLabels[h.ladLabels.length - 1].textContent = t;
    }
  }

  // 롤 지시 삼각형 — hudRoll 의 자식이라 rotate 를 **상속만** 한다.
  // 매 프레임 쓸 것이 없고, 구조적으로 수평선과 같은 각도로 붙어 돈다.
  h.rollPtr = el('polygon', { points: '0,0 -9,16 9,16', fill: 'var(--c-spd)' }, h.roll);

  // 롤 호 눈금 — 회전하지 않는다 (core 직속).
  h.rollArc = el('g', { stroke: '#e6edf3', fill: 'none' }, h.core);
  h.arcTicks = [];
  for (let i = 0; i < 11; i++) h.arcTicks.push(el('line', {}, h.rollArc));
  h.arcRef = el('polygon', { fill: '#e6edf3', stroke: 'none' }, h.core);

  // 고정 기체 심볼 — 야외 글레어 대비 얇은 선 금지.
  const symH = el('g', { stroke: '#0d1117', 'stroke-width': 8, fill: 'none', 'stroke-linecap': 'round' }, h.core);
  const symB = el('g', { stroke: '#f0883e', 'stroke-width': 4, fill: 'none', 'stroke-linecap': 'round' }, h.core);
  for (const g of [symH, symB]) {
    el('path', { d: 'M-110 0 H-40 L-40 14' }, g);
    el('path', { d: 'M110 0 H40 L40 14' }, g);
  }
  el('circle', { cx: 0, cy: 0, r: 4, fill: '#f0883e', stroke: 'none' }, h.core);

  // 중앙 상태 블록
  h.center = el('g', {}, h.core);
  h.arm = el('text', { x: 0, y: 0, 'text-anchor': 'middle', class: 'armTxt' }, h.center);
  h.mode = el('text', { x: 0, y: 34, 'text-anchor': 'middle', class: 'modeTxt', fill: 'var(--text)' }, h.center);
  // 🔴 경고는 피치 사다리와 안 겹치게 내리되, **HUD 밖으로 나가면 안 된다.**
  //    너무 올리면 −10°·−15° 가로대에 잘리고, 너무 내리면 짧은 HUD 아래로
  //    넘쳐 통째로 안 보인다. y=78·108 이면 −13°·−18° 자리다 — 그 구간 가로대는 짧은 대(30px)뿐이라
  //    폭 400px 판이 통째로 덮는다. 판이 겹침을 해결하므로 y 를 더 내릴 이유가 없다.
  // 🔴 비상정지. arm/모드 위에 겹쳐 놓는 것이 아니라 **둘을 숨기고 대신** 뜬다
  //    (아래 update 참조). 모터가 끊긴 상태에서 ARMED 와 비행모드를 같이
  //    보여주면 읽는 사람이 무엇이 참인지 재느라 시간을 쓴다. 여기서 필요한
  //    정보는 하나다 — 지금 모터가 죽어 있다.
  h.kill = el('g', { class: 'off' }, h.center);
  el('rect', { x: -200, y: -34, width: 400, height: 46, rx: 4,
               fill: '#0d1117', opacity: .95,
               stroke: 'var(--bad)', 'stroke-width': 3 }, h.kill);
  h.killTxt = el('text', { x: 0, y: 2, 'text-anchor': 'middle', class: 'killTxt',
                           fill: 'var(--bad)' }, h.kill);


  // 일반 경고도 글자 뒤에 판을 깐다. 사다리 위에 그냥 얹으면 헤일로만으로는
  // 가로대를 못 이긴다.
  h.warnBg = el('rect', { x: -200, y: 92, width: 400, height: 26, rx: 4,
                          fill: '#0d1117', opacity: .92, class: 'off' }, h.center);
  h.warn = el('text', { x: 0, y: 110, 'text-anchor': 'middle', class: 'warnTxt', fill: 'var(--bad)' }, h.center);
  // 🔴 원문 아래 한글 한 줄. FC 가 내는 영어를 그대로만 띄우면
  //    현장에서 무슨 뜻인지 생각하는 동안 시간이 간다. 원문은 그대로 두고
  //    (검색·문서 대조에 그게 필요하다) 아래에 요약만 붙인다.
  h.warnKo = el('text', { x: 0, y: 126, 'text-anchor': 'middle', class: 'warnKo',
                          fill: 'var(--bad)' }, h.center);

  // ③ 좌측 테이프 — 대지속도 (🔴 대기속도가 아니다)
  h.spdBg = el('rect', { fill: 'rgba(22,27,34,.62)' }, svg);
  const spdClip = el('g', { 'clip-path': 'url(#hudClipSpd)' }, svg);
  h.spdSlide = el('g', {}, spdClip);
  for (let v = 0; v <= 40; v++) {
    const y = -v * PPU_SPD, five = v % 5 === 0;
    el('line', { x1: 0, y1: y, x2: five ? -14 : -8, y2: y, stroke: '#e6edf3', 'stroke-width': five ? 1.6 : 1, opacity: five ? 1 : .6 }, h.spdSlide);
    if (five) {
      const t = el('text', { x: -18, y: y + 4, 'text-anchor': 'end', 'font-size': 12, fill: '#e6edf3' }, h.spdSlide);
      t.textContent = String(v);
    }
  }
  h.spdBox = el('rect', { fill: '#0d1117', opacity: .92, stroke: 'var(--c-spd)', 'stroke-width': 1.5 }, svg);
  h.spdApex = el('polygon', { fill: '#0d1117', opacity: .92, stroke: 'var(--c-spd)', 'stroke-width': 1.5 }, svg);
  h.spdVal = el('text', { 'text-anchor': 'end', 'font-size': 22, fill: '#e6edf3' }, svg);
  // 머리말·단위. 무슨 값인지 테이프만 보고 읽혀야 한다. 눈금 위에 판을 깔아
  // 겹침을 막는다.
  // ⚠️ 좌측은 **대지속도**다 — 이 기체에는 대기속도 센서가 없다.
  h.spdHdrBg = el('rect', { fill: '#0d1117', opacity: .96, rx: 3 }, svg);
  h.spdHdr = el('text', { 'text-anchor': 'end', 'font-size': 11, 'font-weight': 700,
                          fill: 'var(--c-spd)', 'letter-spacing': '.5px' }, svg);
  h.spdHdr.textContent = 'SPD';
  h.spdUnitBg = el('rect', { fill: '#0d1117', opacity: .92, rx: 3 }, svg);
  h.spdUnit = el('text', { 'text-anchor': 'end', 'font-size': 11, fill: '#e6edf3', opacity: .85 }, svg);
  h.spdUnit.textContent = 'm/s';

  // ④ 우측 테이프 — 고도 AGL + 지면대
  h.altBg = el('rect', { fill: 'rgba(22,27,34,.62)' }, svg);
  const altClip = el('g', { 'clip-path': 'url(#hudClipAlt)' }, svg);
  h.altSlide = el('g', {}, altClip);
  h.gndBand = el('rect', { y: 0, fill: 'var(--bad)', opacity: .10 }, h.altSlide);
  h.gndLine = el('line', { x1: 0, y1: 0, y2: 0, stroke: 'var(--dim)', 'stroke-width': 2 }, h.altSlide);
  for (let v = -10; v <= 120; v += 2) {
    const y = -v * PPU_ALT, ten = v % 10 === 0;
    el('line', { x1: 0, y1: y, x2: ten ? 14 : 8, y2: y, stroke: '#e6edf3', 'stroke-width': ten ? 1.6 : 1, opacity: ten ? 1 : .6 }, h.altSlide);
    if (ten) {
      const t = el('text', { x: 18, y: y + 4, 'text-anchor': 'start', 'font-size': 12, fill: '#e6edf3' }, h.altSlide);
      t.textContent = String(v);
    }
  }
  h.altBox = el('rect', { fill: '#0d1117', opacity: .92, stroke: 'var(--c-alt)', 'stroke-width': 1.5 }, svg);
  h.altApex = el('polygon', { fill: '#0d1117', opacity: .92, stroke: 'var(--c-alt)', 'stroke-width': 1.5 }, svg);
  h.altVal = el('text', { 'text-anchor': 'start', 'font-size': 22, fill: '#e6edf3' }, svg);
  h.altHdrBg = el('rect', { fill: '#0d1117', opacity: .96, rx: 3 }, svg);
  h.altHdr = el('text', { 'text-anchor': 'start', 'font-size': 11, 'font-weight': 700,
                          fill: 'var(--c-alt)', 'letter-spacing': '.5px' }, svg);
  h.altHdr.textContent = 'ALT';
  h.altUnitBg = el('rect', { fill: '#0d1117', opacity: .92, rx: 3 }, svg);
  h.altUnit = el('text', { 'text-anchor': 'start', 'font-size': 11, fill: '#e6edf3', opacity: .85 }, svg);
  h.altUnit.textContent = 'm';


  // ⑤ 상승률 리본 — 숫자는 안 쓴다. 크기보다 부호와 추세라 막대가 더 빠르다.
  h.vsiTicks = [];
  for (let i = 0; i < 4; i++) h.vsiTicks.push(el('line', { stroke: 'var(--border-2)', 'stroke-width': 1 }, svg));
  h.vsi = el('rect', { fill: 'var(--c-alt)' }, svg);

  // ⑥ 상단 기수 테이프. 🔴 359→0 이음매: 사다리를 -60..780 한 벌로 만들어
  //    어느 방향으로 몇 바퀴를 돌아도 재렌더·모듈로 로직이 0 이다.
  h.hdgBg = el('rect', { fill: 'rgba(22,27,34,.62)' }, svg);
  h.hdgWrap = el('g', { 'clip-path': 'url(#hudClipHdg)' }, svg);
  h.hdgSlide = el('g', {}, h.hdgWrap);
  h.hdgMinor = [];
  const CARD = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' };
  for (let d = -60; d <= 780; d += 5) {
    const x = d * PPD_HDG, ten = d % 10 === 0;
    const ln = el('line', { x1: x, y1: HDG_H, x2: x, y2: ten ? 20 : 26, stroke: '#e6edf3', 'stroke-width': ten ? 1.6 : 1, opacity: ten ? 1 : .6 }, h.hdgSlide);
    if (!ten) h.hdgMinor.push(ln);
    if (ten) {
      const w = wrap360(d), c = CARD[w];
      const t = el('text', {
        x, y: 17, 'text-anchor': 'middle', 'font-size': c ? 15 : 13,
        fill: c ? 'var(--accent)' : '#e6edf3', 'font-weight': c ? 700 : 400,
      }, h.hdgSlide);
      t.textContent = c || String(w / 10).padStart(2, '0');
    }
  }
  // 코스 마커·홈 벅은 슬라이드가 아니라 창 좌표로 놓는다 (자기 transform 을 가진다).
  h.course = el('polygon', { points: '0,4 6,10 0,16 -6,10', fill: '#e6edf3', class: 'off' }, h.hdgWrap);
  h.homeBug = el('g', { class: 'off' }, h.hdgWrap);
  el('polygon', { points: '0,4 6,12 -6,12', fill: 'var(--ok)' }, h.homeBug);
  const hb = el('text', { x: 0, y: 24, 'text-anchor': 'middle', 'font-size': 10, fill: 'var(--ok)' }, h.homeBug);
  hb.textContent = 'H';
  // 창 밖으로 나가면 가장자리 삼각형으로 바꾼다 — 클램프해서 붙여 두면
  // '정확히 저쪽 57°' 로 읽혀 계기가 거짓말한다.
  h.bugL = el('polygon', { fill: '#e6edf3', class: 'off' }, svg);
  h.bugR = el('polygon', { fill: '#e6edf3', class: 'off' }, svg);
  h.hdgApex = el('polygon', { fill: '#0d1117', opacity: .92, stroke: 'var(--border-2)' }, svg);
  h.hdgBox = el('rect', { fill: '#0d1117', opacity: .92, stroke: 'var(--border-2)' }, svg);
  h.hdgVal = el('text', { 'text-anchor': 'middle', 'font-size': 17, fill: '#e6edf3' }, svg);
  h.hdgSrc = el('text', { 'font-size': 9, fill: 'var(--muted)' }, svg);

  // ⑨ 프리즈 오버레이 — 얼어붙은 테이프는 정상 테이프와 겉모습이 같다.
  //    얼어붙은 계기는 자기가 얼었다고 온몸으로 말해야 한다.
  h.freeze = el('rect', { fill: '#0d1117', opacity: .55, class: 'off' }, svg);
  h.freezeTxt = el('text', { 'text-anchor': 'middle', 'font-size': 30, fill: 'var(--bad)', class: 'off' }, svg);
}

// ── 리사이즈 배치 ───────────────────────────────────────────────────
// 🔴 viewBox 속성만 바꾸고 width/height/style 은 절대 안 건드린다 →
//    레이아웃에 영향을 안 주므로 ResizeObserver 무한루프가 성립하지 않는다.
function layout(w, hh) {
  W = w; H = hh;
  TAPE_W = clamp(W * 0.082, 62, 92);
  AY0 = HDG_H; AY1 = H; AH = AY1 - AY0;
  cx = W / 2; cy = AY0 + AH / 2;
  // min(W,AH) 가 핵심 — max 나 W 를 쓰면 세로가 짧은 패널에서 호가 잘린다.
  ARC_R = Math.min(W, AH) * 0.36;
  CENTER_DY = Math.min(AH * 0.17, 150);

  const svg = $('hud');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.classList.toggle('small', AH < 420);

  const box = (r, x, y, ww, hg) => {
    setAttr(r, 'x', x); setAttr(r, 'y', y);
    setAttr(r, 'width', Math.max(0, ww)); setAttr(r, 'height', Math.max(0, hg));
  };
  box(h.clipAll, 0, AY0, W, AH);
  box(h.clipCore, TAPE_W, AY0, W - 2 * TAPE_W, AH);
  box(h.clipSpd, 0, AY0, TAPE_W, AH);
  box(h.clipAlt, W - TAPE_W, AY0, TAPE_W, AH);
  box(h.clipHdg, TAPE_W, 0, W - 2 * TAPE_W, HDG_H + 40);

  setAttr(h.bgCore, 'transform', `translate(${cx},${cy})`);
  setAttr(h.core, 'transform', `translate(${cx},${cy})`);
  setAttr(h.center, 'transform', `translate(0,${CENTER_DY})`);

  // 롤 호 — scale 을 쓰지 않는다 (stroke 폭까지 바뀐다). 좌표를 다시 쓴다.
  const ARC = [0, -10, 10, -20, 20, -30, 30, -45, 45, -60, 60];
  ARC.forEach((a, i) => {
    const big = a === 0 || Math.abs(a) === 30 || Math.abs(a) === 60;
    const L = big ? 11 : 7, th = (-90 + a) * Math.PI / 180;
    const c = Math.cos(th), s = Math.sin(th), t = h.arcTicks[i];
    setAttr(t, 'x1', (ARC_R * c).toFixed(1)); setAttr(t, 'y1', (ARC_R * s).toFixed(1));
    setAttr(t, 'x2', ((ARC_R + L) * c).toFixed(1)); setAttr(t, 'y2', ((ARC_R + L) * s).toFixed(1));
    setAttr(t, 'stroke-width', big ? 2.5 : 2);
  });
  setAttr(h.arcRef, 'points', `0,${-ARC_R - 2} -8,${-ARC_R - 14} 8,${-ARC_R - 14}`);
  setAttr(h.rollPtr, 'transform', `translate(0,${-ARC_R})`);
  show(h.rollArc, AH >= 300);
  show(h.arcRef, AH >= 300);
  show(h.rollPtr, AH >= 300);
  // 좁으면 라벨·단눈금을 끈다 (노드 삭제가 아니다 — 넓어지면 되살아난다).
  for (const t of h.ladLabels) show(t, W >= 460);
  for (const t of h.hdgMinor) show(t, W >= 460);

  // 좌 테이프. 🔴 판독 박스 폭은 TAPE_W 에 맞춘다 — 88px 로 고정하면
  //    테이프(62~92px)보다 넓어져 박스가 패널 밖으로 잘려 나간다.
  box(h.spdBg, 0, AY0, TAPE_W, AH);
  box(h.spdBox, 0, cy - 15, TAPE_W, 30);
  setAttr(h.spdApex, 'points', `${TAPE_W},${cy - 9} ${TAPE_W + 12},${cy} ${TAPE_W},${cy + 9}`);
  setAttr(h.spdVal, 'x', TAPE_W - 6); setAttr(h.spdVal, 'y', cy + 8);
  // 머리말은 테이프 맨 위, 단위는 판독 박스 바로 아래 — 둘 다 눈금 라벨 열(x=TAPE_W-18)에 맞춘다.
  // 판은 눈금 라벨 한 줄(12px)을 통째로 덮을 높이 — 반만 가리면 더 지저분하다.
  box(h.spdHdrBg, 2, AY0 + 2, TAPE_W - 4, 22);
  setAttr(h.spdHdr, 'x', TAPE_W - 6); setAttr(h.spdHdr, 'y', AY0 + 17);
  // 단위도 판을 깐다 — 눈금 라벨이 스크롤하며 그 자리를 지나간다.
  box(h.spdUnitBg, TAPE_W - 34, cy + 17, 32, 15);
  setAttr(h.spdUnit, 'x', TAPE_W - 6); setAttr(h.spdUnit, 'y', cy + 28);

  // 우 테이프
  box(h.altBg, W - TAPE_W, AY0, TAPE_W, AH);
  box(h.altBox, W - TAPE_W, cy - 15, TAPE_W, 30);
  setAttr(h.altApex, 'points', `${W - TAPE_W},${cy - 9} ${W - TAPE_W - 12},${cy} ${W - TAPE_W},${cy + 9}`);
  setAttr(h.altVal, 'x', W - TAPE_W + 6); setAttr(h.altVal, 'y', cy + 8);
  box(h.altHdrBg, W - TAPE_W + 2, AY0 + 2, TAPE_W - 4, 22);
  setAttr(h.altHdr, 'x', W - TAPE_W + 6); setAttr(h.altHdr, 'y', AY0 + 17);
  box(h.altUnitBg, W - TAPE_W + 2, cy + 17, 20, 15);
  setAttr(h.altUnit, 'x', W - TAPE_W + 6); setAttr(h.altUnit, 'y', cy + 28);
  setAttr(h.gndBand, 'width', TAPE_W); setAttr(h.gndBand, 'height', 80);
  setAttr(h.gndLine, 'x2', TAPE_W);

  // VSI — 고도 테이프 안쪽 모서리에 붙는다
  const vx = W - TAPE_W - 16;
  [2, -2, 5, -5].forEach((v, i) => {
    const t = h.vsiTicks[i], y = cy - v * PPU_VSI;
    setAttr(t, 'x1', vx); setAttr(t, 'y1', y); setAttr(t, 'x2', vx + 12); setAttr(t, 'y2', y);
  });
  setAttr(h.vsi, 'x', vx); setAttr(h.vsi, 'width', 12);

  // 기수 테이프
  box(h.hdgBg, TAPE_W, 0, W - 2 * TAPE_W, HDG_H);
  setAttr(h.hdgApex, 'points', `${cx},${HDG_H} ${cx - 9},${HDG_H + 10} ${cx + 9},${HDG_H + 10}`);
  box(h.hdgBox, cx - 34, HDG_H + 10, 68, 24);
  setAttr(h.hdgVal, 'x', cx); setAttr(h.hdgVal, 'y', HDG_H + 27);
  setAttr(h.hdgSrc, 'x', cx + 40); setAttr(h.hdgSrc, 'y', HDG_H + 27);
  setAttr(h.bugL, 'points', `${TAPE_W + 2},${HDG_H + 4} ${TAPE_W + 12},${HDG_H - 2} ${TAPE_W + 12},${HDG_H + 10}`);
  setAttr(h.bugR, 'points', `${W - TAPE_W - 2},${HDG_H + 4} ${W - TAPE_W - 12},${HDG_H - 2} ${W - TAPE_W - 12},${HDG_H + 10}`);

  box(h.freeze, 0, 0, W, H);
  setAttr(h.freezeTxt, 'x', cx); setAttr(h.freezeTxt, 'y', cy);
}

// ── 차트 ────────────────────────────────────────────────────────────
// 단 구성·색은 로그 뷰어(log.html 의 CHARTS)와 맞춘다.
const CHARTS = [
  // minSpan — 축이 최소한 이만큼은 담는다. 없으면 지상 정지 중 ±1cm 노이즈가
  // 화면을 가득 채우고 눈금이 `0 / -0 / 0` 이 된다 (실측 rim3: climb -0.0013).
  // 값이 실제로 안 움직이면 **평평하게 보이는 것이 사실**이다.
  // 🔴 고도와 속도를 한 칸에 둔다. 보조자가 기본으로
  //    보는 것은 이 칸과 자세 둘뿐이고, 둘을 나란히 놓으면 「높이 대 빠르기」가
  //    한눈에 읽힌다. 상승률은 뺐다 — 고도선의 기울기가 같은 것을 말한다.
  //    속도는 **GPS 속도**(GLOBAL_POSITION_INT 의 vx·vy 합성, EKF 융합)다.
  { id: 'k-alt', title: '고도+속도', on: true, series: [
      { key: 'alt', color: 'var(--c-alt)', label: '고도', axis: 'left', weight: 2, unit: 'm', minSpan: 4 },
      { key: 'spd', color: 'var(--c-spd)', label: 'GPS 속도', axis: 'right', weight: 2, unit: 'm/s', minSpan: 4, nonNeg: true }],
    // 기준선은 축을 그 값까지 늘린다(chart.js) — 평소 5m 비행에서도 30m 가 어디인지 보인다.
    thresholds: [{ v: 30, label: '30m', color: '#d29922' }] },
  { id: 'k-pwr', title: '전력', on: false, series: [
      { key: 'cur', color: 'var(--c-cur)', label: '전류', axis: 'left', weight: 2, unit: 'A', minSpan: 10, nonNeg: true },
      // 4S 는 만충 16.8V·하한 13.2V(MOT_BAT_VOLT_MIN) 라 폭이 2V 면 비행 대부분이 담긴다.
      { key: 'volt', color: 'var(--c-volt)', label: '전압', axis: 'right', unit: 'V', minSpan: 2 }],
    // 모터 연속 14 A × 4 = 56 A (docs/design/01) — 그 7할인 40A 에 선을 긋는다.
    thresholds: [{ v: 40, label: '40A', color: '#d29922' }] },
  { id: 'k-att', title: '자세', on: true, series: [
      { key: 'roll', color: '#d55e00', label: '롤', axis: 'left', weight: 2, unit: '°', minSpan: 20 },
      { key: 'pitch', color: '#e69f00', label: '피치', axis: 'left', weight: 2, unit: '°', minSpan: 20 }] },
  { id: 'k-vib', title: '진동', on: false, series: [
      { key: 'vib', color: '#f0883e', label: '진동(최대축)', axis: 'left', weight: 2, unit: 'm/s²', minSpan: 6, nonNeg: true }],
    // VIBRATION 은 m/s² 다. ArduCopter 기준 30 넘으면 주의, 60 넘으면 위치 추정이
    // 흔들린다 (log.html 진동 단과 같은 값).
    thresholds: [{ v: 30, label: '30', color: '#d29922' },
                 { v: 60, label: '60', color: '#f85149' }] },
  { id: 'k-gps', title: 'GPS', on: false, series: [
      { key: 'sats', color: '#3fb950', label: '위성 수', axis: 'left', weight: 2, minSpan: 6, nonNeg: true },
      { key: 'eph', color: '#f85149', label: '위치 오차', axis: 'right', unit: 'm', minSpan: 2, nonNeg: true }] },
  { id: 'k-ekf', title: 'EKF', on: false, series: [
      // EKF 는 비율이라 1.0 이 한계선이다. 축이 늘 0~1 을 담아야 지금이
      // 한계에서 얼마나 떨어져 있는지 한눈에 읽힌다.
      { key: 'ekf_vel', color: '#58a6ff', label: '속도', axis: 'left', minSpan: 1.2, nonNeg: true },
      { key: 'ekf_pos', color: '#3fb950', label: '위치', axis: 'left', minSpan: 1.2, nonNeg: true },
      { key: 'ekf_alt', color: '#f0883e', label: '고도', axis: 'left', minSpan: 1.2, nonNeg: true },
      { key: 'ekf_mag', color: '#a371f7', label: '지자기', axis: 'left', minSpan: 1.2, nonNeg: true }],
    // 비율이다. 1 을 넘으면 그 센서의 혁신 검사가 깨지고 있다는 뜻.
    thresholds: [{ v: 1, label: '한계', color: '#d29922' }] },
];
const shownIds = new Set(CHARTS.filter((c) => c.on).map((c) => c.id));

// 🔴 chart.js 는 stroke 를 **SVG 속성**으로 쓴다 (stroke="..."). 속성값은 CSS
//    변수를 풀지 않으므로 var(--c-alt) 를 그대로 넘기면 선이 그려지긴 해도
//    색이 없어 화면에서 사라진다. log.html 이 cssVar() 를 거치는 이유가 이것이다.
//    기동 시 한 번 실제 색으로 바꿔 둔다.
function cssVar(v) {
  return v && v.startsWith('var(')
    ? getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() || v
    : v;
}
function resolveColors() {
  for (const c of CHARTS) for (const sx of c.series) sx.color = cssVar(sx.color);
}

/** 폴 한 번 = 격자 한 칸. */
function pushSample(d) {
  const put = (k, v) => {
    // 뒤늦게 처음 등장한 채널은 앞을 null 로 채워 길이를 맞춘다.
    if (!trk[k]) trk[k] = new Array(trk.n).fill(null);
    trk[k].push(v == null || !isFinite(v) ? null : v);
  };
  put('alt', d.alt);
  put('climb', d.climb);
  put('spd', d.groundspeed);
  put('roll', d.roll);
  put('pitch', d.pitch);
  put('cur', d.cur);
  put('volt', d.volt);
  put('vib', d.vibe ? Math.max(...d.vibe) : null);
  put('sats', d.sats);
  put('eph', d.eph);
  const r = d.ekf_ratio || {};
  put('ekf_vel', r.vel); put('ekf_pos', r.pos); put('ekf_alt', r.alt); put('ekf_mag', r.mag);

  trk.n++;
  trk.dur = (trk.n - 1) / trk.hz;

  // 모드가 바뀌면 밴드를 연다 — 로그 뷰어와 같은 배경 띠가 된다.
  if (d.mode && d.mode !== lastMode) {
    trk.modes.push({ t: trk.dur, name: d.mode });
    lastMode = d.mode;
  }

  // 오래된 것을 버린다. 모든 채널에서 **같은 개수**를 떨궈야 인덱스가 안 어긋난다.
  if (trk.n > KEEP_N) {
    const drop = trk.n - KEEP_N;
    for (const k of Object.keys(trk)) {
      if (Array.isArray(trk[k]) && k !== 'modes' && k !== 'events') trk[k].splice(0, drop);
    }
    trk.n -= drop;
    const shift = drop / trk.hz;
    trk.dur -= shift;
    for (const m of trk.modes) m.t -= shift;
    // 창 밖으로 나간 밴드는 접는다. 첫 밴드는 0 에 붙여 두어야 배경이 안 빈다.
    while (trk.modes.length > 1 && trk.modes[1].t <= 0) trk.modes.shift();
    if (trk.modes.length) trk.modes[0].t = Math.max(0, trk.modes[0].t);
  }
}

/** 단 DOM 을 만든다. 그리기는 renderCharts() 가 매 폴마다 한다. */
function buildCharts() {
  const host = $('charts');
  const want = CHARTS.filter((c) => shownIds.has(c.id));
  if (!want.length) {
    host.innerHTML = '<div class="empty">볼 단을 오른쪽 위에서 고른다.</div>';
    return;
  }
  host.innerHTML = want.map((c) => `
    <div class="lchart">
      <!-- 계열 이름은 chart.js 가 축 머리말로 적고, 지금 값은 왼쪽 계기판이
           크게 말한다. 여기에 또 띄우면 같은 숫자가 화면에 두 번이다. -->
      <svg id="${c.id}"></svg>
      <div class="tip" id="tip-${c.id}"></div>
    </div>`).join('');
  for (const c of want) bindHover(c);
  renderCharts();
}

function buildToc() {
  $('toc').innerHTML = CHARTS.map((c) =>
    `<label class="${shownIds.has(c.id) ? 'on' : ''}" data-id="${c.id}">
       <input type="checkbox" ${shownIds.has(c.id) ? 'checked' : ''}>${c.title}</label>`).join('');
  $('toc').querySelectorAll('label').forEach((el) => {
    el.querySelector('input').onchange = (e) => {
      if (e.target.checked) shownIds.add(el.dataset.id); else shownIds.delete(el.dataset.id);
      el.classList.toggle('on', e.target.checked);
      buildCharts();
    };
  });
}

/** 마우스를 올린 지점에 세로 커서선을 세운다.
 *
 * 값 말풍선은 안 띄운다 — 지금 값은 왼쪽 계기판이 크게 말하고,
 * 없는 값까지 `전류 –A` 처럼 적어 두면 화면에 쓰레기만 는다. 커서선은
 * 남긴다: 여러 단을 세로로 훑을 때 같은 시각을 짚어 주는 것이 그 선이다.
 *
 * 흘러가는 화면이라 커서를 올린 동안에는 **그 시각을 붙잡아** 창을 멈춘다.
 */
function bindHover(c) {
  const el = $(c.id);
  const tip = $('tip-' + c.id);
  if (!el || el._bound) return;
  el._bound = true;

  const move = (e) => {
    const g = el._geom;
    if (!g || !trk.n) return;
    const r = el.getBoundingClientRect();
    // _geom.tAt 은 viewBox 좌표를 받는다. 화면 px → viewBox px 로 환산한다.
    const t = g.tAt((e.clientX - r.left) * (g.W / r.width));
    if (t < g.v0 || t > g.v1) { hide(); return; }
    const cur = el.querySelector('.cursor');
    if (cur) {
      cur.setAttribute('x1', g.x(t)); cur.setAttribute('x2', g.x(t));
      cur.style.display = '';
    }
    hoverT = t;                       // 흘러가는 것을 멈춘다 (renderCharts 가 읽는다)

    // 그 시각의 값. 🔴 **값이 있는 계열만** 적는다 — 배터리를 안 물린
    // 지상에서 `전류 –A` 같은 빈 줄이 뜨면 안 된다.
    if (!tip) return;
    const i = Math.max(0, Math.min(trk.n - 1, Math.round(t * trk.hz)));
    const rows = [];
    for (const sx of c.series) {
      const arr = trk[sx.key];
      const v = arr ? arr[i] : null;
      if (v == null || !isFinite(v)) continue;          // 없는 값은 안 적는다
      rows.push(`<div class="r"><span class="d" style="background:${sx.color}"></span>` +
                `<span class="n">${sx.label}</span><b>${(+v).toFixed(2)}</b>` +
                (sx.unit ? `<i>${sx.unit}</i>` : '') + '</div>');
    }
    if (!rows.length) { tip.style.opacity = '0'; return; }
    const ago = trk.dur - t;
    const md = modeAt(t);
    tip.innerHTML = `<div class="t">${ago < 1 ? '지금' : '-' + ago.toFixed(1) + 's'}` +
                    `${md ? ' · ' + md : ''}</div>` + rows.join('');
    tip.style.opacity = '1';

    // 커서 옆에 두되 단 밖으로 안 나가게 접는다.
    const sec = el.parentElement.getBoundingClientRect();
    const w = tip.offsetWidth, hh = tip.offsetHeight;
    let x = e.clientX - sec.left + 14;
    if (x + w > sec.width - 4) x = e.clientX - sec.left - 14 - w;
    let y = e.clientY - sec.top - hh - 12;
    if (y < 4) y = e.clientY - sec.top + 16;
    tip.style.left = Math.max(4, x) + 'px';
    tip.style.top = Math.max(4, Math.min(y, sec.height - hh - 4)) + 'px';
  };

  const hide = () => {
    if (tip) tip.style.opacity = '0';
    const cur = el.querySelector('.cursor');
    if (cur) cur.style.display = 'none';
    hoverT = null;
  };

  el.addEventListener('pointermove', move);
  el.addEventListener('pointerleave', hide);
}

/** 그 시각의 비행모드 이름. */
function modeAt(t) {
  let n = '';
  for (const m of trk.modes) { if (m.t <= t) n = m.name; else break; }
  return n;
}

function renderCharts() {
  if (!trk.n) return;
  // 보이는 구간 = 최근 winSec 초. 이 창이 오른쪽으로 밀리는 것이 곧 "흘러감" 이다.
  // 🔴 커서를 올린 동안에는 안 민다. 흘러가면 읽으려던 지점이 옆으로 도망가
  //    커서와 숫자가 서로 다른 시각을 가리킨다.
  if (hoverT != null) return;
  const t1 = trk.dur;
  const t0 = winSec > 0 ? Math.max(0, t1 - winSec) : 0;
  for (const c of CHARTS) {
    if (!shownIds.has(c.id)) continue;
    const el = $(c.id);
    if (!el) continue;
    drawChart(el, trk, {
      series: c.series, bands: true, thresholds: c.thresholds,
      bandTop: false,         // 단 꼭대기 색 띠 끔 — 아래 단 테두리처럼 보인다
      relTime: true,          // x축을 "몇 초 전" 으로
      view: { t0, t1: Math.max(t1, t0 + 1e-3) },
    });
  }
}

function dist(a, b) {
  const dlat = (b[0] - a[0]) * 111320;
  const dlon = (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
  return Math.hypot(dlat, dlon);
}
function bearing(from, to) {
  const R = Math.PI / 180;
  const p1 = from[0] * R, p2 = to[0] * R, dl = (to[1] - from[1]) * R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) * 180 / Math.PI);
}

// ── 렌더 ────────────────────────────────────────────────────────────
function render(s) {
  pollN++;
  const d = s.d || {};
  // ② 링크·프리즈·경고 만료 — 조기반환과 무관하게 항상 돈다.
  const changed = s.seq !== lastSeq;
  if (changed) { lastSeq = s.seq; lastSeqPoll = pollN; }
  const stall = (pollN - lastSeqPoll) * POLL_MS / 1000;

  // 링크 상태는 점 하나로 말한다 (우하단 바). 자세한 사정은 HUD 의 프리즈
  // 오버레이가 크게 적으므로 여기서 글자를 또 쓸 이유가 없다.
  // 색만으로는 색맹에게 안 보이니 title 에 같은 내용을 남긴다.
  const dot = $('dot');
  let lt, lc, frz = '';
  // 🔴 재생 중에는 링크를 말하지 않는다. 계기가 라이브와 똑같이 생겼으므로
  //    점이 초록으로 "링크 ON" 이라고 하면 지금 기체가 떠 있는 것으로 읽힌다.
  if (s.playback) { lt = '로그 재생'; lc = ''; }
  else if (!s.packets) { lt = '링크 없음'; lc = ''; }
  else if (!s.live) { lt = '링크 끊김'; lc = 'bad'; frz = `링크 끊김 · ${Math.round(s.age)}s`; }
  else if (stall >= 3) {
    lt = '데이터 정지'; lc = 'warn';
    frz = `데이터 정지 · ${stall.toFixed(0)}s (링크는 살아 있음)`;
  } else { lt = '링크 ON'; lc = 'live'; }
  if (dot.dataset.st !== lt) {          // 매 폴 DOM 을 건드리지 않는다
    dot.dataset.st = lt;
    dot.className = 'dot ' + lc;
    dot.title = lt;
  }
  show(h.freeze, !!frz);
  show(h.freezeTxt, !!frz);
  if (frz) setText(h.freezeTxt, frz);

  // 하단 바는 좁다. 송신 주소는 title 로 밀고 숫자만 남긴다.
  const stEl = $('stats');
  setText(stEl, s.playback
    // 재생은 패킷 수·바이트가 의미 없다. 몇 번째 프레임인지가 그 자리를 대신한다.
    ? `프레임 ${(s.i + 1).toLocaleString()}/${(s.n || 0).toLocaleString()}`
    : s.packets
    ? `${s.packets.toLocaleString()}pkt · ${(s.bytes / 1024).toFixed(0)}KB`
    : 'MAVLink 대기 중…');
  if (s.src && stEl.dataset.src !== s.src) {
    stEl.dataset.src = s.src;
    stEl.title = s.src;
  }

  // ── 차트 표본. 🔴 조기반환보다 **위**에 있어야 한다.
  //    시계열의 x축은 벽시계 시간이다 — 새 프레임이 없다고 표본을 건너뛰면
  //    링크가 끊긴 20초가 그래프에서 통째로 사라져, 끊긴 자국 없이 선이
  //    이어져 버린다 (실측: pollN 15 인데 trk.n 이 2 였다).
  //    값이 안 바뀐 폴은 같은 값이 한 칸 더 들어가고, 링크가 죽으면 아래
  //    pushSample 이 null 을 넣어 선이 끊긴다 — 둘 다 사실대로다.
  // 🔴 재생 중에는 한 칸씩 쌓지 않는다. pbFillCharts() 가 0..t 구간을 통째로
  //    다시 만들어 두었으므로, 여기서 또 밀어 넣으면 프레임마다 격자가 하나씩
  //    늘어 차트 시간축이 실제 로그의 두 배로 벌어진다.
  // 🔴 폴이 20Hz 라도 격자는 5Hz 다 — 매 폴 밀어 넣으면 시간축이 4배로 벌어진다.
  if (!s.playback && pollN % CHART_EVERY === 0) pushSample(s.live ? d : {});
  // 5Hz 로 단 3개를 전부 다시 그리면 초당 15회 SVG 재생성이다. 2.5Hz 로
  // 줄여 HUD 에 CPU 를 남긴다. 처음 몇 칸만 매번 그려 첫 화면이 안 빈다.
  if (trk.n < 4 || pollN % (CHART_EVERY * 2) === 0) renderCharts();

  // ③ 조기반환 — 여기부터는 새 데이터가 있을 때만.
  if (!changed) return;

  // ── 자세. 🔴 roll/pitch 에 CSS transition 이나 보간을 넣지 마라 —
  //    주 자세계에 100~200ms 지연이 생겨 계기가 과거를 보여준다.
  //    ⚠️ 폴 주기가 화면 갱신의 상한이다. 텔레메트리가 빨라도 폴이 5Hz 면
  //    화면은 5Hz 로 끊긴다 — 그래서 폴을 20Hz 로 둔다.
  const roll = d.roll || 0, pitch = d.pitch || 0;
  // 기수를 들면(pitch +) 수평선은 **아래로** 내려간다. 부호를 빼먹으면 계기가 거꾸로 돈다.
  const rt = `rotate(${(-roll).toFixed(2)})`, pt = `translate(0,${(pitch * PPD_PITCH).toFixed(1)})`;
  setAttr(h.bgRoll, 'transform', rt);
  setAttr(h.bgPitch, 'transform', pt);
  setAttr(h.roll, 'transform', rt);
  setAttr(h.pitch, 'transform', pt);
  setAttr(h.rollPtr, 'fill', Math.abs(roll) > 35 ? 'var(--warn)' : 'var(--c-spd)');

  // ── 대지속도 테이프. 눈금만 클램프하고 판독 박스는 진짜 숫자를 쓴다 —
  //    계기가 포화돼도 숫자는 절대 거짓이 안 된다.
  const gs = d.groundspeed;
  const gsC = clamp(gs == null ? 0 : gs, 0, 40);
  setAttr(h.spdSlide, 'transform', `translate(${TAPE_W},${(cy + gsC * PPU_SPD).toFixed(1)})`);
  setText(h.spdVal, fmt(gs));
  setAttr(h.spdBox, 'stroke', gs > 40 ? 'var(--warn)' : 'var(--c-spd)');

  // ── 고도 테이프
  const alt = d.alt;
  const altC = clamp(alt == null ? 0 : alt, -10, 120);
  setAttr(h.altSlide, 'transform', `translate(${W - TAPE_W},${(cy + altC * PPU_ALT).toFixed(1)})`);
  setText(h.altVal, fmt(alt));
  setAttr(h.altBox, 'stroke', (alt > 120 || alt < -10) ? 'var(--warn)' : 'var(--c-alt)');

  // ── VSI
  const cl = clamp(d.climb == null ? 0 : d.climb, -5, 5), ch = Math.abs(cl) * PPU_VSI;
  setAttr(h.vsi, 'y', cl >= 0 ? cy - ch : cy);
  setAttr(h.vsi, 'height', d.climb == null ? 0 : ch);

  // ── 기수 테이프. hdg 도 yaw 도 없으면 0 을 그리지 않는다 —
  //    가짜 0° 는 북쪽을 향한 것처럼 보인다.
  const hdgRaw = d.hdg != null ? d.hdg : d.yaw;
  const haveHdg = hdgRaw != null && isFinite(hdgRaw);
  const hh = haveHdg ? wrap360(hdgRaw) : 0;
  setAttr(h.hdgWrap, 'opacity', haveHdg ? 1 : .3);
  setAttr(h.hdgSlide, 'transform', `translate(${(cx - (hh + 360) * PPD_HDG).toFixed(1)},0)`);
  setText(h.hdgVal, haveHdg ? String(Math.round(hh) % 360).padStart(3, '0') : '—');
  setText(h.hdgSrc, !haveHdg ? '방위없음' : (d.hdg != null ? 'HDG' : 'YAW'));

  const halfWin = (W - 2 * TAPE_W) / 2 / PPD_HDG;
  // 🔴 edgeL/edgeR 은 코스 마커일 때 null 이다 — 숨기는 가지에서도 반드시 가드한다.
  //    가드가 없으면 gs<1.5 (정지·호버) 인 순간 show(null) 이 TypeError 를 던져
  //    render() 가 여기서 죽고 중앙 상태·스트립·상태밴드가 통째로 안 그려진다.
  const place = (node, edgeL, edgeR, deg) => {
    if (deg == null || !haveHdg) {
      show(node, false);
      if (edgeL) show(edgeL, false);
      if (edgeR) show(edgeR, false);
      return;
    }
    const dd = wrap180(deg - hh);
    const out = Math.abs(dd) > halfWin;
    show(node, !out);
    if (edgeL) show(edgeL, out && dd < 0);
    if (edgeR) show(edgeR, out && dd > 0);
    if (!out) setAttr(node, 'transform', `translate(${(cx + dd * PPD_HDG).toFixed(1)},0)`);
  };
  // 코스 마커 — 🔴 대기속도 센서가 없어 기수와 코스의 벌어짐이 바람에 밀리는
  // 각을 아는 유일한 수단이다. 호버에서 atan2 는 노이즈이므로 gs<1.5 면 숨긴다.
  const moving = gs != null && gs >= 1.5 && d.vx != null && d.vy != null;
  place(h.course, null, null, moving ? wrap360(Math.atan2(d.vy, d.vx) * 180 / Math.PI) : null);
  const pos = (d.lat != null && d.lon != null && (d.lat || d.lon)) ? [d.lat, d.lon] : null;
  place(h.homeBug, h.bugL, h.bugR, (s.home && pos) ? bearing(pos, s.home) : null);

  // ── 중앙 상태 블록
  // 🔴 ARMED 를 빨갛게 쓰지 않는다 — 지상 대기·정상 비행은 이상 상태가 아니고,
  //    매 비행마다 빨강을 보면 빨강의 의미가 닳는다 (색 예산).
  // 🔴 KILL 은 FC 가 직접 말해 준다 — 스위치 채널을 보고 짐작하지 않는다.
  //    HEARTBEAT.system_status 가 MAV_STATE_FLIGHT_TERMINATION(8) 이면 끊긴 것이다.
  //    CH9 의 PWM 을 보는 쪽은 "스위치가 눌렸나" 지 "모터가 죽었나" 가 아니다.
  //    (채널이 안 와서가 아니다 — rc_chan 은 CH1~16 이 다 온다. 질문이 다르다.
  //    페일세이프·FC 쪽 termination 은 스위치를 거치지 않는다.)
  const killed = d.system_status === 8;
  show(h.kill, killed);
  if (killed) setText(h.killTxt, 'EMERGENCY STOP');
  // arm·모드는 KILL 판에 자리를 내준다.
  show(h.arm, !killed);
  show(h.mode, !killed);

  const tail = d.landed === 2 ? ' · 공중' : d.landed === 1 ? ' · 지상' : '';
  setText(h.arm, d.armed ? 'ARMED' + tail : 'DISARMED');
  // 🔴 DISARMED 를 --muted(#6e7681) 로 두면 갈색 지면 위에서 거의 안 보인다.
  //    ARM 여부는 이 화면에서 가장 먼저 읽어야 하는 값이다 — 흐리게 둘 값이
  //    아니다. 대비는 글자색이 아니라 **굵기와 헤일로**로 준다.
  setAttr(h.arm, 'fill', d.armed ? 'var(--text)' : 'var(--dim)');
  setText(h.mode, d.mode || '—');


  // 붉은 한 줄. 🔴 만료를 m.t 로 판정하지 마라 — m.t 는 서버 시계이고 비교는
  //    브라우저 시계라, RTC 없는 Pi 나 NTP 미동기면 창이 영원히 안 열리거나 안 닫힌다.
  //    길이 비교도 쓰지 마라 — 서버가 messages[-40:] 슬라이딩 창을 준다.
  const msgs = s.messages || [];
  const keyOf = (m) => m.t + '|' + m.text;
  const newKey = msgs.length ? keyOf(msgs[msgs.length - 1]) : '';
  if (newKey !== lastMsgKey) {
    let start = 0;
    for (let i = msgs.length - 1; i >= 0; i--) if (keyOf(msgs[i]) === lastMsgKey) { start = i + 1; break; }
    const SEV = { EMERG: 1, ALERT: 1, CRIT: 1, ERROR: 1, WARN: 1 };
    for (let i = msgs.length - 1; i >= start; i--) {
      if (SEV[msgs[i].sev]) {
        warnText = msgs[i].text.slice(0, 48);
        warnKoText = warnKo(msgs[i].text);
        warnUntil = pollN + 15000 / POLL_MS;
        break;
      }
    }
    lastMsgKey = newKey;
  }
  const crit = d.system_status === 6 ? 'FC 상태 CRITICAL'
    : d.system_status === 7 ? 'FC 상태 EMERGENCY' : '';
  const warnStr = crit || (pollN < warnUntil ? warnText : '');
  const koStr = crit ? '' : (pollN < warnUntil ? warnKoText : '');
  setText(h.warn, warnStr);
  setText(h.warnKo, koStr);
  show(h.warnBg, !!warnStr);          // 글자 없을 때 빈 판이 떠 있으면 안 된다
  // 한글 줄이 있으면 판을 그만큼 키운다 — 글자가 판 밖으로 나가면 사다리에 묻힌다.
  h.warnBg.setAttribute('height', koStr ? 44 : 26);
  // 점멸은 우선순위 상위 하나에만 — 동시에 여럿 깜빡이면 아무것도 안 튄다.
  // KILL 이 사슬의 맨 위다. 모터가 끊긴 것보다 급한 상태는 없다.
  h.kill.classList.toggle('blink', killed);
  h.warn.classList.toggle('blink', !killed && !!crit);

  // ── HUD 아래 한 줄. 전류밴드·상태밴드·숫자스트립 3층을 통합했다.
  //    비행 중 곁눈질로 읽는 값만 남긴다 — 나머지는 우측 차트에 있다.
  //
  // 🔴 색 예산은 그대로다: 평소엔 전부 무채색이고, 색이 보이는 것 자체가 신호다.
  //    (--c-cur 이 --bad 와 같은 #f85149 라 그걸 기본색으로 쓰면 정상
  //     비행 내내 새빨갛고 정작 한계 초과가 안 튄다.)
  const sc = (id, cls) => { const e = $(id); if (e) e.className = 'sc' + (cls ? ' ' + cls : ''); };

  // 모터 연속 14 A × 4 = 56 A (docs/design/01) 를 넘으면 빨강, 그 7할(40 A)에서 노랑.
  setText($('st-cur'), fmt(d.cur));
  sc('sc-cur', d.cur > 56 ? 'bad' : d.cur > 40 ? 'warn' : '');

  setText($('st-batt'), d.batt_pct != null ? String(d.batt_pct) : '—');
  sc('sc-batt', d.batt_pct != null && d.batt_pct < 20 ? 'bad'
    : d.batt_pct != null && d.batt_pct < 35 ? 'warn' : '');

  // 배터리 온도는 계기판이 아니라 HUD 좌측 하단에 겹쳐 둔다 — 평소 볼 일이
  // 없고 뜨거워질 때만 눈에 들어오면 되는 값이라, 계기판 칸을 하나 쓰기에는
  // 아깝다. 리튬 배터리는 45도를 넘으면 수명이 급히 깎이고 60도는 위험이다.
  // 값이 없으면 0.0 을 찍는다. 배터리를 뽑으면 BATTERY_STATUS 가 발행되지
  // 않아 이 칸이 비는데, 자리를 감췄다 되살리면 HUD 구석이 깜빡여 오히려
  // 눈에 걸린다. 0.0 은 실제 온도로 읽힐 수 없는 값이라 "아직 안 온다" 로
  // 통한다.
  const bt = $('hudTemp');
  const t = d.batt_temp;
  setText(bt, (t == null ? 0 : t).toFixed(1) + '°C');
  bt.className = t == null ? '' : t > 60 ? 'bad' : t > 45 ? 'warn' : '';


  setText($('st-spd'), fmt(d.groundspeed));
  setText($('st-alt'), fmt(d.alt));

  // 위성은 개수와 fix 를 같이 본다 — 8기라도 fix 가 없으면 위치는 없다.
  setText($('st-sats'), d.sats != null ? String(d.sats) : '—');
  sc('sc-sats', d.fix != null && d.fix < 3 ? 'bad' : (d.sats != null && d.sats < 8) ? 'warn' : '');

  // eph — fix 가 3D 를 유지한 채 이 값이 먼저 부푸는 것이 위치 열화의 첫 징후다.
  // 1m 넘으면 노랑, 3m 넘으면 빨강. 🔶 미검증 — 이 기체 실비행 평소값이 아직 없다.
  setText($('st-eph'), d.eph != null ? d.eph.toFixed(2) : '—');
  sc('sc-eph', d.eph != null && d.eph > 3 ? 'bad' : d.eph != null && d.eph > 1 ? 'warn' : '');

  // 모터 4개를 **기체 형상 위에** 그린다. 절대값보다 **넷이 서로 비슷한가**
  // 가 판정이라, 부하를 원의 크기·밝기로 주고 튄 놈에만 색을 얹는다.
  renderMotors(d.motors || {});

  renderMap(s);
}

// ── 지도 ────────────────────────────────────────────────────────────
// HUD 는 자세를 말하지만 **어디 있는지**를 말하지 않는다. 비행 중 위치 감이
// 안 잡힌다는 것이 이 칸이 생긴 이유다.
//
// 로그 뷰어(log.html)와 **같은 Leaflet·같은 타일**을 쓴다 — 지난 비행과 지금
// 비행을 같은 그림으로 읽어야 눈이 안 흔들린다.
//
// 🔴 항적은 **증분으로** 받는다. 예전에 `?track=0` 으로 아예 안 받았던 이유가
//    "40분 비행이면 폴마다 수백 KB" 였는데, 서버는 `since=` 로 그 뒤의 점만
//    주는 길을 이미 갖고 있다 (`snapshot(since, want_track)`). 매 폴 몇 개씩만
//    받으므로 대역폭 문제가 없다.
const MAX_ZOOM = 20;
// 🔴 기본 줌 — "50m 급".
//    지도 칸이 좁고(실측 155px) 세로로 길어(455px) 가로·세로 배율이 크게
//    다르다. 실측 (위도 35.18, 155×455px):
//
//      z19   가로 37.8m · 세로 110.9m
//      z18   가로 75.6m · 세로 221.8m
//
//    가로 기준 50m 에 가까운 것은 z19 다. z18 은 50m 를 훌쩍 넘어 기체가
//    점처럼 작아진다. **가까이 보는 쪽을 택했다** — 이 계기의 목적이
//    "지금 어디 있나" 이지 "전체 경로 조망" 이 아니기 때문이다.
//    전체를 보고 싶으면 손으로 줌아웃하면 된다 — 확대·축소는 따라가기를
//    멈추지 않으므로 축척만 바뀐 채 기체를 계속 따라간다.
//
//    ⚠️ Esri 위성은 z18 까지만 실제 타일을 준다 — z19 는 마지막 타일을
//    확대한 것이라 흐리다. 궤적·기체 아이콘은 벡터라 선명하다.
// 🔴 지도 칸이 우측 넓은 칸이라 같은 z19 에서 가로 실거리가
//    74m → 115m 로 늘었다. 한 단 올려 "화면 가로 100m 이내" 규칙을 지킨다.
const ZOOM_50M = 20;
// 🔴 위성 사진만 쓴다. OSM 은 흰 바탕이라 어두운 계기판 옆에서
//    그 칸만 밝게 튀고, 비행장에서는 활주로·장애물이 지도보다 사진에 더 잘
//    보인다. 전환 버튼도 없앴다 — 좁은 칸에서 버튼이 궤적을 가린다.
let lmap = null, tiles = {};
let trkLine = null, acMarker = null, homeMarker = null;
// [[lat, lon, t], ...] — t 는 **받은 시각**(초, performance 기준).
// 🔴 서버가 주는 점에는 시각이 없다([lat,lon,alt]). 시간 창으로 자르려면
//    시각이 필요하므로 받은 순간을 여기서 붙인다. 서버가 한 번에 여러 개를
//    보내면(첫 연결·재동기) 그 묶음은 같은 시각을 갖는다 — 창 경계에서
//    몇 초 어긋날 수 있지만, 지도는 "대략 어디를 돌았나" 를 보는 계기다.
// 상한 — 차트 버퍼(KEEP_N, 1시간치)와 뜻을 맞춘다. 지도 점은 움직여야
// 쌓이므로(서버 TRACK_MIN_MOVE) 차트보다 훨씬 성기다. 넉넉히 잡는다.
const TRACK_KEEP = 20000;
let trkPts = [];
let trkHave = 0;          // 서버 기준 지금까지 받은 점 개수
let mapReady = false;
// 🔴 따라가기는 **항상 켜져 있다**. 토글 버튼을 없앴다 —
//    비행 중에 기체가 화면 밖으로 나가 있는 상태가 정상일 이유가 없고,
//    좁은 칸에서 버튼 하나가 계기 자리를 먹는다.
//    다만 손으로 지도를 끌어 주변을 볼 수는 있어야 하므로, 드래그하면
//    잠시 멈췄다가 스스로 돌아온다. 되돌릴 버튼이 없으니 **자동 복귀가
//    없으면 기체를 영영 놓친다.**
const FOLLOW_RESUME_MS = 8000;
let followPausedAt = 0;
// 재생 중이면 시간 창의 기준 시각. 라이브면 null(= 지금). 재생 항적의 시각은
// 로그 초이고 라이브는 unix 초라, "지금" 을 그대로 쓰면 재생 항적이 전부 잘린다.
let trkNowRef = null;

function initMap() {
  if (lmap || typeof L === 'undefined') return;
  const box = $('lmap');
  if (!box) return;
  // 🔴 자체검사는 iframe 을 24개 띄운다. 그 각각이 외부 타일을 받으러 가면
  //    검사가 끝나지 않는다 (실측: 180초를 줘도 "검사 중…"). `?notiles=1` 로
  //    타일만 끈다 — 지도·마커·궤적·레이아웃은 그대로 검사된다.
  const noTiles = new URLSearchParams(location.search).has('notiles');
  // 🔴 +/− 버튼을 안 붙인다. 칸이 좁아 버튼이 궤적을 가리고,
  //    줌은 기본값(50m 급)이 맞춰져 있어 평소 건드릴 일이 없다.
  //    필요하면 휠·핀치로 조절된다 — scrollWheelZoom 은 그대로 살아 있다.
  lmap = L.map(box, { zoomControl: false, attributionControl: true });
  // 🔴 레이어를 붙이기 전에 뷰를 반드시 정한다 — 뷰 없는 지도에 Path 를 넣으면
  //    Leaflet 이 _bounds 없는 상태로 _clipPoints 를 돌려 터진다 (log.html 과 같은 함정).
  lmap.setView([36.5, 127.8], 6);
  // maxNativeZoom: Esri 는 없는 타일을 404 가 아니라 안내 이미지로 200 을 준다.
  // 그 너머는 마지막 타일을 확대해 쓴다 — 흐릿할 뿐 궤적 벡터는 선명하다.
  tiles.sat = L.tileLayer(
    'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: MAX_ZOOM, maxNativeZoom: 18, attribution: 'Esri World Imagery' });
  if (!noTiles) tiles.sat.addTo(lmap);


  // 손으로 끌면 8초간 멈춘다 — 보려던 곳에서 곧바로 튕겨 나가면 못 쓴다.
  // 그 뒤에는 스스로 기체로 돌아온다 (버튼이 없으므로 자동 복귀가 유일한 길이다).
  // ⚠️ dragstart 만 본다. zoomstart 를 같이 걸면 첫 좌표에서 부르는
  //    setView 자체가 zoom 이벤트를 내 곧바로 8초 정지에 걸린다.
  //    확대·축소는 중심을 안 바꾸므로 따라가기와 부딪히지도 않는다.
  lmap.on('dragstart', () => { followPausedAt = Date.now(); });
  trkLine = L.polyline([], { color: '#58a6ff', weight: 2, opacity: .9 }).addTo(lmap);
  // 자체검사·현장 디버깅이 줌·실거리·궤적 길이를 물어볼 수 있게 남긴다.
  // "50m 급" 이나 "시간 창을 따라간다" 같은 주장은 숫자로 확인돼야 한다.
  window.__lmap = lmap;
  window.__trkLine = trkLine;
  window.drawTrack = drawTrack;
  window.__trkPtsLen = () => trkPts.length;
  window.__trkPtsRaw = () => trkPts;
  mapReady = true;
}

// 기체 아이콘 — 기수 방향으로 돈다. divIcon 이라 CSS transform 하나로 끝난다.
function acIcon(hdg) {
  return L.divIcon({
    className: '', iconSize: [22, 22], iconAnchor: [11, 11],
    html: `<svg width="22" height="22" viewBox="0 0 22 22"
             style="transform:rotate(${(hdg || 0).toFixed(0)}deg)">
             <polygon points="11,2 17,19 11,15 5,19" fill="#f0f6fc"
                      stroke="#0d1117" stroke-width="1.2"/></svg>`,
  });
}

// ── ADS-B: 주변 유인기 ───────────────────────────────────────────────
// 🔴 **웹(drone01.bewe.co.kr) 전용이다.** 로컬 트래커(:4410)는 인터넷이 없는
//    현장에서 쓰는 화면이라 외부 API 를 부르지 않는다. `/api/adsb` 가 404 면
//    조용히 꺼진다 — 콘솔을 더럽히거나 재시도를 반복하지 않는다.
//
// ⚠️ 데이터 반경은 서버가 30nm 로 잡는다. 10km 로 좁히면 실측 0기다
//    (창원은 순항 트래픽 위주). 홈 10km 원은 아래에서 따로 그린다.
const ADSB_MS = 15000;
let adsbLayer = null, adsbMarks = new Map(), adsbTimer = null, adsbOff = false;
let homeRing = null;

function adsbIcon(trk, ground) {
  const c = ground ? '#8b949e' : '#ffd866';
  return L.divIcon({
    className: '', iconSize: [18, 18], iconAnchor: [9, 9],
    html: `<svg width="18" height="18" viewBox="0 0 18 18"
             style="transform:rotate(${(trk || 0).toFixed(0)}deg)">
             <polygon points="9,1 13,14 9,11 5,14" fill="${c}"
                      stroke="#0d1117" stroke-width="1.1"/></svg>`,
  });
}

/** 호버 한 줄. 편명이 없으면 hex 로 대신한다 (군용기·미등록기가 그렇다). */
function adsbTip(a) {
  const name = a.call || a.hex || '?';
  const alt = a.ground ? '지상'
            : (a.alt == null ? '고도 ?' : `${a.alt.toLocaleString()} ft`);
  const bits = [`<b>${name}</b>`, alt];
  if (a.type) bits.push(a.type);
  if (a.gs != null) bits.push(`${Math.round(a.gs)} kt`);
  if (a.dst != null) bits.push(`${a.dst.toFixed(1)} NM`);
  return bits.join(' · ');
}

async function adsbTick() {
  if (adsbOff || !lmap) return;
  let d;
  try {
    const r = await fetch('/api/adsb', { cache: 'no-store' });
    // 로컬 트래커에는 이 라우트가 없다. 한 번 404 면 영구히 끈다.
    if (r.status === 404) { adsbOff = true; return; }
    if (!r.ok) return;                       // 일시 오류는 다음 주기에 다시 본다
    d = await r.json();
  } catch { return; }                        // 오프라인이면 조용히 넘긴다
  if (!d || !Array.isArray(d.ac)) return;

  if (!adsbLayer) adsbLayer = L.layerGroup().addTo(lmap);
  const seen = new Set();
  for (const a of d.ac) {
    if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon)) continue;
    seen.add(a.hex);
    let m = adsbMarks.get(a.hex);
    if (!m) {
      m = L.marker([a.lat, a.lon], { icon: adsbIcon(a.trk, a.ground) })
            .bindTooltip(adsbTip(a), { direction: 'top', offset: [0, -10] });
      m.addTo(adsbLayer);
      adsbMarks.set(a.hex, m);
    } else {
      m.setLatLng([a.lat, a.lon]);
      m.setIcon(adsbIcon(a.trk, a.ground));
      m.setTooltipContent(adsbTip(a));
    }
  }
  // 사라진 기체는 지운다 — 안 지우면 유령이 화면에 쌓인다.
  for (const [hex, m] of adsbMarks) {
    if (!seen.has(hex)) { adsbLayer.removeLayer(m); adsbMarks.delete(hex); }
  }
  checkTraffic(d.ac, homeMarker ? [homeMarker.getLatLng().lat, homeMarker.getLatLng().lng] : null);
}

// ── 침범 경고 ────────────────────────────────────────────────────────
// 🔴 **두 가지를 본다.**
//   1) 유인기가 홈 반경 1km 안에 들어왔다 — 충돌 위험. 즉시 내려야 한다.
//   2) 우리 기체가 금지·제한·관제권 안으로 들어갔다 — 법 위반.
//
// ⚠️ 이 경고는 **참고**다. 공역 폴리곤은 정적 파일이라 NOTAM·임시 제한을
//    모른다 (tools/fetch_airspace.py 를 다시 돌려야 갱신된다). 경고가 없다고
//    안전한 것이 아니다 — 비행 전 드론원스톱 확인은 그대로 필요하다.
const HOME_RING_M = 1000;
let alertBox = null;
// key -> 화면에 띄울 문구. 비어 있으면 경고가 없다.
const alertMsg = new Map();

/** 두 좌표 사이 거리(m). 1km 판정이라 평면 근사로 충분하다. */
function distM(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dla = (b[0] - a[0]) * r, dlo = (b[1] - a[1]) * r;
  const m = Math.cos((a[0] + b[0]) / 2 * r);
  return R * Math.hypot(dla, dlo * m);
}

/** 점이 폴리곤 안인가 (ray casting). GeoJSON 은 [lon,lat] 순서다. */
function inRing(lon, lat, ring) {
  let ins = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat)
        && lon < (xj - xi) * (lat - yi) / ((yj - yi) || 1e-12) + xi) ins = !ins;
  }
  return ins;
}
function inGeom(lon, lat, g) {
  if (!g) return false;
  if (g.type === 'Polygon') return inRing(lon, lat, g.coordinates[0]);
  if (g.type === 'MultiPolygon') return g.coordinates.some(p => inRing(lon, lat, p[0]));
  return false;
}

function ensureAlertBox() {
  if (alertBox) return alertBox;
  alertBox = document.createElement('div');
  alertBox.id = 'zoneAlert';
  alertBox.hidden = true;
  document.body.appendChild(alertBox);
  return alertBox;
}

/** 🔴 문구가 실제로 바뀔 때만 DOM 을 건드린다. 매 틱 다시 그리면
 *  CSS 깜빡임 애니메이션이 처음부터 다시 시작해 글자를 못 읽는다. */
function setAlert(key, text) {
  const cur = alertMsg.get(key) || '';
  const next = text || '';
  if (cur === next) return;
  if (next) alertMsg.set(key, next); else alertMsg.delete(key);
  const box = ensureAlertBox();
  if (!alertMsg.size) { box.hidden = true; return; }
  box.innerHTML = [...alertMsg.values()]
    .map(t => `<div class="zaLine">${t}</div>`).join('');
  box.hidden = false;
}

/** 유인기가 홈 1km 안에 들어왔나. adsbTick 이 부른다. */
function checkTraffic(rows, home) {
  if (!Array.isArray(home) || home.length !== 2) return setAlert('traffic', '');
  const near = (rows || []).filter(a =>
    Number.isFinite(a.lat) && Number.isFinite(a.lon)
    && distM(home, [a.lat, a.lon]) <= HOME_RING_M);
  if (!near.length) return setAlert('traffic', '');
  const who = near.map(a => a.call || a.hex).join(', ');
  setAlert('traffic', `항공기 접근 · ${who}`);
}

/** 우리 기체가 규제 공역 안인가. renderMap 이 부른다. */
let zoneGeo = null;
function checkZone(pos) {
  if (!zoneGeo || !Array.isArray(pos)) return setAlert('zone', '');
  const hit = zoneGeo.features.find(f =>
    ZONE_SHOW.has(f.properties && f.properties.zone_type)
    && inGeom(pos[1], pos[0], f.geometry));
  if (!hit) return setAlert('zone', '');
  const p = hit.properties;
  setAlert('zone', `공역 침범 · ${p.zone_type} ${p.name || ''}`.trim());
}

// ── 공역: 비행금지·제한 구역 ──────────────────────────────────────────
// 출처는 VWorld(국토교통부 공간정보 오픈플랫폼) — 드론원스톱이 쓰는 바로 그
// 레이어다 (lt_c_aisprhc / lt_c_aisresc / lt_c_aisctrc …).
//
// 🔴 **정적 파일인 이유**: api.vworld.kr 이 CORS 헤더를 안 준다. 게다가 공역은
//    분기에 한 번 바뀔까 말까라 실시간으로 받을 이유가 없다. 갱신은
//    `tools/fetch_airspace.py` 를 다시 돌린다.
//
// 🔴 **금지·제한만 그린다**: 전국 255개를 전부 올리면 화면이 색으로 덮인다.
//    조종자가 "여기 날려도 되나" 를 묻는 데 필요한 것만 남긴다 —
//    금지/임시금지/제한/관제권. UA·드론존은 오히려 **날아도 되는** 곳이라 뺀다.
const ZONE_SHOW = new Set(['비행금지구역', '임시금지구역', '비행제한구역', '관제권']);
// 요청대로 **빨강 계열**로 통일하되 등급이 구분되게 명도만 나눈다.
const ZONE_COLOR = {
  '비행금지구역': '#ff2d2d',
  '임시금지구역': '#ff2d2d',
  '비행제한구역': '#ff6b3d',
  '관제권':       '#ff9aa2',
};
let zoneLayer = null;

async function loadAirspace() {
  if (zoneLayer || !lmap) return;
  let gj;
  try {
    const r = await fetch('/data/kr_airspace.geojson', { cache: 'force-cache' });
    if (!r.ok) return;                    // 로컬(:4410)엔 없다 — 조용히 넘긴다
    gj = await r.json();
  } catch { return; }
  if (!gj || !Array.isArray(gj.features)) return;

  zoneGeo = gj;                            // 침범 판정이 같은 데이터를 쓴다
  zoneLayer = L.geoJSON(gj, {
    filter: (f) => ZONE_SHOW.has(f.properties && f.properties.zone_type),
    style: (f) => {
      const t = f.properties.zone_type;
      const c = ZONE_COLOR[t] || '#ff2d2d';
      return {
        color: c, weight: t === '관제권' ? 1 : 1.6, opacity: .85,
        // 금지는 진하게, 관제권은 옅게 — 색만으로 등급이 읽혀야 한다.
        fillColor: c, fillOpacity: t === '관제권' ? .06 : .13,
      };
    },
    onEachFeature: (f, l) => {
      const p = f.properties || {};
      const alt = (p.lower || p.upper)
        ? `<br>${p.lower || '?'} ~ ${p.upper || '?'}` : '';
      l.bindTooltip(`<b>${p.zone_type || '공역'}</b><br>${p.name || ''}${alt}`,
                    { direction: 'top', sticky: true });
    },
  }).addTo(lmap);
  // 🔴 기체·궤적 아래로 내린다. 위에 있으면 반투명 면이 궤적을 덮고
  //    마우스 이벤트까지 가로챈다.
  zoneLayer.bringToBack();
}

/** 홈 1km 원. ADS-B 데이터 반경(30nm)과 무관한 **경고 기준선**이다. */
function drawHomeRing(home) {
  if (!lmap || !Array.isArray(home) || home.length !== 2) return;
  if (!homeRing) {
    homeRing = L.circle(home, {
      radius: HOME_RING_M, color: '#3fb950', weight: 1, opacity: .45,
      fill: false, dashArray: '6 6', interactive: false,
    }).addTo(lmap);
  } else homeRing.setLatLng(home);
}

function adsbStart() {
  if (adsbTimer || adsbOff) return;
  adsbTick();
  adsbTimer = setInterval(adsbTick, ADSB_MS);
}

// 🔴 **기체 상태와 무관하게 돈다.** 홈 마커 안에서 켜면 비행 중이 아닐 때
//    (홈 좌표가 없을 때) 영영 안 켜진다 — 실측으로 걸렸다. 주변 항공기는
//    우리가 날든 말든 봐야 하는 정보다.
// 🔴 initMap 안에서는 못 부른다. 위 `let adsbTimer` 가 그 시점엔 TDZ 라
//    ReferenceError 로 지도 전체가 죽는다 (실측 확인).
if (typeof window !== 'undefined') {
  const kick = () => {
    if (mapReady) { adsbStart(); loadAirspace(); } else setTimeout(kick, 500);
  };
  kick();
}

/** 시간 창 안의 점만 골라 궤적을 다시 그린다. winSec=0 이면 가진 것 전부. */
function drawTrack() {
  if (!trkLine) return;
  let pts = trkPts;
  if (winSec > 0 && trkPts.length) {
    // 기준은 **지금**이다. 마지막 점 기준으로 하면 링크가 끊겨 점이 안 들어올 때
    // 창이 그 자리에 얼어붙어 옛 궤적이 계속 남는다.
    const cut = (trkNowRef != null ? trkNowRef : Date.now() / 1000) - winSec;
    // 창 안 첫 점을 찾는다. 시각이 오름차순이라 뒤에서부터 훑으면 빠르다.
    let i = trkPts.length - 1;
    while (i > 0 && trkPts[i - 1][2] >= cut) i--;
    pts = trkPts.slice(i);
  }
  trkLine.setLatLngs(pts.map((p) => [p[0], p[1]]));
}

function renderMap(s) {
  if (!mapReady) initMap();
  if (!mapReady) return;
  const d = s.d || {};

  // 항적 증분. track_from 이 0 이면 "처음부터 다시" 라는 뜻이다(서버 주석).
  // 🔴 재생은 빈 배열이라도 갈아끼운다 — 로그 초반(항적 0점)에 라이브 항적이
  //    남아 있으면 로그 위에 실내 표류 꼬리가 파란 선으로 보인다.
  trkNowRef = s.playback ? (typeof s.pos === 'number' ? s.pos : 0) : null;
  if (Array.isArray(s.track) && (s.track.length || s.playback)) {
    const now = Date.now() / 1000;
    if (s.track_from === 0 || s.playback) trkPts = [];
    for (const p of s.track) {
      // 서버는 [lat, lon, alt, t] 로 준다. 유한한 값만 쓴다.
      const la = Array.isArray(p) ? p[0] : p && p.lat;
      const lo = Array.isArray(p) ? p[1] : p && p.lon;
      // 🔴 시각은 **서버가 준 것**을 쓴다 (p[3], unix 초). 받은 시각을 붙이면
      //    새로고침 때 5533점이 한 묶음으로 와서 전부 같은 시각이 되고,
      //    시간 창이 하나도 못 자른다. 옛 서버가 시각을
      //    안 주면 지금 시각으로 떨어뜨린다 — 그때는 안 잘리지만 안 깨진다.
      const ts = (Array.isArray(p) && typeof p[3] === 'number') ? p[3] : now;
      if (typeof la === 'number' && typeof lo === 'number'
          && isFinite(la) && isFinite(lo)) trkPts.push([la, lo, ts]);
    }
    // 무한히 자라지 않게. 차트 버퍼(KEEP_N = 1시간치)와 같은 한도를 쓴다 —
    // "전체" 가 두 계기에서 다른 길이를 뜻하면 안 된다.
    if (trkPts.length > TRACK_KEEP) trkPts.splice(0, trkPts.length - TRACK_KEEP);
  }
  // 🔴 차트의 시간 창(1분/3분/10분/전체)과 **같은 구간**을 그린다.
  //    지도만 전체를 그리면 "차트는 1분인데 지도는 20분" 이라 두 계기가
  //    서로 다른 시간을 말한다.
  drawTrack();
  if (typeof s.track_n === 'number') trkHave = s.track_n;

  const pos = (typeof d.lat === 'number' && typeof d.lon === 'number'
               && isFinite(d.lat) && isFinite(d.lon)
               && (d.lat !== 0 || d.lon !== 0)) ? [d.lat, d.lon] : null;

  const empty = $('mapEmpty');
  if (empty) empty.hidden = !!pos;
  // 좌표를 잃으면 공역 경고도 내린다 — 어디 있는지 모르면서 침범을 주장할 수 없다.
  if (!pos) { setAlert('zone', ''); return; }

  const hdg = (typeof d.hdg === 'number') ? d.hdg : (d.yaw || 0);
  if (!acMarker) acMarker = L.marker(pos, { icon: acIcon(hdg) }).addTo(lmap);
  else { acMarker.setLatLng(pos); acMarker.setIcon(acIcon(hdg)); }

  // 홈(H). RTL 이 그리로 가므로 어디인지 보여야 한다.
  if (Array.isArray(s.home) && s.home.length === 2) {
    if (!homeMarker) {
      homeMarker = L.marker(s.home, { icon: L.divIcon({
        className: '', iconSize: [16, 16], iconAnchor: [8, 8],
        html: '<div style="width:16px;height:16px;border-radius:50%;'
            + 'background:rgba(63,185,80,.25);border:1.5px solid #3fb950;'
            + 'color:#3fb950;font:700 10px/13px ui-monospace;text-align:center">H</div>',
      }) }).addTo(lmap);
    } else homeMarker.setLatLng(s.home);
    drawHomeRing(s.home);
  }
  checkZone(pos);

  // 🔴 좌표를 처음 받으면 그 자리로 **중심을 잡고 50m 급으로 확대**한다.
  //    실내·실외를 가리지 않는다 — fix 가 잡히기만 하면 거기가 중심이다.
  //    (실내에서도 GPS 가 3D fix 를 주면 오차가 크더라도 대략의 자리는 맞고,
  //     빈 판을 보는 것보다 낫다.)
  if (!renderMap._zoomed) { lmap.setView(pos, ZOOM_50M); renderMap._zoomed = true; }
  else if (Date.now() - followPausedAt > FOLLOW_RESUME_MS) {
    lmap.panTo(pos, { animate: false });
  }
}

// ── 모터: 기체 형상 위의 넷 ─────────────────────────────────────────
// 🔴 이 기체 배치에 묶여 있다: MAIN1/2/3/4 = 우전/우후/좌후/좌전 (실측).
//    서버(drone_live.py)가 그 매핑으로 LF/RF/LB/RB 를
//    만들어 보내므로 여기서는 이름 그대로 자리에 꽂는다.
//
// 왜 그림인가 — 숫자 넷을 2×2 로 놓으면 "48 과 41 중 어느 쪽이 어느 팔인가"
// 를 매번 머리로 옮겨야 한다. 기수가 위인 X 형상에 얹으면 그 변환이 사라진다.
//
// 무엇을 보이나 — 두 가지가 겹쳐 있다:
//   1. **절대 부하**: 원의 반지름과 채움 밝기. 무채색이라 색 예산을 안 쓴다.
//      넷이 다 같이 커지는 것은 무겁거나 바람이 세다는 뜻이지 이상이 아니다.
//   2. **치우침**: 편차가 벌어졌을 때 **최대·최소인 놈만** 색을 받는다.
//      한쪽만 무리하는 것이 무게중심·프롭 손상·모터 열화의 첫 신호다.
const MOTORS = ['LF', 'RF', 'LB', 'RB'];
// 🔶 실비행 전 — 아래 임계는 전부 이 기체 실비행으로 아직 검증하지 않았다.
// 편차 임계. 20%p 면 "기체가 한쪽을 억지로 붙들고 있다" 로 읽는다.
const SPREAD_WARN = 10, SPREAD_BAD = 20;
// 🔴 개별 모터 부하 임계. 이 기체 호버는 약 54%(MOT_THST_HOVER=0.540,
//    components/fc/pixhawk-2.4.8/README.md) 라 70% 는 "여유가 줄기 시작했다",
//    80% 는 "여유가 얼마 안 남았다" 다.
const MOT_WARN = 70, MOT_BAD = 80;
// 평균 임계. 넷이 다 같이 호버(54%)보다 11%p·21%p 위면 기체 전체의 추력 여유가 준다.
const MAVG_WARN = 65, MAVG_BAD = 75;

function renderMotors(mt) {
  // render() 의 sc 는 그 함수 안의 지역 상수다 — 여기서는 안 보인다.
  // 같은 규칙(className 을 통째로 다시 씀)을 그대로 쓴다.
  const sc = (id, cls) => { const e = $(id); if (e) e.className = 'sc' + (cls ? ' ' + cls : ''); };
  const vals = MOTORS.map((k) => mt[k]).filter((v) => v != null);
  const has = vals.length > 0;
  const spread = has ? Math.max(...vals) - Math.min(...vals) : null;
  const avg = has ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

  // 편차 등급 — 오른쪽 숫자 칸이 이 색으로 경고한다. 로터 색과는 별개다.
  const lvl = spread == null ? '' : spread > SPREAD_BAD ? 'bad'
            : spread > SPREAD_WARN ? 'warn' : '';

  for (const k of MOTORS) {
    const v = mt[k];
    const rot = $('rot-' + k), arm = $('arm-' + k), txt = $('mv-' + k);
    if (!rot) continue;
    if (v == null) {
      // 값이 없어도 자리는 남긴다 — 사라지면 "모터가 없다" 로 오독된다.
      rot.setAttribute('r', 18);
      rot.style.fill = ''; arm.style.strokeWidth = '';
      rot.classList.remove('warn', 'bad'); arm.classList.remove('warn', 'bad');
      txt.classList.remove('warn', 'bad');
      setText(txt, '—');
      continue;
    }
    // 🔴 크기는 **비행에 쓰는 구간만** 편다. 0~100% 를 그대로 반지름에
    //    걸면 실제로 오가는 55~75% 구간이 반지름 2~3px 차이라 눈에 안 띈다.
    //    40~90% 를 반지름 9~22 로 펴서 그 구간의 차이를 크게 만든다.
    //    (하한·상한 밖은 잘라 붙인다 — 원이 사라지거나 칸을 넘지 않게.)
    const f = Math.max(0, Math.min(1, (v - 40) / 50));
    // viewBox 가 280×100 이라 반지름도 그 스케일이다.
    rot.setAttribute('r', (13 + f * 12).toFixed(1));
    // 밝기로도 부하를 준다. 평소엔 무채색 회색조라 색 예산을 안 쓴다 —
    // 14%(어두움) ~ 66%(밝음) 사이를 오간다.
    // 임계를 넘으면 채움도 그 색조로 옮겨간다. 테두리만 칠하면 작은 화면에서
    // 눈에 안 걸린다 — 다만 채도를 낮게 둬서 원 안 숫자가 계속 읽힌다.
    const L = 14 + f * 52;
    rot.style.fill = v >= MOT_BAD ? `hsl(3 42% ${(L * 0.62).toFixed(0)}%)`
                   : v >= MOT_WARN ? `hsl(38 40% ${(L * 0.60).toFixed(0)}%)`
                   : `hsl(210 9% ${L.toFixed(0)}%)`;
    // 팔은 부하에 비례해 굵어진다. 그림을 곁눈질할 때 먼저 잡히는 신호다.
    arm.style.strokeWidth = (5 + f * 8).toFixed(1);
    // 🔴 색은 **그 모터 자신의 부하**가 정한다 — 70%↑ 노랑, 80%↑ 빨강.
    //    편차로 칠하던 것을 걷어냈다: 한 로터가 상황마다 다른 이유로
    //    칠해지면 색의 뜻이 흔들린다. 편차는 오른쪽 숫자 칸이 경고한다.
    const ml = v >= MOT_BAD ? 'bad' : v >= MOT_WARN ? 'warn' : '';
    rot.classList.toggle('warn', ml === 'warn');
    rot.classList.toggle('bad',  ml === 'bad');
    arm.classList.toggle('warn', ml === 'warn');
    arm.classList.toggle('bad',  ml === 'bad');
    txt.classList.toggle('warn', ml === 'warn');
    txt.classList.toggle('bad',  ml === 'bad');
    setText(txt, v.toFixed(0));
  }

  setText($('st-mspread'), spread == null ? '—' : spread.toFixed(1));
  sc('sc-mspread', lvl);
  setText($('st-mavg'), avg == null ? '—' : avg.toFixed(0));
  // 평균은 "얼마나 힘든가" 다.
  sc('sc-mavg', avg == null ? '' : avg > MAVG_BAD ? 'bad' : avg > MAVG_WARN ? 'warn' : '');
}

// ── 데모 피드 ───────────────────────────────────────────────────────
// FC 없이는 종횡비·이음매·클리핑을 현장에서야 발견하는데, 이 페이지의 검증
// 실패 비용은 비행 중이다. ?demo=1 로 합성 값을 5Hz 로 먹인다.
function demoState(n) {
  const q = new URLSearchParams(location.search);
  const t = n / 5;
  const fx = (k, v) => (q.has(k) ? parseFloat(q.get(k)) : v);
  const hdg = fx('hdg', wrap360(t * 24));
  const gs = fx('gs', 12 + 11 * Math.sin(t / 7));
  return {
    live: true, seq: n, age: 0, packets: n * 5, bytes: n * 300, src: 'demo',
    // 항적 — 지도를 데모로 검증하려면 점이 있어야 한다. 기체 좌표와 같은
    // 원을 그리므로 궤적 위에 아이콘이 얹힌다.
    // 서버와 같은 [lat, lon, alt] 형식. 매 폴 전량을 주되 track_from=0 이라
    // 프론트가 "처음부터 다시" 로 받는다 — 데모는 짧아서 그래도 된다.
    track_n: n, track_from: 0,
    track: Array.from({ length: Math.min(n, 120) }, (_, i) => {
      const u = (n - Math.min(n, 120) + i) / 5;
      return [35.181 + Math.sin(u / 20) * 3e-4, 128.554 + Math.cos(u / 20) * 3e-4, 45];
    }),
    home: [35.181, 128.554],   // 실제 비행장 — 위성 타일이 의미 있게 보인다
    messages: n > 25 && n < 40 ? [{ t: 1757000000, sev: 'CRIT', text: 'demo: PreArm: Compass not calibrated' }] : [],
    d: {
      armed: (n % 300) > 60, landed: (n % 300) > 100 ? 2 : 1,
      mode: fx('auto', 0) ? 'AUTO' : 'LOITER',
      // ?sys=8 로 비상정지 화면을 띄운다 — 자체검사가 그렇게 확인한다.
      system_status: fx('sys', 4),
      lat: 35.181 + Math.sin(t / 20) * 3e-4, lon: 128.554 + Math.cos(t / 20) * 3e-4,
           alt: fx('alt', 45 + 40 * Math.sin(t / 9)),
      vx: Math.cos(t / 7) * gs, vy: Math.sin(t / 7) * gs,
      groundspeed: gs, climb: 3 * Math.cos(t / 9), hdg, yaw: hdg,
      roll: fx('roll', 55 * Math.sin(t / 5)), pitch: fx('pitch', 22 * Math.sin(t / 6.5)),
      thr: 54, load: 41,
      volt: fx('volt', 15.6), cur: fx('cur', 20 + 12 * Math.sin(t / 11)),
      batt_pct: 63,
      fix: 3, sats: 14, eph: 0.8,
      vibe: [8.5, 9.1, 14.4], ekf_ratio: { vel: 0.3 },
      // 모터 — 형상 계기를 데모로 검증하려면 값이 있어야 한다.
      // 기본은 호버(MOT_THST_HOVER≈0.54) 근처에 편차 몇 %p.
      // ?spread=N 으로 편차를 강제해 자체검사가 색·크기를 실측한다.
      motors: (() => {
        const sp = fx('spread', 4);              // 최대−최소 %p
        const base = fx('mavg', 54);             // 평균 %
        const w = Math.sin(t / 3) * 1.5;         // 살아 있게 흔든다
        return { LF: base + sp / 2 + w, RF: base + sp / 6 - w,
                 LB: base - sp / 6 + w, RB: base - sp / 2 - w };
      })(),
    },
  };
}

// ── 로그 재생 ───────────────────────────────────────────────────────
// 같은 계기·같은 차트로 지난 비행을 돌려 본다. 서버가 `.BIN` 를 라이브와
// **같은 모양**(`d`)으로 구워 주므로, 여기서는 시각만 옮기면 된다.
//
// 🔴 재생 중에는 실시간 폴을 멈춘다. 같은 계기에 두 시각이 섞이면 그림이
//    거짓말이 된다 — 로그의 고도와 지금 기체의 전압이 한 화면에 뜨는 식.
const ulpb = {
  on: false,          // 재생 모드인가
  playing: false,
  t: 0,               // 재생 시각 (초)
  dur: 0,
  rate: 1,
  name: '',
  series: null,       // 차트용 전량 시계열
  msgs: [],
  timer: null,
  last: 0,            // 마지막 tick 의 벽시계 (performance.now)
  seeking: false,     // 슬라이더를 잡고 있는 동안 자동 진행을 멈춘다
};

function mmss(s) {
  s = Math.max(0, Math.round(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

/** 차트 버퍼를 재생 시각까지 **다시 만든다**.
 *
 * 🔴 라이브는 폴 한 번이 격자 한 칸이라 앞으로만 쌓이지만, 재생은 되감을 수
 *    있다. 커서를 뒤로 옮겼는데 차트가 그대로면 그림과 계기가 다른 시각을
 *    가리킨다 — 그래서 매번 0..t 구간으로 잘라 새로 채운다. 서버가 전량을
 *    한 번에 줬으므로 자르기만 하면 된다 (네트워크 왕복 없음).
 */
function pbFillCharts() {
  const s = ulpb.series;
  if (!s) return;
  const upto = Math.max(1, Math.min(s.n, Math.round(ulpb.t * s.hz) + 1));
  for (const k of Object.keys(trk)) {
    if (Array.isArray(trk[k]) && k !== 'modes' && k !== 'events') delete trk[k];
  }
  for (const k in s.cols) trk[k] = s.cols[k].slice(0, upto);
  trk.n = upto;
  trk.dur = (upto - 1) / s.hz;
  trk.hz = s.hz;
  trk.modes = s.modes.filter((m) => m.t <= trk.dur)
    .map((m) => ({ t: m.t, name: m.name }));
  if (!trk.modes.length && s.modes.length) {
    trk.modes = [{ t: 0, name: s.modes[0].name }];
  }
  trk.events = [];
}

async function pbRender() {
  try {
    const r = await fetch('/api/playback/state?t=' + ulpb.t.toFixed(2), { cache: 'no-store' });
    if (!r.ok) return;
    const s = await r.json();
    pbFillCharts();
    render(s);
  } catch (e) { /* 서버가 죽으면 다음 tick 에서 다시 해 본다 */ }
  $('pbTime').textContent = mmss(ulpb.t) + ' / ' + mmss(ulpb.dur);
  if (!ulpb.seeking) {
    $('pbSeek').value = String(ulpb.dur ? Math.round(ulpb.t / ulpb.dur * 1000) : 0);
  }
}

function pbTick() {
  const now = performance.now();
  const dt = (now - ulpb.last) / 1000;
  ulpb.last = now;
  if (ulpb.playing && !ulpb.seeking) {
    ulpb.t += dt * ulpb.rate;
    if (ulpb.t >= ulpb.dur) { ulpb.t = ulpb.dur; pbPause(); }
  }
  pbRender();
}

function pbPlay() {
  if (ulpb.t >= ulpb.dur) ulpb.t = 0;      // 끝에서 누르면 처음부터
  ulpb.playing = true;
  ulpb.last = performance.now();
  $('pbPlay').textContent = '❚❚';
}
function pbPause() {
  ulpb.playing = false;
  $('pbPlay').textContent = '▶';
}

async function pbStart(name) {
  $('pbList').innerHTML = '<div class="msg">' + name + ' 여는 중… (큰 로그는 수십 초)</div>';
  const r = await fetch('/api/playback/open?name=' + encodeURIComponent(name), { cache: 'no-store' });
  if (!r.ok) {
    $('pbList').innerHTML = '<div class="msg">열지 못했다.</div>';
    return;
  }
  // 굽는 동안 기다린다. 큰 로그는 수십 초 걸린다 — 진행을 글로 알린다.
  for (;;) {
    await new Promise((z) => setTimeout(z, 400));
    const info = await (await fetch('/api/playback/info', { cache: 'no-store' })).json();
    if (info.state === 'ready') {
      ulpb.on = true; ulpb.t = 0; ulpb.dur = info.dur; ulpb.name = info.name;
      ulpb.series = await (await fetch('/api/playback/series', { cache: 'no-store' })).json();
      document.body.classList.add('playback');
      $('pbBar').hidden = false;
      $('pbPick').hidden = true;
      $('pbName').textContent = info.name;
      $('pbSeek').value = '0';
      lastMode = null;
      pbPlay();
      if (ulpb.timer) clearInterval(ulpb.timer);
      // 재생은 로그 격자(5Hz)에 물려 있다. 화면 폴 주기와 무관하게 200ms 다.
      ulpb.timer = setInterval(pbTick, 1000 / CHART_HZ);
      return;
    }
    if (info.state === 'error') {
      $('pbList').innerHTML = '<div class="msg">읽을 수 없다: ' + (info.error || '') + '</div>';
      return;
    }
  }
}

function pbExit() {
  ulpb.on = false;
  pbPause();
  if (ulpb.timer) { clearInterval(ulpb.timer); ulpb.timer = null; }
  fetch('/api/playback/close').catch(() => {});
  document.body.classList.remove('playback');
  $('pbBar').hidden = true;
  // 차트를 비우고 실시간으로 돌아간다 — 로그의 꼬리가 남아 있으면
  // 지금 비행의 그래프가 로그에서 이어진 것처럼 보인다.
  for (const k of Object.keys(trk)) {
    if (Array.isArray(trk[k]) && k !== 'modes' && k !== 'events') delete trk[k];
  }
  trk.n = 0; trk.dur = 0; trk.modes = []; trk.events = []; trk.hz = HZ;
  lastMode = null;
  poll();                    // 멈춰 있던 실시간 폴을 다시 돈다
}

/** 재생 목록 — FC 로그(.BIN)만. 이름과 크기 한 줄씩.
 *
 * 🔴 **두 서버가 같은 경로에 다른 모양을 준다.**
 *      로컬 drone_live.py : {logs:[...], error}
 *      웹   server.js   : [...]   ← 웹 목록 페이지의 카탈로그
 *    웹서버 쪽 모양은 목록 페이지도 쓰므로 바꾸지 않고 여기서 받아 준다.
 */
async function pbShowPicker() {
  $('pbPick').hidden = false;
  $('pbList').innerHTML = '<div class="msg">불러오는 중…</div>';

  const logs = await fetch('/api/logs', { cache: 'no-store' })
    .then((r) => r.json()).catch(() => null);
  const rows = Array.isArray(logs) ? logs : (logs && logs.logs) || [];
  if (!rows.length) {
    $('pbList').innerHTML = '<div class="msg">' + ((logs && logs.error) || '재생할 것이 없다.') + '</div>';
    return;
  }

  const box = document.createElement('div');
  for (const e of rows) {
    const row = document.createElement('div');
    row.className = 'row';
    const nm = document.createElement('span');
    nm.className = 'nm';
    nm.textContent = e.name;
    row.appendChild(nm);
    if (e.size != null) {
      const r = document.createElement('span');
      r.className = 'wh';
      r.textContent = (e.size / 1e6).toFixed(1) + 'MB';
      row.appendChild(r);
    }
    row.onclick = () => pbStart(e.name);
    box.appendChild(row);
  }
  $('pbList').replaceChildren(box);
}

// ── 폴 루프 ─────────────────────────────────────────────────────────
// setInterval 이 아니라 꼬리물기다. 서버가 느려도 요청이 쌓이지 않는다.
const DEMO = new URLSearchParams(location.search).has('demo');
let demoN = 0;

async function poll() {
  // 재생 중에는 실시간을 긁지 않는다. pbTick 이 화면을 그린다.
  if (ulpb.on) return;
  if (DEMO) {
    // 🔴 demoState 의 시간축은 5Hz 폴 카운트로 짜여 있다 (n % 300 = 60초 등).
    //    폴을 20Hz 로 올리면서 그대로 두면 데모가 4배 빨리 흘러, 자체검사가
    //    2.6초에 보는 화면이 달라진다 (실측: 「Preflight Fail」 경고창이 미리
    //    떠서 「정상 상태에 경고색 0건」이 FAIL 났다). 벽시계로 환산해 넘긴다.
    render(demoState(Math.floor(demoN++ * POLL_MS / (1000 / CHART_HZ))));
    setTimeout(poll, POLL_MS);
    return;
  }
  try {
    // 🔴 항적은 **증분으로** 받는다. 예전에는 `track=0` 으로 아예 안 받았다 — 지도가 없었고, 전량을 받으면
    //    40분 비행에서 폴마다 수백 KB 였기 때문이다. 서버는 `since=` 로 그 뒤의
    //    점만 주는 길을 이미 갖고 있어(`snapshot(since, want_track)`), 매 폴
    //    몇 개씩만 오간다. 전량을 다시 받는 것은 서버가 track_from=0 을
    //    보낼 때뿐이다("처음부터 다시").
    const r = await fetch(API_STATE + '?since=' + trkHave, { cache: 'no-store' });
    if (r.ok) render(await r.json());
  } catch (e) {
    // 서버가 죽었을 때도 점으로 말한다 — 깜빡이는 빨강.
    const dot = $('dot');
    dot.dataset.st = '서버 없음';
    dot.className = 'dot bad';
    dot.title = ON_WEB ? '웹서버에 못 닿는다' : '서버 없음 — drone_live.py 가 안 떠 있다';
    setText($('stats'), '서버 없음');
  }
  setTimeout(poll, POLL_MS);
}

// ── 기동 ────────────────────────────────────────────────────────────
// 🔴 웹과 로컬은 **UI 가 완전히 같아야 한다.** 랩서버도 같은 drone_live.py 로
//    재생을 서비스하므로(server.js 가 /api/playback/* 을 :4411 로 넘긴다)
//    웹에서도 그대로 재생된다.
//
//    남는 차이는 **목록에 뜨는 파일**뿐이다 — 웹은 랩서버의 .BIN, 로컬은
//    그 PC 가 가진 것. 조작·배치·버튼은 한 벌이다.
if (ON_WEB) document.documentElement.classList.add('on-web');

buildHUD();
resolveColors();      // 반드시 buildCharts 앞에 — 범례·선이 같은 색을 쓴다
buildToc();
buildCharts();

// 🔴 콜백에서 즉시 계산하지 말고 rAF 로 한 번만 예약 — 드래그 중 프레임마다
//    콜백이 오고, 콜백이 관찰 대상 크기를 바꾸면 'ResizeObserver loop' 가 터진다.
let lpend = false;
const doLayout = () => {
  const r = $('hudBox').getBoundingClientRect();
  if (r.width > 0 && r.height > 0) layout(Math.round(r.width), Math.round(r.height));
};
new ResizeObserver(() => {
  if (lpend) return;
  lpend = true;
  requestAnimationFrame(() => { lpend = false; doLayout(); });
}).observe($('hudBox'));
doLayout();

$('win').onchange = (e) => { winSec = +e.target.value; renderCharts(); drawTrack(); };

// ── 재생 조작 ───────────────────────────────────────────────────────
$('pbOpen').onclick = pbShowPicker;
$('pbPickClose').onclick = () => { $('pbPick').hidden = true; };
$('pbPick').onclick = (e) => { if (e.target === $('pbPick')) $('pbPick').hidden = true; };
$('pbPlay').onclick = () => (ulpb.playing ? pbPause() : pbPlay());
$('pbExit').onclick = pbExit;
$('pbRate').onchange = (e) => { ulpb.rate = +e.target.value; };

// 슬라이더: 잡는 동안 자동 진행을 멈추고, 놓으면 그 지점부터 이어 간다.
// 🔴 input 마다 서버를 때리면 드래그 중 요청이 쌓인다 — 좌표만 바꾸고
//    그리기는 tick 에 맡긴다 (tick 이 200ms 마다 돈다).
$('pbSeek').oninput = (e) => {
  ulpb.seeking = true;
  ulpb.t = ulpb.dur * (+e.target.value / 1000);
  $('pbTime').textContent = mmss(ulpb.t) + ' / ' + mmss(ulpb.dur);
};
$('pbSeek').onchange = () => { ulpb.seeking = false; ulpb.last = performance.now(); };

// space 로 재생/정지. 입력칸에 있을 때는 가로채지 않는다.
addEventListener('keydown', (e) => {
  if (!ulpb.on || e.target.matches('input,select,button,textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); ulpb.playing ? pbPause() : pbPlay(); }
  else if (e.code === 'ArrowLeft') { ulpb.t = Math.max(0, ulpb.t - 5); pbRender(); }
  else if (e.code === 'ArrowRight') { ulpb.t = Math.min(ulpb.dur, ulpb.t + 5); pbRender(); }
});

// 기동은 마지막이다 — 위의 const 선언이 전부 초기화된 뒤라야 한다.
poll();
