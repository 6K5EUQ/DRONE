"""배터리 시작 잔량 — 시동 전 **무부하 전압**에서 구한다.

ArduCopter 3.6 은 부팅할 때마다 잔량을 100 % 로 잡는다. 전압을 보고 시작 잔량을 정하지 않아서,
만충이 아닌 팩을 꽂아도 화면이 100 % 부터 시작했다. 여기서는 시동 전 휴지 전압으로 시작 잔량을 잡고,
그 뒤에는 FC 가 센 소모량만 뺀다 (라이브: tools/live/drone_live.py, 재생: tools/live/bin_playback.py).

🔴 부하가 걸린 전압으로는 쓰지 않는다 — 새그 때문에 출렁인다 (docs/procedures/05-log-retrieval.md E항).
   쓰는 것은 시동 전 무부하 샘플 하나뿐이다.
"""

CELLS = 4
CAPACITY_MAH = 2900.0      # BATT_CAPACITY 와 같다 — 🔶 노화·실제 용량은 미확인
REST_MAX_A = 1.0           # 이 전류 아래일 때만 「무부하」 로 본다

# 이 팩(VEGA 4S 2900 mAh)의 셀당 휴지 전압(V) → 잔량(%).
# 근거: 2026-10-12 충전기 — 3.66 V 에서 충전기가 2002 mAh, 3.89 V 에서 921 mAh 를 만충까지 넣었다
#   (잔량 = 100 − 넣은 mAh ÷ 2900). 4.19 V = 만충. 🔶 점이 3개뿐이고 직선 보간이다.
#   3.66 V 아래는 첫 구간의 기울기를 그대로 늘린 추정 — 실측 없음.
# 전체 기록: components/batteries/vega-graphene-4s-2900-70c/README.md
_CURVE = ((3.66, 31.0), (3.89, 68.2), (4.19, 100.0))


def pct_from_rest_voltage(v_pack):
    """팩 전압(V, 무부하) → 시작 잔량(%, 0~100)."""
    v = v_pack / CELLS
    (v0, p0), (v1, p1), (v2, p2) = _CURVE
    if v <= v1:
        pct = p0 + (v - v0) / (v1 - v0) * (p1 - p0)
    else:
        pct = p1 + (v - v1) / (v2 - v1) * (p2 - p1)
    return max(0.0, min(100.0, pct))
