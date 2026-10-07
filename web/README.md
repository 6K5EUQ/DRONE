# web — drone01.shade-signals.com

DRONE01 의 콕핏·비행로그 사이트. **조회는 공개, 업로드만 공유 암호.**

```
콕핏      https://drone01.shade-signals.com/                    첫 화면 — 3D 기체 + 실시간·기록·점검 (/cockpit 도 같은 페이지)
배송      https://drone01.shade-signals.com/#dlv
목록      https://drone01.shade-signals.com/analysis/log
분석      https://drone01.shade-signals.com/analysis/log/<id>
비교      https://drone01.shade-signals.com/analysis/compare?a=<id>&b=<id>
소개      https://drone01.shade-signals.com/intro
상태      https://drone01.shade-signals.com/api/health
```

2026-10-07 개편: 콕핏을 첫 화면으로 올리고 목록·분석·비교를 `/analysis` 아래로 옮겼다.
옛 `/log/<id>`·`/compare` 는 새 자리로 301 한다. 실시간 화면(`/live`)과 점검 화면(`/preflight`)은
웹에서 뺐다 — 실시간은 콕핏이, 점검은 콕핏 점검 탭이 맡는다.

## 구조

| 파일 | 역할 |
|---|---|
| `server.js` | node 내장만 쓴다. 업로드·카탈로그·캐시·라이브 중계·재생 프록시 |
| `delivery.js` | 교내 배송 — 학교 계정 대리 로그인, 배송 상태머신, 지점 ([설계 02](../docs/design/02-delivery-system.md)) |
| `test/` | 배송 시험 `delivery_test.js` 와 가짜 학교 로그인 서버 `fake_sugang.js` |
| `extract.py` | ArduCopter `.BIN` → 목록 한 줄(`row`) / 요약+시계열(`full`). **유일한 파싱 경로** |
| `public/` | 콕핏·목록·분석·비교·소개 화면, `vendor/`(leaflet·three·inter) |
| `live/public/` | 로컬 실시간 화면 (rim3 의 `drone-live` 가 쓴다. 웹에서는 2026-10-07 제거) |
| `live/livepush.py` | rim3 → 웹 실시간 중계 (한 방향) |
| `model/drone01.py` | 콕핏 3D 모델 정본(Blender 4.5). 결과물 `public/model/drone01.glb` |
| `deploy/` | 랩서버 유닛·터널 설정·`deploy.sh` |

- 모터 매핑 `MOTOR_PINS` 는 `extract.py`·`tools/live/drone_live.py`·`tools/live/bin_playback.py`
  세 곳이 **같아야 한다** (MAIN1~4 = RF·RB·LB·LF, 2026-09-16 실측).
- 콕핏은 노드 이름으로 부품을 찾는다 — `rotor_LF/RF/LB/RB`, `gps`, `bay_battery/fc/power/gps`.
  모델을 고치면 스크립트를 고치고 다시 굽는다:

  ```bash
  ~/tools/blender-4.5.9-linux-x64/blender -b -P web/model/drone01.py -- web/public/model/drone01.glb
  ```
- 판정 임계값: 전류 40/56 A(모터 연속 14 A × 4, docs/design/01), 진동 30/60 m/s².
  🔶 실비행으로 검증 전이다.

## 콕핏 `/`

기체 상태 화면 한 장(`public/cockpit.html`·`cockpit.js`). 값은 `/api/live/state`(실시간)와
`/api/logs`·`/api/playback/*`(기록·재생)에서만 읽는다.

- **첫 화면**은 기체만 크게, 아래 가운데에 SHADE SIGNALS 워드마크. 기체를 누르면 로터를
  올려 **수직으로 떠올라** 사라지고, 대시보드가 열리면 위에서 내려와 착지한다.
  `#pf`·`#map`·`#dlv` 로 열면 건너뛴다.
