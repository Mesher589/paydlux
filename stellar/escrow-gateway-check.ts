// Escrow sold through the HTTP gateway, end to end on the test network.
//
// escrow-check.ts proves the ledger primitives. This proves the PRODUCT: a
// buyer's agent hits a priced route, gets a 402 that tells it how to lock the
// money, locks it, retries, and receives the paid content while the seller
// still cannot touch the money. Then the seller releases it — but only after
// the timer and only with both human keys.
//
// Run: npx tsx stellar/escrow-gateway-check.ts
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault, passphrase } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { createEscrow, claimEscrow, readEscrow, refundEscrow, escrowOutcome } from "./escrow.ts";

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + what); }
  else { console.log("  \x1b[31m✗\x1b[0m " + what); fail++; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const principal = Keypair.random(), approver = Keypair.random(), agent = Keypair.random();
  const payee = Keypair.random(), buyer = Keypair.random(), funder = Keypair.random();
  for (const k of [funder, principal, approver, payee, buyer]) await StellarVault.fundTestnet(k);

  const vault = await StellarVault.create({
    network: "testnet", issuer: funder, principal, approver, agent, tokenCode: "XLM",
  });

  const PRICE = "3.5", RELEASE = 40, PORT = 4391;
  const gw = new Gateway({
    vault, network: "testnet", payee: payee.publicKey(),
    routes: [{ uri: "/report", price: PRICE, mode: "escrow", releaseSeconds: RELEASE }],
    principal: principal.publicKey(), approver: approver.publicKey(),
  });
  const srv = await gw.listen(PORT, () => "the paid report: revenue 42, costs 7");
  const url = `http://127.0.0.1:${PORT}/report`;

  console.log("\nthe 402 tells an escrow buyer how to lock the money");
  const first = await fetch(url);
  ok(first.status === 402, `a plain GET gets 402 (${first.status})`);
  const terms = await first.json();
  ok(terms.accepts?.mode === "escrow", "the route declares escrow mode");
  ok(terms.accepts?.scheme === "stellar-escrow", `scheme is ${terms.accepts?.scheme}`);
  ok(terms.accepts?.escrow?.releaseSeconds === RELEASE, `the release window is published (${RELEASE}s)`);
  ok(terms.accepts?.escrow?.vault === vault.address, "the escrow must name this vault");
  ok(/^ord_[0-9a-f]{16}$/.test(terms.order ?? ""), `the order id is handed out up front (${terms.order})`);

  console.log("\nno escrow, no content");
  const bare = await fetch(url, { headers: { "x-payment": JSON.stringify({}) } });
  ok(bare.status === 400, `an empty payment header is a 400 (${bare.status})`);
  const wrong = await fetch(url, { headers: { "x-payment": JSON.stringify({ escrow: "0".repeat(64) }) } });
  ok(wrong.status === 402, `a made-up escrow id gets 402 (${wrong.status})`);
  const why = (await wrong.json()).reason ?? "";
  ok(/no such claimable balance/.test(why), `and says why: ${why}`);

  console.log("\nthe buyer locks the money and pays with the escrow id");
  const orderId = terms.order;
  const { escrow } = await createEscrow("testnet", {
    orderId, asset: vault.token, amount: PRICE,
    buyer: buyer.publicKey(), vault: vault.address,
    releaseAt: Math.floor(Date.now() / 1000) + RELEASE,
  }, buyer);
  ok(!!escrow.balanceId, `escrow locked on the ledger (${escrow.balanceId.slice(0, 16)}…)`);

  const paid = await fetch(url, { headers: { "x-payment": JSON.stringify({ escrow: escrow.balanceId }) } });
  ok(paid.status === 200, `the route serves the body against escrow (${paid.status})`);
  const body = await paid.json();
  ok(/revenue 42/.test(body.data ?? ""), "the paid content arrived");
  ok(body.escrow?.id === escrow.balanceId, "the receipt names the escrow");
  ok(body.escrow?.refundUntil === escrow.releaseAt, "the receipt states the buyer's refund deadline");
  ok(!!body.escrow?.lockTx, `receipt lock tx ${String(body.escrow?.lockTx).slice(0, 16)}…`);

  console.log("\nthe seller cannot take that money yet");
  let early = "";
  try { await claimEscrow("testnet", escrow.balanceId, vault.address, { agent, approver }); }
  catch (e: any) { early = e.message; }
  ok(/release timer has not passed/.test(early), `release refused: ${early}`);
  const queue = await gw.escrowOrders();
  ok(queue.length === 1 && queue[0].state === "locked", `the order shows as ${queue[0]?.state}`);
  ok(queue[0]?.uri === "/report" && queue[0]?.price === PRICE, "the order is matched to the route by its memo");

  console.log("\na buyer who never locks anything is not served twice");
  const other = await fetch("http://127.0.0.1:" + PORT + "/report", {
    method: "POST", headers: { "x-payment": JSON.stringify({ escrow: escrow.balanceId }) }, body: "different body",
  });
  ok(other.status === 402, `a different request body is a different order (${other.status})`);
  ok(/memo/.test((await other.json()).reason ?? ""), "refused because the escrow memo names the other order");

  console.log("\nthe buyer can still walk away with their money");
  const { escrow: e2 } = await createEscrow("testnet", {
    orderId: "ord_walkaway_0001", asset: vault.token, amount: PRICE,
    buyer: buyer.publicKey(), vault: vault.address,
    releaseAt: Math.floor(Date.now() / 1000) + 120,
  }, buyer);
  const back = await refundEscrow("testnet", e2.balanceId, buyer);
  ok(!!back.txHash, `buyer refunded without asking anyone (${back.txHash.slice(0, 16)}…)`);

  console.log("\nafter the timer, delivery already proven, two keys release it");
  while (Math.floor(Date.now() / 1000) < escrow.releaseAt) await sleep(1000);
  await sleep(3000);
  const q2 = await gw.escrowOrders();
  ok(q2.find((o) => o.id === orderId)?.state === "releasable", "the order flips to releasable");
  const oneKey = await gw.releaseEscrow(orderId, { agent, approver: Keypair.random() }).then(() => "ok").catch((e: any) => e.message ?? String(e));
  ok(/bad_auth|failed|no such/i.test(String(oneKey)), `a wrong second key cannot release: ${String(oneKey).slice(0, 60)}`);
  const rel = await gw.releaseEscrow(orderId, { agent, approver });
  ok(!!rel.txHash, `released in tx ${rel.txHash.slice(0, 16)}…`);
  const out = await escrowOutcome("testnet", escrow.balanceId);
  ok(out.settled && out.by === vault.address, "the ledger shows the vault claimed it");
  ok((await readEscrow("testnet", escrow.balanceId)) === null, "the escrow is gone from the ledger");
  const q3 = await gw.escrowOrders();
  ok(!q3.some((o) => o.id === orderId), "it left the seller's release queue");
  const q4 = await gw.escrowOrders({ includeSettled: true });
  ok(q4.some((o) => o.id === orderId && o.state === "released"), "it is still auditable as released");

  srv.close();
  console.log(`\nexplorer: https://stellar.expert/explorer/testnet/account/${vault.address}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error("\nescrow gateway check crashed:", e?.response?.data ?? e); process.exit(1); });
