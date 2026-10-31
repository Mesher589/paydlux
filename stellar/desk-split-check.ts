// The product path, end to end, with the human key OFF the seller's machine.
//
//   gateway  ->  desk  ->  HTTP  ->  phone signs  ->  HTTP  ->  ledger
//
// The desk is started WITHOUT an approver seed. It physically cannot approve a
// payment. It can only ask, and then submit what the phone signed.
//
//   npx tsx stellar/desk-split-check.ts
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { ApprovalDesk, newPortalKey } from "./desk.ts";
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
  await vault.deposit("20", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);

  // ---- the desk, deliberately missing the approver key ------------------
  const portalKey = newPortalKey();
  const desk = new ApprovalDesk({
    vault, payee: seller.publicKey(),
    principal: principal.secret(),   // seller's own half
    split: true,                     // no approver seed anywhere in this process
    port: 4199,
    portalKey,
    decideWithinSeconds: 3600,
  });
  ok(!("approver" in desk.cfg) || !desk.cfg.approver, "the desk holds no approver key");

  const id = desk.enqueue("GET https://api.example.com/quotes", "4.50", "30s of market data", "quote payload");

  step("1. Approve on the portal: the desk can only ask the phone");
  const asked = await desk.approve(id);
  ok(asked!.status === "awaiting_phone", `status is ${asked!.status}, not settled`);
  ok(!!asked!.challenge && asked!.challenge!.hash.length === 64, "a challenge was built for the phone");
  ok(asked!.qr!.startsWith("paydlux:1"), "a QR payload is ready to scan");

  step("2. nothing moved yet");
  ok(await vault.balance(seller.publicKey()) === "0.0000000", "seller still at 0.0000000");
  await desk.listen();

  step("3. the phone signs, offline, and posts the signature back");
  const signedXdr = signChallenge(asked!.challenge!, approver.secret());
  const done = await desk.complete(id, signedXdr);
  ok(done!.status === "settled", `status is ${done!.status}`);
  ok(/^[\da-f]{64}$/.test(done!.tx ?? ""), `tx ${done!.tx?.slice(0, 16)}\u2026`);
  ok(await vault.balance(seller.publicKey()) === "4.5000000", "seller now holds 4.5000000");

  step("4. the HTTP route refuses a completion the phone never signed");
  const id2 = desk.enqueue("GET https://api.example.com/news", "2.00", "headlines", "news payload");
  await desk.approve(id2);
  const res = await fetch(`http://127.0.0.1:4199/signed/${id2}?k=${portalKey}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: asked!.signedXdr ?? asked!.challenge!.xdr }),
  });
  const body = await res.json();
  ok(body.status === "failed", `unsigned replay rejected: ${body.status} / ${body.reason}`);
  ok(await vault.balance(seller.publicKey()) === "4.5000000", "no second payment escaped");

  await desk.close();
  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES: " + fail} \u2014 the desk cannot pay without the phone.`);
  console.log(`pass ${pass}  fail ${fail}`);
  console.log("explorer: https://stellar.expert/explorer/testnet/account/" + vault.address);
};

main().catch((e) => { console.error("crashed:", e?.message ?? e); process.exit(1); });
