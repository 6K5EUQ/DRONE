// 콕핏 — 3D 기체 + 실시간 + 부품 + 비행 전 점검.
//
// 모델은 web/model/drone01.py(Blender)가 만든 /model/drone01.glb.
// 좌표: +z 기수, +y 위, 단위 m, 왼쪽 +x. 노드 이름으로 부품을 찾는다 —
// rotor_LF/RF/LB/RB, gps, bay_*.
//
// 🔴 판정은 여기서 하지 않는다. 점검은 /api/preflight/stream 이 준 level·verdict
//    를 그대로 그린다 (preflight.js 와 같은 규칙, 임계값은 preflight.py 한 곳).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const $ = (id) => document.getElementById(id);
const txt = (id, s) => { const e = $(id); if (e && e.textContent !== s) e.textContent = s; };
const html = (id, s) => { const e = $(id); if (e && e.innerHTML !== s) e.innerHTML = s; };
const num = (v, n = 0) => (v == null || !Number.isFinite(v)) ? '—' : v.toFixed(n);
const icon = (n) => `<svg class="i"><use href="#i-${n}"/></svg>`;
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const lvl = (v, warn, bad, low = true) => v == null ? '' : low ? (v < bad ? 'bad' : v < warn ? 'warn' : '') : (v > bad ? 'bad' : v > warn ? 'warn' : '');
const mins = (s) => s == null ? '—' : s < 60 ? `${Math.round(s)}초` : `${Math.floor(s / 60)}분 ${String(Math.round(s % 60)).padStart(2, '0')}초`;

let S = { live: false, d: {} };   // /api/live/state
let R = null;                      // 비행 기록 요약
let tab = null;                    // 아무 탭도 안 고른 것이 기본 — 정보 카드·타일 없이 기체만
let sel = null;                    // 고른 탑재칸
let mode = '3d';                   // 3d | map
// 로그 재생 상태 — 첫 frame() 이 모듈 평가 중에 돌므로 여기서 먼저 만든다
const pb = { on: false, t: 0, dur: 0, rate: 1, playing: false, last: 0, name: '', timer: 0, seeking: false, when: '', fl: null };
const D = () => (S.live ? (S.d || {}) : {});

// ── 부품 — components/*/README.md 에서 옮긴 요약 ─────────────────────
const BAYS = {
  motor: { name: '모터', outside: true, view: 'pwr', rows: [
    ['모터', 'GT DRONE 3508-380KV × 4'],
    ['프롭', '12 × 4.5 2엽'],
    ['회전', '좌전·우후 CW · 우전·좌후 CCW'] ] },
  battery: { name: '배터리', rows: [
    ['배터리', '4S 2,900 mAh 20C'],
    ['위치', '아랫판 밑'] ] },
  power: { name: 'ESC', rows: [
    ['ESC', 'GT DRONE EC-X3 30 A × 4'],
    ['BEC', '없음 (OPTO)'] ] },
  fc: { name: 'FC', rows: [
    ['비행제어기', 'Pixhawk 2.4.8 · STM32F427'],
    ['펌웨어', 'ArduCopter 3.6.12'] ] },
  gps: { name: 'GPS', outside: true, rows: [
    ['GPS', 'M8N (u-blox)'],
    ['컴퍼스', '외장 GPS 모듈'] ] },
};
const TAB_INFO = {
  sum: { name: '제원', bays: ['motor', 'battery', 'power', 'fc', 'gps'], rows: [
    ['형식', '쿼드 X · S500 계열'], ['프롭', '12 × 4.5'], ['목표 중량', '2 kg 이하'] ] },
  fly: null,
  pwr: { name: '동력', bays: ['power'], rows: [
    ['모터', 'GT DRONE 3508-380KV × 4'], ['ESC', 'GT DRONE EC-X3 30 A × 4'], ['프롭', '12 × 4.5 2엽'] ] },
  nav: { name: '항법', bays: ['fc', 'gps'], rows: [
    ['비행제어기', 'Pixhawk 2.4.8 · STM32F427'], ['펌웨어', 'ArduCopter 3.6.12'], ['GPS', 'M8N (u-blox)'] ] },
  bat: { name: '전원', bays: ['battery', 'power'], rows: [
    ['배터리', '4S 2,900 mAh 20C'], ['ESC', 'EC-X3 30 A × 4'] ] },
  rec: null,
  pf: null,
};

// 점검 묶음 → 기체 부위. 소프트웨어 설정(failsafe·미션 등)은 부위가 없다.
// 이름은 tools/preflight/preflight.py 의 r.group 과 같아야 한다.
const PF_BAY = {
  'GPS': ['gps'], '나침반': ['gps'], '배터리': ['battery', 'power'],
  '모터·프레임': ['power'], '출력 매핑': ['power'],
  'RC 수신': ['fc'], 'ARM 상태': ['fc'], '진동·센서': ['fc'],
};
const LV_COLOR = { ok: 0x1f9d55, warn: 0xd99a06, blk: 0xdc2626, info: 0x828284 };
const LV_RANK = { info: 0, ok: 1, warn: 2, blk: 3 };

// ── 3D ───────────────────────────────────────────────────────────────
const canvas = $('view');
let renderer = null;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch { canvas.style.display = 'none'; }

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 0.05, 600);   // 높이 뜨면 먼 땅까지 보인다
const craft = new THREE.Group();      // 사용자가 끌어 돌리는 것
const flyG = new THREE.Group();       // 첫 화면에서 날아가는 것
const attitude = new THREE.Group();   // 실시간 자세
flyG.add(attitude); craft.add(flyG); scene.add(craft);

scene.add(new THREE.HemisphereLight(0xffffff, 0xdedee3, 1.5));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(1.4, 3.4, 1.8); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 6; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01;
Object.assign(sun.shadow.camera, { left: -1.4, right: 1.4, top: 1.4, bottom: -1.4, near: 0.5, far: 8 });
scene.add(sun);
const fill = new THREE.DirectionalLight(0xf2f4ff, 0.9); fill.position.set(-2.5, 1.2, -1.5); scene.add(fill);
const front = new THREE.DirectionalLight(0xffffff, 0.5); front.position.set(0, 0.6, 3); scene.add(front);

const FLOOR = -0.20;   // 스키드 바닥 (web/model/drone01.py 의 FLOOR 와 같다)
// ── 땅 — 홈(이륙한 자리)에 고정된 바닥 ─────────────────────────────────
// 기체는 화면 가운데 그대로 있고, 땅이 고도만큼 내려가고 이동한 만큼 뒤로 흐른다.
// 땅·홈·고도는 **한 축척**이다 — 무대 1 = 실제 2 m. 따로 줄이면 홈이 땅 위에서
// 미끄러지고(가까워질수록 제자리를 찾아가는 것처럼 보인다) 높이·속도감이 죽는다.
// world 는 craft 안에 있어 사용자가 돌린 시점을 따르고, 기수 방향만큼 돈다 —
// world 좌표는 +z 북, -x 동.
const world = new THREE.Group(); craft.add(world);
const G = 0.5, GRID = 4.8;   // 무대/m, 격자 판 한 변 (격자 한 칸 = 0.5 m, 굵은 선 = 2 m)
let grid, floorY = FLOOR;
{ // 격자 — 25 cm 칸, 1 m 마다 진하게. 무늬는 땅을 따라 흐르고(map), 흐려지는 테두리는 기체 밑에 남는다(alphaMap)
  const T = 256, c = document.createElement('canvas'); c.width = c.height = T;
  const x = c.getContext('2d');
  x.fillStyle = 'rgb(204,205,213)'; x.fillRect(0, 0, T, T);
  for (let k = 0; k < 4; k++) {
    x.strokeStyle = k ? 'rgba(110,112,126,.24)' : 'rgba(96,98,112,.50)';
    x.lineWidth = k ? 1.5 : 2.4;
    const v = k * T / 4 + (k ? 0 : 1.2);
    x.beginPath(); x.moveTo(v, 0); x.lineTo(v, T); x.moveTo(0, v); x.lineTo(T, v); x.stroke();
  }
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const N = 512, a = document.createElement('canvas'); a.width = a.height = N;
  const y = a.getContext('2d'), g = y.createRadialGradient(N / 2, N / 2, N * 0.22, N / 2, N / 2, N * 0.49);
  g.addColorStop(0, '#fff'); g.addColorStop(1, '#000');
  y.fillStyle = g; y.fillRect(0, 0, N, N);
  grid = new THREE.Mesh(new THREE.PlaneGeometry(GRID, GRID),
    new THREE.MeshBasicMaterial({ map: tex, alphaMap: new THREE.CanvasTexture(a), transparent: true, depthWrite: false }));
  grid.rotation.x = -Math.PI / 2; grid.position.y = FLOOR - 0.001; grid.renderOrder = -1; world.add(grid);
}
// 홈 — 바닥의 H 패드와, 기체 높이까지 서는 가는 선 (멀리서도 보이게)
const homeG = new THREE.Group(); homeG.visible = false; world.add(homeG);
{
  const N = 256, c = document.createElement('canvas'); c.width = c.height = N;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(255,255,255,.92)'; x.beginPath(); x.arc(N / 2, N / 2, N / 2 - 4, 0, Math.PI * 2); x.fill();
  x.strokeStyle = '#3e6ae1'; x.lineWidth = 12; x.beginPath(); x.arc(N / 2, N / 2, N / 2 - 12, 0, Math.PI * 2); x.stroke();
  x.fillStyle = '#171a20'; x.font = '800 150px Inter, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText('H', N / 2, N / 2 + 8);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  const pad = new THREE.Mesh(new THREE.CircleGeometry(0.18, 48), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  pad.name = 'pad'; pad.rotation.x = -Math.PI / 2; pad.position.y = FLOOR + 0.002; pad.renderOrder = 0; homeG.add(pad);
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 1, 8), new THREE.MeshBasicMaterial({ color: 0x3e6ae1, transparent: true, opacity: 0.45, depthWrite: false }));
  pole.name = 'pole'; homeG.add(pole);
}
const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.ShadowMaterial({ opacity: 0.24 }));
ground.rotation.x = -Math.PI / 2; ground.position.y = FLOOR; ground.receiveShadow = true; scene.add(ground);
let blob;
{ // 접지 그림자 — 기체 밑이 가장 진하고 바깥으로 사라진다
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const x = c.getContext('2d'), gr = x.createRadialGradient(128, 128, 0, 128, 128, 128);
  gr.addColorStop(0, 'rgba(30,30,40,.42)'); gr.addColorStop(.5, 'rgba(30,30,40,.14)'); gr.addColorStop(1, 'rgba(30,30,40,0)');
  x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
  blob = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.0), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = FLOOR + 0.001; craft.add(blob);
}