- **탭**은 기본으로 아무것도 안 고른다. 고른 탭을 다시 누르면 풀린다.
- 상단줄 GPS 는 `위성 수 (수평 오차 m)`. 좌측은 자세계와 계기판(고도·배터리·전류, 모터 X 그림·편차·평균).
- **모터 부하** — 한 모터가 70% 넘으면 노랑, 80% 넘으면 빨강. 좌측 모터 그림과 3D 로터가
  같은 함수(`thr`)를 쓴다. 부품 탭은 로터마다 회전 방향(`ROT_DIR`, MOTOR_PINS 실측과 같다).
- **땅과 홈** — 바닥은 홈에 고정된 땅(무대 1 = 2 m, `G`). 고도만큼 내려가고 이동한 만큼
  흐르며 기수만큼 돈다. 홈에 H 패드, 20 m 넘으면 거리 표지.
- **예측 경로** — 3초 앞까지, 기체 높이에서 상승률만큼 오르내리고 0.5초마다 흰 화살촉.
  높이 떠 있으면 땅에 옅은 그림자와 끝점 선. 0.8 m/s 미만이면 끈다.
- **지도** — 기체/지도 스위치의 지도는 3D 바닥에 위성사진(Esri World Imagery)을 땅 축척으로
  깔고 격자를 걷는다. 진하기·줌은 `cockpit.js` 의 `SAT` (0.70 · 줌 18).
- 워드마크는 `i-brand` 심볼(shade-signals.com 의 wordmark.js 자형) — 첫 화면 아래. 하단 도크(다른 페이지 링크)는 없다.

## 배송

콕핏의 `배송` 탭. 화면은 실시간 콕핏과 같은 3D 다 — `기체/지도` 스위치(격자 바닥 / 위성 바닥)
그대로. 지점은 땅 위 원판과 화면 이름표(거리 포함, 화면 밖이면 그쪽 가장자리)로 뜨고, 이름표를 눌러 고른다.
지점은 **고정 6곳**이고 소스(`delivery.js` 의 `CATALOG` — 이름·좌표·기지)에서만 바뀐다. 관리자 화면·계정은 없다.
기체가 연결돼 있지 않으면 기지를 기준으로 땅을 깐다. 상태·권한은 서버(`delivery.js`)가 정하고 화면은 받은 `can` 의
버튼만 그린다. 설계·상태표는 [설계 02](../docs/design/02-delivery-system.md).

| 라우트 | 쓰임 |
|---|---|
| `POST /api/auth/login {id,pw}` | 학교 계정 대리 로그인 → 쿠키 `__Host-dlv` (12시간). 비번은 저장 안 함 |
| `POST /api/auth/logout` | 쿠키 삭제 |
| `GET /api/delivery/state` | `{rev, service, me, points, job, can}` — 비로그인은 단계만 |
| `POST /api/delivery/act {act, rev, …}` | 호출·보내기·수거완료·취소. 출발·착륙은 기체만(`X-Delivery-Key`) |
| `GET /api/delivery/job` | 기체(Pi)용 일감, `X-Delivery-Key` |
| `GET /api/delivery/who?id=` | 학번 → 이름 (로그인했던 사람만 이름을 안다), 로그인 필요 |

배송·테스트 탭에서는 왼쪽 패널이 바뀐다 — 계기는 고도·남은 거리(상승+수평+하강 경로 전체)·예상 시간(배터리는 위쪽 표시), 자세계 자리에 **고정 크기** 배송 칸(한 줄 상태 **사용 중 / 대기 중 / 사용 불가** + 사용 중인 사람 「이름 (학번)」,
지점 격자, 버튼 한 칸 — 호출(첫 호출·짐 실은 뒤 둘 다) 또는 수거완료, 로그아웃). 상태가 바뀌어도 칸 크기·배치는 그대로고 비활성으로만 바뀐다. 받는 사람은 정하지 않는다. 다른 탭으로 나가면 원래 패널.

