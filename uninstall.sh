#!/bin/sh
# Removes the portless-home LaunchAgent, serve rule, and installed files.
set -eu

LABEL="sh.portless.home"
INSTALL_DIR="$HOME/.portless-home"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
rm -rf "$INSTALL_DIR"
command -v tailscale >/dev/null 2>&1 && tailscale serve --https=443 off 2>/dev/null || true
echo "portless-home removed."
