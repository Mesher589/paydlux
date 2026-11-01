// One-time: make a throwaway funding wallet for the mainnet setup.
// The seed is written to a local 0600 file and NEVER printed. Only the public
// address is printed, because that is the only thing that needs to leave here.
import { Keypair } from "@stellar/stellar-sdk";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";

const file = resolve(process.cwd(), "paydlux-fund-wallet.json");
if (existsSync(file)) {
  const d = JSON.parse(readFileSync(file, "utf8"));
  console.log("already exists — the same wallet:\n  " + d.address);
  process.exit(0);
}

const kp = Keypair.random();
writeFileSync(file, JSON.stringify({
  createdAt: new Date().toISOString(),
  purpose: "pays account-creation costs for `paydlux setup --mainnet`. inert afterwards: the vault's master key is switched off in the transaction that creates it, so this wallet can never touch the vault.",
  address: kp.publicKey(),
  seed: kp.secret(),
}, null, 2));
chmodSync(file, 0o600);

console.log(`
funding wallet created (throwaway, stays on this machine)

  address   ${kp.publicKey()}
  file      ${file}   (0600)

Send to that address:
  8 XLM   (~$1.35 at 0.17 USDT/XLM) for ledger rent.
  Nothing else — the USDC goes to the vault, not to this wallet.
`);
