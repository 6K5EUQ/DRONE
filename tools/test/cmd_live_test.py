#!/usr/bin/env python3
"""cmd_agent.py live 모드 시험 — 가짜 FC(fake_fc.py) + 가짜 명령 서버. 실제 FC·파이·랩서버에 안 붙는다.

    .venv/bin/python tools/test/cmd_live_test.py

포트: HTTP 4404(가짜 서버)·4405·4406(drone_live), UDP 14565(에이전트)·14566·14567(drone_live 다리).
seen_ids 는 임시 HOME 에만 쓴다. 자식은 SIGTERM 으로 끝낸다. ~2분.
"""
import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
LIVE = os.path.join(ROOT, 'tools', 'live')
sys.path.insert(0, HERE)
sys.path.insert(0, LIVE)
from fake_fc import FakeFc, MAV   # noqa: E402

PY = sys.executable
AGENT = os.path.join(LIVE, 'cmd_agent.py')
DLIVE = os.path.join(LIVE, 'drone_live.py')
HTTP_PORT, DL_HTTP, DL_HTTP2 = 4404, 4405, 4406
AG_UDP, DL_DEV, DL_BRIDGE = 14565, 14566, 14567
KEY = 'cmd-key-for-test-0123456789'
TMP = tempfile.mkdtemp(prefix='cmdlive-')
passed = failed = 0
kids = []


def ok(cond, name, extra=''):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print('  ✖', name, extra, flush=True)


def until(f, t=8.0):
    end = time.monotonic() + t
    while time.monotonic() < end:
        if f():
            return True
        time.sleep(0.05)
    return False


# ── 가짜 명령 서버 ───────────────────────────────────────────────────
class Q:
    cmds, acks, polls = [], [], []      # polls: (시각, wait, status)
    down = False
    n = 0
    gen = 0                             # 에이전트를 바꿀 때 올린다 — 죽은 에이전트의 롱폴이 명령을 가로채지 않게
    lock = threading.Lock()


class H(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, obj=None):
        b = json.dumps(obj).encode() if obj is not None else b''
        try:
            self.send_response(code)
            self.send_header('Content-Length', str(len(b)))
            self.end_headers()
            self.wfile.write(b)
        except OSError:
            pass                        # 에이전트가 끊었다 (끊김 시험·SIGTERM)

    def do_GET(self):                   # noqa: N802
        while Q.down:                   # LTE 끊김 흉내 — 응답 없이 붙잡는다
            time.sleep(0.05)
        wait = float(urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query).get('wait', ['0'])[0])
        end = time.monotonic() + wait
        gen = Q.gen
        while True:
            with Q.lock:
                c = Q.cmds.pop(0) if Q.cmds and gen == Q.gen else None
            if c or time.monotonic() >= end or Q.down or gen != Q.gen:
                break
            time.sleep(0.05)
        if Q.down:                      # 붙잡는 사이 끊겼다
            while Q.down:
                time.sleep(0.05)
        Q.polls.append((time.monotonic(), wait, 200 if c else 204))
        return self._send(200, c) if c else self._send(204)

    def do_POST(self):                  # noqa: N802
        n = int(self.headers.get('Content-Length', 0))
        b = json.loads(self.rfile.read(n) or b'{}')
        Q.acks.append({'id': self.path.split('/')[3], **b})
        self._send(200, {})


def give(kind, args=None, ttl_ms=30000):
    with Q.lock:
        Q.n += 1
        cid = 'c%011d' % Q.n
        Q.cmds.append({'id': cid, 'kind': kind, 'args': args or {}, 'ttl_ms': ttl_ms})
    return cid


END = {'done', 'failed', 'rejected', 'expired', 'unknown'}


def final(cid, t=12.0):
    until(lambda: any(a['id'] == cid and a['state'] in END for a in Q.acks), t)
    a = [a for a in Q.acks if a['id'] == cid and a['state'] in END]
    return a[-1] if a else {}


def run(kind, args=None):
    return final(give(kind, args))


