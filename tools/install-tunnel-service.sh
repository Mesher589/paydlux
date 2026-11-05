#!/bin/bash
# Install the Paydlux public tunnel as a launchd service.
#
# Why: stellar/tunnel.ts makes the app that spawns cloudflared kill it on exit
# (an orphaned tunnel = a public desk nobody is watching). That is right for a
# laptop run and wrong for a public surface: when the demo app stopped, the
# shared tunnel stopped with it, and donate.paydlux.com — the MAINNET donation
# door, where real people send real USDC — went 530 with it.
#
# With the tunnel as its own supervised service, apps always find it already
# running (tunnelRunning() in stellar/tunnel.ts) and reuse it. They never spawn
# it, so they never kill it. If it dies, launchd brings it back in seconds.
set -euo pipefail

TUNNEL="${PAYDLUX_TUNNEL:-paydlux-desk}"
CF="$(command -v cloudflared || echo /opt/homebrew/bin/cloudflared)"
[ -x "$CF" ] || { echo "cloudflared not found — brew install cloudflared"; exit 1; }

LABEL="com.paydlux.tunnel"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/paydlux-tunnel.log"
mkdir -p "$HOME/Library/LaunchAgents" "$(dirname "$LOG")"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$CF</string>
    <string>tunnel</string>
    <string>run</string>
    <string>$TUNNEL</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer>
</dict>
</plist>
PLIST

# Replace any cloudflared an app spawned, so exactly one connector is running.
for pid in $(pgrep -f "cloudflared tunnel run $TUNNEL" 2>/dev/null || true); do
  echo "stopping app-spawned cloudflared pid $pid"
  kill "$pid" 2>/dev/null || true
done
sleep 2

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

for i in $(seq 1 20); do
  if curl -s -m 6 -o /dev/null https://desk.paydlux.com/healthz; then
    echo "tunnel service is up (launchd: $LABEL, log: $LOG)"
    echo "apps will now reuse it and never kill it"
    exit 0
  fi
  sleep 3
done
echo "the tunnel did not answer within 60s — check $LOG"
exit 1
