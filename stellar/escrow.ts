// Paydlux escrow — a payment the buyer locks, not a payment the seller holds.
//
// The claim on the website is: "the escrow that holds a payment until delivery
// is proven". This file is what makes that claim true, and it deliberately does
// NOT use a smart contract. Stellar has a native primitive for exactly this
// shape of deal — a claimable balance with two claimants and a time predicate —
// and it is strictly better than a contract for a payment rail:
//
//   * no contract to audit, and no contract address that can be wrong
//   * the money never sits in an account the seller controls
//   * the reserve is paid by whoever creates the balance (the buyer), and the
//     ledger gives it back when the balance is claimed
//   * the rules are enforced by the network, not by our server being up
//
// The shape, verified against testnet (see stellar/escrow-check.ts):
//
//   claimant 1 — the seller vault, predicate NOT(abs_before = releaseAt)
//                so the vault can only claim AFTER the release time
//   claimant 2 — the buyer,          predicate abs_before = releaseAt
//                so the buyer can claw the money back ONLY before it
//
// Three properties follow, and all three were observed on the ledger:
//   1. before releaseAt the vault cannot take the money, even with both of its
//      keys (tx_failed on the claim)
//   2. after releaseAt the vault can take it, but only with BOTH keys — one
//      signature is tx_bad_auth, so a stolen agent key cannot empty an escrow
//   3. before releaseAt the buyer can always take it back, no seller consent
//
// So the seller's incentive is to prove delivery before the timer: releasing
// early needs the human approval key anyway, and until then the money is the
// buyer's to reclaim. That is the whole product in two claimants.
import {
  Asset, Claimant, Horizon, Keypair, Memo, Operation, TransactionBuilder, Transaction,
  getClaimableBalanceIdFromResult, xdr,
} from "@stellar/stellar-sdk";
import { hex } from "@scure/base";
import { passphrase, type Amount, type Network } from "./vault.ts";

const HORIZON_URL: Record<Network, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

export const horizonUrl = (network: Network) => HORIZON_URL[network];

/** Horizon writes an asset as "native" or "USDC:Gissuer…". */
export function assetToHorizonString(asset: Asset): string {
  return asset.getAssetType() === "native"
    ? "native"
    : `${asset.getCode()}:${asset.getIssuer()}`;
}
export function assetFromHorizonString(s: string): Asset {
  if (s === "native") return Asset.native();
  const [code, issuer] = String(s).split(":");
  if (!code || !issuer) throw new Error(`unrecognised asset string "${s}"`);
  return new Asset(code, issuer);
}

/** The deal the buyer must lock into the ledger. */
export type EscrowTerms = {
  /** the order id the buyer must put in the creating transaction's memo */
  orderId: string;
  asset: Asset;
  amount: Amount;
  /**
   * The account that funds and locks the escrow. Required to create one.
   * Optional when VERIFYING: a seller usually does not care who the buyer is,
   * only that the money is locked to the right order, price and vault. Pin it
   * when the buyer's account was agreed up front, and any other account is
   * refused.
   */
  buyer?: string;
  /** the seller vault allowed to claim after release */
  vault: string;
  /** unix seconds; the vault cannot claim before this, the buyer can refund until this */
  releaseAt: number;
};

export type Escrow = {
  balanceId: string;
  amount: Amount;
  asset: string;          // Horizon form, "native" or "CODE:issuer"
  vault: string;          // claimant that must wait for the timer
  buyer: string;          // claimant that can refund until the timer
  releaseAt: number;      // unix seconds
  /** the transaction that created it, and the memo it carried */
  txHash: string;
  memo: string;
  memoType: string;
  /** true once the ledger says the balance is gone (claimed or swept) */
  claimed: boolean;
};

export type EscrowCheck = { ok: boolean; reason?: string; escrow?: Escrow };

async function getJson(url: string): Promise<any> {
  const r = await fetch(url);
  if (!r.ok) {
    const e: any = new Error(`horizon ${r.status} on ${url.split("?")[0]}`);
    e.status = r.status;
    throw e;
  }
  return r.json();
}

/**
 * Read a claimable balance back from the ledger and turn it into an Escrow.
 *
 * Horizon does NOT put the memo on the balance record — the memo lives on the
 * transaction that created it. So the join between "this pile of money" and
 * "that order" is one extra request. It is not optional: without it, two orders
 * of the same price to the same vault are indistinguishable, and a seller could
 * deliver order A and claim the escrow that was locked for order B.
 */
