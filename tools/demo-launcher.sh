#!/bin/bash
# The executable inside "Paydlux Demo.app". Written as a normal file (not a
# heredoc inside a builder) so it can be read, edited and shell-checked on its
# own. The only thing the bundle adds is Contents/Resources/repo.txt, which
# holds the path to the Paydlux folder on this machine.
#
# What it does, in order:
#   1. If the desk port is already held by Paydlux, do NOT start a second one —
#      offer the tabs, or stop the old one. This is the failure that happened in
#      front of a funder: "port 4022 is already in use by another Paydlux".
#   2. Otherwise run `paydlux demo`, which lifts a spent daily budget and then
#      starts the real seller (same mandate, same desk, same phone signature).
#   3. Wait until the desk actually answers, then open the two tabs.
#
# It holds no keys. The portal key is read from the vault file at run time and
# only ever passed to `open`, never printed.
set -u

PORT=4022
LINK_DEMO="https://demo.paydlux.com"
LINK_DESK="https://desk.paydlux.com"
VAULT="paydlux-vault.json"

# --- locate the bundle and the repo it was built for -------------------------
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cat "$APP_DIR/Resources/repo.txt" 2>/dev/null || true)"
# A Finder-launched app gets a minimal PATH, so `npx` is usually not findable.
# The builder records the absolute path it was built with; fall back to the
# usual install locations if that file is stale.
NPX="$(cat "$APP_DIR/Resources/npx.txt" 2>/dev/null || true)"
if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then
  for c in /opt/homebrew/bin/npx /usr/local/bin/npx "$HOME/.local/bin/npx"; do
    [ -x "$c" ] && NPX="$c" && break
  done
fi
LOG="$HOME/Library/Logs/paydlux-demo.log"

alert() { osascript -e "display alert \"$1\" message \"$2\"" >/dev/null 2>&1 || true; }
say()   { osascript -e "display notification \"$1\" with title \"Paydlux demo\"" >/dev/null 2>&1 || true; }

if [ -z "$REPO" ] || [ ! -d "$REPO" ]; then
  alert "Paydlux demo" "The Paydlux folder moved or this app was copied from another Mac. Rebuild it: npm run app:demo"
  exit 1
fi
cd "$REPO" || { alert "Paydlux demo" "Cannot open $REPO"; exit 1; }
if [ ! -f "$VAULT" ]; then
  alert "Paydlux demo" "No vault file in $REPO. Run: paydlux setup"
  exit 1
fi

# --- the portal key: what makes the approvals link yours --------------------
# Same PATH problem as above: node is resolved from npx's own directory.
NODE="$(dirname "$NPX")/node"
[ -x "$NODE" ] || NODE="node"
K="$("$NODE" -e 'try{const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(d.desk&&d.desk.portalKey?d.desk.portalKey:"")}catch(e){}' "$VAULT" 2>/dev/null)"

# --- already running? ------------------------------------------------------
PID_ON_PORT="$(lsof -nP -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null | head -1)"
if [ -n "$PID_ON_PORT" ]; then
  CHOICE="$(osascript -e 'display dialog "Already running. The tabs you need open in a second." buttons {"Open demo page","Open approvals","Stop demo","Cancel"} default button "Open demo page" with title "Paydlux demo"' 2>/dev/null)"
  case "$CHOICE" in
    *"demo page"*)  open "$LINK_DEMO" ;;
    *approvals*)    if [ -n "$K" ]; then open "$LINK_DESK/phone/?k=$K"; else open "$LINK_DESK"; fi ;;
    *Stop*)
      # Kill by port, not by name: the process is `npx tsx stellar/cli.ts …`,
      # and a name pattern that misses it leaves a zombie desk holding the port.
      [ -n "$PID_ON_PORT" ] && kill "$PID_ON_PORT" 2>/dev/null || true
      pkill -f "stellar/cli.ts demo" 2>/dev/null || true
      pkill -f "stellar/cli.ts sell" 2>/dev/null || true
      say "stopped."
      ;;
  esac
  exit 0
fi

# --- start it --------------------------------------------------------------
if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then
  alert "Paydlux demo" "Node's npx was not found. Install Node, then rebuild: npm run app:demo"
  exit 1
fi
mkdir -p "$HOME/Library/Logs"
say "starting the desk…"
nohup "$NPX" tsx stellar/cli.ts demo >"$LOG" 2>&1 &
DEMO_PID=$!

# Wait for the desk to answer over TLS. Until then nothing on screen would
# change, and 30 silent seconds in front of an investor reads as a broken demo.
READY=0
for _ in $(seq 1 40); do
  sleep 1.5
  if curl -s -o /dev/null --max-time 3 "https://desk.paydlux.com/healthz" 2>/dev/null; then READY=1; break; fi
  if ! kill -0 "$DEMO_PID" 2>/dev/null; then DEAD=1; break; fi
done

if [ "${DEAD:-0}" = 1 ]; then
  TAIL="$(tail -8 "$LOG" 2>/dev/null | head -c 900)"
  alert "Paydlux demo could not start" "$TAIL"
  exit 1
fi
if [ "$READY" != 1 ]; then
  say "started locally, but desk.paydlux.com is not answering — check the internet"
fi

open "$LINK_DEMO"
if [ -n "$K" ]; then open "$LINK_DESK/phone/?k=$K"; fi
say "ready. Press Run the loop on the demo page."
