#!/usr/bin/env python3
"""DRONE01(2kg 쿼드, ArduCopter) 비행 전 점검 — GO/NOGO.

    .venv/bin/python tools/preflight/preflight.py
    .venv/bin/python tools/preflight/preflight.py --conn /dev/ttyACM0
    .venv/bin/python tools/preflight/preflight.py --json      판정 한 벌 (기계용)
    .venv/bin/python tools/preflight/preflight.py --stream    NDJSON — 묶음이 끝나는 대로 (웹 콕핏용)

`--json`·`--stream` 은 터미널과 같은 check_* 로 판정한다. 모양만 다르다.

🔴 FC USB 는 하나다. drone-live 가 켜져 있으면 먼저 끈다 (`tools/live/drone-live off`).

🔴 읽기 전용이다. PARAM_SET·COMMAND_LONG 을 보내지 않는다. 보내는 것은
   GCS 하트비트와 PARAM_REQUEST_READ 뿐이다.

🔴 이 파일의 임계값은 전부 2026-09-21 이 기체에서 직접 실측한 값이거나
   FC_CHANGELOG.md·docs/procedures/00-progress.md 에 이미 기록된 값이다.
   추측값은 없다.

🔴 이 기체는 실비행 이력이 0 회다(2026-09-21 기준). 임계값 다수가
   "정상 비행에서 이만큼 흔들린다"가 아니라 "설계상 이래야 한다"는
   근거뿐이다 — 실비행 후 재검증이 필요하다.
"""
import argparse
import json
import sys
import time

try:
    from pymavlink import mavutil
except ImportError:
    sys.exit("pymavlink 이 없다. .venv/bin/python 으로 돌려라 (web/README.md 「rim3」).")

LOCAL_TIMEOUT = 4.0


def near(a, b, tol):
    return a is not None and abs(a - b) <= tol


def fmtv(v):
    if isinstance(v, float):
        return ('%.3f' % v).rstrip('0').rstrip('.')
    return str(v)


class Result:
    def __init__(self):
        self.items = []   # (level, group, name, value, why)
        self.group = ''

    def add(self, level, name, value, why=''):
        self.items.append((level, self.group, name, value, why))


# ── 연결 ──────────────────────────────────────────────────────────
def connect(explicit):
    """FC USB 직결. 이 기체의 FC 만 USB id(3D_Robotics…v2)로 찾는다."""
    import glob
    import os
    tries = []
    if explicit:
        tries.append((explicit, '지정'))
    else:
        for p in sorted(glob.glob('/dev/serial/by-id/usb-3D_Robotics*v2*-if00')):
            tries.append((os.path.realpath(p), 'FC USB 직결'))

    notes = [] if tries else ['FC USB 없음 (ls /dev/serial/by-id/)']

    for conn, why in tries:
        try:
            baud = 921600 if conn.startswith('/dev/') else None
            m = (mavutil.mavlink_connection(conn, baud=baud, source_system=250, source_component=190)
                 if baud else
                 mavutil.mavlink_connection(conn, source_system=250, source_component=190))
        except Exception as e:
            notes.append('%s: %s' % (why, e))
            continue

        t0 = time.time()
        hb = None
        budget = 3.0 if conn.startswith('/dev/') else 1.8
        while time.time() - t0 < budget:
            try:
                m.mav.heartbeat_send(mavutil.mavlink.MAV_TYPE_GCS,
                                      mavutil.mavlink.MAV_AUTOPILOT_INVALID, 0, 0, 0)
            except Exception:
                pass
            hb = m.wait_heartbeat(timeout=0.45)
            if hb:
                break
        if hb:
            # 이 기체가 맞는지 확인 — ArduCopter(autopilot 3) 쿼드(type 2)
            if hb.autopilot != 3 or hb.type != 2:
                notes.append('%s: 이 기체 FC 가 아니다 (autopilot=%d type=%d)' % (why, hb.autopilot, hb.type))
                continue
            return m, why, time.time() - t0, notes
        notes.append('%s: 하트비트 없음' % why)
    return None, None, None, notes


