#!/bin/sh
# 重启 bike-travel：先 stop 再 start（端口均取自 config/ports.env）
ROOT="$(cd "$(dirname "$0")" && pwd)"
"$ROOT/stop.sh"
sleep 1
"$ROOT/start.sh"