if (renderer) {
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.0;
  // 금속 재질이 비칠 환경 — 밝은 스튜디오
  const pm = new THREE.PMREMGenerator(renderer);
  const env = new THREE.Scene();
  env.background = new THREE.Color(0xf0f0f3);
  const panel = (w, h, pos, s) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide })); m.position.set(...pos); m.lookAt(0, 0, 0); m.material.color.multiplyScalar(s); env.add(m); };
  panel(6, 2, [0, 5, 0], 2.2); panel(3, 3, [5, 2, 3], 1.4); panel(3, 3, [-5, 1, -2], 1.0);
  const floorM = new THREE.Mesh(new THREE.PlaneGeometry(20, 20), new THREE.MeshBasicMaterial({ color: 0x9a9aa0, side: THREE.DoubleSide }));
  floorM.rotation.x = -Math.PI / 2; floorM.position.y = -2; env.add(floorM);
  scene.environment = pm.fromScene(env, 0.04).texture;
  scene.environmentIntensity = 0.6;
}

// 모델이 오기 전까지 비어 있다 — 없으면 해당 동작만 건너뛴다
const rotors = {};          // LF/RF/LB/RB → { node, dir, v, disc }
let anchors = {};
const bays = {};            // battery/... → { meshes, fills, edges, a } — 부위 하나가 여러 덩이일 수 있다(모터 4개)
const skin = [];            // 반투명이 되는 겉면 재질
let skinT = 0;              // 0 불투명 ~ 1 반투명
const discMat = new THREE.MeshBasicMaterial({ color: 0x5a5d63, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false });
function addDisc(node, R) {
  const d = new THREE.Mesh(new THREE.CircleGeometry(R, 64), discMat.clone());
  d.rotation.x = -Math.PI / 2; node.add(d); return d;
}
// 윗판·아랫판 — 칸을 고르면 비친다
const SKIN = /^(top_plate|bottom_plate|name)/;

new GLTFLoader().load('/model/drone01.glb', (g) => {
  const m = g.scene;
  m.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = true;
    if (SKIN.test(o.name)) {
      o.material = o.material.clone();
      o.material.transparent = true;
      skin.push(o.material);
    }
  });
  for (const k of ['LF', 'RF', 'LB', 'RB']) {
    const n = m.getObjectByName('rotor_' + k);
    if (n) rotors[k] = { node: n, dir: (k === 'RF' || k === 'LB') ? 1 : -1, v: 0, disc: addDisc(n, 0.1524) };
  }
  // 클릭 영역. 안 보이게 두되 광선은 맞는다 (colorWrite 만 끈다). 칠과 테두리는 같은 모양으로 겹친다.
  const addHit = (k, mesh) => {
    mesh.castShadow = mesh.receiveShadow = false;
    mesh.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    mesh.userData.bay = k;
    const fillM = new THREE.MeshBasicMaterial({ color: 0x3e6ae1, transparent: true, opacity: 0, depthWrite: false });
    const fillMesh = new THREE.Mesh(mesh.geometry, fillM);
    fillMesh.renderOrder = 5;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 40),   // 곡면 안쪽 선은 빼고 양 끝 테두리만
      new THREE.LineBasicMaterial({ color: 0x3e6ae1, transparent: true, opacity: 0, depthTest: false }));
    edges.renderOrder = 6;
    mesh.add(fillMesh, edges);
    const b = bays[k] || (bays[k] = { meshes: [], fills: [], edges: [], a: 0 });
    b.meshes.push(mesh); b.fills.push(fillM); b.edges.push(edges.material);
  };
  for (const k of Object.keys(BAYS)) {
    const mesh = m.getObjectByName('bay_' + k);
    if (mesh) addHit(k, mesh);
  }
  // 모터 — 칸 상자가 없으니 프롭 원판 크기의 납작한 원통을 붙인다
  for (const r of Object.values(rotors)) {
    const c = new THREE.Mesh(new THREE.CylinderGeometry(0.1524, 0.1524, 0.025, 48));
    r.node.add(c); addHit('motor', c);
  }
  // 부위 표시가 붙을 자리
  const at = (name, off = [0, 0, 0]) => { const n = m.getObjectByName(name); if (!n) return null; const a = new THREE.Object3D(); a.position.set(...off); n.add(a); return a; };
  anchors = {
    gps: at('gps', [0, 0.02, 0]),
    bat: at('bay_battery', [0, -0.02, 0]),
    LF: at('rotor_LF'), RF: at('rotor_RF'), LB: at('rotor_LB'), RB: at('rotor_RB'),
  };
  attitude.add(m);
  $('loading').remove();
  setView();
}, (e) => { if (e.total) $('loading').firstChild.style.width = (100 * e.loaded / e.total) + '%'; },
() => { $('loading').remove(); if (intro) { intro = false; document.body.classList.remove('intro'); setView(); } });

// ── 조작 — 끌면 기체가 돈다, 휠·두 손가락은 거리, 두 번 누르면 제자리, 눌러서 칸 선택 ──
const VIEWS = {
  intro: { yaw: 4.0, tilt: 0.6, dist: 2.3 },
  sum: { yaw: 4.0, tilt: 0.55, dist: 1.75 },
  fly: { yaw: 4.0, tilt: 0.55, dist: 1.75 },
  pwr: { yaw: -2.75, tilt: 0.78, dist: 1.8 },
  nav: { yaw: 0.65, tilt: 0.45, dist: 1.5 },
  bat: { yaw: -1.9, tilt: 0.2, dist: 1.5 },
  rec: { yaw: 4.0, tilt: 0.55, dist: 1.75 },
  pf: { yaw: -2.1, tilt: 0.75, dist: 1.5 },
  bay: { yaw: -1.25, tilt: 0.62, dist: 0.95 },
};
let intro = document.body.classList.contains('intro');
if (intro && !renderer) { intro = false; document.body.classList.remove('intro'); }
const cam = { ...VIEWS[intro ? 'intro' : 'sum'], vYaw: 0, vTilt: 0 };
const goal = { ...cam, on: false };
const look = new THREE.Vector3(0, 0.02, 0);
const ptrs = new Map();
let pinch0 = 0, dist0 = 0, down = null;
const clampTilt = (t) => Math.max(-Math.PI / 2, Math.min(Math.PI / 2, t));   // ±90° — 음수면 바닥 밑에서 올려다본다
const clampDist = (d) => Math.max(0.5, Math.min(15, d));   // 높이 뜨면 멀리 물러나 땅까지 본다
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pickBay(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(Object.values(bays).flatMap((b) => b.meshes), false)[0];
  return hit ? hit.object.userData.bay : null;
}
function hitCraft(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  return ray.intersectObject(attitude, true).length > 0;
}
let hover = null;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, [e.clientX, e.clientY]);
  down = { x: e.clientX, y: e.clientY };
  canvas.classList.add('drag'); goal.on = false; cam.vYaw = cam.vTilt = 0;
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch0 = Math.hypot(a[0] - b[0], a[1] - b[1]); dist0 = cam.dist; }
});
canvas.addEventListener('pointermove', (e) => {
  const p = ptrs.get(e.pointerId);
  if (!p) {   // 끌지 않는 중 — 칸 위면 손 모양
    const mouse = e.pointerType === 'mouse';
    hover = mouse && !intro ? pickBay(e) : null;
    canvas.style.cursor = (intro ? mouse && fly.t < 0 && hitCraft(e) : hover) ? 'pointer' : '';
    return;
  }
  if (ptrs.size === 1) {
    const dx = e.clientX - p[0], dy = e.clientY - p[1];
    cam.vYaw = dx * 0.008; cam.vTilt = dy * 0.006;
    cam.yaw += cam.vYaw; cam.tilt = clampTilt(cam.tilt + cam.vTilt);
  }
  p[0] = e.clientX; p[1] = e.clientY;
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()];
    cam.dist = clampDist(dist0 * pinch0 / Math.max(1, Math.hypot(a[0] - b[0], a[1] - b[1])));
  }
});
const up = (e) => {
  ptrs.delete(e.pointerId);
  if (!ptrs.size) canvas.classList.remove('drag');
  // 거의 안 움직였으면 누른 것이다
  if (down && e.type === 'pointerup' && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) {
    if (intro) { if (hitCraft(e)) launch(); }
    else { const k = pickBay(e); if (k) selectBay(k === sel ? null : k); }
  }
  down = null;
};
canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
canvas.addEventListener('pointerleave', () => { hover = null; });
canvas.addEventListener('wheel', (e) => { e.preventDefault(); goal.on = false; cam.dist = clampDist(cam.dist * Math.exp(e.deltaY * 0.001)); }, { passive: false });
canvas.addEventListener('dblclick', () => setView());

function setView() {
  const v = VIEWS[intro ? 'intro' : sel ? BAYS[sel].view || 'bay' : tab || 'sum'], twoPi = Math.PI * 2;
  goal.yaw = v.yaw + Math.round((cam.yaw - v.yaw) / twoPi) * twoPi;   // 가까운 쪽으로 돈다
  goal.tilt = v.tilt; goal.dist = v.dist; goal.on = true; cam.vYaw = cam.vTilt = 0;
}

