#!/usr/bin/env npx tsx
// End-to-end proof for the phone app's OWN code.
//
// Everything the browser in phone-app/ does is done here by the same
// dependency-free module (phone-app/xdr.js): decode the payment, recompute the
// hash, sign with a non-extractable WebCrypto key, append the signature. Then it
// goes to the real testnet. If the ledger accepts that, the phone app works —
// not the SDK, the app.
//
//   npx tsx phone-app/app-check.ts
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { StellarVault, createApprovalChallenge, submitApproved } from "../stellar/index.ts";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./xdr.js");
const X: any = (globalThis as any).PaydluxXdr;

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705 " + m)) : (fail++, console.log("  \u274c " + m)); };

/** submitApproved throws with the ledger's own word; turn that into a result. */
async function attempt(signedXdr: string) {
  try {
    await submitApproved(signedXdr, "testnet", horizonOf);
    return { rejected: false, detail: "accepted" };
  } catch (e: any) {
    return { rejected: true, detail: String(e.message).slice(0, 40) };
  }
}
let horizonOf: Horizon.Server;

/** Exactly what index.html does with the seed: non-extractable key, then drop it. */
async function enrol(seed: string) {
  const key = await X.importSecretSeed(seed);
  let exportable = false;
  try { await crypto.subtle.exportKey("pkcs8", key); exportable = true; } catch { /* expected */ }
  return { key, exportable };
}

const main = async () => {
  console.log("\nphone app code path \u2192 live testnet\n");
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
  horizonOf = horizon;
  await vault.deposit("20", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);

  const challenge = await createApprovalChallenge({
    vaultAddress: vault.address, principal, payee: seller.publicKey(),
    tokenCode: "AGPAY", tokenIssuer: issuer.publicKey(), network: "testnet",
    horizon, memo: "pay_app1", amount: "3.25", id: "pay_app1", decideWithinSeconds: 600,
  });

  // ---- the phone: read, verify, sign. No SDK, no network.
  const { key, exportable } = await enrol(approver.secret());
  ok(!exportable, "the app's approver key cannot be exported once imported");

  const env = X.parseEnvelope(challenge.xdr);
  ok(X.formatAmount(env.tx.ops[0].amount) === "3.2500000",
    `the app reads the payment as ${X.formatAmount(env.tx.ops[0].amount)} ${env.tx.ops[0].asset.code}`);
  ok(X.encodeAccountEd25519(env.tx.ops[0].destination.pub) === seller.publicKey(),
    "the app shows the real payee");

  const { hash } = await X.transactionHash(challenge.xdr, X.NETWORK_ID.testnet);
  ok(hash === challenge.hash, "the app's hash matches the seller's hash");

  const sig = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", key, X.signaturePreimage(hash)));
  const signed = X.addSignature(challenge.xdr, sig, approver.rawPublicKey());
  ok(signed !== challenge.xdr, "the app produced a signed envelope");

  // ---- the ledger decides
  const res = await submitApproved(signed, "testnet", horizon);
  ok(res.ok === true, "the ledger accepted a signature made by the app's own code");
  ok(res.hash === challenge.hash, `ledger hash ${res.hash.slice(0, 16)}\u2026 equals the hash the human typed`);

  const bal = await vault.balance(seller.publicKey());
  ok(Number(bal) === 3.25, `the seller received ${bal} AGPAY`);

  // ---- a signature over the wrong hash must fail
  console.log("\n\u2014 and a signature over a hash the human was NOT shown");
  const c2 = await createApprovalChallenge({
    vaultAddress: vault.address, principal, payee: seller.publicKey(),
    tokenCode: "AGPAY", tokenIssuer: issuer.publicKey(), network: "testnet",
    horizon, memo: "pay_app2", amount: "1.00", id: "pay_app2", decideWithinSeconds: 600,
  });
  const badSig = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", key, X.signaturePreimage("0".repeat(64))));
  const badSigned = X.addSignature(c2.xdr, badSig, approver.rawPublicKey());
  const bad = await attempt(badSigned);
  ok(bad.rejected, `the ledger rejects it: ${bad.detail}`);

  // ---- an approver key the vault never authorised must fail
  console.log("\n\u2014 and a stranger's key");
  const stranger = Keypair.random();
  const { key: strangerKey } = await enrol(stranger.secret());
  const sSig = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", strangerKey, X.signaturePreimage(c2.hash)));
  const strangerSigned = X.addSignature(c2.xdr, sSig, stranger.rawPublicKey());
  const sres = await attempt(strangerSigned);
  ok(sres.rejected, `an unauthorised approver is rejected: ${sres.detail}`);

  console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
