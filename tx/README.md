# tx/ — TX16S 조종기 SD 카드 스냅샷

TX16S(EdgeTX) SD 카드 내용을 시점별로 저장해 둔 폴더. 조종기를 PC 에 다시 연결하지
않고도 설정 상태를 확인할 수 있게 하는 것이 목적. 분석/요약은
[components/transmitters/tx16s/README.md](../components/transmitters/tx16s/README.md) 참조.

## 폴더

| 폴더 | 시점 | 내용 | 비고 |
|---|---|---|---|
| `backup/` | 2026-09-16 | `radio.yml`, `model17.yml`(Kill 스위치 추가 **전**) | 파일명에 `before-kill` 명시 |
| `sdcard_20260921/` | 2026-09-21 | `RADIO/radio.yml`, `MODELS/model*.yml` 19개 전부, `Multi.txt`, `edgetx.sdcard.version`, `FIRMWARE_listing.txt`(파일 목록만, 바이너리 본체는 미포함) | 조종기 상태 전수 조사 시점 |

## 무엇을 뺐나

SD 카드에서 `FIRMWARE/`(펌웨어 바이너리, 7.8M — 파일 목록만 `FIRMWARE_listing.txt` 로 기록),
`SOUNDS/`(212M), `THEMES/`(16M), `IMAGES/`(4.2M), `SCRIPTS/`(7.8M, lua),
`WIDGETS/`, `TEMPLATES/`, `UTILITIES/`, `SCREENSHOTS/`, `LOGS/` 는 상태 파악과
무관한 리소스·대용량 파일이라 제외했다. 설정 상태(모델·프로토콜·RF모듈) 파악에
필요한 것만 저장.

## 갱신 방법

조종기를 USB Mass Storage 모드로 PC 에 연결 → SD 카드가 `/media/<user>/<라벨>` 에
마운트됨 → 위 대상 파일들을 새 날짜 폴더(`sdcard_YYYYMMDD/`)로 복사.
**이전 스냅샷은 지우지 않는다** — 변경 이력 추적용.
