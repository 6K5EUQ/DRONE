# DRONE — 2 kg 급 쿼드콥터 개발

2 kg 이하 멀티로터(쿼드) 기체를 **처음부터** 설계·조립·시험하는 저장소.
부품 선정, 설계 계산, 조립 절차, 파라미터, 시험비행 기록이 여기 모인다.

---

## 🔴 SHADE01 과의 관계 — 완전 독립 모델이다

이 저장소는 `~/SHADE01` 과 **아무 부품도, 아무 설정도 공유하지 않는다.**

| | SHADE01 | DRONE (이 저장소) |
|---|---|---|
| 기체 | Makeflyeasy Striver Mini VTOL 4+1, 2100 mm | 쿼드콥터 (프레임 미확정) |
| 형식 | VTOL 고정익 (`MAV_TYPE=22`) | 순수 멀티로터 쿼드 (`MAV_TYPE=2`) |
| 중량 | 7 kg 급, MTOW < 7.5 kg | **2 kg 이하 목표** |
| FC | Holybro Pixhawk 6C Mini (FMUv6C, STM32H743) | **Pixhawk 2.4.8 (PX4v3, STM32F427)** |
| 펌웨어 | PX4 v1.17.0 커스텀 자체 빌드 | 🔴 **ArduCopter V3.6.12** (현재 실물 상태) |
| 모터 | MFE M4112 KV460 / X4120 KV430 | GT DRONE 3508-380KV |
| ESC | MFE ESC 650 50A / 6S 100A | GT DRONE EC-X3 30A OPTO |
| 배터리 | Fullymax 6S 16000 mAh | 6S 2900 mAh 70C / 4S 2900 mAh 20C |

**차용해도 되는 것:** 문서 작성 방식, 절차서 구조, 로그 분석 관점, 안전 사고방식.
**차용하면 안 되는 것:** 파라미터 값, 추력·전류 수치, 펌웨어 바이너리, failsafe 설정값,
캘리브레이션 결과, 비행 이력. 기체가 다르면 숫자도 다르다.

SHADE01 문서에서 값을 가져올 때는 **반드시 출처와 함께 "SHADE01 값 — 이 기체 미검증"**
이라고 표시한다. 검증 없이 옮긴 값은 문서에 남기지 않는다.

---

## 현재 상태 (2026-09-14)

🔶 **설계 단계.** 조립 시작 전. **실비행 이력 없음** (실내 지상시험 10회만 존재).

확정된 것:
- 🟢 모터: GT DRONE 3508-380KV ×4 (보유)
- 🟢 ESC: GT DRONE EC-X3 MultiRotor 30A OPTO, No BEC, 2S~6S ×4 (보유)
- 🟢 FC: Pixhawk 2.4.8 — **PX4v3 타깃, ArduCopter V3.6.12 탑재, 쿼드 X 로 셋업됨**
- 🟢 배터리: 6S 2900 mAh 70C, 4S 2900 mAh 20C (보유)
- 🟢 **4S 로 간다** — 6S 는 모터 정격 초과. [계산서 §4](docs/design/01-thrust-weight.md)

미확정 — 조립 전에 답해야 하는 것:
- 🔴 **스택 결정** — ArduCopter 유지 / 최신화 / PX4 전환. [셋업 A항](docs/procedures/02-fc-setup.md)
- 🔴 **프롭 사이즈·피치** — 추력과 호버 스로틀을 결정한다
- 🔴 **프레임 모델명과 휠베이스** — 프롭 사이즈가 여기 묶인다
- 🔴 **BEC** — ESC 가 OPTO(No BEC) 라 FC·수신기 5 V 공급원이 따로 필요하다
- 🔴 **배터리 failsafe 임계** — 현재 값이 4S 에 맞지 않아 계속 오동작한다
- 🟠 FC 전원 모듈(PM), GPS, 수신기 모델 확인
- 🟠 로그 03 의 `Crash` 이력 — 기체·보드 손상 여부

---

## 🔴 FC 실물 상태 — 먼저 읽을 것

SD 카드 조사(2026-09-14) 결과, **이 보드는 새것이 아니다.**