export async function readEscrow(network: Network, balanceId: string): Promise<Escrow | null> {
  const h = horizonUrl(network);
  let cb: any;
  try { cb = await getJson(`${h}/claimable_balances/${balanceId}`); }
  catch (e: any) { if (e.status === 404 || e.status === 400) return null; throw e; }
  if (!cb?.claimants) return null;

  // The two claimants are distinguished by their predicate, not by position:
  // the seller's is wrapped in `not`, the buyer's is the bare abs_before.
  const seller = cb.claimants.find((c: any) => c.predicate?.not);
  const buyer = cb.claimants.find((c: any) => !c.predicate?.not && c.predicate?.abs_before_epoch);
  if (!seller || !buyer) return null;

  const txs = await getJson(`${h}/claimable_balances/${balanceId}/transactions?order=asc&limit=1`);
  const tx = txs?._embedded?.records?.[0];
  return {
    balanceId,
    amount: cb.amount,
    asset: cb.asset,
    vault: seller.destination,
    buyer: buyer.destination,
    releaseAt: Number(seller.predicate.not.abs_before_epoch),
    txHash: tx?.hash ?? "",
    memo: tx?.memo ?? "",
    memoType: tx?.memo_type ?? "none",
    claimed: false,
  };
}

/**
 * Does this on-chain escrow actually pay THIS deal?
 *
 * Every field is checked against the terms the gateway issued, because the
 * buyer is untrusted: a buyer could lock 0.0000001 XLM, or lock money to a
 * different vault, or set the timer to next year, or reuse the escrow from a
 * previous order. Anything short of an exact match is a refusal.
 */
export async function verifyEscrow(
  network: Network,
  balanceId: string,
  want: EscrowTerms,
  opts: {
    minReleaseSeconds?: number;
    maxReleaseSeconds?: number;
    /**
     * The refund window being open is a requirement when ACCEPTING a deal —
     * a buyer who locks money with a timer that already expired has locked
     * nothing, because the seller could claim it the instant it lands.
     *
     * It is not a requirement when RELEASING one. An escrow that reached its
     * timer is still a valid escrow; that is the normal, successful case. So
     * the release path passes allowClosedWindow and gets the money it earned.
     */
    allowClosedWindow?: boolean;
  } = {},
): Promise<EscrowCheck> {
  const e = await readEscrow(network, balanceId);
  if (!e) return { ok: false, reason: "no such claimable balance (already claimed, or never created)" };
  if (e.asset !== assetToHorizonString(want.asset)) return { ok: false, reason: `escrow holds ${e.asset}, this route is priced in ${assetToHorizonString(want.asset)}` };
  if (Number(e.amount) !== Number(want.amount)) return { ok: false, reason: `escrow holds ${e.amount}, this route costs ${want.amount}` };
  if (e.vault !== want.vault) return { ok: false, reason: "escrow names a different seller vault" };
  if (want.buyer && e.buyer !== want.buyer) return { ok: false, reason: "escrow was locked by a different account" };
  // The memo is the only link between money and order. Exact match, or no deal.
  if (e.memoType !== "text" || e.memo !== want.orderId) return { ok: false, reason: `escrow memo "${e.memo}" does not match order ${want.orderId}` };
  const now = Math.floor(Date.now() / 1000);
  if (e.releaseAt <= now && !opts.allowClosedWindow) {
    return { ok: false, reason: "the refund window has already closed — the seller could already have claimed it" };
  }
  if (opts.minReleaseSeconds != null && e.releaseAt - now < opts.minReleaseSeconds) return { ok: false, reason: "release timer is too soon to prove delivery" };
  if (opts.maxReleaseSeconds != null && e.releaseAt - now > opts.maxReleaseSeconds) return { ok: false, reason: "release timer is further out than this route allows" };
  return { ok: true, escrow: e };
}

/**
 * The balance id of the escrow a submitted transaction created.
 *
 * Horizon does not return this to the submitter, and the id is not derivable
 * from the account alone — it comes out of the transaction RESULT. A buyer who
 * locks money with their own code needs this to know what to put in the
 * `x-payment` header, so it is exported rather than kept private.
 */
