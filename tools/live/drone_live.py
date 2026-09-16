#!/usr/bin/env python3
"""DRONE(2 kg 쿼드) 전용 라이브 화면.

SHADE01 의 `web/live/mav_live.py` 와 **별개 프로그램**이다. 화면(HTML/CSS/JS)은
SHADE01 것을 그대로 읽어 쓰지만, 파싱은 이 파일이 따로 한다. SHADE01 코드는
한 줄도 건드리지 않는다.

🔴 왜 따로 만들었나 (2026-09-16)
   SHADE01 의 live 로 이 기체를 보면 **조용히 틀린 화면**이 나온다. 두 가지다.

   1. 모터를 MAIN3/4/6/7 에서 읽는다. 그것은 SHADE01(VTOL) 의 출력 배치다.
      이 기체는 ArduCopter 쿼드라 **MAIN1~4** 다. 겹치는 3,4 만 그려지고
      나머지 둘은 "—" 로 비었다 — 모터가 안 도는 것처럼 보였다.
      (2026-09-16 실측: M1=1443 M2=1500 M3=1541 M4=1396 으로 넷 다 살아 있었다)

   2. 배터리를 `BATTERY_STATUS` 우선으로 읽는다. 그것은 PX4 + PM08 DroneCAN
      전제다. ArduCopter 3.6.12 는 이 메시지를 **껍데기로** 보낸다 —
      current 0 / remaining 100 / voltages 전부 65535 (2026-09-16 실측).
      그래서 화면이 늘 100 % · 0.0 A 였다.
      이 기체는 `SYS_STATUS` 를 봐야 한다 (14811 mV / 13 = 1.3 A / 98 %).

   섞으면 CLAUDE.md 가 금지한 "다른 기체 값을 이 기체 것처럼 쓰기" 가 된다.

읽기 전용이다. FC 로 나가는 바이트는 **데이터 스트림 요청뿐**이다 —
`request_data_stream_send` 는 텔레메트리를 달라는 요청이고 파라미터·명령이
아니다. 파라미터 쓰기, arm/disarm, 모드 변경은 이 파일에 없다.
"""

import argparse
import json
import math
import os
import socket
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    from pymavlink import mavutil
except ImportError:
    sys.exit("pymavlink 이 없다. ~/.venv-mav/bin/python 으로 실행해라.")


# ── 상수 ──────────────────────────────────────────────────────────────
LINK_TIMEOUT = 3.0          # 이 초 동안 조용하면 화면이 "끊김" 으로 본다
TRACK_MAX = 20000           # 항적 상한. 넘으면 앞에서 버린다
MSG_MAX = 200               # STATUSTEXT 보관 수

# SHADE01 의 화면 자산을 그대로 쓴다. 같은 JSON 스키마를 내면 그대로 그려진다.
#
# 🔴 자산이 **두 디렉터리에 나뉘어** 있다 (2026-09-16 캡처로 규명).
#    index.html 은 /app.css·/chart.js·/vendor/leaflet/ 을 루트에서 찾는데
#    그것들은 live/public 이 아니라 web/public 에 있다. 앞쪽만 서빙하면
#    404 가 나고 **CSS 변수가 통째로 빠져 글자가 전부 검정**으로 나온다
#    (app.css 에 색 토큰 21개가 있다).
#    앞에 있는 것이 이긴다 — index.html 은 양쪽에 다 있고 live 쪽이 맞다.
DEFAULT_PUBLIC = [
    os.path.expanduser('~/SHADE01/web/live/public'),
    os.path.expanduser('~/SHADE01/web/public'),
]

# ArduCopter 비행모드. 🔴 PX4 표와 다르다 — 섞지 마라.
#    출처: ArduPilot/ArduCopter/mode.h (Mode::Number), 3.6 기준
COPTER_MODE = {
    0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED',
    5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT',
    13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE',
    18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL',
    22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID',
    26: 'AUTOROTATE',
}

# GPS_RAW_INT.fix_type
FIX = {0: 'NO_GPS', 1: 'NO_FIX', 2: '2D', 3: '3D', 4: 'DGPS',
       5: 'RTK_FLOAT', 6: 'RTK_FIXED'}

