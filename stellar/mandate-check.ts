// The spending mandate, enforced where money actually moves.
//
// `--max` and `--daily` used to be printed in the seller's banner and applied to
// nothing. A ceiling nobody enforces is worse than no ceiling: the seller
// believes they have one. This file is the proof that they do.
//
//   npx tsx stellar/mandate-check.ts
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { ApprovalDesk, newPortalKey } from "./desk.ts";
import { PolicyEngine } from "./policy.ts";
import { Gateway } from "./gateway.ts";
import { signChallenge } from "./phone.ts";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705", m)) : (fail++, console.log("  \u274c", m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);

  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  await vault.deposit("100", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);

  // max 5 per payment, 10 per day. Small numbers on purpose: the daily ceiling
  // has to be reachable inside one test run.
  const policy = new PolicyEngine({ maxPerPayment: 5, dailyBudget: 10, maxMandateTtl: 3600 });

  const desk = new ApprovalDesk({
    vault, payee: seller.publicKey(),
    principal: principal.secret(),
    split: true,
    port: 4198,
    portalKey: newPortalKey(),
    decideWithinSeconds: 3600,
    policy,
  });

  step("1. a payment over the per-payment ceiling never reaches the phone");
  const big = desk.enqueue("GET https://api.example.com/big", "9.00", "too big", "payload");
  const refused = await desk.approve(big);
  ok(refused!.status === "failed", `status is ${refused!.status}`);
  ok(/max_per_payment/.test(refused!.reason ?? ""), `reason names the rule: ${refused!.reason}`);
  ok(!refused!.challenge, "no challenge was built, so nothing is signable");
  ok(await vault.balance(seller.publicKey()) === "0.0000000", "no money moved");

  step("2. the buyer is told, not left polling a dead handle");
  // The gateway projects id/status/price/uri plus tx and reason onto its ungated
  // /pay/status route, so a refused payment answers instead of timing out.
  const seen = desk.get(big)!;
  ok(seen.status === "failed", `the buyer sees ${seen.status}`);
  ok(/mandate refused/.test(seen.reason ?? ""), `and why: ${seen.reason}`);
  await desk.listen();

  step("3. the daily budget counts real approvals");
  const a1 = desk.enqueue("GET https://api.example.com/a1", "4.00", "one", "payload");
  const asked1 = await desk.approve(a1);
  ok(asked1!.status === "awaiting_phone", "4.00 is inside the ceiling, so the phone is asked");
  const done1 = await desk.complete(a1, signChallenge(asked1!.challenge!, approver.secret()));
  ok(done1!.status === "settled", `settled at ledger ${done1!.tx?.slice(0, 12)}\u2026`);
  ok(policy.spentToday() === 4, `spentToday is now ${policy.spentToday()}`);

  step("4. a second approval that fits is allowed");
  const a2 = desk.enqueue("GET https://api.example.com/a2", "5.00", "two", "payload");
  const asked2 = await desk.approve(a2);
  ok(asked2!.status === "awaiting_phone", "4 + 5 = 9, still under 10");

  step("5. the ceiling is re-checked at submission, not only at approval");
  // The phone signed while the budget was available. Between that signature and
  // the submission, something else spent the rest of the day. Submitting anyway
  // would honour a mandate the seller never agreed to.
  policy.record({ at: Date.now(), amount: 2, payee: seller.publicKey(), uri: "/elsewhere" });
  ok(policy.spentToday() === 6, "6 spent today");
  const a3 = desk.enqueue("GET https://api.example.com/a3", "5.00", "three", "payload");
  const asked3 = await desk.approve(a3);
  ok(asked3!.status === "failed", `6 + 5 = 11 > 10, refused before the phone is asked (${asked3!.status})`);
  ok(!asked3!.challenge, "no challenge, so the phone was never handed something to sign");
  ok(/daily_budget/.test(asked3!.reason ?? ""), asked3!.reason ?? "");

  step("6. a signature already in hand is still refused at the ledger door");
  const late = await desk.complete(a2, signChallenge(asked2!.challenge!, approver.secret()));
  ok(late!.status === "failed", `status is ${late!.status}`);
  ok(/daily_budget/.test(late!.reason ?? ""), late!.reason ?? "");
  ok(await vault.balance(seller.publicKey()) === "4.0000000",
     `seller holds ${await vault.balance(seller.publicKey())} — only the first payment escaped`);

  step("7. no policy configured means no invented ceiling");
  const bare = new ApprovalDesk({
    vault, payee: seller.publicKey(), principal: principal.secret(),
    split: true, port: 4197, portalKey: newPortalKey(), decideWithinSeconds: 3600,
  });
  const b1 = bare.enqueue("GET https://api.example.com/bare", "500.00", "no mandate set", "payload");
  const bareAsked = await bare.approve(b1);
  ok(bareAsked!.status === "awaiting_phone", "without a policy the desk still asks a human");

  step("8. the queue counts as a promise, so the human is not set up to fail");
  // Six 4.50 requests against a 20/day budget: counting only settled payments
  // lets a human approve all six with six Face ID scans and watch two die at
  // submission. Counting what is already queued refuses at the button.
  const q = new PolicyEngine({ maxPerPayment: 10, dailyBudget: 20 });
  const qDesk = new ApprovalDesk({
    vault, payee: seller.publicKey(), principal: principal.secret(),
    split: true, port: 4194, portalKey: newPortalKey(), decideWithinSeconds: 3600, policy: q,
  });
  const qIds = ["", "", "", "", "", ""].map(() =>
    qDesk.enqueue("GET https://api.example.com/q", "4.50", "queued", "payload"));
  const qAsked = [];
  for (const id of qIds) qAsked.push(await qDesk.approve(id));
  const qOk = qAsked.filter((r) => r!.status === "awaiting_phone").length;
  const qNo = qAsked.filter((r) => r!.status === "failed");
  ok(qOk === 4, `4 of 6 fit under 20/day (4 x 4.50 = 18); ${qOk} were sent to the phone`);
  ok(qNo.length === 2, `${qNo.length} refused at the button, not at the ledger`);
  ok(/already approved and waiting/.test(qNo[0]!.reason ?? ""), qNo[0]!.reason ?? "");
  await qDesk.close();

  step("9. over HTTP, a mandate refusal does not loop the buyer");
  // The dangerous shape: the gateway treats `failed` as "ledger hiccup, park a
  // fresh one", so a mandate refusal would park, refuse, park, refuse forever,
  // each time with a new handle the human has to look at. The buyer must get a
  // 402 that says the ceiling refused, and the same handle.
  const gwPolicy = new PolicyEngine({ maxPerPayment: 5, dailyBudget: 4, maxMandateTtl: 3600 });
  // The intent the SDK would send: url|amount|vault|timestamp, signed by a key
  // the vault actually lists. Built here rather than imported so this check also
  // proves the wire format, not just our reading of it.
  const intentFor = (url: string, amount: string) => {
    const payload = `${url}|${amount}|${vault.address}|${Date.now()}`;
    // Keypair.sign returns a Uint8Array; only a Buffer knows about base64.
    const sig = Buffer.from(agent.sign(Buffer.from(payload))).toString("base64");
    return JSON.stringify({ intent: { payload, signature: sig } });
  };
  const gw = new Gateway({
    vault, network: "testnet", payee: seller.publicKey(),
    principal: principal.secret(), split: true,
    deskPort: 4196, portalKey: newPortalKey(), policy: gwPolicy,
    agentKeys: [agent.publicKey()],
    routes: [{ uri: "/data", price: "9.00", mode: "approval", holdSeconds: 3600 }],
  });
  const gwSrv = await gw.listen(4195);
  const over = await fetch("http://127.0.0.1:4195/data");
  ok(over.status === 402, `an unpaid request gets a plain 402 (${over.status})`);
  ok(/"mode":"approval"/.test(over.headers.get("x-payment") ?? ""), "with approval terms attached");

  const intent = intentFor("http://127.0.0.1:4195/data", "9.00");
  const parked = await fetch("http://127.0.0.1:4195/data", { headers: { "x-payment": intent } });
  const pj: any = await parked.json();
  ok(parked.status === 202, `a signed intent parks the request (${parked.status})`);
  ok(!!pj.handle, `handle ${pj.handle}`);

  const asked = await gw.desk.approve(pj.handle);
  ok(asked!.status === "failed", `9.00 over a 5 ceiling: ${asked!.status}`);

  const again = await fetch("http://127.0.0.1:4195/data", {
    headers: { "x-payment": intent },
  });
  const aj: any = await again.json();
  ok(again.status === 402, `the retry is refused, not re-parked (${again.status})`);
  ok(aj.error === "mandate_refused", `error is ${aj.error}`);
  ok(aj.handle === pj.handle, "same handle — the queue does not grow on every retry");
  await new Promise<void>((r) => gwSrv.close(() => r()));

  await desk.close();
  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES: " + fail} \u2014 the mandate holds at both doors.`);
  console.log(`pass ${pass}  fail ${fail}`);
};

main().catch((e) => { console.error("crashed:", e?.message ?? e); process.exit(1); });
