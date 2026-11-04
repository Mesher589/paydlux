// The gap this closes: `paydlux escrow --release` on a --split vault used to
// write a challenge file and stop, because the desk only knew how to route
// PAYMENTS to the phone. This is the release path end to end, with the human
// key off the seller's machine:
//
//   escrow on the ledger -> desk.addEscrow -> HTTP -> phone signs the CLAIM
//   -> HTTP -> desk submits -> vault balance grows
//
// It also pins the two properties that make the path safe:
//   * a release is money IN, so the spending mandate must NOT block it, even
//     when the daily budget is already exhausted;
//   * the claim the phone signs must target THIS escrow's balance id, and a
//     signature collected for something else must not complete it.
//
//   npx tsx stellar/escrow-phone-check.ts
import { Asset, Horizon, Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { ApprovalDesk, newPortalKey } from "./desk.ts";
import { signChallenge } from "./phone.ts";
import { createEscrow } from "./escrow.ts";
import { PolicyEngine } from "./policy.ts";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705", m)) : (fail++, console.log("  \u274c", m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  const buyer = Keypair.random();
  for (const k of [issuer, principal, approver, seller, buyer]) await StellarVault.fundTestnet(k);

  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  await vault.deposit("20", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);
  await vault.trustToken(buyer.publicKey(), "1000", buyer);
  // The escrow is XLM the buyer locks; fundTestnet gave them 10 XLM already.

  // ---- the desk, split: no approver key, and a budget about to be spent ----
  const portalKey = newPortalKey();
  const desk = new ApprovalDesk({
    vault, payee: seller.publicKey(),
    principal: principal.secret(),
    agentSeed: agent.secret(),      // the machine half of an escrow claim
    split: true,
    port: 4198,
    portalKey,
    decideWithinSeconds: 3600,
    // A budget this tight is the point of the test: if the mandate were applied
    // to a release, the release below would be refused for money that never
    // leaves the vault.
    policy: new PolicyEngine({ maxPerPayment: 10, dailyBudget: 5 }),
  });
  await desk.listen();

  // ---- an escrow already releasable on the ledger ----
  const { escrow } = await createEscrow("testnet", {
    orderId: "ord_phone_1",
    asset: Asset.native(),
    amount: "3.50",
    buyer: buyer.publicKey(),
    vault: vault.address,
    releaseAt: Math.floor(Date.now() / 1000) - 60,   // timer already passed
  }, buyer);
  ok(!escrow.claimed, `escrow ${escrow.balanceId.slice(0, 12)}… holds 3.50 XLM and is releasable`);

  step("1. the budget is exhausted by a payment first");
  const pid = desk.enqueue("GET https://api.example.com/data", "5.00", "the whole day's budget", "payload");
  const paid = await desk.approve(pid);
  ok(paid!.status === "awaiting_phone", `the payment went to the phone (${paid!.status})`);
  const paySigned = signChallenge(paid!.challenge!, approver.secret());
  const payDone = await desk.complete(pid, paySigned);
  ok(payDone!.status === "settled", `payment settled, budget now at ${5}/5`);

  step("2. a second payment is mandate-refused before the phone is asked");
  const pid2 = desk.enqueue("GET https://api.example.com/more", "1.00", "over budget", "payload");
  const over = await desk.approve(pid2);
  ok(over!.status === "failed" && /mandate/.test(over!.reason ?? ""),
    `refused without burning a phone signature: ${over!.reason?.slice(0, 60)}`);

  step("3. the escrow release is queued and NOT mandate-blocked");
  const rec = desk.addEscrow({
    escrowId: escrow.balanceId, order: "ord_phone_1",
    amount: "3.50", asset: "XLM", buyer: buyer.publicKey(),
  });
  ok(rec.status === "pending", `queued as ${rec.id} (${rec.status})`);
  ok(desk.addEscrow({ escrowId: escrow.balanceId, amount: "3.50", asset: "XLM" }).id === rec.id,
    "a second --release for the same balance reuses the queue entry");
  const asked = await desk.approve(rec.id);
  ok(asked!.status === "awaiting_phone",
    `a release goes to the phone on a day the budget is gone (${asked!.status})`);
  ok(!!asked!.challenge && asked!.challenge!.hash.length === 64, "a claim challenge was built");

  step("4. the phone signs the claim and the desk submits it");
  // vault.balance() is the TOKEN balance; this escrow is XLM, so read the
  // native balance off the account itself.
  const h = new Horizon.Server("https://horizon-testnet.stellar.org");
  const xlmOf = async () => {
    const a = await h.loadAccount(vault.address);
    return a.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";
  };
  const before = await xlmOf();
  const signedXdr = signChallenge(asked!.challenge!, approver.secret());
  const done = await desk.complete(rec.id, signedXdr);
  ok(done!.status === "settled", `status is ${done!.status}${done!.reason ? " — " + done!.reason : ""}`);
  ok(/^[\da-f]{64}$/.test(done!.tx ?? ""), `tx ${done!.tx?.slice(0, 16)}\u2026`);
  const after = await xlmOf();
  const grew = Number(after) - Number(before);
  // 3.50 in, minus the 100-stroop fee the vault pays for the claim itself.
  ok(grew > 3.49 && grew <= 3.5, `the vault gained ${grew.toFixed(7)} — the escrow minus the fee, not a new payment`);

  step("5. the HTTP routes carry an escrow like the phone app reads them");
  const { escrow: escrow2 } = await createEscrow("testnet", {
    orderId: "ord_phone_2",
    asset: Asset.native(),
    amount: "2.00",
    buyer: buyer.publicKey(),
    vault: vault.address,
    releaseAt: Math.floor(Date.now() / 1000) - 60,
  }, buyer);
  const q = await (await fetch(`http://127.0.0.1:4198/escrow?k=${portalKey}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({
      escrowId: escrow2.balanceId, order: "ord_phone_2",
      amount: "2.00", asset: "XLM", buyer: buyer.publicKey(),
    }),
  })).json();
  ok(q.id && q.status === "pending", `POST /escrow queued ${q.id}`);
  await desk.approve(q.id);
  const ch = await (await fetch(`http://127.0.0.1:4198/challenge/${q.id}?k=${portalKey}`)).json();
  ok(ch.kind === "escrow" && ch.escrowId === escrow2.balanceId,
    "/challenge/:id says kind=escrow and names the balance id");
  ok(ch.amount === "2.00" && ch.asset === "XLM",
    `/challenge/:id carries the amount the claim op cannot (${ch.amount} ${ch.asset})`);
  const list = await (await fetch(`http://127.0.0.1:4198/queue?k=${portalKey}`)).json();
  const row = (list.records ?? list).find?.((r: any) => r.id === q.id);
  ok(row && row.kind === "escrow" && row.token === "XLM", "the queue row renders as an escrow in XLM");

  step("6. a signature for anything else does not complete an escrow");
  const forged = await (await fetch(`http://127.0.0.1:4198/signed/${q.id}?k=${portalKey}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: payDone!.signedXdr ?? signedXdr }),
  })).json();
  ok(forged.status === "failed", `replay rejected: ${forged.status} — ${String(forged.reason).slice(0, 60)}`);

  await desk.close();
  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES: " + fail} \u2014 escrow releases go through the phone.`);
  console.log(`pass ${pass}  fail ${fail}`);
  console.log("explorer: https://stellar.expert/explorer/testnet/account/" + vault.address);
};

main().catch((e) => { console.error("crashed:", e?.message ?? e); process.exit(1); });
