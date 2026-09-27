// 시간축 차트. SVG 문자열을 만들어 innerHTML 에 한 번에 넣는다 —
// Lab_Main 의 drawAirconChart(), bewe.co.kr 의 UPS 차트와 같은 관용구다.
// 라이브러리를 쓰지 않는 이유는 이 집의 다른 서비스와 같다: 외부 의존 0.
//
// 모든 차트가 **같은 균일 격자**(extract.py 가 만든 5Hz)를 쓰므로
// x 좌표 계산이 하나뿐이고, 커서 인덱스는 i = round(t * hz) 산술로 구해진다.

'use strict';

// 3열 격자라 칸이 좁다. 축 라벨을 폭에 맞춰 줄인다 — 고정 46px 이면
// 좁은 칸에서 그림 영역이 거의 안 남는다.
function pad(W) {
  const l = W < 420 ? 30 : 40;
  // 좌우 여백을 **항상 같게** 잡는다. 우축 유무로 r 을 바꾸면 단마다 iw 가
  // 달라져 같은 t 가 다른 px 에 찍힌다 — 커서·이벤트선이 단 사이에서 어긋난다.
  // 우축이 없는 단은 그 여백이 빌 뿐이고, 시간축 정렬이 훨씬 중요하다.
  return { l, r: l, t: 20, b: 16 };   // t: 축 머리말 한 줄이 들어갈 자리
}

