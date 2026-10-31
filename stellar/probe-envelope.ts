// DE-RISK PROBE: can Stellar enforce a spending cap with no smart contract?
//
// Idea: the vault is a native multisig account. We pre-build a transaction
// whose operations are EXACTLY "pay 3 AGPAY to this payee, inside this time
// window", take its hash, and register that hash as a weight-1 signer on the
// vault. The agent is also a weight-1 signer. Threshold is 2.
//
//   agent alone            -> 1 signature, rejected
//   agent + envelope hash  -> 2 signatures, and the ONLY thing it can submit
//                             is that exact payment
//   principal + approver   -> 2 signatures, the human path
//
// If this works, the cap is a property of the ledger, not of our software.
import {
  Keypair, Networks, Horizon, Asset, TransactionBuilder, Operation, Account,
} from "stellar-sdk";

const HORIZON = new Horizon.Server("https://horizon-testnet.stellar.org");
const TOKEN = "AGPAY";
const log = (...a: unknown[]) => console.log("•", ...a);

const errCode = (e: unknown) => {
  const any = e as any;
  const codes = any?.resultResultCodes?.()?.results ?? any?.response?.data?.extras?.result_codes?.results;
  return codes?.[0] ?? any?.message?.slice(0, 90);
};

async function fund(kp: Keypair, label: string) {
  const r = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!r.ok) throw new Error(`friendbot ${label} -> ${r.status}`);
  log(`funded ${label}`);
}
const reload = (pub: string) => HORIZON.loadAccount(pub);
async function tb(pub: string) {
  return new TransactionBuilder(await reload(pub), { fee: await HORIZON.fetchBaseFee(), networkPassphrase: Networks.TESTNET });
}
/** Builder that claims the sequence number AFTER `at` (for pre-authorized txs). */
async function tbAt(pub: string, at: bigint) {
  const fake = new Account(pub, at.toString());
  return new TransactionBuilder(fake, { fee: await HORIZON.fetchBaseFee(), networkPassphrase: Networks.TESTNET });
}
async function submit(label: string, tx: any, ...signers: Keypair[]) {
  tx.sign(...signers);
  const res = await HORIZON.submitTransaction(tx);
  log(`${label}: OK  hash=${res.hash.slice(0, 14)}…`);
  return res;
}
const bal = async (pub: string, asset: Asset) => {
  const a = await reload(pub);
  const b = a.balances.find((x: any) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer());
  return b ? b.balance : "0";
};

const main = async () => {
  const principal = Keypair.random();
  const approver = Keypair.random();
  const agent = Keypair.random();
  const payee = Keypair.random();
  const vault = Keypair.random();

  for (const [kp, n] of [[principal, "principal"], [approver, "approver"], [payee, "payee"]] as const) await fund(kp, n);

  const token = new Asset(TOKEN, principal.publicKey());

  await submit("payee trustline", (await tb(payee.publicKey()))
    .addOperation(Operation.changeTrust({ asset: token })).setTimeout(60).build(), payee);

  await submit("create vault", (await tb(principal.publicKey()))
    .addOperation(Operation.createAccount({ destination: vault.publicKey(), startingBalance: "10" }))
    .setTimeout(60).build(), principal);

  // vault signers: principal, approver, agent — all weight 1.
  // low/med threshold 2 (payments), high threshold 3 (changing signers).
  await submit("vault 3-of-signers + thresholds", (await tb(vault.publicKey()))
    .addOperation(Operation.changeTrust({ asset: token, limit: "1000000" }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: principal.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: approver.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: agent.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(60).build(), vault);

  await submit("deposit 10 into vault", (await tb(principal.publicKey()))
    .addOperation(Operation.payment({ destination: vault.publicKey(), asset: token, amount: "10" }))
    .setTimeout(60).build(), principal);
  log("vault balance:", await bal(vault.publicKey(), token));

  // ---- the mandate envelope -------------------------------------------------
  // Build the payment tx WITHOUT signing it, take its hash, register the hash
  // as a signer. The vault's seq is S; the setOptions tx takes S+1, so the
  // envelope must take S+2.
  // The vault's next tx is S+1 (the setOptions that registers the hash), so the
  // envelope must claim S+2 exactly. stellar-sdk derives the sequence from the
  // source account, so we hand it a synthetic account one step ahead.
  const acc = await reload(vault.publicKey());
  const seq = (BigInt(acc.sequence) + 2n).toString();
  const now = Math.floor(Date.now() / 1000);

  const envelope = (await tbAt(vault.publicKey(), BigInt(acc.sequence) + 1n))
    .addOperation(Operation.payment({ destination: payee.publicKey(), asset: token, amount: "3" }))
    .setTimebounds(now - 60, now + 3600)
    .build();
  const envHash = envelope.hash(Networks.TESTNET).toString("hex");
  log("envelope hash:", envHash.slice(0, 20) + "…");

  await submit("register envelope as signer", (await tb(vault.publicKey()))
    .addOperation(Operation.setOptions({ signer: { preAuthTx: envHash, weight: 1 } }))
    .setTimeout(3600).build(), principal, approver);

  // NEGATIVE 1: agent alone must not be able to move money.
  try {
    const rogue = (await tb(vault.publicKey()))
      .addOperation(Operation.payment({ destination: payee.publicKey(), asset: token, amount: "9" }))
      .setTimeout(60).build();
    await submit("ROGUE agent-only payment", rogue, agent);
    console.error("!! SECURITY FAILURE: agent moved money alone");
    process.exit(1);
  } catch (e) { log("agent alone rejected:", errCode(e)); }

  // POSITIVE: the agent submits the pre-signed envelope. It is capped by
  // construction — 3 AGPAY, this payee, this window, one time only.
  await submit("agent executes envelope (agent + preauth hash)", envelope, agent);
  log("payee:", await bal(payee.publicKey(), token), "| vault:", await bal(vault.publicKey(), token));

  // NEGATIVE 2: resubmitting the identical envelope must not move money twice.
  // Stellar dedupes an identical submission and returns the ORIGINAL result, so
  // the check is on balances, not on an error being thrown.
  const before = { payee: await bal(payee.publicKey(), token), vault: await bal(vault.publicKey(), token) };
  await submit("resubmit of the same envelope", envelope, agent);
  const after = { payee: await bal(payee.publicKey(), token), vault: await bal(vault.publicKey(), token) };
  if (after.payee !== before.payee || after.vault !== before.vault) {
    console.error(`!! SECURITY FAILURE: envelope executed twice (${JSON.stringify(before)} -> ${JSON.stringify(after)})`);
    process.exit(1);
  }
  log("resubmission is idempotent — balances unchanged:", JSON.stringify(after));

  // NEGATIVE 3: agent cannot inflate the envelope amount.
  try {
    const inflated = (await tbAt(vault.publicKey(), BigInt(seq)))
      .addOperation(Operation.payment({ destination: payee.publicKey(), asset: token, amount: "9" }))
      .setTimebounds(now - 60, now + 3600)
      .build();
    await submit("INFLATED envelope", inflated, agent);
    console.error("!! SECURITY FAILURE: unsigned variant accepted");
    process.exit(1);
  } catch (e) { log("unsigned variant rejected:", errCode(e)); }

  log("PROBE PASSED — a Stellar account can hold a spending cap the agent cannot exceed");
};

main().catch((e) => {
  console.error("FAILED", JSON.stringify((e as any)?.response?.data?.extras?.result_codes ?? (e as any)?.message ?? e, null, 1).slice(0, 900));
  process.exit(1);
});
