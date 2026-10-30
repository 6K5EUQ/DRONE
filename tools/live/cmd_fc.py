"""cmd_agent.py --live 의 FC 쪽 — drone_live 의 로컬 MAVLink 다리로 FC 와 말한다.

    [cmd_agent] ──udp 127.0.0.1:14560── [drone_live --bridge] ──USB── FC (ArduCopter 3.6.12)

drone_live 가 FC USB 를 쥐고 있다. 이 모듈은 그 다리(UDP)만 연다 — 시리얼은 안 연다.
cmd_agent 가 --live 와 DRONE_CMD_LIVE=1 이 **둘 다** 있을 때만 이 모듈을 불러온다.

🔴 RC_CHANNELS_OVERRIDE 는 보내지 않는다 (보내는 함수가 이 파일에 없다).
🔴 arm·disarm 은 param2=0 — 강제(arm 2989 · disarm 21196, 3.6 GCS_Mavlink.cpp magic_force_*)를 쓰지 않는다.

받는 스레드 하나가 FC 메시지를 읽어 상태(모드·시동·GPS·전압·착지·CH5)를 갱신하고,
0.2초마다 GCS 하트비트·LTE 워치독·조종사 개입을 본다. 명령 실행은 cmd_agent 의 일꾼 스레드가
하고, 응답은 구독 큐로 받는다. 비상(rtl·land)은 다른 명령이 도는 중에도 따로 들어와 그것을 멈춘다.

depart = 시동 + MISSION_START 를 한 번에. 마지막으로 **되읽기까지 맞은** 업로드(hash)가 FC 에
그대로 있을 때만 한다 — FC 재부팅·다른 업로드·개수 불일치면 그 기록을 지운다.

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
ARM_MODES = (GUIDED, LOITER)   # 둘 다 SITL 3.6.12 에서 GCS arm 됨 — 2026-10-30 실측 (RTL·LAND·AUTO 는 'Mode not armable')
CH5_DELTA = 100         # 🔶 CH5(FLTMODE_CH=5) 가 기준에서 이 µs 넘게 움직이면 조종사 — 스위치 칸 간격보다 작게, 잡음보다 크게. 실기 미확인
# 착지 판정 — 🔴 3.6.12 는 EXTENDED_SYS_STATE 를 안 보낸다 (3.6.12 소스에 송신 코드 없음, SITL 2026-10-30 실측 0건).
#    그래서 보내는 값으로 본다: 상대고도(GLOBAL_POSITION_INT) |alt| < 1.0 m · VFR_HUD |climb| < 0.3 m/s ·
#    throttle ≤ 10 % 가 2초 넘게 이어지면 지상. SITL 3.6.12 2026-10-30 실측: 지상 시동 thr 0 · climb 0.00 ·
#    호버 thr 34~37 · LAND 하강 thr 35 climb −0.49 · 접지 직후 thr 6→0. 🔶 숫자는 보수적으로 고른 것, 실기 미확인
GROUND_ALT_M = 1.0
GROUND_CLIMB = 0.3
GROUND_THR = 10
GROUND_HOLD_S = 2.0
REBOOT_GAP_S = 5.0      # 하트비트가 이만큼 끊겼다 오면 FC 가 다시 켜졌을 수 있다 — 검증 기록을 지운다
WD_FALLBACK_S = 2.5     # 🔶 워치독 RTL 이 거부(ACK 실패)되거나 이 안에 RTL 이 안 보이면 LAND — 하트비트 1 Hz 를 한 번 놓쳐도 되게
TAKEOFF_ALT_M = 1.0     # depart — AUTO 에서 상대고도가 이만큼 오르면 이륙 확인
TAKEOFF_S = 10.0        # 🔶 SITL 3.6.12: MISSION_START 뒤 10 m 까지 6.6 s (2026-10-30 실측) — 1 m 는 그 안쪽
ALT_TOL_M = 0.02        # 되읽기 고도 허용 — FC 는 int(z*100) cm 로 저장해 1 cm 까지 버린다 (AP_Mission.cpp:900) + float32 반올림
URGENT = ('rtl', 'land')
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
        self.mode = self.armed = self.fix = self.volt = None
        self.alt = self.climb = self.thr = None   # 상대고도 m · 상승 m/s · 스로틀 % — 착지 판정
        self.ground_at = None               # 착지 조건이 처음 맞은 시각 — 바뀌면 None
        self.boot_ms = None                 # 마지막 time_boot_ms — 줄면 FC 재부팅
        self.verified = None                # {'hash', 'count'} — 되읽기까지 맞은 마지막 업로드
        self.uploading = False
        self.ch5 = self.ch5_base = None
        self.pending = set()                # 에이전트가 지금 시킨 모드 — 이것으로 바뀌는 건 조종사가 아니다
        self.pilot = None                   # 조종사가 가져갔으면 그 사유 — 착지할 때까지
        self.server_at = time.monotonic()   # 마지막 서버 응답(롱폴 200·204)
        self.running = 0                    # 도는 명령 수 (비상이 겹치면 2)
        self.abort = threading.Event()      # 비상·워치독이 도는 명령을 멈춘다
        self.gate = threading.Lock()        # abort 확인 + 보내기 를 한 덩어리로 — 멈춘 뒤 한 번 더 나가지 않게
        self.tl = threading.local()         # 이 스레드가 비상 명령인가
        self.wd = None                      # 워치독이 보내는 중인 모드(RTL → 안 되면 LAND)
        self.wd_modes = set()               # 워치독이 시킨 모드 — 조종사로 안 센다
        self.wd_t0 = self.wd_sent = 0.0
        self.wd_nak = False                 # 워치독 RTL 에 FC 가 거부 ACK
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
            if t == 'HEARTBEAT':
                last = self.at.get('HEARTBEAT')
                if last is not None and now - last > REBOOT_GAP_S:
                    self._unverify('하트비트 %.0f초 끊김' % (now - last))
            self.at[t] = now
            if t == 'HEARTBEAT':
                self.armed = bool(msg.base_mode & MAV.MAV_MODE_FLAG_SAFETY_ARMED)
                m = msg.custom_mode
                if (self.mode is not None and m != self.mode and m not in self.pending
                        and m not in self.wd_modes):
                    self._take('mode %s→%s' % (NAMES.get(self.mode, self.mode), NAMES.get(m, m)))
                self.mode = m
            elif t == 'GPS_RAW_INT':
                self.fix = msg.fix_type
            elif t == 'SYS_STATUS':
                self.volt = None if msg.voltage_battery in (0, 65535) else msg.voltage_battery / 1000.0
            elif t == 'GLOBAL_POSITION_INT':
                if self.boot_ms is not None and msg.time_boot_ms < self.boot_ms:
                    self._unverify('FC 재부팅')
                self.boot_ms = msg.time_boot_ms
                self.alt = msg.relative_alt / 1000.0
                self._ground(now)
            elif t == 'VFR_HUD':
                self.climb, self.thr = msg.climb, msg.throttle
                self._ground(now)
            elif t in ('MISSION_REQUEST', 'MISSION_REQUEST_INT', 'MISSION_ACK') and not self.uploading:
                # 우리 업로드가 아닌데 FC 가 미션을 받고 있다 — 다른 GCS 가 올린다
                self._unverify('다른 업로드 (%s)' % t)
            elif t == 'COMMAND_ACK':
                if (self.wd == RTL and msg.command == MAV.MAV_CMD_NAV_RETURN_TO_LAUNCH
                        and msg.result != MAV.MAV_RESULT_ACCEPTED):
                    self.wd_nak = True
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
        self.wd = None
        self.wd_modes.clear()
        self.log('[fc] 🔴 조종사가 가져감 (%s) — 착지할 때까지 명령 안 받는다' % why, flush=True)

    def _unverify(self, why):
        if self.verified:
            self.log('[fc] 검증된 미션 기록 지움 (%s)' % why, flush=True)
        self.verified = None

    def _ground(self, now):
        """착지 조건(GROUND_*)을 본다 — 맞기 시작한 시각을 남긴다. self.lock 안에서 부른다."""
        ok = (self.alt is not None and self.climb is not None and self.thr is not None
              and abs(self.alt) < GROUND_ALT_M and abs(self.climb) < GROUND_CLIMB and self.thr <= GROUND_THR)
        if not ok:
            self.ground_at = None
        elif self.ground_at is None:
            self.ground_at = now

    def grounded(self):
        """착지 조건이 GROUND_HOLD_S 넘게 이어졌고 값이 새것이다. 모르면 False."""
        g = self.ground_at
        return (g is not None and time.monotonic() - g >= GROUND_HOLD_S
                and self.fresh('GLOBAL_POSITION_INT') and self.fresh('VFR_HUD'))

    @property
    def landed(self):
        """화면용 — 1 지상 · 2 공중 · None 모름 (MAV_LANDED_STATE 와 같은 번호)."""
        if self.grounded():
            return 1
        return 2 if self.fresh('GLOBAL_POSITION_INT') and self.fresh('VFR_HUD') else None

    def _on_ground(self):
        return self.armed is False or self.grounded()

    # ── 0.2초마다 — GCS 하트비트·워치독 ──────────────────────────
    def _tick(self):
        if self.sys is None:
            return
        now = time.monotonic()
        # 명령이 도는 중에도 롱폴은 따로 돈다(cmd_agent 일꾼 스레드) — 그래서 실행 중이라고 봐주지 않는다
        alive = now - self.server_at <= LINK_GAP_S
        # 🔶 GCS 하트비트는 서버가 살아 있을 때만 보낸다 — 끊기면 멈춰서, GUIDED 중이면 FC 의 5초 GCS
        #    failsafe(3.6 events.cpp: GUIDED·rc override 일 때만 본다, FS_GCS_ENABLE=1) 도 같이 잡도록.
        #    소스 읽기로 낸 추측이다. SITL·실기 미검증
        if alive and now - self.hb_sent >= 1.0:
            self.hb_sent = now
            self._send(lambda: self.m.mav.heartbeat_send(MAV.MAV_TYPE_GCS, MAV.MAV_AUTOPILOT_INVALID, 0, 0, 0))
        with self.lock:
            # ArduCopter 3.6.12 의 GCS failsafe 는 AUTO 에서 안 걸린다 — 그래서 여기서 본다.
            # 웹이 시킨 모드(AUTO·GUIDED)로 떠 있을 때만. 조종사가 가져간 뒤에는 손대지 않는다
            trig = (not alive and not self.wd and not self.pilot and self.armed
                    and self.mode in (AUTO, GUIDED) and self.fresh())
            if trig:
                self.wd, self.wd_t0, self.wd_nak = RTL, now, False
                self.wd_modes = {RTL}
                self.flush = True
                self.log('[wd] 🔴 서버 응답 %.1f초 없음 — RTL' % (now - self.server_at), flush=True)
            if self.wd and self.mode == self.wd:
                self.log('[wd] %s 확인 — 유지한다' % NAMES[self.wd], flush=True)
                self.wd = None
                self.wd_modes.clear()
            if not self.wd and self.wd_modes and now - self.wd_t0 > 10.0:
                self.wd_modes.clear()       # 복구로 멈춘 뒤 늦게 오는 RTL·LAND 하트비트까지만 봐준다
            if self.wd == RTL and (self.wd_nak or now - self.wd_t0 > WD_FALLBACK_S):
                # RTL 이 안 된다(홈·GPS 없음 등) — LAND 는 GPS 없이도 된다
                self.log('[wd] 🔴 RTL %s — LAND' % ('거부' if self.wd_nak else '%.1f초 안 보임' % (now - self.wd_t0)),
                         flush=True)
                self.wd, self.wd_t0, self.wd_sent = LAND, now, 0.0
                self.wd_modes.add(LAND)
            send = self.wd if self.wd and now - self.wd_sent >= 1.0 else None
            if send:
                self.wd_sent = now
        if trig:
            with self.gate:
                self.abort.set()            # 도는 명령(depart 기다림 등)은 멈춘다
        if send:
            self._command_send(MAV.MAV_CMD_NAV_RETURN_TO_LAUNCH if send == RTL else MAV.MAV_CMD_NAV_LAND)

    # ── 서버 쪽에서 부른다 ──────────────────────────────────────
    def server_ok(self):
        self.server_at = time.monotonic()
        if self.wd:
            with self.lock:
                if self.wd:
                    # 운용자가 돌아왔다 — 더 보내면 그 뒤 운용자의 LAND·모드를 덮는다
                    self.log('[wd] 서버 복구 — %s 재전송 멈춤' % NAMES[self.wd], flush=True)
                    self.wd = None

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

    def _halted(self):
        """조종사가 가져갔거나, (비상 아닌 명령이면) 비상·워치독이 멈추라고 했다."""
        return bool(self.pilot) or (self.abort.is_set() and not getattr(self.tl, 'urgent', False))

    def _gated_send(self, f):
        """멈추라는 말이 없을 때만 보낸다 — 확인과 보내기 사이에 비상이 끼지 못하게. 보냈으면 True."""
        with self.gate:
            if self._halted():
                return False
            self._send(f)
            return True

    def _wait(self, q, want, timeout):
        deadline = time.monotonic() + timeout
        while True:
            left = deadline - time.monotonic()
            if left <= 0 or self._halted():
                return None
            try:
                msg = q.get(timeout=min(left, 0.1))
            except queue.Empty:
                continue
            if want(msg):
                return msg

    def _until(self, f, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline and not self._halted():
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
        urgent = kind in URGENT
        with self.lock:
            if self.running and not urgent:
                return 'rejected', 'busy', None
            self.running += 1
        if urgent:
            with self.gate:
                if self.running > 1:
                    self.log('[fc] 비상 %s — 도는 명령을 멈춘다' % kind, flush=True)
                self.abort.set()
        else:
            self.abort.clear()
        self.tl.urgent = urgent
        try:
            return f(args, progress)
        finally:
            with self.lock:
                self.running -= 1
                if not self.running:
                    self.pending.clear()    # 겹친 명령이 다 끝났을 때만 — 비상이 시킨 모드를 먼저 지우지 않게

    def _command(self, cmd, effect, progress, p1=0, p2=0, mode=None):
        """COMMAND_LONG 하나 → COMMAND_ACK → 하트비트로 effect() 확인."""
        if mode is not None:
            with self.lock:
                self.pending.add(mode)
        q = self._watch()
        try:
            if not self._gated_send(lambda: self.m.mav.command_long_send(self.sys, self.comp, cmd, 0, p1, p2,
                                                                         0, 0, 0, 0, 0)):
                return self._stopped()
            ack = self._wait(q, lambda x: x.get_type() == 'COMMAND_ACK' and x.command == cmd, ACK_S)
        finally:
            self._unwatch(q)
        return self._result(ack, effect, progress)

    def _stopped(self):
        return 'failed', 'pilot' if self.pilot else 'interrupted', None

    def _result(self, ack, effect, progress):
        if self._halted():
            return self._stopped()
        if ack is None:
            # 🔶 ACK 를 잃었어도 효과가 보이면 된 것으로 본다
            return ('done', 'no-ack', None) if self._until(effect, EFFECT_S) else ('failed', 'no-ack', None)
        if ack.result != MAV.MAV_RESULT_ACCEPTED:
            return 'failed', 'fc', ack.result
        progress('fc_ack', ack.result)
        if self._until(effect, EFFECT_S):
            return 'done', None, ack.result
        if self._halted():
            return self._stopped()
        return 'failed', 'no-effect', ack.result

    def _arm_check(self):
        """시동 사전 확인 — 문제면 사유."""
        if self.armed:
            return 'armed'
        if self.mode not in ARM_MODES:
            return 'mode'
        if not (self.fresh('GPS_RAW_INT') and (self.fix or 0) >= 3):
            return 'gps'
        if not (self.fresh('SYS_STATUS') and self.volt is not None and self.volt >= ARM_VOLT):
            return 'volt'
        return None

    def _do_arm(self, args, progress):
        bad = self._arm_check()
        if bad:
            return 'rejected', bad, None
        # 🔴 param2=0 — 2989(강제 시동)은 쓰지 않는다. FC 의 사전점검을 그대로 받는다
        return self._command(MAV.MAV_CMD_COMPONENT_ARM_DISARM, lambda: self.armed is True, progress, p1=1, p2=0)

    def _do_disarm(self, args, progress):
        if not self.armed:
            return 'rejected', 'disarmed', None
        # 모르면(값이 안 오거나 오래됐으면) 거부. FC 도 param2=0 이면 ap.land_complete 일 때만 받는다
        # (3.6 GCS_Mavlink.cpp MAV_CMD_COMPONENT_ARM_DISARM) — 여기는 그 앞에서 한 번 더 막는 것
        if not self.grounded():
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
            if not self._gated_send(lambda: self.m.mav.set_mode_send(self.sys, MAV.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED, num)):
                return self._stopped()
            # 🔶 3.6 의 SET_MODE 응답은 COMMAND_ACK(command=11, SET_MODE 메시지 id) — 소스 읽기, 실기 미확인
            ack = self._wait(q, lambda x: x.get_type() == 'COMMAND_ACK' and x.command == MAV.MAVLINK_MSG_ID_SET_MODE, ACK_S)
        finally:
            self._unwatch(q)
        return self._result(ack, lambda: self.mode == num, progress)

    def _do_rtl(self, args, progress):
        return self._command(MAV.MAV_CMD_NAV_RETURN_TO_LAUNCH, lambda: self.mode == RTL, progress, mode=RTL)

    def _do_land(self, args, progress):
        return self._command(MAV.MAV_CMD_NAV_LAND, lambda: self.mode == LAND, progress, mode=LAND)

    def _check_verified(self, h):
        """FC 의 미션이 마지막으로 검증된 업로드인가 — hash(주면)와 FC 의 개수를 본다. 아니면 사유."""
        v = self.verified
        if not v or (h is not None and h != v['hash']):
            return 'not-verified'
        q = self._watch()
        try:
            cnt = self._count(q)
        finally:
            self._unwatch(q)
        if isinstance(cnt, str):
            return cnt if cnt in ('pilot', 'interrupted') else 'not-verified'
        if cnt != v['count']:
            with self.lock:
                self._unverify('FC 미션 개수 %d≠%d' % (cnt, v['count']))
            return 'not-verified'
        return None

    def _do_mission_start(self, args, progress):
        if not self.armed:                  # 3.6: 시동 상태에서만 AUTO 로 넘긴다
            return 'rejected', 'disarmed', None
        bad = self._check_verified(args.get('hash'))
        if bad:
            return 'rejected', bad, None
        return self._command(MAV.MAV_CMD_MISSION_START, lambda: self.mode == AUTO, progress, mode=AUTO)

    def _do_depart(self, args, progress):
        """시동 → 곧바로 MISSION_START → AUTO 에서 TAKEOFF_ALT_M 넘게 오르면 done('airborne').

        시동 뒤 지상 대기는 DISARM_DELAY(10 s) 안에 끝나야 한다 — 여기서는 시동 확인 즉시 보낸다.
        """
        h = args.get('hash')
        bad = self._arm_check()
        if bad:
            return 'rejected', bad, None
        if not isinstance(h, str) or not h:
            return 'rejected', 'not-verified', None
        bad = self._check_verified(h)
        if bad:
            return 'rejected', bad, None
        sent = []

        def once(st, mr):                   # 중간 결과는 시동 ACK 한 번만 올린다
            if not sent:
                sent.append(1)
                progress(st, mr)
        st, det, mr = self._command(MAV.MAV_CMD_COMPONENT_ARM_DISARM, lambda: self.armed is True, once, p1=1, p2=0)
        if st != 'done':
            return st, det if det in ('pilot', 'interrupted') else 'arm-%s' % det, mr
        st, det, mr = self._command(MAV.MAV_CMD_MISSION_START, lambda: self.mode == AUTO, once, mode=AUTO)
        if st != 'done':
            if det not in ('pilot', 'interrupted') and self.armed and self.grounded():
                # 땅에서 시동만 걸린 채 두지 않는다
                self._command(MAV.MAV_CMD_COMPONENT_ARM_DISARM, lambda: self.armed is False, lambda *_: None, p1=0, p2=0)
            return st, det if det in ('pilot', 'interrupted') else 'start-%s' % det, mr
        if self._until(lambda: self.mode == AUTO and self.armed and (self.alt or 0) >= TAKEOFF_ALT_M, TAKEOFF_S):
            return 'done', 'airborne', mr
        if self._halted():
            return self._stopped()
        return 'failed', 'disarmed' if self.armed is False else 'no-takeoff', mr

    # ── 미션 ────────────────────────────────────────────────────
    def _do_mission_upload(self, args, progress):
        if self.armed is not False:
            return 'rejected', 'armed', None
        items = args.get('items')
        bad = check_items(items)
        if bad:
            return 'rejected', 'items: ' + bad, None
        with self.lock:
            self._unverify('새 업로드')     # 🔴 시작하자마자 지운다 — 중간에 끊긴 업로드로 depart 하지 않게
            self.uploading = True
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
            h = args.get('hash')
            with self.lock:
                self.verified = {'hash': h, 'count': len(items)} if isinstance(h, str) and h else None
            return 'done', 'verified %d' % len(items), MAV.MAV_MISSION_ACCEPTED
        finally:
            self.uploading = False
            self._unwatch(q)

    def _upload(self, q, items):
        """MISSION_COUNT → (MISSION_REQUEST[_INT] → MISSION_ITEM_INT)* → MISSION_ACK. 실패면 (사유, 결과).

        재전송 때문에 FC 가 내는 거짓 실패 (3.6 GCS_Common.cpp handle_mission_item 708~724):
          · 같은 항목을 두 번 받으면 MISSION_ACK INVALID_SEQUENCE — 이미 받았다는 뜻이라 무시하고 다음 요청을 기다린다
          · 마지막 ACK 를 잃고 마지막 항목을 다시 보내면 MISSION_ACK ERROR(받는 중 아님) — 다 보낸 뒤의 실패·무응답은
            되읽기로 판정한다 (None 을 돌려준다 — 부르는 쪽이 되읽어 대조한다)
        """
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
            if self._halted():
                return ('pilot' if self.pilot else 'interrupted'), None
            if msg is None:
                misses += 1
                if misses > MIS_RETRIES:
                    return None if len(sent) >= n else ('no-mission-request', None)   # 다 보냈으면 되읽기로
                resend()
                continue
            misses = 0
            if msg.get_type() == 'MISSION_ACK':
                if msg.type == MAV.MAV_MISSION_INVALID_SEQUENCE:
                    continue                # 중복 항목 — FC 는 다음 것을 다시 요청한다(1초마다)
                if msg.type != MAV.MAV_MISSION_ACCEPTED:
                    if len(sent) >= n:
                        return None         # 마지막 ACK 를 잃었을 수 있다 — 되읽기로
                    return 'mission-rejected', msg.type
                if len(sent) < n:
                    return 'mission-ack-early', msg.type
                return None
            i = msg.seq
            if 0 <= i < n:
                send_item(i)
                sent.add(i)
                resend = (lambda i=i: send_item(i))

    def _count(self, q):
        """MISSION_REQUEST_LIST → MISSION_COUNT. 개수, 실패면 사유 문자열."""
        mis = lambda x: getattr(x, 'mission_type', 0) == MAV.MAV_MISSION_TYPE_MISSION
        cnt = None
        for _ in range(MIS_RETRIES + 1):
            self._send(lambda: self.m.mav.mission_request_list_send(self.sys, self.comp, MAV.MAV_MISSION_TYPE_MISSION))
            cnt = self._wait(q, lambda x: x.get_type() == 'MISSION_COUNT' and mis(x), MIS_STEP_S)
            if cnt is not None or self._halted():
                break
        if cnt is None:
            return 'pilot' if self.pilot else 'interrupted' if self._halted() else 'no-count'
        return cnt.count

    def _download(self, q):
        """되읽기 — MISSION_REQUEST_LIST → MISSION_COUNT → MISSION_REQUEST_INT 마다 MISSION_ITEM_INT. 실패면 사유 문자열."""
        n = self._count(q)
        if isinstance(n, str):
            return n
        out = []
        for i in range(n):
            it = None
            for _ in range(MIS_RETRIES + 1):
                self._send(lambda i=i: self.m.mav.mission_request_int_send(self.sys, self.comp, i, MAV.MAV_MISSION_TYPE_MISSION))
                it = self._wait(q, lambda x, i=i: x.get_type() == 'MISSION_ITEM_INT' and x.seq == i, MIS_STEP_S)
                if it is not None or self._halted():
                    break
            if it is None:
                return 'pilot' if self.pilot else 'interrupted' if self._halted() else 'no-item %d' % i
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
    """seq 1 이후 — 위경도 1e-7 정수 일치, 고도 ±ALT_TOL_M, 명령·프레임 같음. seq 0 은 FC 가 홈으로 덮는다."""
    if len(items) != len(got):
        return ['count %d≠%d' % (len(items), len(got))]
    diffs = []
    for i in range(1, len(items)):
        s, g = items[i], got[i]
        if int(s['cmd']) != g.command or int(s['frame']) != g.frame:
            diffs.append('%d cmd/frame' % i)
        if int(round(float(s['lat']) * SCALE)) != g.x or int(round(float(s['lon']) * SCALE)) != g.y:
            diffs.append('%d latlon' % i)
        if abs(float(s['alt']) - g.z) > ALT_TOL_M:
            diffs.append('%d alt %s≠%.2f' % (i, s['alt'], g.z))
    return diffs
