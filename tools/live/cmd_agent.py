#!/usr/bin/env python3
"""서버 명령 대기열을 롱폴로 가져오는 파이 에이전트 — **dry-run 판.**

    [웹 운용자] ──> [랩서버 /api/cmd] <──롱폴── [파이 이 스크립트]  (FC 로는 안 나간다)

파이는 LTE NAT 뒤라 서버가 파이로 못 붙는다. 그래서 파이가 GET /api/cmd/next 를
걸어 두고 명령을 받아 가고, 결과는 POST /api/cmd/:id/ack 로 올린다 (web/cmd.js).

🔴 **이 단계는 dry-run 뿐이다.** 받은 명령은 전부 rejected(detail 'dry-run') 로 돌려준다.
   FC 로 보내는 자리는 execute() 하나로 떼어 두었고 지금은 거부만 반환한다.
   이 파일에는 FC·시리얼·MAVLink 를 여는 코드가 없다.

🔴 **같은 id 는 두 번 실행하지 않는다.** 받은 id 는 실행 전에 디스크(SEEN_FILE)에 먼저
   남긴다. 재전달·재연결로 같은 id 가 다시 오면 실행 없이 ack 만 보낸다.

🔴 **만료는 받은 시각(monotonic) + 서버가 준 ttl_ms 로 판정한다.** 서버·파이 시계가
   달라도 틀리지 않게 — 서버 시각(expires)은 쓰지 않는다.

    CMD_KEY=... ./cmd_agent.py                     # 기본 https://drone01.shade-signals.com
    ./cmd_agent.py --url http://127.0.0.1:4310 --key ...
"""

import argparse
import http.client
import json
import os
import signal
import sys
import time
import urllib.parse

# 🔴 기본 urllib UA(`Python-urllib/3.x`)는 Cloudflare 가 1010 으로 막는다 (livepush.py 와 같은 사정).
USER_AGENT = 'drone01-cmdagent/1.0'

# 롱폴 초. 서버(cmd.js WAIT_MAX)도 25초가 최대다. 시간당 약 144회 요청.
WAIT_S = 25
# 소켓 타임아웃 — 서버가 wait 초 뒤 204 를 주므로 그보다 넉넉히.
SOCK_TIMEOUT = WAIT_S + 10

# 네트워크 오류 시 물러서는 간격 — 2초부터 두 배씩, 최대 30초.
BACKOFF_MIN = 2.0
BACKOFF_MAX = 30.0

# 처리한 id — 한 줄에 하나, 최근 SEEN_KEEP 개만.
SEEN_FILE = os.path.expanduser('~/.local/state/drone-cmd/seen_ids')
SEEN_KEEP = 500


# ── 처리한 id ───────────────────────────────────────────────────────
def seen_load():
    try:
        with open(SEEN_FILE, encoding='utf-8') as f:
            return [l.strip() for l in f if l.strip()][-SEEN_KEEP:]
    except FileNotFoundError:
        return []


def seen_save(ids):
    """임시파일에 쓰고 rename — 쓰다 죽어도 옛 목록이 남는다."""
    os.makedirs(os.path.dirname(SEEN_FILE), exist_ok=True)
    tmp = SEEN_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(''.join(i + '\n' for i in ids[-SEEN_KEEP:]))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, SEEN_FILE)


# ── 연결 ────────────────────────────────────────────────────────────
class Server:
    """연결 하나를 들고 재사용한다 (keep-alive). 롱폴과 ack 가 같은 연결을 차례로 쓴다."""

    def __init__(self, url, key):
        u = urllib.parse.urlsplit(url)
        self.https = u.scheme != 'http'
        self.host = u.netloc or url
        # 🔴 키는 헤더에만 싣는다. 로그에 찍지 마라.
        self.headers = {'User-Agent': USER_AGENT, 'X-Cmd-Key': key}
        self.c = None

    def close(self):
        if self.c is not None:
            try:
                self.c.close()
            except Exception:
                pass
        self.c = None

    def request(self, method, path, body=None):
        """(status, dict|None). 끊긴 연결이면 한 번만 다시 열고 재시도, 그래도 안 되면 예외.

        서버·중간 장비가 idle 연결을 끊는 것은 정상이라 그때마다 백오프하지 않는다.
        """
        headers = dict(self.headers)
        data = None
        if body is not None:
            data = json.dumps(body, separators=(',', ':')).encode('utf-8')
            headers['Content-Type'] = 'application/json'
        for attempt in (0, 1):
            try:
                if self.c is None:
                    cls = http.client.HTTPSConnection if self.https else http.client.HTTPConnection
                    self.c = cls(self.host, timeout=SOCK_TIMEOUT)
                self.c.request(method, path, body=data, headers=headers)
                r = self.c.getresponse()
                raw = r.read()
                try:
                    obj = json.loads(raw.decode('utf-8')) if raw else None
                except ValueError:
                    obj = None
                return r.status, obj
            except (http.client.HTTPException, OSError):
                self.close()
                if attempt:
                    raise
        raise RuntimeError('unreachable')