def read_params(m, names, timeout=6.0, got=None, on_msg=None):
    got = {} if got is None else got
    for attempt in range(3):
        need = [n for n in names if n not in got]
        if not need:
            break
        for name in need:
            m.mav.param_request_read_send(m.target_system, m.target_component, name.encode(), -1)
            time.sleep(0.02)
        t0 = time.time()
        while time.time() - t0 < timeout and any(n not in got for n in need):
            msg = m.recv_match(type='PARAM_VALUE', blocking=True, timeout=1)
            if msg is None:
                continue
            pid = msg.param_id
            if isinstance(pid, bytes):
                pid = pid.decode()
            pid = pid.rstrip('\x00')
            got[pid] = msg.param_value
            if on_msg:
                on_msg()
    return got


def sample_telemetry(m, seconds=3.0, tel=None, on_msg=None):
    """DATA_STREAM 요청 후 들어오는 대로 최신값만 남긴다. TEL_KEYS 가 다 오면 일찍 끝낸다."""
    try:
        m.mav.request_data_stream_send(m.target_system, m.target_component,
                                        mavutil.mavlink.MAV_DATA_STREAM_ALL, 4, 1)
    except Exception:
        pass
    tel = {} if tel is None else tel
    t0 = time.time()
    while time.time() - t0 < seconds and any(k not in tel for k in TEL_KEYS):
        msg = m.recv_match(blocking=True, timeout=0.5)
        if msg is None:
            continue
        t = msg.get_type()
        if t == 'HEARTBEAT':
            tel['armed'] = bool(msg.base_mode & mavutil.mavlink.MAV_MODE_FLAG_SAFETY_ARMED)
            tel['mode'] = msg.custom_mode
        elif t in ('SYS_STATUS', 'GPS_RAW_INT', 'RC_CHANNELS', 'VIBRATION',
                   'BATTERY_STATUS', 'EKF_STATUS_REPORT', 'ATTITUDE'):
            tel[t] = msg
        else:
            continue
        if on_msg:
            on_msg()
    return tel


