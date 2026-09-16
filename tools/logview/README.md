# DRONE 로그 뷰어 — 로컬 전용

ArduCopter `.BIN` 로그를 브라우저로 본다. **shade01.bewe.co.kr 과 무관** —
그 웹은 PX4 `.ulg` 전용 파서라 이 기체 로그를 못 읽는다 (2026-09-16 확인).
그래서 이걸 따로 만들었다.

```bash
# 1. .BIN → .json 추출 (pymavlink 필요)
~/.venv-mav/bin/python extract.py 00000012.BIN 00000013.BIN ...

# 2. json 을 viewer.html 옆으로 (같은 디렉터리에서 fetch 한다)
cp <어딘가>/*.json tools/logview/

# 3. 로컬 서버
cd tools/logview && python3 -m http.server 4402 --bind 127.0.0.1
# → http://localhost:4402/viewer.html
```

읽기 전용. FC 로 아무것도 보내지 않는다.

---

## 지금 보이는 로그

`viewer.html` 상단의 `LOGS` 배열에 파일명이 하드코딩돼 있다.
새 로그를 추가하려면 그 배열에 ID 를 더하고 json 을 같이 둔다.

현재: `00000012` ~ `00000016` (2026-09-16 실내 비행, USB 로 FC 에서 직접 회수).
`00000011`(2.45MB, 가장 큼)은 USB 연결이 끊겨 다운로드 실패 — 아직 없다.

---

## 보여주는 것

| 패널 | 로그 필드 |
|---|---|
| 요약 통계 | 펌웨어, 길이, ARM 횟수, 최고고도, GPS fix/위성, 전압/전류, 진동, 충돌 여부 |
| 자세 | `ATT` — Roll/Pitch/Yaw |
| 모터 출력 | `RCOU` — MAIN1~4 PWM |
| 진동 | `VIBE` — X/Y/Z, 60 넘으면 🔴, 30 넘으면 🟡 |
| 배터리 | `BAT` — 전압/전류 |
| 고도 | `CTUN` — Alt |
| 이벤트 | `MSG` 전체 (Crash/fail 계열은 빨간 글씨) |

점 2000개로 다운샘플한다 — 원본 정밀도가 필요하면 `.BIN` 을 `pymavlink` 로 직접 읽는다.

---

## 왜 SHADE01 웹을 안 썼나

- `web/extract.py`·`web/tools/uploadable.py` 는 `pyulog` 로 **PX4 `.ulg` 만** 읽는다
- `outdoor_enough()` 가 **위성 15기 이상 · eph 1.0m 이하**를 요구해 실내 로그를 자동 거부한다
  (이 기체의 5개 로그는 전부 실내, GPS fix=1·sats=0)
- 기체 구분이 없어 SHADE01 비행 이력에 섞인다

억지로 우회하면 웹이 "잘린 메시지에서 조용히 멈추는" 실제 장애 이력이 있다
(`web/extract.py` 주석 참조). 그래서 완전히 분리했다.
