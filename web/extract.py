#!/usr/bin/env python3
"""ArduCopter .BIN 하나를 읽어 웹이 쓸 JSON 세 덩어리를 stdout 으로 낸다.

    extract.py row   <path>   목록 한 줄
    extract.py full  <path>   요약 + 시계열 (서버가 쪼개 캐시한다)

출력은 `{"ok", "row", "sum", "trk"}` 한 문서다. 키·단위·격자 규칙은 화면
(public/*.html, *.js) 과 server.js 가 읽는 모양 그대로다 — 여기서 키 이름을
바꾸면 화면이 조용히 빈 칸이 된다.

🔴 파싱은 pymavlink DFReader 한 경로다. 깨진 바이트는 건너뛰고 끝까지 읽는다
   — 중간에 멈추면 짧은 비행으로 보인다. DFReader 는 경고를 **stdout** 으로도
   찍으므로 읽는 동안 stdout 을 stderr 로 돌린다. 안 그러면 JSON 이 깨진다.

고도는 arm 기준 상대고도다. EKF 원점 기준 값을 그대로 쓰면 지상 로그가
0 이 아닌 값으로 떠 "떴는지" 를 눈으로 못 가른다.

시계열은 **균일 격자**로 리샘플한다. 메시지마다 레이트가 달라 각자의 시간축을
보내면 지도·차트·재생 커서가 서로 다른 인덱스를 쓴다. 격자 하나를 공유하면
`i = round(t * rate)` 산술 하나로 전부 정렬된다.

⚠️ 격자 값은 **보여주기용**이다. 최대/최소는 리샘플 전 원본에서 뽑아 `sum` 에 담는다.
"""

import contextlib
import datetime
import json
import math
import os
import re
import sys

import numpy as np
from pymavlink import mavutil


GRID_HZ = 5.0          # 배터리·스틱 레이트 근처. 이보다 올려도 절반이 복제값이다.
GRID_MAX_PTS = 4000    # 긴 비행에서 격자가 무한정 커지지 않게. 넘으면 레이트를 낮춘다.
MAX_EVENTS = 500       # FC 메시지 상한

# ── 판정 임계값 ──────────────────────────────────────────────────────
# 근거: docs/design/01-thrust-weight.md (14×4.8 프롭, 4S 2900mAh 20C). 실비행 미검증.
CUR_FULL_A = 25.0         # 설계상 풀스로틀 총전류
CUR_BATT_A = 58.0         # 배터리 20C 한계
CELL_LOW_V = 3.5          # LiPo 셀당 경고선
VIB_WARN = 30.0           # VIBE m/s² — ArduPilot 권장 상한
VIB_BAD = 60.0            # 동 위험
INNOV_WARN = 1.0          # EKF test ratio 정상 상한
TILT_WARN = 45.0          # 자세 경고 (deg)

GROUND_WINDOW_S = 1.0     # arm 직후 이만큼은 지상 정지로 보고 지면 높이를 잡는다
SANE_ALT_M = 10000.0      # 물리적으로 불가능한 크기는 깨진 샘플이다
SANE_SPEED_MS = 200.0
LEAP_S = 18               # GPS→UTC 윤초 (2017 이후)

# 🔴 아래 셋은 tools/live/bin_playback.py 와 **반드시 같은 값**을 유지한다.
#    캐시 지문이 이 파일만 보므로 import 하지 않고 옮겨 적었다.
COPTER_MODE = {
    0: 'STABILIZE', 1: 'ACRO', 2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED',
    5: 'LOITER', 6: 'RTL', 7: 'CIRCLE', 9: 'LAND', 11: 'DRIFT',
    13: 'SPORT', 14: 'FLIP', 15: 'AUTOTUNE', 16: 'POSHOLD', 17: 'BRAKE',
    18: 'THROW', 19: 'AVOID_ADSB', 20: 'GUIDED_NOGPS', 21: 'SMART_RTL',
    22: 'FLOWHOLD', 23: 'FOLLOW', 24: 'ZIGZAG', 25: 'SYSTEMID',
    26: 'AUTOROTATE',
}
# 2026-09-16 실측 배선: MAIN1=우전 MAIN2=우후 MAIN3=좌후 MAIN4=좌전.
# 교과서 Quad-X 순서(1=우전 2=좌후 3=좌전 4=우후)가 아니다 — 실측이 정본.
MOTOR_PINS = (('RF', 1), ('RB', 2), ('LB', 3), ('LF', 4))

# EV.Id (ArduCopter 3.6 defines.h)
EV_ARMED, EV_DISARMED = 10, 11
EV_LAND_MAYBE, EV_LAND_COMPLETE, EV_NOT_LANDED = 17, 18, 28

# ERR.Subsys. ECode 0 = 해소.
ERR_SUBSYS = {
    1: 'MAIN', 2: 'RADIO', 3: 'COMPASS', 4: 'OPTFLOW', 5: 'FAILSAFE_RADIO',
    6: 'FAILSAFE_BATT', 7: 'FAILSAFE_GPS', 8: 'FAILSAFE_GCS', 9: 'FAILSAFE_FENCE',
    10: 'FLIGHT_MODE', 11: 'GPS', 12: 'CRASH_CHECK', 13: 'FLIP', 14: 'AUTOTUNE',
    15: 'PARACHUTES', 16: 'EKFCHECK', 17: 'FAILSAFE_EKFINAV', 18: 'BARO', 19: 'CPU',
    20: 'FAILSAFE_ADSB', 21: 'TERRAIN', 22: 'NAVIGATION', 23: 'FAILSAFE_TERRAIN',
    24: 'EKF_PRIMARY', 25: 'THRUST_LOSS_CHECK', 26: 'FAILSAFE_SENSORS',
    27: 'FAILSAFE_LEAK', 28: 'PILOT_INPUT', 29: 'FAILSAFE_VIBE',
}
ERR_FLIGHT_MODE = 10      # ECode = 진입을 거부당한 모드 번호

# EKF test ratio → 화면의 센서 이름표 (log.html INNOV_KO 키)
INNOV_MAP = (("SV", "gps_hvel"), ("SP", "gps_hpos"), ("SH", "baro_vpos"), ("SM", "mag_field"))

# 인스턴스 필드. 0 번(주 센서·주 코어)만 쓴다. 두 번째 센서가 섞이면 선이 톱니가 된다.
INST_FIELDS = ("I", "Instance", "Inst", "C", "Core", "IMU")

