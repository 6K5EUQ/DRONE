# 절차 06 — PX4 전환 준비

이 기체(Pixhawk 2.4.8 / PX4v3)를 **ArduCopter 3.6.12 → PX4** 로 바꾸기 위한 준비.

작성 2026-09-17. 🔴 **아직 아무것도 실행하지 않았다.** 이 문서는 *준비*다.
작성 시점에 FC 는 PC 에 연결돼 있지 않았고, **조회·쓰기·삭제를 일절 하지 않았다.**
모든 값은 `params/params_20260914-1900_live-usb.param`(09-14 실측)에서 가져왔다.

> 전제: [절차 02 A항](02-fc-setup.md) 의 스택 결정. 이 문서는 그중 **C안(PX4 전환)**
> 을 고를 경우에 대비한 사전조사다. 결정 자체는 아직 나지 않았다.

---

## 🔴 결론부터 — 전환은 가능하다. 단 조건이 있다

| 항목 | 판정 |
|---|---|
| 이 보드에 PX4 가 올라가는가 | ✅ **가능** — FMUv3 타깃, v1.15~v1.16 까지 지원 |
| 최신 PX4 를 쓸 수 있는가 | 🔴 **아니다** — FMUv3 는 더 이상 발행되지 않는다 |
| 지금 설정을 살릴 수 있는가 | 🔴 **전부 날아간다** — 파라미터 체계가 완전히 다르다 |
| 되돌릴 수 있는가 | ✅ ArduCopter 재플래시로 복귀 가능 (백업 있음) |

**2 MB 를 다 쓸 수 있다는 것이 이 보드의 행운이다.** [FC 문서](../../components/fc/pixhawk-2.4.8/README.md)
에 적힌 대로 로그에 `PX4v3` 로 찍히므로 FMUv2 의 1 MB 실리콘 버그 보드가 아니다.
PX4 문서는 FMUv3 를 *"Identical to FMUv2, but usable flash doubled to 2MB"* 라고 정의한다.

---

## A. 어느 PX4 버전을 쓸 것인가

🔶 **아래는 2026-09-17 에 PX4 공식 문서에서 확인한 값이다. 실제 빌드로는 미검증.**

| 보드 | 마지막 지원 PX4 |
|---|---|
| Holybro Pixhawk Mini (FMUv3) | **v1.16** |
| CUAV Pixhack v3 (FMUv3) | v1.15 |
| 3DR Pixhawk 1 (FMUv2) | v1.15 |
| Holybro Pix32 (FMUv2) | v1.16 |

> ⚠️ **09-14 문서에 "PX4 는 v1.14 를 끝으로 FMUv2/v3 지원을 중단했다" 고 적었는데
> 그건 틀렸다.** 실제로는 v1.15~v1.16 까지 발행됐다. 이 절에서 정정한다.
> 다만 *더 새 버전은 없다* 는 결론은 그대로다.

- [ ] 🔴 **목표 버전 결정** — v1.15 인가 v1.16 인가
- [ ] 그 버전의 `px4_fmu-v3_default.px4` 를 구할 수 있는지 확인
      (QGC 의 펌웨어 목록에 안 뜨면 GitHub 릴리스에서 직접 받는다)

🔴 **SHADE01 의 v1.17.0 커스텀 빌드는 이 보드에 못 올린다.**
그건 FMUv6C 타깃이다. 빌드 절차를 가져오지 마라.

---

## B. 🔴 전환하면 잃는 것 — 백업으로 못 살린다

파라미터 체계가 달라서 **ArduCopter 백업을 PX4 에 복원할 수 없다.**
아래는 전부 다시 잡아야 한다.

