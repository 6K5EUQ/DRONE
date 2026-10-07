#!/usr/bin/env python3
"""DRONE01 점검 에이전트 — FC 가 꽂힌 PC(rim3)에서 돌고, 웹서버가 HTTP 로 부른다.

SHADE01 tools/preflight/agent.py 를 이 기체에 맞게 옮긴 것이다.

## 왜 따로 있나

웹서버는 랩서버에서 돌고 FC 는 rim3 USB 에 꽂힌다. FC 와 말하는 일은
**이 PC 안에서만** 한다. 랩서버가 보내는 것은 "점검을 돌려라" 라는 HTTP
요청 하나고, 받는 것은 preflight.py 가 낸 NDJSON 그대로다.

    브라우저 → 웹서버(ku-labserver)  POST /api/preflight/stream
                 │ HTTP + X-Preflight-Key
                 ▼
             agent.py (rim3)          GET /preflight/stream
                 │ subprocess
                 ▼
             preflight.py ──USB──▶ FC

## 🔴 FC USB 는 한 프로그램만 쥔다

평소에는 라이브 화면(drone-live, drone-livepush)이 FC 를 쥐고 있다.
점검하는 동안만 그 둘을 내리고, 끝나면 **원래 켜져 있던 것만** 다시 켠다
(CLAUDE.md 「drone-live off → 작업 → on」 을 대신 해 주는 것).
라이브를 내린 뒤에도 누가 포트를 쥐고 있으면(logdl·QGC 등) 점검하지 않는다 —
리눅스 시리얼은 둘이 동시에 열 수 있어서, 열면 그쪽 작업을 망친다.

## 읽기 전용이라는 사실은 preflight.py 가 보증한다

preflight.py 는 PARAM_SET·COMMAND_LONG·미션 업로드를 보내지 않는다.
이 에이전트는 그 프로그램을 부르는 것 외에 아무것도 안 하고, 요청에서
받는 것은 숫자인 수집 시간뿐이다 (범위로 자른다).

## 띄우기

    DRONE_PREFLIGHT_KEY=<암호> .venv/bin/python tools/preflight/agent.py

바인드는 이 PC 의 Tailscale 주소다. 못 얻으면 뜨지 않는다 (systemd 가 다시
띄운다) — 127.0.0.1 로 떨어지면 랩서버가 못 닿는데 떠 있는 것처럼 보인다.
"""

import glob
import json
import os
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
PREFLIGHT = os.path.join(HERE, 'preflight.py')
PYTHON = os.path.join(REPO, '.venv', 'bin', 'python')

sys.path.insert(1, os.path.join(HERE, '..'))
import fcport                                              # noqa: E402

PORT = int(os.environ.get('DRONE_PREFLIGHT_PORT', '4412'))
BIND = os.environ.get('DRONE_PREFLIGHT_BIND', '')
KEY = os.environ.get('DRONE_PREFLIGHT_KEY', '')
TIMEOUT = float(os.environ.get('DRONE_PREFLIGHT_TIMEOUT', '45'))
# 🔴 연타 방지. 점검마다 라이브 화면이 잠깐 내려간다.
MIN_INTERVAL = float(os.environ.get('DRONE_PREFLIGHT_INTERVAL', '5'))
LIVE_UNITS = ['drone-live', 'drone-livepush']


def fail(error, notes=()):
    return {'ok': False, 'verdict': 'NO-GO', 'error': error, 'notes': list(notes),
            'groups': [], 'standing': [], 't': 'done'}


def systemctl(*args):
    return subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True, timeout=30)


def fc_holders():
    """FC tty 를 열고 있는 프로세스 pid. 없으면 빈 목록."""
    port = fcport.find_port()
    if not port:
        return []
    dev = os.path.realpath(port)
    pids = []
    for fd in glob.glob('/proc/[0-9]*/fd/*'):
        try:
            if os.readlink(fd) == dev:
                pids.append(int(fd.split('/')[2]))
        except OSError:
            continue
    return sorted(set(pids))


class Live:
    """라이브 화면을 내리고, 끝나면 원래 켜져 있던 것만 올린다."""

    def __enter__(self):
        self.was = [u for u in LIVE_UNITS if systemctl('is-active', '--quiet', u).returncode == 0]
        if self.was:
            systemctl('stop', *self.was)
        return self

    def __exit__(self, *exc):
        if self.was:
            systemctl('start', *self.was)


