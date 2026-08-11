#!/bin/sh
# 启动 bike-travel：server + web，后台运行，日志写 /tmp
# 端口取自 config/ports.env（默认 3000 / 5173），可建 config/ports.env.local 覆盖。
set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# ---- 加载端口配置（单一可信源）----
if [ -f "$ROOT/config/ports.env" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/config/ports.env"
fi
# 本地覆盖（不提交）
if [ -f "$ROOT/config/ports.env.local" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/config/ports.env.local"
fi
SERVER_PORT="${SERVER_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"

# 导出给子进程：server 读 SERVER_PORT/PORT，vite 读 WEB_PORT/SERVER_PORT
export SERVER_PORT WEB_PORT PORT="$SERVER_PORT"

echo "==> 启动 bike-travel (server :$SERVER_PORT, web :$WEB_PORT)..."
(npm run dev:server > /tmp/bike_server.log 2>&1 &)
(npm run dev:web > /tmp/bike_web.log 2>&1 &)

# 等一会儿让服务起来
sleep 4

HEALTH="$(curl -s -m5 "http://localhost:$SERVER_PORT/api/health" 2>/dev/null || echo '')"
if [ -n "$HEALTH" ]; then
  echo "    后端健康: $HEALTH"
else
  echo "    后端尚未就绪（仍在启动），稍后访问 http://localhost:$SERVER_PORT/api/health 确认"
fi
echo "    前端:     http://localhost:$WEB_PORT/"
echo "    日志:     /tmp/bike_server.log   /tmp/bike_web.log"
echo "==> 完毕。终止用: npm run stop"
