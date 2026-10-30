"""cmd_agent.py --live 의 FC 쪽 — drone_live 의 로컬 MAVLink 다리로 FC 와 말한다.

    [cmd_agent] ──udp 127.0.0.1:14560── [drone_live --bridge] ──USB── FC (ArduCopter 3.6.12)

drone_live 가 FC USB 를 쥐고 있다. 이 모듈은 그 다리(UDP)만 연다 — 시리얼은 안 연다.
cmd_agent 가 --live 와 DRONE_CMD_LIVE=1 이 **둘 다** 있을 때만 이 모듈을 불러온다.

🔴 RC_CHANNELS_OVERRIDE 는 보내지 않는다 (보내는 함수가 이 파일에 없다).
🔴 arm 은 param2=0 — 강제(21196)를 쓰지 않는다.

받는 스레드 하나가 FC 메시지를 읽어 상태(모드·시동·GPS·전압·착지·CH5)를 갱신하고,
0.2초마다 GCS 하트비트·LTE 워치독·조종사 개입을 본다. 명령 실행은 cmd_agent 의 주 스레드가
하고, 응답은 구독 큐로 받는다.

모드 번호: ArduCopter 3.6 control_mode_t (defines.h) — drone_live.COPTER_MODE 와 같다. 🔴 PX4 표와 다르다.
"""

import os
import queue
import sys
import threading
import time

# 3.6.12 는 USB 에서 MAVLink2 로 말한다 — 미션 메시지의 mission_type 이 v2 확장 필드다. pymavlink 를 부르기 전에 정한다
os.environ.setdefault('MAVLINK20', '1')
from pymavlink import mavutil   # noqa: E402

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))   # tools/
from fcport import check_heartbeat   # noqa: E402

MAV = mavutil.mavlink

MODE_NUM = {'alt_hold': 2, 'auto': 3, 'guided': 4, 'loiter': 5, 'rtl': 6, 'land': 9}
NAMES = {2: 'ALT_HOLD', 3: 'AUTO', 4: 'GUIDED', 5: 'LOITER', 6: 'RTL', 9: 'LAND'}
AUTO, GUIDED, LOITER, RTL, LAND = 3, 4, 5, 6, 9

# GCS 하트비트 출처 — SYSID_MYGCS=255 (params_20261012-1258_live-usb.param). 190 = MAV_COMP_ID_MISSIONPLANNER
GCS_SYSID, GCS_COMPID = 255, 190

LINK_GAP_S = 5.0        # 서버 응답이 이만큼 없으면 LTE 끊김으로 본다 (운영값)
FC_FRESH_S = 3.0        # 이보다 오래된 FC 상태로는 판정하지 않는다 (cmd.js LIVE_FRESH_MS 와 같다)
ACK_S = 3.0             # COMMAND_ACK 기다림
EFFECT_S = 3.0          # ACK 뒤 하트비트로 효과를 기다림 (FC 하트비트 1 Hz)
MIS_STEP_S = 2.0        # 미션 프로토콜 한 단계 기다림
MIS_RETRIES = 3         # 한 단계 재전송 횟수
ARM_VOLT = 14.0         # 4S 3.5 V/셀 — cmd.js READY_VOLT 와 같다
ARM_MODES = (GUIDED, LOITER)
CH5_DELTA = 100         # 🔶 CH5(FLTMODE_CH=5) 가 기준에서 이 µs 넘게 움직이면 조종사 — 스위치 칸 간격보다 작게, 잡음보다 크게. 실기 미확인
ON_GROUND = 1           # MAV_LANDED_STATE_ON_GROUND — 3.6 은 ap.land_complete 를 이것으로 낸다
SCALE = 1e7
ALLOWED_CMDS = (16, 19, 21, 22)   # web/mission.js ALLOWED 와 같다


