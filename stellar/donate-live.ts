#!/usr/bin/env npx tsx
// End-to-end through the PUBLIC donation URL, with a real ledger in the middle.
//
// This is the stranger test, run against ourselves: ask donate.paydlux.com for
// an order, pay it from OUR vault (2-of-2, so it goes through the same signing
// path a buyer's phone would drive), then ask the public server to confirm.
// The server's only witness is Horizon — nothing here tells it the payment
// happened except the hash.
//
//   npx tsx stellar/donate-live.ts [https://donate.paydlux.com] [vault-file]
//
// The vault file has to match the network the door is on. Pointing a testnet
// vault at the mainnet door fails with op_no_destination, because the payee
// address the door names does not exist on the test ledger — an error message
// that reads like a broken door when the test itself is on the wrong network.
import { Account, Asset, Keypair, Memo, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { existsSync, readFileSync } from "node:fs";
import { passphrase, type Network } from "./vault.ts";

const BASE = process.argv[2] ?? "https://donate.paydlux.com";
const FILE = process.argv[3] ?? "paydlux-vault.json";
if (!existsSync(FILE)) {
  console.error(`no vault file at ${FILE}. For the mainnet door use: paydlux-mainnet.json`);
  process.exit(1);
}
const data = JSON.parse(readFileSync(FILE, "utf8"));
const network = (data.network ?? "testnet") as Network;
const horizon = network === "public" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";

const log = (s: string) => console.log("•", s);
const bad = (m: string): never => { console.error("\n\x1b[31m" + m + "\x1b[0m\n"); process.exit(1); };

async function main() {
  log(`asking ${BASE} for an order`);
  // Bind the order to OUR vault. The door then refuses a payment from anyone
  // else — the check that stops one stranger paying for another's order and
  // collecting the goods.
  const ask = await fetch(BASE + "/donate", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault: data.vault }) });
  const terms: any = await ask.json();
  if (ask.status !== 402 || !terms.order) bad(`expected 402 + order, got ${ask.status}: ${JSON.stringify(terms)}`);
  // Say which network each side is on BEFORE trying to pay. A testnet vault
  // paying a mainnet payee fails as op_no_destination, which looks like a
  // broken door and is really the wrong vault file.
  const doorNet = String(terms.network ?? "").replace("stellar:", "");
  if (doorNet && doorNet !== network) {
    bad(`network mismatch: ${BASE} is on ${doorNet} but ${FILE} is a ${network} vault.
  Pass the matching vault file as the second argument.`);
  }
  log(`402 — order ${terms.order}, memo ${terms.memo}, pay ${terms.maxAmountRequired} ${terms.token?.code} to ${terms.payTo.slice(0, 8)}…`);

  // Poll once before paying: the page does this, and it must NOT mint a new order.
  const poll = await (await fetch(`${BASE}/donate?order=${terms.order}`)).json();
  if (poll.order !== terms.order || poll.paid !== false) bad(`pre-payment poll was wrong: ${JSON.stringify(poll)}`);
  log(`poll before paying: ${poll.paid === false ? "202 paid:false, same order id" : "UNEXPECTED " + JSON.stringify(poll)}`);

  // Pay it from our own vault. Two signatures, because that is what the vault
  // requires — the same 2-of-2 a buyer's phone completes.
  const principal = Keypair.fromSecret(data.keys.principal);
  const approver = data.keys.approver ? Keypair.fromSecret(data.keys.approver) : null;
  if (!approver) bad("this machine holds only one human key; run the buyer side on the machine with both.");
  const src: any = await (await fetch(`${horizon}/accounts/${data.vault}`)).json();
  const tx = new TransactionBuilder(new Account(data.vault, src.sequence),
    { fee: "100", networkPassphrase: passphrase(network) })
    .addOperation(Operation.payment({
      destination: terms.payTo,
      asset: terms.token?.issuer ? new Asset(terms.token.code, terms.token.issuer) : Asset.native(),
      amount: terms.maxAmountRequired,
    }))
    .addMemo(Memo.text(terms.memo))
    .setTimeout(120).build();
  tx.sign(principal); tx.sign(approver!);
  const sub = await (await fetch(`${horizon}/transactions`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "tx=" + encodeURIComponent(tx.toXDR()),
  })).json();
  if (sub.hash) log(`ledger accepted it: ${sub.hash}`);
  else bad(`ledger refused: ${JSON.stringify(sub.extras ?? sub)}`);

  // Now the public server decides. It has no idea we paid; it reads Horizon.
  const conf = await (await fetch(`${BASE}/donate?order=${terms.order}&tx=${sub.hash}`)).json();
  if (!conf.data) bad(`the door refused its own real payment: ${conf.error} — ${conf.reason}`);
  log(`served: ${String(conf.data).slice(0, 80)}…`);
  log(`proof: tx ${conf.proof?.tx?.slice(0, 16)}… ledger #${conf.proof?.ledger} at ${conf.proof?.paidAt}`);
  log(`verify without trusting us: ${conf.proof?.verify}`);

  // The same hash must not buy a second order.
  const ask2 = await (await fetch(BASE + "/donate", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ vault: data.vault }) })).json();
  const again = await (await fetch(`${BASE}/donate?order=${ask2.order}&tx=${sub.hash}`)).json();
  log(`same tx, a different order: ${again.error ?? "SERVED — BUG"}`);
  if (again.data) bad("one payment bought two orders");

  console.log("\n\x1b[32mthe public donation door works end to end against the real ledger\x1b[0m\n");
}
main().catch((e) => bad("crashed: " + (e?.message ?? e)));