# 모을 메시지와 필드. 없는 필드는 NaN 으로 채운다.
WANT = {
    "ATT":  ("Roll", "Pitch", "Yaw", "DesRoll", "DesPitch"),
    "RATE": ("R", "P", "Y", "RDes", "PDes", "YDes"),
    "NKF1": ("PD", "VN", "VE", "VD"),
    "XKF1": ("PD", "VN", "VE", "VD"),
    "NKF4": ("SV", "SP", "SH", "SM"),
    "XKF4": ("SV", "SP", "SH", "SM"),
    "CTUN": ("Alt", "CRt"),
    "POS":  ("Lat", "Lng"),
    "GPS":  ("Status", "NSats", "Lat", "Lng", "Spd", "GWk", "GMS"),
    "GPA":  ("HAcc", "VAcc"),
    "BAT":  ("Volt", "Curr", "CurrTot"),
    "CURR": ("Volt", "Curr", "CurrTot"),
    "BARO": ("Alt",),
    "VIBE": ("VibeX", "VibeY", "VibeZ", "Clip0", "Clip1", "Clip2"),
    "MAG":  ("MagX", "MagY", "MagZ"),
    "PM":   ("Load",),
    "RAD":  ("RSSI", "RemRSSI", "TxBuf", "Noise"),
    "RCIN": tuple("C%d" % i for i in range(1, 9)),
    "RCOU": tuple("C%d" % i for i in range(1, 15)),
    "DSF":  ("Dp",),
    "ORGN": ("Type", "Lat", "Lng"),
}


class LogUnreadable(Exception):
    """로그를 읽을 수 없다. 호출자가 그 파일만 건너뛰게 하기 위한 신호."""


# ── 직렬화 ───────────────────────────────────────────────────────────

def coerce(o):
    """numpy·datetime 을 JSON 이 아는 타입으로. NaN/inf 는 null 로."""
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, (np.floating, float)):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return [coerce(x) for x in o.tolist()]
    if isinstance(o, (datetime.datetime, datetime.date)):
        return o.isoformat()
    raise TypeError("직렬화 못 하는 타입: %s" % type(o).__name__)