| 잃는 것 | 09-14 실측값 | 다시 잡는 법 |
|---|---|---|
| 가속도계 캘리브레이션 | `INS_ACCOFFS_X/Y/Z = -0.133 / -0.307 / -0.297`<br>`INS_ACCSCAL_X = 0.983` | PX4 에서 6면 재보정 |
| 자이로 오프셋 | `INS_GYROFFS_X = 0.00197` | 부팅 시 자동 |
| 나침반 캘리브레이션 | `COMPASS_OFS_X/Y/Z = 56.18 / -29.61 / -79.66` | 🔴 **야외에서** 재보정 |
| RC 캘리브레이션 | `RC1_MIN/MAX = 982 / 2005` | 송신기 바인딩 후 재보정 |
| 자세 PID | `ATC_RAT_RLL_P=0.135`, `I=0.09`, `D=0.0036`<br>`ATC_RAT_YAW_P=0.18`, `ATC_ANG_RLL_P=4.5` | PX4 기본값에서 다시 |
| 호버 추력 | `MOT_THST_HOVER = 0.5402` | PX4 가 `MPC_THR_HOVER` 로 재학습 |
| 비행모드 배치 | `FLTMODE_CH=5`, `FLTMODE1=5(LOITER)`, `FLTMODE4=2(ALT_HOLD)` | PX4 모드로 다시 배치 |

⚠️ **이 값들은 어차피 대부분 무효다.** [CLAUDE.md](../../CLAUDE.md) 대로
이 기체는 분해 후 재조립이라 PID·호버추력은 프레임·프롭이 확정되면
다시 잡아야 한다. **전환의 실질 손실은 캘리브레이션 재작업뿐이다.**

---

## C. 값 대응표 — ArduCopter → PX4

09-14 실측값을 PX4 쪽에 어떻게 옮길지. **그대로 복사하는 게 아니라
같은 의도를 PX4 파라미터로 다시 쓰는 것**이다.

### 기체 형식

| ArduCopter (실측) | PX4 | 비고 |
|---|---|---|
| `FRAME_CLASS=1` (Quad) | `SYS_AUTOSTART=4001` | Generic Quadcopter X |
| `FRAME_TYPE=1` (X) | 〃 | 기체 형식이 airframe 하나로 합쳐진다 |

🔶 `SYS_AUTOSTART` 번호는 PX4 airframe 목록에서 확인 필요. **미검증.**

### 출력 — 🔴 여기가 가장 조심할 곳

| ArduCopter (실측) | PX4 | 비고 |
|---|---|---|
| `SERVO1~4_FUNCTION = 33~36` | 액추에이터 설정에서 Motor 1~4 | GUI 로 배치 |
| `MOT_PWM_MIN/MAX = 1000/2000` | `PWM_MAIN_MIN/MAX` | 같은 뜻 |
| `MOT_PWM_TYPE=0` (일반 PWM) | `DSHOT_CONFIG=0` (PWM 유지) | |
| `RC_SPEED=490` | `PWM_MAIN_RATE=490` | |
| `BRD_PWM_COUNT=4` | PX4 는 채널별로 기능 배정 | MAIN5~8 을 쓰려면 별도 설정 |

🔴 **모터 번호와 물리 위치의 대응은 PX4 에서 다시 확인해야 한다.**
ArduCopter 의 Motor1~4 순서와 PX4 의 Motor1~4 순서가 **같다는 보장이 없다.**
우리 기체의 실측 배치는 이렇다 (09-16 실측, 커밋 `f3ee0e8`):

| MAIN | 위치 | 회전 |
|---|---|---|
| 1 | 우전 | CCW |
| 2 | 우후 | CW |
| 3 | 좌후 | CCW |
| 4 | 좌전 | CW |

→ 전환 후 **[절차 03 A항](03-ground-test.md)의 모터 테스트를 처음부터 다시** 해서
   어느 출력이 어느 모터를 도는지 실측으로 확인한다. 가정하지 마라.

### 배터리

