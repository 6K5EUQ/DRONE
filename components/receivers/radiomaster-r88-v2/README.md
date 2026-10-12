# RadioMaster R88 V2 — 수신기 (DRONE01)

DRONE01 의 수신기. **사용자 확인 2026-10-12** — 실물 라벨 사진은 아직 없다 🔶 (제품명만 사용자가 알려 줌).
아래 사양은 판매 페이지 기재 내용이다 (출처 하단). 이 기체에서 직접 잰 값이 아니다.

---

## 사양 — 판매 페이지 기재 (🔶 제조사 문서 직접 확인 안 함)

| 항목 | 값 |
|---|---|
| 제조사 | **RadioMaster** (FrSky 가 아니다) |
| 프로토콜 | **D8 / D16 / SFHSS** — FrSky 송신기가 아니라 **Multi-Module(MPM) 라디오 전용** |
| 채널 | **8채널** |
| 출력 | **PWM 8채널 + SBUS** (SBUS 는 8채널 + RSSI 1 이라는 설명이 있다 🔶) |
| 주파수 | 2400~2483.5 MHz |
| 전원 | 4.5~6 V (일부 목록은 4.5~8.4 V — 목록끼리 다름 🔶) |
| 거리 | 1 km 이상 (15 cm 안테나) |
| 무게·크기 | 11 g · 40 × 26 × 16 mm |
| 페일세이프 | 전원을 켠 뒤 10초 안에 바인드 버튼을 한 번 누르면 **그때의 모든 채널 값**을 페일세이프로 저장 |
| CPPM | 목록에 언급 없음 — 지원 여부 미확인 |

## 통신 — **D16** (사용자 확인 2026-10-12)

- 송신기 ↔ 이 수신기는 **FrSky D16** 프로토콜로 통신한다. TX16S 의 Multi-Module 에서는 **FrskyX** 가 D16 에 해당한다.
- 이 수신기는 D8·D16·SFHSS 를 받는다 (위 사양) — D16 은 지원 범위 안이다.
- 송신기 쪽 설정: `model17 "T1 Doran"` 의 RF 모듈이 `TYPE_MULTIMODULE`, `subType: 15,0` → **FrskyX (CH_16)** 다
  ([TX16S 문서](../../transmitters/tx16s/README.md), 2026-09-21 SD 카드 읽기). 🔶 이 모델이 DRONE01 용인지는 아직 확인 안 됨.
- 🔶 수신기는 8채널이라 CH_16 모드의 9~16번 채널은 받지 못한다. 이 기체는 5채널(RC1~5)을 쓰고 있어 영향 없다.
- 🔶 이 수신기의 텔레메트리(송신기로 돌아오는 값) 지원 여부는 판매 페이지에 없다.

## 이 기체에서의 활용

- **연결:** Pixhawk 2.4.8 의 **RC 포트**에 SBUS 로 연결한다. ArduCopter 3.6.12 에는 `RC_PROTOCOLS` 가 없고 RC 포트가
  SBUS/PPM 을 자동 감지한다 ([00-progress](../../../docs/procedures/00-progress.md) 미해결 2번). `RC1~5` 보정값 982~2005 는
  SBUS 수신기로 쓰던 흔적이다.
- **송신기:** [TX16S](../../transmitters/tx16s/README.md) 는 내부 모듈이 Multi-Module 이라 이 수신기와 맞는다 (MPM 라디오).
  프로토콜은 **D16** 이다 (위 「통신」 절). 🔶 이 수신기와 현재 바인딩돼 있는지는 확인 안 됨.
  이 수신기는 FrSky 계열이라 **ELRS 로 바꿀 수 없다** (수신기도 바꿔야 한다).
- **전원:** ESC 가 5 V 를 만들지 않으므로(OPTO) 수신기 5 V 는 FC 의 RC 포트(파워모듈 5 V)에서 받는다.
- 🔶 **확인할 것:**
  - 저장된 페일세이프 값 — 송신기가 꺼졌을 때 수신기가 낮은 스로틀을 내보내는지, 아니면 마지막 값을 유지하는지.
    FC 는 `FS_THR_ENABLE=1` 이라 스로틀이 `FS_THR_VALUE` 아래로 내려가야 걸린다. 값이 다르면 송신기 꺼짐에 failsafe 가 안 걸릴 수 있다.
  - 조회 시점의 RC 채널이 전부 0 이었던 것은 송신기가 꺼져 있었기 때문으로 추정한다 ([FC_CHANGELOG](../../../FC_CHANGELOG.md) 2026-10-07 18:28).

## 출처

- [RadioMaster R88 V2 — racedayquads](https://www.racedayquads.com/products/radiomaster-r88-v2-2-4ghz-wing-receiver-1)
- [RadioMaster R88 V2 — kiwiquads](https://kiwiquads.co.nz/product/radiomaster-r88-v2-8ch-frsky-d8-compatible-pwm-sbus-receiver/)
- [RadioMaster R88 V2 — GetFPV](https://www.getfpv.com/radios/receivers/radiomaster-r88-v2-8ch-pwm-receiver-w-sbus.html)
- [RadioMaster R88 V2 — radiomasterrc.com](https://radiomasterrc.com/products/r88-receiver)
