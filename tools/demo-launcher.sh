#!/bin/bash
# Paydlux demo launcher — buttons, no typing.
#
# The owner is not a programmer and a demo is a live performance: nobody should
# be typing shell commands while an investor waits. This script is what the
# "Paydlux Demo" app on the Desktop runs. Every action is a button, every answer
# is plain language, and the checks run before the founder is on a call.
#
# The failure this exists for: the demo page parks a payment, the seller's iPhone
# shows nothing, and the room thinks the product is broken. There are exactly
# three ways that happens, all of them real:
#
#   1. the secure tunnel is not running, so desk.paydlux.com answers nothing and
#      the iPhone's queue is simply unreachable;
#   2. the iPhone is pointed at the desk from a previous run — a different link,
#      usually the mainnet donation-door one — so the parked payment lands in a
#      queue nobody is looking at;
#   3. the iPhone holds an approver key this vault does not know, so the payment
#      shows up but the signature is refused.
#
# The Doctor button names which one it is. "Show the iPhone link" fixes (2) with
# a QR code the iPhone camera reads — no typing. "Copy the demo key" fixes (3):
# the seed goes to the clipboard and the app's Re-add key screen takes a paste.
#
#   ./tools/demo-launcher.sh              the menu
#   ./tools/demo-launcher.sh --doctor     plain-language diagnosis, no dialogs
#   ./tools/demo-launcher.sh --check      is the iPhone attached?
#   ./tools/demo-launcher.sh --qr         write and open the iPhone QR
#   ./tools/demo-launcher.sh --key        copy the demo approver key
#   ./tools/demo-launcher.sh --start      start the demo
#
# Secrets: the approver seed and the portal key live in ./paydlux-vault.json
# (0600). Nothing here prints them. The seed goes to the clipboard only when a
# button asks for it, and the dialog says so out loud.

set -u
# --- locate the repo this runs against --------------------------------------
# Run from the repo: the script's own folder's parent. Run from the .app: the
# path the builder recorded, because inside the bundle there is no vault file and
# no node_modules. A leading --flag is never a directory.
BUNDLE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO=""
[ -f "$BUNDLE_DIR/Resources/repo.txt" ] && REPO="$(cat "$BUNDLE_DIR/Resources/repo.txt" 2>/dev/null || true)"
DIR="${1:-}"
case "$DIR" in -*) DIR="" ;; esac
[ -n "$DIR" ] && REPO="$DIR"
[ -d "$REPO" ] || REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Finder gives a launched app a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin): no
# node, no cloudflared. The builder records the absolute npx it was built with;
# node and npm live in the same folder.
NPX="$(cat "$BUNDLE_DIR/Resources/npx.txt" 2>/dev/null || true)"
if [ -z "$NPX" ] || [ ! -x "$NPX" ]; then
  for c in /opt/homebrew/bin/npx /usr/local/bin/npx "$HOME/.local/bin/npx"; do
    [ -x "$c" ] && NPX="$c" && break
  done
fi
[ -n "$NPX" ] && PATH="$(dirname "$NPX"):/opt/homebrew/bin:$PATH"
NODE="$(dirname "$NPX")/node"; [ -x "$NODE" ] || NODE="node"

cd "$REPO" || { osascript -e 'display alert "Paydlux demo" message "The Paydlux folder moved or this app was copied from another Mac. Rebuild it: npm run app:demo:build"' >/dev/null 2>&1; exit 1; }
VAULT=./paydlux-vault.json
[ -f "$VAULT" ] || { osascript -e 'display alert "Paydlux vault file not found" message "Expected paydlux-vault.json in the Paydlux folder." as warning' >/dev/null 2>&1; exit 1; }

DESK=https://desk.paydlux.com
DEMO=https://demo.paydlux.com
TUNNEL=paydlux-desk
LOG_DIR="$HOME/Library/Logs"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/paydlux-demo.log"
TLOG="$LOG_DIR/paydlux-tunnel.log"
QR="$LOG_DIR/paydlux-phone-qr.png"