function resize() {
  const r = canvas.getBoundingClientRect();
  if (!renderer || !r.width) return;
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(canvas);

// ── 칸 선택 ──────────────────────────────────────────────────────────
function selectBay(k) {
  sel = k;
  setView();
  renderInfo();
  renderCalls();
}

/** 칸마다 지금 칠할 색과 세기. 점검 탭이면 판정 색, 아니면 고른 칸·탭 칸만 파랑. */
function bayLook(k) {
  if (tab === 'pf' && !sel) {
    const lv = pf.bayLevel[k];
    return lv ? { color: LV_COLOR[lv], a: 1 } : { color: 0x3e6ae1, a: 0 };
  }
  if (sel) return { color: 0x3e6ae1, a: k === sel ? 1 : 0 };
  if (tab === 'sum') return { color: 0x3e6ae1, a: k === hover ? 0.7 : 0.3 };   // 누를 수 있는 부위를 옅게
  const tb = TAB_INFO[tab];
  if (tb && tb.bays && tb.bays.includes(k)) return { color: 0x3e6ae1, a: 0.7 };
  return { color: 0x3e6ae1, a: k === hover ? 0.5 : 0 };
}

// ── 부위 표시 ────────────────────────────────────────────────────────
const ROT_DIR = { LF: 'CW', RF: 'CCW', LB: 'CCW', RB: 'CW' };
const CALLS = {
  sum: () => [],
  // 비행 — 모터마다 부하만. 한쪽으로 쏠리면 바로 보이게 색은 thr 그대로.
  fly: (d) => { const m = d.motors || {}; const f = (k) => m[k] != null ? `${Math.round(m[k])}%` : '—';
    return [['LF', '', f('LF'), thr(m.LF)], ['RF', '', f('RF'), thr(m.RF)], ['LB', '', f('LB'), thr(m.LB)], ['RB', '', f('RB'), thr(m.RB)]]; },
  // 회전 방향은 tools/live/drone_live.py MOTOR_PINS (2026-09-16 실측) 기준
  pwr: (d) => { const m = d.motors || {}; const f = (k) => m[k] != null ? `${Math.round(m[k])}% · ${ROT_DIR[k]}` : ROT_DIR[k];
    return [['LF', '', f('LF'), thr(m.LF)], ['RF', '', f('RF'), thr(m.RF)], ['LB', '', f('LB'), thr(m.LB)], ['RB', '', f('RB'), thr(m.RB)],
            ]; },
  nav: (d) => [['gps', 'GPS', d.sats != null ? `${d.sats}기 · ${num(d.eph, 1)}m` : '—', lvl(d.sats, 8, 5)],
               ],
  bat: (d) => [['bat', '배터리', d.volt != null ? `${d.volt.toFixed(1)}V · ${num(d.cur, 1)}A` : '—', lvl(d.batt_pct, 35, 20)]],
  rec: () => [],
  pf: () => [],
};
// 모터 부하 판정 — 좌측 계기판(모터 그림)과 3D 기체 위(라벨·로터 원판)가 **같은 함수**를 쓴다.
// 기준은 /live 와 같다: 한 모터가 70% 넘으면 노랑, 80% 넘으면 빨강.
const MOT_WARN = 70, MOT_BAD = 80;
const thr = (v) => v == null ? '' : v >= MOT_BAD ? 'bad' : v >= MOT_WARN ? 'warn' : '';
const THR_COLOR = { '': 0x5a5d63, warn: 0xd99a06, bad: 0xdc2626 };
const callEls = new Map();
const MOTOR_OUT = new Set(['LF', 'RF', 'LB', 'RB']), CALL_OUT = 26;   // 원판 밖에서 라벨 반 폭만큼 더(px)
const ROTOR_R = 0.1524, tmpW = new THREE.Vector3(), tmpC = new THREE.Vector3(), tmpS = new THREE.Vector3();
function renderCalls() {
  let want = sel || mode !== '3d' || !tab ? [] : CALLS[tab](D());
  if (!sel && mode === '3d' && tab !== 'pwr' && tab !== 'fly') {
    const m = D().motors || {};
    for (const k of ['LF', 'RF', 'LB', 'RB']) if (thr(m[k])) want.push([k, '', `${Math.round(m[k])}%`, thr(m[k])]);
  }
  const keep = new Set();
  for (const [a, k, v, c] of want) {
    keep.add(a);
    let el = callEls.get(a);
    if (!el) {
      el = document.createElement('div'); el.className = MOTOR_OUT.has(a) ? 'call m' : 'call';
      el.innerHTML = '<span class="k"></span><span class="v"></span><i></i>';
      $('calls').append(el); callEls.set(a, el);
    }
    el.children[0].textContent = k;
    el.children[1].textContent = v;
    el.children[1].className = 'v ' + (c || '');
  }
  for (const [a, el] of callEls) if (!keep.has(a)) { el.remove(); callEls.delete(a); }
}
const tmpV = new THREE.Vector3();
function placeCalls() {
  const r = canvas.getBoundingClientRect();
  const top = $('tabs').getBoundingClientRect().bottom - r.top;   // 탭 밑까지만 — 넘으면 탭에 가린다
  const moving = goal.on && Math.abs(goal.yaw - cam.yaw) + Math.abs(goal.tilt - cam.tilt) > 0.08;
  // 모터 라벨은 모터 중심이 아니라 기체 중심에서 바깥쪽으로 밀어 둔다 — 멀리 보면 네 개가
  // 한데 뭉쳐 겹친다. 화면에서 같은 거리(px)만큼 밀어 줌과 상관없이 떨어져 보이게.
  attitude.getWorldPosition(tmpC); tmpV.copy(tmpC).project(camera);
  const cx = (tmpV.x + 1) / 2 * r.width, cy = (1 - tmpV.y) / 2 * r.height;
  for (const [a, el] of callEls) {
    const o = anchors[a];
    if (!o) { el.style.opacity = 0; continue; }
    o.getWorldPosition(tmpV); tmpV.project(camera);
    let x = (tmpV.x + 1) / 2 * r.width, y = (1 - tmpV.y) / 2 * r.height;
    if (MOTOR_OUT.has(a)) {
      // 로터 원판 바깥 — 기체 중심→로터 방향으로 원판 반지름의 1.25배 떨어진 점을 투영하고,
      // 라벨 크기만큼 화면에서 더 민다. 어떤 줌에서도 박스가 원판 밖에 있다.
      o.getWorldPosition(tmpW); tmpW.sub(tmpC); tmpW.y = 0; tmpW.setLength(ROTOR_R * 1.25 * o.getWorldScale(tmpS).x);
      o.getWorldPosition(tmpV); tmpV.add(tmpW).project(camera);
      x = (tmpV.x + 1) / 2 * r.width; y = (1 - tmpV.y) / 2 * r.height;
      const dx = x - cx, dy = y - cy, n = Math.hypot(dx, dy) || 1;
      x += dx / n * CALL_OUT; y += dy / n * CALL_OUT;
    }
    el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, ${MOTOR_OUT.has(a) ? '-50%' : '-100%'})`;   // 모터 라벨은 선 없이 그 자리에
    el.style.opacity = moving || y - el.offsetHeight < top ? 0 : 1;   // 시점이 크게 바뀌는 동안은 숨긴다
  }
}

// ── 그리기 ───────────────────────────────────────────────────────────
const lookGoal = new THREE.Vector3();

// ── 예측 경로 ────────────────────────────────────────────────────────
// 대지 속도 벡터(vx 북·vy 동)의 방향 χ 와 그 변화율 ω(선회율)로, 지금처럼
// 계속 가면 어디로 가는지를 기수 앞에 그린다. 기수 방향과 χ 가 다르면(옆바람·
// 호버 중 옆걸음) 선이 그만큼 비스듬히 나간다. 예측이지 계획 경로가 아니다.
const pred = { on: 0, v: 0, chi: 0, rel: 0, omega: 0, climb: 0, prev: null };
const PRED_N = 48;
const unwrap = (a) => ((a + 540) % 360) - 180;
function updatePred() {
  const d = D();
  const t = pb.on ? S.pos : performance.now() / 1000;
  const v = d.vx != null && d.vy != null ? Math.hypot(d.vx, d.vy) : d.groundspeed;
  const yaw = d.yaw != null ? d.yaw : d.hdg;
  pred.v = v || 0;
  // 느리면 방향이 잡음이다 — 호버 제자리에서 선이 춤추지 않게 끈다
  pred.show = v != null && v > 0.8 && yaw != null && (!!d.armed || pb.on);
  if (!pred.show) { pred.prev = null; return; }
  const chi = d.vx != null ? (Math.atan2(d.vy, d.vx) * 180 / Math.PI + 360) % 360 : yaw;
  if (pred.prev && t > pred.prev.t && t - pred.prev.t < 3) {
    const w = unwrap(chi - pred.prev.chi) / (t - pred.prev.t);
    pred.omega += (Math.max(-40, Math.min(40, w)) - pred.omega) * 0.35;   // 선회율(°/s) 평활
  } else if (!pred.prev || t < pred.prev.t) pred.omega = 0;              // 되감기·첫 표본
  pred.prev = { t, chi };
  pred.chi = chi;
  pred.rel = unwrap(chi - yaw);
  pred.climb = d.climb || 0;
}
// 예측 경로 — 세 겹이다.
//   공중 길: 기수 앞에서 기체 높이로 나가 상승률만큼 오르내린다. 0.5초마다 화살촉.
//   땅 그림자: 같은 길을 땅에 옅게. 높이 떠 있어도 어디 위를 지나는지 보인다.
//   끝 기둥: 3초 뒤 자리에서 땅까지 선 하나 — 공중 길과 땅 그림자를 잇는다.
// 길이는 3초 앞까지(더 길면 화면 밖으로 나간다), 땅과 같은 축척(G). 기체와 같이 돈다 (craft 안에 둔다).
const PRED_W = 0.22, PRED_SEC = 3, PRED_TICK = 0.5, PRED_NOSE = 0.36;
function predTexture() {
  const W = 512, H = 64, c = document.createElement('canvas'); c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = 'rgba(62,106,225,.30)'; x.fillRect(0, 0, W, H);          // 속
  x.fillStyle = 'rgba(62,106,225,.95)'; x.fillRect(0, 0, W, 5); x.fillRect(0, H - 5, W, 5);   // 가장자리
  x.globalCompositeOperation = 'destination-in';                          // 길이 방향으로 흐려진다
  const g = x.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,.5)'); g.addColorStop(0.06, 'rgba(0,0,0,1)'); g.addColorStop(0.7, 'rgba(0,0,0,.75)'); g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; return t;
}
function ribbon(order) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((PRED_N + 1) * 2 * 3), 3));
  const uv = new Float32Array((PRED_N + 1) * 4), idx = [];
  for (let i = 0; i <= PRED_N; i++) {
    uv.set([i / PRED_N, 0, i / PRED_N, 1], i * 4);
    if (i < PRED_N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ map: predTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  m.frustumCulled = false; m.renderOrder = order; craft.add(m);
  return m;
}
const predPath = ribbon(2);     // 공중 길
const predShadow = ribbon(1);   // 땅 그림자
const predTicks = (() => {      // 0.5초마다 화살촉
  const g = new THREE.BufferGeometry();
  const n = Math.round(PRED_SEC / PRED_TICK);
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 9), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 12), 4));
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }));
  m.frustumCulled = false; m.renderOrder = 3; craft.add(m);
  return m;
})();
const predPost = (() => {       // 끝 기둥
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const m = new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0x3e6ae1, transparent: true, depthWrite: false }));
  m.frustumCulled = false; craft.add(m);
  return m;
})();
const predPts = Array.from({ length: PRED_N + 1 }, () => ({ x: 0, y: 0, z: 0, dx: 0, dz: 1 }));
function drawPred(k) {
  pred.on += ((pred.show ? 1 : 0) - pred.on) * k;
  const vis = pred.on > 0.01;
  predPath.visible = predShadow.visible = predTicks.visible = predPost.visible = vis;
  if (!vis) return;
  const L = Math.max(0.7, Math.min(40, pred.v * PRED_SEC * G));
  const turn = THREE.MathUtils.degToRad(Math.max(-160, Math.min(160, pred.omega * PRED_SEC)));
  const rel = THREE.MathUtils.degToRad(pred.rel);
  const rise = Math.max(-10, Math.min(10, pred.climb)) * PRED_SEC * G;   // 그동안 오르내리는 높이
  // 기수 앞에서 출발. 오른쪽 선회 = -x (좌익이 +x). 기수와 진행 방향이 다르면
  // (옆바람·옆걸음) 처음부터 그만큼 틀어져 나간다.
  let x = 0, z = PRED_NOSE;
  for (let i = 0; i <= PRED_N; i++) {
    const s = i / PRED_N;
    const th = rel * Math.min(1, s * 4) + turn * s;          // 선회율 그대로 — 끝에서 ω·PRED_SEC 만큼 돈다
    const p = predPts[i];
    p.dx = -Math.sin(th); p.dz = Math.cos(th); p.x = x; p.z = z; p.y = rise * s;
    x += p.dx * L / PRED_N; z += p.dz * L / PRED_N;
  }
  const fill = (mesh, yOf, w) => {
    const a = mesh.geometry.attributes.position.array;
    for (let i = 0; i <= PRED_N; i++) {
      const p = predPts[i], y = yOf(p);
      a.set([p.x + p.dz * w, y, p.z - p.dx * w, p.x - p.dz * w, y, p.z + p.dx * w], i * 6);
    }
    mesh.geometry.attributes.position.needsUpdate = true;
  };
  const depth = FLOOR - floorY, air = depth > 0.2;          // 땅에 붙어 있으면 공중 길 = 땅 길
  const yAir = (p) => (air ? 0 : floorY + 0.006) + (air ? p.y : 0);
  fill(predPath, yAir, PRED_W / 2);
  predPath.material.opacity = pred.on;
  predShadow.visible = air;
  if (air) {
    fill(predShadow, () => floorY + 0.004, PRED_W / 2 * (1 + depth * 0.1));
    predShadow.material.opacity = pred.on * 0.35;
  }
  // 화살촉 — 0.5초 간격. 간격이 곧 속도다 (넓으면 빠르다).
  const ta = predTicks.geometry.attributes.position.array, tc = predTicks.geometry.attributes.color.array;
  const NT = Math.round(PRED_SEC / PRED_TICK);
  for (let n = 1; n <= NT; n++) {
    const p = predPts[Math.round(n / NT * PRED_N)], y = yAir(p) + 0.002;
    const hw = PRED_W * 0.38, len = PRED_W * 0.5;
    const tipX = p.x + p.dx * len / 2, tipZ = p.z + p.dz * len / 2, bx = p.x - p.dx * len / 2, bz = p.z - p.dz * len / 2;
    ta.set([tipX, y, tipZ, bx + p.dz * hw, y, bz - p.dx * hw, bx - p.dz * hw, y, bz + p.dx * hw], (n - 1) * 9);
    const a = pred.on * (1 - (n - 1) / NT * 0.7);
    for (let v = 0; v < 3; v++) tc.set([1, 1, 1, a], ((n - 1) * 3 + v) * 4);   // 흰 화살촉 — 파란 띠 위에서 읽힌다
  }
  predTicks.geometry.attributes.position.needsUpdate = true; predTicks.geometry.attributes.color.needsUpdate = true;
  // 끝 기둥
  predPost.visible = air;
  if (air) {
    const e = predPts[PRED_N];
    predPost.geometry.attributes.position.array.set([e.x, yAir(e), e.z, e.x, floorY + 0.004, e.z]);
    predPost.geometry.attributes.position.needsUpdate = true;
    predPost.material.opacity = pred.on * 0.5;
  }
}

// ── 첫 화면 → 대시보드 — 쿼드라 제자리에서 수직으로 떠올라 사라지면 대시보드가
// 열리고, 위에서 수직으로 내려와 내려앉는다. 좌표는 기체 기준(+y 위).
const fly = { t: -1, from: null, to: null, floor: 1 };
const FLY_SPOOL = 0.3, FLY_OUT = 1.1, FLY_IN = 1.4, FLY_H = 4;
const FLY_SETTLE = 0.6;   // 내려앉은 뒤 착지 흔들림이 가라앉는 시간
function launch() {
  if (fly.t >= 0) return;
  fly.t = 0;
  document.body.classList.add('launch');   // 로고를 거둔다
  goal.on = false; cam.vYaw = cam.vTilt = 0;
  canvas.style.cursor = '';
}
function flyStep(dt) {
  if (fly.t < 0) return;
  fly.t += dt;
  if (fly.t < FLY_OUT) {                      // 로터를 올린 뒤 수직으로 가속 상승
    const s = Math.max(0, (fly.t - FLY_SPOOL) / (FLY_OUT - FLY_SPOOL));
    flyG.position.set(0, FLY_H * s * s, 0);
    return;
  }
  if (intro) {                                // 화면 밖 — 이때 대시보드를 연다
    intro = false;
    document.body.classList.remove('intro');
    document.body.classList.add('opened');
    fly.from = { yaw: cam.yaw, tilt: cam.tilt, dist: cam.dist };
    setView(); goal.on = false;
    fly.to = { yaw: goal.yaw, tilt: goal.tilt, dist: goal.dist };
  }
  const u = fly.t - FLY_OUT, s = Math.min(1, u / FLY_IN), e = 1 - (1 - s) ** 3;   // 감속하며 내려온다
  const f = fly.from, g = fly.to;
  if (s < 1) { cam.yaw = f.yaw + (g.yaw - f.yaw) * e; cam.tilt = f.tilt + (g.tilt - f.tilt) * e; cam.dist = f.dist + (g.dist - f.dist) * e; }
  // 착지 — 다리가 닿으며 살짝 눌렸다 편다
  const k = u - FLY_IN, bump = k > 0 ? -0.012 * Math.exp(-7 * k) * Math.sin(14 * k) : 0;
  flyG.position.set(0, FLY_H * (1 - e) + bump, 0);
  if (u >= FLY_IN + FLY_SETTLE) { fly.t = -1; flyG.position.set(0, 0, 0); }
}
// 바닥 — 수직 이착륙이라 치우지 않는다. 그림자는 뜬 만큼 옅어진다.
function flyFloor() {
  grid.material.opacity = fly.floor;
  ground.material.opacity = 0.24 * fly.floor * Math.max(0, 1 - (FLOOR - floorY) / 3);
  blob.position.z = flyG.position.z;   // 그림자는 바닥에 남아 따라가고, 뜬 만큼 옅어진다
  blob.material.opacity = Math.max(0, 1 - Math.abs(flyG.position.y) * 3 - (FLOOR - floorY) * 2) * fly.floor;
}

// 기체 밑에서 땅까지 내리는 선과 땅에 닿는 고리 — 얼마나 떠 있는지
const drop = new THREE.Group(); drop.visible = false; craft.add(drop);
{
  const m = new THREE.MeshBasicMaterial({ color: 0x3e6ae1, transparent: true, opacity: 0.35, depthWrite: false });
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.005, 1, 6), m); line.name = 'line'; drop.add(line);
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.2, 48), m.clone()); ring.name = 'ring';
  ring.rotation.x = -Math.PI / 2; drop.add(ring);
}
// 위치는 1초마다 온다 — 사이는 속도로 이어 가다 받은 값으로 당긴다.
// 홈은 FC 의 HOME_POSITION(ARM 때 잡힌다), 없으면 ARM 한 순간의 위치.
const geo = { n: 0, e: 0, alt: 0, psi: 0, armHome: null, armed: false, home: null, hs: null };
function groundStep(dt, ease) {
  const d = D();
  if (d.armed && !geo.armed && d.lat != null) geo.armHome = [d.lat, d.lon];
  geo.armed = !!d.armed;
  const hs = Array.isArray(S.home) ? S.home : S.home && S.home.lat != null ? [S.home.lat, S.home.lon] : geo.armHome;
  const on = !!S.live && hs && d.lat != null;
  let rn = 0, re = 0;
  if (on) {
    rn = (d.lat - hs[0]) * 111320;
    re = (d.lon - hs[1]) * 111320 * Math.cos(hs[0] * Math.PI / 180);
    if (Math.hypot(rn - geo.n, re - geo.e) > 300) { geo.n = rn; geo.e = re; }   // 홈이 바뀌었다 — 따라가지 말고 옮긴다
    geo.n += (d.vx || 0) * dt; geo.e += (d.vy || 0) * dt;
  }
  geo.n += (rn - geo.n) * ease(1.5); geo.e += (re - geo.e) * ease(1.5);
  geo.alt += ((on && d.alt != null ? d.alt : 0) - geo.alt) * ease(3);
  const yaw = d.yaw != null ? d.yaw : d.hdg;
  geo.psi += unwrap((on && yaw != null ? yaw : 0) - geo.psi) * ease(4);
  // 바닥 — 내려가고, 기수만큼 돌고, 무늬가 흐른다. 멀어질수록 넓게 깔아 화면에 남긴다.
  const depth = Math.max(0, geo.alt) * G;
  floorY = FLOOR - depth;
  world.position.y = -depth;
  world.rotation.y = THREE.MathUtils.degToRad(geo.psi);
  const sc = 1 + depth * 1.5, rp = GRID * sc;
  grid.scale.set(sc, sc, 1);
  const m = grid.material.map, fr = (v) => ((v % 1) + 1) % 1;
  m.repeat.set(rp, rp);
  m.offset.set(fr(-geo.e * G - rp / 2), fr(-geo.n * G - rp / 2));
  ground.position.y = floorY;
  blob.position.y = floorY + 0.001;
  // 홈 — 땅과 같은 축척으로 제자리에. 높이 뜨면 패드를 키워 멀리서도 보이게.
  homeG.visible = !!on;
  geo.home = on ? Math.hypot(geo.n, geo.e) : null;
  geo.hs = on ? hs : null;
  if (on) {
    homeG.position.set(geo.e * G, 0, -geo.n * G);
    homeG.getObjectByName('pad').scale.setScalar(1 + depth * 0.25);
    const pole = homeG.getObjectByName('pole');
    pole.scale.y = Math.max(0.001, depth); pole.position.y = FLOOR + depth / 2;
    pole.visible = depth > 0.05;
  }
  drop.visible = depth > 0.1;
  if (drop.visible) {
    const line = drop.getObjectByName('line');
    line.scale.y = depth; line.position.y = FLOOR - depth / 2;
    const ring = drop.getObjectByName('ring');
    ring.position.y = floorY + 0.003; ring.scale.setScalar(1 + depth * 0.25);
  }
}

// 홈 표지 — 20 m 넘게 떨어지면 패드 자리에 거리와 함께. 화면 밖이면 그쪽 가장자리로.
const hPos = new THREE.Vector3();
function placeHome() {
  const el = $('htag'), r = geo.home;
  const show = r != null && r > 20 && !sel;
  if (el.hidden === show) el.hidden = !show;
  if (!show) return;
  homeG.getObjectByName('pad').getWorldPosition(hPos).project(camera);
  // 붙는 영역 — 탭 아래부터 타일·재생 막대 위까지
  const w = canvas.clientWidth, h = canvas.clientHeight, L = 44, R = w - 44, T = 110, B = h - (document.querySelector('.main').classList.contains('pbmode') ? 200 : 130);
  let x = (hPos.x + 1) / 2 * w, y = (1 - hPos.y) / 2 * h;
  const behind = hPos.z > 1;
  if (behind || x < L || x > R || y < T || y > B) {
    const cx = (L + R) / 2, cy = (T + B) / 2;
    let dx = x - cx, dy = y - cy;
    if (behind) { dx = -dx; dy = -dy; }
    const k = Math.min((R - cx) / Math.max(1e-6, Math.abs(dx)), (B - cy) / Math.max(1e-6, Math.abs(dy)));
    x = cx + dx * k; y = cy + dy * k;
  }
  el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) translate(-50%, -50%)`;
  const t = r >= 1000 ? `${(r / 1000).toFixed(1)}<small>km</small>` : `${Math.round(r)}<small>m</small>`;
  const b = el.querySelector('b'); if (b.innerHTML !== t) b.innerHTML = t;
}

// ── 위성 바닥 — 지도 버튼. 홈 둘레 위성 타일을 땅과 같은 축척(G)으로 격자 밑에 연하게 깐다.
// 🔧 조정값 — 보면서 맞춘다.
const SAT = {
  opacity: 0.70,          // 0 안 보임 ~ 1 원본
  zoom: 18,               // 타일 줌 (18 ≈ 0.5 m/px). 비행장은 Esri 에 18 까지만 있다 — 19 는 회색 「없음」 타일
  tiles: 5,               // 한 변 타일 수 (5 × 256 px ≈ 625 m)
};
const SAT_FIELD = [35.1811, 128.5538];   // 링크가 없을 때 가운데 — 비행장 (server.js ADSB_LAT/LON)
const sat = { on: false, mesh: null, key: '', lat: 0, lon: 0 };
function satBuild(lat, lon) {
  const z = SAT.zoom, n = 2 ** z, N = SAT.tiles, T = 256, rad = Math.PI / 180;
  const xt = (lon + 180) / 360 * n, yt = (1 - Math.asinh(Math.tan(lat * rad)) / Math.PI) / 2 * n;
  const x0 = Math.floor(xt) - (N >> 1), y0 = Math.floor(yt) - (N >> 1);
  const c = document.createElement('canvas'); c.width = c.height = N * T;
  const g = c.getContext('2d');
  const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => { g.drawImage(img, i * T, j * T); tex.needsUpdate = true; };
    img.src = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y0 + j}/${x0 + i}`;
  }
  // 캔버스 가운데의 위경도와 한 변 길이(m)
  const cx = x0 + N / 2, cy = y0 + N / 2;
  sat.lon = cx / n * 360 - 180;
  sat.lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * cy / n))) / rad;
  const size = N * T * 156543.03392 * Math.cos(lat * rad) / n;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size * G, size * G),
    new THREE.MeshBasicMaterial({ map: tex, alphaMap: grid.material.alphaMap, transparent: true, opacity: SAT.opacity, depthWrite: false }));
  mesh.rotation.set(-Math.PI / 2, 0, Math.PI);   // 이미지 위 = 북(+z), 오른쪽 = 동(-x)
  mesh.renderOrder = -2;                          // 격자 밑
  world.add(mesh);
  return mesh;
}
function satStep() {
  grid.visible = !sat.on;   // 지도일 때는 격자를 걷어 사진만
  if (!sat.on) { if (sat.mesh) sat.mesh.visible = false; return; }
  const ref = geo.hs || SAT_FIELD, key = ref.join(',');
  if (!sat.mesh || sat.key !== key) {
    if (sat.mesh) { world.remove(sat.mesh); sat.mesh.material.map.dispose(); sat.mesh.geometry.dispose(); }
    sat.mesh = satBuild(ref[0], ref[1]); sat.key = key;
  }
  sat.mesh.visible = true;
  sat.mesh.material.opacity = SAT.opacity;
  // 이미지 가운데가 홈에서 떨어진 만큼 — 땅 좌표(+z 북, -x 동)로 옮긴다
  const nC = (sat.lat - ref[0]) * 111320, eC = (sat.lon - ref[1]) * 111320 * Math.cos(ref[0] * Math.PI / 180);
  sat.mesh.position.set((geo.e - eC) * G, FLOOR - 0.002, (nC - geo.n) * G);
}

const timer = new THREE.Timer();
let shiftX = 0, distK = 1;   // 정보 카드를 피해 화면 중심을 옮긴 폭(px), 물러선 배율
function frame() {
  requestAnimationFrame(frame);
  if (pb.on) pbAdvance();
  if (!renderer || mode !== '3d') return;
  timer.update();
  const dt = Math.min(timer.getDelta(), 0.05);
  const ease = (r) => 1 - Math.exp(-dt * r);
  flyStep(dt); flyFloor(); groundStep(dt, ease); satStep();
  if (goal.on) {
    const k = ease(3.2);
    cam.yaw += (goal.yaw - cam.yaw) * k; cam.tilt += (goal.tilt - cam.tilt) * k; cam.dist += (goal.dist - cam.dist) * k;
    if (Math.abs(goal.yaw - cam.yaw) < 0.003 && Math.abs(goal.tilt - cam.tilt) < 0.003) goal.on = false;
  } else if (!ptrs.size) {
    cam.yaw += cam.vYaw; cam.tilt = clampTilt(cam.tilt + cam.vTilt);
    cam.vYaw *= 0.93; cam.vTilt *= 0.88;
  }
  craft.rotation.y = cam.yaw;
  craft.updateMatrixWorld();
  // 고른 칸을 가운데로
  if (sel && bays[sel] && !BAYS[sel].view) bays[sel].meshes[0].getWorldPosition(lookGoal); else lookGoal.set(0, 0.02 - Math.min(FLOOR - floorY, 1) * 0.25, 0);   // 조금만 내린다 — 더 내리면 기체가 화면 위로 잘린다
  look.lerp(lookGoal, ease(4));
  // 정보 카드가 기체를 덮을 때만 — 카드 오른쪽 빈 곳으로 화면 중심을 옮기고,
  // 거기에 안 들어가면 물러선다. 기체 반폭 ≈ 0.6·높이/거리 (대각 0.55 m 기준).
  const cw = canvas.clientWidth, chh = canvas.clientHeight, ib = $('info');
  const base = cam.dist * Math.max(1, 1.35 * chh / Math.max(1, cw));   // 좁으면 물러선다
  let far = base, want = 0;
  if (!intro && innerWidth > 900 && ib.offsetParent) {
    const L = ib.getBoundingClientRect().right - canvas.getBoundingClientRect().left + 16;
    far = Math.max(base, 1.2 * chh / Math.max(1, cw - L - 16));
    want = Math.max(0, L - (cw / 2 - 0.6 * chh / far));
  }
  shiftX += (want - shiftX) * ease(5);
  distK += (far / cam.dist - distK) * ease(5);
  if (shiftX > 0.5) camera.setViewOffset(cw, chh, -shiftX, 0, cw, chh); else camera.clearViewOffset();
  const dist = cam.dist * distK;
  camera.position.set(look.x, look.y + Math.sin(cam.tilt) * dist, look.z + Math.cos(cam.tilt) * dist);
  camera.up.set(0, Math.cos(cam.tilt), -Math.sin(cam.tilt));   // 궤도 접선 — 90° 에서도 안 뒤집힌다
  camera.lookAt(look);

  // 실시간 자세 — 기체가 붙어 있을 때만, 없으면 수평으로 돌아온다
  const d = D();
  const tr = d.roll != null ? THREE.MathUtils.degToRad(d.roll) : 0;
  const tp = d.pitch != null ? THREE.MathUtils.degToRad(d.pitch) : 0;
  attitude.rotation.order = 'YXZ';
  attitude.rotation.z += (tr - attitude.rotation.z) * ease(6);
  attitude.rotation.x += (-tp - attitude.rotation.x) * ease(6);

  // 로터 — ARM 이고 출력이 있으면 돈다. 빨라지면 날 대신 원판이 보인다.
  const mt = d.motors || {};
  for (const [k, r] of Object.entries(rotors)) {
    const pct = fly.t >= 0 ? 60 : d.armed ? (mt[k] ?? 0) : 0;   // 첫 화면에서 날아갈 때도 돈다
    r.v += ((pct > 0 ? 10 + pct * 0.6 : 0) - r.v) * ease(2);
    r.node.rotateY(r.dir * r.v * dt);
    const w = thr(mt[k]);
    r.disc.material.color.setHex(THR_COLOR[w]);
    r.disc.material.opacity = Math.min(w ? 0.28 : 0.09, Math.max(0, (r.v - 12) / (w ? 80 : 200)));
  }
  // 겉면 — 칸을 고르면 비친다
  skinT += ((sel && !BAYS[sel].outside ? 1 : 0) - skinT) * ease(5);
  for (const m of skin) {
    m.opacity = 1 - 0.85 * skinT;
    m.depthWrite = skinT < 0.5;
  }
  // 칸 강조
  for (const [k, b] of Object.entries(bays)) {
    const L = bayLook(k);
    b.a += (L.a - b.a) * ease(8);
    for (const f of b.fills) { f.color.setHex(L.color); f.opacity = 0.24 * b.a; }
    for (const e of b.edges) { e.color.setHex(L.color); e.opacity = 0.9 * b.a; }
  }
  drawPred(ease(4));
  renderer.render(scene, camera);
  placeCalls();
  placeHome();
}
frame();

// ── 정보 카드 ────────────────────────────────────────────────────────
function rowsHtml(rows) {
  return rows.map(([k, v]) => `<div class="row"><span>${esc(k)}</span><b>${esc(v).replace(/(\d) (?=[A-Za-z°%])/g, '$1\u00a0')}</b></div>`).join('');
}
function renderInfo() {
  const box = $('info');
  if (mode !== '3d') { box.hidden = true; return; }
  if (sel) {
    const b = BAYS[sel];
    box.hidden = false;
    box.innerHTML = `<div class="ih"><b>${esc(b.name)}</b><button class="x" id="infoX" aria-label="닫기">×</button></div>${rowsHtml(b.rows)}`;
    $('infoX').onclick = () => selectBay(null);
    return;
  }
  if (tab === 'pf') { box.hidden = false; renderPf(); return; }
  const t = TAB_INFO[tab];
  if (!t) { box.hidden = true; return; }
  box.hidden = false;
  const chips = (t.bays || []).map((k) => `<button class="chip" data-bay="${k}">${esc(BAYS[k].name)}</button>`).join('');
  box.innerHTML = `<div class="ih"><b>${esc(t.name)}</b></div>${rowsHtml(t.rows)}${chips ? `<div class="chips">${chips}</div>` : ''}`;
}
$('info').addEventListener('click', (e) => {
  const c = e.target.closest('[data-bay]');
  if (c) selectBay(c.dataset.bay);
});

// ── 탭·타일 ──────────────────────────────────────────────────────────
const TILES = {
  sum: (d) => [
    ['alt', '고도', num(d.alt, 1), 'm'],
    ['spd', '대지속도', num(d.groundspeed, 1), 'm/s'],
    ['climb', '상승률', num(d.climb, 1), 'm/s'],
    ['hdg', '헤딩', num(d.hdg), '°'],
  ],
  // 비행 중에 볼 것만 — 높이·속도·오르내림·홈까지·남은 배터리
  fly: (d) => [
    ['alt', '고도', num(d.alt, 1), 'm'],
    ['spd', '대지속도', num(d.groundspeed, 1), 'm/s'],
    ['climb', '상승률', num(d.climb, 1), 'm/s'],
    ['pin', '홈 거리', num(geo.home), 'm'],
    ['bat', '배터리', num(d.batt_pct), '%', lvl(d.batt_pct, 35, 20)],
  ],
  pwr: () => [],
  nav: (d) => [
    ['sat', '위성', num(d.sats), '기', lvl(d.sats, 8, 5)],
    ['pin', '위치 오차', num(d.eph, 1), 'm', lvl(d.eph, 3, 6, false)],
    ['hdg', '헤딩', num(d.hdg), '°'],
  ],
  bat: (d) => [
    ['bat', '잔량', num(d.batt_pct), '%', lvl(d.batt_pct, 35, 20)],
    ['volt', '전압', num(d.volt, 2), 'V'],
    ['cur', '전류', num(d.cur, 1), 'A'],
    ['temp', '온도', num(d.batt_temp, 1), '°C'],
  ],
  rec: () => [
    ['count', '비행 횟수', R ? String(R.n) : '—', '회'],
    ['time', '누적 비행', num(R && R.min), '분'],
    ['alt', '최대 고도', num(R && R.alt, 1), 'm'],
    ['spd', '최대 속도', num(R && R.spd, 1), 'm/s'],
    ['cur', '최대 전류', num(R && R.cur), 'A'],
  ],
  pf: () => [],
};
function renderTiles() {
  html('tiles', mode !== '3d' || !tab ? '' : TILES[tab](D()).map(([ic, l, v, u, c, on]) =>
    `<div class="tile ${c || ''}${on ? ' on' : ''}">${icon(ic)}<b class="num">${v}${u && v !== '—' ? `<small>${u}</small>` : ''}</b><span>${l}</span></div>`).join(''));
  renderCalls();
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  tab = tab === b.dataset.t ? null : b.dataset.t; sel = null;   // 고른 탭을 다시 누르면 풀린다
  for (const x of $('tabs').children) x.classList.toggle('on', x.dataset.t === tab);
  setView(); renderTiles(); renderInfo();
});

// ── 기체 / 지도 ──────────────────────────────────────────────────────
let predLine = null;
let lmap = null, trackLine = null, acMarker = null, homeMarker = null;
let track = [], trkHave = 0, followAt = 0;
const AC_SVG = '<svg viewBox="0 0 32 32" width="34" height="34"><path d="M16 3l3 11 9 3v3l-9-1-1 7 3 2v2l-5-1-5 1v-2l3-2-1-7-9 1v-3l9-3z" fill="#3e6ae1" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>';
async function ensureMap() {
  if (lmap) return;
  if (!window.L) {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = '/vendor/leaflet/leaflet.js'; s.onload = res; s.onerror = rej; document.head.append(s); });
  }
  const L = window.L;
  lmap = L.map('map', { zoomControl: false, attributionControl: true });
  lmap.setView([36.5, 127.8], 7);   // 🔴 레이어 전에 뷰부터 (live.js 와 같은 함정)
  L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 20, maxNativeZoom: 18, attribution: 'Esri World Imagery' }).addTo(lmap);
  trackLine = L.polyline([], { color: '#3e6ae1', weight: 3, opacity: 0.95 }).addTo(lmap);
  predLine = L.polyline([], { color: '#8fb0ff', weight: 5, opacity: 0.9, dashArray: '2 8', lineCap: 'round' }).addTo(lmap);
  acMarker = L.marker([0, 0], { icon: L.divIcon({ className: 'ac', html: AC_SVG, iconSize: [34, 34], iconAnchor: [17, 17] }), interactive: false });
  homeMarker = L.circleMarker([0, 0], { radius: 6, color: '#fff', weight: 2, fillColor: '#171a20', fillOpacity: 1 });
  lmap.on('dragstart', () => { followAt = Date.now(); });
}
function renderMap() {
  if (!lmap) return;
  const d = D();
  trackLine.setLatLngs(track.map((p) => [p[0], p[1]]));
  const dd = D(), pts = [];
  if (pred.show && dd.lat != null) {
    let la = dd.lat, lo = dd.lon, chi = pred.chi;
    pts.push([la, lo]);
    for (let i = 0; i < 20; i++) {   // 10초를 0.5초씩
      chi += pred.omega * 0.5;
      const r = THREE.MathUtils.degToRad(chi), ds = pred.v * 0.5;
      la += ds * Math.cos(r) / 111320; lo += ds * Math.sin(r) / (111320 * Math.cos(la * Math.PI / 180));
      pts.push([la, lo]);
    }
  }
  predLine.setLatLngs(pts);
  const hm = Array.isArray(S.home) ? { lat: S.home[0], lon: S.home[1] } : S.home;
  if (hm && hm.lat != null) homeMarker.setLatLng([hm.lat, hm.lon]).addTo(lmap);
  if (d.lat != null && d.lon != null) {
    acMarker.setLatLng([d.lat, d.lon]).addTo(lmap);
    const el = acMarker.getElement();
    if (el) el.firstChild.style.transform = `rotate(${d.hdg || 0}deg)`;
    // 손으로 끈 뒤 8초는 따라가지 않는다 (live.js 와 같은 규칙)
    if (Date.now() - followAt > 8000) lmap.setView([d.lat, d.lon], Math.max(lmap.getZoom(), 17), { animate: false });
  } else if (track.length) {
    lmap.fitBounds(trackLine.getBounds(), { padding: [40, 40] });
  }
}
async function setMode(m) {
  mode = m;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.m === m);
  document.querySelector('.main').classList.toggle('mapmode', m === 'map');
  if (m === 'map') { await ensureMap(); lmap.invalidateSize(); trkHave = 0; track = []; if (!pb.on) pollLive(true); }
  renderTiles(); renderInfo(); resize();
}
// 기체 / 지도 — 지도는 기체 화면 바닥에 위성사진을 깐다 (satStep)
function setSat(on) {
  sat.on = on;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', (b.dataset.m === 'map') === on);
}
$('modes').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSat(b.dataset.m === 'map'); });

// ── 비행 전 점검 ─────────────────────────────────────────────────────
// preflight.js 와 같은 스트림·암호(sessionStorage pf_pw)를 쓴다.
const pf = { state: 'idle', groups: [], res: {}, prog: {}, verdict: null, error: null, at: null, open: null, bayLevel: {} };
let pfPw = '';
try { pfPw = sessionStorage.getItem('pf_pw') || ''; } catch { /* 사설 모드 */ }
const PF_SECS = 10;
const PF_MARK = { blk: '✖', warn: '▲', ok: '✔', info: '·' };

function pfBayLevels() {
  const out = {};
  for (const g of Object.values(pf.res)) {
    for (const k of PF_BAY[g.name] || []) {
      if (!out[k] || LV_RANK[g.level] > LV_RANK[out[k]]) out[k] = g.level;
    }
  }
  pf.bayLevel = out;
}
function renderPf() {
  const box = $('info');
  let h = '<div class="ih"><b>비행 전 점검</b>' + (pf.at ? `<span class="at">${esc(pf.at.replace('T', ' ').slice(5, 16))}</span>` : '') + '</div>';
  if (pf.verdict) {
    const go = pf.verdict === 'GO';
    h += `<div class="verdict ${go ? 'ok' : 'blk'}">${go ? 'GOOD TO GO' : 'NO GO'}</div>`;
  }
  if (pf.error) {
    h += `<div class="pferr"><b>${esc(pf.error)}</b></div>`;
  }
  if (pf.groups.length) {
    h += '<ol class="pfl">' + pf.groups.map((g) => {
      const r = pf.res[g.name];
      const p = pf.prog[g.name];
      const right = r ? esc(r.verdict) : p > 0 ? Math.round(p * 100) + '%' : '대기';
      const cls = r ? r.level : p > 0 ? 'run' : 'wait';
      let body = '';
      if (r && pf.open === g.name) {
        body = '<div class="pfb">' + (r.items.length ? r.items.map((it) =>
          `<div class="it ${it.level}"><i>${PF_MARK[it.level] || '·'}</i><span>${esc(it.name)}</span><em>${esc(it.detail)}</em></div>`).join('')
          : '<div class="it info"><span>항목 없음</span></div>') + '</div>';
      }
      return `<li class="${cls}" style="--pct:${r ? 100 : Math.round((p || 0) * 100)}%"><button data-g="${esc(g.name)}"><span>${esc(g.label)}</span><b>${right}</b></button>${body}</li>`;
    }).join('') + '</ol>';
  }
  h += `<button class="pfgo" id="pfGo" ${pf.state === 'run' ? 'disabled' : ''}>${pf.state === 'run' ? '점검 중' : pf.verdict || pf.error ? '다시 점검' : '기체 점검'}</button>`;
  box.innerHTML = h;
  $('pfGo').onclick = () => pfRun();
}
$('info').addEventListener('click', (e) => {
  const g = e.target.closest('[data-g]');
  if (!g || !pf.res[g.dataset.g]) return;
  pf.open = pf.open === g.dataset.g ? null : g.dataset.g;
  renderPf();
});

function pfAsk(err) {
  $('pwErr').hidden = !err; $('pwErr').textContent = err || '';
  $('modal').hidden = false; $('pw').value = ''; $('pw').focus();
}
$('pwCancel').onclick = () => { $('modal').hidden = true; };
$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) $('modal').hidden = true; });
$('pwForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('pw').value;
  if (!v) return;
  pfPw = v; $('modal').hidden = true; pfRun();
});

function pfLine(d) {
  if (d.t === 'agent' || d.t === 'start' || d.t === 'done') if (d.at) pf.at = d.at;
  if (d.t === 'start') { pf.groups = d.groups || []; pf.res = {}; pf.prog = {}; }
  else if (d.t === 'prog') Object.assign(pf.prog, d.progress || {});
  else if (d.t === 'group') pf.res[d.group.name] = d.group;
  else if (d.t === 'done') {
    for (const g of d.groups || []) pf.res[g.name] = g;
    if (d.error) pf.error = '점검 실패'; else pf.verdict = d.verdict;
    pf.state = 'done';
  }
  pfBayLevels();
  if (tab === 'pf' && !sel) renderPf();
}

async function pfRun() {
  if (pf.state === 'run') return;
  if (!pfPw) { pfAsk(); return; }
  Object.assign(pf, { state: 'run', groups: [], res: {}, prog: {}, verdict: null, error: null, open: null, bayLevel: {} });
  renderPf();
  try {
    const res = await fetch('/api/preflight/stream?t=' + PF_SECS, { method: 'POST', headers: { 'X-Preflight-Password': pfPw } });
    if (res.status === 401) {
      pfPw = ''; try { sessionStorage.removeItem('pf_pw'); } catch { /* 사설 모드 */ }
      pf.state = 'idle'; renderPf(); pfAsk('암호 오류'); return;
    }
    try { sessionStorage.setItem('pf_pw', pfPw); } catch { /* 사설 모드 */ }
    if (!(res.headers.get('content-type') || '').includes('ndjson')) {
      pf.error = res.status === 409 ? '다른 점검 중' : res.status === 429 ? '잠시 후 재시도' : '점검 실패';
      pf.state = 'done'; renderPf(); return;
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        try { pfLine(JSON.parse(line)); } catch { /* 반쪽 줄 */ }
      }
    }
  } catch (e) {
    pf.error = '연결 실패';
  }
  if (pf.state === 'run') pf.state = 'done';
  if (tab === 'pf' && !sel) renderPf();
}

// ── 로그 재생 ────────────────────────────────────────────────────────
// 서버 재생 엔진(/api/playback/*, drone_live.py)을 그대로 쓴다. 상태가 실시간과
// 같은 모양이라 화면의 모든 칸이 그대로 채워진다 — 여기서는 시각만 넘긴다.
// ⚠️ 재생 세션은 서버에 하나뿐이다 — /live 에서 누가 재생 중이면 그쪽이 바뀐다.
const RATES = [1, 2, 4, 8];
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
// 목록의 `utc` 는 이름과 달리 이미 **한국시간**이다(extract.py 가 +9 해 둔다) — 다시 더하지 않는다.
const fmtWhen = (kst) => { const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(kst || '');
  return m ? `${m[1]}.${m[2]}.${m[3]} ${m[4]}:${m[5]}` : ''; };
const PB_BADGE = { flight: '실비행', hover: '호버', ground: '지상', abort: '즉시 해제', noarm: '시동 없음', unknown: '판정 불가' };
const PB_AUTO = { misn: '미션', rtl: 'RTL' };

async function pbSheet(open) {
  const sh = $('pbSheet');
  sh.hidden = !open;
  if (!open) return;
  sh.innerHTML = '<div class="ih"><b>비행 재생</b><button class="x" id="pbSheetX" aria-label="닫기">×</button></div><div class="pbmsg">불러오는 중</div>';
  $('pbSheetX').onclick = () => pbSheet(false);
  try {
    const rows = (await (await fetch('/api/logs', { cache: 'no-store' })).json())
      .filter((x) => !x.error && !x.corrupt)
      .sort((a, b) => (b.utc || '').localeCompare(a.utc || '') || b.name.localeCompare(a.name));
    if (!rows.length) { sh.querySelector('.pbmsg').textContent = '기록 없음'; return; }
    sh.querySelector('.pbmsg').remove();
    const list = document.createElement('div'); list.className = 'pbl';
    list.innerHTML = rows.map((x) => `<button data-log="${esc(x.name)}" data-utc="${esc(x.utc || '')}">
      <span class="w">${esc(fmtWhen(x.utc) || x.name)}</span><span class="t"><span class="b ${esc(x.badge || '')}">${PB_BADGE[x.badge] || '—'}</span>${(x.auto || []).map((a) => `<span class="b ${esc(a)}">${esc(PB_AUTO[a] || a)}</span>`).join('')}</span>
      <span class="n">${esc(mins(x.duration))}</span><span class="n">${x.alt_max != null ? x.alt_max.toFixed(0) + ' m' : '—'}</span></button>`).join('');
    sh.append(list);
  } catch { sh.querySelector('.pbmsg').textContent = '목록 오류'; }
}
$('pbSheet').addEventListener('click', (e) => {
  const b = e.target.closest('[data-log]');
  if (b) pbStart(b.dataset.log, b.dataset.utc);
});
$('pbBtn').onclick = () => pbSheet($('pbSheet').hidden);   // 재생 중에도 연다 — 고르면 그 파일로 바로 바뀐다

async function pbStart(name, utc) {
  pbSheet(false);
  if (pb.on) await pbStop(true);
  pb.name = name; pb.when = fmtWhen(utc) || name;
  document.querySelector('.main').classList.add('pbmode');
  $('pbBar').hidden = false;
  $('pbName').textContent = pb.when;
  $('pbSeek').disabled = true;
  pb.t = 0; pbSync(); txt('pbTime', '여는 중');
  try {
    const r = await fetch('/api/playback/open?name=' + encodeURIComponent(name), { cache: 'no-store' });
    if (!r.ok) throw new Error();
    for (;;) {   // 큰 로그는 굽는 데 수십 초 걸린다
      await new Promise((z) => setTimeout(z, 400));
      const info = await (await fetch('/api/playback/info', { cache: 'no-store' })).json();
      if (info.state === 'ready') { pb.dur = info.dur; break; }
      if (info.state === 'error') throw new Error();
      if ($('pbBar').hidden) return;   // 기다리는 사이에 닫았다
    }
    const fr = await fetch('/api/playback/frames', { cache: 'no-store' });
    if (!fr.ok) throw new Error();
    pb.fl = await fr.json();
    pb.fl.ix = Object.fromEntries(pb.fl.keys.map((k, c) => [k, c]));
    if ($('pbBar').hidden) return;
  } catch {
    txt('pbTime', '열기 실패');
    return;
  }
  clearTimeout(pollTimer);
  Object.assign(pb, { on: true, t: 0, playing: true, last: performance.now() });
  document.body.classList.add('replay');
  txt('replayWhen', pb.when);
  $('pbName').textContent = pb.when;
  $('pbSeek').disabled = false;
  trkHave = 0; track = [];
  pbTick();
  clearInterval(pb.timer);
  pb.timer = setInterval(pbTick, 200);   // 칸·HUD 는 5 Hz, 기체는 화면 프레임마다(pbAdvance)
}
async function pbStop(keepBar) {
  clearInterval(pb.timer);
  const was = pb.on;
  Object.assign(pb, { on: false, playing: false, fl: null });
  // 다른 로그로 바꿀 때는 닫기가 끝난 뒤 연다 — 안 기다리면 늦게 닿은 닫기가 새 세션을 닫는다
  if (was) { const c = fetch('/api/playback/close').catch(() => {}); if (keepBar) await c; }
  document.body.classList.remove('replay');
  if (!keepBar) { $('pbBar').hidden = true; document.querySelector('.main').classList.remove('pbmode'); }
  // 실시간으로 돌아간다 — 로그의 항적을 지우고 다시 받는다
  S = { live: false, d: {} }; trkHave = 0; track = [];
  render();
  if (!keepBar) pollLive();
}
function pbSync() {
  $('pbPlay').innerHTML = pb.playing ? '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M7 4.5v15l12.5-7.5z"/></svg>';
  $('pbRate').textContent = pb.rate + '×';
  txt('pbTime', mmss(pb.t) + ' / ' + mmss(pb.dur));
  if (!pb.seeking) $('pbSeek').value = String(pb.dur ? Math.round(pb.t / pb.dur * 1000) : 0);
  $('pbSeek').style.setProperty('--p', (pb.dur ? pb.t / pb.dur * 100 : 0) + '%');
}
// 비행 전체(/api/playback/frames)를 열 때 한 번 받아 두고, 두 격자(0.2 s) 사이를 보간한다.
// 폴마다 서버에 묻던 때는 웹 왕복(0.2~0.3 s)이 격자보다 길어 갱신이 초당 2~4번,
// 불규칙하게 왔다 — 기체가 뚝뚝 끊겼다. 위치·자세·속도만 잇고 나머지는 그 칸 값 그대로.
const PB_LERP = ['lat', 'lon', 'alt', 'roll', 'pitch', 'vx', 'vy', 'vz', 'climb', 'groundspeed'];
const PB_ANGLE = ['yaw', 'hdg'];
function pbFrame(t) {
  const F = pb.fl, n = F.rows.length, x = Math.max(0, Math.min(n - 1, t * F.hz)), i = Math.floor(x), u = x - i;
  const a = F.rows[i], b = F.rows[Math.min(n - 1, i + 1)], d = {};
  F.keys.forEach((k, c) => { if (a[c] != null) d[k] = a[c]; });
  if (u > 0) {
    for (const k of PB_LERP) { const c = F.ix[k]; if (c != null && a[c] != null && b[c] != null) d[k] = a[c] + (b[c] - a[c]) * u; }
    for (const k of PB_ANGLE) { const c = F.ix[k]; if (c != null && a[c] != null && b[c] != null) d[k] = (a[c] + unwrap(b[c] - a[c]) * u + 360) % 360; }
  }
  return d;
}
// 재생 시각을 흘리고 기체 값을 채운다 — 화면 프레임마다(frame) 그리고 틱마다 불린다.
function pbAdvance() {
  const now = performance.now(), dt = (now - pb.last) / 1000;
  pb.last = now;
  if (pb.playing && !pb.seeking) {
    pb.t += dt * pb.rate;
    if (pb.t >= pb.dur) { pb.t = pb.dur; pb.playing = false; }
  }
  if (pb.on && pb.fl) { S.d = pbFrame(pb.t); S.pos = pb.t; }
}
function pbTick() {
  pbAdvance();
  pbSync();
  if (!pb.on || !pb.fl) return;
  const F = pb.fl, t = pb.t;
  S = { live: true, playback: true, pos: t, d: S.d, home: F.home, mission: [], messages: F.messages.filter((m) => m.t <= t).slice(-40) };
  track = F.track.filter((p) => p.length > 3 && p[3] <= t).map((p) => [p[0], p[1], p[2]]);
  render();
}
$('pbPlay').onclick = () => { if (!pb.on) return; if (!pb.playing && pb.t >= pb.dur) pb.t = 0; pb.playing = !pb.playing; pb.last = performance.now(); pbSync(); };
$('pbRate').onclick = () => { pb.rate = RATES[(RATES.indexOf(pb.rate) + 1) % RATES.length]; pbSync(); };
$('pbX').onclick = () => pbStop();
$('pbSeek').addEventListener('input', (e) => { pb.seeking = true; pb.t = pb.dur * e.target.value / 1000; pbSync(); });
$('pbSeek').addEventListener('change', () => { pb.seeking = false; pb.last = performance.now(); });

// ── HUD ──────────────────────────────────────────────────────────────
// 자세계는 좌측 패널 남은 높이를 다 채운다 — 상자 비율에 맞춰 보는 창을 늘린다(짧은 변 116).
new ResizeObserver(([e]) => {
  const { width: w, height: h } = e.contentRect;
  if (!w || !h) return;
  const vw = w >= h ? 116 * w / h : 116, vh = w >= h ? 116 : 116 * h / w;
  $('att').setAttribute('viewBox', `${-vw / 2} ${-vh / 2} ${vw} ${vh}`);
  for (const id of ['attClipR', 'attEdge']) {
    const r = $(id); r.setAttribute('x', -vw / 2 + 2); r.setAttribute('y', -vh / 2 + 2);
    r.setAttribute('width', vw - 4); r.setAttribute('height', vh - 4);
  }
  const L = Math.min(60, vw / 2 - 12);   // 기준 막대가 틀 밖으로 안 나가게
  $('attRef').setAttribute('d', `M${-L} 0 H-11 L-6 6 L0 0 L6 6 L11 0 H${L}`);
}).observe(document.querySelector('.hud'));
function renderHud(d) {
  const r = d.roll || 0, p = Math.max(-40, Math.min(40, d.pitch || 0));
  // 지평선 — 1° 가 1.6px. 기체가 오른쪽으로 기울면 지평선은 반대로 돈다
  $('hudHz').style.transform = `rotate(${(-r).toFixed(1)}deg) translateY(${(p * 1.6).toFixed(1)}px)`;
  $('hudRoll').style.transform = `rotate(${(-r).toFixed(1)}deg)`;
}

// ── 계기판 — /live 와 같은 값·같은 판정 (live.js 의 sc·SPREAD·MOT 기준) ──
const SPREAD_WARN = 10, SPREAD_BAD = 20, MAVG_WARN = 65, MAVG_BAD = 75;
function renderStrip(d) {
  const sc = (id, c) => { $(id).className = 'sc' + (c ? ' ' + c : ''); };
  const u = (v, n, unit) => v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(n)}<small>${unit}</small>`;
  html('st-cur', u(d.cur, 1, 'A'));
  sc('sc-cur', d.cur > 56 ? 'bad' : d.cur > 40 ? 'warn' : '');
  const mt = d.motors || {}, vs = ['LF', 'RF', 'LB', 'RB'].map((k) => mt[k]).filter((v) => v != null);
  const spread = vs.length ? Math.max(...vs) - Math.min(...vs) : null;
  const avg = vs.length ? vs.reduce((a, b) => a + b, 0) / vs.length : null;
  html('st-mspread', u(spread, 1, '%p'));
  sc('sc-mspread', spread == null ? '' : spread > SPREAD_BAD ? 'bad' : spread > SPREAD_WARN ? 'warn' : '');
  html('st-mavg', u(avg, 0, '%'));
  sc('sc-mavg', avg == null ? '' : avg > MAVG_BAD ? 'bad' : avg > MAVG_WARN ? 'warn' : '');
  html('st-alt', u(d.alt, 1, 'm'));
  const ft = flightTime(d);
  txt('st-ftime', ft == null ? '—' : mmss(ft));
  const w = fcWarn(), we = $('fcWarn');
  we.hidden = !w;
  if (w) we.textContent = w.text;
}
// 비행 시간 — 시동부터. 재생은 로그에서 처음 시동 걸린 칸을 찾고, 실시간은 시동을 본 순간부터 잰다.
let armT = null;
function flightTime(d) {
  if (pb.on && pb.fl) {
    const F = pb.fl, c = F.ix.armed;
    if (c == null) return null;
    if (F.armT === undefined) { const i = F.rows.findIndex((r) => r[c]); F.armT = i < 0 ? null : i / F.hz; }
    return F.armT != null && S.pos >= F.armT ? S.pos - F.armT : null;
  }
  if (!d.armed) { armT = null; return null; }
  if (armT == null) armT = Date.now() / 1000;
  return Date.now() / 1000 - armT;
}
// FC 경고 — 최근 15초 안의 WARNING 이상 한 줄. 없으면 칸도 없다.
const SEV_N = { EMERG: 0, ALERT: 1, CRIT: 2, ERROR: 3, WARN: 4, WARNING: 4 };
function fcWarn() {
  const ms = S.messages || [], now = pb.on ? S.pos : Date.now() / 1000;
  for (let i = ms.length - 1; i >= 0; i--) {
    const m = ms[i];
    if (now - m.t > 15) break;
    const lv = typeof m.sev === 'number' ? m.sev : m.sev != null ? SEV_N[m.sev] ?? 6 : /^ERR/.test(m.text || '') ? 3 : 6;
    if (lv <= 4 && m.text) return m;
  }
  return null;
}

