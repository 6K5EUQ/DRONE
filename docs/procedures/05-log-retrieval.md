# 절차 05 — 비행 로그 회수와 재생

비행이 끝난 뒤 FC 의 로그를 PC 로 받아 브라우저로 다시 보는 절차.

작성 2026-09-17. **이 절차는 실제로 수행해 검증했다** — 09-16 실내 비행
로그 5개(ID 12~16)를 이 방법으로 받아 재생까지 했다.

> 전제: 이 기체는 **ArduCopter 3.6.12**(ArduPilot)다. 로그는 `.BIN` 이다.
> PX4 `.ulg` 가 아니다 — 도구가 완전히 다르다. [CLAUDE.md](../../CLAUDE.md) 참조.

---

## 🔴 먼저 알 것 — 이 기체의 제약 세 가지

### 1. SHADE01 웹(shade01.bewe.co.kr)에는 못 올린다

그 서버는 **PX4 `.ulg` 전용**이다. 확인한 것(2026-09-16):

- `web/extract.py`·`web/tools/uploadable.py` 가 `pyulog` 로만 읽는다
- `outdoor_enough()` 가 **위성 15기 이상 · eph 1.0 m 이하**를 요구한다 —
  실내 로그는 자동으로 거부된다 (이 기체 로그는 전부 GPS fix=1·위성 0)
- 기체 구분이 없어 SHADE01 비행 이력에 섞인다

억지로 넣으면 "잘린 메시지에서 조용히 멈추는" 장애 이력이 그쪽 주석에 있다.
→ **그래서 이 저장소에 따로 만들었다** (아래 C·D 항).

### 2. FC 에 시계(RTC)가 없다

`LOG_ENTRY.time_utc` 가 **2000-01-01 근처**로 찍힌다 (2026-09-16 실측).
**"언제 찍힌 로그인가"를 시각으로 고를 수 없다.** ID 번호가 클수록 새것이다.

어느 ID 부터가 이번 비행인지는 **직전에 받아 둔 목록과 대조**해서 안다.
`flights/` 에 이미 있는 것과 크기가 같으면 예전 것이다.

### 3. USB 포트는 하나다

`/dev/ttyACM0` 를 **한 프로그램만** 쓸 수 있다. 로그를 받으려면
`shade-bridge`·`drone-live`·QGC 를 전부 내려야 한다.

```bash
fuser -v /dev/ttyACM0      # 누가 쥐고 있나
```

---

## A. 준비 — 포트 비우기

- [ ] FC 를 USB 로 PC 에 직결한다
- [ ] 꽂힌 것이 DRONE 인지 확인한다

```bash
ls /dev/serial/by-id/
#  usb-3D_Robotics_PX4_FMU_v2.x_*  → DRONE (Pixhawk 2.4.8)  ✅
#  usb-Auterion_PX4_FMU_v6C.x_*    → SHADE01 (건드리지 마라)
```

- [ ] 포트를 쥔 것을 내린다

```bash
systemctl --user stop shade-bridge.service
cd ~/DRONE/tools/live && ./drone-live off
# QGC 가 떠 있으면 종료한다
fuser -v /dev/ttyACM0          # 아무것도 안 나와야 한다
```

⚠️ `shade-bridge` 는 `Restart=always` 라 **재부팅·재로그인하면 혼자 다시 뜬다.**
받다가 갑자기 실패하면 이것부터 다시 확인한다.

---

## B. 로그 목록 받기

```bash
~/.venv-mav/bin/python ~/DRONE/tools/loglist.py
```

출력 예 (2026-09-16 실측):

```
  ID    크기(bytes)    time_utc(raw)
   1       869950        946685484
  ...
  11      2453502        946686876
  12       218150        946687150
  ...
  16       278698        946685106
```

- [ ] **총 개수와 수신 개수가 같은지** 확인한다 (한 번에 다 안 올 때가 있어
      스크립트가 3회 재시도한다)
- [ ] `flights/` 의 기존 파일과 **크기를 대조**해 새 ID 를 가린다

```bash
ls -l ~/DRONE/flights/*/*.BIN
```

