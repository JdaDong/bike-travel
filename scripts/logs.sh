#!/bin/sh
# 实时查看 bike-travel 前后端日志（Ctrl+C 退出），每行带 [server]/[web] 标识
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SLOG=/tmp/bike_server.log
WLOG=/tmp/bike_web.log

# 端口来自配置（仅用于提示，不影响 tail）
if [ -f "$ROOT/config/ports.env" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/config/ports.env"
fi
if [ -f "$ROOT/config/ports.env.local" ]; then
  # shellcheck disable=SC1091
  . "$ROOT/config/ports.env.local"
fi

G='\033[0;32m'  # server 绿
C='\033[0;36m'  # web 青
N='\033[0m'

echo "==> 跟踪日志（Ctrl+C 退出），每行带标识："
echo "    ${G}[server]${N} $SLOG  (port ${SERVER_PORT:-3000})"
echo "    ${C}[web]${N}    $WLOG  (port ${WEB_PORT:-5173})"
echo

cleanup() {
  [ -n "$SPID" ] && kill "$SPID" 2>/dev/null
  [ -n "$WPID" ] && kill "$WPID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

if [ ! -f "$SLOG" ] && [ ! -f "$WLOG" ]; then
  echo "    [提示] 两个日志都还不存在，请先 npm run start"
  exit 0
fi

# -F 跟随且文件缺失时持续重试（web 后启动也能自动接上）；逐行加标识前缀
# 用 sed -u 行缓冲，确保管道/重定向时也能实时刷新（终端下天然行缓冲）
tail -F "$SLOG" 2>/dev/null | sed -u "s|^|${G}[server]${N} |" & SPID=$!
tail -F "$WLOG" 2>/dev/null | sed -u "s|^|${C}[web]${N}    |" & WPID=$!

wait
