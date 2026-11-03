// ── 공간 뷰 — 기체 화면(THREE)에 브이월드 데이터만 얹는다 [globe]
// SHADE01 web/public/cockpit-globe.js 에서 가져왔다 (2026-11-03). 미션 선은 뺐다 — 이 콕핏의 3D 에는 미션이 없다.
// 기체·카메라·자세·로터는 기체 뷰 그대로다. 여기서는 땅(우리 DEM + 브이월드 위성사진),
// 브이월드 실사 3D 건물(3D Tiles), 항적 선만 world 안에 그린다.
// 타일은 브라우저가 브이월드에서 직접 받는다 — 서버에 저장하지 않는다(약관).
//
// 좌표는 world 와 같다 — x = -동, z = 북, 1 m = G. 높이는 해발(m)을 그대로 쓴다
// (브이월드 건물 바닥이 해발 기준, DEM 과 중앙값 −4 m — SHADE01 실측). 땅 기준점(base)의 지면이 FLOOR 다.
import * as THREE from 'three';
import { TilesRenderer, GLTFExtensionsPlugin, UpdateOnChangePlugin, LRUCache, DRACOLoader, KTX2Loader } from '/vendor/3d-tiles/tiles.module.js?v=2';   // 번들이 바뀌면 올린다 — vendor 는 7일 캐시

const VW_SAT = (key, z, x, y) => `https://api.vworld.kr/req/wmts/1.0.0/${key}/Satellite/${z}/${y}/${x}.jpeg`;
const VW_BUILDINGS = 'https://cdn.vworld.kr/TDServer/services/map4/TG9ENA.json';
// 🔧 땅 두 겹 — 넓고 거친 판 위에 기체 둘레만 선명한 판
const LAYERS = [
  { zoom: 16, half: 2000, seg: 128 },   // 4 km, ≈ 2 m/px
  { zoom: 18, half: 320, seg: 40 },     // 640 m, ≈ 0.5 m/px
];
const REBUILD_M = 100;   // 홈이 이만큼 옮겨지면 땅을 새로 깐다

