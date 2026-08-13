#!/usr/bin/env bash
set -euo pipefail

if curl --fail --silent http://127.0.0.1:10000/healthz >/dev/null 2>&1; then
  exit 0
fi

nohup env PYTHONPATH=radar_engine/src PORT=10000 python render_app.py \
  >/tmp/xuncha-radar.log 2>&1 &

for _ in $(seq 1 30); do
  if curl --fail --silent http://127.0.0.1:10000/healthz >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done

cat /tmp/xuncha-radar.log
exit 1
