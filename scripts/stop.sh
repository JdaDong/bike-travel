#!/bin/sh
# 终止 bike-travel：按 config/ports.env 的端口杀进程，再兜底按进程名清理，最后确认端口已释放
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ---- 加载端口配置（与 start 保持一致）----
if [ -f "$ROOT/config/ports.env" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/config/ports.env"
fi
if [ -f "$ROOT/config/ports.env.local" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/config/ports.env.local"
fi
SERVER_PORT="${SERVER_PORT:-3000}"
WEB_PORT="${WEB_PORT:-5173}"

echo "==> 终止 bike-travel (server :$SERVER_PORT, web :$WEB_PORT) ..."

# 1) 按端口杀
for port in "$SERVER_PORT" "$WEB_PORT"; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "    关闭端口 $port: $pids"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
done

# 2) 兜底按进程名清理（tsx watch / vite / 入口文件）
pkill -9 -f "tsx watch" 2>/dev/null || true
pkill -9 -f "vite" 2>/dev/null || true
pkill -9 -f "packages/server/src/index.ts" 2>/dev/null || true

# 3) 等端口释放
sleep 2

# 4) 重检：若端口仍被占，再次强杀
stuck=0
for port in "$SERVER_PORT" "$WEB_PORT"; do
  pids="$(lsof -ti tcp:"$port" 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "    [重试] 端口 $port 仍占用，强杀: $pids"
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
    stuck=1
  fi
done
[ "$stuck" -eq 1 ] && sleep 1

# 5) 最终确认（以端口是否释放为准，避免半死进程误报）
remaining="$(lsof -ti tcp:"$SERVER_PORT" -ti tcp:"$WEB_PORT" 2>/dev/null || true)"
if [ -n "$remaining" ]; then
  echo "    [警告] 以下端口仍被占用: $remaining"
else
  echo "    后端(:$SERVER_PORT) 与 前端(:$WEB_PORT) 均已停止"
fi
echo "==> 完毕"
