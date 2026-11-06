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
#   ./tools/demo-launcher.sh --check      is the iPhone attached? (door status on mainnet)
#   ./tools/demo-launcher.sh --qr         write and open the iPhone QR
#   ./tools/demo-launcher.sh --key        copy the approver key for this vault
#   ./tools/demo-launcher.sh --start      start the demo (or the door, with --mainnet)
#
#   --mainnet   switch to the mainnet side: the donation door (donate.paydlux.com,
#               real money IN, no desk, no iPhone queue) and the same 4-step demo
#               running against the MAINNET vault. The bundle records the mode in
#               Resources/mode.txt, so "Paydlux Mainnet.app" needs no flags.
#               The door is safe as one button: it reads no private key, signs
#               nothing, and the vault still needs two signatures to move money.
#               --money prints what has been paid in (public ledger data),
#               --address copies the vault address.
#               The demo spends, so it is not one button: --wallet first proves the
#               agent account can pay, then a dialog names the cost (0.1 XLM per
#               loop, vault to our own payee account) and waits for "Run it".
#               There is still no button that sells on mainnet — that stays a
#               deliberate terminal step (npm run app:mainnet:sell).
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

cd "$REPO" || { osascript -e 'display alert "Paydlux" message "The Paydlux folder moved or this app was copied from another Mac. Rebuild it: npm run app:demo:build"' >/dev/null 2>&1; exit 1; }

# --- which product this app runs --------------------------------------------
# The demo (testnet, play money, spends the seller's money behind a human hold)
# and the donation door (mainnet, real money coming IN, holds no key and cannot
# spend anything) are separate processes on separate ports behind the same
# tunnel, with separate vault files. The bundle records which one it is; the
# command line can say so too (--mainnet / --demo).
MODE="$(cat "$BUNDLE_DIR/Resources/mode.txt" 2>/dev/null || echo demo)"
for a in "$@"; do
  case "$a" in --mainnet) MODE=mainnet ;; --demo) MODE=demo ;; esac
done

DESK=https://desk.paydlux.com
DEMO=https://demo.paydlux.com
DOOR=https://donate.paydlux.com
TUNNEL=paydlux-desk
LOG_DIR="$HOME/Library/Logs"
mkdir -p "$LOG_DIR"
TLOG="$LOG_DIR/paydlux-tunnel.log"
QR="$LOG_DIR/paydlux-qr.png"

if [ "$MODE" = mainnet ]; then
  VAULT=./paydlux-mainnet.json
  LOG="$LOG_DIR/paydlux-mainnet.log"
  NET_WORD="mainnet — real money"
else
  VAULT=./paydlux-vault.json
  LOG="$LOG_DIR/paydlux-demo.log"
  NET_WORD="testnet — play money"
fi
[ -f "$VAULT" ] || { osascript -e "display alert \"Paydlux vault file not found\" message \"Expected $VAULT in the Paydlux folder.\" as warning" >/dev/null 2>&1; exit 1; }

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
  local pub=""
  # The running desk is the authority when there is one. The donation door has
  # no desk at all, so fall back to the vault file: derive the PUBLIC address from
  # the stored seed locally and print only its 8 characters.
  if [ "$MODE" != mainnet ]; then
    pub=$(status_json | "$NODE" -e '
      let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
        try { process.stdout.write(JSON.parse(s).approver || ""); } catch { /* desk down */ }
      });')
  fi
  [ -z "$pub" ] && pub=$("$NODE" -e '
    const { Keypair } = require("@stellar/stellar-sdk");
    process.stdout.write(Keypair.fromSecret(
      JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).keys.approver).publicKey());
  ' "$VAULT" 2>/dev/null)
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
# --fail matters: when the origin behind Cloudflare is down, the tunnel answers
# with a 502 page and a plain curl call reports success. A check-up that says
# "answering" while the demo is dead is worse than one that says nothing.
url_up() { curl -sf -m 6 -o /dev/null "$1"; }

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