// 모드 색 — 자동 비행은 파랑, 복귀·정지 계열은 노랑, KILL 은 빨강
const MODE_TONE = { AUTO: 'blue', RTL: 'warn', BRAKE: 'warn' };
// 모드 글자 — 칸에 들어갈 때까지 줄인다 (STABILIZED 같은 긴 이름)
function fitMode() {
  const e = $('mode');
  e.style.fontSize = '';
  for (let f = parseFloat(getComputedStyle(e).fontSize); e.scrollWidth > e.clientWidth && f > 14; f -= 2) e.style.fontSize = f - 2 + 'px';
}
new ResizeObserver(() => fitMode()).observe(document.querySelector('.spd'));
// ── 상태 반영 ────────────────────────────────────────────────────────
function render() {
  const on = !!S.live, d = D();
  updatePred();
  renderHud(d);
  renderStrip(d);
  txt('spd', d.groundspeed != null ? d.groundspeed.toFixed(0) : '0');
  $('spd').classList.toggle('off', d.groundspeed == null);
  const killed = d.system_status === 8;   // KILL — FC 가 비행 종료 상태를 알린다 (스위치·페일세이프)
  const md = killed ? 'KILL' : (d.mode || '—').replace(/^AUTO\./, '');   // AUTO.RTL → RTL
  // RTL — FC 가 스스로 건 것(페일세이프)이면 AUTO.RTL 빨강, 조종사가 건 것이면 MANUAL.RTL 노랑.
  //    재생은 로그의 판단(rtl_auto)을, 실시간은 HEARTBEAT 상태 CRITICAL/EMERGENCY(페일세이프 중)를 본다.
  const rtl = !killed && md === 'RTL', rtlAuto = rtl && (d.rtl_auto != null ? d.rtl_auto : d.system_status === 5 || d.system_status === 6);
  $('mode').className = killed ? 'bad' : rtl ? (rtlAuto ? 'bad' : 'warn') : MODE_TONE[md] || '';
  const mdShown = rtl ? (rtlAuto ? 'AUTO.RTL' : 'MANUAL.RTL') : md;
  if ($('mode').textContent !== mdShown) { txt('mode', mdShown); fitMode(); }
  const arm = $('arm');
  txt('arm', !on ? '연결 없음' : d.armed ? (d.landed === 2 ? '비행 중' : '시동') : '대기');
  arm.className = on && d.armed ? (d.landed === 2 ? 'air' : 'on') : '';
  html('bat', d.batt_pct != null ? d.batt_pct + '<small>%</small>' : '—');
  $('batBox').className = 'bat ' + lvl(d.batt_pct, 35, 20);
  $('batFill').setAttribute('width', d.batt_pct != null ? (21 * Math.max(0, Math.min(100, d.batt_pct)) / 100).toFixed(1) : 0);

  txt('sat', d.sats == null ? '—' : d.eph != null ? `${d.sats} (${d.eph.toFixed(1)})` : String(d.sats));   // 위성 수 (수평 오차 m)
  $('stSat').className = 'st ' + (d.fix != null && d.fix < 3 ? 'bad' : lvl(d.sats, 8, 5));
  $('linkDot').className = 'dot' + (on ? ' on' : '');


  renderTiles();
  if (mode === 'map') renderMap();
}


