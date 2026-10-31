#!/usr/bin/env npx tsx
// Proves the phone app's dependency-free decoder agrees with the Stellar SDK.
// If the two ever disagree, a human would approve one transaction while the
// ledger settles another. So this is a real check, not a smoke test.
//
//   npx tsx phone-app/xdr-check.ts
import { Keypair, Horizon, TransactionBuilder, Operation, Asset, xdr } from "@stellar/stellar-sdk";
import { StellarVault, passphrase, createApprovalChallenge } from "../stellar/index.ts";
import { hex } from "../stellar/vault.ts";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./xdr.js");
const X: any = (globalThis as any).PaydluxXdr;

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705 " + m)) : (fail++, console.log("  \u274c " + m)); };

const main = async () => {
  console.log("\nphone decoder vs the Stellar SDK\n");
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");

  // ---------------------------------------------------------------- strkey
  console.log("\u2014 the phone has to read keys without the SDK");
  const seed = Keypair.random().secret();
  const seedBytes = X.decodeSecretSeed(seed);
  ok(seedBytes.length === 32, "a secret seed decodes to 32 bytes");
  ok(X.encodeSecretSeed(seedBytes) === seed, "seed round-trips through the phone's own encoder");

  // the seed imported into WebCrypto must sign as that same Stellar account
  const kp = Keypair.fromSecret(seed);
  const key = await X.importSecretSeed(seed);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode("paydlux-probe")));
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, digest));
  ok(kp.verify(digest, sig), "WebCrypto signs with the Stellar seed and the SDK verifies it");

  let nonExtractable = "";
  try { await crypto.subtle.exportKey("pkcs8", key); } catch (e: any) { nonExtractable = e.message; }
  ok(/extract/i.test(nonExtractable), `the app cannot read the seed back out: ${nonExtractable.slice(0, 44)}`);

  let threw = "";
  try { X.decodeSecretSeed(seed.slice(0, 55) + "A"); } catch (e: any) { threw = e.message; }
  ok(/checksum|mistyped/.test(threw), `a corrupted seed is refused: ${threw.slice(0, 46)}`);
  threw = "";
  try { X.decodeSecretSeed(kp.publicKey()); } catch (e: any) { threw = e.message; }
  ok(/secret seed/.test(threw), "an account id is refused where a seed is expected");
  threw = "";
  try { X.decodeAccountEd25519("G" + "A".repeat(55)); } catch (e: any) { threw = e.message; }
  ok(/checksum/.test(threw), `a corrupted account id is refused: ${threw.slice(0, 46)}`);

  // ---------------------------------------------------------------- payment
  console.log("\n\u2014 a real vault payment, decoded with no SDK in sight");
  await vault.deposit("20", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);
  const challenge = await createApprovalChallenge({
    vaultAddress: vault.address, principal, payee: seller.publicKey(),
    tokenCode: "AGPAY", tokenIssuer: issuer.publicKey(), network: "testnet",
    horizon, memo: "pay_0001", amount: "4.50", id: "pay_0001", decideWithinSeconds: 3600,
  });
  const parsed = X.parseEnvelope(challenge.xdr);
  const op = parsed.tx.ops[0];
  ok(op.asset.code === "AGPAY", `token code reads as ${op.asset.code}`);
  ok(op.asset.issuer === issuer.publicKey(), "token issuer matches");
  ok(X.formatAmount(op.amount) === "4.5000000", `amount reads as ${X.formatAmount(op.amount)}`);
  ok(X.encodeAccountEd25519(op.destination.pub) === seller.publicKey(), "payee matches");
  ok(parsed.tx.memo === "pay_0001", `memo reads as "${parsed.tx.memo}"`);
  ok(X.encodeAccountEd25519(parsed.tx.source.pub) === vault.address, "source is the vault");
  ok(parsed.tx.fee > 0 && parsed.tx.fee < 100000, `fee reads as ${parsed.tx.fee} stroops`);
  ok(parsed.tx.bounds !== null, "the approval deadline is visible to the phone");
  ok(parsed.signatures.length === 1, "the phone sees exactly one signature so far (the seller's)");

  // ---------------------------------------------------------------- hash
  console.log("\n\u2014 the hash the human is shown");
  const { hash } = await X.transactionHash(challenge.xdr, X.NETWORK_ID.testnet);
  ok(hash === challenge.hash, "the phone recomputes the SDK's transaction hash");
  const { hash: mainnetHash } = await X.transactionHash(challenge.xdr, X.NETWORK_ID.public);
  ok(mainnetHash !== challenge.hash, "a mainnet passphrase gives a different hash (no cross-network replay)");

  // ---------------------------------------------------------------- tamper
  console.log("\n\u2014 tampering");
  // Tamper with the raw bytes, the way an attacker would: no SDK involved.
  const raw = Buffer.from(challenge.xdr, "base64");
  const amountAt = raw.indexOf(Buffer.from([0x02, 0xae, 0xa5, 0x40]));   // 4.50 as int64
  ok(amountAt > 0, `the amount field is found in the envelope at byte ${amountAt}`);

  const tampered = Buffer.from(raw);
  tampered.writeUInt32BE(1_000_000, amountAt);                           // 4.50 -> 0.10
  const tamperedXdr = tampered.toString("base64");
  const { hash: tamperedHash } = await X.transactionHash(tamperedXdr, X.NETWORK_ID.testnet);
  ok(tamperedHash !== challenge.hash, "changing the amount changes the hash");
  ok(X.formatAmount(X.parseEnvelope(tamperedXdr).tx.ops[0].amount) === "0.1000000",
    "and the decoder shows the tampered amount, not the one the seller built");

  const swapped = Buffer.from(raw);
  swapped[104] ^= 0xff;                                                  // corrupt the payee key
  const swappedXdr = swapped.toString("base64");
  const { hash: swappedHash } = await X.transactionHash(swappedXdr, X.NETWORK_ID.testnet);
  ok(swappedHash !== challenge.hash, "changing the payee changes the hash");
  ok(X.encodeAccountEd25519(X.parseEnvelope(swappedXdr).tx.ops[0].destination.pub)
    !== seller.publicKey(), "and the decoder shows the swapped payee");

  // ---------------------------------------------------------------- signing
  console.log("\n\u2014 the phone signs, the SDK still accepts the result");
  const approverKey = await X.importSecretSeed(approver.secret());
  const phoneSig = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", approverKey, X.signaturePreimage(challenge.hash)));
  const signed = X.addSignature(challenge.xdr, phoneSig, approver.rawPublicKey());

  const sdkTx: any = TransactionBuilder.fromXDR(signed, passphrase("testnet"));
  ok(sdkTx.signatures.length === 2, `the SDK reloads it with ${sdkTx.signatures.length} signatures`);
  ok(hex(sdkTx.hash()) === challenge.hash, "the signature did not change the transaction hash");
  ok(X.parseEnvelope(signed).signatures.length === 2, "the decoder also sees 2 signatures");
  ok(hex(X.parseEnvelope(signed).signatures[1].hint) === hex(approver.rawPublicKey().slice(28)),
    "the signature hint is the last 4 bytes of the approver key");

  let tooMany = "";
  try { X.addSignature(signed, phoneSig, approver.rawPublicKey()); } catch (e: any) { tooMany = e.message; }
  ok(/already has 2/.test(tooMany), `a third signature is refused: ${tooMany.slice(0, 44)}`);

  // ---------------------------------------------------------------- refusals
  console.log("\n\u2014 things the phone refuses to sign at all");
  const acc: any = await horizon.loadAccount(principal.publicKey());
  const tb = () => new TransactionBuilder(acc, {
    fee: "100", networkPassphrase: "Test SDF Network ; September 2015",
  });
  const refuse = (label: string, xdrString: string) => {
    let msg = "";
    try { X.parseEnvelope(xdrString); } catch (e: any) { msg = e.message; }
    ok(/not a payment|refusing|not supported|soroban|expected a v1|single-payment/.test(msg),
      `${label}: refused \u2014 ${msg.slice(0, 56)}`);
  };
  refuse("a path payment", tb().addOperation(Operation.pathPaymentStrictReceive({
    sendAsset: Asset.native(), destAsset: Asset.native(), destination: seller.publicKey(),
    sendMax: "1", destAmount: "1", path: [],
  })).setTimeout(100).build().toXDR());
  refuse("an account merge", tb().addOperation(Operation.accountMerge({
    destination: seller.publicKey(),
  })).setTimeout(100).build().toXDR());
  refuse("a key rotation", tb().addOperation(Operation.setOptions({
    signer: { ed25519PublicKey: seller.publicKey(), weight: 1 },
  })).setTimeout(100).build().toXDR());
  refuse("two payments at once", tb().addOperation(Operation.payment({
    destination: seller.publicKey(), asset: Asset.native(), amount: "1",
  })).addOperation(Operation.payment({
    destination: seller.publicKey(), asset: Asset.native(), amount: "1",
  })).setTimeout(100).build().toXDR());

  console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