class Fc:
    def __init__(self, spec, log=print):
        self.log = log
        self.m = mavutil.mavlink_connection(spec, source_system=GCS_SYSID, source_component=GCS_COMPID)
        self.tx = threading.Lock()          # 보내기 — 주 스레드와 받는 스레드가 같이 쓴다
        self.lock = threading.Lock()        # 아래 상태
        self.subs = []
        self.sys = self.comp = None
        self.at = {}                        # 메시지 종류 → 마지막 받은 시각(monotonic)
        self.mode = self.armed = self.fix = self.volt = self.landed = None
        self.ch5 = self.ch5_base = None
        self.pending = set()                # 에이전트가 지금 시킨 모드 — 이것으로 바뀌는 건 조종사가 아니다
        self.pilot = None                   # 조종사가 가져갔으면 그 사유 — 착지할 때까지
        self.server_at = time.monotonic()   # 마지막 서버 응답(롱폴 200·204)
        self.busy = False                   # 명령 실행 중 — 그동안은 폴을 못 하니 끊김으로 안 센다
        self.wd = False                     # 워치독이 RTL 을 보내는 중
        self.wd_sent = 0.0
        self.flush = False                  # 워치독 뒤 — 서버에 쌓인 명령은 실행하지 않고 비운다
        self.hb_sent = 0.0
        self.stop = threading.Event()

    def start(self):
        threading.Thread(target=self._loop, daemon=True).start()

    # ── 받기 ────────────────────────────────────────────────────
    def _loop(self):
        while not self.stop.is_set():
            try:
                msg = self.m.recv_match(blocking=True, timeout=0.2)
                if msg is not None:
                    self._feed(msg)
                self._tick()
            except Exception as e:          # noqa: BLE001 — 받는 스레드는 죽지 않는다
                self.log('[fc] 받기 오류: %s' % e, flush=True)
                time.sleep(0.2)

    def _feed(self, msg):
        t = msg.get_type()
        if t == 'BAD_DATA':
            return
        if t == 'HEARTBEAT':
            if msg.autopilot == MAV.MAV_AUTOPILOT_INVALID:     # GCS·주변기기
                return
            if self.sys is None:
                why = check_heartbeat(msg)
                if why:
                    self.log('[fc] %s — 무시' % why, flush=True)
                    return
                self.sys, self.comp = msg.get_srcSystem(), msg.get_srcComponent()
                self.m.target_system, self.m.target_component = self.sys, self.comp
                self.log('[fc] 다리로 FC 확인: sysid %d' % self.sys, flush=True)
        if self.sys is None or msg.get_srcSystem() != self.sys:
            return
        now = time.monotonic()
        with self.lock:
            self.at[t] = now
            if t == 'HEARTBEAT':
                self.armed = bool(msg.base_mode & MAV.MAV_MODE_FLAG_SAFETY_ARMED)
                m = msg.custom_mode
                if self.mode is not None and m != self.mode and m not in self.pending:
                    self._take('mode %s→%s' % (NAMES.get(self.mode, self.mode), NAMES.get(m, m)))
                self.mode = m
            elif t == 'GPS_RAW_INT':
                self.fix = msg.fix_type
            elif t == 'SYS_STATUS':
                self.volt = None if msg.voltage_battery in (0, 65535) else msg.voltage_battery / 1000.0
            elif t == 'EXTENDED_SYS_STATE':
                self.landed = msg.landed_state
            elif t == 'RC_CHANNELS':
                v = msg.chan5_raw
                if v not in (0, 65535):     # 조종기 신호 없음
                    self.ch5 = v
                    if self.ch5_base is None:
                        self.ch5_base = v
                    elif abs(v - self.ch5_base) > CH5_DELTA:
                        self._take('ch5 %d→%d' % (self.ch5_base, v))
            if self.pilot and self._on_ground():
                self.log('[fc] 착지 — 조종사 잠금 풂 (%s)' % self.pilot, flush=True)
                self.pilot = None
                self.ch5_base = self.ch5
            subs = list(self.subs)
        for q in subs:
            q.put(msg)

    def _take(self, why):
        """조종사가 가져갔다 — 대기열을 잠그고 워치독도 멈춘다. self.lock 안에서 부른다."""
        if self.pilot:
            return
        self.pilot = why
        self.pending.clear()
        self.wd = False
        self.log('[fc] 🔴 조종사가 가져감 (%s) — 착지할 때까지 명령 안 받는다' % why, flush=True)

    def _on_ground(self):
        return self.armed is False or self.landed == ON_GROUND

    # ── 0.2초마다 — GCS 하트비트·워치독 ──────────────────────────
    def _tick(self):
        if self.sys is None:
            return
        now = time.monotonic()
        alive = self.busy or now - self.server_at <= LINK_GAP_S
        # 🔶 GCS 하트비트는 서버가 살아 있을 때만 보낸다 — 끊기면 멈춰서, GUIDED 중이면 FC 의 5초 GCS
        #    failsafe(3.6 events.cpp: GUIDED·rc override 일 때만 본다, FS_GCS_ENABLE=1) 도 같이 잡도록.
        #    소스 읽기로 낸 추측이다. SITL·실기 미검증
        if alive and now - self.hb_sent >= 1.0:
            self.hb_sent = now
            self._send(lambda: self.m.mav.heartbeat_send(MAV.MAV_TYPE_GCS, MAV.MAV_AUTOPILOT_INVALID, 0, 0, 0))
        with self.lock:
            # ArduCopter 3.6.12 의 GCS failsafe 는 AUTO 에서 안 걸린다 — 그래서 여기서 본다.
            # 웹이 시킨 모드(AUTO·GUIDED)로 떠 있을 때만. 조종사가 가져간 뒤에는 손대지 않는다
            if (not alive and not self.wd and not self.pilot and self.armed
                    and self.mode in (AUTO, GUIDED) and self.fresh()):
                self.wd = True
                self.flush = True
                self.log('[wd] 🔴 서버 응답 %.1f초 없음 — RTL' % (now - self.server_at), flush=True)
            if self.wd and self.mode == RTL:
                self.wd = False
                self.pending.discard(RTL)
                self.log('[wd] RTL 확인 — 유지한다', flush=True)
            send = self.wd and now - self.wd_sent >= 1.0
            if send:
                self.wd_sent = now
                self.pending.add(RTL)
        if send:
            self._command_send(MAV.MAV_CMD_NAV_RETURN_TO_LAUNCH)

    # ── 서버 쪽에서 부른다 ──────────────────────────────────────
    def server_ok(self):
        self.server_at = time.monotonic()

    def fresh(self, t='HEARTBEAT'):
        at = self.at.get(t)
        return at is not None and time.monotonic() - at <= FC_FRESH_S

    # ── 보내기 ──────────────────────────────────────────────────
    def _send(self, f):
        with self.tx:
            f()

    def _command_send(self, cmd, p1=0, p2=0):
        self._send(lambda: self.m.mav.command_long_send(self.sys, self.comp, cmd, 0, p1, p2, 0, 0, 0, 0, 0))

    def _watch(self):
        q = queue.Queue()
        with self.lock:
            self.subs.append(q)
        return q

    def _unwatch(self, q):
        with self.lock:
            self.subs.remove(q)

    def _wait(self, q, want, timeout):
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or self.pilot:
                return None
            try:
                msg = q.get(timeout=min(left, 0.1))
            except queue.Empty:
                continue
            if want(msg):
                return msg

    def _until(self, f, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self.pilot:
            if f():
                return True
            time.sleep(0.05)
        return False

    # ── 실행 ────────────────────────────────────────────────────
    def run(self, cmd, progress):
        """(state, detail, mav_result). progress(state, mav_result) 는 중간 결과(fc_ack)를 올린다."""
        kind, args = str(cmd.get('kind', '')), cmd.get('args') or {}
        if self.pilot:
            return 'rejected', 'pilot', None
        if self.flush:
            return 'rejected', 'watchdog', None
        if self.sys is None or not self.fresh():
            return 'rejected', 'fc-link', None
        f = getattr(self, '_do_' + kind, None)
        if f is None or not isinstance(args, dict):
            return 'rejected', 'kind', None
        self.busy = True
        try:
            return f(args, progress)
        finally:
            with self.lock:
                self.pending.clear()
            self.busy = False
            self.server_at = max(self.server_at, time.monotonic())

    def _command(self, cmd, effect, progress, p1=0, p2=0, mode=None):
        """COMMAND_LONG 하나 → COMMAND_ACK → 하트비트로 effect() 확인."""
        if mode is not None:
            with self.lock:
                self.pending.add(mode)
        q = self._watch()
        try:
            self._command_send(cmd, p1, p2)
            ack = self._wait(q, lambda x: x.get_type() == 'COMMAND_ACK' and x.command == cmd, ACK_S)
        finally:
            self._unwatch(q)
        return self._result(ack, effect, progress)

    def _result(self, ack, effect, progress):
        if self.pilot:
            return 'failed', 'pilot', None
        if ack is None:
            # 🔶 ACK 를 잃었어도 효과가 보이면 된 것으로 본다
            return ('done', 'no-ack', None) if self._until(effect, EFFECT_S) else ('failed', 'no-ack', None)
        if ack.result != MAV.MAV_RESULT_ACCEPTED:
            return 'failed', 'fc', ack.result
        progress('fc_ack', ack.result)
        if self._until(effect, EFFECT_S):
            return 'done', None, ack.result
        return 'failed', 'pilot' if self.pilot else 'no-effect', ack.result

    def _do_arm(self, args, progress):
        if self.armed:
            return 'rejected', 'armed', None
        if self.landed is not None and self.landed != ON_GROUND:
            return 'rejected', 'not-landed', None
        if self.mode not in ARM_MODES:
            return 'rejected', 'mode', None
        if not (self.fresh('GPS_RAW_INT') and (self.fix or 0) >= 3):
            return 'rejected', 'gps', None
        if not (self.fresh('SYS_STATUS') and self.volt is not None and self.volt >= ARM_VOLT):
            return 'rejected', 'volt', None
        # 🔴 param2=0 — 21196(강제 시동)은 쓰지 않는다. FC 의 사전점검을 그대로 받는다
        return self._command(MAV.MAV_CMD_COMPONENT_ARM_DISARM, lambda: self.armed is True, progress, p1=1, p2=0)

    def _do_disarm(self, args, progress):
        if not self.armed:
            return 'rejected', 'disarmed', None
        if self.landed != ON_GROUND:        # 모르면(EXTENDED_SYS_STATE 없음) 거부
            return 'rejected', 'not-landed', None
        return self._command(MAV.MAV_CMD_COMPONENT_ARM_DISARM, lambda: self.armed is False, progress, p1=0, p2=0)

    def _do_mode(self, args, progress):
        num = MODE_NUM.get(args.get('mode'))
        if num is None:
            return 'rejected', 'mode', None
        with self.lock:
            self.pending.add(num)
        q = self._watch()
        try:
            self._send(lambda: self.m.mav.set_mode_send(self.sys, MAV.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, num))
            # 🔶 3.6 의 SET_MODE 응답은 COMMAND_ACK(command=11, SET_MODE 메시지 id) — 소스 읽기, 실기 미확인
            ack = self._wait(q, lambda x: x.get_type() == 'COMMAND_ACK' and x.command == MAV.MAVLINK_MSG_ID_SET_MODE, ACK_S)
        finally:
            self._unwatch(q)
        return self._result(ack, lambda: self.mode == num, progress)

    def _do_rtl(self, args, progress):
        return self._command(MAV.MAV_CMD_NAV_RETURN_TO_LAUNCH, lambda: self.mode == RTL, progress, mode=RTL)

    def _do_land(self, args, progress):
        return self._command(MAV.MAV_CMD_NAV_LAND, lambda: self.mode == LAND, progress, mode=LAND)

    def _do_mission_start(self, args, progress):
        if not self.armed:                  # 3.6: 시동 상태에서만 AUTO 로 넘긴다
            return 'rejected', 'disarmed', None
        return self._command(MAV.MAV_CMD_MISSION_START, lambda: self.mode == AUTO, progress, mode=AUTO)

    # ── 미션 ────────────────────────────────────────────────────
    def _do_mission_upload(self, args, progress):
        if self.armed is not False:
            return 'rejected', 'armed', None
        items = args.get('items')
        bad = check_items(items)
        if bad:
            return 'rejected', 'items: ' + bad, None
        q = self._watch()
        try:
            err = self._upload(q, items)
            if err:
                return 'failed', err[0], err[1]
            progress('fc_ack', MAV.MAV_MISSION_ACCEPTED)
            got = self._download(q)
            if isinstance(got, str):
                return 'failed', 'readback: ' + got, None
            diffs = compare(items, got)
            if diffs:
                return 'failed', 'mismatch: ' + '; '.join(diffs[:3]), None
            return 'done', 'verified %d' % len(items), MAV.MAV_MISSION_ACCEPTED
        finally:
            self._unwatch(q)

    def _upload(self, q, items):
        """MISSION_COUNT → (MISSION_REQUEST[_INT] → MISSION_ITEM_INT)* → MISSION_ACK. 실패면 (사유, 결과)."""
        n = len(items)
        mis = lambda x: getattr(x, 'mission_type', 0) == MAV.MAV_MISSION_TYPE_MISSION

        def send_count():
            self._send(lambda: self.m.mav.mission_count_send(self.sys, self.comp, n, MAV.MAV_MISSION_TYPE_MISSION))

        def send_item(i):
            it = items[i]
            # seq 0 = 홈 자리 (FC 가 홈으로 덮는다). 프레임은 항목 것(3)
            self._send(lambda: self.m.mav.mission_item_int_send(
                self.sys, self.comp, i, int(it['frame']), int(it['cmd']), 0, 1,
                float(it.get('p1') or 0), 0, 0, 0,
                int(round(float(it['lat']) * SCALE)), int(round(float(it['lon']) * SCALE)), float(it['alt']),
                MAV.MAV_MISSION_TYPE_MISSION))

        send_count()
        resend, sent, misses = send_count, set(), 0
        while True:
            msg = self._wait(q, lambda x: x.get_type() in ('MISSION_REQUEST', 'MISSION_REQUEST_INT', 'MISSION_ACK') and mis(x),
                             MIS_STEP_S)
            if self.pilot:
                return 'pilot', None
            if msg is None:
                misses += 1
                if misses > MIS_RETRIES:
                    return ('no-mission-ack' if len(sent) >= n else 'no-mission-request'), None
                resend()
                continue
            misses = 0
            if msg.get_type() == 'MISSION_ACK':
                if msg.type != MAV.MAV_MISSION_ACCEPTED:
                    return 'mission-rejected', msg.type
                if len(sent) < n:
                    return 'mission-ack-early', msg.type
                return None
            i = msg.seq
            if 0 <= i < n:
                send_item(i)
                sent.add(i)
                resend = (lambda i=i: send_item(i))

    def _download(self, q):
        """되읽기 — MISSION_REQUEST_LIST → MISSION_COUNT → MISSION_REQUEST_INT 마다 MISSION_ITEM_INT. 실패면 사유 문자열."""
        mis = lambda x: getattr(x, 'mission_type', 0) == MAV.MAV_MISSION_TYPE_MISSION
        cnt = None
        for _ in range(MIS_RETRIES + 1):
            self._send(lambda: self.m.mav.mission_request_list_send(self.sys, self.comp, MAV.MAV_MISSION_TYPE_MISSION))
            cnt = self._wait(q, lambda x: x.get_type() == 'MISSION_COUNT' and mis(x), MIS_STEP_S)
            if cnt is not None or self.pilot:
                break
        if cnt is None:
            return 'pilot' if self.pilot else 'no-count'
        out = []
        for i in range(cnt.count):
            it = None
            for _ in range(MIS_RETRIES + 1):
                self._send(lambda i=i: self.m.mav.mission_request_int_send(self.sys, self.comp, i, MAV.MAV_MISSION_TYPE_MISSION))
                it = self._wait(q, lambda x, i=i: x.get_type() == 'MISSION_ITEM_INT' and x.seq == i, MIS_STEP_S)
                if it is not None or self.pilot:
                    break
            if it is None:
                return 'pilot' if self.pilot else 'no-item %d' % i
            out.append(it)
        self._send(lambda: self.m.mav.mission_ack_send(self.sys, self.comp, MAV.MAV_MISSION_ACCEPTED,
                                                       MAV.MAV_MISSION_TYPE_MISSION))
        return out


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and abs(v) != float('inf')


def check_items(items):
    """모양만 본다 — 펌웨어·운영 규칙은 서버(web/mission.js check)가 이미 봤다. 문제면 사유."""
    if not isinstance(items, list) or len(items) < 2:
        return 'count'
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            return '%d' % i
        if it.get('seq', i) != i or it.get('cmd') not in ALLOWED_CMDS or it.get('frame') != 3:
            return '%d cmd/frame/seq' % i
        if not all(_num(it.get(k)) for k in ('lat', 'lon', 'alt')) or not _num(it.get('p1', 0) or 0):
            return '%d num' % i
        if not (-90 <= it['lat'] <= 90 and -180 <= it['lon'] <= 180):
            return '%d latlon' % i
    return None


def compare(items, got):
    """seq 1 이후 — 위경도 1e-7 정수 일치, 고도 ±0.01 m, 명령·프레임 같음. seq 0 은 FC 가 홈으로 덮는다."""
    if len(items) != len(got):
        return ['count %d≠%d' % (len(items), len(got))]
    diffs = []
    for i in range(1, len(items)):
        s, g = items[i], got[i]
        if int(s['cmd']) != g.command or int(s['frame']) != g.frame:
            diffs.append('%d cmd/frame' % i)
        if int(round(float(s['lat']) * SCALE)) != g.x or int(round(float(s['lon']) * SCALE)) != g.y:
            diffs.append('%d latlon' % i)
        if abs(float(s['alt']) - g.z) > 0.01:
            diffs.append('%d alt %s≠%.2f' % (i, s['alt'], g.z))
    return diffs
