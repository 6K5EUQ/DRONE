# RadioMaster TX16S — RC 송신기(조종기)

보유 조종기. DRONE(2kg 쿼드) 조종에 사용 예정. ELRS 사용 가능 여부를 조사하며
SD 카드 전체를 읽어 상태를 파악했다.

조사일 2026-09-21. 출처: SD 카드 직결 읽기(`/media/rim3/CEC3-562B`, USB Mass Storage 모드)
+ `tx/backup/` 스냅샷(2026-09-16) 대조. **SD 카드 미연결 상태에서도 확인 가능하도록
원본 파일을 [`tx/sdcard_20260921/`](../../../tx/sdcard_20260921/) 에 저장해 두었다** —
이하 인용 경로는 전부 그 폴더 기준.

---

## 🔴 가장 중요한 사실 — 내장 RF 모듈이 ExpressLRS 가 아니다

| 항목 | 값 | 출처 |
|---|---|---|
| `internalModule` | **`TYPE_MULTIMODULE`** (4-in-1 Multiprotocol) | `tx/sdcard_20260921/RADIO/radio.yml:48` |
| `externalModule` | 미설정 (외장 베이 비어 있음) | `tx/sdcard_20260921/RADIO/radio.yml` 전체에 키 없음 |
| 현재 선택 모델의 모듈 설정 | `type: TYPE_MULTIMODULE`, `subType: 15,0` → **FrskyX** | `tx/sdcard_20260921/MODELS/model17.yml:195-196`, `tx/sdcard_20260921/Multi.txt` 15번 |

**ExpressLRS 는 EdgeTX 의 소프트웨어 기능이 아니라 별도 RF 칩(SX1280 계열)이 얹힌
물리 모듈이 있어야 동작한다.** 이 개체는 구매 시 "4-in-1 Multiprotocol" 내장 모듈
버전으로 나왔고, 그 칩 자체가 ELRS 를 지원하지 않는 하드웨어다. 설정 메뉴로 전환
불가 — **하드웨어 추가 구매 없이는 ELRS 사용 불가.**

TX16S 라인업에도 ELRS 내장 버전(TX16S Max 등)이
존재하나, 이 개체가 그 버전은 아니다.

### ELRS 를 쓰려면

| 방법 | 구매 필요 | 비고 |
|---|---|---|
| 외장 JR 베이에 ELRS 모듈 장착 | 🔴 필요 | 후면 베이 비어 있어 바로 장착 가능한 상태. 기체 쪽 ELRS RX 도 별도 필요 |
| 내장 모듈 보드를 ELRS 용으로 물리 교체 | 🔴 필요 | 분해 필요, 비권장 |
| 소프트웨어/설정만으로 전환 | 불가능 | — |

🔶 기체(DRONE) 쪽에 RX 가 뭔지 `components/` 에 아직 문서 없음 — ELRS 도입 시 TX 모듈뿐
아니라 RX 도 ELRS 대응 기종으로 맞춰야 한다.

---

## 연결 상태 (2026-09-21 조사 시점)

| 항목 | 값 |
|---|---|
| USB 인식 | `0483:5720 STMicroelectronics Mass Storage Device` |
| 모드 | **Mass Storage**(SD카드 파일시스템 직결) — Serial(VCP) 아님 |
| 마운트 경로 | `/media/rim3/CEC3-562B` (FAT, 481M 중 251M 사용) |
| 참고 | 시리얼(MAVLink/Lua 등) 연결 필요 시 TX16S 에서 USB 모드를 Serial 로 전환 후 재연결 필요 — 지금은 SD 카드 통째로 마운트된 상태라 파일 단위 조사만 가능 |

---

## 펌웨어 / 소프트웨어

| 항목 | 값 | 출처 |
|---|---|---|
| 보드 | `tx16s` | `tx/sdcard_20260921/RADIO/radio.yml:4` |
| 현재 올라간 펌웨어 | **EdgeTX 2.9.4** | `tx/sdcard_20260921/RADIO/radio.yml:3` (`semver`), `tx/sdcard_20260921/FIRMWARE_listing.txt` (2025-08-14) |
| SD 카드 자체 버전 | 2.5 | `tx/sdcard_20260921/edgetx.sdcard.version` |

### FIRMWARE/ 폴더 전체 — ELRS 펌웨어 없음, 전부 Multiprotocol 계열

