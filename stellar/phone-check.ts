// Does the split actually hold? This is the test that matters: the laptop must
// be unable to pay on its own, and the phone must be unable to pay on its own.
//
//   npx tsx stellar/phone-check.ts
//
// Runs against live Stellar testnet. Nothing here touches real money.
import {
  Keypair, Horizon, TransactionBuilder, xdr, Networks,
} from "@stellar/stellar-sdk";
import { StellarVault, passphrase, StellarTxError } from "./vault.ts";
import {
  createApprovalChallenge, signChallenge, describeChallenge, submitApproved,
  challengeQrPayload, parseChallengeQr,
} from "./phone.ts";

let pass = 0, fail = 0;
const ok = (cond: unknown, msg: string) => {
  if (cond) { pass++; console.log("  \u2705", msg); }
  else { fail++; console.log("  \u274c", msg); }
};
const step = (n: string) => console.log(`\n\u2014 ${n}`);
const log = (...a: unknown[]) => console.log("\u2022", ...a);
const short = (k: string) => k.slice(0, 12) + "\u2026";
const errOf = (e: unknown) => (e instanceof StellarTxError ? e.code : (e as Error).message);

/** Paste one transaction's signatures onto another, without the SDK stopping us. */
function stealSignatures(targetXdr: string, donorXdr: string, network: Networks | string): string {
  const env = xdr.TransactionEnvelope.fromXDR(targetXdr, "base64") as any;
  const donor = xdr.TransactionEnvelope.fromXDR(donorXdr, "base64") as any;
  const key = env.v1 ? "v1" : "v0";
  env[key].signatures = donor[key].signatures;
  return env.toXDR("base64");
}

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);

  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  await vault.deposit("20", issuer);
  // the seller has to opt in to holding the token, or the payment has nowhere
  // to land (the ledger answers OP_NO_TRUST_LINE)
  await vault.trustToken(seller.publicKey(), "1000", seller);
  log("vault", short(vault.address), "balance", await vault.balance());

  const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
  const base = {
    vaultAddress: vault.address, principal,
    payee: seller.publicKey(), tokenCode: "AGPAY", tokenIssuer: issuer.publicKey(),
    network: "testnet" as const, horizon, memo: "market data",
  };

  // ---------------------------------------------------------------- 1
  step("1. the laptop builds a payment and signs it alone");
  const challenge = await createApprovalChallenge({ ...base, amount: "4.50", id: "pay_0001", decideWithinSeconds: 3600 });
  ok(challenge.xdr.length > 50, `challenge built (${challenge.xdr.length} chars of XDR)`);
  ok(challenge.hash.length === 64, `hash is 32 bytes hex: ${challenge.hash.slice(0, 16)}\u2026`);
  console.log("\n" + describeChallenge(challenge) + "\n");

  // ---------------------------------------------------------------- 2
  step("2. the laptop tries to submit WITHOUT the phone \u2014 must fail");
  const before = await vault.balance(seller.publicKey());
  let laptopErr = "";
  try {
    await submitApproved(challenge.xdr, "testnet", horizon);
  } catch (e) {
    laptopErr = errOf(e);
  }
  ok(/BAD_AUTH/.test(laptopErr), `ledger refused the half-signed payment: ${laptopErr || "no error"}`);
  ok(await vault.balance(seller.publicKey()) === before,
     `seller unchanged at ${before} \u2014 the laptop alone cannot pay`);

  // ---------------------------------------------------------------- 3
  step("3. the phone signs, offline, with the approver key");
  const signed = signChallenge(challenge, approver.secret());
  ok(signed.length > challenge.xdr.length, `phone returned a signed tx (${signed.length} chars)`);

  // ---------------------------------------------------------------- 4
  step("4. swap the transaction \u2014 the phone must refuse");
  // The real attack: the laptop shows the human "4.50" but wants a 0.01 payment
  // signed. Different amount, therefore a different transaction.
  const rival = await createApprovalChallenge({ ...base, amount: "0.01", id: "pay_0001", decideWithinSeconds: 3600 });
  ok(rival.hash !== challenge.hash,
     `a different amount is a different transaction (${rival.hash.slice(0, 8)}\u2026 \u2260 ${challenge.hash.slice(0, 8)}\u2026)`);
  let why = "";
  let caught = false;
  try { signChallenge({ ...rival, hash: challenge.hash }, approver.secret()); }
  catch (e) { why = (e as Error).message; caught = /hash does not match/.test(why); }
  ok(caught, `phone refuses to sign a swapped transaction: ${why}`);

  // ---------------------------------------------------------------- 5
  step("5. steal the phone's signature and paste it on the rival payment");
  const forged = stealSignatures(rival.xdr, signed, Networks.TESTNET);
  let replayErr = "";
  let replayFailed = false;
  try { await submitApproved(forged, "testnet", horizon); }
  catch (e) { replayFailed = true; replayErr = errOf(e); }
  ok(replayFailed, `stolen signature rejected by the ledger: ${replayErr}`);
  ok(await vault.balance(seller.publicKey()) === before,
     `seller still at ${before} \u2014 the forged payment moved nothing`);

  // ---------------------------------------------------------------- 6
  step("6. QR round-trip \u2014 what a phone camera would actually read");
  const qr = challengeQrPayload(challenge);
  const parsed = parseChallengeQr(qr);
  ok(parsed.summary.amount === "4.5000000", `parsed amount ${parsed.summary.amount}`);
  ok(parsed.summary.payee === seller.publicKey(), "parsed payee matches the seller");
  // Rewrite the amount inside the QR's own XDR while leaving the hash line
  // alone — the payload a phone would receive if someone edited it in transit.
  const tamperedEnv = xdr.TransactionEnvelope.fromXDR(challenge.xdr, "base64") as any;
  // amounts are int64 stroops: 4.50 = 45_000_000, so 0.01 = 100_000
  tamperedEnv.v1.tx.operations[0].body.paymentOp.amount = 100_000n;
  const tamperedQr = [
    "paydlux:1", challenge.id, "testnet", challenge.hash, tamperedEnv.toXDR("base64"),
  ].join("\n");
  let qrCaught = false, qrWhy = "";
  try { parseChallengeQr(tamperedQr); }
  catch (e) { qrWhy = (e as Error).message; qrCaught = /tampered/.test(qrWhy); }
  ok(qrCaught, `editing the amount inside the QR payload is caught: ${qrWhy}`);
  ok(parseChallengeQr(qr).summary.amount === "4.5000000",
     "an untouched payload parses to the amount the human was shown");

  // ---------------------------------------------------------------- 7
  step("7. submit the phone-signed transaction");
  const res = await submitApproved(signed, "testnet", horizon);
  ok(!!res.hash, `settled, tx ${res.hash.slice(0, 16)}\u2026`);
  const after = await vault.balance(seller.publicKey());
  ok(after === "4.5000000", `seller now holds ${after} (was ${before})`);
  log("vault remaining:", await vault.balance());

  // ---------------------------------------------------------------- 8
  step("8. the phone alone cannot pay either");
  const rogue = await createApprovalChallenge({
    ...base, amount: "9.00", id: "pay_0002", principal: Keypair.random(), decideWithinSeconds: 3600,
  });
  const rogueSigned = signChallenge(rogue, approver.secret());
  let soloFailed = false, soloErr = "";
  try { await submitApproved(rogueSigned, "testnet", horizon); }
  catch (e) { soloFailed = true; soloErr = errOf(e); }
  ok(soloFailed, `an approver signature without the real principal is rejected: ${soloErr}`);
  ok(await vault.balance(seller.publicKey()) === "4.5000000", "seller still at 4.5000000");

  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES: " + fail} \u2014 split signing holds on testnet.`);
  console.log(`pass ${pass}  fail ${fail}`);
  console.log("explorer: https://stellar.expert/explorer/testnet/account/" + vault.address);
  void passphrase;
};

main().catch((e) => { console.error("crashed:", e?.message ?? e); process.exit(1); });
