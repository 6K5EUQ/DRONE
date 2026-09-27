"""ArduCopter .BIN 로그를 재생 프레임으로 굽는다 (drone_live.py 가 쓴다).

🔴 범위를 자세·모터출력·배터리·GPS 로 좁혔다 (2026-09-16 결정).
   EKF 혁신비·진동은 안 낸다 — 필요해지면 여기 추가한다.

반환 모양:
    {'name','path','dur','utc','frames':[{'t','d'},...],'messages':[...],
     'home':[lat,lon] 또는 None, 'track':[[lat,lon,alt],...],
     'hz','repaired','pruned'}
"""
import math
import os

from pymavlink import mavutil

FRAME_HZ = 5.0

COPTER_MODE = {
    0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED',
    5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT',
    13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE',
    18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL',
    22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID',
    26: 'AUTOROTATE',
}
FIX = {0: 'NO_GPS', 1: 'NO_FIX', 2: '2D', 3: '3D', 4: 'DGPS',
       5: 'RTK_FLOAT', 6: 'RTK_FIXED'}

# drone_live.py 의 MOTOR_PINS 와 반드시 같은 값을 유지한다 (2026-09-16 실측,
# 커밋 f3ee0e8): MAIN1=우전/CCW MAIN2=우후/CW MAIN3=좌후/CCW MAIN4=좌전/CW
MOTOR_PINS = (('RF', 1), ('RB', 2), ('LB', 3), ('LF', 4))


class LogUnreadable(Exception):
    pass


# 이 기체의 배터리 용량(mAh). FC 파라미터 BATT_CAPACITY 와 같은 값이다
# (2900 — 2026-09-14 실기 조회, 보유 4S 2900mAh 와 일치).
BATT_CAPACITY_MAH = 2900.0


def _pct_from_mah(used_mah):
    """소모 mAh 에서 잔량(%)을 낸다.

    🔴 .BIN 에는 SYS_STATUS.battery_remaining 이 없다 (2026-09-17 확인).
       라이브는 FC 가 계산해 준 값을 그대로 쓰지만 로그에는 없어서 여기서
       만든다. **전압으로는 추정하지 않는다** — 실측해 보니 같은 비행에서
       무부하 14.56V(37%) → 호버 13.65V(12%) → 착륙 14.44V(34%) 로
       출렁여 쓸 수 없었다. 실제 소모는 20.3mAh, 즉 거의 만충이었다.
       BAT.CurrTot(누적 소모 mAh)가 FC 가 적분한 값이라 훨씬 곧다.

    ⚠️ 시작 시점을 만충으로 가정한다. 쓰던 배터리를 꽂고 날았다면 실제보다
       높게 나온다. 로그에 시작 잔량이 없어 알 길이 없다.
    """
    if used_mah is None:
        return None
    pct = (1.0 - used_mah / BATT_CAPACITY_MAH) * 100.0
    return int(max(0.0, min(100.0, pct)))