| ArduCopter (실측) | PX4 | 비고 |
|---|---|---|
| `BATT_CAPACITY=2900` | `BAT1_CAPACITY=2900` | mAh |
| `BATT_MONITOR=4` (전압+전류) | `BAT1_SOURCE=0`, `BAT1_V_DIV`·`BAT1_A_PER_V` 설정 | |
| `BATT_VOLT_MULT=10.8199` | `BAT1_V_DIV` | 🔶 **환산식이 다르다. 그대로 넣지 마라** |
| `BATT_AMP_PERVLT=18.0018` | `BAT1_A_PER_V` | 🔶 〃 |
| `MOT_BAT_VOLT_MAX/MIN=16.8/13.2` | `BAT1_N_CELLS=4` | PX4 는 셀 수로 관리 |
| 🔴 `BATT_LOW_VOLT=14.4` (틀림) | `BAT_LOW_THR` | **옮기지 마라 — 아래 참조** |
| 🔴 `BATT_CRT_VOLT=14.0` (틀림) | `BAT_CRIT_THR` | 〃 |

🔴 **배터리 failsafe 임계는 지금 값을 옮기면 안 된다.**
현재 값이 4S 에 맞지 않아 지상시험을 계속 중단시켰다
([절차 00 미해결 4](00-progress.md)). PX4 에서는 **비율(0~1)** 로 잡는다:
- `BAT_LOW_THR = 0.15` (15 % 남음)
- `BAT_CRIT_THR = 0.07` (7 %)

⚠️ **전압·전류 보정은 어차피 재측정 대상이다.** `BATT_AMP_PERVLT=18.0` 이
이 기체에서 검증되지 않았다 — 15 % 스로틀에서 총 0.19 A 라는 이상한 값이
나온 채로 남아 있다 ([절차 00 미해결 1](00-progress.md)).
**멀티미터·클램프미터 실측으로 새로 잡는다.**

### 비행 제한

| ArduCopter (실측) | PX4 | 비고 |
|---|---|---|
| `ANGLE_MAX=4500` (45°) | `MPC_TILTMAX_AIR=30` | 🔴 초기 시험은 **30°** 로 낮춘다 |
| `RTL_ALT=1500` (15 m) | `RTL_RETURN_ALT=15` | PX4 는 m 단위 |
| `LAND_SPEED=50` (50 cm/s) | `MPC_LAND_SPEED=0.5` | PX4 는 m/s |
| `WPNAV_SPEED=500` (5 m/s) | `MPC_XY_VEL_MAX=5` | 〃 |
| `MOT_THST_HOVER=0.5402` | `MPC_THR_HOVER` | 🔶 재학습시키는 편이 낫다 |

🔴 **단위가 다른 것이 많다.** cm → m, cm/s → m/s. 숫자를 그대로 넣으면
100 배 틀린 값이 들어간다.

### 센서 · 통신

| ArduCopter (실측) | PX4 | 비고 |
|---|---|---|
| `GPS_TYPE=1` (AUTO) | `GPS_1_CONFIG=101` (GPS1 포트) | |
| `SERIAL3_PROTOCOL=5` (GPS) | 〃 | |
| `SERIAL1_PROTOCOL=1` (MAVLink1) | `MAV_0_CONFIG=101` | TELEM1 |
| `COMPASS_USE=1` (외장 1개) | PX4 가 자동 검출 | |
| `BRD_SAFETYENABLE=1` | `CBRK_IO_SAFETY=0` (안전스위치 사용) | |
| `ARMING_CHECK=1` (전체) | `CBRK_*` 차단기 **전부 기본값 유지** | 🔴 **끄지 마라** |

🔶 `GPS_1_CONFIG`·`MAV_0_CONFIG` 의 포트 번호 값은 PX4 문서에서 확인 필요.
**미검증.**

---

## D. 전환 절차 (실행 전 점검표)

🔴 **아래는 아직 한 번도 수행하지 않았다.**

### D-1. 되돌릴 준비

- [ ] 현재 ArduCopter 파라미터 백업이 있는지 확인
      → ✅ `params/params_20260914-1900_live-usb.param` (838개, 09-14 실측)
- [ ] **ArduCopter 3.6.12 펌웨어 파일을 미리 확보**해 둔다
      (되돌릴 때 같은 버전을 못 구하면 곤란하다)
- [ ] SD 카드의 로그를 전부 회수한다 → [절차 05](05-log-retrieval.md)
      🔶 ID 11(2.45 MB)이 아직 안 받아져 있다