**기체 시뮬레이션** — 실제 기체 링크가 붙기 전까지 서버가 기체 몫을 한다(`DELIVERY_SIM=on`, `delivery.js`).
호출 3초 뒤 이륙 → 상승 → 순항고도 직선 → 하강 → 착륙, 위치는 시간만으로 계산되고 `/api/live/state` 로 **모두에게 같은 기체**가
보인다(`live:false`, `sim:true` — 앱의 링크 알림이 진짜 연결로 오인하지 않게). 진짜 기체 신호가 오면 그쪽이 먼저다.
값(순항 30 m, 8 m/s, 상승 2.5 m/s, 하강 1.5 m/s)은 `SIMV` — **시연용이지 운용값이 아니다.**
지점·진행 구간·기체·사용자 이름·학번은 접속한 누구나 본다(내부 공유 드론, 2026-10-07 결정). 동작만 로그인한 사람. 짐을 실은 뒤 대운동장(기지)을 고르면 기지로 보낸다(복귀) —
기지에서 수거완료(또는 대기 초과)면 바로 끝난다.

- POST 는 `application/json` 만, `Origin` 은 같은 Host 나 `DELIVERY_ORIGINS` 만 (CSRF)
- 상태 `DATA_DIR/delivery.json`, 전이 기록 `DATA_DIR/delivery-log.jsonl`
- 시험: `node web/test/delivery_test.js` (가짜 학교 서버로 한 바퀴, 데이터는 임시 폴더)
- 학교 로그인 성공 신호: 성공은 `.ASPXAUTH` 쿠키 발급(2026-10-07 실측, 상태코드는 맞든 틀리든 200). 다시 잴 때 `node tools/delivery/sugang_probe.js <학번>`

| `.env` | 뜻 |
|---|---|
| `SUGANG_URL` | 학교 로그인 주소. **비우면 배송 로그인이 막힌다(503)** |
| `SUGANG_LOGOUT` | 확인 직후 학교 세션을 끊을 주소 (실측 후) |
| `DELIVERY_SERVICE` | `on` 이면 배송 접수. 기본 꺼짐 |
| `DELIVERY_SIM` | `on` 이면 서버가 기체를 시뮬레이션 (실제 링크 전). `SIM_ALT`·`SIM_SPEED`·`SIM_CLIMB`·`SIM_DESC`·`SIM_WAIT` 로 값 조정 |
| `DELIVERY_SECRET` | 쿠키 서명 키. 비우면 재시작 때마다 전원 재로그인 |
| `DELIVERY_KEY` | 기체(Pi)가 act·job 을 부를 키 |
| `DELIVERY_ORIGINS` | 허용 Origin (기본 `https://drone01.shade-signals.com,https://drone01.bewe.co.kr`) |
| `PICKUP_WAIT`·`DEST_WAIT` | 착륙 후 대기 초과 시 복귀, 초 (기본 300·600, 운영값) |

## 포트

| 곳 | 포트 | 무엇 |
|---|---|---|
| 랩서버 | 4310 | `lab-drone01` (node) |
| 랩서버 | 4411 | `drone-playback` (`drone_live.py --device none`) |
| rim3 | 4410 | `drone-live` (FC USB) |

## 로컬에서 돌리기

```bash
python3 -m venv --without-pip .venv && curl -sS https://bootstrap.pypa.io/get-pip.py | .venv/bin/python
.venv/bin/pip install -r web/requirements.txt
cd web && PORT=4310 UPLOAD_PASSWORD=x node server.js      # 로그는 web/data/logs/*.BIN
```

## 서버 설치 (ku-labserver, 최초 1회)