🔴 **`time_utc` 로 고르지 마라.** 위 예에서 ID 13 이 ID 14 보다 큰 숫자를
갖지만 실제로는 나중 것이다 — RTC 가 없어서 나온 무의미한 값이다.

---

## C. 로그 내려받기

ID 와 **크기를 그대로** 넣는다. 크기가 틀리면 파일이 깨진다.

```bash
mkdir -p ~/DRONE/flights/sd-recovered-$(date +%Y%m%d)
cd ~/DRONE

for pair in "12:218150" "13:317285" "14:813672"; do
  id="${pair%%:*}"; size="${pair##*:}"
  ~/.venv-mav/bin/python tools/logdl.py "$id" "$size" \
      "flights/sd-recovered-$(date +%Y%m%d)/$(printf '%08d' $id).BIN"
done
```

- [ ] 각 파일이 **100 %** 로 끝났는지 본다

⚠️ **큰 로그는 실패할 수 있다.** ID 11(2.45 MB)은 USB 가 중간에 끊겨
못 받았다 (2026-09-16). 작은 것부터 받고, 실패하면 포트를 다시 비우고
그 하나만 재시도한다.

### 🔴 받은 파일은 반드시 검증한다

크기만 맞고 내용이 깨져 있을 수 있다.

```bash
cd ~/DRONE/flights/sd-recovered-YYYYMMDD
for f in *.BIN; do
  ~/.venv-mav/bin/python -c "
from pymavlink import mavutil
m = mavutil.mavlink_connection('$f'); n=0; fw=None
while True:
    try: msg=m.recv_match()
    except Exception: continue
    if msg is None: break
    n+=1
    if msg.get_type()=='MSG' and 'ArduCopter' in msg.Message: fw=msg.Message
print('$f', n, '메시지', fw)
"
done
```

- [ ] 메시지 수가 수천 개 이상인가
- [ ] 펌웨어 문자열이 `ArduCopter V3.6.12 (cb570c06)` 로 나오는가

둘 중 하나라도 아니면 **다시 받는다.**

---

## D. 브라우저로 재생하기

```bash
cd ~/DRONE/tools/live && ./drone-live
# → http://localhost:4401
```

화면 아래 **「재생」** 을 누르면 `~/DRONE/flights/` 안의 `.BIN` 이 전부 뜬다.
하나를 고르면 스크럽바로 앞뒤로 감으며 볼 수 있다.

- [ ] 좌하단 링크 표시가 **`LOG`** 로 바뀌는가 (라이브면 `usb` 다)
- [ ] 시각을 옮기면 계기·모터·차트가 **실제로 변하는가**

🟢 **FC 가 안 꽂혀 있어도 재생은 된다** (2026-09-17 부터).
"FC 가 안 꽂혀 있다 — 라이브 없이 켠다" 가 뜨면 정상이다.

### 끝나면 되돌린다

```bash
cd ~/DRONE/tools/live && ./drone-live off    # shade-bridge 도 같이 복구된다
systemctl --user is-active shade-bridge.service   # active 확인
```

---

## E. 화면에서 보이는 값과 그 출처

라이브는 MAVLink 메시지를, 재생은 `.BIN` 로그를 읽는다. **원천이 다르므로
같은 칸이라도 나오는 방식이 다르다.**

| 화면 | 라이브 출처 | 재생 출처(`.BIN`) | 비고 |
|---|---|---|---|
| 자세 | `ATTITUDE` | `ATT.Roll/Pitch/Yaw` | 로그는 이미 도(°) 단위다 |
| 모터 | `SERVO_OUTPUT_RAW` | `RCOU.C1~C4` | MAIN1~4 |
| 전압·전류 | `SYS_STATUS` | `BAT.Volt/Curr` | |
| 고도 | `GLOBAL_POSITION_INT` | `CTUN.Alt` | 기압계 기준 상대고도 |
| 상승률 | `VFR_HUD.climb` | `CTUN.CRt` | 로그는 cm/s 라 100 으로 나눈다 |
| 속도 | `VFR_HUD.groundspeed` | `GPS.Spd` | 실내면 0 |
| 위성·fix | `GPS_RAW_INT` | `GPS.NSats/Status` | |
| 비행모드 | `HEARTBEAT.custom_mode` | `MODE.Mode` | |
| ARM 여부 | `HEARTBEAT.base_mode` | `EV.Id` 10=ARM, 11=DISARM | |