# ── 판정 ──────────────────────────────────────────────────────────
def check_params(r, p):
    r.group = '배터리 failsafe'
    # 🔴 DRONE/00-progress.md #4 — 4S 배터리에 맞지 않는 값이 실측·문서화돼
    #    있다. 아직 고치지 않았다고 문서가 명시한다. 그 사실을 그대로 낸다.
    low = p.get('BATT_LOW_VOLT')
    crt = p.get('BATT_CRT_VOLT')
    if low is None or crt is None:
        r.add('warn', 'BATT_LOW_VOLT/CRT_VOLT', '읽지 못했다', '값을 모르면 판정도 못 한다')
    else:
        if low > 14.5 or crt > 13.5:
            r.add('blk', 'BATT_LOW/CRT_VOLT', '%.1fV / %.1fV' % (low, crt),
                  '4S 배터리(3.5V/셀=14.0V, 3.3V/셀=13.2V) 기준보다 높게 잡혀 있다. '
                  '이 값으로는 배터리가 넉넉히 남았는데도 failsafe 가 조기에 걸리거나, '
                  'low/critical 간격이 좁아 사실상 동시에 터진다 '
                  '(DRONE/docs/procedures/00-progress.md #4, 2026-09-14 실측 후 미수정)')
        else:
            r.add('ok', 'BATT_LOW/CRT_VOLT', '%.1fV / %.1fV' % (low, crt))
    gap = None
    if low is not None and crt is not None:
        gap = low - crt
        if gap < 0.5:
            r.add('warn', 'low↔critical 간격', '%.1fV' % gap,
                  '간격이 좁아 low 를 알리기도 전에 critical 로 넘어갈 수 있다')

    for name, act_name in [('FS_THR_ENABLE', '조종 신호 failsafe'),
                            ('FS_GCS_ENABLE', 'GCS 통신 failsafe')]:
        v = p.get(name)
        if v is None:
            r.add('warn', name, '읽지 못했다', '값을 모르면 판정도 못 한다')
        elif v == 0:
            r.add('blk', name, '꺼짐 (0)', '%s 가 꺼져 있으면 신호가 끊겨도 아무 대응이 없다' % act_name)
        else:
            r.add('ok', name, fmtv(v))

    r.group = '출력 매핑'
    # 🔴 이 기체의 매핑. 2026-09-16 실측 정정값(DRONE/docs/procedures/00-progress.md).
    #    SERVOn_FUNCTION 은 MAIN 포트→Motor 번호만 확정한다. 물리적 코너는
    #    실측으로만 안다 — 다른 기체에 이 표를 그대로 쓰면 안 된다.
    EXPECT_SERVO = {'SERVO1_FUNCTION': 33.0, 'SERVO2_FUNCTION': 34.0,
                    'SERVO3_FUNCTION': 35.0, 'SERVO4_FUNCTION': 36.0}
    SERVO_POS = {1: '우전/CCW', 2: '우후/CW', 3: '좌후/CCW', 4: '좌전/CW'}
    for name, want in EXPECT_SERVO.items():
        v = p.get(name)
        n = int(name[5])
        if v is None:
            r.add('warn', name, '읽지 못했다', '값을 모르면 판정도 못 한다')
        elif v != want:
            r.add('blk', name, '%s (기대 Motor%d)' % (fmtv(v), n),
                  '출력 배치가 실측 기록과 다르다 — 모터가 엉뚱한 포트에서 도는 상태일 수 있다')
        else:
            r.add('ok', name, 'Motor%d → %s' % (n, SERVO_POS[n]))

    fc, ft = p.get('FRAME_CLASS'), p.get('FRAME_TYPE')
    if near(fc, 1.0, 0.01) and near(ft, 1.0, 0.01):
        r.add('ok', 'FRAME_CLASS/TYPE', '쿼드 X (1/1)')
    elif fc is None or ft is None:
        r.add('warn', 'FRAME_CLASS/TYPE', '읽지 못했다')
    else:
        r.add('blk', 'FRAME_CLASS/TYPE', '%s/%s (기대 1/1)' % (fmtv(fc), fmtv(ft)),
              '프레임 형식이 실측값과 다르다 — 다른 기체 설정이 남아 있을 수 있다')

    r.group = '나침반'
    use1, use2, use3 = p.get('COMPASS_USE'), p.get('COMPASS_USE2'), p.get('COMPASS_USE3')
    if near(use1, 1.0, 0.01) and near(use2, 0.0, 0.01) and near(use3, 0.0, 0.01):
        r.add('ok', 'COMPASS_USE 구성', 'GPS 외장 나침반만 사용')
    elif None in (use1, use2, use3):
        r.add('warn', 'COMPASS_USE 구성', '읽지 못했다')
    else:
        r.add('warn', 'COMPASS_USE 구성', '%s/%s/%s' % (fmtv(use1), fmtv(use2), fmtv(use3)),
              '2026-09-14 실측·정정 구성과 다르다')

    ox, oy, oz = p.get('COMPASS_OFS_X'), p.get('COMPASS_OFS_Y'), p.get('COMPASS_OFS_Z')
    if None not in (ox, oy, oz):
        mag = (ox**2 + oy**2 + oz**2) ** 0.5
        # 🟠 DRONE/00-progress.md #5 — 오프셋 101.9 는 "통상 100 미만이 바람직"이라
        #    기록돼 있고, 분해·재조립으로 배치가 달라져 재보정 대상이라고 명시돼 있다.
        if mag >= 100:
            r.add('warn', '나침반 오프셋 크기', '%.1f' % mag,
                  '통상 100 미만이 바람직하다. 분해·재조립 후 재보정 대상으로 '
                  '이미 기록돼 있다 — 반드시 야외에서 재보정하라 (실내는 철근·전자기기로 오염됨)')
        else:
            r.add('ok', '나침반 오프셋 크기', '%.1f' % mag)
    else:
        r.add('warn', '나침반 오프셋', '읽지 못했다')

    r.group = '모터·프레임'
    hover = p.get('MOT_THST_HOVER')
    learn = p.get('MOT_HOVER_LEARN')
    if hover is not None:
        # 🔴 DRONE/00-progress.md — 이 기체 실비행 이력이 없다. 이 값이 실제
        #    학습된 것인지, 이전 기체의 잔재인지 구분이 안 된다는 사실 자체가
        #    문서화돼 있다. 그래서 OK 로 못 내고 참고로만 보여준다.
        r.add('warn', 'MOT_THST_HOVER', '%s (학습모드 %s)' % (fmtv(hover), fmtv(learn)),
              '이전 기체에서 넘어온 잔재값일 수 있다 — 이 프레임·프롭에서 검증된 값이 아니다 '
              '(DRONE CLAUDE.md: "잔재값을 실측값처럼 쓰지 마라")')
    else:
        r.add('warn', 'MOT_THST_HOVER', '읽지 못했다')

    vmax, vmin = p.get('MOT_BAT_VOLT_MAX'), p.get('MOT_BAT_VOLT_MIN')
    if near(vmax, 16.8, 0.05) and near(vmin, 13.2, 0.05):
        r.add('ok', 'MOT_BAT_VOLT_MAX/MIN', '16.8V / 13.2V (4S)')
    elif vmax is None or vmin is None:
        r.add('warn', 'MOT_BAT_VOLT_MAX/MIN', '읽지 못했다')
    else:
        r.add('warn', 'MOT_BAT_VOLT_MAX/MIN', '%s / %s' % (fmtv(vmax), fmtv(vmin)),
              '4S 기대값(16.8/13.2)과 다르다')

    r.group = 'RC 수신'
    sb, pc = p.get('BRD_SBUS_OUT'), p.get('BRD_PWM_COUNT')
    if near(sb, 0.0, 0.01):
        r.add('ok', 'BRD_SBUS_OUT', '0 (수신 전용, 정상)')
    elif sb is not None:
        r.add('warn', 'BRD_SBUS_OUT', fmtv(sb), 'SBUS 출력이 켜져 있다 — 의도한 것인지 확인하라')
    if near(pc, 4.0, 0.01):
        r.add('warn', 'BRD_PWM_COUNT', '4', 'MAIN5~8 은 지금 PWM 이 아니라 GPIO 다. '
              '짐벌·LED 를 쓸 계획이면 이 값을 올려야 한다 (판정에는 영향 없음, 참고)')

    r.group = '자세제어'
    amax = p.get('ANGLE_MAX')
    if near(amax, 4500.0, 1.0):
        r.add('ok', 'ANGLE_MAX', '45°')
    elif amax is not None:
        r.add('warn', 'ANGLE_MAX', '%.0f°' % (amax / 100), '실측 기록(45°)과 다르다')

    r.group = '지오펜스'
    fen = p.get('FENCE_ENABLE')
    if near(fen, 0.0, 0.01):
        r.add('ok', '지오펜스', '꺼져 있음 (의도한 상태로 기록돼 있음)')
    elif fen is not None:
        r.add('warn', '지오펜스', '켜져 있음', '기록에 없는 변경이다 — 반경/고도 설정을 확인하라')
    else:
        r.add('warn', 'FENCE_ENABLE', '읽지 못했다')


