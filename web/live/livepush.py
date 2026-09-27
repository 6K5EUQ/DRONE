#!/usr/bin/env python3
"""로컬 트래커의 라이브 상태를 drone01.bewe.co.kr 로 밀어 올린다.

    [FC] ──USB──> [rim3 트래커 :4410] ──HTTPS POST──> [랩서버] ──> 웹

🔴 **rim3 가 현장 노트북이다.** 비행 나갈 때 들고 나가는 PC 가 rim3 이고,
   FC 는 거기에 USB 로 붙는다. 그래서 라이브 중계는 **rim3 에서
   돈다** — 다른 PC 에 켜 두면 기체가 없으므로 아무것도 안 올라간다.
   랩서버(`ku@ku-labserver`)는 웹만 돌린다. FC 를 직접 못 본다.

🔴 **한 방향뿐이다.** 여기서 하는 것은 트래커에게 GET 해서 서버로 POST 하는
   것뿐이다. 서버에서 받은 것을 FC 로 보내는 경로는 **없다.** 트래커는 여전히
   소켓에 쓰는 코드가 0줄이고, 이 스크립트도 FC 를 향해 아무것도 안 연다.
   웹에서 기체를 조작할 길은 구조적으로 존재하지 않는다.

⚠️ 인터넷이 없으면 조용히 계속 재시도한다. 로컬 화면(:4410)은 인터넷과
   무관하게 계속 돈다 — 중계가 죽어도 현장 화면은 안 죽는다.

    ./livepush.py                        # 기본값으로
    ./livepush.py --to https://drone01.bewe.co.kr --interval 1.0
"""

import argparse
import http.client
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# 서버로 올리는 주기.
#
# 🔴 1.0 → 0.1 (2026-09-11). 공개 화면이 1Hz 로 갱신돼 기체를 90° 꺾으면
#    30/60/90 세 프레임만 잡혔다 — 조종자 보고. FC 는 USB 로 ATTITUDE 를
#    100Hz 로 주고 트래커는 15.6Hz 로 내주는데, 이 중계가 1Hz 로 깎고 있었다.
#    브라우저 폴(POLL_MS)만 올려도 소용없다 — 소스가 1Hz 면 20번 중 19번이
#    같은 값이다.
#
# ⚠️ 데이터를 먹는다. 현장은 LTE 테더링이다 — 실측 프레임 1139 B (항적 증분
#    포함, gzip 전) 이므로 10Hz 면 **약 11 KB/s = 시간당 40 MB** 다. 1Hz 때는
#    시간당 4 MB 였다. 한 편이 10~20분이니 편당 7~14 MB 쯤 된다.
#    데이터가 아까우면 유닛에서 `--interval 0.2` (5Hz) 로 낮춰라 — 조종기
#    텔레메트리와 같은 급이고 체감 차이는 크지 않다.
#
# ⚠️ 0.1 보다 더 내리지 마라. rim3 LTE 실측 왕복이 keep-alive 로 **104ms**
#    다. 주기가 그보다 짧으면 루프가 쉬지 못하고 요청만 쌓인다.
DEFAULT_INTERVAL = 0.1

# 로컬 트래커에서 읽을 때/서버로 올릴 때의 타임아웃.
LOCAL_TIMEOUT = 3.0
PUSH_TIMEOUT = 8.0

# 서버가 죽었거나 인터넷이 없을 때 물러서는 최대 간격.
BACKOFF_MAX = 30.0

# 이 시간 넘게 프레임이 없으면 굳이 안 올린다 — 서버가 알아서 「끊김」으로
# 만든다. 기체가 없는데 계속 올려 봐야 데이터만 쓴다.
IDLE_STOP_S = 120.0


def _get_local(base, since):
    """트래커에서 상태 하나를 읽는다. 항적은 증분으로 받는다."""
    url = '%s/api/state?since=%d' % (base.rstrip('/'), since)
    req = urllib.request.Request(url, headers={'Cache-Control': 'no-store',
                                               'User-Agent': USER_AGENT})
    with urllib.request.urlopen(req, timeout=LOCAL_TIMEOUT) as r:
        return json.loads(r.read().decode('utf-8'))