# 🔴 이 기체의 모터 배치. MAIN1~4 = servo1~4_raw 다.
#    `SERVO_OUTPUT_RAW` 의 필드는 servo1_raw 부터라 **1 부터 센다**.
#    위치·회전은 2026-09-16 실측값이다 (커밋 f3ee0e8, FC_CHANGELOG 09-16 항목):
#      MAIN1=우전/CCW  MAIN2=우후/CW  MAIN3=좌후/CCW  MAIN4=좌전/CW
#    🔴 이 상수는 그동안 옛(틀린) 매핑을 들고 있었다 — f3ee0e8 정정이
#       여기 반영이 안 됐었다. 2026-09-17 에 바로잡았다.
#    화면 라벨은 SHADE01 과 같은 이름(RF/RB/LF/LB)을 쓴다 — 프론트가 그 키를
#    기대하기 때문이다. 핀 번호만 이 기체 것으로 바꾼 것이다.
MOTOR_PINS = (('RF', 1), ('RB', 2), ('LB', 3), ('LF', 4))


def dumps_json(obj):
    return json.dumps(obj, ensure_ascii=False, separators=(',', ':'))


# 재생할 .BIN 이 있는 곳. flights/sd-recovered-* 를 전부 훑는다.
LOG_DIRS = [os.path.expanduser('~/DRONE/flights')]


def list_logs():
    """재생 가능한 .BIN 목록. 최신(파일명 역순)이 먼저."""
    out = []
    for root in LOG_DIRS:
        if not os.path.isdir(root):
            continue
        for dirpath, _, names in os.walk(root):
            for name in names:
                if name.lower().endswith('.bin'):
                    full = os.path.join(dirpath, name)
                    try:
                        size = os.path.getsize(full)
                    except OSError:
                        continue
                    out.append({'name': name, 'path': full, 'size': size})
    out.sort(key=lambda e: e['name'], reverse=True)
    return out