def check_live(r, tel):
    r.group = 'ARM 상태'
    if 'armed' not in tel:
        r.add('blk', 'ARM 상태', '확인 불가',
              '기체가 응답하지 않아 시동 여부를 모른다. 모르는 채로 만지지 마라')
    elif tel['armed']:
        r.add('blk', 'ARM 상태', '🔴 시동 걸림', '점검은 DISARM 상태에서 해야 한다')
    else:
        r.add('ok', 'ARM 상태', 'DISARMED')

    r.group = '배터리'
    sysm = tel.get('SYS_STATUS')
    if sysm is None:
        r.add('warn', '전압·전류', '수신 안 됨')
    else:
        # SYS_STATUS.voltage_battery 단위는 mV. 여기서 17 처럼 비정상적으로
        # 작은 값이면 전압센서 미설정/배터리 미연결일 가능성이 높다 — 그대로 보여준다.
        v = sysm.voltage_battery / 1000.0
        c = sysm.current_battery / 100.0 if sysm.current_battery >= 0 else None
        if sysm.voltage_battery in (0, 65535) or v < 1.0:
            r.add('blk', '배터리 전압', '%s (원시값 %d)' % (fmtv(v), sysm.voltage_battery),
                  '전압이 비정상적으로 낮다 — 배터리 미연결이거나 전압센서(BATT_VOLT_MULT) 문제다')
        elif v < 13.2:
            r.add('blk', '배터리 전압', '%.2fV' % v, '4S 기준 최소전압(13.2V) 미만이다')
        else:
            r.add('ok', '배터리 전압', '%.2fV%s' % (v, ('  %.1fA' % c) if c else ''))

    r.group = 'GPS'
    gps = tel.get('GPS_RAW_INT')
    if gps is None:
        r.add('warn', 'GPS', '수신 안 됨')
    else:
        if gps.fix_type < 3 or gps.satellites_visible == 0:
            r.add('warn', 'GPS', 'fix %d · 위성 %d기' % (gps.fix_type, gps.satellites_visible),
                  '위치를 못 잡았다. 실내라면 정상이다 — 야외에서만 GPS 필요 기능이 된다')
        else:
            eph = gps.eph / 100.0
            r.add('ok', 'GPS', 'fix %d · 위성 %d기 · eph %.2fm' % (gps.fix_type, gps.satellites_visible, eph))

    r.group = 'RC 수신'
    rc = tel.get('RC_CHANNELS')
    # 🔴 DRONE/00-progress.md 는 "송신기 바인딩 안 됨, CH1~8=0"이라 기록했다
    #    (작성 시점). 여기서 실측이 그것과 다르면 반드시 그 사실을 말해야
    #    한다 — 낡은 기록을 근거로 최신 상태를 판단하면 안 된다.
    if rc is None:
        r.add('blk', 'RC 수신', '수신 안 됨', '조종기 신호가 FC 에 안 들어온다')
    else:
        chans = [rc.chan1_raw, rc.chan2_raw, rc.chan3_raw, rc.chan4_raw, rc.chan5_raw]
        live = [c for c in chans if 0 < c < 65535]
        if not live:
            r.add('blk', 'RC 채널', 'CH1~5 전부 0',
                  '송신기가 꺼져 있거나 바인딩이 안 됐다 (docs/procedures/00-progress.md #2 와 일치)')
        else:
            r.add('ok', 'RC 채널(1~5)', ' '.join(str(c) for c in chans),
                  '값이 들어온다 — 문서(00-progress.md #2)의 "바인딩 안 됨" 기록과 다르다. '
                  '바인딩이 된 것으로 보이니 문서를 갱신하라')
        if rc.rssi in (0, 255):
            r.add('warn', 'RSSI', str(rc.rssi), 'RSSI_TYPE 미설정 상태로 보인다 — 신호 세기를 모른다')

    r.group = '진동·센서'
    vib = tel.get('VIBRATION')
    if vib is not None:
        mx = max(vib.vibration_x, vib.vibration_y, vib.vibration_z)
        clip = vib.clipping_0 + vib.clipping_1 + vib.clipping_2
        if clip > 0:
            r.add('warn', '진동 클리핑', '%d회' % clip, '가속도계가 포화됐다 — 마운트를 점검하라')
        elif mx > 30:
            r.add('warn', '진동', '최대축 %.1f' % mx, '정지 상태치고 높다')
        else:
            r.add('ok', '진동(정지)', 'x%.2f y%.2f z%.2f' % (vib.vibration_x, vib.vibration_y, vib.vibration_z))

    ek = tel.get('EKF_STATUS_REPORT')
    if ek is not None:
        # EKF_STATUS_REPORT.flags 비트: attitude(1)+velocity_horiz(2)+velocity_vert(4)
        # +pos_horiz_rel(8)+pos_horiz_abs(16)+pos_vert_abs(32)+pos_vert_agl(64)+const_pos_mode(128)
        need = 1 | 2 | 4  # 자세·수평속도·수직속도 추정만 최소 요구 (실내라 위치추정은 별개)
        if ek.flags & need == need:
            r.add('ok', 'EKF', '자세/속도 추정 정상')
        else:
            r.add('warn', 'EKF', 'flags=%d' % ek.flags, '추정기 일부가 아직 안 섰다')


