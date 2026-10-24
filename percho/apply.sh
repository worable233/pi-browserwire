#!/usr/bin/env bash
# 把打好的 app.asar 换进去：等 Percho 退出 → 备份 → 替换 → 重新打开。
# 用法：./percho/apply.sh            （前台：立刻等退出）
#       ./percho/apply.sh --detach   （后台守护：Percho 一退出就替换）
set -euo pipefail

APP="/Applications/Percho.app"
RES="$APP/Contents/Resources"
NEW="/tmp/app-patched.asar"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -f "$NEW" ] || python3 "$HERE/patch-percho.py"

if [ "${1:-}" = "--detach" ]; then
  nohup bash "$0" >/tmp/percho-patch.log 2>&1 &
  disown || true
  echo "已挂后台守护：退出 Percho 后自动打补丁并重新打开（日志 /tmp/percho-patch.log）"
  exit 0
fi

while pgrep -f "Percho.app/Contents/MacOS/Percho" >/dev/null 2>&1; do sleep 2; done

BK="$RES/app.asar.bak-$(date +%Y%m%d%H%M%S)"
cp "$RES/app.asar" "$BK"
mv "$NEW" "$RES/app.asar"
echo "$(date '+%H:%M:%S') patched（备份：$BK）"
open -a "$APP"
