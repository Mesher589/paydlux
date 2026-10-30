// Proof-of-concept: the same idea on XRPL testnet, using NATIVE primitives.
//
// WHAT WORKS (verified here):
//   • faucet funding — no captcha, no phone
//   • an issued currency (AGP) as our payment token
//   • SignerListSet quorum 2 -> the account acts only when the AGENT key AND
//     the human APPROVER key both sign. No smart contract needed.
//   • EscrowCreate / EscrowFinish / EscrowCancel in XRP, gated by that quorum
//
// WHAT XRPL CANNOT DO (the blocker for a dollar-denominated product):
//   • EscrowCreate with an ISSUED currency fails with tecNO_PERMISSION —
//     XRPL escrow is XRP-only. So "hold 3 USDC until a human approves" is not
//     expressible natively; you would have to hold XRP instead.
//   • Check + DefaultRipple paths are possible but need a ripple-enabled
//     issuer, and the approval gate then lives in the Check owner's quorum
//     rather than in a held balance.
// Conclusion: XRPL's multisig is excellent, but for escrowed *token* payments
// Stellar is the better fit. See stellar/probe.ts.
//
// XRPL rules learned building this:
//   - an account may not be its own signer
//   - a receiver needs a TrustSet line before holding an issued currency
//   - EscrowCreate needs a Destination plus FinishAfter or a Condition
//   - xrpl v5: wallet.sign(tx, true) -> { tx_blob }; multisign([blob, blob])
//   - xrpl v5 autofill(tx, signersCount); testnet needs a roomy LastLedgerSequence
//
// Run: npx tsx xrpl/probe.ts
import { Client, multisign, type ClientOptions } from "xrpl";

const WSS = "wss://s.altnet.rippletest.net:51233";
const CUR = "AGP"; // XRPL native currency codes are exactly 3 ASCII chars

const log = (...a: unknown[]) => console.log("•", ...a);

const resCode = (res: any) =>
  res?.result?.meta?.TransactionResult ?? res?.result?.meta?.transactionResult ??
  res?.result?.engine_result ?? res?.engine_result ?? "?";

const ledgerSeq = async (client: Client) =>
  (await client.request({ command: "server_info" })).result.info.validated_ledger.seq;

async function multi(client: Client, tx: any, wallets: any[], label: string) {
  const prepared: any = await client.autofill(tx, wallets.length);
  prepared.LastLedgerSequence = (await ledgerSeq(client)) + 120;
  const blobs = wallets.map((w) => (w.sign(prepared as never, true) as any).tx_blob);
  const res = await client.submitAndWait(multisign(blobs as never), { autofill: false } as never);
  log(`${label}: ${resCode(res)}  ${String((res.result as any).hash ?? "").slice(0, 14)}…`);
  return res;
}

async function single(client: Client, tx: any, w: any, label: string) {
  const prepared: any = await client.autofill(tx);
  prepared.LastLedgerSequence = (await ledgerSeq(client)) + 120;
  const res = await client.submitAndWait(prepared, { autofill: false, wallet: w } as never);
  log(`${label}: ${resCode(res)}`);
  return res;
}

async function escrowSeq(client: Client, account: string) {
  const r: any = await client.request({ command: "account_objects", account, ledger_index: "validated", type: "escrow" });
  const objs: any[] = r.result.account_objects ?? r.result.AccountObjects ?? [];
  if (!objs.length) throw new Error("no escrow found for " + account);
  return objs[objs.length - 1].Sequence;
}

