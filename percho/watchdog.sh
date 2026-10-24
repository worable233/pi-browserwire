#!/bin/sh
# 让 composer.top 补丁在 Percho 升级后自己补回来。
#
#   设置 → 外观 → UI 插件 里的「批注条」依赖宿主补丁；Percho 每次升级都会把
#   app.asar 整个换掉，补丁随之消失。这个守护者每 30 分钟看一次，发现补丁没了
#   就重新打（锚点对不上就放弃并记日志，绝不留半截包）。
#
#   ./percho/watchdog.sh check       只检查一次（LaunchAgent 调的就是这个）
#   ./percho/watchdog.sh install     安装为登录项，登录时 + 每 30 分钟检查
#   ./percho/watchdog.sh uninstall   移除
set -eu

APP_ASAR="/Applications/Percho.app/Contents/Resources/app.asar"
LABEL="com.bw.perchopatch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
LOG="/tmp/percho-patch.log"

patched() { grep -aq "bw-patch:main-ipc start" "$APP_ASAR" 2>/dev/null; }

check() {
	[ -f "$APP_ASAR" ] || exit 0
	patched && exit 0
	echo "[$(date '+%F %T')] 补丁缺失（Percho 升级过？），重新打补丁" >>"$LOG"
	if ! python3 "$ROOT/percho/patch-percho.py" >>"$LOG" 2>&1; then
		echo "[$(date '+%F %T')] 锚点对不上，放弃（等手动处理）" >>"$LOG"
		exit 0
	fi
	cp "$APP_ASAR" "$APP_ASAR.bak-$(date +%Y%m%d%H%M%S)"
	mv /tmp/app-patched.asar "$APP_ASAR"
	echo "[$(date '+%F %T')] 已换入，重启 Percho 后生效" >>"$LOG"
}

install() {
	mkdir -p "$HOME/Library/LaunchAgents"
	cat >"$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$ROOT/percho/watchdog.sh</string><string>check</string></array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>1800</integer>
  <key>StandardErrorPath</key><string>/tmp/percho-watchdog.err</string>
</dict>
</plist>
PLIST_EOF
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$PLIST"
	echo "✓ 已安装登录项 $LABEL（每 30 分钟检查一次）"
}

uninstall() {
	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	rm -f "$PLIST"
	echo "✓ 已移除 $LABEL"
}

case "${1:-check}" in
check) check ;;
install) install ;;
uninstall) uninstall ;;
*) echo "用法: $0 [check|install|uninstall]" >&2; exit 2 ;;
esac
