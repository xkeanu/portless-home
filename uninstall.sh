#!/bin/sh
# Removes the portless-home LaunchAgent (macOS) or systemd user service (Linux),
# serve rule, and installed files.
set -eu

LABEL="sh.portless.home"
INSTALL_DIR="$HOME/.portless-home"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

OS="$(uname)"
case "$OS" in
	Darwin)
		launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
		rm -f "$PLIST"
		;;
	Linux)
		systemctl --user disable --now portless-home.service 2>/dev/null || true
		rm -f "$HOME/.config/systemd/user/portless-home.service"
		systemctl --user daemon-reload 2>/dev/null || true
		;;
	*) echo "Unsupported OS: $OS (macOS and Linux only)."; exit 1 ;;
esac

rm -rf "$INSTALL_DIR"
command -v tailscale >/dev/null 2>&1 && tailscale serve --https=443 off 2>/dev/null || true
echo "portless-home removed."
