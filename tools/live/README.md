# DRONE 라이브 화면

USB 로 직결한 이 기체의 상태를 브라우저로 본다. **읽기 전용이다** — FC 로
파라미터·명령을 보내지 않는다.

```bash
./drone-live            # 켠다 → http://localhost:4401
./drone-live off        # 끈다 (멈췄던 shade-bridge 도 되돌린다)
./drone-live status     # 지금 뭐가 꽂혔나
```

---

## 🔴 왜 SHADE01 live 를 안 쓰고 따로 만들었나

`~/SHADE01/web/live/mav_live.py` 로 이 기체를 보면 **조용히 틀린 화면**이 나온다.
2026-09-16 에 규명한 것이 둘이다.

### 1. 모터 두 개가 안 뜬다

SHADE01 은 모터를 **MAIN3/4/6/7** 에서 읽는다. 그것은 VTOL 의 출력 배치다.
이 기체는 ArduCopter 쿼드라 **MAIN1~4** 다. 겹치는 3,4 만 그려지고 나머지
둘은 `—` 로 비었다 — **모터가 안 도는 것처럼 보였다.**

같은 시각 FC 를 직접 읽은 값은 이렇다 — 넷 다 살아 있었다:

```
SERVO_OUTPUT_RAW: M1=1443  M2=1500  M3=1541  M4=1396   — 2026-09-16 실측
```

### 2. 배터리가 늘 100 % / 0.0 A 로 나온다

SHADE01 은 `BATTERY_STATUS` 를 **우선**한다 (PX4 + PM08 DroneCAN 전제).
ArduCopter 3.6.12 는 이 메시지를 **껍데기로** 보낸다:

```
BATTERY_STATUS: current 0 / remaining 100 / voltages 전부 65535   — 2026-09-16 실측
SYS_STATUS    : voltage 14811 mV / current 13 / remaining 98      — 2026-09-16 실측
```

이 기체는 **`SYS_STATUS` 가 정본**이다. `drone_live.py` 는 그쪽을 읽는다.

### 3. 모드명이 틀린다

SHADE01 은 PX4 모드 표로 해석한다. 화면에 `MANUAL` 로 떴지만 실제 모드는
**STABILIZE** 였다. ArduCopter 는 `custom_mode` 가 곧 모드 번호다.

> 섞으면 CLAUDE.md 가 금지한 "다른 기체 값을 이 기체 것처럼 쓰기" 가 된다.
> 그래서 SHADE01 코드는 **한 줄도 건드리지 않았다.**

---

## 무엇을 공유하고 무엇을 안 하나

| | 출처 |
|---|---|
| 파싱 (백엔드) | **이 디렉터리** `drone_live.py` — 이 기체 전용 |
| 화면 (HTML/CSS/JS) | `~/SHADE01/web/live/public/` 을 **읽어 쓴다** |

화면 자산을 공유하는 것은 JSON 스키마가 같기 때문이다. 화면이 바뀌면 이쪽도
같이 바뀐다 — 그것이 의도다. 다른 경로를 쓰려면 `--public` 으로 준다.

---

## 자동 인식

`drone-live` 가 `/dev/serial/by-id/` 를 보고 기체를 가린다
(CLAUDE.md 「USB 포트를 SHADE01 과 공유한다」의 구분법 그대로):

| by-id | 기체 | 결과 |
|---|---|---|
| `3D_Robotics...v2.x` | **DRONE** | 켠다 |
| `Auterion...v6C.x` | SHADE01 | 거부하고 4400 을 쓰라고 안내 |
| 그 외 | 불명 | 거부. `FORCE=1` 로 무시 가능 |

붙은 뒤에도 `mav_type` 을 한 번 더 본다. 2(쿼드)가 아니면 로그에 경고를 남긴다.

---

## 🔴 USB 포트 공유

포트는 하나다. `shade-bridge.service` 가 `/dev/ttyACM0` 를 잡고 있으면 이
스크립트가 못 붙는다.

- `./drone-live` 는 브리지가 떠 있으면 **자동으로 멈추고** 그 사실을 표시해 둔다
- `./drone-live off` 가 **되돌린다**

🔴 끄지 않고 자리를 뜨면 다른 PC 의 QGC 가 조용히 안 붙는다. 반드시
`off` 로 끝내라. 수동 복구는 이것이다:

```bash
systemctl --user start shade-bridge.service
```

---

## 포트

| 포트 | 무엇 |
|---|---|
| 4400 | SHADE01 live (기존) |
| **4401** | **DRONE live (이것)** |

둘 다 `127.0.0.1` 만 듣는다. 단, **FC USB 는 하나라 동시에 둘을 띄울 수 없다.**

---

## 지원하지 않는 것

SHADE01 화면에 있는 기능 중 이 서버가 안 하는 것:

- **로그 재생** — `/api/logs`, `/api/playback` 이 "지원하지 않는다" 를 답한다.
  이 기체의 `.BIN` 로그 분석은 `pymavlink` 로 따로 한다 (CLAUDE.md 「도구」)
- **링크 고정** — 경로가 USB 하나뿐이라 고를 것이 없다
- **미션 표시** — 아직 미션이 없다

---

## 화면 값의 한계

| 항목 | 상태 |
|---|---|
| `rssi` | 늘 0. 이 기체는 `RSSI_TYPE=0` 이라 FC 가 RSSI 를 안 읽는다 |
| `eph` | GPS 픽스 전에는 `None`. 9999 를 99.99 m 로 그리지 않는다 |
| `mah` | `BATTERY_STATUS` 가 채워질 때만. ArduCopter 3.6.12 는 대개 안 준다 |
| 전류 정확도 | 🔶 `BATT_AMP_PERVLT=18.0` 이 이 기체에서 **검증 안 됨**. [00-progress.md](../../docs/procedures/00-progress.md) 미해결 항목 |

---

## 실행 환경

`pymavlink` 가 필요하다. 기본은 `~/.venv-mav/bin/python` 을 쓴다
(`MAV_PYTHON` 으로 바꿀 수 있다).