- [ ] [FC_CHANGELOG](../../FC_CHANGELOG.md) 에 "플래시 전" 기록

### D-2. 플래시

- [ ] QGC 로 보드 인식 — **`PX4v3` / FMUv3 로 잡히는지 확인**
      🔴 `FMUv2` 로 잡히면 1 MB 로 제한된다. 그 상태로 진행하지 마라
- [ ] PX4 v1.15 또는 v1.16 플래시
- [ ] 부팅 확인, 버전 문자열 대조
- [ ] [FC_CHANGELOG](../../FC_CHANGELOG.md) 기록

### D-3. 기본 설정

- [ ] `SYS_AUTOSTART` = Generic Quadcopter X
- [ ] 액추에이터 설정에서 Motor 1~4 배치
- [ ] `PWM_MAIN_MIN/MAX` = 1000 / 2000
- [ ] 배터리: `BAT1_N_CELLS=4`, `BAT1_CAPACITY=2900`
- [ ] `MPC_TILTMAX_AIR=30` (초기 시험용)

### D-4. 캘리브레이션 (전부 새로)

- [ ] 가속도계 6면
- [ ] 🔴 나침반 — **야외에서**
- [ ] RC (송신기 바인딩이 선행되어야 한다)
- [ ] ESC 스로틀 범위 — 🔴 **프롭 분리 상태에서**
- [ ] 전압·전류 센서 — 멀티미터 실측 대조

### D-5. 검증 — 🔴 가정하지 말고 실측한다

- [ ] **모터 테스트로 출력↔위치 대응 재확인** (C절 경고 참조)
- [ ] 자세 반응 방향 확인 (기울이면 반대쪽이 증속하는가)
- [ ] failsafe 동작
- [ ] → [절차 03 지상시험](03-ground-test.md) 전체를 다시 수행

---

## E. 🔶 전환할 가치가 있는가 — 판단 재료

### 전환하면 좋은 점

- SHADE01 의 도구·감각이 통한다 (`.ulg` 로그, PX4 파라미터 체계)
- PX4 v1.15/v1.16 은 ArduCopter 3.6.12(2019년)보다 훨씬 최신이다
- 두 기체를 같은 방식으로 다룰 수 있다

### 전환하면 나쁜 점

- 🔴 **FMUv3 는 PX4 에서 끝난 플랫폼이다.** v1.16 이후는 없다
- 캘리브레이션을 전부 다시 해야 한다
- ArduCopter 는 **4.5.x 까지 FMUv3 를 지원**한다 — 최신성만 보면 이쪽이 낫다
- 이 저장소의 로그 도구를 전부 다시 만들어야 한다
  (`tools/` 전체가 `.BIN` 전제다 → `.ulg` 로 바뀐다)

### 🔶 아직 답하지 못한 것

- PX4 v1.16 의 FMUv3 빌드가 실제로 받아지는가 (QGC 목록 / GitHub 릴리스)
- 2 MB 에 필요한 기능이 다 들어가는가 (FMUv3 도 모듈이 일부 빠진다)
- `SYS_AUTOSTART`·`GPS_1_CONFIG`·`MAV_0_CONFIG` 의 정확한 값
- 전류 센서 보정식이 ArduCopter 와 어떻게 다른가

---

## 참고

- [PX4 — Discontinued Autopilots](https://docs.px4.io/main/en/flight_controller/autopilot_discontinued)
  (FMUv3 마지막 지원 버전)
- [PX4 — Pixhawk Series](https://docs.px4.io/main/en/flight_controller/pixhawk_series)
  (*"FMUv3: Identical to FMUv2, but usable flash doubled to 2MB"*)
- 실측 파라미터: [`params/params_20260914-1900_live-usb.param`](../../params/params_20260914-1900_live-usb.param)
- 현재 FC 상태: [`components/fc/pixhawk-2.4.8/README.md`](../../components/fc/pixhawk-2.4.8/README.md)
- 스택 결정: [절차 02 A항](02-fc-setup.md)