export function createGlobe({ parent, camera, renderer, G, FLOOR, demAt, key }) {
  const root = new THREE.Group(); root.visible = false; parent.add(root);
  let base = null;   // { lat, lon, h, kE, kN } — 땅을 깐 기준점
  const layers = [];
  let imgs = [];     // 받는 중인 위성 타일 — 새로 깔면 끊는다

  // 위경도·해발 → base 기준 로컬 (x = -동, z = 북)
  const local = (lat, lon, h, out) => out.set(-(lon - base.lon) * base.kE * G, (h - base.h) * G, (lat - base.lat) * base.kN * G);

  // hole — 선명한 판이 덮는 자리(반폭 m). 거친 판은 그 안을 비우고 둘레를 낮춰, 높이가 어긋난 곳에서 흐린 판이 뚫고 올라오지 않게 한다
  function buildLayer({ zoom, half, seg }, order, hole) {
    const n = 2 ** zoom, T = 256, rad = Math.PI / 180;
    const tx = (lon) => (lon + 180) / 360 * n, ty = (lat) => (1 - Math.asinh(Math.tan(lat * rad)) / Math.PI) / 2 * n;
    const dLat = half / base.kN, dLon = half / base.kE;
    const x0 = Math.floor(tx(base.lon - dLon)), x1 = Math.floor(tx(base.lon + dLon));
    const y0 = Math.floor(ty(base.lat + dLat)), y1 = Math.floor(ty(base.lat - dLat));
    const W = x1 - x0 + 1, H = y1 - y0 + 1;
    const c = document.createElement('canvas'); c.width = W * T; c.height = H * T;
    const g = c.getContext('2d');
    g.fillStyle = '#8a8d86'; g.fillRect(0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 8;   // 공간 뷰와 같게
    // 올리기는 모아서 — 캔버스(최대 ≈26 MB)를 사진 한 장마다 GPU 로 다시 보내지 않는다. 0.25초에 한 번, 마지막 장에 한 번
    let left = W * H, upAt = 0, upT = 0;
    const up = () => { clearTimeout(upT); upT = 0; upAt = performance.now(); tex.needsUpdate = true; };
    const done = () => {
      if (--left === 0) up();
      else if (!upT) upT = setTimeout(up, Math.max(0, 250 - (performance.now() - upAt)));
    };
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const img = new Image(); img.crossOrigin = 'anonymous';
      img.onload = () => { g.drawImage(img, i * T, j * T); done(); };
      img.onerror = done;
      img.src = VW_SAT(key, zoom, x0 + i, y0 + j);
      imgs.push(img);
    }
    tex.userData.stop = () => clearTimeout(upT);
    // 판 — DEM 높이로 굽고, 위경도로 사진을 맞춘다
    const N = seg + 1, pos = new Float32Array(N * N * 3), uv = new Float32Array(N * N * 2), v = new THREE.Vector3();
    for (let r = 0; r < N; r++) for (let q = 0; q < N; q++) {
      const lat = base.lat + dLat * (1 - 2 * r / seg), lon = base.lon + dLon * (2 * q / seg - 1);
      let h = demAt(lat, lon); if (h == null) h = base.h;
      if (hole && Math.max(Math.abs(2 * q / seg - 1), Math.abs(1 - 2 * r / seg)) * half <= hole + 2 * half / seg + 1e-6) h -= 3;
      local(lat, lon, h, v);
      const k = r * N + q;
      pos.set([v.x, v.y + FLOOR, v.z], k * 3);
      uv.set([(tx(lon) - x0) / W, 1 - (ty(lat) - y0) / H], k * 2);
    }
    const ix = [];
    for (let r = 0; r < seg; r++) for (let q = 0; q < seg; q++) {
      const a = r * N + q, b = a + 1, d = a + N, e = d + 1;
      if (hole && Math.max(Math.abs(2 * q / seg - 1), Math.abs(2 * (q + 1) / seg - 1), Math.abs(1 - 2 * r / seg), Math.abs(1 - 2 * (r + 1) / seg)) * half < hole) continue;
      ix.push(a, b, d, b, e, d);
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geom.setIndex(ix);
    const mat = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -order, polygonOffsetUnits: -4 * order });
    const m = new THREE.Mesh(geom, mat); m.renderOrder = -3 + order; m.frustumCulled = false;
    root.add(m);
    return m;
  }

  // 건물 — 브이월드 3D Tiles. 지구 중심 좌표(ECEF)를 base 의 동·북·위로 돌려 world 축척에 맞춘다
  const tiles = new TilesRenderer(VW_BUILDINGS);
  // 텍스처는 KTX2 뿐이다 — 같이 든 PNG 는 1×1 자리표시 (2026-11-03 b3dm 확인).
  // 트랜스코더는 eval 이 필요해 페이지 CSP 를 물려받는 blob 워커로는 못 돈다 — 첫 워커를 만들기 전에
  // 주소를 cockpit-globe-ktx2.js 로 바꿔 끼운다 (이 then 이 텍스처 요청보다 먼저 걸린다)
  const ktx = new KTX2Loader().setTranscoderPath('/vendor/three/addons/libs/basis/').detectSupport(renderer);
  ktx.init().then(() => { ktx.workerSourceURL = '/cockpit-globe-ktx2.js?src=' + encodeURIComponent(ktx.workerSourceURL); });
  tiles.registerPlugin(new GLTFExtensionsPlugin({
    dracoLoader: new DRACOLoader().setDecoderPath('/vendor/three/addons/libs/draco/gltf/'),
    ktxLoader: ktx,
  }));
  tiles.registerPlugin(new UpdateOnChangePlugin());   // 카메라·건물 자리가 그대로고 받을 것도 없으면 순회를 건너뛴다
  tiles.errorTarget = 20;   // 기본 16 — 조금 거칠게
  // 캐시는 이 렌더러 몫으로 — 기본(공유, 0.3~0.4 GB)은 휴대폰에 크다. 첫 update 전에만 바꿀 수 있다
  const lru = new LRUCache();
  lru.unloadPriorityCallback = tiles.lruCache.unloadPriorityCallback;
  lru.minBytesSize = 100 * 2 ** 20; lru.maxBytesSize = 150 * 2 ** 20;
  tiles.lruCache = lru;
  tiles.setCamera(camera);
  let placed = false;
  const camV = new THREE.Vector3();
  const bG = new THREE.Group(); bG.matrixAutoUpdate = false; bG.add(tiles.group); root.add(bG);

  function rebuild(lat, lon, h) {
    for (const im of imgs) { im.onload = im.onerror = null; im.src = ''; }   // 옛 판의 받는 중인 사진은 끊는다
    imgs = [];
    for (const m of layers) { root.remove(m); m.material.map.userData.stop(); m.geometry.dispose(); m.material.map.dispose(); m.material.dispose(); }
    layers.length = 0;
    const kN = 111320;
    base = { lat, lon, h, kN, kE: kN * Math.cos(lat * Math.PI / 180) };
    LAYERS.forEach((L, i) => layers.push(buildLayer(L, i, i ? 0 : LAYERS[1].half)));
    for (const m of layers) m.visible = bG.visible;
    const enu = tiles.ellipsoid.getEastNorthUpFrame(lat * Math.PI / 180, lon * Math.PI / 180, h, new THREE.Matrix4());
    const toWorld = new THREE.Matrix4().set(-G, 0, 0, 0, 0, 0, G, FLOOR, 0, G, 0, 0, 0, 0, 0, 1);
    bG.matrix.multiplyMatrices(toWorld, enu.invert());
    bG.matrixWorldNeedsUpdate = true;
    trkWrite(0);
  }

  // 항적 — 해발 점 [lat, lon, h]
  const trkLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x8fb0ff }));
  trkLine.frustumCulled = false; root.add(trkLine);
  // 항적은 뒤에 붙이기만 한다 — 버퍼를 넉넉히 잡아 두고 새 점만 바꿔 쓴다. 다 차면 두 배로
  const trkPts = [], trkV = new THREE.Vector3();
  let trkA = new THREE.BufferAttribute(new Float32Array(3 * 4096), 3).setUsage(THREE.DynamicDrawUsage);
  trkLine.geometry.setAttribute('position', trkA); trkLine.geometry.setDrawRange(0, 0);
  function trkWrite(from) {
    if (!base) return;
    const n = trkPts.length;
    if (n * 3 > trkA.array.length) {
      const a = new Float32Array(Math.max(n * 3, trkA.array.length * 2));
      a.set(trkA.array.subarray(0, from * 3));
      trkLine.geometry.dispose();   // 옛 GPU 버퍼를 놓는다
      trkA = new THREE.BufferAttribute(a, 3).setUsage(THREE.DynamicDrawUsage);
      trkLine.geometry.setAttribute('position', trkA);
    } else if (n > from) trkA.addUpdateRange(from * 3, (n - from) * 3);
    for (let i = from; i < n; i++) { const p = trkPts[i]; local(p[0], p[1], p[2], trkV); trkA.setXYZ(i, trkV.x, trkV.y, trkV.z); }
    if (n > from) trkA.needsUpdate = true;
    trkLine.geometry.setDrawRange(0, n);
  }
  function setTrack(pts) { trkPts.length = 0; trkPts.push(...pts); trkWrite(0); }
  function addTrack(pts) { const k = trkPts.length; trkPts.push(...pts); trkWrite(k); }

  return {
    setTrack, addTrack,
    showTrack(on) { trkLine.visible = on; },
    // 끌 때 — 받은 건물은 두고, 줄 서 있거나 받는·푸는 중인 것만 버린다. 켤 때는 한 번 다시 순회
    setActive(on) {
      root.visible = on;
      if (on) tiles.dispatchEvent({ type: 'needs-update' });
      else for (const t of [...tiles.loadingTiles]) tiles.lruCache.remove(t);
    },
    // 매 프레임, 기체 행렬 갱신 전 — ref: 홈(없으면 비행장) [lat, lon], hx·hz: world 안의 홈 자리
    place(ref, hx, hz) {
      const hRef = demAt(ref[0], ref[1]);
      placed = hRef != null;
      if (!placed) return;   // DEM 이 아직 안 왔다
      if (!base || Math.hypot((ref[0] - base.lat) * base.kN, (ref[1] - base.lon) * base.kE) > REBUILD_M) rebuild(ref[0], ref[1], hRef);
      root.position.set(hx - (base.lon - ref[1]) * base.kE * G, (base.h - hRef) * G, hz + (base.lat - ref[0]) * base.kN * G);
    },
    // 매 프레임, 카메라를 맞춘 뒤 — 행렬은 콕핏이 craft.updateMatrixWorld 로 이미 갱신했다
    update() {
      if (!placed) return;
      camera.updateMatrixWorld();
      // 카메라가 그 자리 지면 밑이면 땅·건물을 숨긴다 — 밑에서는 기체·꼬리·항적·미션만 보인다
      root.worldToLocal(camV.setFromMatrixPosition(camera.matrixWorld));
      const g = demAt(base.lat + camV.z / G / base.kN, base.lon - camV.x / G / base.kE);
      const show = camV.y >= FLOOR + ((g == null ? base.h : g) - base.h) * G;
      if (bG.visible !== show) { bG.visible = show; for (const m of layers) m.visible = show; }
      tiles.setResolutionFromRenderer(camera, renderer);
      tiles.update();
    },
  };
}