### 🔴 배터리 %는 로그에 없다 — 계산한 값이다

`.BIN` 에는 `SYS_STATUS.battery_remaining` 에 해당하는 필드가 **없다**
(2026-09-17 확인). 그래서 `BAT.CurrTot`(FC 가 적분한 누적 소모 mAh)와
`BATT_CAPACITY=2900` 으로 계산한다.

⚠️ **전압으로는 추정하지 않는다.** 같은 비행에서 이렇게 출렁여 쓸 수 없었다:

| 시점 | 전압 | 전압 기준 추정 | 실제 소모 |
|---|---|---|---|
| 시동 전 | 14.56 V | 37 % | 0.8 mAh |
| 호버 중 | 13.65 V | **12 %** | 16.6 mAh |
| 착륙 후 | 14.44 V | 34 % | 20.3 mAh |

28초 지상시험에 20.3 mAh — **거의 만충**인데 전압으로는 12 % 까지 떨어졌다.
부하가 걸리면 전압이 주저앉기 때문이다. 지금은 셋 다 **99 %** 로 나온다.

⚠️ **쓰던 배터리를 꽂고 날면 실제보다 높게 나온다.** 로그에 시작 잔량이
없어 만충을 가정한다.

---

## F. 로그에서 무엇을 읽을 것인가

첫 비행 이후에는 [절차 04 F항](04-first-flight.md)의 표를 따른다.
지금 단계(지상시험)에서 볼 것:

| 확인할 것 | 로그 필드 | 판정 |
|---|---|---|
| 모터 4개 균형 | `RCOU.C1~C4` | 편차 20 µs 이내면 정상 |
| 진동 | `VIBE.VibeX/Y/Z` | 🔴 60 이상이면 비행 금지 |
| 클리핑 | `VIBE.Clip0~2` | 증가하면 🔴 중단 |
| 전압 새그 | `BAT.Volt` | `BATT_LOW_VOLT` 아래로 가면 안 된다 |
| 실제 전류 | `BAT.Curr` | 계산서와 대조 |
| 충돌 감지 | `MSG` 에 `Crash` | |
| ARM 실패 사유 | `MSG` 에 `PreArm` | |

🔶 **09-16 로그에서 이미 나온 것** (아직 원인 규명 안 됨):
- ID 13 진동 **71.1** — 위험 수준(60 초과)
- ID 14 에 `Crash: Disarming`
- 15 % 스로틀에서 총전류 0.19 A — 3508 모터 4개치고 너무 작다.
  모터가 실제로 안 돌았거나 `BATT_AMP_PERVLT=18.0` 보정이 틀렸다
→ [절차 00 미해결 항목](00-progress.md#-미해결--다음에-이어서-할-것)

---

## 🔶 이 절차가 아직 못 하는 것

- **ID 11(2.45 MB) 미회수** — USB 끊김으로 실패. 재시도 필요
- **큰 로그 재시도 자동화 없음** — 실패하면 손으로 다시 돌린다
- **SD 카드 직접 읽기 절차 없음** — 카드를 빼서 리더기에 꽂으면
  `APM/LOGS/*.BIN` 을 그냥 복사하면 된다. MAVLink 다운로드보다 훨씬 빠르지만
  카드를 빼고 꽂는 동안 접점이 상한다
- **지도가 빈다** — 실내 로그는 GPS 좌표가 없어 항적이 안 그려진다. 정상이다

---

## 참고

- 도구: [`tools/loglist.py`](../../tools/loglist.py), [`tools/logdl.py`](../../tools/logdl.py)
- 재생 서버: [`tools/live/`](../../tools/live/README.md)
- 정적 뷰어(재생과 별개, 차트만): [`tools/logview/`](../../tools/logview/README.md)
