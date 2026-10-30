// Proof-of-concept: AgentVault on STELLAR testnet — no smart contract needed.
// Native primitives do the whole job:
//   • issued asset  -> our payment token
//   • multisig account -> the vault (release needs principal + approver)
//   • preconditions  -> budget/expiry enforcement
// Run: npx tsx stellar/probe.ts
import {
  Keypair, Networks, Horizon, Asset, TransactionBuilder, Operation, Claimant,
} from "stellar-sdk";

const HORIZON = new Horizon.Server("https://horizon-testnet.stellar.org");
const FRIENDBOT = "https://friendbot.stellar.org";
const TOKEN = "AGPAY";

const log = (...a: unknown[]) => console.log("•", ...a);

async function fund(kp: Keypair, label: string) {
  const r = await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(kp.publicKey())}`);
  if (!r.ok) throw new Error(`friendbot ${label} -> ${r.status} ${await r.text()}`);
  const acc = await HORIZON.loadAccount(kp.publicKey());
  const xlm = acc.balances.find((b: any) => b.asset_type === "native")?.balance;
  log(`funded ${label}: ${kp.publicKey().slice(0, 16)}…  XLM ${xlm}`);
  return acc;
}

async function run(signers: Keypair[], build: () => Promise<TransactionBuilder>, label: string) {
  const tx = (await build()).build();
  tx.sign(...signers);
  const res = await HORIZON.submitTransaction(tx);
  log(`${label}: OK  fee=${(Number((res as any).fee_charged ?? 100) / 1e7).toFixed(7)} XLM  hash=${res.hash.slice(0, 16)}…`);
  return res;
}

async function tb(acc: any) {
  return new TransactionBuilder(acc, { fee: await HORIZON.fetchBaseFee(), networkPassphrase: Networks.TESTNET });
}
const reload = (kp: Keypair) => HORIZON.loadAccount(kp.publicKey());

const tokenBal = async (acc: string, asset: Asset) => {
  const a = await HORIZON.loadAccount(acc);
  const b = a.balances.find((x: any) => x.asset_code === asset.getCode() && x.asset_issuer === asset.getIssuer());
  return b ? b.balance : "0";
};

const errCode = (e: unknown) => {
  const any = e as any;
  const codes = any?.resultResultCodes?.()?.results ?? any?.response?.data?.extras?.result_codes?.results;
  return codes?.[0] ?? any?.message?.slice(0, 70);
};

const main = async () => {
  const principal = Keypair.random(); // the human account owner
  const payee = Keypair.random();     // the merchant
  const approver = Keypair.random();  // the human approval key (phone/browser wallet)
  const vault = Keypair.random();     // the escrow account (native multisig)

  log("creating accounts via friendbot — no captcha, no phone, no faucet hunt…");
  await fund(principal, "principal");
  await fund(payee, "payee");
  await fund(approver, "approver");

  const token = new Asset(TOKEN, principal.publicKey());

  // 1. ISSUE OUR OWN TOKEN — answers "can we create a token on these chains?"
  //    (an issuer holds its own asset automatically; payee needs a trustline)
  await run([payee], async () =>
    (await tb(await reload(payee)))
      .addOperation(Operation.changeTrust({ asset: token }))
      .setTimeout(60), "payee trustline");

  // 2. CREATE THE VAULT as a native multisig account.
  //    One atomic tx: add principal + approver as weight-1 signers, then drop
  //    master to weight 0 with threshold 2  =>  every release needs BOTH
  //    the owner's and the designated approver's signature. No contract.
  await run([principal], async () =>
    (await tb(await reload(principal)))
      .addOperation(Operation.createAccount({ destination: vault.publicKey(), startingBalance: "5" }))
      .setTimeout(60), "create vault account");

  await run([vault], async () => {
    const b = await tb(await reload(vault));
    b.addOperation(Operation.changeTrust({ asset: token, limit: "1000000" }));
    b.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: principal.publicKey(), weight: 1 } }));
    b.addOperation(Operation.setOptions({ signer: { ed25519PublicKey: approver.publicKey(), weight: 1 } }));
    b.addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }));
    return b.setTimeout(60);
  }, "vault: trustline + 2-of-2 multisig (principal + approver)");
  log("vault is now 2-of-2 (principal + approver) — enforced by the ledger itself");

  // 3. DEPOSIT into the vault (payee must trust the vault as issuer later, so
  //    we keep principal as issuer and simply send the token to the vault)
  await run([principal], async () =>
    (await tb(await reload(principal)))
      .addOperation(Operation.payment({ destination: vault.publicKey(), asset: token, amount: "10" }))
      .setTimeout(60), "deposit 10 AGPAY into vault");
  log("vault AGPAY:", await tokenBal(vault.publicKey(), token));

  // 4. NEGATIVE TEST: agent/owner tries to release WITHOUT the approver
  try {
    await run([principal], async () =>
      (await tb(await reload(vault)))
        .addOperation(Operation.payment({ destination: payee.publicKey(), asset: token, amount: "3" }))
        .setTimeout(60), "release WITHOUT approval");
    console.error("!! SECURITY FAILURE: unapproved release succeeded");
    process.exit(1);
  } catch (e) {
    log("release WITHOUT approval rejected:", errCode(e), "<- approval is enforced");
  }

  // 5. POSITIVE: human approves -> 2 signatures -> money moves
  await run([principal, approver], async () =>
    (await tb(await reload(vault)))
      .addOperation(Operation.payment({ destination: payee.publicKey(), asset: token, amount: "3" }))
      .setTimeout(60), "human approved -> released");
  log("payee AGPAY:", await tokenBal(payee.publicKey(), token), "| vault AGPAY:", await tokenBal(vault.publicKey(), token));

  // 6. WRONG APPROVER: a different key cannot release
  const impostor = Keypair.random();
  try {
    await run([principal, impostor], async () =>
      (await tb(await reload(vault)))
        .addOperation(Operation.payment({ destination: payee.publicKey(), asset: token, amount: "1" }))
        .setTimeout(60), "release with WRONG approver");
    console.error("!! SECURITY FAILURE: impostor release succeeded");
    process.exit(1);
  } catch (e) {
    log("release with WRONG approver rejected:", errCode(e), "<- only the designated approver counts");
  }

  log("DONE — token, escrow, and approval-gated release all work natively on Stellar");
};

main().catch((e) => {
  const any = e as any;
  console.error("FAILED", JSON.stringify(any?.response?.data?.extras?.result_codes ?? any, null, 1).slice(0, 800));
  process.exit(1);
});