# 🔴 User-Agent 를 반드시 우리 것으로 바꾼다. 기본값(`Python-urllib/3.x`)은
#    **Cloudflare 가 막는다** — 서버에 닿지도 못하고 `error code: 1010` 과
#    함께 403 이 돌아온다 (실측 2026-09-06). 키가 틀린 것처럼 보이는데
#    키와 아무 상관이 없어서, 모르면 한참 헤맨다.
USER_AGENT = 'drone01-livepush/1.0'


def _apply_pin(base, want):
    """웹에서 고른 수신 경로를 트래커에 전한다.

    🔴 이것이 서버 -> 트래커로 흐르는 **유일한** 값이고, 담기는 것은
       'USB' / 'ELRS' / 'auto' 셋뿐이다. 여기서 검사해 그 밖의 것은 버린다 —
       서버가 무엇을 돌려주든 이 프로세스가 트래커에 거는 요청은 세 가지로
       고정된다.

    🔴 FC 와는 무관하다. 트래커가 이미 듣고 있는 두 스트림 중 무엇을 화면에
       그릴지를 고르는 것뿐이고, 트래커는 여전히 소켓에 쓰는 코드가 0줄이다.

    실패해도 조용히 넘어간다 — 중계가 멈추면 안 된다.
    """
    if want not in ('USB', 'ELRS', 'auto'):
        return
    try:
        url = '%s/api/link?pin=%s' % (base.rstrip('/'), want)
        req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
        with urllib.request.urlopen(req, timeout=LOCAL_TIMEOUT):
            pass
    except Exception:
        pass


# 🔴 연결을 재사용한다 (2026-09-11). urlopen 은 POST 마다 TCP+TLS 를 새로
#    연다 — rim3 LTE 실측으로 왕복 **211ms** 였다. 0.1초 주기에서는 왕복이
#    주기보다 길어 루프가 쉬지 못하고, 실효가 10Hz 가 아니라 ~4.7Hz 가 된다.
#    keep-alive 로 재면 **104ms** 다 (같은 회선, 같은 시각).
_conn = {'c': None, 'host': None}


def _conn_get(to):
    """이 프로세스가 들고 있는 연결. 없으면 연다."""
    host = urllib.parse.urlsplit(to).netloc or to
    if _conn['c'] is None or _conn['host'] != host:
        _conn_close()
        _conn['c'] = http.client.HTTPSConnection(host, timeout=PUSH_TIMEOUT)
        _conn['host'] = host
    return _conn['c']


def _conn_close():
    if _conn['c'] is not None:
        try:
            _conn['c'].close()
        except Exception:
            pass
    _conn['c'] = None


def _push(to, key, payload):
    """서버로 올린다. 성공하면 서버 응답(dict), 실패하면 예외.

    🔴 연결이 끊겨 있으면 한 번만 다시 열고 재시도한다. 서버·중간 장비가
       idle 연결을 끊는 것은 정상이고, 그때마다 예외를 올리면 호출부가
       backoff 를 걸어 중계가 느려진다.
    """
    body = json.dumps(payload, separators=(',', ':')).encode('utf-8')
    headers = {'Content-Type': 'application/json',
               'User-Agent': USER_AGENT,
               'X-Live-Key': key}
    for attempt in (0, 1):
        try:
            c = _conn_get(to)
            c.request('POST', '/api/live/push', body=body, headers=headers)
            r = c.getresponse()
            raw = r.read().decode('utf-8') or '{}'
            if r.status >= 400:
                # HTTPError 로 올려야 호출부의 "키가 맞나?" 갈래가 그대로 산다.
                raise urllib.error.HTTPError(
                    to + '/api/live/push', r.status, r.reason, r.headers, None)
            return json.loads(raw)
        except urllib.error.HTTPError:
            raise
        except (http.client.HTTPException, OSError):
            _conn_close()
            if attempt:
                raise
    raise RuntimeError('unreachable')


