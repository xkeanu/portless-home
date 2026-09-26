#!/bin/sh
# portless-home installer (macOS: launchd / Linux: systemd user service).
# Installs the home-page server as a login service and pins it to your
# tailnet device URL via `tailscale serve`. Run from the repo directory.
# --no-autostart starts the server now but skips start-at-login (and
# crash restarts); rerun without the flag to switch back.
set -eu

AUTOSTART=1
for ARG in "$@"; do
	case "$ARG" in
		--no-autostart) AUTOSTART=0 ;;
		*) echo "Unknown option: $ARG"; echo "Usage: ./install.sh [--no-autostart]"; exit 1 ;;
	esac
done

LABEL="sh.portless.home"
INSTALL_DIR="$HOME/.portless-home"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-5995}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# A checkout needs its contributor build before it can be installed. Check every
# input before creating the install directory or touching an existing service.
for FILE in server.mjs render.mjs i18n.mjs peers.mjs menubar.mjs live.mjs launch.mjs \
	dist/ui-server.mjs dist/ui.js dist/ui.css; do
	if [ ! -f "$SCRIPT_DIR/$FILE" ]; then
		echo "Missing $FILE. Run npm ci && npm run build before installing from a checkout."
		exit 1
	fi
done

OS="$(uname)"
case "$OS" in
	Darwin) ;;
	Linux) command -v systemctl >/dev/null 2>&1 || { echo "systemd required (systemctl not found)."; exit 1; } ;;
	*) echo "Unsupported OS: $OS (macOS and Linux only; on Windows run install.ps1)."; exit 1 ;;
esac
NODE_BIN="$(command -v node)" || { echo "node not found on PATH."; exit 1; }

mkdir -p "$INSTALL_DIR/dist"
cp "$SCRIPT_DIR/server.mjs" "$SCRIPT_DIR/render.mjs" "$SCRIPT_DIR/i18n.mjs" "$SCRIPT_DIR/peers.mjs" "$SCRIPT_DIR/menubar.mjs" "$SCRIPT_DIR/live.mjs" "$SCRIPT_DIR/launch.mjs" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/dist/ui-server.mjs" "$SCRIPT_DIR/dist/ui.js" "$SCRIPT_DIR/dist/ui.css" "$INSTALL_DIR/dist/"

if [ "$AUTOSTART" = 1 ]; then AT_LOAD=true; RESTART=always; else AT_LOAD=false; RESTART=no; fi

if [ "$OS" = "Darwin" ]; then
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
	<key>RunAtLoad</key><$AT_LOAD/>
	<key>KeepAlive</key><$AT_LOAD/>
	<key>StandardErrorPath</key><string>$INSTALL_DIR/service.log</string>
</dict>
</plist>
EOF

	launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
	launchctl bootstrap "gui/$(id -u)" "$PLIST"
	# With RunAtLoad off, bootstrap loads the job without starting it.
	[ "$AUTOSTART" = 1 ] || launchctl kickstart "gui/$(id -u)/$LABEL"
else
	UNIT_DIR="$HOME/.config/systemd/user"
	mkdir -p "$UNIT_DIR"
	cat > "$UNIT_DIR/portless-home.service" <<UNIT
[Unit]
Description=portless-home tailnet directory page
After=network.target

[Service]
ExecStart="$NODE_BIN" "$INSTALL_DIR/server.mjs"
Environment=PORT=$PORT
Restart=$RESTART
StandardError=append:$INSTALL_DIR/service.log

[Install]
WantedBy=default.target
UNIT

	systemctl --user daemon-reload || { echo "systemd user session unavailable — log in on the console or run: loginctl enable-linger $USER"; exit 1; }
	if [ "$AUTOSTART" = 1 ]; then
		systemctl --user enable portless-home.service
	else
		systemctl --user disable portless-home.service 2>/dev/null || true
	fi
	systemctl --user restart portless-home.service
fi
sleep 1
curl -sf -o /dev/null "http://127.0.0.1:$PORT/" || { echo "Server did not start; see $INSTALL_DIR/service.log"; exit 1; }
echo "Home page running on 127.0.0.1:$PORT"
[ "$AUTOSTART" = 1 ] || echo "Start-at-login off (--no-autostart); rerun ./install.sh to turn it on."

if command -v tailscale >/dev/null 2>&1 && tailscale status >/dev/null 2>&1; then
	tailscale serve --bg --https=443 "http://127.0.0.1:$PORT" >/dev/null
	DEVICE_URL="https://$(tailscale status --json | sed -n 's/.*"DNSName": "\([^"]*\)\.".*/\1/p' | head -1)"
	echo "Pinned to $DEVICE_URL (persists across reboots)."
	echo "Portless apps will now land on :8443, :8444, ..."
else
	echo "Tailscale not running — skipped the serve rule. When it's up, run:"
	echo "  tailscale serve --bg --https=443 http://127.0.0.1:$PORT"
fi