alert() { # alert <title> <body> [warning]
  # PAYDLUX_QUIET=1 keeps the dialogs off the screen — used by the checks in
  # this repo's tests, and handy when someone wants the answer in text only.
  [ -n "${PAYDLUX_QUIET:-}" ] && return 0
  osascript - "$1" - "$2" - "${3:-}" <<'EOF'
on run argv
  set t to item 1 of argv
  set b to item 2 of argv
  if (count of argv) > 2 and (item 3 of argv) is "warning" then
    display alert t message b as warning
  else
    display alert t message b
  end if
end run
EOF
}

# ------------------------------------------------------------------ parts
# The portal key from the vault file: used to build the iPhone link and to read
# the desk's own /status. Never echoed.
portal_key() { "$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).desk.portalKey)' "$VAULT"; }

# Which approver key this desk accepts, in the same 8 characters the iPhone app
# shows under "Add your approver key". The desk answers with the G... address it
# will accept; the app's summary is the first 8 hex digits of that address's raw
# key, which is the address minus its version byte — decoded here in plain
# base32 so no crypto library has to be loaded on a machine that is mid-demo.
# Comparing the two by eye tells a wrong key from a sleeping phone in seconds.
expected_key_hint() {
  local pub
  pub=$(status_json | "$NODE" -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      try { process.stdout.write(JSON.parse(s).approver || ""); } catch { /* desk down */ }
    });')
  [ -z "$pub" ] && return 0
  "$NODE" -e '
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const a = process.argv[1];
    let bits = 0, val = 0, out = [];
    for (const c of a) {
      const v = A.indexOf(c);
      if (v < 0) process.exit(0);
      val = ((val << 5) | v) >>> 0; bits += 5;
      if (bits >= 8) { bits -= 8; out.push((val >>> bits) & 0xff); }
    }
    // out[0] is the version byte (ed25519 = 6 << 3); the key starts after it.
    process.stdout.write(out.slice(1, 5).map(b => b.toString(16).padStart(2, "0")).join(""));
  ' "$pub" 2>/dev/null
}

demo_running()   { pgrep -f "stellar/cli.ts demo" >/dev/null || pgrep -f "cli.ts sell.*--showcase" >/dev/null; }
door_running()   { pgrep -f "cli.ts donate" >/dev/null; }
tunnel_running() { pgrep -f "cloudflared tunnel run $TUNNEL" >/dev/null; }
url_up() { curl -s -m 6 -o /dev/null "$1"; }

# The named tunnel is not a launchd service on this Mac, so a reboot or a closed
# terminal takes the public URLs down with it. Start it if it is missing.
ensure_tunnel() {
  tunnel_running && return 0
  mkdir -p "$LOG_DIR"
  ( cloudflared tunnel run "$TUNNEL" >"$TLOG" 2>&1 & )
  for _ in 1 2 3 4 5 6 7 8 9 10; do tunnel_running && url_up "$DESK/healthz" && return 0; sleep 1; done
  tunnel_running
}

# ------------------------------------------------------------------ status
status_json() {
  local key; key=$(portal_key) || return 1
  curl -s -m 8 "$DESK/status?k=$key"
}

# One plain-language sentence about the iPhone and this desk. Exit 0 = attached.
phone_verdict() {
  local json
  json=$(status_json) || { echo "the desk did not answer the check"; return 2; }
  [ -n "$json" ] || { echo "the desk is not reachable at $DESK"; return 2; }
  "$NODE" -e '
    let s; try { s = JSON.parse(process.argv[1]); } catch { console.log("the desk answered something unreadable"); process.exit(2); }
    if (!s.ok) { console.log("the desk refused the check"); process.exit(2); }
    const seen = s.phoneSeenSecondsAgo, q = s.pending + s.awaitingPhone;
    if (seen === null)
      console.log("No iPhone has talked to this desk since it started, so the parked payment is waiting where nobody can see it. Open the Paydlux app on the iPhone — it only checks the queue while it is on screen. If it still says nothing, scan the QR code on this Mac with the iPhone camera.");
    else if (seen < 120)
      console.log("The iPhone is connected — it checked the queue " + seen + " seconds ago. " + (q ? q + " payment(s) are waiting for it right now. Keep the app open on the screen while you demo." : "Nothing is waiting for it right now."));
    else
      console.log("The iPhone last talked to this desk " + Math.round(seen / 60) + " minutes ago. The app only polls while it is open, so first: open Paydlux and pull to refresh. If it shows nothing, the phone is pointed at an older desk (often the mainnet one) — scan the QR code on this Mac to point it here.");
    process.exit(seen !== null && seen < 120 ? 0 : 1);
  ' "$json"
}

