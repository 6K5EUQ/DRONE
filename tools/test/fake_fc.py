"""가짜 FC — UDP 로 ArduCopter 3.6 흉내를 낸다 (시험 전용, 실제 FC 에 안 붙는다).

    fc = FakeFc(('127.0.0.1', 14565))   # 보낼 곳 = cmd_agent 의 udpin (또는 drone_live 의 udpin)
    fc.start(); ...; fc.close()

하트비트·SYS_STATUS·GPS_RAW_INT·EXTENDED_SYS_STATE·RC_CHANNELS 를 5 Hz 로 보내고,
COMMAND_LONG(arm·rtl·land·mission_start)·SET_MODE·미션 프로토콜에 답한다.
받은 것은 전부 self.rx 에 (시각, 메시지) 로 남긴다 — 시험이 전송 프레임을 검사한다.
"""
import os
import socket
import threading
import time

os.environ['MAVLINK20'] = '1'       # 3.6.12 USB 와 같이 MAVLink2
from pymavlink import mavutil       # noqa: E402

MAV = mavutil.mavlink


class FakeFc:
    def __init__(self, peer, sysid=1):
        self.peer = peer
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(('127.0.0.1', 0))
        self.sock.settimeout(0.1)
        self.out = MAV.MAVLink(None, srcSystem=sysid, srcComponent=1)
        self.inp = MAV.MAVLink(None)
        self.inp.robust_parsing = True
        self.lock = threading.Lock()
        self.rx = []
        # 상태
        self.mode, self.armed, self.fix, self.volt, self.landed, self.ch5 = 5, False, 3, 15.2, 1, 1500
        self.mission = []           # 받은 MISSION_ITEM_INT
        self.up_n = None
        self.corrupt = False        # 되읽기 때 1번 항목 위도를 1e-7 틀리게
        self.reject = set()         # 거부할 COMMAND_LONG 번호
        self.ignore_rtl = 0         # RTL 명령을 이만큼은 받기만 하고 모드를 안 바꾼다
        self.stop = threading.Event()

    def start(self):
        threading.Thread(target=self._tx, daemon=True).start()
        threading.Thread(target=self._rx, daemon=True).start()
        return self

    def close(self):
        self.stop.set()
        self.sock.close()

    def send(self, m):
        try:
            self.sock.sendto(m.pack(self.out), self.peer)
        except OSError:
            pass

    def got(self, t=None, since=0.0):
        with self.lock:
            return [m for (at, m) in self.rx if at >= since and (t is None or m.get_type() == t)]

    def _tx(self):
        while not self.stop.is_set():
            base = MAV.MAV_MODE_FLAG_CUSTOM_MODE_ENABLED | (MAV.MAV_MODE_FLAG_SAFETY_ARMED if self.armed else 0)
            self.send(self.out.heartbeat_encode(MAV.MAV_TYPE_QUADROTOR, MAV.MAV_AUTOPILOT_ARDUPILOTMEGA, base, self.mode,
                                                MAV.MAV_STATE_ACTIVE if self.armed else MAV.MAV_STATE_STANDBY))
            self.send(self.out.sys_status_encode(0, 0, 0, 500, int(self.volt * 1000), 0, -1, 0, 0, 0, 0, 0, 0))
            self.send(self.out.gps_raw_int_encode(0, self.fix, 352000000, 1285000000, 0, 100, 100, 0, 0, 12))
            self.send(self.out.extended_sys_state_encode(0, self.landed))
            ch = [1500] * 18
            ch[4] = self.ch5
            self.send(self.out.rc_channels_encode(0, 8, *ch, 0))
            self.stop.wait(0.2)

    def _ack(self, cmd, result):
        self.send(self.out.command_ack_encode(cmd, result))

    def _rx(self):
        while not self.stop.is_set():
            try:
                data, _ = self.sock.recvfrom(65535)
            except (socket.timeout, OSError):
                continue
            for m in self.inp.parse_buffer(data) or []:
                if m.get_type() == 'BAD_DATA':
                    continue
                with self.lock:
                    self.rx.append((time.monotonic(), m))
                self._handle(m)

    def _handle(self, m):
        t = m.get_type()
        if t == 'COMMAND_LONG':
            c = m.command
            if c in self.reject:
                return self._ack(c, MAV.MAV_RESULT_FAILED)
            if c == MAV.MAV_CMD_COMPONENT_ARM_DISARM:
                self.armed = m.param1 == 1
            elif c == MAV.MAV_CMD_NAV_RETURN_TO_LAUNCH:
                if self.ignore_rtl > 0:
                    self.ignore_rtl -= 1
                else:
                    self.mode = 6
            elif c == MAV.MAV_CMD_NAV_LAND:
                self.mode = 9
            elif c == MAV.MAV_CMD_MISSION_START:
                if not self.armed:
                    return self._ack(c, MAV.MAV_RESULT_FAILED)
                self.mode = 3
            self._ack(c, MAV.MAV_RESULT_ACCEPTED)
        elif t == 'SET_MODE':
            self.mode = m.custom_mode
            self._ack(MAV.MAVLINK_MSG_ID_SET_MODE, MAV.MAV_RESULT_ACCEPTED)
        elif t == 'MISSION_COUNT':
            self.up_n, self.mission = m.count, []
            self.send(self.out.mission_request_int_encode(255, 190, 0, 0))
        elif t == 'MISSION_ITEM_INT' and self.up_n is not None:
            if m.seq == len(self.mission):
                self.mission.append(m)
            if len(self.mission) < self.up_n:
                self.send(self.out.mission_request_int_encode(255, 190, len(self.mission), 0))
            else:
                self.up_n = None
                self.send(self.out.mission_ack_encode(255, 190, MAV.MAV_MISSION_ACCEPTED, 0))
        elif t == 'MISSION_REQUEST_LIST':
            self.send(self.out.mission_count_encode(255, 190, len(self.mission), 0))
        elif t == 'MISSION_REQUEST_INT' and 0 <= m.seq < len(self.mission):
            g = self.mission[m.seq]
            x, z = g.x, g.z
            if m.seq == 0:                          # 홈으로 덮는다
                x, z = 352000000, 31.5
            if m.seq == 1 and self.corrupt:
                x += 1
            self.send(self.out.mission_item_int_encode(255, 190, g.seq, g.frame, g.command, 0, 1, g.param1, 0, 0, 0,
                                                       x, g.y, z, 0))
