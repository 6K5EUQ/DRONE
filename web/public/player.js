// 재생 루프. 로그 시간을 벽시계 시간에 맞춰 진행시킨다.
//
// setInterval 을 쓰지 않는 이유: 프레임과 어긋나 커서가 떨린다. requestAnimationFrame
// 으로 **경과 실시간**을 재서 t 를 밀면, 프레임을 건너뛰어도 재생 속도가 유지된다.
// 탭이 백그라운드로 가면 rAF 가 멈추므로 돌아왔을 때 시간이 튀지 않도록
// 프레임 간격에 상한을 둔다.

'use strict';

function makePlayer({ dur, onTick }) {
  let t = 0, rate = 1, playing = false, raf = 0, last = 0;

  function apply() { onTick(t); }

  function frame(now) {
    if (!playing) return;
    const dt = Math.min((now - last) / 1000, 0.25);   // 탭 복귀 시 점프 방지
    last = now;
    t += dt * rate;
    if (t >= dur) { t = dur; stop(); apply(); return; }
    apply();
    raf = requestAnimationFrame(frame);
  }

  function play() {
    if (playing) return;
    if (t >= dur - 1e-6) t = 0;                       // 끝에서 누르면 처음부터
    playing = true;
    last = performance.now();
    raf = requestAnimationFrame(frame);
    setBtn();
  }

  function stop() {
    playing = false;
    cancelAnimationFrame(raf);
    setBtn();
  }

  function setBtn() {
    const b = document.getElementById('play');
    if (b) { b.textContent = playing ? '⏸' : '▶'; b.title = playing ? '일시정지' : '재생 (스페이스)'; }
  }

  const api = {
    get t() { return t; },
    get playing() { return playing; },
    apply,
    play, stop,
    toggle() { playing ? stop() : play(); },
    seek(v) { t = Math.max(0, Math.min(dur, v)); apply(); },
    setRate(r) { rate = r; },
  };
  return api;
}
