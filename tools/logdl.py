#!/usr/bin/env python3
"""FC 의 로그 하나를 MAVLink 로 내려받는다.

    ~/.venv-mav/bin/python tools/logdl.py <ID> <크기bytes> <저장경로>

크기는 tools/loglist.py 가 찍어 준 값을 그대로 넣는다. 누락된 구간은
자동으로 다시 요청한다.

🔴 포트는 하나다. shade-bridge / drone-live / QGC 를 먼저 내려야 한다.
⚠️ 큰 로그(2MB+)는 USB 가 중간에 끊기면 실패한다 — 실제로 ID 11(2.45MB)이
   그렇게 실패했다 (2026-09-16). 받은 뒤 반드시 파싱으로 검증한다.
"""
from pymavlink import mavutil
import time, sys, os

log_id = int(sys.argv[1])
size = int(sys.argv[2])
outpath = sys.argv[3]

m = mavutil.mavlink_connection('/dev/ttyACM0', source_system=250, source_component=190)
m.wait_heartbeat(timeout=15)

CHUNK = 90  # MAVLink1 LOG_DATA payload max
data = bytearray(size)
got = bytearray(size)  # 0/1 마스크로 수신 추적
received = [False]*((size+CHUNK-1)//CHUNK)

def request_range(ofs, count):
    m.mav.log_request_data_send(m.target_system, m.target_component, log_id, ofs, count)

t_start = time.time()
next_ofs = 0
last_progress = time.time()
total_bytes_got = 0

# 순차 요청 + 누락 재요청 방식
pending = 0
last_request_time = 0
request_range(0, size)

timeout_overall = max(60, size / 3000)  # 대략 3KB/s 이상 가정, 최소 60초
while time.time() - t_start < timeout_overall:
    msg = m.recv_match(type='LOG_DATA', blocking=True, timeout=2)
    if msg is None:
        # 누락 구간 재요청
        missing = [i*CHUNK for i,r in enumerate(received) if not r]
        if not missing:
            break
        # 첫 누락 지점부터 재요청
        request_range(missing[0], size - missing[0])
        continue
    if msg.ofs >= size: continue
    n = msg.count
    chunk = bytes(msg.data[:n])
    data[msg.ofs:msg.ofs+n] = chunk
    idx = msg.ofs // CHUNK
    if idx < len(received):
        received[idx] = True
    if time.time() - last_progress > 3:
        done = sum(received)
        print(f"  {done}/{len(received)} 청크 ({done*CHUNK}/{size} bytes)", file=sys.stderr)
        last_progress = time.time()
    if all(received):
        break

done = sum(received)
pct = done/len(received)*100 if received else 0
with open(outpath, 'wb') as f:
    f.write(data)
print(f"ID={log_id} 완료: {done}/{len(received)} 청크 ({pct:.1f}%) -> {outpath}")