def load_flight(path):
    """.BIN 하나를 5Hz 프레임으로 굽는다."""
    try:
        m = mavutil.mavlink_connection(path)
    except Exception as exc:
        raise LogUnreadable(str(exc))

    # ── 1차 훑기: 전 구간 원시 샘플을 시각순으로 모은다 ──────────────
    att = []    # (t, roll, pitch, yaw)
    gps = []    # (t, fix, sats, lat, lon, alt)
    bat = []    # (t, volt, curr)
    rcou = []   # (t, {pin: pwm})
    ctun = []   # (t, alt_m, crt_cms, thr_out)
    mode = []   # (t, name)
    events = []  # {'t', 'text'}
    ev_arm = []  # (t, id)  — EV.Id: 10=ARMED, 11=DISARMED
    fw = None
    frame_hint = None

    while True:
        try:
            msg = m.recv_match()
        except Exception:
            continue
        if msg is None:
            break
        t = msg.get_type()
        if not hasattr(msg, 'TimeUS'):
            continue
        ts = msg.TimeUS / 1e6

        if t == 'ATT':
            att.append((ts, msg.Roll, msg.Pitch, (msg.Yaw + 360) % 360))
        elif t == 'GPS':
            gps.append((ts, msg.Status, msg.NSats, msg.Lat, msg.Lng, msg.Alt,
                        getattr(msg, 'Spd', None)))
        elif t == 'BAT':
            bat.append((ts, msg.Volt, msg.Curr, getattr(msg, 'CurrTot', None)))
        elif t == 'RCOU':
            pins = {p: getattr(msg, 'C%d' % p, 0) for _, p in MOTOR_PINS}
            rcou.append((ts, pins))
        elif t == 'CTUN':
            # Alt = 상대고도(m), CRt = 상승률(cm/s), ThO = 스로틀 출력(0~1)
            ctun.append((ts, msg.Alt, getattr(msg, 'CRt', None),
                         getattr(msg, 'ThO', None)))
        elif t == 'MODE':
            mode.append((ts, COPTER_MODE.get(int(msg.Mode), 'MODE_%d' % msg.Mode)))
        elif t == 'EV':
            ev_arm.append((ts, msg.Id))
        elif t == 'MSG':
            txt = msg.Message
            if 'ArduCopter' in txt or 'ArduPlane' in txt:
                fw = txt
            if 'Frame:' in txt:
                frame_hint = txt
            events.append({'t': round(ts, 2), 'text': txt})
        elif t == 'ERR':
            events.append({'t': round(ts, 2),
                            'text': 'ERR subsys=%s code=%s' % (msg.Subsys, msg.ECode)})

    if not att and not gps and not bat:
        raise LogUnreadable('디코딩할 토픽이 없다.')

    all_ts = ([r[0] for r in att] + [r[0] for r in gps] +
              [r[0] for r in bat] + [r[0] for r in rcou])
    if not all_ts:
        raise LogUnreadable('시각을 가진 메시지가 없다.')
    t0, t1 = min(all_ts), max(all_ts)
    dur = max(0.0, t1 - t0)

    # ── armed 상태 (라이브의 d['armed'] 와 같은 의미) ────────────────
    armed_spans = []  # [(start,end)...] end=None 이면 로그 끝까지
    cur_start = None
    for ts, eid in sorted(ev_arm):
        if eid == 10:
            cur_start = ts
        elif eid == 11 and cur_start is not None:
            armed_spans.append((cur_start, ts))
            cur_start = None
    if cur_start is not None:
        armed_spans.append((cur_start, None))

    def armed_at(ts):
        for s, e in armed_spans:
            if s <= ts and (e is None or ts <= e):
                return True
        return False

    # ── 2차: 5Hz 격자로 프레임 굽기 ───────────────────────────────
    def nearest(rows, ts, tol=1.0):
        """rows: [(t, ...), ...] 정렬됨. ts 에 가장 가까운 행. tol 초과면 None."""
        if not rows:
            return None
        lo, hi = 0, len(rows) - 1
        best = None
        while lo <= hi:
            mid = (lo + hi) // 2
            if rows[mid][0] < ts:
                lo = mid + 1
            else:
                hi = mid - 1
        for i in (hi, lo):
            if 0 <= i < len(rows) and abs(rows[i][0] - ts) <= tol:
                if best is None or abs(rows[i][0] - ts) < abs(best[0] - ts):
                    best = rows[i]
        return best

    att.sort(); gps.sort(); bat.sort(); rcou.sort(); ctun.sort()

    n_frames = max(1, int(dur * FRAME_HZ) + 1)
    frames = []
    track = []
    home = None
    last_mode = None
    mode_i = 0

    for i in range(n_frames):
        ts = t0 + i / FRAME_HZ
        d = {}

        a = nearest(att, ts)
        if a:
            d['roll'] = round(a[1], 1)
            d['pitch'] = round(a[2], 1)
            d['yaw'] = round(a[3], 1)

        g = nearest(gps, ts)
        if g:
            fix = int(g[1])
            d['fix'] = fix
            d['fix_s'] = FIX.get(fix, str(fix))
            d['sats'] = int(g[2])
            if g[6] is not None:
                d['groundspeed'] = round(g[6], 2)
            if g[3] and g[4] and (abs(g[3]) > 1e-6 or abs(g[4]) > 1e-6):
                d['lat'], d['lon'] = g[3], g[4]
                d['alt'] = round(g[5], 2)
                if home is None:
                    home = [g[3], g[4]]
                track.append([g[3], g[4], round(g[5], 2), round(ts - t0, 2)])

        b = nearest(bat, ts)
        if b:
            d['volt'] = round(b[1], 2)
            d['cur'] = round(b[2], 2)
            if b[3] is not None:
                d['mah'] = round(b[3], 1)
                pct = _pct_from_mah(b[3])
                if pct is not None:
                    d['batt_pct'] = pct
                    d['batt_pct_est'] = True   # FC 가 준 값이 아니라 계산한 값

        r = nearest(rcou, ts)
        if r:
            pins = r[1]
            out = {}
            pwm = {}
            for name, pin in MOTOR_PINS:
                v = pins.get(pin, 0)
                out[name] = None if (not v or v < 900) else \
                    round(max(0.0, min(100.0, (v - 1000.0) / 10.0)), 1)
                pwm[name] = v
            if any(v is not None for v in out.values()):
                d['motors'] = out
                d['motors_pwm'] = pwm

        c = nearest(ctun, ts)
        if c:
            # GPS 고정이 없으면 위에서 alt 가 안 채워진다. 실내 로그가 그렇다 —
            # CTUN.Alt(기압계 기준 상대고도)를 쓴다.
            if d.get('alt') is None and c[1] is not None:
                d['alt'] = round(c[1], 2)
            if c[2] is not None:
                d['climb'] = round(c[2] / 100.0, 2)   # cm/s → m/s
            if c[3] is not None:
                d['thr'] = round(c[3] * 100.0)        # 0~1 → %

        d['armed'] = armed_at(ts)

        while mode_i < len(mode) and mode[mode_i][0] <= ts:
            last_mode = mode[mode_i][1]
            mode_i += 1
        if last_mode:
            d['mode'] = last_mode

        frames.append({'t': round(ts - t0, 2), 'd': d})

    return {
        'name': os.path.basename(path),
        'path': path,
        'dur': round(dur, 1),
        'utc': None,  # 이 FC 는 RTC 가 없다 — 09-16 실측, time_utc 는 2000-01-01 근처
        'repaired': False,
        'hz': FRAME_HZ,
        'frames': frames,
        'messages': events,
        'home': home,
        'track': track,
        'firmware': fw,
        'frame_hint': frame_hint,
    }