check_phone() {
  local verdict rc=0
  verdict=$(phone_verdict) || rc=$?
  echo "$verdict"
  [ -t 1 ] || alert "The iPhone and the desk" "$verdict"
  return $rc
}

# ------------------------------------------------------------------ qr
# The zero-typing way to point the iPhone at this desk: the iPhone camera reads
# the code, the Paydlux app opens with the link already in it.
show_qr() {
  local key link
  key=$(portal_key) || return 1
  link="$DESK/phone/?k=$key"
  mkdir -p "$LOG_DIR"
  "$NODE" -e 'require("qrcode").toFile(process.argv[1], process.argv[2], { width: 900, margin: 2 }, e => process.exit(e ? 1 : 0))' "$QR" "$link" \
    || { alert "Could not draw the QR code" "The qrcode package is missing. In the project folder run: npm install" warning; return 1; }
  open -a Preview "$QR"
  alert "Scan this with the iPhone camera" "The Paydlux app opens with the link already filled in.

This link IS the approval gesture — anyone who scans it can approve or refuse payments. Scan it yourself, then close the picture." warning
}

# ------------------------------------------------------------------ key
# The approver seed for the DEMO vault, onto the clipboard. The iPhone app's
# Re-add key screen takes a paste, so nothing has to be typed there either.
copy_key() {
  "$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).keys.approver)' "$VAULT" | pbcopy \
    || { alert "Could not copy the key" "" warning; return 1; }
  local hint; hint=$(expected_key_hint)
  alert "The demo key is on the clipboard" "On the iPhone: open Paydlux, tap the three dots, choose Re-add key, then paste into the S... box and press Store on this device.

This desk accepts the key that starts $hint — the iPhone shows the same 8 characters once the right key is stored.

The clipboard now holds a spending key. Do not paste it anywhere else, and copy something harmless when you are done." warning
}

# ------------------------------------------------------------------ process
start_demo() {
  if door_running; then
    alert "The donation door is running" "The mainnet donation door is up on donate.paydlux.com. The demo does not touch it — it runs beside the demo on its own address, and it keeps taking real donations."
  fi
  ensure_tunnel || alert "The secure tunnel did not start" "desk.paydlux.com and demo.paydlux.com need the Cloudflare tunnel named $TUNNEL. The log is at $TLOG." warning
  osascript -e 'display alert "Starting the demo" message "The approval desk, the demo page and the tunnel come up in a few seconds. Keep this window open."'
  # `demo` reuses a live demo, clears leftover Paydlux processes on its own
  # three ports, lifts a spent daily budget, and deliberately leaves the
  # donation door alone.
  mkdir -p "$LOG_DIR"
  "$NPX" tsx stellar/cli.ts demo >"$LOG" 2>&1 &
  for _ in $(seq 1 30); do url_up "$DESK/healthz" && url_up "$DEMO/" && break; sleep 2; done
  if ! url_up "$DESK/healthz" || ! url_up "$DEMO/"; then
    alert "The demo did not come up" "The desk or the demo page is still not answering after a minute. The log is at $LOG — press Restart, and if it fails again send that file to whoever set this up." warning
    return 1
  fi
  open_tabs
  # The most common demo failure, checked before the investor arrives.
  local verdict rc=0
  verdict=$(phone_verdict) || rc=$?
  if [ "$rc" -ne 0 ]; then
    alert "One thing first: the iPhone" "$verdict

Press OK and the QR code opens on this screen." warning
    show_qr
  fi
}

