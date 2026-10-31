// Paydlux — the approval half that lives on a phone.
//
// The problem this solves: until now the human's key was a string in the
// seller's own process. That makes "2 of 2" a lie — one machine held both
// halves, so whoever owned that machine was the human.
//
// Split it the way banks and hardware wallets do:
//
//   laptop (seller)   builds the payment, signs with the principal key,
//                     sends the UNSIGNED transaction out
//   phone  (human)    decodes it, shows a person what it says, signs with the
//                     approver key, sends the signature back
//   laptop (seller)   submits the now-complete transaction
//
// The approver seed never travels to the laptop. The phone needs no network to
// sign — it only needs the transaction, and it can refuse.
//
// The signature is over the transaction hash, so the phone is signing THIS
// payment: change the amount or the payee and the signature stops counting.
import {
  Asset, Keypair, Memo, Operation, StrKey, Transaction, TransactionBuilder,
} from "@stellar/stellar-sdk";
import type { Network } from "./vault.ts";
import { passphrase, StellarTxError, txResultName } from "./vault.ts";

/** What the seller sends to the phone. Unsigned on purpose. */
export type ApprovalChallenge = {
  id: string;
  network: Network;
  /** the transaction, as XDR, signed by the principal only */
  xdr: string;
  /** what a human should read before signing */
  summary: {
    payee: string;
    amount: string;
    token: string;
    tokenIssuer: string;
    from: string;
    memo?: string;
    expiresAt?: number;
  };
  hash: string;
};

/**
 * Build the payment and sign it with the principal key only. The result is
 * deliberately incomplete: it reaches the vault's threshold of 2 only once the
 * approver's signature is added.
 */
export async function createApprovalChallenge(opts: {
  vaultAddress: string;
  principal: Keypair;
  payee: string;
  amount: string;
  tokenCode: string;
  tokenIssuer: string;
  network: Network;
  horizon: import("@stellar/stellar-sdk").Horizon.Server;
  id: string;
  memo?: string;
  /** how long the human has to decide; the tx is dead after this */
  decideWithinSeconds?: number;
}): Promise<ApprovalChallenge> {
  const pass = passphrase(opts.network);
  const acc = await opts.horizon.loadAccount(opts.vaultAddress);
  const asset = opts.tokenCode === "XLM" ? Asset.native() : new Asset(opts.tokenCode, opts.tokenIssuer);

  const built = new TransactionBuilder(acc, { fee: "100", networkPassphrase: pass })
    .addOperation(Operation.payment({ destination: opts.payee, asset, amount: opts.amount }))
    .setTimeout(opts.decideWithinSeconds ?? 1800);
  if (opts.memo) built.addMemo(Memo.text(opts.memo));
  const tx = built.build();
  tx.sign(opts.principal);

  return {
    id: opts.id,
    network: opts.network,
    xdr: tx.toXDR(),
    summary: {
      payee: opts.payee,
      amount: opts.amount,
      token: opts.tokenCode,
      tokenIssuer: opts.tokenIssuer,
      from: opts.vaultAddress,
      memo: opts.memo,
      expiresAt: tx.timeBounds ? Number(tx.timeBounds.maxTime) || undefined : undefined,
    },
    hash: Buffer.from(tx.hash()).toString("hex"),
  };
}

/**
 * What a person (or a phone app) does with a challenge: read it, decide, sign.
 *
 * This function does not talk to the network. It cannot submit anything. It
 * cannot change the amount. It either adds a valid signature or returns the
 * challenge untouched. That is the whole point of running it on the phone.
 */
export function signChallenge(challenge: ApprovalChallenge, approverSeed: string): string {
  const pass = passphrase(challenge.network);
  const tx = TransactionBuilder.fromXDR(challenge.xdr, pass) as unknown as Transaction;
  const hash = Buffer.from(tx.hash()).toString("hex");
  if (hash !== challenge.hash) {
    throw new Error("challenge was altered in transit — hash does not match, refusing to sign");
  }
  tx.sign(Keypair.fromSecret(approverSeed));
  return tx.toXDR();
}