export function escrowBalanceId(resultXdr: string, index = 0): string {
  return getClaimableBalanceIdFromResult(xdr.TransactionResult.fromXdr(resultXdr, "base64"), index);
}

/**
 * Lock an escrow. Needs the BUYER's key: the money leaves the buyer's account,
 * so only the buyer can put it in escrow. The seller never gets a signature on
 * this transaction — that is the point.
 */
export async function createEscrow(
  network: Network,
  terms: EscrowTerms,
  buyerKey: Keypair,
): Promise<{ escrow: Escrow; txHash: string }> {
  if (!terms.buyer) throw new Error("creating an escrow needs terms.buyer — the money leaves that account");
  if (buyerKey.publicKey() !== terms.buyer) throw new Error("the signing key is not the escrow buyer");
  const h = new Horizon.Server(horizonUrl(network));
  const acc = await h.loadAccount(terms.buyer);
  const releaseAt = Math.floor(terms.releaseAt);
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: passphrase(network) })
    .addOperation(Operation.createClaimableBalance({
      asset: terms.asset,
      amount: terms.amount,
      // Order matters for readability only; the predicates are what enforce the deal.
      claimants: [
        new Claimant(terms.vault, Claimant.predicateNot(Claimant.predicateBeforeAbsoluteTime(String(releaseAt)))),
        new Claimant(terms.buyer, Claimant.predicateBeforeAbsoluteTime(String(releaseAt))),
      ],
    }))
    // The memo is the order id. Without it the escrow cannot be matched to an
    // order, and verifyEscrow() will refuse it.
    .addMemo(Memo.text(terms.orderId))
    .setTimeout(300)
    .build();
  tx.sign(buyerKey);
  const res = await h.submitTransaction(tx);
  const balanceId = getClaimableBalanceIdFromResult(
    xdr.TransactionResult.fromXdr(res.result_xdr, "base64"), 0);
  const escrow = await readEscrow(network, balanceId);
  if (!escrow) throw new Error("escrow was created but Horizon will not show it yet");
  return { escrow, txHash: res.hash };
}

/**
 * The seller takes the escrow. Two keys, always: the vault's threshold is 2 and
 * the claim is a medium-threshold operation, so the agent key alone gets
 * tx_bad_auth. `approverKey` lives on the phone in a real deployment.
 *
 * Refuses before the release time rather than letting Horizon reject it, so the
 * caller gets a sentence instead of an error code — and so a buggy scheduler
 * cannot accidentally try to release early in a loop.
 */
export async function claimEscrow(
  network: Network,
  balanceId: string,
  vaultAddress: string,
  keys: { agent: Keypair; approver: Keypair },
): Promise<{ txHash: string; claimedAt: number }> {
  const e = await readEscrow(network, balanceId);
  if (!e) throw new Error("no such escrow — it has already been claimed or refunded");
  if (e.vault !== vaultAddress) throw new Error(`escrow ${balanceId.slice(0, 12)}… pays a different vault`);
  const now = Math.floor(Date.now() / 1000);
  if (now < e.releaseAt) throw new Error(`release timer has not passed (${e.releaseAt - now}s to go)`);

  const h = new Horizon.Server(horizonUrl(network));
  const acc = await h.loadAccount(vaultAddress);
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: passphrase(network) })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(120)
    .build();
  tx.sign(keys.agent);
  tx.sign(keys.approver);
  const res = await h.submitTransaction(tx);
  return { txHash: res.hash, claimedAt: now };
}

/**
 * Release an escrow with the approver's key on a PHONE.
 *
 * `claimEscrow` needs both keys in one process. In a real deployment the human
 * half never lives on the seller's machine — it lives on their phone. So build
 * the claim here, sign it with the agent key, and hand it out as the same
 * challenge the payment desk already uses: the phone reads a sentence
 * ("claim 3.5 XLM from escrow ord_…"), signs, and sends back XDR.
 *
 * The phone is the only place the second signature can be added. This process
 * cannot sign for it, cannot submit a completed claim, and cannot do anything
 * with the half-signed transaction except wait.
 */