def main():
    ap = argparse.ArgumentParser(
        description='라이브 상태를 drone01 웹으로 중계한다 (한 방향)')
    ap.add_argument('--from', dest='src',
                    default=os.environ.get('LIVE_LOCAL', 'http://127.0.0.1:4410'),
                    help='로컬 트래커 주소 (기본 http://127.0.0.1:4410)')
    ap.add_argument('--to', default=os.environ.get(
        'LIVE_PUSH_URL', 'https://drone01.bewe.co.kr'),
        help='랩서버 주소 (기본 https://drone01.bewe.co.kr)')
    ap.add_argument('--key', default=os.environ.get('LIVE_PUSH_KEY', ''),
                    help='밀어 올릴 때 쓰는 암호. 서버의 LIVE_PUSH_KEY 와 같아야 한다')
    ap.add_argument('--interval', type=float,
                    default=float(os.environ.get('LIVE_PUSH_INTERVAL',
                                                 DEFAULT_INTERVAL)),
                    help='올리는 주기(초). 기본 %.1f' % DEFAULT_INTERVAL)
    ap.add_argument('--name', default=os.environ.get('LIVE_PUSH_NAME',
                                                     socket.gethostname()),
                    help='어느 PC 가 올리는지. 화면에 뜬다 (기본 호스트명)')
    args = ap.parse_args()

    if not args.key:
        sys.exit('LIVE_PUSH_KEY 가 없다. 서버와 같은 값을 넣어라 '
                 '(~/.config/drone-live.env).')

    print('중계: %s → %s  (%.1f초마다, 이름 %s)'
          % (args.src, args.to, args.interval, args.name), flush=True)
    print('🔴 한 방향이다 — 서버에서 FC 로 가는 경로는 없다.', flush=True)

    since = 0
    backoff = 0.0
    warned_local = warned_push = False
    sent = 0
    last_live = time.monotonic()

    while True:
        t0 = time.monotonic()

        # ── 1. 로컬 트래커에서 읽는다 ──────────────────────────────
        try:
            st = _get_local(args.src, since)
            if warned_local:
                print('로컬 트래커 복구', flush=True)
                warned_local = False
        except Exception as e:
            if not warned_local:
                print('로컬 트래커를 못 읽는다 (%s) — 계속 시도한다' % e, flush=True)
                warned_local = True
            time.sleep(args.interval)
            continue

        # 기체가 오래 조용하면 올리지 않는다. 서버가 알아서 끊김으로 만든다.
        if st.get('live'):
            last_live = t0
        elif t0 - last_live > IDLE_STOP_S:
            time.sleep(args.interval)
            continue

        # ── 2. 서버로 올린다 ──────────────────────────────────────
        st['pusher'] = args.name
        try:
            resp = _push(args.to, args.key, st)
            sent += 1
            if warned_push:
                print('서버 복구 (%d번째)' % sent, flush=True)
                warned_push = False
            backoff = 0.0
            # 🔴 서버가 "나는 여기까지 받았다" 고 알려 준다. 그 다음부터 보낸다.
            #    서버가 재시작해 항적을 잃으면 0 을 돌려주고, 그러면 처음부터
            #    다시 보낸다 — 지도에 궤적이 통째로 빠지는 것을 막는다.
            nxt = resp.get('track_n')
            since = int(nxt) if isinstance(nxt, int) else st.get('track_n', since)
            # 웹에서 수신 경로를 골랐으면 응답에 실려 온다. 서버는 이것을 한
            # 번만 들려보내므로, 반영한 뒤 조종자가 여기 앞에서 직접 바꿔도
            # 웹이 덮어쓰지 않는다.
            if 'pin' in resp:
                _apply_pin(args.src, resp['pin'])
        except urllib.error.HTTPError as e:
            if not warned_push:
                print('서버가 거절했다 (%s %s) — 키가 맞나?'
                      % (e.code, e.reason), flush=True)
                warned_push = True
            backoff = min(BACKOFF_MAX, max(2.0, backoff * 2 or 2.0))
        except Exception as e:
            if not warned_push:
                print('서버로 못 올린다 (%s) — 인터넷이 없나? 계속 시도한다' % e,
                      flush=True)
                warned_push = True
            backoff = min(BACKOFF_MAX, max(2.0, backoff * 2 or 2.0))

        time.sleep(max(0.0, args.interval - (time.monotonic() - t0)) + backoff)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print('\n종료')