- 🔴 **ArduCopter V3.6.12 가 올라가 있다** — PX4 가 아니다. 스택을 정해야 한다
- 🟢 **PX4v3 타깃** — 악명 높은 1 MB 플래시 버그 보드가 **아니다**. 2 MB 전부 쓸 수 있다
- 🟢 **쿼드 X 로 셋업 완료** — 캘리브레이션·PID 이력 있음. `MOT_THST_HOVER=0.540`
- 🟢 **4S 설정** — `MOT_BAT_VOLT_MAX/MIN = 16.8/13.2 V`
- 🔴 **배터리 failsafe 임계가 잘못됐다** — `BATT_LOW_VOLT=14.4 V` 는 4S 에 너무 높다.
  지상시험이 이것 때문에 계속 중단됐다
- ⚠️ **센서가 구형** — MPU6000 + LSM303D + L3GD20 + MS5611.
  6C Mini 의 ICM-42688-P 보다 노이즈가 크다 → **방진 마운트 필수**
- 🔶 **이전 기체의 이력을 모른다** — 어떤 프레임·프롭에 붙어 있었는지 불명

→ 상세: [components/fc/pixhawk-2.4.8/README.md](components/fc/pixhawk-2.4.8/README.md)

---

## 저장소 구성

| 경로 | 내용 |
|---|---|
| `docs/design/` | 설계 계산서 — 추력/중량, 전력, 프롭 선정 |
| `docs/procedures/` | 절차서 — 조립, 셋업, 시험비행, 비상 |
| `components/` | 부품별 사양·배선 문서 (`<카테고리>/<벤더-모델>/README.md`) |
| `flights/` | 비행별 분석 기록 (`YYYY-MM-DD-<slug>.md`) |
| `params/` | FC 파라미터 스냅샷 (`params_YYYYMMDD-HHMMSS.params`) |
| `tools/` | 스크립트 (현재 비어 있음) |
| `FC_CHANGELOG.md` | FC 상태를 바꾼 모든 작업의 이력 — **바꾸기 전에 읽고, 바꾼 뒤에 쓴다** |

문서 지도는 [CLAUDE.md](CLAUDE.md) 에 있다.

---

## 다음에 할 일

🔴 **진행 현황·미해결 문제·작업 수칙은 [절차 00 진행 현황](docs/procedures/00-progress.md) 에 있다.
새 세션은 그것부터 읽는다.**

가장 시급한 순서:

1. 🔴 **송신기 바인딩** — 여기서 막혀 있다. RC·ESC 캘리브레이션의 전제
2. 🔴 **MAIN4 모터가 "QGC All" 에서만 안 도는 문제** — FC 신호는 정상 확인됨.
   ESC·전원 구간 문제 ([지상시험 A항](docs/procedures/03-ground-test.md))
3. 🔴 **배터리 failsafe 수정** — `BATT_LOW_VOLT` 14.4→14.0, `BATT_CRT_VOLT` 14.0→13.2
4. 🔴 **스택 결정** — ArduCopter 유지 / 최신화 / PX4 전환 ([셋업 A항](docs/procedures/02-fc-setup.md))
5. 🔴 **프레임·프롭 실물 확인** — 모델명, 휠베이스, 사이즈, 중량
6. 🔴 **PM/BEC 실물 확인** — ESC 가 No BEC 라 5 V 공급원이 필요하다
7. [계산서 §6 중량 예산](docs/design/01-thrust-weight.md)을 실측으로 채운다
8. [조립](docs/procedures/01-assembly.md) → [FC 셋업](docs/procedures/02-fc-setup.md)
   → [지상 시험](docs/procedures/03-ground-test.md) → [첫 비행](docs/procedures/04-first-flight.md)

---

## 표기 규칙

| 기호 | 뜻 |
|---|---|
| 🔴 | 치명적 · 진행을 막는 것 |
| 🟠 | 심각 · 비행 전에 해결할 것 |
| 🟡 | 경미 · 알고 넘어갈 것 |
| 🟢 / ✅ | 확정됨 · 검증됨 |
| ⚠️ | 주의 |
| 🔶 | 미검증 · 답이 없는 질문 |
| 📋 | 체크리스트 |

**모든 수치에는 출처와 날짜를 붙인다.** 실측이면 `— 2026-09-14 실측`,
데이터시트면 `— 데이터시트`, 추정이면 `— 추정, 미검증` 이라고 쓴다.
출처 없는 숫자는 문서에 넣지 않는다.