# ------------------------------------------------------------------ money
# What the donation door has actually taken in. This is public ledger data — the
# vault address is printed on the door's own page — and it is the first number an
# investor asks for, so the app answers it instead of making anyone open an
# explorer and count by hand.
money_report() {
  local vault
  vault=$("$NODE" -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof d.vault==="string"?d.vault:(d.vault&&d.vault.address)||"")' "$VAULT")
  [ -z "$vault" ] && { echo "the vault address is missing from $VAULT"; return 1; }
  curl -s -m 12 "https://horizon.stellar.org/accounts/$vault/payments?order=desc&limit=200" \
    | "$NODE" -e '
      let s = "";
      process.stdin.on("data", d => s += d).on("end", () => {
        let r; try { r = JSON.parse(s)._embedded.records; } catch { console.log("the ledger did not answer"); process.exit(1); }
        const vault = process.argv[1];
        const in_ = r.filter(p => p.type === "payment" && p.to === vault && p.successful);
        if (!in_.length) { console.log("Nothing has been paid into " + vault.slice(0, 12) + "… yet."); process.exit(0); }
        const total = in_.reduce((a, p) => a + Number(p.amount), 0);
        const last = in_[0];
        console.log(in_.length + " payment(s) in, " + total.toFixed(4) + " " + (p_asset(last)) + " total. Last one "
          + new Date(last.created_at).toISOString().slice(0, 16).replace("T", " ") + " UTC: "
          + "https://stellar.expert/explorer/public/tx/" + last.transaction_hash);
        function p_asset(p) { return p.type_i === 1 && p.asset_type === "native" ? "XLM" : (p.asset_code || "asset"); }
      });
    ' "$vault"
}

# One sentence: is the door up, and what has it taken? Exit 0 = live.
door_verdict() {
  local money; money=$(money_report)
  if door_running && url_up "$DOOR"; then
    echo "The donation door is live at $DOOR ($NET_WORD). $money"
    return 0
  fi
  echo "The donation door is not answering at $DOOR. $money"
  return 1
}

check_door() {
  local verdict rc=0
  verdict=$(door_verdict) || rc=$?
  echo "$verdict"
  [ -t 1 ] || alert "The donation door" "$verdict"
  return $rc
}

# ------------------------------------------------------------------ qr
# The zero-typing way to point the iPhone at this desk: the iPhone camera reads
# the code, the Paydlux app opens with the link already in it.
show_qr() {
  local key link note
  mkdir -p "$LOG_DIR"
  if [ "$MODE" = mainnet ] && ! mainnet_demo_running; then
    # The door is public and holds no key: its link is safe to print, and a phone
    # that scans it lands on the page where an agent pays us.
    link="$DOOR"
    note="This page is the donation door. Scanning it opens it on the phone; paying from there sends real money into the 2-of-2 vault."
  else
    key=$(portal_key) || return 1
    link="$DESK/phone/?k=$key"
    note="This link IS the approval gesture — anyone who scans it can approve or refuse payments. Scan it yourself, then close the picture."
    [ "$MODE" = mainnet ] && note="$note

This is the MAINNET desk: the iPhone must hold the mainnet approver key (the one that starts $(expected_key_hint)) or its signature will be refused."
  fi
  "$NODE" -e 'require("qrcode").toFile(process.argv[1], process.argv[2], { width: 900, margin: 2 }, e => process.exit(e ? 1 : 0))' "$QR" "$link" \
    || { alert "Could not draw the QR code" "The qrcode package is missing. In the project folder run: npm install" warning; return 1; }
  open -a Preview "$QR"
  alert "Scan this with a phone camera" "$note" warning
}