# ── 기계용 출력 (--json · --stream) ─────────────────────────────────
# 웹 콕핏 점검 탭이 읽는다. 모양은 SHADE01 tools/preflight 와 같다 —
# 웹서버(web/server.js)·에이전트(agent.py)는 줄을 해석하지 않고 그대로 넘긴다.
#
# 🔴 판정은 위의 check_* 뿐이다. 여기서는 묶어서 옮기기만 한다.

WANT_PARAMS = [
    'BATT_LOW_VOLT', 'BATT_CRT_VOLT', 'FS_THR_ENABLE', 'FS_GCS_ENABLE',
    'SERVO1_FUNCTION', 'SERVO2_FUNCTION', 'SERVO3_FUNCTION', 'SERVO4_FUNCTION',
    'FRAME_CLASS', 'FRAME_TYPE',
    'COMPASS_USE', 'COMPASS_USE2', 'COMPASS_USE3',
    'COMPASS_OFS_X', 'COMPASS_OFS_Y', 'COMPASS_OFS_Z',
    'MOT_THST_HOVER', 'MOT_HOVER_LEARN', 'MOT_BAT_VOLT_MAX', 'MOT_BAT_VOLT_MIN',
    'BRD_SBUS_OUT', 'BRD_PWM_COUNT', 'ANGLE_MAX', 'FENCE_ENABLE',
]
TEL_KEYS = ['armed', 'SYS_STATUS', 'GPS_RAW_INT', 'RC_CHANNELS', 'VIBRATION', 'EKF_STATUS_REPORT']