| 파일 | 성격 |
|---|---|
| `tx16s-v2.9.4.bin` | EdgeTX 본체 (현재 적용본) |
| `EdgeTX-TX16S-{CN,EN,TW}-2.7.1-SD.bin` | EdgeTX 구버전 백업 3종 |
| `mm-stm-serial-aetr-air-v1.3.4.31.bin` | **Multi-Module**(내장 4-in-1 RF보드용). `strings` 검사로 `multi-x00000b81-...` 시그니처 확인 — ELRS 문자열 없음 |
| `mm-korea-low-4in1-1.3.1.77.bin` | Multi-Module 4-in-1, 한국 리전용 |
| `multi-4in1-v1.3.3.20.bin`, `multi-4in1-v1.3.3.7.bin` | Multi-Module 4-in-1 구버전 |
| `multi-cc2500-v1.3.3.20.bin`, `4in1-LBT-1.3.3.24.bin`, `cc2500-LBT-1.3.3.24.bin` | Multi-Module CC2500 계열 / LBT 리전용 |

`tx/sdcard_20260921/Multi.txt` 에 Multi-Module 지원 프로토콜 91개 목록이 있고, 27번에 `OpnLrs`(OpenLRS —
ELRS 와는 다른 구형 오픈소스 프로젝트)만 있을 뿐 **ExpressLRS 는 목록에 없다.**

---

## 모델 목록 (SD 카드, 총 19개)

| 파일 | 모델명 | 비고 |
|---|---|---|
| model1.yml | GREEN | |
| model2.yml | DELTA | |
| model3.yml | OMPHOBBY M2 | 헬기 |
| model4.yml | QUAD | 🔶 이름은 쿼드이나 현재 선택 모델 아님, DRONE 기체와의 연관 미확인 |
| model5.yml | HELI | |
| model6~12.yml | Eachine 완구기 각종(E160/E180/P-51D/T-28/F4U/F22/F16) | |
| model13~16.yml | YUSOO / MODEL14 / MODEL15 / 0919YSW | 🔶 용도 미확인 |
| **model17.yml** | **"T1 Doran"** | 🟢 **현재 선택 모델** (`currModelFilename`), DRONE 기체용으로 추정 |

### model17 "T1 Doran" — 현재 선택 모델 상세

| 항목 | 값 |
|---|---|
| RF 모듈 | `TYPE_MULTIMODULE`, `subType: 15,0` → **FrskyX** (CH_16) |
| 채널 구성 | destCh 0~5 기본 믹스(에일러론/엘리베이터/스로틀/러더/… + SE "Mode") + **destCh 6 "Kill"(SF 스위치)** |

🔶 **모델명이 "T1 Doran"** — DRONE 프로젝트 기체명과의 관계는 문서화된 적 없음.
이 기체가 맞는지 실기 바인딩 상태로 확인 필요.

---

## 🟠 드리프트 — `tx/backup/` 스냅샷이 최신 상태가 아니다

레포에 있는 `tx/backup/model17_20260916_before-kill.yml` 은 파일명 그대로
**"Kill 스위치 추가 전" 스냅샷**이다. `tx/sdcard_20260921/`(당시 라이브 SD)과 diff 결과:

- `radio.yml`: `checksum`, `globalTimer` 만 차이 — 실사용에 따른 정상 변화
- `model17.yml`: **라이브에 `destCh: 6, srcRaw: SF, name: "Kill"` 믹스가 추가로 존재**,
  백업본엔 없음

즉 백업 이후 Kill 스위치(SF)를 추가하는 작업이 있었고, 그 결과물이 레포에 반영 안
됐다. `tx/backup/` 은 현재 미문서화 상태(파일 존재만 하고 이 폴더를 설명하는 글 없음) —
정식 백업 절차로 편입하려면 날짜·사유를 붙여 재백업 필요.

---

## 요약

| 질문 | 답 |
|---|---|
| ExpressLRS 되나? | 🔴 안 됨 — 내장 모듈이 Multiprotocol, ELRS 칩 자체가 없음 |
| 소프트웨어 설정으로 켤 수 있나? | 🔴 불가 — 하드웨어 문제 |
| 방법은? | 외장 JR 베이에 ELRS 모듈 구매·장착 (+ 기체 쪽 ELRS RX 별도 구매) |
| 지금 쓰는 프로토콜은? | FrskyX (model17 "T1 Doran" 기준) |
| SD 카드 최신 상태 반영됐나? | 🟠 아니다 — `tx/backup/` 스냅샷에 Kill 스위치 추가분 누락 |
