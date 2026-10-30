# 미션 지형

서버 미션 계획(`web/mission.js`)이 순항고도·지반 경고에 쓰는 지형 격자다.

- **가져온 곳**: SHADE01 저장소 `web/public/terrain/` 에서 그대로 복사 — 2026-10-30. 다시 만드는 스크립트는 SHADE01 `tools/terrain/make_dem.py`
- **출처**: Copernicus DEM GLO-30 (30 m 격자, 2021 공개판), 타일 `N35_00_E128_00` — `dem.json` 의 `src`
- **범위**: 35.181, 128.554 중심 ±0.1° (약 22 × 18 km). 밖이면 값이 없다
- **형식**: `dem.bin` int16 LE, 0.1 m 단위, 북→남 행. `dem.json` 의 `lat0`·`lon0` 이 첫 화소 중심, 간격 1″

## 알아 둘 것

- 해발은 EGM2008 기준이다. FC 의 상대고도와 바로 비교하지 말고 **출발점과의 차이**로만 쓴다
- 레이더(X밴드)로 잰 지표면(DSM)이라 숲에서는 땅보다 높고 나무 꼭대기보다 낮게 나온다. 전선·철탑은 없다
- 30 m 격자 하나 안에서도 경사면은 수십 m 차이가 난다 (SHADE01 README — 그쪽 이륙장 기준)

© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS
by the European Union and ESA; all rights reserved.