class LogPlayback:
    """열어 둔 로그 하나. SHADE01 의 Playback 클래스와 같은 역할이다
    (mav_live.py) — 이 기체(.BIN)에 맞게 bin_playback 을 쓸 뿐이다.

    서버가 시간을 흘리지 않는다 — 재생 시각은 브라우저가 정하고,
    서버는 「이 시각의 프레임을 달라」에 답할 뿐이다 (SHADE01 과 동일 원칙).
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.fl = None
        self.err = None
        self.loading = None

    def open(self, name):
        import bin_playback
        matches = [e for e in list_logs() if e['name'] == name]
        if not matches:
            with self.lock:
                self.err = '그런 로그가 없다'
                self.loading = None
            return
        path = matches[0]['path']
        with self.lock:
            self.loading = name
            self.err = None
            self.fl = None
        try:
            fl = bin_playback.load_flight(path)
        except Exception as exc:
            with self.lock:
                self.err = str(exc)
                self.loading = None
            return
        with self.lock:
            self.fl = fl
            self.loading = None

    def close(self):
        with self.lock:
            self.fl = None
            self.err = None
            self.loading = None

    def info(self):
        with self.lock:
            if self.loading:
                return {'state': 'loading', 'name': self.loading}
            if self.err:
                return {'state': 'error', 'error': self.err}
            if not self.fl:
                return {'state': 'idle'}
            f = self.fl
            return {'state': 'ready', 'name': f['name'], 'dur': f['dur'],
                    'utc': f['utc'], 'hz': f['hz'], 'frames': len(f['frames']),
                    'repaired': f['repaired'], 'home': f['home'],
                    'track_n': len(f['track']), 'messages_n': len(f['messages'])}

    def series(self):
        """차트용 전량 시계열. drone_live 의 핵심 채널만 낸다
        (자세·모터출력·배터리·GPS — 2026-09-16 범위 결정)."""
        with self.lock:
            if not self.fl:
                return None
            frames = self.fl['frames']
            cols = {k: [] for k in ('roll', 'pitch', 'yaw', 'volt', 'cur',
                                    'sats', 'alt')}
            motor_cols = {n: [] for n, _ in MOTOR_PINS}
            modes = []
            last_mode = None
            for fr in frames:
                d = fr['d']
                for k in cols:
                    cols[k].append(d.get(k))
                mo = d.get('motors') or {}
                for n in motor_cols:
                    motor_cols[n].append(mo.get(n))
                m = d.get('mode')
                if m and m != last_mode:
                    modes.append({'t': fr['t'], 'name': m})
                    last_mode = m
            cols['motors'] = motor_cols
            return {'hz': self.fl['hz'], 'n': len(frames), 'dur': self.fl['dur'],
                    'cols': cols, 'modes': modes, 'messages': self.fl['messages']}

    def at(self, ts):
        """재생 시각 ts(초) 의 상태를 라이브와 같은 모양(/api/state)으로."""
        with self.lock:
            if not self.fl:
                return None
            f = self.fl
            frames = f['frames']
            if not frames:
                return None
            i = int(round(ts * f['hz']))
            i = max(0, min(len(frames) - 1, i))
            fr = frames[i]
            msgs = [m for m in f['messages'] if m['t'] <= fr['t']][-40:]
            trk = [p for p in f['track'] if len(p) > 3 and p[3] <= fr['t']]
            return {
                'live': True, 'playback': True, 'name': f['name'],
                'dur': f['dur'], 'utc': f['utc'], 'pos': fr['t'], 'i': i,
                'n': len(frames), 'seq': i, 'age': 0, 'packets': i,
                'link': 'LOG', 'src': f['name'], 'sysid': 1,
                'uptime': round(fr['t']), 'd': fr['d'], 'home': f['home'],
                'vehicle': 'DRONE', 'mission': [],
                'track': [[p[0], p[1], p[2]] for p in trk],
                'messages': msgs,
            }


class State:
    """수신한 텔레메트리를 화면이 쓸 형태로 모아 둔다."""

    def __init__(self):
        self.lock = threading.Lock()
        self.d = {}                     # 최신값 묶음
        self.track = []                 # [lat, lon, alt_rel]
        self.track_total = 0
        self.messages = deque(maxlen=MSG_MAX)
        self.home = None
        self.seen = None                # 마지막 수신 시각(monotonic)
        self.packets = 0
        self.bytes = 0
        self.src = None
        self.sysid = None
        self.boot = time.time()
        self._seq = 0
        self._last_track = 0.0

    # ── 수신 ──────────────────────────────────────────────────────
    def feed(self, msg):
        t = msg.get_type()
        if t == 'BAD_DATA':
            return
        with self.lock:
            self.seen = time.monotonic()
            self.packets += 1
            self._seq += 1
            d = self.d
            try:
                self._apply(t, msg, d)
            except Exception as exc:                # noqa: BLE001
                # 한 메시지가 깨져도 화면 전체가 멈추면 안 된다.
                self.messages.append(
                    {'t': time.time(), 'sev': 3,
                     'text': '파싱 오류 %s: %s' % (t, exc)})

    def _apply(self, t, msg, d):
        if t == 'HEARTBEAT':
            self.sysid = msg.get_srcSystem()
            d['mav_type'] = msg.type
            d['armed'] = bool(msg.base_mode
                              & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
            # 🔴 ArduCopter 는 custom_mode 가 곧 모드 번호다.
            #    PX4 처럼 main/sub 로 쪼개 읽으면 안 된다.
            d['mode'] = COPTER_MODE.get(msg.custom_mode,
                                        'MODE_%d' % msg.custom_mode)
            d['sys_status'] = msg.system_status

        elif t == 'SYS_STATUS':
            # 🔴 이 기체의 배터리 정본이다. BATTERY_STATUS 가 아니다 —
            #    파일 첫머리 주석 참조.
            d['volt'] = (round(msg.voltage_battery / 1000.0, 2)
                         if msg.voltage_battery not in (0, 65535) else None)
            d['cur'] = (msg.current_battery / 100.0
                        if msg.current_battery != -1 else None)
            d['batt_pct'] = (msg.battery_remaining
                             if msg.battery_remaining != -1 else None)
            d['load'] = round(msg.load / 10.0, 1)
            d['drop'] = msg.drop_rate_comm
            d['errors_comm'] = msg.errors_comm

        elif t == 'BATTERY_STATUS':
            # ArduCopter 3.6.12 는 여기를 껍데기로 보낸다 (실측). 값이 실제로
            # 채워져 오면 그때만 쓴다 — 지금은 거의 항상 건너뛴다.
            if msg.current_consumed not in (-1, 0):
                d['mah'] = msg.current_consumed
            if msg.temperature not in (0, 32767, -1):
                d['batt_temp'] = round(msg.temperature / 100.0, 1)

        elif t == 'ATTITUDE':
            d['roll'] = round(math.degrees(msg.roll), 1)
            d['pitch'] = round(math.degrees(msg.pitch), 1)
            d['yaw'] = round((math.degrees(msg.yaw) + 360) % 360, 1)
            d['rollspeed'] = round(math.degrees(msg.rollspeed), 1)
            d['pitchspeed'] = round(math.degrees(msg.pitchspeed), 1)
            d['yawspeed'] = round(math.degrees(msg.yawspeed), 1)

        elif t == 'VFR_HUD':
            # 🔴 키 이름은 화면(live.js)이 정한다. `spd` 로 내면 속도 칸이
            #    영원히 "—" 다 — 프론트는 `groundspeed` 를 읽는다 (2026-09-16
            #    캡처로 확인). 화면 자산을 SHADE01 과 공유하는 대가다.
            d['groundspeed'] = round(msg.groundspeed, 2)
            d['airspeed'] = round(msg.airspeed, 2)
            d['hdg'] = msg.heading
            d['climb'] = round(msg.climb, 2)
            d['thr'] = msg.throttle
            d['alt_msl'] = round(msg.alt, 2)

        elif t == 'GLOBAL_POSITION_INT':
            d['alt'] = round(msg.relative_alt / 1000.0, 2)
            lat, lon = msg.lat / 1e7, msg.lon / 1e7
            d['lat'], d['lon'] = lat, lon
            # vx/vy 는 화면이 지도 위 속도 벡터에 쓴다. cm/s 로 온다.
            d['vx'] = round(msg.vx / 100.0, 2)
            d['vy'] = round(msg.vy / 100.0, 2)
            d['vz'] = round(msg.vz / 100.0, 2)
            # lat/lon 0 은 "아직 픽스 없음" 이다. 항적에 넣으면 아프리카 앞바다
            # 에 점이 찍힌다.
            if lat or lon:
                now = time.monotonic()
                if now - self._last_track >= 1.0:
                    self._last_track = now
                    self.track.append([round(lat, 7), round(lon, 7),
                                       d['alt']])
                    self.track_total += 1
                    if len(self.track) > TRACK_MAX:
                        self.track = self.track[-TRACK_MAX:]

        elif t == 'GPS_RAW_INT':
            d['sats'] = msg.satellites_visible
            d['fix'] = msg.fix_type
            d['fix_s'] = FIX.get(msg.fix_type, str(msg.fix_type))
            # eph 9999 = 값 없음. 그대로 99.99 로 그리면 거짓 정밀도가 된다.
            d['eph'] = None if msg.eph in (0, 65535, 9999) else \
                round(msg.eph / 100.0, 2)

        elif t == 'EKF_STATUS_REPORT':
            # 🔴 화면은 `ekf_ratio` 를 읽는다 (live.js:584). `ekf` 로 내면
            #    EKF 칸이 안 그려진다.
            d['ekf_ratio'] = {
                'vel': round(msg.velocity_variance, 3),
                'pos': round(msg.pos_horiz_variance, 3),
                'hgt': round(msg.pos_vert_variance, 3),
                'mag': round(msg.compass_variance, 3),
            }
            d['ekf_flags'] = msg.flags

        elif t == 'VIBRATION':
            # 🔴 화면이 읽는 이름은 `vibe` 다. `vib` 가 아니다.
            d['vibe'] = [round(msg.vibration_x, 2),
                         round(msg.vibration_y, 2),
                         round(msg.vibration_z, 2)]
            d['clip'] = [msg.clipping_0, msg.clipping_1, msg.clipping_2]

        elif t == 'SERVO_OUTPUT_RAW':
            # 🔴 MAIN1~4 다. SHADE01 의 3/4/6/7 이 아니다 — 첫머리 주석 참조.
            #    PWM 1000~2000us 를 0~100 % 로 편다. 900 미만은 "출력 없음".
            out = {}
            for name, pin in MOTOR_PINS:
                v = getattr(msg, 'servo%d_raw' % pin, 0)
                out[name] = None if (v is None or v < 900) else \
                    round(max(0.0, min(100.0, (v - 1000.0) / 10.0)), 1)
            if any(v is not None for v in out.values()):
                d['motors'] = out
                d['motors_pwm'] = {n: getattr(msg, 'servo%d_raw' % p, 0)
                                   for n, p in MOTOR_PINS}

        elif t == 'RC_CHANNELS':
            # rssi 255 = 값 없음. 이 기체는 RSSI_TYPE=0 이라 늘 0 이 온다.
            d['rssi'] = msg.rssi if msg.rssi not in (255,) else None
            n = min(getattr(msg, 'chancount', 8) or 8, 18)
            d['rc_chan'] = [getattr(msg, 'chan%d_raw' % i)
                            for i in range(1, n + 1)]
            d['rc_count'] = n

        elif t == 'SCALED_PRESSURE':
            d['press'] = round(msg.press_abs, 2)
            d['baro_temp'] = round(msg.temperature / 100.0, 1)

        elif t == 'POWER_STATUS':
            d['vcc'] = round(msg.Vcc / 1000.0, 2)
            d['vservo'] = round(msg.Vservo / 1000.0, 2)

        elif t == 'HOME_POSITION':
            self.home = [msg.latitude / 1e7, msg.longitude / 1e7,
                         msg.altitude / 1000.0]

        elif t == 'STATUSTEXT':
            self.messages.append({'t': time.time(), 'sev': msg.severity,
                                  'text': msg.text})

    # ── 송신 ──────────────────────────────────────────────────────
    def snapshot(self, since=None, want_track=True):
        with self.lock:
            live = ((time.monotonic() - self.seen) < LINK_TIMEOUT
                    if self.seen else False)
            n = len(self.track)
            dropped = self.track_total - n
            if since is None or since < dropped:
                start = 0
            else:
                start = min(since - dropped, n)
            return {
                'live': live,
                'seq': self._seq,
                'age': (round(time.monotonic() - self.seen, 2)
                        if self.seen else None),
                'packets': self.packets,
                'bytes': self.bytes,
                'src': self.src,
                'link': 'usb' if live else None,
                'links': {'usb': round(time.monotonic() - self.seen, 2)}
                         if self.seen else {},
                'pin': None,
                'sysid': self.sysid,
                'uptime': round(time.time() - self.boot),
                'vehicle': 'DRONE',      # 화면이 기체를 구분할 수 있게
                'd': dict(self.d),
                'home': self.home,
                'mission': None,
                'track_n': self.track_total,
                'track_from': dropped + start,
                'track': self.track[start:] if want_track else [],
                'messages': list(self.messages)[-40:],
            }


# ── MAVLink 수신 스레드 ───────────────────────────────────────────────
def reader(st, device, baud, stop):
    """FC 에 붙어 계속 읽는다. 끊기면 다시 붙는다."""
    while not stop.is_set():
        conn = None
        try:
            print('[link] %s 에 붙는다 (baud=%d)' % (device, baud), flush=True)
            conn = mavutil.mavlink_connection(device, baud=baud)
            hb = conn.wait_heartbeat(timeout=10)
            if hb is None:
                raise RuntimeError('HEARTBEAT 없음')

            # 🔴 이 기체가 맞는지 본다. mav_type 2 = 쿼드.
            #    22(VTOL)이면 SHADE01 이 꽂힌 것이다 — 그 값을 이 화면으로
            #    그리면 CLAUDE.md 가 금지한 기체 혼동이 된다.
            if hb.type != mavutil.mavlink.MAV_TYPE_QUADROTOR:
                print('[link] ⚠️ mav_type=%d 다 (쿼드=2 가 아니다). '
                      'SHADE01 이 꽂혔을 수 있다. 화면을 신뢰하지 마라.'
                      % hb.type, flush=True)

            st.src = device
            print('[link] 붙었다. sysid=%d type=%d autopilot=%d'
                  % (hb.get_srcSystem(), hb.type, hb.autopilot), flush=True)

            # 텔레메트리를 달라는 요청. 읽기 전용 보장을 깨지 않는다.
            conn.mav.request_data_stream_send(
                conn.target_system, conn.target_component,
                mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1)

            last_req = time.monotonic()
            while not stop.is_set():
                msg = conn.recv_match(blocking=True, timeout=2)
                if msg is None:
                    # 2초 조용하면 스트림 요청을 다시 보낸다. FC 가 재부팅
                    # 되면 스트림 설정이 날아간다.
                    if time.monotonic() - last_req > 5:
                        conn.mav.request_data_stream_send(
                            conn.target_system, conn.target_component,
                            mavutil.mavlink.MAV_DATA_STREAM_ALL, 10, 1)
                        last_req = time.monotonic()
                    continue
                st.feed(msg)
        except Exception as exc:                    # noqa: BLE001
            print('[link] 끊김: %s' % exc, flush=True)
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:                   # noqa: BLE001
                    pass
        if not stop.is_set():
            time.sleep(2)


# ── HTTP ──────────────────────────────────────────────────────────────
def _qs(query, key):
    for kv in query.split('&'):
        if kv.startswith(key + '='):
            return kv[len(key) + 1:]
    return ''


class Handler(BaseHTTPRequestHandler):
    st = None
    public = None
    pb = None

    def log_message(self, fmt, *args):
        pass                                        # 접속 로그는 끈다

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_GET(self):                               # noqa: N802
        # 🔴 GET 만 연다. POST 가 없다는 것이 이 서버의 읽기 전용 보장이다.
        path = self.path.split('?')[0]
        query = self.path.split('?')[1] if '?' in self.path else ''

        if path == '/api/state':
            since = None
            want_track = True
            for kv in query.split('&'):
                if kv.startswith('since='):
                    try:
                        since = int(kv[6:])
                    except ValueError:
                        pass
                elif kv == 'track=0':
                    want_track = False
            return self._send(200,
                              dumps_json(self.st.snapshot(since, want_track)),
                              'application/json; charset=utf-8')

        # 🔴 링크고정은 여전히 지원하지 않는다 — 경로가 USB 하나뿐이라
        # 고를 것이 없다. 로그 재생은 2026-09-17 부터 지원한다 (아래).
        if path == '/api/link':
            return self._send(200, dumps_json({'pin': None, 'link': 'usb'}),
                              'application/json; charset=utf-8')

        # ── 로그 재생 (2026-09-17) ───────────────────────────────────
        # SHADE01 의 /api/logs, /api/playback/* 와 같은 이름·모양을 쓴다 —
        # 프론트(index.html/app.js)가 SHADE01 것 그대로라 그 쪽이 부르는
        # 경로를 맞춰야 그려진다. 실제 파싱은 bin_playback.py, 상태는
        # 위 LogPlayback 이 한다.
        if path == '/api/logs':
            return self._send(200, dumps_json(
                {'logs': list_logs(), 'source': 'local', 'remote': None,
                 'error': None}),
                'application/json; charset=utf-8')

        if path == '/api/playback/open':
            name = None
            for kv in query.split('&'):
                if kv.startswith('name='):
                    from urllib.parse import unquote
                    name = unquote(kv[5:])
            if not name:
                return self._send(400, '{"error":"name 이 없다"}',
                                  'application/json')
            allowed = {e['name'] for e in list_logs()}
            if name not in allowed:
                return self._send(404, '{"error":"그런 로그가 없다"}',
                                  'application/json')
            threading.Thread(target=self.pb.open, args=(name,), daemon=True).start()
            return self._send(200, dumps_json({'ok': True, 'name': name}),
                              'application/json; charset=utf-8')

        if path == '/api/playback/close':
            self.pb.close()
            return self._send(200, '{"ok":true}', 'application/json')

        if path == '/api/playback/info':
            return self._send(200, dumps_json(self.pb.info()),
                              'application/json; charset=utf-8')

        if path == '/api/playback/series':
            body = self.pb.series()
            if body is None:
                return self._send(409, dumps_json(self.pb.info()),
                                  'application/json; charset=utf-8')
            return self._send(200, dumps_json(body),
                              'application/json; charset=utf-8')

        if path == '/api/playback/state':
            ts = 0.0
            for kv in query.split('&'):
                if kv.startswith('t='):
                    try:
                        ts = float(kv[2:])
                    except ValueError:
                        pass
            snap = self.pb.at(ts)
            if snap is None:
                return self._send(409, dumps_json(self.pb.info()),
                                  'application/json; charset=utf-8')
            return self._send(200, dumps_json(snap),
                              'application/json; charset=utf-8')

        # 정적 파일. 여러 뿌리를 **순서대로** 뒤진다 — 앞이 이긴다.
        rel = 'index.html' if path in ('/', '') else path.lstrip('/')
        full = None
        for root in self.public:
            cand = os.path.normpath(os.path.join(root, rel))
            # 🔴 ../ 로 그 뿌리 밖을 못 읽게 한다. 뿌리마다 따로 본다.
            if not cand.startswith(root):
                continue
            if os.path.isfile(cand):
                full = cand
                break
        if full is None:
            return self._send(404, 'not found', 'text/plain')
        ctype = {
            '.html': 'text/html; charset=utf-8',
            '.css': 'text/css; charset=utf-8',
            '.js': 'application/javascript; charset=utf-8',
            '.json': 'application/json; charset=utf-8',
            '.png': 'image/png', '.svg': 'image/svg+xml',
            '.ico': 'image/x-icon',
        }.get(os.path.splitext(full)[1], 'application/octet-stream')
        with open(full, 'rb') as fh:
            body = fh.read()
        # 🔴 탭 제목이 "SHADE01 라이브" 로 뜨면 기체를 오인한다. 원본은
        #    SHADE01 소유라 못 고치므로 내보낼 때만 바꾼다.
        if rel.endswith('.html'):
            body = body.replace('SHADE01 라이브'.encode('utf-8'),
                                'DRONE 라이브'.encode('utf-8'))
        return self._send(200, body, ctype)


def main():
    ap = argparse.ArgumentParser(
        description='DRONE(2kg 쿼드) 전용 라이브 화면 — 읽기 전용')
    ap.add_argument('--device', default='/dev/ttyACM0',
                    help='FC 시리얼 경로 (기본 /dev/ttyACM0)')
    ap.add_argument('--baud', type=int, default=115200)
    ap.add_argument('--http', type=int, default=4401,
                    help='HTTP 포트 (기본 4401 — SHADE01 은 4400)')
    ap.add_argument('--public', action='append', default=None,
                    help='화면 자산 경로. 여러 번 줄 수 있고 앞이 이긴다. '
                         '(기본: SHADE01 의 live/public + web/public)')
    args = ap.parse_args()

    roots = [os.path.realpath(os.path.expanduser(p))
             for p in (args.public or DEFAULT_PUBLIC)]
    missing = [p for p in roots if not os.path.isdir(p)]
    if missing:
        sys.exit('화면 자산이 없다: %s' % ', '.join(missing))

    st = State()
    stop = threading.Event()
    th = threading.Thread(target=reader,
                          args=(st, args.device, args.baud, stop),
                          daemon=True)
    th.start()

    Handler.st = st
    Handler.public = roots
    Handler.pb = LogPlayback()
    srv = ThreadingHTTPServer(('127.0.0.1', args.http), Handler)
    print('[http] http://localhost:%d  (127.0.0.1 만 듣는다)' % args.http,
          flush=True)
    for i, p in enumerate(roots):
        print('[http] 화면 자산 %d: %s' % (i + 1, p), flush=True)
    print('종료: Ctrl-C', flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print('\n종료한다', flush=True)
    finally:
        stop.set()
        srv.server_close()


if __name__ == '__main__':
    main()