# The vault address onto the clipboard, for pasting into a wallet. Public.
copy_address() {
  local vault; vault=$("$NODE" -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(typeof d.vault==="string"?d.vault:(d.vault&&d.vault.address)||"")' "$VAULT")
  [ -n "$vault" ] || { alert "Could not read the vault address" "" warning; return 1; }
  printf '%s' "$vault" | pbcopy
  alert "The vault address is on the clipboard" "$vault

Money sent here lands in the 2-of-2 vault. It is printed on the donation page too, so copying it is not a secret — it is just shorter than typing 56 characters."
}

# ------------------------------------------------------------------ key
# The approver seed for the DEMO vault, onto the clipboard. The iPhone app's
# Re-add key screen takes a paste, so nothing has to be typed there either.
copy_key() {
  "$NODE" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).keys.approver)' "$VAULT" | pbcopy \
    || { alert "Could not copy the key" "" warning; return 1; }
  local hint which; hint=$(expected_key_hint)
  if [ "$MODE" = mainnet ]; then
    which="the MAINNET approver key (the donation door's vault, real money)"
  else
    which="the DEMO approver key (the testnet vault, play money)"
  fi
  alert "The key is on the clipboard" "This is $which.

On the iPhone: open Paydlux, tap the three dots, choose Re-add key, then paste into the S... box and press Store on this device.

This vault accepts the key that starts $hint — the iPhone shows the same 8 characters once the right key is stored.

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
  nohup "$NPX" tsx stellar/cli.ts demo >"$LOG" 2>&1 & disown
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

# --- the mainnet side: the donation door ------------------------------------
# The door only receives. It reads no private key, signs nothing, and verifies a
# payment against the public ledger before it serves anything, so starting it
# cannot spend the vault. That is why this app is allowed to be one button.
start_door() {
  if door_running && url_up "$DOOR"; then
    alert "The donation door is already running" "$(door_verdict)

Press OK to open the page."
    open "$DOOR"
    return 0
  fi
  if door_running; then
    # A door process is up but answering nothing — usually a stale one holding
    # port 4024. The CLI refuses to start over it, so clear it first.
    pkill -f "cli.ts donate" 2>/dev/null
    sleep 2
  fi
  ensure_tunnel || alert "The secure tunnel did not start" "donate.paydlux.com needs the Cloudflare tunnel named $TUNNEL. The log is at $TLOG." warning
  alert "Starting the donation door" "The door takes real money on mainnet into the 2-of-2 vault. It holds no key and cannot spend anything. Keep this window open."
  mkdir -p "$LOG_DIR"
  nohup "$NPX" tsx stellar/cli.ts donate --file paydlux-mainnet.json --tls >"$LOG" 2>&1 & disown
  for _ in $(seq 1 30); do url_up "$DOOR" && break; sleep 2; done
  if ! url_up "$DOOR"; then
    alert "The door did not come up" "donate.paydlux.com is still not answering after a minute. The log is at $LOG — press Restart the door, and if it fails again send that file to whoever set this up." warning
    return 1
  fi
  alert "The donation door is live" "$(door_verdict)"
  open "$DOOR"
}

restart_door() {
  pkill -f "cli.ts donate" 2>/dev/null
  sleep 2
  start_door
}

stop_door() {
  pkill -f "cli.ts donate" 2>/dev/null
  alert "The donation door is offline" "Nobody can pay us until it is started again. Nothing was spent — the door only ever receives. The demo is untouched."
}

# --- the mainnet side: the same demo, with real money -----------------------
# The four steps are identical to the testnet demo — a browser gets a throwaway
# agent key, signs a request, the desk parks it, the iPhone signs, the ledger
# settles — except the vault is the mainnet one and the settlement is real.
#
# What it costs, stated out loud before it starts: each completed loop pays the
# demo price OUT of the vault and INTO our own payee account. Both ends belong to
# us, so nothing is lost, but money does leave the vault and the ledger keeps the
# record forever. The price is deliberately small.
MAINNET_DEMO_PRICE=0.1

mainnet_demo_running() { pgrep -f "cli.ts demo --file paydlux-mainnet.json" >/dev/null; }

# Which vault the public demo URLs are serving right now. The two demos share
# desk.paydlux.com and demo.paydlux.com, so "which one is live" is a question the
# check-up has to answer — a founder who thinks they are showing play money while
# the real vault is live (or the other way round) is in for a surprise.
demo_kind() {
  mainnet_demo_running && { echo mainnet; return; }
  demo_running && { echo testnet; return; }
  echo none
}

