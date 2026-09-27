#!/usr/bin/env bash
# 서버에서 실행한다:  ssh ku@<서버> 'cd ~/DRONE && ./web/deploy/deploy.sh'
#
# 🔴 kill / fuser -k 를 쓰지 마라. Restart= 때문에 TERM 을 보내면 유닛이 죽은 채 남는다.
set -euo pipefail

cd "$(dirname "$0")/../.."          # 리포 루트
OLD=$(git rev-parse --short HEAD)
git fetch --quiet
git pull --ff-only
NEW=$(git rev-parse --short HEAD)
[ "$OLD" = "$NEW" ] && echo "변화 없음 ($NEW)" || echo "$OLD → $NEW"

sudo systemctl restart lab-drone01
systemctl --user restart drone-playback
sleep 2
systemctl is-active lab-drone01
systemctl --user is-active drone-playback

# 곧바로 물으면 502 가 난다 — 캐시를 다시 굽는 동안은 listen 전이다.
echo -n "healthcheck "
for i in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://drone01.bewe.co.kr/api/health" || true)
  [ "$code" = "200" ] && break
  echo -n "."; sleep 3
done
echo " $code"
[ "$code" = "200" ] || { systemctl status lab-drone01 --no-pager -n 10 || true; tail -20 /home/ku/drone01-data/server.log || true; exit 1; }
curl -s https://drone01.bewe.co.kr/api/health; echo
