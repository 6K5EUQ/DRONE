"""이 기체의 FC 만 연다 — USB id 로 고르고, 첫 하트비트로 한 번 더 확인한다.

    from fcport import open_fc
    m = open_fc()            # 못 찾거나 이 기체가 아니면 SystemExit

FC: Pixhawk 2.4.8 (USB id 3D_Robotics…v2), ArduCopter (autopilot 3), 쿼드 (type 2).
by-id 링크를 그대로 연다 — ttyACMn 으로 풀면 뽑고 다시 꽂을 때 다른 장치가 열릴 수 있다.
"""
import glob
import sys
import time

BY_ID = '/dev/serial/by-id/usb-3D_Robotics*v2*-if00'
AUTOPILOT, VEHICLE = 3, 2          # MAV_AUTOPILOT_ARDUPILOTMEGA, MAV_TYPE_QUADROTOR


def find_port():
    """이 FC 의 by-id 링크. 없거나 둘 이상이면 None."""
    hits = sorted(glob.glob(BY_ID))
    return hits[0] if len(hits) == 1 else None


def check_heartbeat(hb):
    """이 기체면 None, 아니면 사유 문자열."""
    if hb.autopilot == AUTOPILOT and hb.type == VEHICLE:
        return None
    return '이 기체 FC 가 아니다 (autopilot=%d type=%d)' % (hb.autopilot, hb.type)


def wait_fc_heartbeat(m, timeout=15.0):
    """GCS·주변기기 하트비트는 건너뛰고 FC 것을 기다린다. 이 기체가 아니면 SystemExit."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        hb = m.recv_match(type='HEARTBEAT', blocking=True, timeout=1)
        if hb is None or hb.autopilot == 8:      # MAV_AUTOPILOT_INVALID = GCS·주변기기
            continue
        why = check_heartbeat(hb)
        if why:
            sys.exit(why)
        m.target_system, m.target_component = hb.get_srcSystem(), hb.get_srcComponent()
        return hb
    sys.exit('하트비트 없음 (%.0f초)' % timeout)


def open_fc(port=None, **kw):
    """이 FC 에 붙어 하트비트까지 확인한 연결을 준다."""
    from pymavlink import mavutil
    port = port or find_port()
    if not port:
        sys.exit('이 기체 FC(Pixhawk 2.4.8) 가 없다 — ls /dev/serial/by-id/')
    m = mavutil.mavlink_connection(port, **kw)
    wait_fc_heartbeat(m)
    return m