# The agent account: it signs the demo payments and pays the transaction fee, so
# it has to exist on the ledger with a little XLM in it. Unfunded, every demo
# payment fails at the ledger, which is the worst possible moment to find out.
demo_wallet() {
  "$NODE" -e '
    const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    process.stdout.write(require("@stellar/stellar-sdk").Keypair.fromSecret(d.keys.agent).publicKey());
  ' "$VAULT" 2>/dev/null
}

wallet_verdict() {
  local addr bal
  addr=$(demo_wallet)
  [ -n "$addr" ] || { echo "the demo wallet address is missing from $VAULT"; return 1; }
  bal=$(curl -s -m 12 "https://horizon.stellar.org/accounts/$addr" | "$NODE" -e '
    let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
      let j; try { j = JSON.parse(s); } catch { console.log("unreadable"); process.exit(1); }
      if (j.detail) { console.log("NOT funded — every demo payment will be refused by the ledger"); process.exit(1); }
      const xlm = (j.balances || []).find(b => b.asset_type === "native");
      const free = Number(xlm.balance) - (1 + 0.5 * (j.subentry_count || 0));
      console.log(xlm.balance + " XLM (" + free.toFixed(2) + " spendable)");
      process.exit(free >= 0.2 ? 0 : 1);
    });')
  local rc=$?
  echo "$addr: $bal"
  return $rc
}

confirm() { # confirm <title> <body> — 0 = the owner pressed the go button
  [ -n "${PAYDLUX_QUIET:-}" ] && return 1
  osascript - "$1" - "$2" <<'EOF' >/dev/null 2>&1
on run argv
  display dialog (item 2 of argv) with title (item 1 of argv) buttons {"Cancel", "Run it"} default button "Run it"
end run
EOF
}

start_mainnet_demo() {
  local kind; kind=$(demo_kind)
  if [ "$kind" = mainnet ] && url_up "$DEMO/"; then
    alert "The mainnet demo is already running" "It is live at $DEMO. Press OK to open the tabs."
    open_tabs
    return 0
  fi
  local wallet rc=0; wallet=$(wallet_verdict) || rc=$?
  if [ "$rc" -ne 0 ]; then
    alert "The demo wallet cannot pay yet" "The agent account that signs demo payments needs XLM for the fee:
$wallet

Top it up from the vault (two signatures, money stays ours) with:
  npm run app:mainnet:fund" warning
    return 1
  fi
  if ! confirm "Run the demo on MAINNET" "This is the real vault, not the testnet one.

Each completed loop pays $MAINNET_DEMO_PRICE XLM out of the vault into our own payee account. Both ends are ours, so nothing is lost, but the payment is real and stays on the ledger forever.
$([ "$kind" = testnet ] && printf '\nThe testnet demo is running on the same address and will be stopped.')"; then
    return 0
  fi
  ensure_tunnel || alert "The secure tunnel did not start" "desk.paydlux.com and demo.paydlux.com need the Cloudflare tunnel named $TUNNEL. The log is at $TLOG." warning
  osascript -e 'display alert "Starting the mainnet demo" message "The approval desk and the demo page come up on the MAINNET vault. Keep this window open."' >/dev/null 2>&1
  mkdir -p "$LOG_DIR"
  # `demo` clears whatever Paydlux holds its three ports, lifts a spent daily
  # budget, and leaves the donation door (4024) alone.
  nohup "$NPX" tsx stellar/cli.ts demo --file paydlux-mainnet.json --price "$MAINNET_DEMO_PRICE" --no-open >>"$LOG" 2>&1 & disown
  for _ in $(seq 1 30); do url_up "$DESK/healthz" && url_up "$DEMO/" && break; sleep 2; done
  if ! url_up "$DESK/healthz" || ! url_up "$DEMO/"; then
    alert "The mainnet demo did not come up" "$DEMO is still not answering after a minute. The log is at $LOG." warning
    return 1
  fi
  open_tabs
  local hint verdict rc2=0
  hint=$(expected_key_hint)
  verdict=$(phone_verdict) || rc2=$?
  if [ "$rc2" -ne 0 ]; then
    alert "One thing first: the iPhone" "$verdict

For THIS demo the iPhone must hold the MAINNET approver key — the one that starts $hint. Press OK and the QR code opens on this screen." warning
    show_qr
  else
    alert "The mainnet demo is live" "$DEMO is running against the MAINNET vault. Each loop pays $MAINNET_DEMO_PRICE XLM from the vault into our own payee account. Keep the Paydlux app open on the iPhone screen."
  fi
}