def jsonable(o):
    """NaN/inf 를 null 로 **미리** 바꾼다. 컨테이너는 재귀로 훑는다.

    🔴 `json.dumps(default=coerce)` 만으로는 못 막는다. `default=` 는 json 이
       **모르는 타입**에만 불린다. NaN 은 float 라 `NaN` 글자가 그대로 나가고,
       브라우저 `JSON.parse` 가 그것을 거부한다. 값 하나 때문에 리포트 전체를
       죽이지 않도록 그 필드만 null 로 떨어뜨린다.
    """
    if isinstance(o, float):
        return None if math.isnan(o) or math.isinf(o) else o
    if isinstance(o, np.floating):
        f = float(o)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(o, np.integer):
        return int(o)
    if isinstance(o, np.bool_):
        return bool(o)
    if isinstance(o, np.ndarray):
        return [jsonable(x) for x in o.tolist()]
    if isinstance(o, dict):
        return {k: jsonable(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [jsonable(x) for x in o]
    return o


# ── 배열 도구 ────────────────────────────────────────────────────────

def clean(arr, limit=None):
    """길이를 보존하며 이상치를 NaN 으로. 샘플을 버리면 시간축이 밀린다."""
    a = np.asarray(arr, dtype=np.float64).copy()
    a[~np.isfinite(a)] = np.nan
    if limit is not None:
        a[np.abs(a) > limit] = np.nan
    return a


def stat(arr, fn, default=None):
    """유한값에 fn. 없으면 default."""
    if arr is None:
        return default
    a = np.asarray(arr, dtype=np.float64)
    a = a[np.isfinite(a)]
    return float(fn(a)) if a.size else default


def to_grid(t_src, v_src, grid, nd=3):
    """원본 (시각, 값) 을 균일 격자에 올린다. 격자 밖은 None."""
    v = clean(v_src)
    ok = np.isfinite(v)
    if ok.sum() < 2:
        return [None] * len(grid)
    ts = np.asarray(t_src)[ok]
    # 가장자리 한 칸은 채운다 — 안 그러면 t=0 읽기 패널이 전부 '–' 다.
    # 진짜로 데이터가 없는 구간(한 격자 간격 이상)은 지운다.
    out = np.interp(grid, ts, v[ok])
    tol = 1.0 / GRID_HZ
    out[(grid < ts[0] - tol) | (grid > ts[-1] + tol)] = np.nan
    return [None if math.isnan(x) else round(float(x), nd) for x in out]


def transitions(t, values, mapping=None):
    """값이 바뀌는 지점만 (시각, 값) 으로."""
    if values is None or len(values) == 0:
        return []
    values = np.asarray(values)
    idx = np.where(np.diff(values.astype(float)) != 0)[0]
    out = [(t[0], values[0])]
    out += [(t[i + 1], values[i + 1]) for i in idx]
    if mapping:
        out = [(ts, mapping.get(int(v), str(v))) for ts, v in out]
    return out


def agl(z_up, t_rel):
    """arm 시점을 0 으로 잡은 상대고도. 첫 1초 중앙값이 지면이다 (한 샘플은 노이즈를 탄다)."""
    if z_up is None or len(z_up) == 0:
        return z_up
    fin = np.isfinite(z_up)
    ground = z_up[(t_rel <= GROUND_WINDOW_S) & fin]
    if not ground.size:
        ground = z_up[fin][:1]
    if not ground.size:
        return z_up
    return z_up - np.median(ground)


def kst(dt_utc):
    return dt_utc + datetime.timedelta(hours=9)


def time_from_name(path):
    """파일명의 **KST** 시각. 없으면 None.

      `log_<n>_YYYY-M-D-H-M-S.bin`   QGC 가 내려받으며 붙인 이름 — 로컬(KST)
      `YYYY-MM-DD HH-MM-SS.bin`      Mission Planner 이름 — 로컬(KST)

    SD 원본(`00000012.BIN`)에는 시각이 없다. 이 FC 는 RTC 도 없다.
    """
    base = os.path.basename(path)
    for pat in (r"(\d{4})-(\d{1,2})-(\d{1,2})-(\d{1,2})-(\d{2})-(\d{2})",
                r"(\d{4})-(\d{2})-(\d{2})[ _](\d{2})-(\d{2})-(\d{2})"):
        m = re.search(pat, base)
        if m:
            try:
                return datetime.datetime(*[int(x) for x in m.groups()])
            except ValueError:
                return None
    return None


# ── 읽기 ─────────────────────────────────────────────────────────────

class Log:
    """.BIN 한 개를 한 번 훑어 필요한 것만 배열로 모은다."""

    def __init__(self, path):
        self.path = path
        self.rows = {k: [] for k in WANT}
        self.params = {}
        self.ev = []          # (t, id)
        self.arm = []         # (t, armed) — ARM 메시지(신 펌웨어)
        self.mode = []        # (t, 번호)
        self.msgs = []        # (t, 본문)
        self.err = []         # (t, subsys, ecode)
        self.points = 0
        self.skipped = 0      # 중간에 건너뛴 바이트 (꼬리 제외)
        self.bad = 0          # 해석 실패 횟수
        self.tmin = self.tmax = None
        self.hw = self.sw = self.uuid = None
        self._read()
        self.arr = {k: self._to_arr(k, v) for k, v in self.rows.items() if v}

    def _read(self):
        # DFReader 는 경고를 stdout 에도 찍는다 — JSON 을 지키려고 통째로 돌린다.
        with contextlib.redirect_stdout(sys.stderr):
            try:
                m = mavutil.mavlink_connection(self.path)
            except Exception as exc:                          # noqa: BLE001
                raise LogUnreadable("열 수 없다: %s" % exc)
            if not hasattr(m, "data_len"):
                raise LogUnreadable("DataFlash .BIN 이 아니다")
            prev_end = 0
            gap = 0
            while True:
                try:
                    msg = m.recv_msg()
                except Exception:                             # noqa: BLE001
                    # 한 메시지가 깨져도 멈추지 않는다. 한 바이트 밀고 다시 찾는다.
                    self.bad += 1
                    m.offset = min(getattr(m, "offset", 0) + 1, m.data_len)
                    if m.offset >= m.data_len:
                        break
                    continue
                if msg is None:
                    break
                end = getattr(m, "offset", 0)
                start = end - msg.fmt.len
                if start > prev_end:
                    gap += start - prev_end
                prev_end = end
                self._take(msg)
        # 꼬리 잘림(전원 급단)은 손상으로 치지 않는다 — 앞 구간은 정상이다.
        self.skipped = gap
        if self.points == 0:
            raise LogUnreadable("디코딩된 메시지가 없다")

    def _take(self, msg):
        t = msg.get_type()
        if t in ("FMT", "FMTU", "UNIT", "MULT"):
            return
        self.points += 1
        us = getattr(msg, "TimeUS", None)
        if us is None:
            return
        ts = us / 1e6
        if t == "PARM":
            self.params[msg.Name] = msg.Value
            return
        self.tmin = ts if self.tmin is None else min(self.tmin, ts)
        self.tmax = ts if self.tmax is None else max(self.tmax, ts)
        if t == "EV":
            self.ev.append((ts, int(msg.Id)))
        elif t == "ARM":
            self.arm.append((ts, int(getattr(msg, "ArmState", 0))))
        elif t == "MODE":
            n = getattr(msg, "ModeNum", None)
            self.mode.append((ts, int(msg.Mode if n is None else n)))
        elif t == "MSG":
            txt = str(msg.Message).strip()
            self.msgs.append((ts, txt))
            # 보드 이름 + 고유번호 3워드. 기체를 가리는 열쇠다.
            b = re.match(r"^(\S+) ([0-9A-F]{8}) ([0-9A-F]{8}) ([0-9A-F]{8})$", txt)
            if b and self.uuid is None:
                self.hw, self.uuid = b.group(1), "".join(b.groups()[1:])
            if self.sw is None and re.match(r"^Ardu\w+ V\d", txt):
                self.sw = txt
        elif t == "ERR":
            self.err.append((ts, int(msg.Subsys), int(msg.ECode)))
        elif t in WANT:
            d = msg.to_dict()
            for f in INST_FIELDS:
                if f in d and not (t == "RCOU" or t == "RCIN") and d[f] not in (0, None):
                    return
            self.rows[t].append([ts] + [d.get(f, float("nan")) for f in WANT[t]])

    def _to_arr(self, name, rows):
        a = np.array(rows, dtype=np.float64)
        a = a[np.argsort(a[:, 0], kind="stable")]
        out = {"t": a[:, 0]}
        for i, f in enumerate(WANT[name]):
            out[f] = a[:, i + 1]
        return out

    def get(self, name):
        return self.arr.get(name)

    def param(self, name, default=None):
        v = self.params.get(name)
        return default if v is None else float(v)


def win(log, name, t0, t1):
    """메시지를 구간으로 자른 (필드사전, 상대시각). 없으면 (None, None)."""
    d = log.get(name)
    if d is None:
        return None, None
    m = (d["t"] >= t0) & (d["t"] <= t1)
    if not m.any():
        return None, None
    return {k: v[m] for k, v in d.items()}, d["t"][m] - t0


def first(log, t0, t1, *names):
    """먼저 있는 메시지를 쓴다. EKF2/EKF3 처럼 이름만 다른 경우."""
    for n in names:
        d, t = win(log, n, t0, t1)
        if d is not None:
            return d, t
    return None, None


def armed_window(log):
    """(t0, t1, armed) — 첫 arm 부터 마지막 disarm 까지. 없으면 로그 전체, armed=False."""
    ev = sorted([(t, True) for t, i in log.ev if i == EV_ARMED]
                + [(t, False) for t, i in log.ev if i == EV_DISARMED]
                + [(t, bool(s)) for t, s in log.arm])
    ons = [t for t, on in ev if on]
    if ons:
        t0 = ons[0]
        offs = [t for t, on in ev if not on and t > t0]
        # 마지막 이벤트가 arm 이면 arm 한 채로 로그가 끝났다 — 끝까지 쓴다.
        t1 = log.tmax if (not offs or ev[-1][1]) else offs[-1]
        return float(t0), float(t1), True
    if log.tmin is None:
        raise LogUnreadable("타임스탬프가 있는 메시지가 하나도 없다.")
    return float(log.tmin), float(log.tmax), False


def gps_utc(log, t_at):
    """GPS 주·ms 로 t_at(부팅초) 의 KST. GPS 시각이 없으면 None."""
    g = log.get("GPS")
    if g is None:
        return None
    ok = (g["GWk"] > 0) & (g["Status"] >= 3) & np.isfinite(g["GMS"])
    if not ok.any():
        return None
    i = np.where(ok)[0][0]
    base = (datetime.datetime(1980, 1, 6) + datetime.timedelta(
        weeks=int(g["GWk"][i]), milliseconds=float(g["GMS"][i]), seconds=-LEAP_S))
    return kst(base + datetime.timedelta(seconds=float(t_at - g["t"][i])))


def level(txt):
    """.BIN 의 MSG 에는 등급이 없다. 본문으로 syslog 등급(3=ERROR, 4=WARNING, 6=INFO)을 매긴다."""
    s = txt.lower()
    if any(k in s for k in ("crash", "critical", "emergency", "parachute", "thrust loss")):
        return 3, "ERROR"
    if any(k in s for k in ("prearm", "failsafe", "fail", "low", "error", "bad", "anomaly",
                            "lost", "fence", "not ", "unhealthy", "glitch", "vibration")):
        return 4, "WARNING"
    return 6, "INFO"


def err_text(sub, code):
    name = ERR_SUBSYS.get(sub, str(sub))
    if sub == ERR_FLIGHT_MODE:
        return "ERR %s: %s 진입 거부" % (name, COPTER_MODE.get(code, "MODE_%d" % code))
    return "ERR %s: %s" % (name, "해소" if code == 0 else "코드 %d" % code)


def messages(log):
    """(t, 등급, 등급이름, 본문) 을 시각순으로. MSG 와 ERR 을 합친다."""
    out = [(t,) + level(x) + (x,) for t, x in log.msgs]
    for t, sub, code in log.err:
        lv = (6, "INFO") if code == 0 else (3, "ERROR") if sub == 12 else (4, "WARNING")
        out.append((t,) + lv + (err_text(sub, code),))
    return sorted(out, key=lambda r: r[0])


def mode_track(log, t0, t1):
    """구간 안 모드 전이 [(절대시각, 이름)]. MODE 는 바뀔 때만 찍히므로 t0 직전 값을 시작에 둔다."""
    if not log.mode:
        return []
    ms = sorted(log.mode)
    before = [n for t, n in ms if t <= t0]
    seq = ([(t0, before[-1])] if before else []) + [(t, n) for t, n in ms if t0 < t <= t1]
    if not seq:
        return []
    tr = transitions(np.array([t for t, _ in seq]), np.array([n for _, n in seq]))
    return [(float(t), COPTER_MODE.get(int(n), "MODE_%d" % int(n))) for t, n in tr]


def land_state(log, t0, t1):
    """(상대시각 배열, landed 배열). EV 로 세운다 — arm 시점은 지상으로 본다."""
    ts, vs = [0.0], [True]
    for t, i in sorted(log.ev):
        if t < t0 or t > t1:
            continue
        if i == EV_LAND_COMPLETE:
            ts.append(t - t0); vs.append(True)
        elif i == EV_NOT_LANDED:
            ts.append(t - t0); vs.append(False)
    return np.array(ts), np.array(vs)


def failsafe_flags(log, t0, t1):
    """{이름: [(상대시각, on)]} — ERR 의 FAILSAFE_* 계열. 한 번도 안 켜진 것은 뺀다."""
    out = {}
    for t, sub, code in sorted(log.err):
        name = ERR_SUBSYS.get(sub, "")
        if not name.startswith("FAILSAFE_") or t > t1:
            continue
        out.setdefault(name.lower(), []).append((max(t - t0, 0.0), code != 0))
    return {k: v for k, v in out.items() if any(on for _, on in v)}


def motor_scale(log):
    """(최소, 최대) PWM. MOT_PWM_MIN/MAX 가 0 이면 FC 가 RC3 범위를 쓴다."""
    lo, hi = log.param("MOT_PWM_MIN", 0.0), log.param("MOT_PWM_MAX", 0.0)
    if not lo or not hi or hi <= lo:
        lo, hi = log.param("RC3_MIN", 0.0), log.param("RC3_MAX", 0.0)
    if not lo or not hi or hi <= lo:
        lo, hi = 1000.0, 2000.0
    return lo, hi


def motor_series(log, d):
    """{위치: 0~1 배열}. PWM 0(출력 없음)은 NaN."""
    if d is None:
        return {}
    lo, hi = motor_scale(log)
    out = {}
    for name, pin in MOTOR_PINS:
        v = clean(d["C%d" % pin])
        v[v < 900] = np.nan
        if np.isfinite(v).any():
            out[name] = np.clip((v - lo) / (hi - lo), 0.0, 1.0)
    return out


def sticks(log, d):
    """{roll,pitch,yaw,throttle: -1~1 배열}. RCMAP 과 RCn_MIN/TRIM/MAX/REVERSED 를 따른다."""
    if d is None:
        return {}
    out = {}
    for key, pmap, dflt in (("roll", "RCMAP_ROLL", 1), ("pitch", "RCMAP_PITCH", 2),
                            ("throttle", "RCMAP_THROTTLE", 3), ("yaw", "RCMAP_YAW", 4)):
        ch = int(log.param(pmap, dflt))
        if "C%d" % ch not in d:
            continue
        v = clean(d["C%d" % ch])
        v[v < 800] = np.nan
        lo = log.param("RC%d_MIN" % ch, 1000.0)
        hi = log.param("RC%d_MAX" % ch, 2000.0)
        mid = log.param("RC%d_TRIM" % ch, (lo + hi) / 2)
        if hi <= lo:
            continue
        if key == "throttle":
            n = 2.0 * (v - lo) / (hi - lo) - 1.0
        else:
            n = np.where(v >= mid, (v - mid) / max(hi - mid, 1.0), (v - mid) / max(mid - lo, 1.0))
        if log.param("RC%d_REVERSED" % ch, 0.0) == 1.0:
            n = -n
        out[key] = np.clip(n, -1.0, 1.0)
    return out


def ekf_pos(log, t0, t1):
    """(t, 고도(위+), vn, ve, vd). EKF2 → EKF3 → CTUN 순."""
    d, t = first(log, t0, t1, "NKF1", "XKF1")
    if d is not None:
        return t, -clean(d["PD"], SANE_ALT_M), d["VN"], d["VE"], d["VD"]
    c, tc = win(log, "CTUN", t0, t1)
    if c is not None:
        nan = np.full(len(tc), np.nan)
        return tc, clean(c["Alt"], SANE_ALT_M), nan, nan, -clean(c["CRt"]) / 100.0
    return None, None, None, None, None


def latlon(log, t0, t1):
    """(t, lat, lon). EKF 위치(POS) → GPS(3D fix) 순. (0,0) 은 버린다."""
    d, t = win(log, "POS", t0, t1)
    if d is not None:
        ok = (np.abs(d["Lat"]) > 1e-6) | (np.abs(d["Lng"]) > 1e-6)
        if ok.sum() >= 2:
            return t[ok], d["Lat"][ok], d["Lng"][ok]
    g, tg = win(log, "GPS", t0, t1)
    if g is not None:
        ok = (g["Status"] >= 3) & ((np.abs(g["Lat"]) > 1e-6) | (np.abs(g["Lng"]) > 1e-6))
        if ok.sum() >= 2:
            return tg[ok], g["Lat"][ok], g["Lng"][ok]
    return None, None, None


def vib_metric(d):
    """세 축 중 최대 (m/s²)."""
    return np.nanmax(np.vstack([clean(d["VibeX"], 1000.0), clean(d["VibeY"], 1000.0),
                                clean(d["VibeZ"], 1000.0)]), axis=0)


def mag_norm(d):
    """|B| (Gauss). MAG 는 mGauss 다."""
    return np.sqrt(sum(clean(d[k], 10000.0) ** 2 for k in ("MagX", "MagY", "MagZ"))) / 1000.0


def batt(log, t0, t1):
    return first(log, t0, t1, "BAT", "CURR")


# ── 요약 ─────────────────────────────────────────────────────────────

def analyse(log, t0, t1):
    """arm 구간 요약. 키는 화면(log.html·compare.html) 이 읽는 그대로."""
    rep = {"findings": [], "good": [], "todo": [], "repaired": False,
           "corrupt": bool(log.skipped or log.bad)}
    rep["t0"], rep["t1"] = t0, t1
    rep["duration"] = t1 - t0
    rep["utc"] = gps_utc(log, 0.0)        # 부팅 시각 (KST)
    rep["hw"] = log.hw or "?"
    rep["sw"] = log.sw or "?"
    rep["nav"] = mode_track(log, t0, t1)

    # ── 고도·속도 ────────────────────────────────────────────────
    tp, up, vn, ve, vd = ekf_pos(log, t0, t1)
    if tp is not None:
        alt = agl(up, tp)
        spd = clean(np.hypot(vn, ve), SANE_SPEED_MS)
        if not np.isfinite(spd).any():
            g, _ = win(log, "GPS", t0, t1)
            spd = clean(g["Spd"], SANE_SPEED_MS) if g is not None else spd
        vz = -clean(vd, SANE_SPEED_MS)
        alt_max, speed_max = stat(alt, np.max), stat(spd, np.max)
        # 둘은 같이 있거나 같이 없어야 한다 (classify 가 둘을 한 묶음으로 본다).
        if alt_max is not None and speed_max is not None:
            rep["alt_max"], rep["speed_max"] = alt_max, speed_max
        rep["climb_max"] = stat(vz, np.max, 0.0)
        rep["descent_max"] = stat(vz, np.min, 0.0)

    # ── 배터리 ───────────────────────────────────────────────────
    b, tb = batt(log, t0, t1)
    if b is not None:
        volt, cur = clean(b["Volt"], 200.0), clean(b["Curr"], 1000.0)
        v_min, v_max = stat(volt[volt > 1.0], np.min), stat(volt, np.max)
        if v_min is not None and v_max is not None:
            # 셀 수 파라미터가 없다. 만충 4.35V 로 나눠 올림한다 (4S 16.8V → 4).
            cells = max(1, int(math.ceil(v_max / 4.35)))
            rep["v_min"], rep["v_max"] = v_min, v_max
            rep["cell_min"] = v_min / cells
            rep["cur_max"] = stat(cur, np.max, 0.0)
            rep["cur_mean"] = stat(cur, np.mean, 0.0)
        # CurrTot 는 부팅 후 누적 mAh 다. 이 비행분은 증가분이다.
        tot = clean(b["CurrTot"])
        tot = tot[np.isfinite(tot)]
        rep["mah"] = float(tot[-1] - tot[0]) if tot.size else 0.0
        rep["mah_total"] = float(tot[-1]) if tot.size else 0.0
        rep["sag"] = stat(volt, np.max, 0.0) - stat(volt, np.min, 0.0)

        for thresh in (CUR_FULL_A, CUR_BATT_A):
            over = np.nan_to_num(cur) > thresh
            if not over.any():
                continue
            edge = np.diff(np.concatenate(([0], over.astype(int), [0])))
            starts, ends = np.where(edge == 1)[0], np.where(edge == -1)[0]
            durs = [tb[min(e, len(tb) - 1)] - tb[s] for s, e in zip(starts, ends)]
            rep.setdefault("over", []).append(
                (thresh, len(starts), float(sum(durs)), float(max(durs))))

        if rep.get("cur_max", 0.0) > CUR_FULL_A:
            rep["findings"].append(
                ("전류", "최대 %.1fA — 설계 풀스로틀 총전류 %.0fA 초과" % (rep["cur_max"], CUR_FULL_A),
                 "과중량·프롭 과대·모터 이상 의심. 전류 센서 보정(BATT_AMP_PERVLT)도 확인"))
        if rep.get("cell_min", 99.0) < CELL_LOW_V:
            rep["findings"].append(
                ("배터리", "셀당 최저 %.2fV (경고선 %.1fV)" % (rep["cell_min"], CELL_LOW_V),
                 "부하 시 전압 강하 %.2fV. 배터리 내부저항·용량 점검" % rep["sag"]))

    # ── GPS ──────────────────────────────────────────────────────
    g, _ = win(log, "GPS", t0, t1)
    if g is not None:
        a, _ = win(log, "GPA", t0, t1)
        sats = stat(g["NSats"], np.mean)
        eph = stat(a["HAcc"], np.mean) if a is not None else None
        epv = stat(a["VAcc"], np.mean) if a is not None else None
        fix = stat(g["Status"], np.max)
        # 넷은 한 묶음이다.
        if None not in (sats, eph, epv, fix):
            rep["sats"], rep["eph"], rep["epv"] = sats, eph, epv
            rep["fix"] = int(fix)
        if rep.get("sats", 0) >= 12 and rep.get("eph", 99) < 1.0:
            rep["good"].append("GPS 양호 — 위성 %.0f개, eph %.2fm" % (rep["sats"], rep["eph"]))

    # ── 진동 ─────────────────────────────────────────────────────
    v, _ = win(log, "VIBE", t0, t1)
    if v is not None:
        vib = vib_metric(v)
        vib_mean, vib_max = stat(vib, np.mean), stat(vib, np.max)
        if vib_mean is not None and vib_max is not None:
            rep["vib_mean"], rep["vib_max"] = vib_mean, vib_max
            if vib_max > VIB_BAD:
                rep["findings"].append(
                    ("진동", "VIBE 최대 %.1f m/s² (위험선 %.0f)" % (vib_max, VIB_BAD),
                     "프로펠러 밸런스·모터 마운트·FC 방진 점검"))
            elif vib_max > VIB_WARN:
                rep["findings"].append(
                    ("진동", "VIBE 최대 %.1f m/s² (경고선 %.0f)" % (vib_max, VIB_WARN),
                     "프로펠러 밸런싱 권장. 추세 관찰"))
            else:
                rep["good"].append("진동 양호 — 최대 %.1f" % vib_max)
        # Clip 은 부팅 후 누적 횟수다. 이 구간의 증가분만 센다.
        clip = 0
        for k in ("Clip0", "Clip1", "Clip2"):
            c = v[k][np.isfinite(v[k])]
            if c.size:
                clip += int(c[-1] - c[0])
        rep["clip"] = clip
        if clip > 0:
            rep["findings"].append(
                ("클리핑", "가속도계 클리핑 %d회" % clip, "IMU 포화. 방진 마운트 개선 필요"))

    # ── EKF 이상 ─────────────────────────────────────────────────
    k4, _ = first(log, t0, t1, "NKF4", "XKF4")
    if k4 is not None:
        bad = []
        for src, name in INNOV_MAP:
            peak = stat(np.abs(clean(k4[src], 100.0)), np.max, 0.0)
            if peak > INNOV_WARN:
                bad.append((name, peak))
        rep["innov"] = sorted(bad, key=lambda x: -x[1])

    # ── 자세 ─────────────────────────────────────────────────────
    at, ta = win(log, "ATT", t0, t1)
    if at is not None:
        tl, lv = land_state(log, t0, t1)
        idx = np.clip(np.searchsorted(tl, ta, side="right") - 1, 0, len(lv) - 1)
        flying = ~lv[idx]
        roll, pitch = clean(at["Roll"], 180.0), clean(at["Pitch"], 90.0)
        flying &= np.isfinite(roll) & np.isfinite(pitch)
        if flying.any():
            rep["roll_max"] = stat(np.abs(roll[flying]), np.max, 0.0)
            rep["pitch_max"] = stat(np.abs(pitch[flying]), np.max, 0.0)
            # 다른 시각 키(nav·msgs)와 같이 절대 로그초로 담는다.
            rep["tilt_t"] = float(ta[flying][np.argmax(np.abs(roll[flying]))] + t0)
            if max(rep["roll_max"], rep["pitch_max"]) > TILT_WARN:
                rep["findings"].append(
                    ("자세", "최대 경사 roll %.0f° / pitch %.0f° @ %.1fs"
                     % (rep["roll_max"], rep["pitch_max"], rep["tilt_t"] - t0),
                     "제어 상실 의심 구간. 해당 시점 모터 출력·조종 입력 확인"))

    # ── 자기계 간섭 ──────────────────────────────────────────────
    mg, tm = win(log, "MAG", t0, t1)
    if mg is not None and b is not None:
        norm = mag_norm(mg)
        cur = clean(b["Curr"], 1000.0)
        ok = np.isfinite(cur)
        if norm.size > 10 and ok.sum() >= 2:
            cur_i = np.interp(tm, tb[ok], cur[ok])
            f = np.isfinite(norm)
            # 표준편차 0 이면 NaN — jsonable 이 null 로 떨어뜨린다.
            with np.errstate(invalid="ignore", divide="ignore"):
                corr = float(np.corrcoef(cur_i[f], norm[f])[0, 1]) if f.sum() > 2 else float("nan")
            rep["mag_corr"] = corr
            rep["mag_mean"] = stat(norm, np.mean, 0.0)
            if abs(corr) > 0.5:
                rep["findings"].append(
                    ("자기 간섭", "전류-자기장 상관 %.2f" % corr,
                     "전력선이 나침반에 간섭. GPS 마스트를 높이거나 전력선 이격"))

    # ── failsafe (구간 중 켜져 있던 비율 %) ─────────────────────
    fl = failsafe_flags(log, t0, t1)
    dur = max(t1 - t0, 1e-6)
    act = []
    for k, tr in fl.items():
        on_t, st = 0.0, None
        for t, on in tr:
            if on and st is None:
                st = t
            elif not on and st is not None:
                on_t += t - st; st = None
        if st is not None:
            on_t += dur - st
        act.append((k, min(100.0, on_t / dur * 100)))
    rep["failsafe"] = sorted(act, key=lambda x: -x[1])

    # ── CPU ─────────────────────────────────────────────────────
    pm, _ = win(log, "PM", t0, t1)
    if pm is not None:
        cpu_max = stat(clean(pm["Load"]) / 10.0, np.max)      # Load 는 0.1% 단위
        if cpu_max is not None:
            rep["cpu_max"] = cpu_max
            if cpu_max < 70:
                rep["good"].append("CPU 여유 — 최대 %.0f%%" % cpu_max)

    # ── 로그 메시지 (경고 이상, 로그 전체) ──────────────────────
    rep["msgs"] = [(t, ls, x) for t, lv_, ls, x in messages(log) if lv_ <= 4]
    ds = log.get("DSF")
    dp = stat(ds["Dp"], np.max, 0.0) if ds is not None else 0.0
    rep["dropouts"] = (int(dp), 0.0)
    return rep


# ── 시계열 ───────────────────────────────────────────────────────────

def build_track(log, t0, t1):
    """지도 궤적 + 균일 격자 시계열."""
    dur = max(t1 - t0, 0.001)
    hz = GRID_HZ
    while dur * hz > GRID_MAX_PTS and hz > 1.0:
        hz /= 2.0
    n = int(dur * hz) + 1
    grid = np.arange(n) / hz
    trk = {"hz": hz, "n": n, "dur": round(dur, 2)}

    # ── 위치·고도·속도 ──────────────────────────────────────────
    tp, up, vn, ve, vd = ekf_pos(log, t0, t1)
    if tp is not None:
        trk["alt"] = to_grid(tp, clean(agl(up, tp), SANE_ALT_M), grid)
        spd = clean(np.hypot(vn, ve), SANE_SPEED_MS)
        if np.isfinite(spd).any():
            trk["spd"] = to_grid(tp, spd, grid)
        trk["climb"] = to_grid(tp, -clean(vd, SANE_SPEED_MS), grid)
    if "spd" not in trk:
        g, tg = win(log, "GPS", t0, t1)
        if g is not None:
            trk["spd"] = to_grid(tg, clean(g["Spd"], SANE_SPEED_MS), grid)

    tl_, la, lo = latlon(log, t0, t1)
    if tl_ is not None:
        # 위경도는 3자리 반올림으로는 못 쓴다 (1도 ≈ 111km). 7자리.
        trk["lat"] = to_grid(tl_, clean(la, 90.0), grid, nd=7)
        trk["lon"] = to_grid(tl_, clean(lo, 180.0), grid, nd=7)

    # ── 자세 (실측 + 목표) ──────────────────────────────────────
    at, ta = win(log, "ATT", t0, t1)
    if at is not None:
        yaw = clean(at["Yaw"], 720.0) % 360.0
        # 방위는 0/360 을 넘나들어 선형보간이 틀린다. 최근접 샘플을 쓴다.
        idx = np.clip(np.searchsorted(ta, grid), 0, len(ta) - 1)
        trk["hdg"] = [None if math.isnan(yaw[i]) else round(float(yaw[i]), 1) for i in idx]
        trk["roll"] = to_grid(ta, clean(at["Roll"], 180.0), grid)
        trk["pitch"] = to_grid(ta, clean(at["Pitch"], 90.0), grid)
        trk["roll_sp"] = to_grid(ta, clean(at["DesRoll"], 180.0), grid)
        trk["pitch_sp"] = to_grid(ta, clean(at["DesPitch"], 90.0), grid)

    # ── 각속도 (실측 + 목표, deg/s) ─────────────────────────────
    r, tr = win(log, "RATE", t0, t1)
    if r is not None:
        for ax, src in (("x", "R"), ("y", "P"), ("z", "Y")):
            trk["rate_" + ax] = to_grid(tr, clean(r[src], 5000.0), grid)
            trk["rate_%s_sp" % ax] = to_grid(tr, clean(r[src + "Des"], 5000.0), grid)

    # ── 기압 고도 (융합과 겹쳐 어느 센서가 튀는지 본다) ──────────
    ba, tba = win(log, "BARO", t0, t1)
    if ba is not None:
        bv = clean(ba["Alt"], SANE_ALT_M)
        fin = bv[np.isfinite(bv)]
        if fin.size:
            trk["alt_baro"] = to_grid(tba, bv - np.median(fin[:max(1, int(len(fin) * 0.02))]), grid)

    # ── 진동 ────────────────────────────────────────────────────
    v, tv = win(log, "VIBE", t0, t1)
    if v is not None:
        trk["vib"] = to_grid(tv, vib_metric(v), grid)

    # ── 나침반 간섭 — |B| 가 전류를 따라 출렁이면 전원선 간섭이다 ─
    mg, tm = win(log, "MAG", t0, t1)
    if mg is not None:
        trk["mag_norm"] = to_grid(tm, mag_norm(mg), grid)

    # ── GPS 품질 ────────────────────────────────────────────────
    g, tg = win(log, "GPS", t0, t1)
    if g is not None:
        trk["sats"] = to_grid(tg, clean(g["NSats"], 100.0), grid)
    a, tga = win(log, "GPA", t0, t1)
    if a is not None:
        trk["eph"] = to_grid(tga, clean(a["HAcc"], 1000.0), grid)

    # ── EKF test ratio — 1.0 을 넘은 것만 싣는다 ────────────────
    k4, tk = first(log, t0, t1, "NKF4", "XKF4")
    if k4 is not None:
        best = []
        for src, name in INNOV_MAP:
            vv = np.abs(clean(k4[src], 100.0))
            peak = stat(vv, np.max, 0.0)
            if peak > INNOV_WARN:
                best.append((peak, name, vv))
        for _, name, vv in sorted(best, key=lambda x: -x[0])[:4]:
            trk["innov_" + name] = to_grid(tk, vv, grid)

    # ── CPU ─────────────────────────────────────────────────────
    pm, tpm = win(log, "PM", t0, t1)
    if pm is not None:
        trk["cpu"] = to_grid(tpm, clean(pm["Load"], 10000.0) / 10.0, grid)

    # ── 통신 (텔레메트리 무선 RADIO_STATUS 가 기록됐을 때만) ─────
    rd, trd = win(log, "RAD", t0, t1)
    if rd is not None:
        def _rssi(key):
            x = clean(rd[key], 300.0)
            x[x <= 0] = np.nan            # 0 은 "값 없음"
            return x
        trk["rssi_air"] = to_grid(trd, _rssi("RemRSSI"), grid)
        trk["rssi_gnd"] = to_grid(trd, _rssi("RSSI"), grid)
        trk["rf_noise"] = to_grid(trd, clean(rd["Noise"], 300.0), grid)
        trk["tx_buf"] = to_grid(trd, clean(rd["TxBuf"], 200.0), grid)

    # 홈에서의 거리. 홈은 ORGN(Type 1) → 궤적 첫 점.
    if trk.get("lat") and trk.get("lon"):
        home = None
        og = log.get("ORGN")
        if og is not None:
            h = (og["Type"] == 1) & (np.abs(og["Lat"]) > 1e-6)
            if h.any():
                home = (float(og["Lat"][h][-1]), float(og["Lng"][h][-1]))
        if home is None:
            home = next(((la_, lo_) for la_, lo_ in zip(trk["lat"], trk["lon"])
                         if la_ is not None and lo_ is not None), None)
        if home is not None:
            hlat, hlon = home
            dd = []
            for la_, lo_ in zip(trk["lat"], trk["lon"]):
                if la_ is None or lo_ is None:
                    dd.append(None)
                    continue
                dx = (la_ - hlat) * 111320.0
                dy = (lo_ - hlon) * 111320.0 * math.cos(math.radians(hlat))
                dd.append(round(math.hypot(dx, dy), 1))
            trk["home_dist"] = dd

    # ── 배터리 ──────────────────────────────────────────────────
    b, tb = batt(log, t0, t1)
    if b is not None:
        trk["cur"] = to_grid(tb, clean(b["Curr"], 1000.0), grid)
        trk["volt"] = to_grid(tb, clean(b["Volt"], 200.0), grid)

    # ── 조종 입력 (-1~1) ────────────────────────────────────────
    rc, trc = win(log, "RCIN", t0, t1)
    for k, arr in sticks(log, rc).items():
        trk["stick_" + k] = to_grid(trc, arr, grid)

    # ── 모터 (0~1, 키는 기체 위치) ──────────────────────────────
    ro, tro = win(log, "RCOU", t0, t1)
    mot = motor_series(log, ro)
    if mot:
        trk["motors"] = {k: to_grid(tro, arr, grid) for k, arr in mot.items()}

    # ── 비행모드 밴드 (리샘플하지 않는다 — 전환 지점 그대로) ─────
    nav = mode_track(log, t0, t1)
    if nav:
        trk["modes"] = [{"t": round(t - t0, 2), "name": name} for t, name in nav]

    # ── 착륙(접지) 구간 ────────────────────────────────────────
    # 접지 뒤 지면효과로 고도가 조금 올라 "다시 떴다" 로 읽히는 것을 막는다.
    if any(i in (EV_LAND_COMPLETE, EV_NOT_LANDED) for _, i in log.ev):
        tl, lv = land_state(log, t0, t1)
        spans, st = [], None
        for tt, on in zip(tl, lv):
            if on and st is None:
                st = float(tt)
            elif not on and st is not None:
                spans.append([round(st, 2), round(float(tt), 2)]); st = None
        if st is not None:
            spans.append([round(st, 2), round(dur, 2)])
        # 이륙 전 '아직 땅' 구간과 스치듯 한 판정은 뺀다.
        trk["landed_spans"] = [s for s in spans if s[1] - s[0] >= 0.5 and s[1] > dur * 0.5]

    # ── failsafe ────────────────────────────────────────────────
    fl = failsafe_flags(log, t0, t1)
    if fl:
        trk["flags"] = {k: [{"t": round(t, 2), "on": on} for t, on in v] for k, v in fl.items()}
        ev_ = sorted((t, k, on) for k, v in fl.items() for t, on in v)
        state, prev, fs = {}, None, []
        for t, k, on in ev_:
            state[k] = on
            any_on = any(state.values())
            if any_on != prev:
                fs.append({"t": round(t, 2), "on": any_on}); prev = any_on
        if fs and fs[0]["t"] > 0:
            fs.insert(0, {"t": 0.0, "on": False})
        trk["failsafe"] = fs
    else:
        trk["failsafe"] = [{"t": 0.0, "on": False}]

    # ── FC 메시지 ───────────────────────────────────────────────
    ev = []
    for t, lv_, ls, x in messages(log):
        rt = t - t0
        if -1.0 <= rt <= (t1 - t0) + 1.0:
            ev.append({"t": round(rt, 2), "lvl": lv_, "lvl_str": ls, "msg": x})
    trk["events"] = ev[:MAX_EVENTS]
    return trk


# ── 목록 ─────────────────────────────────────────────────────────────

def flight_key(log, t0, t1):
    """같은 비행을 가리키는 열쇠. SD 원본과 내려받은 사본이 이름이 달라도 묶인다."""
    if log.uuid:
        return "boot:%s:%.0f:%.0f" % (log.uuid, t0, t1)
    return None


# 🔴 자동 모드를 **시도한** 로그는 크기·고도와 무관하게 남긴다. 성공했는지는
#    상관없다 — 시도가 곧 기록 가치다. 주 배지를 덮지 않고 나란히 붙는다.
_AUTO_TAGS = (("AUTO", "misn"), ("RTL", "rtl"), ("SMART_RTL", "rtl"))


def auto_tags(nav, refused=()):
    """시도한 자동 모드 태그 목록. `refused` 는 진입을 거부당한 모드 이름들.

    FC 가 진입을 거부하면 MODE 는 안 바뀌고 ERR(FLIGHT_MODE, 모드번호) 만
    남는다. 그것까지 잡아야 실패한 시도를 놓치지 않는다.
    순서는 `misn` → `rtl` 고정 — 미션 실패 후 RTL 이 사건 순서다.
    """
    names = {str(n) for _, n in (nav or [])} | set(refused)
    tags = []
    for want, tag in _AUTO_TAGS:
        if want in names and tag not in tags:
            tags.append(tag)
    return tags


def classify(row):
    """목록 배지. 단정적 문장은 만들지 않는다 — 로그는 '무엇' 만 알고 '왜' 는 모른다."""
    if not row.get("armed"):
        return "noarm"
    dur = row.get("duration") or 0
    alt = row.get("alt_max")
    spd = row.get("speed_max")
    if spd is not None and spd >= 3.0:
        return "flight"
    if alt is not None and alt >= 10.0:
        return "flight"          # 실비행
    # ⚠️ 고도·속도가 없어도 arm 하고 6초 만에 내린 것은 abort 다.
    if dur <= 6:
        return "abort"           # 즉시 disarm — 이륙 포기이거나 지상 점검
    if alt is None or spd is None:
        return "unknown"
    if alt < 0.5 and spd <= 0.5:
        return "ground"          # 지상
    return "hover"               # 저고도·저속 — 호버이거나 지상 확인


def summarize(log):
    """(rep, note, t0, t1). arm 이 없으면 최소 요약이라도 만든다 — 목록에서 사라지지 않게."""
    t0, t1, armed = armed_window(log)
    if armed:
        rep = analyse(log, t0, t1)
        rep["armed"] = True
        return rep, None, t0, t1
    reason = "arm 된 구간이 없다 (지상 로그)."
    return {"armed": False, "duration": t1 - t0, "t0": t0, "t1": t1,
            "hw": log.hw or "?", "sw": log.sw or "?", "utc": gps_utc(log, 0.0),
            "repaired": False, "corrupt": bool(log.skipped or log.bad),
            "findings": [], "good": [], "msgs": [], "note": reason}, reason, t0, t1


def main():
    if len(sys.argv) != 3 or sys.argv[1] not in ("row", "full"):
        sys.exit("사용법: extract.py row|full <path.BIN>")
    mode, path = sys.argv[1], sys.argv[2]

    try:
        log = Log(path)
        rep, note, t0, t1 = summarize(log)
    except LogUnreadable as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False))
        return
    except Exception as exc:                                  # noqa: BLE001
        print(json.dumps({"ok": False,
                          "error": "%s: %s" % (type(exc).__name__, exc)},
                         ensure_ascii=False))
        return

    st = os.stat(path)
    stamp = time_from_name(path)
    gps_t = gps_utc(log, t0)
    row = {
        "name": os.path.basename(path),
        "size": st.st_size,
        # 정렬·표시 시각: 파일명 → GPS 시각(arm 순간). 둘 다 없으면 null (RTC 없음).
        "utc": stamp if stamp is not None else gps_t,
        "time_source": "filename" if stamp is not None else ("gps" if gps_t else None),
        "boot_utc": rep.get("utc"),
        "duration": rep.get("duration"),
        "alt_max": rep.get("alt_max"),
        "speed_max": rep.get("speed_max"),
        "armed": rep.get("armed", True),
        "repaired": bool(rep.get("repaired")),
        "corrupt": bool(rep.get("corrupt")),
        "findings_n": len(rep.get("findings", [])),
        "cur_max": rep.get("cur_max"),
        "vib_max": rep.get("vib_max"),
        "hw": rep.get("hw"),
    }
    row["badge"] = classify(row)
    refused = [COPTER_MODE.get(c, "") for t, s, c in log.err
               if s == ERR_FLIGHT_MODE and t0 <= t <= t1]
    row["auto"] = auto_tags(rep.get("nav"), refused)
    row["flight"] = flight_key(log, t0, t1)
    row["points"] = log.points

    if mode == "row":
        print(json.dumps(jsonable({"ok": True, "row": row}),
                         default=coerce, allow_nan=False, ensure_ascii=False))
        return

    out = {"ok": True, "row": row, "sum": rep, "trk": build_track(log, t0, t1)}
    out["sum"]["uuid"] = log.uuid or "?"
    if note:
        out["sum"]["note"] = note
    # allow_nan=False 는 안전망 — jsonable 이 놓친 NaN 이 있으면 조용히 나가는 대신 죽는다.
    print(json.dumps(jsonable(out), default=coerce, allow_nan=False,
                     ensure_ascii=False))


if __name__ == "__main__":
    main()