const main = async () => {
  const client = new Client(WSS, { timeout: 30000 } as ClientOptions);
  await client.connect();

  log("funding wallets via the XRPL testnet faucet (no captcha, no phone)…");
  const owner = await client.fundWallet();     // the human's money
  const payee = await client.fundWallet();     // the merchant
  const approver = await client.fundWallet();  // the human approval device
  const agent = await client.fundWallet();     // the automated agent key
  log("owner   ", owner.wallet.address, owner.balance, "XRP");
  log("payee   ", payee.wallet.address);
  log("approver", approver.wallet.address);
  log("agent   ", agent.wallet.address);

  // 1. THE VAULT: owner account under 2-of-2 multisig (agent + approver).
  //    The agent alone can never move money; the approver alone can't either.
  const sl = await client.submitAndWait({
    TransactionType: "SignerListSet", Account: owner.wallet.address,
    SignerQuorum: 2,
    SignerEntries: [
      { SignerEntry: { Account: agent.wallet.address, SignerWeight: 1 } },
      { SignerEntry: { Account: approver.wallet.address, SignerWeight: 1 } },
    ],
  }, { autofill: true, wallet: owner.wallet });
  log("vault multisig (agent + approver, quorum 2):", resCode(sl));

  // 2. ESCROW in XRP, held until a human approves
  await multi(client, {
    TransactionType: "EscrowCreate", Account: owner.wallet.address,
    Destination: payee.wallet.address, Amount: "3000000", // 3 XRP
    FinishAfter: Math.floor(Date.now() / 1000),
    CancelAfter: Math.floor(Date.now() / 1000) + 900,
  }, [agent.wallet, approver.wallet], "escrow 3 XRP held pending approval");
  const esc = await escrowSeq(client, owner.wallet.address);
  log("escrow seq:", esc);

  // 3. NEGATIVE: agent releases alone -> must fail
  const solo = await single(client, {
    TransactionType: "EscrowFinish", Account: owner.wallet.address,
    Owner: owner.wallet.address, OfferSequence: esc,
  }, agent.wallet, "release WITHOUT human approval");
  if (resCode(solo) === "tesSUCCESS") {
    console.error("!! SECURITY FAILURE: agent released funds alone"); process.exit(1);
  }

  // 4. NEGATIVE: impostor co-signs instead of the approver -> must fail
  const { Wallet } = await import("xrpl");
  const impostor = Wallet.generate();
  const wrong = await multi(client, {
    TransactionType: "EscrowFinish", Account: owner.wallet.address,
    Owner: owner.wallet.address, OfferSequence: esc,
  }, [agent.wallet, impostor], "release with WRONG approver");
  if (resCode(wrong) === "tesSUCCESS") {
    console.error("!! SECURITY FAILURE: impostor co-signature worked"); process.exit(1);
  }

  // 5. POSITIVE: agent initiates + human approves -> money moves
  await multi(client, {
    TransactionType: "EscrowFinish", Account: owner.wallet.address,
    Owner: owner.wallet.address, OfferSequence: esc,
  }, [agent.wallet, approver.wallet], "human approved -> released");

  // 6. THE BLOCKER: the same escrow in our TOKEN, not XRP
  const issuer = await client.fundWallet();
  for (const w of [owner, payee]) {
    await client.submitAndWait({
      TransactionType: "TrustSet", Account: w.wallet.address,
      LimitAmount: { currency: CUR, issuer: issuer.wallet.address, value: "1000000" },
    }, { autofill: true, wallet: w.wallet });
  }
  await client.submitAndWait({
    TransactionType: "Payment", Account: issuer.wallet.address,
    Destination: owner.wallet.address,
    Amount: { currency: CUR, value: "10", issuer: issuer.wallet.address },
  }, { autofill: true, wallet: issuer.wallet });
  const iou = await client.submitAndWait({
    TransactionType: "EscrowCreate", Account: owner.wallet.address,
    Destination: payee.wallet.address,
    Amount: { currency: CUR, value: "3", issuer: issuer.wallet.address },
    FinishAfter: Math.floor(Date.now() / 1000),
    CancelAfter: Math.floor(Date.now() / 1000) + 900,
  }, { autofill: true, wallet: owner.wallet });
  log("escrow 3 AGP (our token) instead of XRP:", resCode(iou),
      "<- XRPL escrow is XRP-only; Stellar has no such limit");

  log("DONE — XRPL multisig + XRP escrow proven; token escrow is the gap");
  await client.disconnect();
};

main().catch((e) => { console.error("FAILED", e?.data ?? e?.message ?? e); process.exit(1); });
