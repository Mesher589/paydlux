#!/bin/bash
# Build the Mac button apps — the things you double-click before a funder meeting.
#
#   npm run app:demo                      ->  ~/Desktop/Paydlux Demo.app
#   npm run app:mainnet                   ->  ~/Desktop/Paydlux Mainnet.app
#   npm run app:demo -- --to /somewhere
#
# Why a real .app instead of a terminal command: on stage, a red error in a
# terminal is the product failing in front of the investor. The two errors that
# actually happened were "port 4022 is already in use" and "today's budget is
# already spent" — both are handled by `paydlux demo`, and this bundle is that
# same command with an icon, a progress note, and buttons that open the right
# tabs.
#
# Two apps, one script, because the two products are different risks:
#   Paydlux Demo    — testnet, play money, spends the seller's money behind a
#                     human hold, and needs the iPhone to be pointed at the desk.
#   Paydlux Mainnet — the donation door. Real money coming IN. The door reads no
#                     private key, signs nothing and cannot spend the vault, so a
#                     single button is a safe thing to give a non-programmer.
# The bundle records which one it is in Resources/mode.txt; tools/demo-launcher.sh
# reads it and shows the matching buttons.
#
# The bundle holds NO keys and starts nothing new. The logic lives in
# tools/demo-launcher.sh (a readable, shell-checkable file); this script only
# assembles the .app around it and records where the repo is on this machine.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$HOME/Desktop"
MODE=demo
while [ $# -gt 0 ]; do
  case "$1" in
    --to) OUT_DIR="$2"; shift 2 ;;
    --mainnet) MODE=mainnet; shift ;;
    --demo) MODE=demo; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ "$MODE" = mainnet ]; then
  APP_NAME="Paydlux Mainnet"
  BUNDLE_ID="com.paydlux.mainnet"
else
  APP_NAME="Paydlux Demo"
  BUNDLE_ID="com.paydlux.demo"
fi

APP="$OUT_DIR/$APP_NAME.app"
BIN="$APP/Contents/MacOS"
RES="$APP/Contents/Resources"
rm -rf "$APP"
mkdir -p "$BIN" "$RES"

# --- the executable: a copy of the launcher, so the app survives the repo
#     being moved to another folder on the same machine -----------------------
cp "$REPO/tools/demo-launcher.sh" "$BIN/$APP_NAME"
chmod +x "$BIN/$APP_NAME"
printf '%s' "$REPO" > "$RES/repo.txt"
printf '%s' "$MODE" > "$RES/mode.txt"
# Finder gives an app a minimal PATH (/usr/bin:/bin:...), which has no node/npx.
# Record the absolute path from the shell that built the app.
NPX_BIN="$(command -v npx || true)"
[ -n "$NPX_BIN" ] && printf '%s' "$NPX_BIN" > "$RES/npx.txt" \
  || echo "warning: npx not found on PATH; the app will search the usual locations"

# --- icon: reuse the phone app's, so the demo and the approver look related ---
ICON_SRC="$REPO/phone-app/icon-512.png"
if [ -f "$ICON_SRC" ] && command -v iconutil >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  ICONSET="$APP/icon.iconset"
  mkdir -p "$ICONSET"
  for s in 16 32 64 128 256 512; do
    sips -z "$s" "$s" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s * 2))
    if [ "$d" -le 1024 ]; then sips -z "$d" "$d" "$ICON_SRC" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true; fi
  done
  iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns" 2>/dev/null || true
  rm -rf "$ICONSET"
fi

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$APP_NAME</string>
  <key>CFBundleDisplayName</key><string>$APP_NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleExecutable</key><string>$APP_NAME</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.finance</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST

# A locally built bundle is not quarantined; clear it anyway so Finder never asks.
xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true

echo "built: $APP"
echo "double-click it, or:  open \"$APP\""
