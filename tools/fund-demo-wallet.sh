#!/bin/bash
# Top up the demo's agent wallet from the vault.
#
# The agent account is the one that signs demo payments and pays the transaction
# fee. If it has never been funded, every demo payment dies at the ledger — the
# worst possible moment to discover it, in front of an investor. This script is
# what the launcher's "the demo wallet cannot pay yet" alert points at.
#
# What it does: one 2-of-2 transaction from the vault into our own agent account.
# Both ends belong to us, so nothing leaves the family; the ledger keeps the
# record forever. It asks before spending, and it never prints a private key.
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR" || exit 1
FILE="${1:-paydlux-mainnet.json}"
AMOUNT="${2:-2}"
NPX="$(command -v npx || echo /opt/homebrew/bin/npx)"
NODE="$(dirname "$NPX")/node"; [ -x "$NODE" ] || NODE=node

[ -f "$FILE" ] || { echo "no $FILE here"; exit 1; }

ADDR="$("$NODE" -e '
  const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  process.stdout.write(require("@stellar/stellar-sdk").Keypair.fromSecret(d.keys.agent).publicKey());
' "$FILE")"
[ -n "$ADDR" ] || { echo "could not read the agent key from $FILE"; exit 1; }

echo
echo "demo wallet (the account that signs demo payments): $ADDR"
echo "topping it up with $AMOUNT XLM from the vault. Both accounts are ours."
echo
read -r -p "Send it? [y/N] " go
[ "$go" = "y" ] || [ "$go" = "Y" ] || { echo "not sent."; exit 0; }

"$NPX" tsx stellar/cli.ts withdraw --file "$FILE" --to "$ADDR" --amount "$AMOUNT"