# 묶음마다 무엇이 와야 끝난 것인가. 진행률은 이 중 **실제로 도착한 개수**다.
# 🔴 이름은 check_* 의 r.group, 콕핏 PF_BAY(web/public/cockpit.js) 와 같아야 한다.
# 순서는 현장 점검 순서 — 시동·전원부터.
GROUP_NEEDS = {
    'ARM 상태':        {'tel': ['armed']},
    '배터리':          {'tel': ['SYS_STATUS']},
    '배터리 failsafe': {'params': ['BATT_LOW_VOLT', 'BATT_CRT_VOLT', 'FS_THR_ENABLE', 'FS_GCS_ENABLE']},
    'RC 수신':         {'params': ['BRD_SBUS_OUT', 'BRD_PWM_COUNT'], 'tel': ['RC_CHANNELS']},
    'GPS':             {'tel': ['GPS_RAW_INT']},
    '나침반':          {'params': ['COMPASS_USE', 'COMPASS_USE2', 'COMPASS_USE3',
                                   'COMPASS_OFS_X', 'COMPASS_OFS_Y', 'COMPASS_OFS_Z']},
    '출력 매핑':       {'params': ['SERVO1_FUNCTION', 'SERVO2_FUNCTION', 'SERVO3_FUNCTION',
                                   'SERVO4_FUNCTION', 'FRAME_CLASS', 'FRAME_TYPE']},
    '모터·프레임':     {'params': ['MOT_THST_HOVER', 'MOT_HOVER_LEARN', 'MOT_BAT_VOLT_MAX', 'MOT_BAT_VOLT_MIN']},
    '자세제어':        {'params': ['ANGLE_MAX']},
    '진동·센서':       {'tel': ['VIBRATION', 'EKF_STATUS_REPORT']},
    '지오펜스':        {'params': ['FENCE_ENABLE']},
}
GROUP_ORDER = list(GROUP_NEEDS)
# 묶음 하나의 판정 = 가장 나쁜 등급. GO 가 아니면 NO GO (SHADE01 과 같은 규칙).
GROUP_VERDICT = {'blk': 'NO GO', 'warn': 'NO GO', 'ok': 'GO', 'info': '참고'}
STANDING = [('실비행 이력', '이 기체는 실비행 이력이 0회다. 이 판정은 파라미터·정지상태 텔레메트리 '
                            '기준이며, 모터 동시기동 실패(00-progress.md #1)·나침반 재보정 등 '
                            '지상시험에서만 드러나는 문제는 이 도구로 못 잡는다.')]