def preflight_cmd(secs, stream):
    return [PYTHON, PREFLIGHT, '--stream' if stream else '--json', '--no-color', '-t', '%.1f' % secs]


def run_json(secs):
    try:
        p = subprocess.run(preflight_cmd(secs, False), capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return 504, fail('점검이 %.0f초 안에 안 끝났다' % TIMEOUT)
    try:
        return 200, json.loads(p.stdout)
    except Exception:
        # 판정을 못 읽었으면 GO 라고 하지 않는다.
        return 500, fail('preflight 출력이 JSON 이 아니다', [(p.stderr or p.stdout)[:400]])


def run_stream(handler, secs):
    """preflight.py 의 NDJSON 을 **해석 없이** 그대로 흘린다."""
    handler.send_response(200)
    handler.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Transfer-Encoding', 'chunked')
    handler.end_headers()

    def chunk(b):
        handler.wfile.write(b'%X\r\n' % len(b) + b + b'\r\n')
        handler.wfile.flush()

    p = subprocess.Popen(preflight_cmd(secs, True), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        for raw in p.stdout:
            chunk(raw)
        handler.wfile.write(b'0\r\n\r\n')
        handler.wfile.flush()
    except (BrokenPipeError, ConnectionResetError):
        p.kill()                                # 브라우저가 닫았다
    finally:
        try:
            p.wait(timeout=TIMEOUT)
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()


class State:
    last_run = 0.0
    running = False


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *a):
        sys.stderr.write('%s %s\n' % (time.strftime('%H:%M:%S'), fmt % a))

    def _json(self, code, obj):
        # 끝 줄바꿈 — 스트림을 기다리던 쪽(콕핏)은 줄 단위로만 읽는다.
        body = (json.dumps(obj, ensure_ascii=False) + '\n').encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/health':
            return self._json(200, {'ok': True, 'host': os.uname().nodename,
                                    'serial': [d for d in (fcport.find_port(),) if d],
                                    'running': State.running})
        if path not in ('/preflight', '/preflight/stream'):
            return self._json(404, {'error': '없는 경로'})
        if KEY and self.headers.get('X-Preflight-Key') != KEY:
            return self._json(401, {'error': '암호가 다르다'})
        if State.running:
            return self._json(409, fail('이미 점검이 돌고 있다'))
        wait = MIN_INTERVAL - (time.time() - State.last_run)
        if wait > 0:
            return self._json(429, fail('%.0f초 뒤에 다시 하라' % wait))

        secs = 6.0
        q = self.path.split('?', 1)
        if len(q) == 2:
            for kv in q[1].split('&'):
                k, _, v = kv.partition('=')
                if k == 't':
                    try:
                        secs = max(2.0, min(20.0, float(v)))
                    except ValueError:
                        pass

        State.running = True
        try:
            if not fcport.find_port():
                return self._json(200, fail('FC USB 없음', ['ls /dev/serial/by-id/']))
            with Live():
                held = fc_holders()
                if held:
                    return self._json(200, fail('FC 포트를 다른 프로그램이 쓰는 중',
                                                ['pid %s' % ', '.join(map(str, held)),
                                                 'fuser -v %s' % fcport.BY_ID]))
                if path == '/preflight/stream':
                    return run_stream(self, secs)
                code, obj = run_json(secs)
        finally:
            State.running = False
            State.last_run = time.time()
        obj['agent'] = os.uname().nodename
        return self._json(code, obj)


def tailscale_ip():
    try:
        out = subprocess.run(['tailscale', 'ip', '-4'], capture_output=True, text=True, timeout=4).stdout
        return out.split('\n')[0].strip() or None
    except Exception:
        return None


def main():
    bind = BIND or tailscale_ip()
    if not bind:
        sys.exit('Tailscale 주소를 못 얻었다 — DRONE_PREFLIGHT_BIND 로 정하거나 tailscale 을 띄워라')
    if not KEY:
        sys.stderr.write('⚠️  DRONE_PREFLIGHT_KEY 가 비었다 — 이 주소에 닿는 누구나 점검을 돌릴 수 있다.\n')
    srv = ThreadingHTTPServer((bind, PORT), Handler)
    sys.stderr.write('drone preflight agent: http://%s:%d\n' % (bind, PORT))
    srv.serve_forever()


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        pass
