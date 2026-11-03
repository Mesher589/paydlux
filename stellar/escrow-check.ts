// Escrow, end to end, on the test network with real ledger transactions.
//
// These are not unit tests of a mock. Every assertion here is a transaction
// submitted to Horizon and the answer the network gave back, because the whole
// value of escrow is that the rules are enforced by the ledger rather than by
// our server. If the ledger stops behaving this way, the product's central
// promise is false and this file should fail loudly.
//
// Run: npx tsx stellar/escrow-check.ts
import {
  Asset, Claimant, Horizon, Keypair, Networks, Operation, TransactionBuilder,
  getClaimableBalanceIdFromResult, xdr,
} from "@stellar/stellar-sdk";
import {
  assetFromHorizonString, assetToHorizonString, claimEscrow, createEscrow,
  escrowOutcome, pendingEscrows, readEscrow, refundEscrow, verifyEscrow,
} from "./escrow.ts";

const H = "https://horizon-testnet.stellar.org";
const server = new Horizon.Server(H);

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + what); }
  else { console.log("  \x1b[31m✗\x1b[0m " + what); fail++; }
}
async function funded(kp: Keypair) {
  await fetch(`https://friendbot.stellar.org?addr=${kp.publicKey()}`).then((r) => r.text());
}
/** Turn a plain account into the vault shape: agent + approver, threshold 2. */
async function makeVault(vaultKp: Keypair, agent: Keypair, approver: Keypair) {
  const acc = await server.loadAccount(vaultKp.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: agent.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ signer: { ed25519PublicKey: approver.publicKey(), weight: 1 } }))
    .addOperation(Operation.setOptions({ masterWeight: 0, lowThreshold: 2, medThreshold: 2, highThreshold: 2 }))
    .setTimeout(120).build();
  tx.sign(vaultKp);
  await server.submitTransaction(tx);
}
async function balanceOf(address: string, asset = "native") {
  const a = await (await fetch(`${H}/accounts/${address}`)).json();
  return a.balances?.find((b: any) => b.asset_type === "native")?.balance ?? "0";
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(epochSeconds: number) {
  while (Math.floor(Date.now() / 1000) < epochSeconds) await sleep(1000);
  await sleep(3000); // let the ledger clock pass the predicate cleanly
}

async function main() {
  const buyer = Keypair.random(), vaultKp = Keypair.random(), agent = Keypair.random(), approver = Keypair.random();
  await funded(buyer); await funded(vaultKp);
  await makeVault(vaultKp, agent, approver);
  const terms = {
    orderId: "ord_scf_001",
    asset: Asset.native(),
    amount: "12.5",
    buyer: buyer.publicKey(),
    vault: vaultKp.publicKey(),
    releaseAt: Math.floor(Date.now() / 1000) + 45,
  };

  console.log("\nthe buyer locks money the seller cannot touch yet");
  const { escrow, txHash } = await createEscrow("testnet", terms, buyer);
  ok(!!escrow.balanceId, `escrow created on ledger (${escrow.balanceId.slice(0, 16)}…)`);
  ok(!!txHash, `creating transaction ${txHash.slice(0, 16)}…`);
  ok(Number(escrow.amount) === Number(terms.amount), `escrow holds ${escrow.amount}`);
  ok(escrow.asset === "native", "escrow holds native XLM");
  ok(escrow.memo === terms.orderId, `the creating transaction carries memo "${escrow.memo}"`);
  ok(escrow.vault === vaultKp.publicKey(), "the vault is a claimant");
  ok(escrow.buyer === buyer.publicKey(), "the buyer is a claimant");
  ok(escrow.releaseAt === terms.releaseAt, `release timer set to +${escrow.releaseAt - Math.floor(Date.now() / 1000)}s`);

  console.log("\nthe gateway accepts an escrow that matches the deal exactly");
  const good = await verifyEscrow("testnet", escrow.balanceId, terms, { minReleaseSeconds: 10, maxReleaseSeconds: 600 });
  ok(good.ok, "an exact match verifies");

  console.log("\na buyer cannot cheat the terms");
  const cheap = await verifyEscrow("testnet", escrow.balanceId, { ...terms, amount: "99" });
  ok(!cheap.ok && /escrow holds/.test(cheap.reason ?? ""), `underpaying refused: ${cheap.reason}`);
  const wrongOrder = await verifyEscrow("testnet", escrow.balanceId, { ...terms, orderId: "ord_other" });
  ok(!wrongOrder.ok && /memo/.test(wrongOrder.reason ?? ""), `an escrow from another order refused: ${wrongOrder.reason}`);
  const wrongVault = await verifyEscrow("testnet", escrow.balanceId, { ...terms, vault: agent.publicKey() });
  ok(!wrongVault.ok && /different seller/.test(wrongVault.reason ?? ""), `an escrow locked for someone else refused: ${wrongVault.reason}`);
  const wrongBuyer = await verifyEscrow("testnet", escrow.balanceId, { ...terms, buyer: agent.publicKey() });
  ok(!wrongBuyer.ok && /different account/.test(wrongBuyer.reason ?? ""), "an escrow locked by someone else refused");
  const wrongAsset = await verifyEscrow("testnet", escrow.balanceId, { ...terms, asset: new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN") });
  ok(!wrongAsset.ok && /priced in/.test(wrongAsset.reason ?? ""), `paying in the wrong token refused: ${wrongAsset.reason}`);
  const tooSoon = await verifyEscrow("testnet", escrow.balanceId, terms, { minReleaseSeconds: 3600 });
  ok(!tooSoon.ok && /too soon/.test(tooSoon.reason ?? ""), "a timer too short to prove delivery refused");
  const bogus = await verifyEscrow("testnet", "0".repeat(64), terms);
  ok(!bogus.ok && /no such claimable balance/.test(bogus.reason ?? ""), "a made-up balance id refused");

  console.log("\nthe seller cannot take the money before the timer");
  const beforeBalance = Number(await balanceOf(vaultKp.publicKey()));
  let earlyRefused = "";
  try { await claimEscrow("testnet", escrow.balanceId, vaultKp.publicKey(), { agent, approver }); }
  catch (e: any) { earlyRefused = e.message; }
  ok(/release timer has not passed/.test(earlyRefused), `release refused locally: ${earlyRefused}`);

  // And prove the ledger itself refuses it, not just our guard: build the claim
  // by hand, bypassing claimEscrow(), and submit it with both vault keys.
  const acc = await server.loadAccount(vaultKp.publicKey());
  const raw = new TransactionBuilder(acc, { fee: "100", networkPassphrase: Networks.TESTNET })
    .addOperation(Operation.claimClaimableBalance({ balanceId: escrow.balanceId }))
    .setTimeout(60).build();
  raw.sign(agent); raw.sign(approver);
  let ledgerRefused = "";
  try { await server.submitTransaction(raw); }
  catch (e: any) { ledgerRefused = e?.response?.data?.extras?.result_codes?.transaction ?? e.message; }
  ok(/tx_failed|op_no_destination|tx_bad_auth/.test(ledgerRefused),
    `the ledger itself refuses an early 2-key claim (${ledgerRefused})`);
  // The vault pays the fee for its own rejected claim, so compare direction,
  // not equality: what must NOT happen is the escrow amount arriving.
  const afterEarly = Number(await balanceOf(vaultKp.publicKey()));
  ok(afterEarly <= beforeBalance, `the vault balance did not grow (${beforeBalance} → ${afterEarly})`);
  ok(afterEarly < beforeBalance + Number(terms.amount), "the escrow amount did not land in the vault");

  console.log("\nthe buyer can always take it back before the timer");
  const { escrow: e2 } = await createEscrow("testnet", { ...terms, orderId: "ord_refund_01", amount: "7", releaseAt: Math.floor(Date.now() / 1000) + 120 }, buyer);
  const refund = await refundEscrow("testnet", e2.balanceId, buyer);
  ok(!!refund.txHash, `buyer self-refunded in tx ${refund.txHash.slice(0, 16)}…`);
  ok((await readEscrow("testnet", e2.balanceId)) === null, "the refunded escrow is gone from the ledger");
  const gone = await verifyEscrow("testnet", e2.balanceId, { ...terms, orderId: "ord_refund_01", amount: "7" });
  ok(!gone.ok, "a refunded escrow no longer verifies");

  console.log("\none stolen key cannot empty an escrow");
  let oneKey = "";
  try {
    const a2 = await server.loadAccount(vaultKp.publicKey());
    const t2 = new TransactionBuilder(a2, { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.claimClaimableBalance({ balanceId: escrow.balanceId }))
      .setTimeout(60).build();
    t2.sign(agent); // the agent key is the one an attacker would have
    await server.submitTransaction(t2);
  } catch (e: any) { oneKey = e?.response?.data?.extras?.result_codes?.transaction ?? e.message; }
  ok(/tx_bad_auth/.test(oneKey), `agent key alone gets ${oneKey}`);

  console.log("\nthe seller's own escrow shows up in the release queue");
  const queue = await pendingEscrows("testnet", vaultKp.publicKey());
  ok(queue.some((q) => q.balanceId === escrow.balanceId), `queue lists it (${queue.length} pending)`);
  ok(queue.every((q) => q.vault === vaultKp.publicKey()), "queue only ever holds this vault's money");

  console.log("\nafter the timer, delivery proven, two keys release it");
  await waitUntil(escrow.releaseAt);
  // Accepting a NEW deal with an expired refund window is still refused — that
  // buyer has locked nothing. Releasing a deal we already accepted is allowed:
  // reaching the timer is what success looks like.
  const asNew = await verifyEscrow("testnet", escrow.balanceId, terms);
  ok(!asNew.ok && /refund window has already closed/.test(asNew.reason ?? ""), "an expired window still cannot open a new deal");
  const asRelease = await verifyEscrow("testnet", escrow.balanceId, terms, { allowClosedWindow: true });
  ok(asRelease.ok, "the same escrow verifies on the release path");
  const claimed = await claimEscrow("testnet", escrow.balanceId, vaultKp.publicKey(), { agent, approver });
  ok(!!claimed.txHash, `released in tx ${claimed.txHash.slice(0, 16)}…`);
  const after = Number(await balanceOf(vaultKp.publicKey()));
  ok(after > beforeBalance, `vault balance moved ${beforeBalance} → ${after}`);
  ok((await readEscrow("testnet", escrow.balanceId)) === null, "the claimed escrow is gone from the ledger");

  console.log("\nthe outcome is public and checkable by the buyer");
  const out = await escrowOutcome("testnet", escrow.balanceId);
  ok(out.settled, "the ledger reports the escrow as settled");
  ok(out.by === vaultKp.publicKey(), `claimed by the vault (${String(out.by).slice(0, 8)}…)`);
  ok(!!out.txHash, `receipt tx ${String(out.txHash).slice(0, 16)}…`);
  const queue2 = await pendingEscrows("testnet", vaultKp.publicKey());
  ok(!queue2.some((q) => q.balanceId === escrow.balanceId), "it left the release queue");

  console.log("\nasset strings round-trip (XLM has no issuer, tokens do)");
  ok(assetToHorizonString(Asset.native()) === "native", "native serialises as \"native\"");
  ok(assetFromHorizonString("native").getAssetType() === "native", "\"native\" parses back to native");
  const usdc = new Asset("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  ok(assetToHorizonString(usdc) === `USDC:${usdc.getIssuer()}`, "a token serialises as CODE:issuer");
  ok(assetFromHorizonString(assetToHorizonString(usdc)).getIssuer() === usdc.getIssuer(), "a token parses back to the same issuer");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e) => { console.error("\nescrow check crashed:", e?.response?.data ?? e); process.exit(1); });
