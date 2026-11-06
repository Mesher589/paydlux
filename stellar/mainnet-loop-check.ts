// Prove the whole Paydlux loop works on MAINNET before a meeting, without
// needing a second person or the iPhone in hand.
//
// It drives the exact same four steps a funder's browser drives:
//   1. GET the showcase route            -> HTTP 402 with the price
//   2. make a throwaway key, get vouched  -> the seller's agent identity
//   3. sign the REQUEST, park it          -> the desk queues it
//   4. sign the challenge with the approver key (the iPhone's job) -> settled
//   5. ask again                          -> the payload plus the ledger hash
//
// Without --yes it stops after step 3: the request is parked, nothing is signed,
// nothing is spent. With --yes it completes the loop, which pays the demo price
// out of the vault into our own payee account. Real money, both ends ours.
//
//   npm run loop:check                     park only — nothing signed, nothing spent
//   npx tsx stellar/mainnet-loop-check.ts --yes    complete the loop (costs the price)
import { Keypair, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const DEMO = "https://demo.paydlux.com";
const DESK = "https://desk.paydlux.com";
const ROUTE = "/demo/data";
const FILE = process.argv.find((a: string) => a.startsWith("--file="))?.slice(7) ?? "paydlux-mainnet.json";

async function main() {
  const go = process.argv.includes("--yes");
  const path = resolve(process.cwd(), FILE);
  if (!existsSync(path)) throw new Error(`no ${FILE} here`);
  const data = JSON.parse(readFileSync(path, "utf8"));
  if ((data.network ?? "testnet") === "testnet") {
    throw new Error(`${FILE} is a testnet vault. This tool proves the MAINNET loop — use the demo app for testnet.`);
  }
  const portalKey = String(data.desk?.portalKey ?? "");
  if (!portalKey) throw new Error(`${FILE} has no desk.portalKey — the desk was never started for this vault`);
  const approver = Keypair.fromSecret(data.keys.approver);

  // 1 — the 402 handshake. No key, no money, just a GET.
  const first = await fetch(DEMO + ROUTE, { cache: "no-store" });
  const terms = JSON.parse(first.headers.get("x-payment") || "null");
  console.log(`1. HTTP ${first.status} · price ${terms?.maxAmountRequired} ${terms?.token?.code ?? ""} · network ${terms?.network}`);
  if (first.status !== 402) {
    throw new Error(`the showcase is not asking for payment (HTTP ${first.status}). Is the mainnet demo running?`);
  }
  if (terms.vault !== data.vault) {
    throw new Error(`${DEMO} is serving ${terms.vault}, not ${data.vault}. Different vault is live on that address.`);
  }

  // 2 — a visitor key, vouched for by the seller.
  const visitor = Keypair.random();
  const enr = await (await fetch(DEMO + "/demo/enroll", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ pub: visitor.publicKey() }),
  })).json();
  if (!enr.ok) throw new Error("the seller refused to vouch for this key: " + enr.error);
  console.log(`2. visitor key ${visitor.publicKey()} vouched`);

  // 3 — sign the REQUEST (never a payment) and park it.
  const payload = [DEMO + ROUTE, terms.maxAmountRequired, terms.vault, Date.now()].join("|");
  const intent = { payload, signature: Buffer.from(visitor.sign(Buffer.from(payload))).toString("base64") };
  const head = { "x-payment": JSON.stringify({ intent }) };
  const parked = await (await fetch(DEMO + ROUTE, { headers: head, cache: "no-store" })).json();
  console.log(`3. parked as ${parked.handle} — waiting for a human`);
  if (!go) {
    console.log(`\nstopping here: nothing was signed and nothing was spent.\nadd --yes to sign the challenge and finish the loop (costs ${terms.maxAmountRequired} XLM into our own payee account).`);
    return;
  }

  // 4 — the human half, done on this machine instead of the iPhone. The desk
  // names the key the vault will accept; if this machine holds a different
  // approver, say so BEFORE signing rather than eating a BAD_AUTH later.
  const ch = await (await fetch(`${DESK}/challenge/${parked.handle}?k=${portalKey}`, { cache: "no-store" })).json();
  if (!ch.xdr) throw new Error("no challenge: " + JSON.stringify(ch));
  if (ch.approver !== approver.publicKey()) {
    throw new Error(`the vault accepts the approver ${ch.approver}; this file holds ${approver.publicKey()}`);
  }
  console.log(`4. signing ${ch.hash.slice(0, 16)}… for ${ch.summary?.amount ?? terms.maxAmountRequired} XLM`);
  const tx: any = TransactionBuilder.fromXDR(ch.xdr, Networks.PUBLIC);
  tx.sign(approver);
  const out = await (await fetch(`${DESK}/signed/${parked.handle}?k=${portalKey}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: tx.toXDR() }),
  })).json();
  if (out.status !== "settled" && out.status !== "paid") {
    throw new Error(`the desk answered ${out.status}: ${out.reason ?? JSON.stringify(out).slice(0, 200)}`);
  }

  // 5 — the same request, now paid.
  let seen: any = out;
  for (let i = 0; i < 20; i++) {
    const u = parked.statusUrl?.startsWith("http") ? parked.statusUrl : DEMO + parked.statusUrl;
    seen = await (await fetch(u, { cache: "no-store" })).json();
    if (seen.status === "settled" || seen.status === "paid" || seen.status === "failed") break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  const paid = await fetch(DEMO + ROUTE, { headers: head, cache: "no-store" });
  const body: any = await paid.json().catch(() => ({}));
  const hash = seen.tx ?? body.tx ?? out.tx;
  console.log(`5. status ${seen.status} · HTTP ${paid.status}`);
  console.log(`   ledger: https://stellar.expert/explorer/public/transaction/${hash}`);
  if (!hash) throw new Error("settled, but no transaction hash came back — check the desk log");
}

main().catch((e) => { console.error("FAILED: " + (e?.message ?? e)); process.exit(1); });
