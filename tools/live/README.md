# DRONE01 라이브

USB 로 직결한 이 기체의 상태와 지난 `.BIN` 로그를 브라우저로 본다. **읽기 전용이다** —
FC 로 파라미터·명령을 보내지 않는다 (데이터 스트림 요청뿐).

```bash
./drone-live            # 켠다 → http://localhost:4410
./drone-live off        # 끈다
./drone-live status     # 상태와 꽂힌 USB
```

`drone-live`·`drone-livepush` 는 rim3 의 systemd user 유닛이다. 설치는 [web/README.md](../../web/README.md#rim3).
웹의 실시간(`drone01.shade-signals.com/live`)은 `drone-livepush` 가 이 화면의 `/api/state` 를
1초마다 밀어 올린 것이다.

## 구성

| 파일 | 역할 |
|---|---|
| `drone_live.py` | FC 를 읽어 `/api/state`, `.BIN` 재생 `/api/logs`·`/api/playback/*` |
| `bin_playback.py` | `.BIN` → 재생 프레임 |
| 화면 | `web/live/public/` + `web/public/` (웹 `/live` 와 같은 파일) |

- **FC 는 USB id 로 찾는다** — `/dev/serial/by-id/usb-3D_Robotics*v2*-if00`. 다른 FC 는 안 잡는다.
  붙은 뒤 `mav_type` 이 2(쿼드)가 아니면 로그에 경고를 남긴다.
- 랩서버에서는 `--device none --http 4411` 로 **재생만** 한다 (`drone-playback` 유닛).
  재생 목록은 `DRONE_LOG_DIRS`(콜론 구분, 기본 `flights/`).

## 이 기체에 맞춘 것 (2026-09-16 실측)

- **모터**: `SERVO_OUTPUT_RAW` 의 MAIN1~4 = 우전/CCW · 우후/CW · 좌후/CCW · 좌전/CW
  (`MOTOR_PINS`, `bin_playback.py`·`web/extract.py` 와 같은 값을 유지한다).
- **배터리**: `SYS_STATUS` 를 본다. ArduCopter 3.6.12 는 `BATTERY_STATUS` 를 껍데기로
  보낸다 (current 0 / remaining 100 / voltages 65535).
- **모드**: ArduCopter 모드표(`COPTER_MODE`)로 해석한다.

## 화면 값의 한계

| 항목 | 상태 |
|---|---|
| `rssi` | 늘 0. `RSSI_TYPE=0` 이라 FC 가 RSSI 를 안 읽는다 |
| `eph` | GPS 픽스 전에는 `None` |
| `mah` | `BATTERY_STATUS` 가 채워질 때만. 대개 안 준다 |
| 전류 정확도 | 🔶 `BATT_AMP_PERVLT=18.0` 검증 안 됨 — [00-progress.md](../../docs/procedures/00-progress.md) |

## 포트

| 포트 | 무엇 |
|---|---|
| 4410 | rim3 라이브 (127.0.0.1) |
| 4411 | 랩서버 재생 (127.0.0.1) |