def verdict_of(r):
    if any(x[0] == 'blk' for x in r.items):
        return 'NO-GO'
    if any(x[0] == 'warn' for x in r.items):
        return '확인 후 판단'
    return 'GO'


def judge(p, tel):
    r = Result()
    check_params(r, p)
    check_live(r, tel)
    return r


def group_progress(name, p, tel):
    need = GROUP_NEEDS[name]
    want = need.get('params', []) + need.get('tel', [])
    have = sum(1 for n in need.get('params', []) if n in p) + sum(1 for k in need.get('tel', []) if k in tel)
    return have / len(want)


def as_groups(r):
    groups = {}
    for i, (level, g, name, value, why) in enumerate(r.items):
        groups.setdefault(g, {'name': g, 'items': []})['items'].append(
            {'level': level, 'name': name, 'detail': value, 'why': why, 'seq': i})
    order = {g: i for i, g in enumerate(GROUP_ORDER)}
    out = []
    for g in sorted(groups, key=lambda g: (order.get(g, 99), g)):
        gr = groups[g]
        lv = {it['level'] for it in gr['items']}
        worst = 'blk' if 'blk' in lv else 'warn' if 'warn' in lv else 'ok' if 'ok' in lv else 'info'
        gr['level'], gr['verdict'] = worst, GROUP_VERDICT[worst]
        out.append(gr)
    return out


def empty_group(g):
    """판정거리가 하나도 안 온 채 끝난 묶음. 🔴 GO 로 내지 않는다 — 안 본 것이다."""
    return {'name': g, 'items': [], 'level': 'info', 'verdict': '수신 없음'}


def as_json(r, how, notes, elapsed):
    groups = as_groups(r)
    have = {g['name'] for g in groups}
    groups += [empty_group(g) for g in GROUP_ORDER if g not in have]
    v = verdict_of(r)
    return {
        'ok': True,
        'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
        'airframe': 'DRONE01',
        'verdict': v,
        'exit': 0 if v == 'GO' else 1,
        'elapsed': round(elapsed, 2),
        'how': how,
        'notes': notes,
        'groups': groups,
        'standing': [{'name': n, 'text': t} for n, t in STANDING],
    }


def machine(m, how, notes, secs, streaming, t0):
    """--json 이면 끝에 한 벌, --stream 이면 묶음이 끝나는 대로 한 줄씩 (NDJSON).

      {"t":"start", groups:[{name,label}...]}   무엇을 볼 것인지
      {"t":"prog",  progress:{name: 0.0~1.0}}   지금까지 몇 개가 왔나
      {"t":"group", group:{...}}                한 묶음이 끝났다 (판정 포함)
      {"t":"done",  ...as_json...}              전부 끝났다 — 이것이 정본
    """
    def line(obj):
        json.dump(obj, sys.stdout, ensure_ascii=False)
        sys.stdout.write('\n')
        sys.stdout.flush()

    p, tel, sent, last = {}, {}, set(), [None]

    def tick():
        prog = {g: round(group_progress(g, p, tel), 3) for g in GROUP_ORDER}
        if prog == last[0]:
            return
        last[0] = prog
        line({'t': 'prog', 'progress': prog, 'elapsed': round(time.time() - t0, 2)})
        ready = [g for g, v in prog.items() if v >= 1.0 and g not in sent]
        if not ready:
            return
        groups = {g['name']: g for g in as_groups(judge(p, tel))}
        for g in ready:
            sent.add(g)
            line({'t': 'group', 'group': groups.get(g) or empty_group(g),
                  'elapsed': round(time.time() - t0, 2)})

    if streaming:
        line({'t': 'start', 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'), 'how': how, 'secs': secs,
              'airframe': 'DRONE01', 'groups': [{'name': g, 'label': g} for g in GROUP_ORDER]})
    cb = tick if streaming else None
    read_params(m, WANT_PARAMS, got=p, on_msg=cb)
    sample_telemetry(m, seconds=secs, tel=tel, on_msg=cb)

    blob = as_json(judge(p, tel), how, notes, time.time() - t0)
    if streaming:
        blob['t'] = 'done'
    line(blob)
    return blob['exit']