stop_mainnet_demo() {
  mainnet_demo_running || { alert "Nothing to stop" "The mainnet demo is not running."; return 0; }
  pkill -f "cli.ts demo --file paydlux-mainnet.json" 2>/dev/null
  alert "The mainnet demo is offline" "$DEMO and the approval desk are down. The donation door is untouched, and nothing was spent by stopping this."
}

# The pre-meeting safety net: drive all four steps without a second person and
# without the iPhone, and print the ledger hash. If this settles, the demo works;
# if it fails, it fails here at 0.1 XLM instead of in front of a funder.
prove_loop() {
  mainnet_demo_running || {
    alert "The mainnet demo is not running" "This test drives the live demo page. Press 'Run the mainnet demo' first."
    return 1
  }
  confirm "Prove the loop end to end" "This runs the whole four-step loop by itself — including the signature your iPhone would normally make — and pays $MAINNET_DEMO_PRICE XLM from the vault into our own payee account.

Run it before a meeting. If it prints a ledger link, the demo will work." || return 0
  local out rc link
  out=$("$NPX" tsx stellar/mainnet-loop-check.ts --yes 2>&1); rc=$?
  link=$(printf '%s\n' "$out" | grep -o 'https://stellar.expert[^ ]*' | tail -1)
  if [ "$rc" -eq 0 ] && [ -n "$link" ]; then
    printf '%s' "$link" | pbcopy
    alert "The mainnet loop works" "A real payment settled on the ledger and the buyer got its data.

The ledger link is on your clipboard:
$link"
  else
    alert "The loop did not settle" "$(printf '%s\n' "$out" | tail -6)

The log is at $LOG." warning
  fi
}

# ------------------------------------------------------------------ doctor
# Everything in one plain-language page: what is up, what is not, what to press.
doctor() {
  local hint body rc=0
  hint=$(expected_key_hint)
  if [ "$MODE" = mainnet ]; then
    local money wallet kind verdict phone_rc=0; money=$(money_report); wallet=$(wallet_verdict)
    kind=$(demo_kind)
    verdict=""
    [ "$kind" = mainnet ] && { verdict=$(phone_verdict); phone_rc=$?; }
    body=$(printf '%s\n' \
      "tunnel: $(tunnel_running && echo running || echo 'NOT running')" \
      "donation door: $(door_running && url_up "$DOOR" && echo 'live at '"$DOOR" || echo 'NOT answering')" \
      "money in: $money" \
      "" \
      "mainnet demo (real money): $([ "$kind" = mainnet ] && echo "live at $DEMO, $MAINNET_DEMO_PRICE XLM per loop" || echo not running)" \
      "testnet demo (play money): $([ "$kind" = testnet ] && echo "live at $DEMO — it shares that address with the mainnet demo" || echo not running)" \
      "demo wallet: $wallet" \
      "$verdict" \
      "" \
      "This vault accepts the approver key that starts $hint.")
    # Two different failures, two different fixes. Saying "start the door" when
    # the door is fine and only the phone is missing sends the founder to the
    # wrong button.
    local door_ok=0
    door_running && url_up "$DOOR" && door_ok=1
    [ "$door_ok" -eq 1 ] || { echo "-> the door is down: press 'Start the donation door'."; rc=1; }
    [ "$phone_rc" -eq 0 ] || { echo "-> the iPhone is not attached: open Paydlux on the phone and pull to refresh, then press 'Is the iPhone connected?'."; rc=1; }
  else
    local verdict; verdict=$(phone_verdict); rc=$?
    body=$(printf '%s\n' \
      "tunnel: $(tunnel_running && echo running || echo 'NOT running')" \
      "desk: $(url_up "$DESK/healthz" && echo answering || echo 'not answering')" \
      "demo page: $(url_up "$DEMO/" && echo answering || echo 'not answering')" \
      "donation door: $(door_running && echo 'running (mainnet)' || echo not)" \
      "$([ "$(demo_kind)" = mainnet ] && echo 'WARNING: the demo running on demo.paydlux.com is the MAINNET one — it spends real money. Stop it in Paydlux Mainnet.app.' || true)" \
      "" \
      "$verdict" \
      "" \
      "This vault accepts the approver key that starts $hint.")
    [ "$rc" -eq 0 ] || echo "-> press 'Show the iPhone link (QR)', then scan it with the iPhone camera."
  fi
  echo "$body"
  [ -t 1 ] || alert "Paydlux check-up" "$body"
  return $rc
}