export async function prepareEscrowRelease(
  network: Network,
  balanceId: string,
  vaultAddress: string,
  agent: Keypair,
): Promise<import("./phone.ts").ApprovalChallenge> {
  const e = await readEscrow(network, balanceId);
  if (!e) throw new Error("no such escrow — it has already been claimed or refunded");
  if (e.vault !== vaultAddress) throw new Error(`escrow ${balanceId.slice(0, 12)}… pays a different vault`);
  const now = Math.floor(Date.now() / 1000);
  if (now < e.releaseAt) throw new Error(`release timer has not passed (${e.releaseAt - now}s to go)`);

  const h = new Horizon.Server(horizonUrl(network));
  const acc = await h.loadAccount(vaultAddress);
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: passphrase(network) })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .addMemo(Memo.text(`release ${e.memo}`))
    .setTimeout(1800)
    .build();
  tx.sign(agent);
  return {
    id: `escrow:${balanceId}`,
    network,
    xdr: tx.toXDR(),
    summary: {
      payee: vaultAddress,
      amount: e.amount,
      token: e.asset === "native" ? "XLM" : e.asset.split(":")[0],
      tokenIssuer: e.asset === "native" ? "" : e.asset.split(":")[1] ?? "",
      from: `escrow ${balanceId.slice(0, 16)}…`,
      memo: `order ${e.memo} — release timer passed`,
      expiresAt: Number(tx.timeBounds?.maxTime) || undefined,
    },
    hash: Buffer.from(tx.hash()).toString("hex"),
  };
}

/**
 * The buyer takes their money back. No seller signature, no permission, and it
 * works right up to the release second — which is why the seller has to earn
 * the release by proving delivery instead of waiting for the timer.
 */
export async function refundEscrow(
  network: Network,
  balanceId: string,
  buyerKey: Keypair,
): Promise<{ txHash: string }> {
  const e = await readEscrow(network, balanceId);
  if (!e) throw new Error("no such escrow — it has already been claimed or refunded");
  if (e.buyer !== buyerKey.publicKey()) throw new Error("only the account that locked this escrow can refund it");
  const now = Math.floor(Date.now() / 1000);
  if (now >= e.releaseAt) throw new Error("the refund window has closed");

  const h = new Horizon.Server(horizonUrl(network));
  const acc = await h.loadAccount(buyerKey.publicKey());
  const tx = new TransactionBuilder(acc, { fee: "100", networkPassphrase: passphrase(network) })
    .addOperation(Operation.claimClaimableBalance({ balanceId }))
    .setTimeout(120)
    .build();
  tx.sign(buyerKey);
  const res = await h.submitTransaction(tx);
  return { txHash: res.hash };
}

/**
 * Every escrow currently waiting on this vault, newest first.
 *
 * Horizon filters claimable balances by claimant, which is exactly the seller's
 * question: "what money is sitting in escrow for me, and when does each one
 * become mine?" A balance that has already been claimed disappears from this
 * list, so it doubles as the pending-release queue.
 */
export async function pendingEscrows(
  network: Network,
  vaultAddress: string,
  limit = 200,
): Promise<Escrow[]> {
  const h = horizonUrl(network);
  const list = await getJson(`${h}/claimable_balances?claimant=${vaultAddress}&order=desc&limit=${Math.min(limit, 200)}`);
  const out: Escrow[] = [];
  for (const rec of list?._embedded?.records ?? []) {
    const e = await readEscrow(network, rec.id);
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.releaseAt - b.releaseAt);
}

/**
 * Has this escrow been settled, and by whom?
 *
 * A claimed balance vanishes from Horizon, so the answer is in the operations
 * of the transaction that claimed it. This is the proof-of-delivery receipt:
 * the buyer can look up the same number on any explorer.
 */
export async function escrowOutcome(
  network: Network,
  balanceId: string,
): Promise<{ settled: boolean; by?: string; txHash?: string; at?: string }> {
  const h = horizonUrl(network);
  let ops: any;
  try { ops = await getJson(`${h}/claimable_balances/${balanceId}/operations?order=desc&limit=5`); }
  catch (e: any) { if (e.status === 404 || e.status === 400) return { settled: false }; throw e; }
  const claim = (ops?._embedded?.records ?? []).find((o: any) => o.type === "claim_claimable_balance");
  if (!claim) return { settled: false };
  return { settled: true, by: claim.account ?? claim.source_account, txHash: claim.transaction_hash, at: claim.created_at };
}
