#!/bin/sh
# portless-home in the menu bar, for xbar (xbarapp.com) and SwiftBar
# (swiftbar.app): your running portless apps with health dots and tailnet
# links, plus start/stop for the login service. Copy or symlink this file
# into your plugin folder; the `15s` in the name is the refresh interval.
#
# Needs only curl: the server renders the menu at GET /api/menubar (see
# menubar.mjs), so nothing here depends on node being on the menu bar app's
# minimal PATH.
#
# <xbar.title>portless-home</xbar.title>
# <xbar.version>v1.0</xbar.version>
# <xbar.author>portless-home contributors</xbar.author>
# <xbar.author.github>xkeanu</xbar.author.github>
# <xbar.desc>Running portless apps with tailnet links, and start/stop for the portless-home service.</xbar.desc>
# <xbar.dependencies>portless-home,curl</xbar.dependencies>
# <xbar.abouturl>https://github.com/xkeanu/portless-home</xbar.abouturl>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
set -eu
PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

# The login service: install.sh's LaunchAgent, or the one `brew services` writes.
AGENTS="$HOME/Library/LaunchAgents"
LABEL="sh.portless.home"
PLIST="$AGENTS/$LABEL.plist"
if [ ! -f "$PLIST" ]; then
	LABEL="homebrew.mxcl.portless-home"
	PLIST="$AGENTS/$LABEL.plist"
	[ -f "$PLIST" ] || PLIST=""
fi

# install.sh writes the chosen PORT into the plist; anything else means 5995.
PORT=5995
if [ -n "$PLIST" ] && command -v plutil >/dev/null 2>&1; then
	PORT="$(plutil -extract EnvironmentVariables.PORT raw -o - "$PLIST" 2>/dev/null || echo 5995)"
fi
URL="${PORTLESS_HOME_URL:-http://127.0.0.1:$PORT}"

# Clicking Start/Stop/Restart re-runs this script with the action as $1.
DOMAIN="gui/$(id -u)"
case "${1:-}" in
	start)
		launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || true
		launchctl kickstart "$DOMAIN/$LABEL"
		exit
		;;
	stop) launchctl bootout "$DOMAIN/$LABEL"; exit ;;
	restart) launchctl kickstart -k "$DOMAIN/$LABEL"; exit ;;
esac

# xbar runs items with shell=, SwiftBar with bash=; SwiftBar exports SWIFTBAR.
RUN=shell
[ -n "${SWIFTBAR:-}" ] && RUN=bash
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
action() { echo "$1 | $RUN=\"$SELF\" param1=$2 terminal=false refresh=true"; }

if MENU="$(curl -sf --max-time 3 "${URL%/}/api/menubar")"; then
	printf '%s\n' "$MENU"
	if [ -n "$PLIST" ]; then
		echo "---"
		action "Restart service" restart
		action "Stop service" stop
	fi
else
	echo "⌂ – | color=gray"
	echo "---"
	echo "portless-home is not running | disabled=true color=gray"
	if [ -n "$PLIST" ]; then
		action "Start service" start
	else
		echo "No login service found — ./install.sh or brew services start portless-home | disabled=true color=gray"
	fi
fi
echo "---"
echo "Refresh | refresh=true"
