#!/bin/sh
# Builds Homeport.app into macos/dist/ (or $1). Needs only the Xcode
# Command Line Tools. The bundle is ad-hoc signed: built locally, so no
# Gatekeeper quarantine; a Developer ID signature is a later step.
# SWIFT_BUILD_FLAGS adds flags to `swift build` (Homebrew passes
# --disable-sandbox).
set -eu
cd "$(dirname "$0")"

# shellcheck disable=SC2086 # word-splitting the flags is the point
swift build -c release ${SWIFT_BUILD_FLAGS:-}
BIN="$(swift build -c release ${SWIFT_BUILD_FLAGS:-} --show-bin-path)/Homeport"

APP="${1:-dist}/Homeport.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Homeport"
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
codesign --force --sign - "$APP"
echo "Built $APP"
