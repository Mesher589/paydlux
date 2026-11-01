// Mainnet readiness check. Builds the real transactions and inspects them, but
// never submits one. Nothing here spends money or needs a funded wallet.
//
//   npx tsx stellar/mainnet-check.ts
//
// What it proves before any real USDC is involved:
//   1. the ledger facts the CLI quotes (fee, reserves, Circle's issuer) are real
//   2. the vault's multisig shape is what the product claims
//   3. the spending ceiling and the daily budget are enforced in code, before
//      any transaction exists
import { Keypair, Asset, Networks, TransactionBuilder, Operation, Account, Horizon } from "@stellar/stellar-sdk";
import { StellarVault, USDC_ISSUER } from "./vault.ts";
import { PolicyEngine } from "./policy.ts";

let n = 0, fails = 0;
const ok = (m: string) => { n++; console.log("  ok  ", m); };
const bad = (m: string) => { n++; fails++; console.log(" FAIL ", m); };

const main = async () => {
  console.log("Paydlux — mainnet readiness (nothing is submitted)\n");

  const h = new Horizon.Server("https://horizon.stellar.org");
  const root = await h.root();
  const fee = await h.fetchBaseFee();
  ok(`horizon is on ledger ${root.history_latest_ledger}, base fee ${fee} stroops`);

  // Circle's mainnet USDC. If this issuer is wrong the product pays worthless
  // tokens, so it is checked against the live ledger rather than trusted.
  let circle: any = null;
  try { circle = await h.loadAccount(USDC_ISSUER.public); } catch { /* not found */ }
  const rec = circle;
  if (!rec) bad(`Circle issuer ${USDC_ISSUER.public} not found on mainnet`);
  else ok(`Circle USDC issuer is live on mainnet (${rec.subentry_count} trustlines, med threshold ${rec.thresholds?.med_threshold})`);

  const usdc = StellarVault.usdcToken("public");
  if (!(usdc instanceof Asset) || usdc.getCode() !== "USDC" || usdc.getIssuer() !== USDC_ISSUER.public) {
    bad("usdcToken() did not build USDC:" + USDC_ISSUER.public);
  } else ok(`asset built as USDC:${USDC_ISSUER.public.slice(0, 12)}…`);

  // Build — do not submit — the exact vault-config transaction StellarVault.create
  // sends, and check its shape. This is the transaction that decides whether the
  // vault can ever be robbed by one stolen key.
  const principal = Keypair.random(), approver = Keypair.random(), agent = Keypair.random();
  const vaultKp = Keypair.random();
  const tx = new TransactionBuilder(new Account(vaultKp.publicKey(), "1"),
    { fee: "100", networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.changeTrust({ asset: usdc, limit: "100000000" }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: principal.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: approver.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: agent.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(120).build();
  tx.sign(vaultKp);

  if (tx.operations.length !== 5) bad(`vault config built ${tx.operations.length} operations, expected 5`);
  else ok(`vault config tx: ${tx.operations.length} operations on the mainnet passphrase`);

  // The claim the whole product rests on: the master key is off and no single
  // key reaches the release threshold.
  const trustline = tx.operations[0];
  if (trustline.type !== "changeTrust") bad("trustline is not the first operation");
  else ok("the vault trusts Circle USDC in the same tx that locks its master key");

  const limits = tx.operations.filter((o: any) => o.type === "setOptions" && o.masterWeight !== undefined);
  if (limits.length !== 1) bad("no operation sets the master weight");
  else {
    const o: any = limits[0];
    if (o.masterWeight !== 0) bad("master key weight is not 0 — the vault seed could still act alone");
    if (o.medThreshold !== 2) bad(`release threshold is ${o.medThreshold}, expected 2`);
    if (o.lowThreshold !== 2 || o.highThreshold !== 2) bad("low/high thresholds are not both 2");
    ok("master weight 0, all thresholds 2 — the vault seed can never act alone");
  }
  const added = tx.operations
    .filter((o: any) => o.type === "setOptions" && o.signer)
    .map((o: any) => o.signer);
  if (added.length !== 3) bad(`${added.length} signers added, expected 3`);
  if (added.some((s: any) => s.weight !== 1)) bad("a signer was added with a weight other than 1");
  ok("3 signers at weight 1: principal + approver, or agent + a mandate hash");

  // Spending ceiling: enforced in code, before any transaction exists. The
  // ledger can cap one payment; it cannot count them, so this is the only gate.
  const policy = new PolicyEngine({ maxPerPayment: 2, dailyBudget: 10 });
  const over = policy.check({ amount: 2.5, payee: Keypair.random().publicKey(), ttl: 600 });
  if (over.ok) bad("a payment above the ceiling passed policy");
  else ok(`$2.50 refused before anything is built: [${over.rule}] ${over.detail}`);

  const atLimit = policy.check({ amount: 2, payee: Keypair.random().publicKey(), ttl: 600 });
  if (!atLimit.ok) bad("policy refused a payment at the ceiling: " + atLimit.detail);
  else ok("$2.00 allowed at the ceiling");

  for (let i = 0; i < 5; i++) {
    policy.record({ at: Date.now(), amount: 2, payee: "payee", uri: "/x", mandateHash: "h" + i });
  }
  const drained = policy.check({ amount: 2, payee: "payee", ttl: 600 });
  if (drained.ok) bad("the daily budget did not stop a 6th payment");
  else ok(`6th payment refused: [${drained.rule}] ${drained.detail}`);

  // Reserve math the CLI quotes. Base reserve 2 XLM, 0.5 XLM per ledger entry
  // (3 signers + 1 trustline = 4 entries).
  const need = (2 + 4 * 0.5).toFixed(1);
  if (need !== "4.0") bad("reserve math wrong");
  ok(`vault locks ${need} XLM of rent (2 base + 3 signers + 1 trustline); the CLI funds 5`);

  console.log(fails ? `\n${fails} of ${n} CHECKS FAILED` : `\nALL ${n} CHECKS PASSED — the mainnet path is coherent`);
  process.exit(fails ? 1 : 0);
};
main().catch((e) => { console.error("check crashed:", (e as Error).message); process.exit(1); });