function niceScale(values, opts = {}) {
  const fin = [];
  for (const v of values) {
    if (v == null || !isFinite(v)) continue;
    fin.push(v);
  }
  if (!fin.length) return null;                     // 유효값이 하나도 없다
  let lo = Math.min(...fin.length > 65536 ? fin.slice(0, 65536) : fin);
  let hi = Math.max(...fin.length > 65536 ? fin.slice(0, 65536) : fin);
  // 한 샘플짜리 스파이크가 축을 통째로 삼키는 것을 막는다. 자이로 한 순간의
  // 손상값(관측: 1.4e8 °/s)이 들어오면 실제 ±20°/s 대의 움직임이 0 선에
  // 눌려 아무것도 못 읽는다. 그래서 축은 **본문 분포**로 잡는다.
  //   - 분포의 0.5~99.5 백분위를 기준으로 하고
  //   - 그 폭의 여유를 둔 범위 안에 드는 실제 최소/최대까지는 그대로 담는다
  // 스파이크는 잘라내지 않는다 — 선은 축 밖으로 나가며 clip 되고, 값이
  // 튀었다는 사실은 툴팁과 통계에 그대로 남는다.
  if (fin.length >= 20) {
    const srt = Float64Array.from(fin).sort();
    const q = (p) => srt[Math.min(srt.length - 1, Math.max(0,
                     Math.round(p * (srt.length - 1))))];
    const qlo = q(0.005), qhi = q(0.995);
    const iqr = qhi - qlo;
    if (iqr > 1e-9) {
      // 본문 범위의 3배까지는 정상 변동으로 보고 담는다. 그 밖은 이상치.
      const flo = qlo - iqr * 3, fhi = qhi + iqr * 3;
      if (lo < flo || hi > fhi) {
        let nlo = Infinity, nhi = -Infinity;
        for (const v of fin) {
          if (v < flo || v > fhi) continue;
          if (v < nlo) nlo = v;
          if (v > nhi) nhi = v;
        }
        if (nlo !== Infinity) { lo = nlo; hi = nhi; }
      }
    }
  }
  if (opts.min != null) lo = Math.min(lo, opts.min);
  if (opts.max != null) hi = Math.max(hi, opts.max);

  // 🔴 최소 표시 폭. 이게 없으면 축이 노이즈를 화면 가득 확대한다 —
  //    지상 정지 중 상승률 ±0.001 m/s 가 산맥처럼 그려지고 y축 눈금은
  //    `0 / -0 / 0` 이 되어 아무 의미가 없다.
  //    값이 실제로 그만큼 안 움직이면 **평평하게 보이는 것이 사실이다.**
  //    단위마다 "이 정도는 움직여야 의미가 있다" 가 달라 호출자가 정한다.
  const span = hi - lo;
  const minSpan = opts.minSpan || 0;
  if (minSpan > 0 && span < minSpan) {
    const mid = (hi + lo) / 2;
    lo = mid - minSpan / 2;
    hi = mid + minSpan / 2;
    // 음수가 없는 양(전류·속도·위성·진동)은 축을 0 밑으로 내리지 않는다.
    // -5.4A 눈금은 물리적으로 없는 값이라 읽는 사람을 헷갈리게 한다.
    // 0 에 붙이고 폭은 그대로 유지한다.
    if (opts.nonNeg && lo < 0) { lo = 0; hi = minSpan; }
  } else if (span < 1e-9) {
    hi = lo + 1; lo -= 1;                          // 완전히 평평한 계열
  }
  const pad = (hi - lo) * 0.08;
  // 여백까지 더하면 0 아래로 다시 내려간다 — 전류 -0.8A 눈금이 그렇게 생겼다.
  // 음수가 없는 양은 바닥을 0 에 붙인 채 위로만 여백을 준다.
  const flo = (opts.nonNeg && lo - pad < 0 && lo >= 0) ? 0 : lo - pad;
  return { lo: flo, hi: hi + pad };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * 한 단을 그린다.
 *   el     : <svg>
 *   trk    : extract.py 의 trk (hz, n, 채널 배열들)
 *   spec   : { series:[{key,color,label,unit,axis}], bands, events, thresholds }
 */
function drawChart(el, trk, spec) {
  const W = el.clientWidth || 900;
  const H = el.clientHeight || 120;
  el.setAttribute('viewBox', `0 0 ${W} ${H}`);
  el.setAttribute('preserveAspectRatio', 'none');

  const PAD = pad(W);
  const dur = trk.dur || (trk.n - 1) / trk.hz;
  // 보이는 시간 구간. 휠 줌이 이걸 좁히고, 드래그가 옮긴다.
  const v0 = spec.view ? spec.view.t0 : 0;
  const v1 = spec.view ? spec.view.t1 : dur;
  const span = Math.max(v1 - v0, 1e-6);
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (t) => PAD.l + ((t - v0) / span) * iw;
  const xi = (i) => x(i / trk.hz);
  // 화면 밖 좌표는 잘라낸다. 안 그러면 확대할수록 path 좌표가 거대해진다.
  const clipId = 'clip-' + (el.id || 'c');

  // 좌/우 축을 각각 자기 계열들로 스케일한다
  const scales = {};
  for (const ax of ['left', 'right']) {
    const keys = spec.series.filter((s) => (s.axis || 'left') === ax).map((s) => s.key);
    if (!keys.length) continue;
    // 확대하면 그 구간의 값 범위로 y 축도 다시 잡는다 — 안 그러면
    // 좁은 구간의 변화가 전체 범위에 눌려 평평한 선으로 보인다.
    const i0 = Math.max(0, Math.floor(v0 * trk.hz));
    const i1 = Math.min(trk.n - 1, Math.ceil(v1 * trk.hz));
    const vals = [];
    for (const k of keys) {
      const arr = trk[k] || [];
      for (let i = i0; i <= i1 && i < arr.length; i++) vals.push(arr[i]);
    }
    const extra = {};
    if (ax === 'left' && spec.thresholds) {
      for (const th of spec.thresholds) extra.max = Math.max(extra.max ?? -Infinity, th.v);
    }
    // 그 축에 실린 계열들이 요구하는 최소 폭 중 가장 큰 것을 쓴다.
    for (const sx of spec.series) {
      if ((sx.axis || 'left') !== ax) continue;
      if (sx.minSpan) extra.minSpan = Math.max(extra.minSpan || 0, sx.minSpan);
      if (sx.nonNeg) extra.nonNeg = true;
    }
    scales[ax] = niceScale(vals, extra);
  }
  const y = (v, ax) => {
    const s = scales[ax || 'left'];
    return PAD.t + (1 - (v - s.lo) / (s.hi - s.lo)) * ih;
  };

  // clip 은 **그림만** 감싼다. 축 눈금까지 넣으면 PAD 영역에 그린 라벨이
  // 통째로 잘려 y축 숫자가 사라진다.
  let svg = `<defs><clipPath id="${clipId}"><rect x="${PAD.l}" y="${PAD.t}"
             width="${iw}" height="${ih}"/></clipPath></defs>`;
  let plot = '', bands = '';

  // ── 비행모드 밴드 (배경) ────────────────────────────────────────
  if (spec.bands && trk.modes && trk.modes.length) {
    for (let i = 0; i < trk.modes.length; i++) {
      const a = trk.modes[i].t;
      const b = i + 1 < trk.modes.length ? trk.modes[i + 1].t : dur;
      // .055 는 다크 배경에서 채널당 최대 11 차이라 사실상 안 보인다. 본체는
      // 조금 올리고, 실제 구분은 위쪽 색 띠가 한다 — 어두운 모드색(AUTO·STAB)은
      // 알파를 올릴수록 배경에 묻히므로 알파만으로는 못 살린다.
      const bx = x(a).toFixed(1), bw = Math.max(0, x(b) - x(a)).toFixed(1);
      const bc = modeColor(trk.modes[i].name);
      bands += `<rect x="${bx}" y="${PAD.t}" width="${bw}"
              height="${ih}" fill="${bc}" opacity=".10"/>`;
      // 단 꼭대기의 3px 색 띠. 로그 뷰어에서는 모드 경계를 짚어 주지만,
      // 라이브처럼 단이 세로로 붙어 쌓이면 **아래 단의 테두리처럼** 보여
      // 차트마다 진한 선이 그어진 것으로 읽힌다. spec.bandTop 으로 끈다.
      if (spec.bandTop !== false) {
        bands += `<rect x="${bx}" y="${PAD.t}" width="${bw}"
                height="3" fill="${bc}" opacity=".85"/>`;
      }
      // 라벨은 보이는 영역 안쪽에 붙인다 — 확대해서 밴드 시작이 왼쪽 밖으로
      // 나가도 이름이 보여야 한다.
      const lx = Math.max(x(a) + 4, PAD.l + 4);
      // 라벨은 요청한 단에만. 12단 전부에 찍으면 화면이 모드 이름으로 뒤덮인다.
      // 고정 30px 게이트는 AUTO_TAKEOFF(≈59px) 같은 긴 이름을 통과시켜 옆 밴드
      // 라벨 위에 겹쳐 찍혔다. 대문자 ASCII 폭으로 어림잡아 안 들어가면 생략한다.
      const lw = trk.modes[i].name.length * 9 * 0.62;
      if (spec.bandLabels && Math.min(x(b), W - PAD.r) - lx > lw + 4) {
        bands += `<text x="${lx.toFixed(1)}" y="${PAD.t + 11}" fill="#8b949e"
                font-size="9">${esc(trk.modes[i].name)}</text>`;
      }
    }
  }

  // 밴드는 배경이므로 격자보다 먼저 깐다. clip 은 각각 걸어 준다.
  // ── 착륙(접지) 구간 ──────────────────────────────────────────────
  // 접지 뒤에도 EKF 는 값을 낸다. 지면효과로 고도가 몇 십 cm 올라가고 상승률이
  // +로 뒤집히는데, 표시가 없으면 "착륙 직전에 다시 떴다" 로 읽힌다.
  for (const [a, b] of trk.landed_spans || []) {
    if (b < v0 || a > v1) continue;
    bands += `<rect x="${x(a).toFixed(1)}" y="${PAD.t}"
            width="${Math.max(0, x(b) - x(a)).toFixed(1)}" height="${ih}"
            fill="#8b949e" opacity=".18"/>`;
    bands += `<line x1="${x(a).toFixed(1)}" y1="${PAD.t}" x2="${x(a).toFixed(1)}"
            y2="${PAD.t + ih}" stroke="#8b949e" stroke-width="1"
            stroke-dasharray="3 2" opacity=".7"/>`;
    if (x(b) - x(a) > 34) {
      bands += `<text x="${(x(a) + 4).toFixed(1)}" y="${PAD.t + ih - 4}"
              fill="#8b949e" font-size="9">착륙</text>`;
    }
  }

  // ── 0 기준선 ────────────────────────────────────────────────────
  // 부호가 뜻을 갖는 축(상승률·자세·각속도)에서 0 이 어디인지 안 보이면
  // 오르는 중인지 내리는 중인지 선 모양만으로는 못 읽는다.
  for (const ax of ['left', 'right']) {
    const sc = scales[ax];
    if (!sc || sc.lo >= 0 || sc.hi <= 0) continue;   // 0 이 범위 안에 있을 때만
    const zy = y(0, ax).toFixed(1);
    bands += `<line x1="${PAD.l}" y1="${zy}" x2="${(W - PAD.r).toFixed(1)}" y2="${zy}"
            stroke="#8b949e" stroke-width="1" stroke-dasharray="2 3" opacity=".35"/>`;
  }

  svg += `<g clip-path="url(#${clipId})">${bands}</g>`;

  // ── 격자 + y 눈금 ───────────────────────────────────────────────
  const NY = H < 200 ? 2 : 3;
  for (let i = 0; i <= NY; i++) {
    const gy = PAD.t + (i / NY) * ih;
    svg += `<line x1="${PAD.l}" y1="${gy.toFixed(1)}" x2="${W - PAD.r}" y2="${gy.toFixed(1)}"
            stroke="#21262d" stroke-dasharray="3 3"/>`;
    for (const [ax, anchor, tx] of [['left', 'end', PAD.l - 5], ['right', 'start', W - PAD.r + 5]]) {
      const s = scales[ax];
      if (!s) continue;
      const v = s.hi - (i / NY) * (s.hi - s.lo);
      const col = (spec.series.find((q) => (q.axis || 'left') === ax) || {}).color || '#6e7681';
      svg += `<text x="${tx}" y="${(gy + 3).toFixed(1)}" fill="${col}" font-size="9"
              text-anchor="${anchor}">${fmtTick(v)}</text>`;
    }
  }

  // ── 축 머리말 — 그 축에 실린 계열 이름 ─────────────────────────
  // 좌·우 축의 눈금 숫자만으로는 어느 숫자가 어느 계열인지 알 수 없다.
  // 축 꼭대기에 그 축의 계열 이름을 그 색으로 적어 둔다.
  for (const [ax, anchorTx, tx] of [['left', 'start', PAD.l],
                                    ['right', 'end', W - PAD.r]]) {
    // scales[ax] 가 없어도 머리말은 그린다 — 그 축 계열을 전부 숨긴 상태이고,
    // 이름이 사라지면 다시 켤 방법이 없어진다.
    // 점선(목표) 계열도 넣는다. 빼면 그 선은 이름도 없고 끌 수도 없다.
    const own = (spec.caption || spec.series)
                  .filter((q) => (q.axis || 'left') === ax);
    if (!own.length) continue;
    // 계열마다 <tspan> 을 따로 두어 클릭으로 숨기는 기능을 그대로 살린다.
    // 상한은 그 축의 계열 수에 맞춘다 — 자르면 잘린 계열은 다시 켤 수 없다.
    // 모터(5)·센서불일치(6) 처럼 많은 단만 3개로 접는다.
    const CAP = own.length <= 4 ? 4 : 3;
    const show = own.slice(0, CAP);
    const parts = show.map((q, n) =>
      `<tspan class="k${q.hidden ? ' off' : ''}" data-key="${q.key}"
              fill="${q.hidden ? '#6e7681' : q.color}"
              style="cursor:pointer">${esc(q.label)}</tspan>`
      + (n < show.length - 1 ? '<tspan fill="#6e7681"> · </tspan>' : ''));
    if (own.length > CAP) parts.push('<tspan fill="#6e7681"> …</tspan>');
    svg += `<text x="${tx}" y="${PAD.t - 7}" font-size="11" font-weight="600"
            text-anchor="${anchorTx}">${parts.join('')}</text>`;
  }

  // ── 임계선 (전류 45A/90A 같은 것) ───────────────────────────────
  for (const th of (spec.thresholds || [])) {
    if (!scales.left || th.v > scales.left.hi || th.v < scales.left.lo) continue;
    const gy = y(th.v, 'left');
    plot += `<line x1="${PAD.l}" y1="${gy.toFixed(1)}" x2="${W - PAD.r}" y2="${gy.toFixed(1)}"
            stroke="${th.color}" stroke-width="1" stroke-dasharray="5 4" opacity=".75"/>`;
    // 오른쪽 축 눈금과 겹치지 않게 안쪽에 붙인다. 임계값이 축 꼭대기 근처면
    // 모드 밴드 라벨(PAD.t+11) 줄과 부딪치므로 그때만 선 아래로 내린다.
    const ly = (spec.bandLabels && gy - 4 < PAD.t + 15) ? gy + 11 : gy - 4;
    plot += `<text x="${W - PAD.r - 8}" y="${ly.toFixed(1)}" fill="${th.color}"
            font-size="9" text-anchor="end">${esc(th.label)}</text>`;
  }

  // ── 계열 ────────────────────────────────────────────────────────
  for (const s of spec.series) {
    const arr = trk[s.key];
    if (!arr || !scales[s.axis || 'left']) continue;
    // null 이 섞이면 선을 끊는다. 이어 그리면 없는 데이터를 지어내는 셈이다.
    let d = '', pen = false;
    const from = Math.max(0, Math.floor(v0 * trk.hz) - 1);
    const to = Math.min(arr.length - 1, Math.ceil(v1 * trk.hz) + 1);
    for (let i = from; i <= to; i++) {
      const v = arr[i];
      if (v == null || !isFinite(v)) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${xi(i).toFixed(1)},${y(v, s.axis).toFixed(1)}`;
      pen = true;
    }
    if (d) {
      // 주 계열(굵게)과 보조 계열(가늘고 옅게)을 나눈다. 모터 4선이 전류를
      // 덮어버리면 45A 초과 여부를 못 읽는다 — 정작 그게 보려는 값이다.
      const w = s.weight || 1.4;
      const op = s.dim ? 0.55 : 1;
      // 목표값은 점선으로 — 실측과 같은 축에 겹치므로 선 종류로 구분한다
      const dash = s.dash ? ' stroke-dasharray="4 3"' : '';
      plot += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${w}"
              opacity="${op}"${dash} stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`;
    }
  }

  // ── FC 메시지 눈금 (경고 이상만) ────────────────────────────────
  if (spec.events && trk.events) {
    for (const e of trk.events) {
      if (e.lvl > 4 || e.t < 0 || e.t > dur) continue;
      const col = e.lvl <= 3 ? '#f85149' : '#d29922';
      plot += `<line x1="${x(e.t).toFixed(1)}" y1="${PAD.t}" x2="${x(e.t).toFixed(1)}"
              y2="${PAD.t + ih}" stroke="${col}" stroke-width="1" opacity=".55"/>`;
    }
  }

  svg += `<g clip-path="url(#${clipId})">${plot}</g>`;

  // ── x 눈금 ──────────────────────────────────────────────────────
  // 기본은 로그 시각(0s = 로그 시작). spec.relTime 이면 **지금으로부터 얼마 전**
  // 으로 적는다 — 라이브 화면은 "몇 초째" 보다 "몇 초 전" 이 읽는 값이다.
  const NX = W < 420 ? 3 : 4;
  for (let i = 0; i <= NX; i++) {
    const t = v0 + (i / NX) * span;
    const anchor = i === 0 ? 'start' : i === NX ? 'end' : 'middle';
    let lbl;
    if (spec.relTime) {
      const ago = dur - t;
      // 분 단위로 반올림하면 3분 창에서 -2m 이 두 번 나온다. 눈금이 서로
      // 달라야 시간축 구실을 하므로 소수 한 자리를 남긴다.
      if (ago < 1) lbl = '지금';
      else if (ago < 90) lbl = '-' + ago.toFixed(0) + 's';
      else {
        const m = ago / 60;
        lbl = '-' + (m < 10 ? m.toFixed(1) : m.toFixed(0)) + 'm';
      }
    } else {
      lbl = t.toFixed(0) + 's';
    }
    svg += `<text x="${x(t).toFixed(1)}" y="${H - 4}" fill="#6e7681" font-size="9"
            text-anchor="${anchor}">${lbl}</text>`;
  }

  // ── 커서 (재생 위치) ────────────────────────────────────────────
  svg += `<line class="cursor" x1="0" y1="${PAD.t}" x2="0" y2="${PAD.t + ih}"
          stroke="#e6edf3" stroke-width="1" opacity=".85" style="display:none"/>`;

  el.innerHTML = svg;
  el._geom = { x, xi, W, H, dur, PAD, v0, v1, span,
               // 화면 x(px) → 로그 시각(s)
               tAt: (px) => v0 + ((px - PAD.l) / iw) * span };
  return el._geom;
}

function fmtTick(v) {
  const a = Math.abs(v);
  const s = a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : v.toFixed(2);
  // -0.00 / -0 은 값이 아니라 부동소수 찌꺼기다. 눈금에 뜨면 읽는 사람이
  // 무슨 뜻인지 되짚게 된다 (실측: 상승률 축 가운데가 늘 '-0' 이었다).
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

// ArduCopter 모드 색. 자동 계열(AUTO·GUIDED·RTL·LAND·SMART_RTL)을 한 보라로
// 묶는다 — "조종자가 개입할 수 없는 구간" 이 한 덩어리로 보인다.
const MODE_COLORS = {
  STABILIZE: '#0033cc', ACRO: '#66cc00', ALT_HOLD: '#eecc00',
  LOITER: '#00cc33', POSHOLD: '#00cc33', BRAKE: '#00cccc',
  AUTO: '#6600cc', GUIDED: '#6600cc', RTL: '#6600cc', SMART_RTL: '#6600cc', LAND: '#6600cc',
};
function modeColorLookup(name) {
  const n = String(name).replace(/~$/, '');       // 추정 표시 제거
  return MODE_COLORS[n] || '#6e7681';
}
const modeColor = modeColorLookup;

/** 모든 차트의 커서를 t 초 위치로 옮긴다. */
function moveCursors(svgs, t) {
  for (const el of svgs) {
    const g = el._geom;
    const c = el.querySelector('.cursor');
    if (!g || !c) continue;
    // 보이는 구간 밖이면 커서를 숨긴다 — 가장자리에 붙어 있으면 거짓말이 된다
    if (t < g.v0 || t > g.v1) { c.style.display = 'none'; continue; }
    const px = g.x(t);
    c.setAttribute('x1', px); c.setAttribute('x2', px);
    c.style.display = '';
  }
}
