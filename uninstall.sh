#!/bin/sh
# Removes the homeport LaunchAgent (macOS) or systemd user service (Linux),
# serve rule, and installed files.
set -eu

LABEL="sh.homeport"
INSTALL_DIR="$HOME/.homeport"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

OS="$(uname)"
case "$OS" in
	Darwin)
		launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
		rm -f "$PLIST"
		;;
	Linux)
		systemctl --user disable --now homeport.service 2>/dev/null || true
		rm -f "$HOME/.config/systemd/user/homeport.service"
		systemctl --user daemon-reload 2>/dev/null || true
		;;
	*) echo "Unsupported OS: $OS (macOS and Linux only; on Windows run uninstall.ps1)."; exit 1 ;;
esac

rm -rf "$INSTALL_DIR"
command -v tailscale >/dev/null 2>&1 && tailscale serve --https=443 off 2>/dev/null || true
echo "homeport removed."
