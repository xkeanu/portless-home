#!/bin/sh
# portless-home installer (macOS).
# Installs the home-page server as a login LaunchAgent and pins it to your
# tailnet device URL via `tailscale serve`. Run from the repo directory.
set -eu

LABEL="sh.portless.home"
INSTALL_DIR="$HOME/.portless-home"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-5995}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

[ "$(uname)" = "Darwin" ] || { echo "macOS only (launchd). PRs for systemd welcome."; exit 1; }
NODE_BIN="$(command -v node)" || { echo "node not found on PATH."; exit 1; }

mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/server.mjs" "$INSTALL_DIR/server.mjs"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>$LABEL</string>
	<key>ProgramArguments</key>
	<array>
		<string>$NODE_BIN</string>
		<string>$INSTALL_DIR/server.mjs</string>
	</array>
	<key>EnvironmentVariables</key>
	<dict><key>PORT</key><string>$PORT</string></dict>
	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardErrorPath</key><string>$INSTALL_DIR/service.log</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" || { echo "Server did not start; see $INSTALL_DIR/service.log"; exit 1; }
echo "Home page running on 127.0.0.1:$PORT"

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
	tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null
	DEVICE_URL="https://$(tailscale status --json | sed -n 's/.*"DNSName": "\([^"]*\)\.".*/\1/p' | head -1)"
	echo "Pinned to $DEVICE_URL (persists across reboots)."
	echo "Portless apps will now land on :8443, :8444, ..."
else
	echo "Tailscale not running — skipped the serve rule. When it's up, run:"
	echo "  tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
fi
