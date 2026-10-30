#!/usr/bin/env python3
"""FC 에 남아 있는 로그 목록을 MAVLink 로 받는다 (SD 카드를 안 빼도 된다).

    .venv/bin/python tools/loglist.py [--tsv]

--tsv 면 stdout 에 "ID<TAB>크기" 줄만 찍는다 (나머지는 stderr).
목록이 덜 오면 stderr 에 경고하고 종료코드 2.

🔴 time_utc 를 믿지 마라. 이 FC 는 RTC 가 없어 2000-01-01 근처로 찍힌다
   (2026-09-16 실측). 어느 로그가 새것인지는 **ID 번호**로 판단한다.
🔴 포트는 하나다. drone-live / QGC 를 먼저 내려야 한다.
"""
from pymavlink import mavutil
from fcport import open_fc
import time, datetime, sys

tsv = '--tsv' in sys.argv[1:]
out = sys.stderr if tsv else sys.stdout

m = open_fc(source_system=250, source_component=190)   # 이 기체 FC 만 (USB id + 하트비트)
print(f"연결 OK sysid={m.target_system}", file=out)

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
    print(f"  재시도... 현재 {len(entries)}/{num_logs}", file=out)

if tsv:
    for lid in sorted(entries):
        print(f"{entries[lid].id}\t{entries[lid].size}")
else:
    print(f"\n총 {num_logs}개 중 {len(entries)}개 수신\n")
    print(f"{'ID':>4} {'크기(bytes)':>12} {'time_utc(raw)':>16}")
    for lid in sorted(entries):
        e = entries[lid]
        print(f"{e.id:>4} {e.size:>12} {e.time_utc:>16}")

if num_logs is None or len(entries) < num_logs:
    print(f"⚠️ 목록 불완전: {num_logs}개 중 {len(entries)}개만 수신", file=sys.stderr)
    sys.exit(2)