```bash
ssh ku@100.86.239.31
git clone https://github.com/6K5EUQ/DRONE.git ~/DRONE
python3 -m venv --without-pip ~/drone01-venv
curl -sS https://bootstrap.pypa.io/get-pip.py | ~/drone01-venv/bin/python
~/drone01-venv/bin/pip install -r ~/DRONE/web/requirements.txt
mkdir -p ~/drone01-data/logs

# .env — 암호는 여기서 만들고 커밋하지 않는다
cat > ~/DRONE/web/.env <<EOF
PORT=4310
DATA_DIR=/home/ku/drone01-data
PARSE_PYTHON=/home/ku/drone01-venv/bin/python
DRONE_PLAYBACK_PORT=4411
UPLOAD_PASSWORD=<업로드 암호>
LIVE_PUSH_KEY=<rim3 livepush 와 같은 값>
EOF
chmod 600 ~/DRONE/web/.env

sudo cp ~/DRONE/web/deploy/lab-drone01.service ~/DRONE/web/deploy/lab-tunnel-drone01.service /etc/systemd/system/
mkdir -p ~/.config/systemd/user && cp ~/DRONE/web/deploy/drone-playback.service ~/.config/systemd/user/
sudo systemctl daemon-reload && sudo systemctl enable --now lab-drone01
systemctl --user daemon-reload && systemctl --user enable --now drone-playback

# 터널 — 도메인마다 따로
~/.local/bin/cloudflared tunnel create drone01
sed "s/REPLACE_WITH_TUNNEL_UUID/<UUID>/g" ~/DRONE/web/deploy/config-drone01.yml > ~/.cloudflared/config-drone01.yml
# DNS 는 `cloudflared tunnel route dns` 로 만들지 마라 — 서버 cert.pem 이 bewe.co.kr 존이라 잘못 만든다.
# Cloudflare API 로 CNAME drone01.shade-signals.com → <UUID>.cfargotunnel.com (proxied). 절차: 랩서버 ~/shade-signals/DEPLOY.md §4.4
sudo systemctl enable --now lab-tunnel-drone01
```

점검(콕핏 점검 탭)은 `.env` 에 `PREFLIGHT_KEY`·`PREFLIGHT_PASSWORD`·`PREFLIGHT_AGENTS` 가
있어야 켜진다. 에이전트는 아직 없다 — 탭은 뜨고 점검만 막힌다.

## 배포 (이후)

```bash
ssh ku@100.86.239.31 'cd ~/DRONE && ./web/deploy/deploy.sh'
```

## rim3

```bash
python3 -m venv --without-pip ~/DRONE/.venv && curl -sS https://bootstrap.pypa.io/get-pip.py | ~/DRONE/.venv/bin/python
~/DRONE/.venv/bin/pip install -r ~/DRONE/web/requirements.txt
echo "LIVE_PUSH_KEY=<서버 .env 와 같은 값>" > ~/.config/drone-live.env && chmod 600 ~/.config/drone-live.env
cp ~/DRONE/web/live/drone-live.service ~/DRONE/web/live/drone-livepush.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now drone-live drone-livepush
```

켜고 끄기는 `tools/live/drone-live [on|off|status]`. FC USB 는 하나라 QGC·로그 내려받기·
점검 전에는 `off`, 끝나면 `on`.

## 장애 대응

| 증상 | 확인 | 대응 |
|---|---|---|
| 500 / 페이지 안 뜸 | `systemctl status lab-drone01`, `tail ~/drone01-data/server.log` | `sudo systemctl restart lab-drone01` |
| 502 / 도메인만 죽음 | `systemctl status lab-tunnel-drone01` | 터널만 재시작 |
| 전부 "파싱 실패" | `/api/health` | venv 가 깨졌다. 설치 venv 단계 다시 |
| 업로드 401 | `.env` 의 `UPLOAD_PASSWORD` | 비어 있으면 업로드가 막힌다 |
| 재생 503 | `systemctl --user status drone-playback` | 재시작 |
| 실시간 안 뜸 | rim3 `tools/live/drone-live status` | FC USB·`drone-livepush` 키 확인 |
