"""ArduCopter .BIN 로그를 재생 프레임으로 굽는다.

SHADE01 의 `web/live/playback.py` 와 같은 역할(`load_flight()`)을
이 기체(.BIN)에 맞게 새로 한 것 — 그 파일은 PX4 `.ulg` 전용이라 못 쓴다.
SHADE01 코드는 한 줄도 건드리지 않는다.

🔴 범위를 자세·모터출력·배터리·GPS 로 좁혔다 (2026-09-16 결정).
   EKF 혁신비·진동은 안 낸다 — 필요해지면 여기 추가한다.

반환 모양은 playback.load_flight() 와 맞춘다:
    {'name','path','dur','utc','frames':[{'t','d'},...],'messages':[...],
     'home':[lat,lon] 또는 None, 'track':[[lat,lon,alt],...],
     'hz','repaired','pruned'}
그래야 mav_live.py 의 Playback 클래스가 SHADE01 것이든 이것이든
똑같이 다룰 수 있다 — 실제로는 drone_live.py 가 별도 서버라 이 모양을
그 서버 안에서만 쓴다.
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
            gps.append((ts, msg.Status, msg.NSats, msg.Lat, msg.Lng, msg.Alt))
        elif t == 'BAT':
            bat.append((ts, msg.Volt, msg.Curr))
        elif t == 'RCOU':
            pins = {p: getattr(msg, 'C%d' % p, 0) for _, p in MOTOR_PINS}
            rcou.append((ts, pins))
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

    att.sort(); gps.sort(); bat.sort(); rcou.sort()

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