/**
 * Read a challenge without any secrets, to show a human. Deliberately separate
 * from signing so a UI can render it on an untrusted machine.
 */
export function describeChallenge(challenge: ApprovalChallenge) {
  const s = challenge.summary;
  return [
    `pay      ${s.amount} ${s.token}`,
    `to       ${s.payee}`,
    `from     ${s.from}`,
    `issuer   ${s.tokenIssuer}`,
    s.memo ? `note     ${readableMemo(s.memo)}` : null,
    `network  ${challenge.network}`,
    `signs    ${challenge.hash.slice(0, 16)}…`,
  ].filter(Boolean).join("\n");
}

/**
 * The seller's side: take the phone's signature back and submit. Fails loudly
 * if the transaction is still short of the vault's threshold.
 */
export async function submitApproved(
  signedXdr: string,
  network: Network,
  horizon: import("@stellar/stellar-sdk").Horizon.Server,
): Promise<{ hash: string; ok: true }> {
  const pass = passphrase(network);
  const tx = TransactionBuilder.fromXDR(signedXdr, pass) as unknown as Transaction;
  if (!tx.signatures.length) throw new Error("no signatures on the returned transaction");
  try {
    await horizon.submitTransaction(tx);
    return { hash: Buffer.from(tx.hash()).toString("hex"), ok: true };
  } catch (e) {
    // Horizon answers 400 with the reason buried in the result codes. Surface
    // the ledger's own word (BAD_AUTH, OP_INNER, ...) instead of "400".
    let codes: string[] | undefined;
    try { codes = (e as any)?.resultResultCodes?.()?.results; } catch { /* shape differs */ }
    codes ??= (e as any)?.response?.data?.extras?.result_codes?.results;
    const resultXdr = (e as any)?.response?.data?.extras?.result_xdr;
    const detail = codes?.join(",")
      || (resultXdr ? txResultName(resultXdr) : undefined)
      || resultXdr
      || (e as Error).message;
    throw new StellarTxError(detail, e);
  }
}

/**
 * A memo can arrive as text or as raw bytes depending on how the transaction was
 * decoded. Show a human words, never a byte list.
 */
function readableMemo(memo: unknown): string {
  if (typeof memo === "string") return memo;
  if (Array.isArray(memo) || memo instanceof Uint8Array) {
    try { return Buffer.from(memo as ArrayLike<number>).toString("utf8"); } catch { return String(memo); }
  }
  return String(memo ?? "");
}

/** A stable, scannable form of a challenge — what a phone would read from a QR code. */
export function challengeQrPayload(challenge: ApprovalChallenge) {
  return `paydlux:1\n${challenge.id}\n${challenge.network}\n${challenge.hash}\n${challenge.xdr}`;
}

/** Parse what a QR code carried. Rejects a payload whose hash disagrees. */
export function parseChallengeQr(payload: string): ApprovalChallenge {
  const [tag, id, network, hash, xdr] = payload.split("\n");
  if (tag !== "paydlux:1") throw new Error("not a paydlux approval payload");
  if (network !== "testnet" && network !== "public") throw new Error("unknown network");
  const tx = TransactionBuilder.fromXDR(xdr, passphrase(network as Network)) as unknown as Transaction;
  const actual = Buffer.from(tx.hash()).toString("hex");
  if (actual !== hash) throw new Error("payload was tampered with: hash mismatch");
  const op = tx.operations[0] as any;
  const asset = op.asset;
  return {
    id, network: network as Network, xdr, hash,
    summary: {
      payee: op.destination,
      amount: op.amount,
      token: asset?.getCode ? asset.getCode() : "XLM",
      tokenIssuer: asset?.getIssuer ? (asset.getIssuer() ?? "native") : "native",
      from: tx.source,
      memo: readableMemo((tx as any).memo?.value),
    },
  };
}

export { StrKey };