# ── 자식 ────────────────────────────────────────────────────────────
def spawn(args, env_extra=None):
    env = dict(os.environ, HOME=os.path.join(TMP, 'home%d' % len(kids)), CMD_KEY=KEY, CMD_URL='')
    env.pop('DRONE_CMD_LIVE', None)
    env.update(env_extra or {})
    p = subprocess.Popen([PY] + args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    p.lines = []
    threading.Thread(target=lambda: [p.lines.append(l.rstrip('\n')) for l in p.stdout], daemon=True).start()
    kids.append(p)
    return p


def kill(p):
    Q.gen += 1
    if p.poll() is None:
        p.send_signal(signal.SIGTERM)
        try:
            p.wait(5)
        except subprocess.TimeoutExpired:
            p.kill()


def agent(live=True, env=True, extra=()):
    a = [AGENT, '--url', 'http://127.0.0.1:%d' % HTTP_PORT, '--bridge', 'udpin:127.0.0.1:%d' % AG_UDP] + list(extra)
    if live:
        a.append('--live')
    return spawn(a, {'DRONE_CMD_LIVE': '1'} if env else {})


def rtl_count(fc, since=0.0):
    return len([m for m in fc.got('COMMAND_LONG', since) if m.command == MAV.MAV_CMD_NAV_RETURN_TO_LAUNCH])


def wait_poll():
    """방금 응답이 나간 직후를 잡는다 — 끊김 길이를 응답 간격으로 재기 위해."""
    n = len(Q.polls)
    until(lambda: len(Q.polls) > n, 5)


def main():
    srv = ThreadingHTTPServer(('127.0.0.1', HTTP_PORT), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()

    # ── dry-run 기본값 ───────────────────────────────────────────
    print('— dry-run 기본값: 플래그 하나만 있거나 없으면 FC 로 한 바이트도 안 나간다', flush=True)
    fc = FakeFc(('127.0.0.1', AG_UDP)).start()
    for live, env, name in ((False, False, '플래그 없음'), (True, False, '--live 만'), (False, True, 'DRONE_CMD_LIVE 만')):
        t0 = time.monotonic()
        ag = agent(live, env)
        r = run('arm')
        ok(r.get('state') == 'rejected' and r.get('detail') == 'dry-run', 'dry-run (%s) → rejected dry-run' % name, r)
        time.sleep(1.5)
        ok(not fc.got(since=t0), 'dry-run (%s) → FC 로 0바이트' % name, len(fc.got(since=t0)))
        ok(any(w == 25 for (at, w, s) in Q.polls if at >= t0), 'dry-run (%s) 롱폴 wait=25' % name)
        kill(ag)
    ok(any('둘 다 있어야' in l for l in ag.lines), '하나만 주면 그렇다고 말한다', ag.lines)

    # ── 오래된 명령 (단위) ──────────────────────────────────────
    print('— 받은 지 2초 넘은 명령은 실행 안 하고 expired', flush=True)
    os.environ['HOME'] = os.path.join(TMP, 'unit')
    import importlib
    import cmd_agent
    importlib.reload(cmd_agent)
    called = []

    class S:
        def request(self, m, p, body=None):
            called.append(('ack', body))
            return 200, {}
    cmd_agent.handle(S(), {'id': 'stale0000000', 'kind': 'rtl', 'ttl_ms': 30000}, time.monotonic() - 2.5, {},
                     run=lambda c, p: called.append('run') or ('done', None, 0))
    ok('run' not in called and called[-1][1].get('state') == 'expired' and called[-1][1].get('detail') == 'stale',
       '2.5초 묵음 → expired stale, 실행 안 함', called)
    called.clear()
    cmd_agent.handle(S(), {'id': 'fresh0000000', 'kind': 'rtl', 'ttl_ms': 30000}, time.monotonic(), {},
                     run=lambda c, p: called.append('run') or ('done', None, 0))
    ok('run' in called, '방금 받은 것은 실행')

    # ── live ────────────────────────────────────────────────────
    print('— live: 하트비트·롱폴 간격', flush=True)
    t0 = time.monotonic()
    ag = agent()
    ok(until(lambda: any(m.get_srcSystem() == 255 and m.type == MAV.MAV_TYPE_GCS for m in fc.got('HEARTBEAT', t0))),
       'GCS 하트비트 sysid 255', ag.lines)
    time.sleep(3)
    ws = [w for (at, w, s) in Q.polls if at >= t0 + 1.0]
    ok(ws and all(w == 2 for w in ws), 'live 롱폴 wait=2', ws)
    hb = [at for (at, m) in fc.rx if at >= t0 and m.get_type() == 'HEARTBEAT']
    ok(len(hb) >= 3, '하트비트 1 Hz 쯤', len(hb))

    print('— arm 사전 거부', flush=True)
    fc.volt = 13.5
    time.sleep(1.3)
    ok(run('arm').get('detail') == 'volt', '전압 13.5 → rejected volt')
    fc.volt, fc.fix = 15.2, 2
    time.sleep(1.3)
    ok(run('arm').get('detail') == 'gps', 'fix 2 → rejected gps')
    fc.fix, fc.mode = 3, 2
    time.sleep(1.3)
    ok(run('arm').get('detail') == 'mode', 'ALT_HOLD → rejected mode')
    fc.mode = 5
    time.sleep(1.3)
    ok(not [m for m in fc.got('COMMAND_LONG') if m.command == 400], '거부된 arm 은 FC 로 안 나감')
    fc.reject = {400}
    r = run('arm')
    ok(r.get('state') == 'failed' and r.get('mav_result') == MAV.MAV_RESULT_FAILED, 'FC 가 거부 → failed mav_result 4', r)
    fc.reject = set()
    cid = give('arm')
    r = final(cid)
    ok(r.get('state') == 'done', 'LOITER·3D·15.2V → arm done', r)
    ok(any(a['id'] == cid and a['state'] == 'fc_ack' for a in Q.acks), 'arm 중간 fc_ack')
    arms = [m for m in fc.got('COMMAND_LONG') if m.command == 400]
    ok(arms and all(m.param1 == 1 and m.param2 == 0 for m in arms), 'arm 프레임 param1=1 param2=0 (21196 아님)',
       [(m.param1, m.param2) for m in arms])

    print('— 시동 중 미션 업로드 거부 · disarm 사전조건', flush=True)
    ok(run('mission_upload', {'items': []}).get('detail') == 'armed', '시동 중 mission_upload → rejected armed')
    fc.landed = 2
    time.sleep(1.3)
    ok(run('disarm').get('detail') == 'not-landed', '공중 → disarm rejected not-landed')
    fc.landed = 1
    time.sleep(1.3)
    ok(run('disarm').get('state') == 'done', '지상 → disarm done')
    ok(run('mission_start').get('detail') == 'disarmed', '꺼진 채 mission_start → rejected disarmed')

    print('— 미션 업로드 + 되읽기 대조', flush=True)
    items = [{'seq': 0, 'cmd': 16, 'frame': 3, 'lat': 35.2, 'lon': 128.5, 'alt': 0, 'p1': 0},
             {'seq': 1, 'cmd': 22, 'frame': 3, 'lat': 35.2, 'lon': 128.5, 'alt': 30.0, 'p1': 0},
             {'seq': 2, 'cmd': 16, 'frame': 3, 'lat': 35.2012345, 'lon': 128.5054321, 'alt': 30.3, 'p1': 0},
             {'seq': 3, 'cmd': 19, 'frame': 3, 'lat': 35.2012345, 'lon': 128.5054321, 'alt': 12.7, 'p1': 5},
             {'seq': 4, 'cmd': 21, 'frame': 3, 'lat': 35.2012345, 'lon': 128.5054321, 'alt': 0, 'p1': 0}]
    cid = give('mission_upload', {'items': items, 'hash': 'x'})
    r = final(cid)
    ok(r.get('state') == 'done', '일치 → done', r)
    ok(any(a['id'] == cid and a['state'] == 'fc_ack' for a in Q.acks), '업로드 ACK 뒤 fc_ack')
    ok([m.x for m in fc.mission[1:]] == [int(round(i['lat'] * 1e7)) for i in items[1:]]
       and all(m.frame == 3 for m in fc.mission), 'FC 가 받은 항목 위도·프레임 3', [(m.x, m.frame) for m in fc.mission])
    ok(fc.got('MISSION_REQUEST_LIST') and fc.got('MISSION_ACK'), '되읽기 MISSION_REQUEST_LIST·ACK')
    fc.corrupt = True
    r = run('mission_upload', {'items': items, 'hash': 'x'})
    ok(r.get('state') == 'failed' and 'mismatch' in str(r.get('detail')), '불일치(1e-7) → failed mismatch', r)
    fc.corrupt = False
    ok(run('mission_upload', {'items': [{'cmd': 99}]}).get('state') == 'rejected', '모양이 틀린 items → rejected')

    print('— 모드·rtl·land', flush=True)
    r = run('mode', {'mode': 'guided'})
    ok(r.get('state') == 'done' and fc.mode == 4, 'mode guided → done', r)
    sm = fc.got('SET_MODE')
    ok(sm and sm[-1].custom_mode == 4 and sm[-1].base_mode & 1, 'SET_MODE custom_mode 4')
    ok(run('mode', {'mode': 'loiter'}).get('state') == 'done' and fc.mode == 5, 'mode loiter → done')
    ok(run('mode', {'mode': 'stabilize'}).get('detail') == 'mode', '없는 모드 → rejected')
    fc.reject = {20}
    r = run('rtl')
    ok(r.get('state') == 'failed' and r.get('detail') == 'fc', 'FC 가 rtl 거부 → failed', r)
    fc.reject = set()
    ok(run('land').get('state') == 'done' and fc.mode == 9, 'land → done (LAND)')
    fc.mode = 5
    time.sleep(1.3)

    print('— 워치독 (AUTO·GUIDED 시동 중에만)', flush=True)
    ok(run('arm').get('state') == 'done', 'arm')
    fc.landed = 2
    ok(run('mode', {'mode': 'guided'}).get('state') == 'done', 'guided')
    t0 = time.monotonic()
    time.sleep(10)
    ok(rtl_count(fc, t0) == 0, '정상 2초 간격 204 10초 → RTL 없음')
    gaps = [b - a for (a, *_), (b, *_) in zip(Q.polls, Q.polls[1:]) if a >= t0]
    ok(gaps and max(gaps) < 3.0, '응답 간격 < 3초', gaps)
    wait_poll()
    t0 = time.monotonic()
    Q.down = True
    time.sleep(4.0)
    Q.down = False
    time.sleep(1.5)
    ok(rtl_count(fc, t0) == 0 and fc.mode == 4, '4초 끊김 → RTL 없음', (rtl_count(fc, t0), fc.mode))
    q0 = len(Q.cmds)
    wait_poll()
    fc.ignore_rtl = 2
    t0 = time.monotonic()
    Q.down = True
    ok(until(lambda: rtl_count(fc, t0) >= 1, 9), '6초 끊김 → RTL')
    first = [at for (at, m) in fc.rx if at >= t0 and m.get_type() == 'COMMAND_LONG' and m.command == 20]
    ok(first and 5.0 <= first[0] - t0 <= 6.5, 'RTL 은 5초 넘어서', first[0] - t0 if first else None)
    ok(until(lambda: fc.mode == 6, 6), 'RTL 확인')
    n = rtl_count(fc, t0)
    ok(n == 3, 'RTL 재전송 (1초 간격, 확인되면 멈춤) — 3번', n)
    first = [at for (at, m) in fc.rx if at >= t0 and m.get_type() == 'COMMAND_LONG' and m.command == 20]
    gaps = [b - a for a, b in zip(first, first[1:])]
    ok(gaps and all(0.8 <= g <= 1.5 for g in gaps), '재전송 간격 ~1초', gaps)
    old = give('mode', {'mode': 'guided'})   # 끊긴 사이 쌓인 명령
    hb_down = [m for m in fc.got('HEARTBEAT', t0 + 5.5) if m.get_srcSystem() == 255]
    ok(not hb_down, '끊긴 동안 GCS 하트비트 멈춤', len(hb_down))
    time.sleep(1)
    Q.down = False
    r = final(old)
    ok(r.get('state') == 'rejected' and r.get('detail') == 'watchdog', '복구 뒤 쌓인 명령 → rejected watchdog', r)
    time.sleep(1)
    ok(fc.mode == 6 and rtl_count(fc, t0) == n, '복구 뒤에도 RTL 유지, 재전송 없음')
    ok(until(lambda: any(m.get_srcSystem() == 255 for m in fc.got('HEARTBEAT', time.monotonic() - 1.5)), 4),
       '복구 뒤 GCS 하트비트 다시')
    del q0

    print('— 조종사 개입', flush=True)
    fc.ch5 = 1900                       # 모드 스위치
    time.sleep(1.3)
    ok(run('mode', {'mode': 'loiter'}).get('detail') == 'pilot', 'CH5 움직임 → 잠금, rejected pilot')
    ok(any('조종사가 가져감' in l for l in ag.lines), '잠금 로그')
    wait_poll()
    t0 = time.monotonic()
    fc.mode = 3                         # (조종사 상태에서) AUTO 라도
    Q.down = True
    time.sleep(7)
    Q.down = False
    ok(rtl_count(fc, t0) == 0, '조종사가 가져간 뒤 워치독은 모드 안 바꿈')
    ok(run('land').get('detail') == 'pilot', '잠금 중 land 도 rejected pilot')
    fc.landed, fc.armed = 1, False      # 착지
    time.sleep(1.3)
    r = run('mode', {'mode': 'loiter'})
    ok(r.get('state') == 'done', '착지 뒤 잠금 풀림', r)
    ok(run('arm').get('state') == 'done', 'arm')
    fc.landed = 2
    time.sleep(1.3)
    fc.mode = 2                         # 에이전트가 안 시킨 모드
    time.sleep(1.3)
    ok(run('mode', {'mode': 'guided'}).get('detail') == 'pilot', '안 시킨 모드 전환 → rejected pilot')
    fc.landed, fc.armed = 1, False
    time.sleep(1.3)

    ok(not fc.got('RC_CHANNELS_OVERRIDE'), 'RC_CHANNELS_OVERRIDE 0건')
    ok(not [m for m in fc.got('COMMAND_LONG') if m.command == 400 and m.param2 == 21196], '21196 0건')
    kill(ag)
    fc.close()

    # ── drone_live ───────────────────────────────────────────────
    print('— drone_live: --bridge 없으면 그대로 (FC 로는 스트림 요청만)', flush=True)
    fc = FakeFc(('127.0.0.1', DL_DEV)).start()
    dl = spawn([DLIVE, '--device', 'udpin:127.0.0.1:%d' % DL_DEV, '--http', str(DL_HTTP)])
    ok(until(lambda: any('붙었다' in l for l in dl.lines), 10), 'drone_live 붙음', dl.lines)
    time.sleep(1)
    st = json.loads(http_get(DL_HTTP, '/api/state') or '{}')
    ok((st.get('d') or st.get('state', {}).get('d') or {}).get('mode') == 'LOITER' or 'LOITER' in json.dumps(st),
       '/api/state 에 모드', str(st)[:200])
    ok({m.get_type() for m in fc.got()} == {'REQUEST_DATA_STREAM'}, '보낸 것은 REQUEST_DATA_STREAM 뿐',
       {m.get_type() for m in fc.got()})
    ok(http_status(DL_HTTP, 'POST', '/api/state') in (501, 405), 'HTTP POST 안 받음')
    ok(not any('[bridge]' in l for l in dl.lines), '다리 안 열림')
    kill(dl)
    fc.close()

    print('— drone_live --bridge: 가짜 FC ↔ drone_live ↔ cmd_agent live', flush=True)
    fc = FakeFc(('127.0.0.1', DL_DEV)).start()
    dl = spawn([DLIVE, '--device', 'udpin:127.0.0.1:%d' % DL_DEV, '--http', str(DL_HTTP2),
                '--bridge', '127.0.0.1:%d' % DL_BRIDGE])
    ok(until(lambda: any('붙었다' in l for l in dl.lines), 10), 'drone_live 붙음')
    # 다른 주소에서 온 프레임·RC override 는 버린다
    peer = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    peer.bind(('127.0.0.1', DL_BRIDGE))
    peer.settimeout(2)
    data, dl_addr = peer.recvfrom(65535)
    ok(bool(data), '다리가 FC 프레임을 내보냄')
    me = MAV.MAVLink(None, srcSystem=255, srcComponent=190)
    t0 = time.monotonic()
    peer.sendto(me.rc_channels_override_encode(1, 1, *([1500] * 8)).pack(me), dl_addr)
    other = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    other.bind(('127.0.0.1', 0))
    other.sendto(me.command_long_encode(1, 1, 20, 0, 0, 0, 0, 0, 0, 0, 0).pack(me), dl_addr)
    peer.sendto(me.command_long_encode(1, 1, 21, 0, 0, 0, 0, 0, 0, 0, 0).pack(me), dl_addr)
    time.sleep(1)
    ok(not fc.got('RC_CHANNELS_OVERRIDE'), '다리: RC_CHANNELS_OVERRIDE 버림')
    cl = [m.command for m in fc.got('COMMAND_LONG', t0)]
    ok(cl == [21], '다리: peer 것만 FC 로 (다른 주소 것은 버림)', cl)
    peer.close()
    other.close()
    fc.mode = 5
    ag = spawn([AGENT, '--url', 'http://127.0.0.1:%d' % HTTP_PORT, '--live', '--bridge',
                'udpin:127.0.0.1:%d' % DL_BRIDGE], {'DRONE_CMD_LIVE': '1'})
    ok(until(lambda: any('FC 확인' in l for l in ag.lines), 8), '에이전트가 다리로 FC 확인', ag.lines)
    time.sleep(1)
    r = run('mission_upload', {'items': items, 'hash': 'x'})
    ok(r.get('state') == 'done', '다리 거쳐 미션 업로드 + 대조 done', r)
    ok(run('arm').get('state') == 'done', '다리 거쳐 arm done')
    kill(ag)
    kill(dl)
    fc.close()
    srv.shutdown()


def http_get(port, path):
    try:
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        c.request('GET', path)
        return c.getresponse().read().decode()
    except OSError:
        return None


def http_status(port, method, path):
    try:
        c = http.client.HTTPConnection('127.0.0.1', port, timeout=3)
        c.request(method, path, body=b'{}')
        return c.getresponse().status
    except OSError:
        return None


if __name__ == '__main__':
    try:
        main()
    finally:
        for k in kids:
            kill(k)
        shutil.rmtree(TMP, ignore_errors=True)
    print('\n%d 통과, %d 실패' % (passed, failed))
    sys.exit(1 if failed else 0)
