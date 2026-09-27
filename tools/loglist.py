#!/usr/bin/env python3
"""FC 에 남아 있는 로그 목록을 MAVLink 로 받는다 (SD 카드를 안 빼도 된다).

    .venv/bin/python tools/loglist.py

🔴 time_utc 를 믿지 마라. 이 FC 는 RTC 가 없어 2000-01-01 근처로 찍힌다
   (2026-09-16 실측). 어느 로그가 새것인지는 **ID 번호**로 판단한다.
🔴 포트는 하나다. drone-live / QGC 를 먼저 내려야 한다.
"""
from pymavlink import mavutil
import time, datetime

m = mavutil.mavlink_connection('/dev/ttyACM0', source_system=250, source_component=190)
m.wait_heartbeat(timeout=15)
print(f"연결 OK sysid={m.target_system}")

entries = {}
num_logs = None
for attempt in range(3):
    m.mav.log_request_list_send(m.target_system, m.target_component, 0, 0xFFFF)
    t0 = time.time()
    while time.time()-t0 < 8:
        msg = m.recv_match(type='LOG_ENTRY', blocking=True, timeout=2)
        if msg is None: continue
        entries[msg.id] = msg
        num_logs = msg.num_logs
        t0 = time.time()
    if num_logs is not None and len(entries) >= num_logs:
        break
    print(f"  재시도... 현재 {len(entries)}/{num_logs}")

print(f"\n총 {num_logs}개 중 {len(entries)}개 수신\n")
print(f"{'ID':>4} {'크기(bytes)':>12} {'time_utc(raw)':>16}")
for lid in sorted(entries):
    e = entries[lid]
    print(f"{e.id:>4} {e.size:>12} {e.time_utc:>16}")