open_tabs() {
  local key; key=$(portal_key)
  open "$DEMO/"
  open "$DESK/?k=$key"
  alert "Demo is up" "Demo page: pay from another computer and stop at step 4 — that is the iPhone's turn.
Approval desk: the tab that just opened shows exactly what the iPhone sees."
}

restart_demo() {
  pkill -f "stellar/cli.ts demo" 2>/dev/null
  pkill -f "cli.ts sell.*--showcase" 2>/dev/null
  sleep 2
  start_demo
}

stop_demo() {
  pkill -f "stellar/cli.ts demo" 2>/dev/null
  pkill -f "cli.ts sell.*--showcase" 2>/dev/null
  alert "Demo stopped" "The demo page and the approval desk are offline. The donation door is untouched. Money cannot move while they are down."
}

# ------------------------------------------------------------------ doctor
# Everything in one plain-language page: what is up, what is not, what to press.
doctor() {
  local hint verdict rc body
  hint=$(expected_key_hint)
  verdict=$(phone_verdict); rc=$?
  body=$(printf '%s\n' \
    "tunnel: $(tunnel_running && echo running || echo 'NOT running')" \
    "desk: $(url_up "$DESK/healthz" && echo answering || echo 'not answering')" \
    "demo page: $(url_up "$DEMO/" && echo answering || echo 'not answering')" \
    "donation door: $(door_running && echo 'running (mainnet)' || echo not)" \
    "" \
    "$verdict" \
    "" \
    "This vault accepts the approver key that starts $hint.")
  echo "$body"
  [ "$rc" -eq 0 ] || echo "-> press 'Show the iPhone link (QR)', then scan it with the iPhone camera."
  [ -t 1 ] || alert "Paydlux check-up" "$body"
  return $rc
}

# ------------------------------------------------------------------ menu
case "${1:-}" in
  --doctor) doctor; exit 0 ;;
  --check)  check_phone; exit $? ;;
  --qr)     show_qr; exit 0 ;;
  --key)    copy_key; exit 0 ;;
  --start)  start_demo; exit 0 ;;
esac

while true; do
  state=$(url_up "$DESK/healthz" && url_up "$DEMO/" && echo "up" || echo "down")
  # The menu is a Standard Additions list. Two things learned the hard way:
  # `without multiple selection` is not valid AppleScript — the script died with
  # a syntax error before any window appeared, so the app looked like it opened
  # and instantly quit — and a silent exit on failure is indistinguishable from
  # a crash, so an osascript failure now raises an alert that says so.
  # No "tell System Events to activate" here: that asks the user for Apple Events
  # permission on a demo app, which is worse than a list that may sit behind a
  # window.
  if ! choice=$(osascript - "$state" 2>>"$LOG" <<'EOF'
on run argv
  choose from list {"Start the demo", "Check-up: what is wrong?", "Is the iPhone connected?", "Show the iPhone link (QR code)", "Copy the demo key to the clipboard", "Open the demo page and the desk", "Restart the demo", "Stop the demo", "Quit"} with prompt "Paydlux demo — the public URLs are " & item 1 of argv & "." default items {"Check-up: what is wrong?"}
end run
EOF
  ); then
    alert "The menu did not open" "macOS refused to show the list. The reason is in $LOG. The demo itself is unaffected — it is still running, and the same buttons work from a terminal in the Paydlux folder: ./tools/demo-launcher.sh" warning
    exit 1
  fi
  # Cancel returns the word "false"; an empty answer means the same thing.
  [ -z "$choice" ] || [ "$choice" = "false" ] && exit 0
  case "$choice" in
    "Start the demo") start_demo ;;
    "Check-up: what is wrong?") doctor ;;
    "Is the iPhone connected?") check_phone ;;
    "Show the iPhone link (QR code)") show_qr ;;
    "Copy the demo key to the clipboard") copy_key ;;
    "Open the demo page and the desk") open_tabs ;;
    "Restart the demo") restart_demo ;;
    "Stop the demo") stop_demo ;;
    "Quit") exit 0 ;;
  esac
done
