#!/usr/bin/env python3
"""cmd_agent.py live 모드 시험 — 가짜 FC(fake_fc.py) + 가짜 명령 서버. 실제 FC·파이·랩서버에 안 붙는다.

    .venv/bin/python tools/test/cmd_live_test.py

포트: HTTP 4404(가짜 서버)·4405·4406(drone_live), UDP 14565(에이전트)·14566·14567(drone_live 다리).
seen_ids 는 임시 HOME 에만 쓴다. 자식은 SIGTERM 으로 끝낸다. ~4분.
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
    slow = 0                            # 이만큼의 GET 은 8초 붙잡는다 (느린 요청 하나)
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
        if Q.slow > 0:
            Q.slow -= 1
            time.sleep(8)
            return self._send(204)
        t_in = time.monotonic()
        while Q.down:                   # LTE 끊김 흉내 — 응답 없이 붙잡는다
            time.sleep(0.05)
        if time.monotonic() - t_in > 3.0:
            # 에이전트는 소켓 타임아웃(3초)으로 이미 끊고 다시 물었다 — 진짜 서버(cmd.js)처럼 이 요청엔 안 준다
            return self._send(204)
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


def cmds(fc, since=0.0):
    return [m.command for m in fc.got('COMMAND_LONG', since)]


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
    import cmd_fc
    ok(cmd_agent.LIVE_SOCK_TIMEOUT + cmd_agent.LIVE_BACKOFF_MIN + 1.0 < cmd_fc.LINK_GAP_S,
       '소켓 타임아웃 + 재시도 < 워치독 여유', (cmd_agent.LIVE_SOCK_TIMEOUT, cmd_fc.LINK_GAP_S))
    g = [type('G', (), {'command': 16, 'frame': 3, 'x': 352000000, 'y': 1285000000, 'z': z})() for z in (0, 30.29, 12.69)]
    its = [{'cmd': 16, 'frame': 3, 'lat': 35.2, 'lon': 128.5, 'alt': a} for a in (0, 30.3, 12.7)]
    ok(not cmd_fc.compare(its, g), '되읽기 고도 1 cm 차이(cm 버림)는 일치', cmd_fc.compare(its, g))
    g[1].z = 30.27
    ok(cmd_fc.compare(its, g), '3 cm 차이는 불일치')

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

    print('— 시동 중 미션 업로드 거부 · disarm 사전조건 (EXTENDED_SYS_STATE 없이 고도·상승·스로틀로)', flush=True)
    ok(run('mission_upload', {'items': []}).get('detail') == 'armed', '시동 중 mission_upload → rejected armed')
    fc.air()
    time.sleep(1.3)
    ok(run('disarm').get('detail') == 'not-landed', '공중(10 m, thr 40) → disarm rejected not-landed')
    fc.alt, fc.thr = 0.3, 35            # 땅 가까이지만 스로틀이 호버
    time.sleep(2.5)
    ok(run('disarm').get('detail') == 'not-landed', '0.3 m · thr 35 → not-landed')
    fc.ground()
    time.sleep(1.0)
    ok(run('disarm').get('detail') == 'not-landed', '지상 조건 1초 → 아직 not-landed (2초 이어져야)')
    time.sleep(1.5)
    ok(run('disarm').get('state') == 'done', '지상 2초 → disarm done')
    ok(run('mission_start').get('detail') == 'disarmed', '꺼진 채 mission_start → rejected disarmed')

    print('— 미션 업로드 + 되읽기 대조', flush=True)
    items = [{'seq': 0, 'cmd': 16, 'frame': 3, 'lat': 35.2, 'lon': 128.5, 'alt': 0, 'p1': 0},
             {'seq': 1, 'cmd': 22, 'frame': 3, 'lat': 35.2, 'lon': 128.5, 'alt': 30.0, 'p1': 0},
             {'seq': 2, 'cmd': 16, 'frame': 3, 'lat': 35.2012345, 'lon': 128.5054321, 'alt': 30.3, 'p1': 0},
             {'seq': 3, 'cmd': 19, 'frame': 3, 'lat': 35.2012345, 'lon': 128.5054321, 'alt': 4.18, 'p1': 5},
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
    ok(abs(fc.mission[3].z - 4.17) < 1e-4 if fc.mission else False, 'FC 는 4.18 을 4.17 로 저장 (float32·cm 버림) — 그래도 done',
       fc.mission[3].z if fc.mission else None)

    print('— 업로드 재전송 거짓 실패', flush=True)
    fc.dup_req = True
    r = run('mission_upload', {'items': items, 'hash': 'x'})
    ok(r.get('state') == 'done', '요청 중복 → 중복 항목 INVALID_SEQUENCE 무시 → done', r)
    fc.dup_req = False
    fc.drop_ack = 1
    r = final(give('mission_upload', {'items': items, 'hash': 'x'}), 20)
    ok(r.get('state') == 'done' and str(r.get('detail')).startswith('verified'), '마지막 ACK 잃음 → 되읽기로 done', r)

    print('— depart (검증된 업로드만)', flush=True)
    fc.corrupt = True
    run('mission_upload', {'items': items, 'hash': 'h1'})
    fc.corrupt = False
    ok(run('depart', {'hash': 'h1'}).get('detail') == 'not-verified', '실패한 업로드 뒤 → rejected not-verified')
    up = lambda: run('mission_upload', {'items': items, 'hash': 'h1'}).get('state') == 'done'
    ok(up(), '업로드 h1')
    ok(run('depart', {'hash': 'h2'}).get('detail') == 'not-verified', '다른 hash → not-verified')
    ok(run('depart', {}).get('detail') == 'not-verified', 'hash 없음 → not-verified')
    fc.mode = 2
    time.sleep(1.3)
    ok(run('depart', {'hash': 'h1'}).get('detail') == 'mode', 'ALT_HOLD → rejected mode')
    fc.mode = 5
    time.sleep(1.3)
    fc.reboot()
    time.sleep(1.0)
    ok(run('depart', {'hash': 'h1'}).get('detail') == 'not-verified', 'FC 재부팅(time_boot_ms 줄어듦) → not-verified')
    ok(up(), '다시 업로드')
    fc._request(0)                      # 다른 GCS 가 올리는 중 (FC 가 요청을 낸다)
    time.sleep(0.5)
    ok(run('depart', {'hash': 'h1'}).get('detail') == 'not-verified', '다른 업로드 보임 → not-verified')
    ok(up(), '다시 업로드')
    fc.mission.pop()                    # FC 미션 개수가 달라짐
    ok(run('depart', {'hash': 'h1'}).get('detail') == 'not-verified', 'FC 개수 다름 → not-verified')
    ok(up(), '다시 업로드')
    fc.reject = {300}
    t0 = time.monotonic()
    r = run('depart', {'hash': 'h1'})
    ok(r.get('state') == 'failed' and r.get('detail') == 'start-fc', 'MISSION_START 거부 → failed start-fc', r)
    ok(fc.armed is False and [m.param1 for m in fc.got('COMMAND_LONG', t0) if m.command == 400] == [1, 0],
       '그때 땅에서 바로 disarm', [(m.command, m.param1) for m in fc.got('COMMAND_LONG', t0)])
    fc.reject = set()
    time.sleep(1.3)
    t0 = time.monotonic()
    cid = give('depart', {'hash': 'h1'})
    r = final(cid, 20)
    ok(r.get('state') == 'done' and r.get('detail') == 'airborne', 'depart → done airborne', r)
    ok(len([a for a in Q.acks if a['id'] == cid and a['state'] == 'fc_ack']) == 1, 'depart 중간 fc_ack 한 번')
    cl = [m for m in fc.got('COMMAND_LONG', t0) if m.command in (400, 300)]
    ok([m.command for m in cl] == [400, 300] and cl[0].param1 == 1 and cl[0].param2 == 0, 'arm(param2 0) → MISSION_START',
       [(m.command, m.param1, m.param2) for m in cl])
    at = [a for (a, m) in fc.rx if a >= t0 and m.get_type() == 'COMMAND_LONG' and m.command in (400, 300)]
    ok(len(at) == 2 and at[1] - at[0] < 2.0, 'arm 뒤 2초 안에 MISSION_START (DISARM_DELAY 10 s 안쪽)', at)
    ok(fc.mode == 3 and fc.armed, 'AUTO·시동')
    ok(run('mission_start', {'hash': 'zz'}).get('detail') == 'not-verified', 'mission_start 다른 hash → not-verified')
    ok(run('mission_start', {'hash': 'h1'}).get('state') == 'done', 'mission_start 검증 hash → done')
    ok(run('land').get('state') == 'done', 'land')
    fc.ground()
    fc.armed = False
    fc.mode = 5
    time.sleep(1.3)

    print('— 실행 중 비상 — depart 기다림을 끊고 land 가 바로', flush=True)
    mark = len(ag.lines)
    fc.takeoff = False                  # 이륙 안 됨 → depart 가 TAKEOFF_S 기다린다
    cid = give('depart', {'hash': 'h1'})
    ok(until(lambda: fc.armed and fc.mode == 3, 8), 'depart: AUTO 까지')
    b = give('mode', {'mode': 'loiter'})
    ok(final(b).get('detail') == 'busy', '실행 중 다른 명령 → rejected busy', final(b))
    t0 = time.monotonic()
    e = give('land')
    r = final(e)
    ok(r.get('state') == 'done' and fc.mode == 9, '실행 중 land → done', r)
    ok(time.monotonic() - t0 < 4.0, 'land 가 depart 를 안 기다림', time.monotonic() - t0)
    r = final(cid, 15)
    ok(r.get('state') == 'failed' and r.get('detail') == 'interrupted', 'depart → failed interrupted', r)
    ok(not any('조종사가 가져감' in l for l in ag.lines[mark:]), '비상 land 는 조종사로 안 셈', ag.lines[mark:])
    fc.armed = False
    fc.mode = 5
    time.sleep(1.3)
    ok(up(), '업로드')
    r = final(give('depart', {'hash': 'h1'}), 20)
    ok(r.get('state') == 'failed' and r.get('detail') == 'no-takeoff', '이륙 안 보임 → failed no-takeoff', r)
    ok(run('land').get('state') == 'done', 'land')
    fc.takeoff = True
    fc.armed = False
    fc.mode = 5
    time.sleep(1.3)

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
    fc.air()
    ok(run('mode', {'mode': 'guided'}).get('state') == 'done', 'guided')
    t0 = time.monotonic()
    time.sleep(10)
    ok(rtl_count(fc, t0) == 0, '정상 2초 간격 204 10초 → RTL 없음')
    gaps = [b - a for (a, *_), (b, *_) in zip(Q.polls, Q.polls[1:]) if a >= t0]
    ok(gaps and max(gaps) < 3.0, '응답 간격 < 3초', gaps)
    wait_poll()
    t0 = time.monotonic()
    Q.slow = 1                          # 다음 GET 하나가 8초 붙잡힌다 — 소켓 타임아웃 뒤 바로 다시
    time.sleep(7)
    ok(rtl_count(fc, t0) == 0 and fc.mode == 4, '느린 요청 하나 → RTL 없음', (rtl_count(fc, t0), fc.mode))
    wait_poll()
    t0 = time.monotonic()
    Q.down = True
    time.sleep(4.0)
    Q.down = False
    time.sleep(1.5)
    ok(rtl_count(fc, t0) == 0 and fc.mode == 4, '4초 끊김 → RTL 없음', (rtl_count(fc, t0), fc.mode))
    q0 = len(Q.cmds)
    wait_poll()
    fc.ignore_rtl = 1
    t0 = time.monotonic()
    Q.down = True
    ok(until(lambda: rtl_count(fc, t0) >= 1, 9), '6초 끊김 → RTL')
    first = [at for (at, m) in fc.rx if at >= t0 and m.get_type() == 'COMMAND_LONG' and m.command == 20]
    ok(first and 4.9 <= first[0] - t0 <= 6.5, 'RTL 은 5초 넘어서 (폴 기록·틱 0.2초 오차)', first[0] - t0 if first else None)
    ok(until(lambda: fc.mode == 6, 6), 'RTL 확인')
    n = rtl_count(fc, t0)
    ok(n == 2, 'RTL 재전송 (1초 간격, 확인되면 멈춤) — 2번', n)
    first = [at for (at, m) in fc.rx if at >= t0 and m.get_type() == 'COMMAND_LONG' and m.command == 20]
    gaps = [b - a for a, b in zip(first, first[1:])]
    ok(gaps and all(0.8 <= g <= 1.5 for g in gaps), '재전송 간격 ~1초', gaps)
    ok(MAV.MAV_CMD_NAV_LAND not in cmds(fc, t0), 'RTL 이 되면 LAND 안 보냄')
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

    print('— 워치독 RTL 거부 → LAND · 복구되면 재전송 멈춤', flush=True)
    ok(run('mode', {'mode': 'guided'}).get('state') == 'done', 'guided')
    fc.reject = {20}
    mark = len(ag.lines)
    wait_poll()
    t0 = time.monotonic()
    Q.down = True
    ok(until(lambda: fc.mode == 9, 12), 'RTL 거부(ACK FAILED) → LAND')
    r_at = [a for (a, m) in fc.rx if a >= t0 and m.get_type() == 'COMMAND_LONG' and m.command == 20]
    l_at = [a for (a, m) in fc.rx if a >= t0 and m.get_type() == 'COMMAND_LONG' and m.command == 21]
    ok(r_at and l_at and l_at[0] - r_at[0] < 1.5, 'ACK 거부면 곧바로 LAND', (r_at[:1], l_at[:1]))
    ok(not any('조종사가 가져감' in l for l in ag.lines[mark:]), '워치독 LAND 는 조종사로 안 셈', ag.lines[mark:])
    Q.down = False
    fc.reject = set()
    ok(until(lambda: any('대기열 비움 끝' in l for l in ag.lines[-5:]), 6), '복구')
    time.sleep(1)
    ok(run('mode', {'mode': 'guided'}).get('state') == 'done', 'guided')
    fc.ignore_rtl = 99                  # RTL 을 받기만 하고 안 바꾼다
    wait_poll()
    t0 = time.monotonic()
    Q.down = True
    ok(until(lambda: rtl_count(fc, t0) >= 1, 9), '끊김 → RTL')
    Q.down = False
    time.sleep(5)
    ok(rtl_count(fc, t0) <= 2 and MAV.MAV_CMD_NAV_LAND not in cmds(fc, t0) and fc.mode == 4,
       '복구 뒤 RTL 재전송 멈춤·LAND 없음', (rtl_count(fc, t0), cmds(fc, t0), fc.mode))
    ok(run('mode', {'mode': 'loiter'}).get('state') == 'done' and fc.mode == 5, '복구 뒤 운용자 모드 그대로')
    time.sleep(2)
    ok(fc.mode == 5, '워치독이 덮지 않음')
    fc.ignore_rtl = 0

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
    fc.ground()
    fc.armed = False                    # 착지
    time.sleep(1.3)
    r = run('mode', {'mode': 'loiter'})
    ok(r.get('state') == 'done', '착지 뒤 잠금 풀림', r)
    ok(run('arm').get('state') == 'done', 'arm')
    fc.air()
    time.sleep(1.3)
    fc.mode = 2                         # 에이전트가 안 시킨 모드
    time.sleep(1.3)
    ok(run('mode', {'mode': 'guided'}).get('detail') == 'pilot', '안 시킨 모드 전환 → rejected pilot')
    fc.ground()
    fc.armed = False
    ok(until(lambda: any('잠금 풂' in l for l in ag.lines[-3:]), 4), '착지 판정으로 잠금 풂')
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
    dd = lambda: json.loads(http_get(DL_HTTP, '/api/state') or '{}')
    ok(dd().get('d', {}).get('lat') == 35.2, '3D fix → 위치', dd().get('d', {}).get('lat'))
    time.sleep(2.5)
    ok(dd().get('d', {}).get('landed') == 1, '지상 2초 → landed 1 (EXTENDED_SYS_STATE 없이)', dd().get('d', {}).get('landed'))
    fc.armed = True
    fc.air()
    time.sleep(1.2)
    ok(dd().get('d', {}).get('landed') == 2, '공중 → landed 2', dd().get('d', {}).get('landed'))
    fc.armed = False
    time.sleep(1.2)
    ok(dd().get('d', {}).get('landed') == 1, '시동 꺼짐 → landed 1 (고도 흔들려도)', dd().get('d', {}).get('landed'))
    fc.fix = 2
    time.sleep(0.6)
    n0 = dd().get('track_n')
    time.sleep(2.5)
    s1 = dd()
    ok(s1.get('d', {}).get('lat') is None and s1.get('d', {}).get('lon') is None, 'fix 2 → 위치 없음(None)', s1.get('d', {}).get('lat'))
    ok(s1.get('track_n') == n0, 'fix 2 → 항적 안 늘어남', (n0, s1.get('track_n')))
    fc.fix = 3
    time.sleep(2.5)
    ok(dd().get('track_n', 0) > n0 and dd().get('d', {}).get('lat') == 35.2, 'fix 3 → 다시 위치·항적')
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
    r = final(give('depart', {'hash': 'x'}), 20)
    ok(r.get('state') == 'done' and r.get('detail') == 'airborne', '다리 거쳐 depart done', r)
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