let pollTimer = 0;
async function pollLive(now) {
  clearTimeout(pollTimer);
  if (pb.on) return;            // 재생 중 — 화면은 로그가 채운다
  try {
    // 지도일 때만 항적을 받는다 — 증분(since)으로, 서버가 앞을 버렸으면 새로 받는다
    const q = mode === 'map' ? `since=${trkHave}` : 'track=0';
    const r = await fetch('/api/live/state?' + q, { cache: 'no-store' });
    if (r.ok) {
      S = await r.json();
      if (mode === 'map' && Array.isArray(S.track)) {
        if (S.track_from === trkHave) track.push(...S.track); else track = S.track.slice();
        trkHave = S.track_n || track.length;
      }
    }
  } catch { S = { live: false, d: {} }; }
  render();
  pollTimer = setTimeout(pollLive, S.live ? 1000 : 4000);
}
async function loadRec() {
  try {
    const r = await fetch('/api/logs', { cache: 'no-store' });
    const rows = (await r.json()).filter((x) => !x.error && !x.corrupt && x.badge && x.badge !== 'ground');
    rows.sort((a, b) => (b.utc || '').localeCompare(a.utc || ''));
    const max = (k) => rows.reduce((m, x) => x[k] != null && x[k] > m ? x[k] : m, 0);
    R = { n: rows.length, min: rows.reduce((s, x) => s + (x.duration || 0), 0) / 60,
      alt: max('alt_max'), spd: max('speed_max'), cur: max('cur_max'), last: rows[0] };
    if (tab === 'rec') renderTiles();
  } catch {}
}
function tick() { const n = new Date(); txt('clk', `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`); }
tick(); setInterval(tick, 5000);
renderInfo(); render(); pollLive(); loadRec(); setInterval(loadRec, 60000);
// 주소로 바로 열기 — /cockpit#pf 점검, #map 지도
if (location.hash === '#pf') document.querySelector('[data-t=pf]').click();
if (location.hash === '#map') setSat(true);
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('modal').hidden) $('modal').hidden = true; else if (!$('pbSheet').hidden) pbSheet(false); else if (sel) selectBay(null); }
  else if (intro && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); launch(); }   // 좁은 창에서 스페이스가 페이지를 내리지 않게
});
