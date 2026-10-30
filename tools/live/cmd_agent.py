#!/usr/bin/env python3
"""서버 명령 대기열을 롱폴로 가져오는 파이 에이전트 — **기본은 dry-run.**

    [웹 운용자] ──> [랩서버 /api/cmd] <──롱폴── [파이 이 스크립트]  (dry-run: FC 로는 안 나간다)
                                                   └─ live: udp 다리 ── drone_live --bridge ── FC

파이는 LTE NAT 뒤라 서버가 파이로 못 붙는다. 그래서 파이가 GET /api/cmd/next 를
걸어 두고 명령을 받아 가고, 결과는 POST /api/cmd/:id/ack 로 올린다 (web/cmd.js).

🔴 **기본은 dry-run 이다.** 받은 명령은 전부 rejected(detail 'dry-run') 로 돌려준다.
   live 는 `--live` 인자 **와** 환경변수 `DRONE_CMD_LIVE=1` 이 둘 다 있어야 켜진다 — 그때만
   cmd_fc.py(FC 쪽, drone_live 의 로컬 MAVLink 다리로 말한다)를 불러온다. 이 파일 자체에는
   FC·시리얼·MAVLink 를 여는 코드가 없다. 유닛(web/live/drone-cmd.service)은 dry-run 그대로다.

🔴 live 에서는 롱폴을 LIVE_WAIT_S(2초)로 짧게 건다 — 서버 응답(200·204)이 5초 넘게 없으면
   cmd_fc 의 워치독이 RTL 을 보내기 때문이다. 받은 지 STALE_S(2초) 넘은 명령은 실행하지 않는다.

🔴 **같은 id 는 두 번 실행하지 않는다.** 받은 id 는 실행 전에 디스크(SEEN_FILE)에 먼저
   남긴다. 재전달·재연결로 같은 id 가 다시 오면 실행 없이 ack 만 보낸다.

🔴 **만료는 받은 시각(monotonic) + 서버가 준 ttl_ms 로 판정한다.** 서버·파이 시계가
   달라도 틀리지 않게 — 서버 시각(expires)은 쓰지 않는다.

    CMD_KEY=... ./cmd_agent.py                     # 기본 https://drone01.shade-signals.com
    ./cmd_agent.py --url http://127.0.0.1:4310 --key ...
    DRONE_CMD_LIVE=1 ./cmd_agent.py --live --bridge udpin:127.0.0.1:14560    # 🔴 FC 로 보낸다
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
# live — 응답이 최대 ~2초 간격으로 오게. 워치독(cmd_fc.LINK_GAP_S 5초)보다 한참 짧게. 시간당 ~1,800회
LIVE_WAIT_S = 2
LIVE_SOCK_TIMEOUT = LIVE_WAIT_S + 3
LIVE_BACKOFF_MAX = 2.0     # live 는 복구를 빨리 알아야 한다
# 받은 시각에서 이만큼 지난 명령은 실행하지 않는다 (expired 'stale')
STALE_S = 2.0

# 네트워크 오류 시 물러서는 간격 — 2초부터 두 배씩, 최대 30초.
BACKOFF_MIN = 2.0
BACKOFF_MAX = 30.0

# 처리한 id — 한 줄에 하나(`id` 만 있으면 실행 중, `id\t상태\t사유` 면 결과까지 끝남), 최근 SEEN_KEEP 개만.
SEEN_FILE = os.path.expanduser('~/.local/state/drone-cmd/seen_ids')
SEEN_KEEP = 500


# ── 처리한 id ───────────────────────────────────────────────────────
def seen_load():
    """{id: (상태, 사유) 또는 None(결과 모름)} — 기록 순서를 지킨다."""
    seen = {}
    try:
        with open(SEEN_FILE, encoding='utf-8') as f:
            for line in f:
                p = line.rstrip('\n').split('\t')
                if p[0]:
                    seen[p[0]] = (p[1], p[2]) if len(p) >= 3 else None
    except FileNotFoundError:
        pass
    for k in list(seen)[:-SEEN_KEEP]:
        del seen[k]
    return seen


def seen_save(seen):
    """임시파일에 쓰고 rename — 쓰다 죽어도 옛 목록이 남는다."""
    for k in list(seen)[:-SEEN_KEEP]:
        del seen[k]
    os.makedirs(os.path.dirname(SEEN_FILE), exist_ok=True)
    tmp = SEEN_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(''.join(k + ('\t%s\t%s' % v if v else '') + '\n' for k, v in seen.items()))
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, SEEN_FILE)


# ── 연결 ────────────────────────────────────────────────────────────
class Server:
    """연결 하나를 들고 재사용한다 (keep-alive). 롱폴과 ack 가 같은 연결을 차례로 쓴다."""

    def __init__(self, url, key, timeout=SOCK_TIMEOUT):
        u = urllib.parse.urlsplit(url)
        self.timeout = timeout
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
                    self.c = cls(self.host, timeout=self.timeout)
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
def execute(cmd, progress):
    """dry-run 실행. (state, detail, mav_result) — 아무것도 보내지 않고 거부만 한다.

    live 면 main() 이 이 자리에 cmd_fc.Fc.run 을 넘긴다.
    """
    return 'rejected', 'dry-run', None


def handle(srv, cmd, got_at, seen, run=execute):
    """명령 하나 — 중복·만료를 보고, 아니면 execute. ack 를 보내고 한 줄 남긴다."""
    cid, kind = str(cmd.get('id', '')), str(cmd.get('kind', '?'))
    mav_result = None
    if cid in seen:
        # 다시 왔다 — 실행하지 않는다. 결과를 알면 같은 결과를 다시 알리고,
        # 모르면(실행 중 죽었다) unknown
        state, detail = seen[cid] or ('unknown', 'duplicate')
    else:
        # 🔴 실행 전에 먼저 남긴다 — 실행 중 죽어도 다시 오면 실행하지 않게
        seen[cid] = None
        seen_save(seen)
        try:
            ttl = max(0.0, float(cmd.get('ttl_ms', 0)) / 1000.0)
        except (TypeError, ValueError):
            ttl = 0.0
        path = '/api/cmd/%s/ack' % urllib.parse.quote(cid, safe='')

        def progress(st, mr):
            """중간 결과(fc_ack) — 못 올려도 최종 ack 가 간다."""
            try:
                s, _ = srv.request('POST', path, {'state': st, 'mav_result': mr})
                print('%s %s … %s ack %d' % (kind, cid, st, s), flush=True)
            except (http.client.HTTPException, OSError):
                pass

        if time.monotonic() >= got_at + ttl:
            state, detail = 'expired', 'ttl'
        elif time.monotonic() - got_at > STALE_S:
            state, detail = 'expired', 'stale'
        else:
            state, detail, mav_result = run(cmd, progress)
        seen[cid] = (state, detail)
        seen_save(seen)
    body = {'state': state, 'detail': detail}
    if mav_result is not None:
        body['mav_result'] = mav_result
    status, _ = srv.request('POST', '/api/cmd/%s/ack' % urllib.parse.quote(cid, safe=''), body)
    print('%s %s → %s (%s) ack %d' % (kind, cid, state, detail, status), flush=True)


def main():
    ap = argparse.ArgumentParser(description='서버 명령 대기열 에이전트 (기본 dry-run — FC 로 안 보낸다)')
    ap.add_argument('--url', default=os.environ.get('CMD_URL', 'https://drone01.shade-signals.com'),
                    help='서버 주소 (기본 https://drone01.shade-signals.com)')
    ap.add_argument('--key', default=os.environ.get('CMD_KEY', ''),
                    help='파이 키. 서버의 CMD_KEY 와 같아야 한다')
    # 🔴 dry-run 이 기본이다. 이 인자는 예전 호환용 — 주든 안 주든 dry-run.
    ap.add_argument('--dry-run', action='store_true', default=True,
                    help='받은 명령을 전부 거부한다 (기본)')
    ap.add_argument('--live', action='store_true',
                    help='🔴 FC 로 보낸다. 환경변수 DRONE_CMD_LIVE=1 도 있어야 켜진다')
    ap.add_argument('--bridge', default='udpin:127.0.0.1:14560',
                    help='live 때 drone_live --bridge 쪽 (기본 udpin:127.0.0.1:14560)')
    args = ap.parse_args()

    if not args.key:
        sys.exit('CMD_KEY 가 없다. 서버와 같은 값을 넣어라 (~/.config/drone-cmd.env).')

    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    live = args.live and os.environ.get('DRONE_CMD_LIVE') == '1'
    if args.live != (os.environ.get('DRONE_CMD_LIVE') == '1'):
        print('live 는 --live 와 DRONE_CMD_LIVE=1 이 둘 다 있어야 켜진다 — dry-run 으로 돈다', flush=True)
    seen = seen_load()
    fc, run, wait, bmax = None, execute, WAIT_S, BACKOFF_MAX
    if live:
        import cmd_fc       # 같은 폴더 — live 일 때만 불러온다
        fc = cmd_fc.Fc(args.bridge)
        fc.start()
        run, wait, bmax = fc.run, LIVE_WAIT_S, LIVE_BACKOFF_MAX
        srv = Server(args.url, args.key, LIVE_SOCK_TIMEOUT)
        print('명령 대기열: %s  (🔴 live — FC 다리 %s)' % (args.url, args.bridge), flush=True)
    else:
        srv = Server(args.url, args.key)
        print('명령 대기열: %s  (dry-run — FC 로 안 보낸다)' % args.url, flush=True)

    backoff = 0.0
    warned_key = warned_net = False
    while True:
        try:
            # 워치독 뒤에는 서버에 쌓인 것부터 비운다 — wait=0 으로 받아 전부 rejected('watchdog'), 204 면 끝
            flushing = fc is not None and fc.flush
            status, obj = srv.request('GET', '/api/cmd/next?wait=%d' % (0 if flushing else wait))
            got_at = time.monotonic()
            if fc is not None and status in (200, 204):
                fc.server_ok()      # 🔴 성공 응답은 200·204 만 — 오류·타임아웃·401/403·5xx 는 아니다
                if flushing and status == 204:
                    fc.flush = False
                    print('워치독 뒤 대기열 비움 끝 — 새 명령을 기다린다 (RTL 유지)', flush=True)
            if status in (401, 403):
                if not warned_key:
                    print('서버가 거절했다 (%d) — 키가 맞나?' % status, flush=True)
                    warned_key = True
                backoff = min(bmax, max(BACKOFF_MIN, backoff * 2))
            elif status >= 400:
                raise OSError('HTTP %d' % status)
            else:
                if warned_key or warned_net:
                    print('서버 복구', flush=True)
                    warned_key = warned_net = False
                backoff = 0.0
                if status == 200 and isinstance(obj, dict) and obj.get('id'):
                    handle(srv, obj, got_at, seen, run)
                # 204 는 찍지 않고 바로 다시 건다
        except (http.client.HTTPException, OSError) as e:
            if not warned_net:
                print('서버에 못 닿는다 (%s) — 계속 시도한다' % e, flush=True)
                warned_net = True
            backoff = min(bmax, max(BACKOFF_MIN, backoff * 2))
        if backoff:
            time.sleep(backoff)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n종료')