# ── 실행 ────────────────────────────────────────────────────────────
def execute(cmd):
    """FC 로 보내는 자리. (state, detail) 을 돌려준다.

    🔴 지금은 dry-run — 아무것도 보내지 않고 거부만 한다. 이후 단계에서 채운다.
    """
    return 'rejected', 'dry-run'


def handle(srv, cmd, got_at, seen):
    """명령 하나 — 중복·만료를 보고, 아니면 execute. ack 를 보내고 한 줄 남긴다."""
    cid, kind = str(cmd.get('id', '')), str(cmd.get('kind', '?'))
    if cid in seen:
        # 실행했는지 알 수 없다(기록 뒤 죽었을 수 있다) — unknown 으로 알리고 실행하지 않는다
        state, detail = 'unknown', 'duplicate'
    else:
        # 🔴 실행 전에 먼저 남긴다 — 실행 중 죽어도 다시 오면 실행하지 않게
        seen.append(cid)
        del seen[:-SEEN_KEEP]
        seen_save(seen)
        try:
            ttl = max(0.0, float(cmd.get('ttl_ms', 0)) / 1000.0)
        except (TypeError, ValueError):
            ttl = 0.0
        if time.monotonic() >= got_at + ttl:
            state, detail = 'expired', 'ttl'
        else:
            state, detail = execute(cmd)
    status, _ = srv.request('POST', '/api/cmd/%s/ack' % urllib.parse.quote(cid, safe=''),
                            {'state': state, 'detail': detail})
    print('%s %s → %s (%s) ack %d' % (kind, cid, state, detail, status), flush=True)


def main():
    ap = argparse.ArgumentParser(description='서버 명령 대기열 에이전트 (dry-run — FC 로 안 보낸다)')
    ap.add_argument('--url', default=os.environ.get('CMD_URL', 'https://drone01.shade-signals.com'),
                    help='서버 주소 (기본 https://drone01.shade-signals.com)')
    ap.add_argument('--key', default=os.environ.get('CMD_KEY', ''),
                    help='파이 키. 서버의 CMD_KEY 와 같아야 한다')
    # 🔴 dry-run 이 기본이자 유일한 경로다. 끄는 인자는 없다.
    ap.add_argument('--dry-run', action='store_true', default=True,
                    help='받은 명령을 전부 거부한다 (기본, 유일)')
    args = ap.parse_args()

    if not args.key:
        sys.exit('CMD_KEY 가 없다. 서버와 같은 값을 넣어라 (~/.config/drone-cmd.env).')

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    srv = Server(args.url, args.key)
    seen = seen_load()
    print('명령 대기열: %s  (dry-run — FC 로 안 보낸다)' % args.url, flush=True)

    backoff = 0.0
    warned_key = warned_net = False
    while True:
        try:
            status, obj = srv.request('GET', '/api/cmd/next?wait=%d' % WAIT_S)
            got_at = time.monotonic()
            if status in (401, 403):
                if not warned_key:
                    print('서버가 거절했다 (%d) — 키가 맞나?' % status, flush=True)
                    warned_key = True
                backoff = min(BACKOFF_MAX, max(BACKOFF_MIN, backoff * 2))
            elif status >= 400:
                raise OSError('HTTP %d' % status)
            else:
                if warned_key or warned_net:
                    print('서버 복구', flush=True)
                    warned_key = warned_net = False
                backoff = 0.0
                if status == 200 and isinstance(obj, dict) and obj.get('id'):
                    handle(srv, obj, got_at, seen)
                # 204 는 찍지 않고 바로 다시 건다
        except (http.client.HTTPException, OSError) as e:
            if not warned_net:
                print('서버에 못 닿는다 (%s) — 계속 시도한다' % e, flush=True)
                warned_net = True
            backoff = min(BACKOFF_MAX, max(BACKOFF_MIN, backoff * 2))
        if backoff:
            time.sleep(backoff)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n종료')