def main():
    ap = argparse.ArgumentParser(description='DRONE01 비행 전 점검 (읽기 전용 — FC 값을 바꾸지 않는다)')
    ap.add_argument('--conn', help='mavlink 연결 문자열. 안 주면 이 기체의 FC USB 를 USB id 로 찾는다')
    ap.add_argument('-t', '--secs', type=float, default=3.0, help='텔레메트리 수집 최대 시간 (기본 3초)')
    ap.add_argument('--no-color', action='store_true', help='색 없음 (지금은 원래 색이 없다 — 에이전트 호환용)')
    ap.add_argument('--json', action='store_true', help='판정을 JSON 한 벌로')
    ap.add_argument('--stream', action='store_true', help='묶음이 끝나는 대로 NDJSON 으로')
    a = ap.parse_args()
    t0 = time.time()

    m, how, hb_s, notes = connect(a.conn)
    if m is None:
        if a.json or a.stream:
            # 🔴 붙지 못한 것을 "이상 없음" 으로 내지 않는다.
            json.dump({'ok': False, 'at': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
                       'verdict': 'NO-GO', 'exit': 1, 'error': 'FC 에 붙지 못했다',
                       'notes': notes, 'groups': [], 'standing': [], 't': 'done'},
                      sys.stdout, ensure_ascii=False)
            sys.stdout.write('\n')
            sys.exit(1)
        print('연결 실패')
        for n in notes:
            print(' ·', n)
        sys.exit(2)

    if a.json or a.stream:
        sys.exit(machine(m, how, notes, a.secs, a.stream, t0))

    print('DRONE(쿼드) 비행 전 점검   %s' % time.strftime('%Y-%m-%d %H:%M:%S'))
    print('경로: %s   %.1f초' % (how, hb_s))
    print('─' * 70)

    r = Result()
    p = read_params(m, WANT_PARAMS)
    check_params(r, p)

    tel = sample_telemetry(m, seconds=a.secs)
    check_live(r, tel)

    blk = [x for x in r.items if x[0] == 'blk']
    warn = [x for x in r.items if x[0] == 'warn']
    ok = [x for x in r.items if x[0] == 'ok']

    if blk:
        print('\n진행 불가 (%d)' % len(blk))
        for level, group, name, value, why in blk:
            print('  ✖ %-18s %s' % (name, value))
            if why:
                print('     %s' % why)
    if warn:
        print('\n확인 필요 (%d)' % len(warn))
        for level, group, name, value, why in warn:
            print('  ▲ %-18s %s' % (name, value))
            if why:
                print('     %s' % why)
    if ok:
        print('\n✔ 정상 (%d)  ' % len(ok) + ', '.join(name for _, _, name, _, _ in ok))

    print('\n' + '─' * 70)
    verdict = verdict_of(r)
    print('판정: %s' % verdict)
    print('  🔴 이 기체는 실비행 이력이 0회다. 이 판정은 파라미터·정지상태 텔레메트리')
    print('     기준이며, 모터 동시기동 실패(00-progress.md #1)·나침반 재보정 등')
    print('     지상시험에서만 드러나는 문제는 이 도구로 못 잡는다.')

    sys.exit(0 if verdict == 'GO' else 1)


if __name__ == '__main__':
    main()