# ------------------------------------------------------------------ menu
# Flags may come in any order (--mainnet is a mode, not an action), so scan every
# argument and act on the first action flag found.
for a in "$@"; do
  case "$a" in
    --doctor) doctor; exit 0 ;;
    --check)  if [ "$MODE" = mainnet ]; then check_door; else check_phone; fi; exit $? ;;
    --qr)     show_qr; exit 0 ;;
    --key)    copy_key; exit 0 ;;
    --address) copy_address; exit 0 ;;
    --money)  money_report; exit 0 ;;
    --wallet) wallet_verdict; exit $? ;;
    --mainnet-demo) start_mainnet_demo; exit 0 ;;
    --prove) prove_loop; exit 0 ;;
    --start)  if [ "$MODE" = mainnet ]; then start_door; else start_demo; fi; exit 0 ;;
  esac
done

if [ "$MODE" = mainnet ]; then
  # The mainnet app is narrower than the demo app on purpose. The door only
  # receives, so it is safe as one button. The demo spends, so it asks twice: the
  # wallet has to be able to pay, and the owner has to press "Run it" on a dialog
  # that says out loud what the money does.
  while true; do
    state=$(door_running && url_up "$DOOR" && echo "door live at $DOOR" || echo "door down")
    kind=$(demo_kind)
    [ "$kind" = mainnet ] && state="$state, mainnet demo UP"
    [ "$kind" = testnet ] && state="$state, testnet demo up (same address)"
    if ! choice=$(osascript - "$state" 2>>"$LOG" <<'EOF'
on run argv
  choose from list {"Start the donation door", "Run the mainnet demo (real money)", "Self-test the whole loop (0.1 XLM)", "Check-up: what is wrong?", "Is the iPhone connected?", "How much has been paid in?", "Show the payment QR code", "Copy the vault address", "Copy the mainnet key to the clipboard", "Open the donation page", "Restart the donation door", "Stop the donation door", "Stop the mainnet demo", "Quit"} with prompt "Paydlux mainnet — " & item 1 of argv & ". REAL MONEY." default items {"Check-up: what is wrong?"}
end run
EOF
    ); then
      alert "The menu did not open" "macOS refused to show the list. The reason is in $LOG. The door itself is unaffected — the same buttons work from a terminal in the Paydlux folder: ./tools/demo-launcher.sh --mainnet" warning
      exit 1
    fi
    [ -z "$choice" ] || [ "$choice" = "false" ] && exit 0
    case "$choice" in
      "Start the donation door") start_door ;;
      "Run the mainnet demo (real money)") start_mainnet_demo ;;
      "Self-test the whole loop (0.1 XLM)") prove_loop ;;
      "Check-up: what is wrong?") doctor ;;
      "Is the iPhone connected?") check_phone ;;
      "How much has been paid in?") check_door ;;
      "Show the payment QR code") show_qr ;;
      "Copy the vault address") copy_address ;;
      "Copy the mainnet key to the clipboard") copy_key ;;
      "Open the donation page") open "$DOOR" ;;
      "Restart the donation door") restart_door ;;
      "Stop the donation door") stop_door ;;
      "Stop the mainnet demo") stop_mainnet_demo ;;
      "Quit") exit 0 ;;
    esac
  done
fi

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
