// Paydlux approval desk on Stellar — the human-in-the-loop layer.
//
// A route in "approval" mode never settles on the agent's say-so. The gateway
// parks the request here; a person opens the portal, reads what the agent
// wanted to buy and for how much, and clicks Approve or Deny.
//
// Approving means signing a Stellar transaction with the human's key. The
// vault needs principal + approver (threshold 2), so:
//   - a stolen agent key cannot approve
//   - a stolen phone cannot approve alone
//   - the approval is a real ledger signature, not a database flag
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { passphrase } from "./vault.ts";
import type { StellarVault } from "./vault.ts";
import type { PolicyEngine } from "./policy.ts";
import { portalPage } from "./portal.ts";
import {
  createApprovalChallenge, submitApproved, challengeQrPayload,
  type ApprovalChallenge,
} from "./phone.ts";
import { claimEscrow, prepareEscrowRelease } from "./escrow.ts";

/**
 * The approver app is plain static files under phone-app/. Read on each request
 * rather than bundled, so the desk and the app can never drift apart.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..", "phone-app");
const PORTAL_DIR = join(HERE, "..", "portal-app");
const staticCache = new Map<string, string | Buffer>();
// mtime of the bytes held in staticCache, so an edited file is picked up on the
// next request instead of after a restart. See readStatic.
const staticStamp = new Map<string, number>();

/**
 * Static files are read from disk, not bundled, so the desk and its front ends
 * can never drift apart. The name is stripped to [a-z._-] before it touches a
 * path, so a request can't walk out of the directory.
 *
 * PNGs are returned as bytes: reading an image as utf8 text replaces every
 * invalid sequence with U+FFFD and ships a corrupt icon to the phone.
 *
 * The cache is keyed on the file's mtime, not just its name. Caching once per
 * process looked fine and was not: the approver's service worker is deliberately
 * network-first so that a security fix reaches an installed phone on the next
 * open, and a desk that holds the old bytes in memory until it restarts breaks
 * exactly that promise. A patched app.js on disk would have sat invisible for
 * days behind a running desk. One stat() per request is cheap; a stale approver
 * page that keeps signing old-style transactions is not.
 */
function readStatic(dir: string, name: string, label: string): string | Buffer | null {
  const safe = name.replace(/[^a-z0-9._-]/g, "");
  const file = join(dir, safe);
  let stamp: number;
  try {
    stamp = statSync(file).mtimeMs;
  } catch {
    return null;   // missing file: a 404, not a crash
  }
  const key = dir + "/" + safe;
  const hit = staticCache.get(key);
  if (hit && staticStamp.get(key) === stamp) return hit;
  let text: string | Buffer;
  try {
    text = safe.endsWith(".png") ? readFileSync(file) : readFileSync(file, "utf8");
  } catch {
    // Unreadable between the stat and the read, or not a file at all. The
    // request handler is not a place to raise: one bad URL must not take the
    // whole desk down.
    return null;
  }
  staticCache.set(key, text);
  staticStamp.set(key, stamp);
  return text;
}
const readAppFile = (name: string) => readStatic(APP_DIR, name, "approver app");
const notFound = (res: ServerResponse) => {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("404");
};
const readPortalFile = (name: string) => readStatic(PORTAL_DIR, name, "portal app");

/** A portal link is a capability: whoever holds it can approve. So it is long,
 *  random, and compared without leaking timing. */
export function newPortalKey() { return randomBytes(16).toString("base64url"); }

/**
 * Check that a signature the phone sent back belongs to THIS payment.
 * Returns a reason string if it does not, or null if it is fine.
 */
function verifyAgainstChallenge(signedXdr: string, rec: DeskRecord): string | null {
  const ch = rec.challenge!;
  let signed: any;
  try {
    signed = TransactionBuilder.fromXDR(signedXdr, passphrase(recNetwork(rec)));
  } catch {
    return "the phone returned something that is not a valid transaction for this network";
  }
  // 1. same transaction the human was shown: same hash, so the amount, payee,
  //    source account and sequence are all identical to what was approved.
  const hash = Buffer.from(signed.hash()).toString("hex");
  if (hash !== ch.hash) {
    return `signed a different transaction (${hash.slice(0, 12)}… was not issued for ${rec.id}, which is ${ch.hash.slice(0, 12)}…)`;
  }
  // 2. the phone added exactly one signature; nothing else changed.
  if (signed.signatures.length < 2) {
    return `only ${signed.signatures.length} signature(s); the vault needs 2`;
  }
  // 3. belt and braces: the payment still says what the record says.
  const op = signed.operations?.[0];
  if (!op || op.type !== "payment") return "the transaction is not a payment";
  if (op.destination !== rec.challenge!.summary.payee) return "payee does not match the approval";
  const want = rec.challenge!.summary.amount;
  if (op.amount !== want && Number(op.amount) !== Number(want)) {
    return `amount ${op.amount} does not match the approved ${want}`;
  }
  return null;
}

function recNetwork(rec: DeskRecord) {
  return rec.challenge!.network;
}

/**
 * Same binding check as verifyAgainstChallenge, for an escrow release. The
 * signed transaction must be the claim the desk issued (same hash), carry both
 * signatures, and — the escrow-specific part — claim EXACTLY the balance this
 * record names. Without that last check a signature collected for one escrow
 * could be replayed against another order's queue entry.
 */
function verifyEscrowAgainstChallenge(signedXdr: string, rec: DeskRecord): string | null {
  const ch = rec.challenge!;
  let signed: any;
  try {
    signed = TransactionBuilder.fromXDR(signedXdr, passphrase(recNetwork(rec)));
  } catch {
    return "the phone returned something that is not a valid transaction for this network";
  }
  const hash = Buffer.from(signed.hash()).toString("hex");
  if (hash !== ch.hash) {
    return `signed a different transaction (${hash.slice(0, 12)}… was not issued for ${rec.id}, which is ${ch.hash.slice(0, 12)}…)`;
  }
  if (signed.signatures.length < 2) {
    return `only ${signed.signatures.length} signature(s); the vault needs 2`;
  }
  const op = signed.operations?.[0];
  if (!op || op.type !== "claimClaimableBalance") return "the transaction is not an escrow claim";
  if (op.balanceId !== rec.escrowId) {
    return `the claim targets ${String(op.balanceId).slice(0, 12)}…, not the escrow ${String(rec.escrowId).slice(0, 12)}… this approval is for`;
  }
  return null;
}

function readBody(req: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 64_000) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Read one cookie out of the request header. No dependency for this. */
function cookieOf(req: IncomingMessage, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function same(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type DeskRecord = {
  id: string;
  at: number;
  uri: string;
  price: string;
  body: string;
  status: "pending" | "awaiting_phone" | "approved" | "denied" | "settled" | "failed" | "expired";
  content?: string;
  tx?: string;
  reason?: string;
  /**
   * Dedupe key: same buyer + same request + same price. Without it, every retry
   * after an approval parks a NEW payment, so a human approving twice pays
   * twice and the buyer never gets the content they already bought.
   */
  key?: string;
  /**
   * The failure came from the seller's spending mandate, not from the ledger.
   * The gateway needs this distinction: a ledger failure is worth retrying, a
   * mandate refusal never changes, so re-parking the same request would loop
   * forever — refuse, and make the buyer change the request to ask again.
   */
  mandateBlocked?: boolean;
  /** split mode: what the phone is asked to sign, and what it sent back */
  challenge?: ApprovalChallenge;
  qr?: string;
  signedXdr?: string;
  /**
   * What the human is being asked to authorise. `payment` is the vault paying
   * money OUT. `escrow` is the vault claiming a claimable balance the buyer
   * already locked — money coming IN. The distinction is load-bearing: the
   * spending mandate caps payments out, so it must not touch an escrow
   * release, and the signed transaction is verified against a different
   * operation type.
   */
  kind?: "payment" | "escrow";
  /** escrow records: the claimable balance to claim, and the order it belongs to */
  escrowId?: string;
  order?: string;
  /** escrow records: the asset the balance pays out ("XLM", "USDC", ...) */
  asset?: string;
};

export type DeskStore = DeskRecord;

export type DeskConfig = {
  vault: StellarVault;
  payee: string;
  /** seeds of the two human keys. DEV ONLY — in production these live on the phone. */
  principal?: string;
  approver?: string;
  /**
   * Split signing: the desk holds only the agent/principal half. Approving
   * produces a challenge the phone signs offline; the signature comes back and
   * the desk submits it. The approver seed never touches this machine.
   */
  split?: boolean;
  /**
   * The agent seed (the machine-side key). Payments are built with the
   * principal key; an ESCROW CLAIM is built with the agent key — that is the
   * key pair the escrow was designed around (agent + phone approver). The desk
   * needs it to build the release challenge, exactly as it needs the principal
   * seed to build a payment challenge. It is not the approving half: the claim
   * still needs the phone's signature to reach the vault's threshold of 2.
   */
  agentSeed?: string;
  /** how long a human has to decide before the payment is dead */
  decideWithinSeconds?: number;
  port: number;
  /** If set, the portal and its actions require this key in the URL.
   *  Required before putting the desk on any public URL. */
  portalKey?: string;
  /**
   * The hostname this desk is served on, e.g. "desk.paydlux.com". When set, the
   * desk answers ONLY requests for that Host. A named Cloudflare tunnel gives
   * real TLS on your own domain, but the local port it forwards to is still
   * plain HTTP: if anything on this machine (or network) reached 127.0.0.1:4022
   * directly it would bypass TLS and the HSTS/cookie protections the domain
   * gives you. Pinning the Host means the only way in is through the tunnel.
   */
  publicHost?: string;
  /**
   * The spending mandate. Optional only so existing tests keep compiling; every
   * real seller passes one.
   *
   * Enforced HERE, at the moment money moves, not in the gateway. The gateway is
   * the buyer's surface: it can be restarted, bypassed, or run by someone who
   * forgot to configure it. The desk is the one place every payment passes
   * through on its way to the ledger — dev mode signs and submits here, split
   * mode submits the phone's signature here — so this is the only place a
   * ceiling can actually hold.
   */
  policy?: PolicyEngine;
};

export class ApprovalDesk {
  private records = new Map<string, DeskRecord>();
  private seq = 0;
  private server?: ReturnType<typeof createServer>;
  cfg: DeskConfig;

  constructor(cfg: DeskConfig) { this.cfg = cfg; }

  /**
   * A request the human never answered is not waiting forever.
   *
   * The transaction the phone signs carries Stellar time bounds, so past
   * `expiresAt` the ledger rejects it no matter who signs it. Until this sweep
   * existed such a request stayed `awaiting_phone` for good: it showed in the
   * queue as approvable, held its price against the daily budget so later
   * payments were refused for a money that could never move, and the buyer's
   * retry kept reusing the dead handle instead of parking a fresh one. Three
   * wrong behaviours from one missing transition, which is why the transition
   * lives here rather than in the page that draws the word "expired".
   *
   * Called from every read path, so no caller can observe a stale state.
   */
  private sweepExpired(): void {
    const now = Date.now();
    // A request nobody has even opened yet gets the same window as one the
    // phone is holding: the seller said how long a human has to decide, and a
    // parked request past that window is not going to be answered. Leaving it
    // `pending` forever means the buyer's retry keeps reusing a handle that
    // will never move, instead of parking a fresh one a human will actually see.
    const decideWindow = (this.cfg.decideWithinSeconds ?? 1800) * 1000;
    for (const r of this.records.values()) {
      let deadline: number | null = null;
      if (r.status === "pending") {
        deadline = r.at + decideWindow;
      } else if (r.status === "awaiting_phone" || r.status === "approved") {
        deadline = r.challenge?.summary.expiresAt ? Number(r.challenge.summary.expiresAt) * 1000 : null;
      }
      if (deadline === null || deadline > now) continue;
      r.status = "expired";
      r.reason = `nobody approved it before the deadline (${new Date(deadline).toISOString()})`;
      console.log(`[desk] ${r.id} expired: the deadline passed with no approval`);
    }
  }

  enqueue(uri: string, price: string, body: string, content: string, key?: string): string {
    this.sweepExpired();
    // Re-use an existing request for the same buyer + body + price. A buyer who
    // retries after a human approved must get their content, not a second
    // payment waiting in the queue. Settled records are NOT reused here — the
    // gateway decides how long a paid-for request stays free to collect.
    if (key) {
      const hit = this.allByKey(key).find((r) => r.status === "pending" || r.status === "awaiting_phone");
      if (hit) return hit.id;
    }
    const id = `pay_${(++this.seq).toString().padStart(4, "0")}`;
    this.records.set(id, { id, at: Date.now(), uri, price, body, status: "pending", content, key });
    console.log(`[desk] ${id} awaiting a human: ${price} for ${uri}`);
    return id;
  }

  /** Every record carrying this key, newest first. */
  allByKey(key: string): DeskRecord[] {
    this.sweepExpired();
    if (!key) return [];
    return [...this.records.values()].filter((r) => r.key === key).sort((a, b) => b.at - a.at);
  }

  findByKey(key: string): DeskRecord | null {
    return this.allByKey(key)[0] ?? null;
  }

  /**
   * Queue an escrow release for the human. This is the missing half of
   * `paydlux escrow --release` on a --split vault: the money already sits in a
   * claimable balance the buyer locked, so releasing it is the vault CLAIMING
   * that balance — money coming IN, not going out. The claim still needs the
   * vault's threshold of 2 (agent + approver), and the approver half lives on
   * the phone, so it goes through the same challenge/sign/submit loop as a
   * payment, tagged `kind: "escrow"` so the spending mandate — which caps
   * money OUT — never touches it.
   *
   * The generic fields (uri/price/body) are filled so the portal page renders
   * the row without knowing about escrow; the structured fields carry the
   * truth the verification uses.
   */
  addEscrow(input: {
    escrowId: string;
    order?: string;
    amount: string;
    asset: string;
    buyer?: string;
  }): DeskRecord {
    this.sweepExpired();
    // One live record per balance id. A seller who runs --release twice must
    // not get two Approve buttons for the same money: the second signature
    // would fail on the ledger (balance already claimed) and confuse the human.
    for (const r of this.records.values()) {
      if (r.kind === "escrow" && r.escrowId === input.escrowId &&
          r.status !== "denied" && r.status !== "failed" && r.status !== "expired") return r;
    }
    const id = `esc_${input.escrowId.slice(-8)}${randomBytes(3).toString("hex")}`;
    const label = input.order || `${input.escrowId.slice(0, 16)}…`;
    const rec: DeskRecord = {
      id, at: Date.now(),
      uri: `/escrow/${label}`,
      // amount only, like a payment price; the asset rides in `asset` and
      // reaches the phone as `token`, so the row never prints "3.5 XLM XLM".
      price: input.amount,
      body: `escrow release — buyer ${input.buyer ?? "?"} — balance ${input.escrowId}`,
      status: "pending",
      kind: "escrow", escrowId: input.escrowId, order: input.order, asset: input.asset,
    };
    this.records.set(id, rec);
    console.log(`[desk] ${id} escrow release awaiting a human: ${rec.price} (${label})`);
    return rec;
  }

  get(id: string) { this.sweepExpired(); return this.records.get(id) ?? null; }
  list(): DeskRecord[] { this.sweepExpired(); return [...this.records.values()]; }

  /**
   * The human clicked Approve.
   *
   * dev mode  (approver seed present): sign and submit here. One machine holds
   *             both keys, which is fine for a testnet demo and nothing else.
   * split mode (no approver seed):     build the challenge, sign it with the
   *             principal only, and hand it to the phone. The money moves when
   *             /signed comes back with the phone's signature.
   */
  /**
   * The mandate check, in one place, called before money moves.
   *
   * Returns null when the payment is allowed, or the reason it is not. The
   * record is marked failed so the buyer's poll gets a real answer instead of a
   * timeout, and the reason is surfaced to the human rather than logged only.
   *
   * Why this exists at all: `--max` and `--daily` were printed in the seller's
   * banner and never applied to anything. A ceiling nobody enforces is worse
   * than no ceiling, because the seller believes they have one.
   */
  private mandateBlock(rec: DeskRecord, when: string): string | null {
    const policy = this.cfg.policy;
    if (!policy) return null;
    // Approvals already made that have not settled yet. Those are promises the
    // seller has already given, so a new one has to fit alongside them.
    // `pending` deliberately does NOT count: that is a request nobody has
    // approved, and counting the whole queue would refuse the first approval
    // just because more requests exist than the budget can cover.
    const committed = this.list().reduce((sum, r) =>
      (r.id !== rec.id && (r.status === "awaiting_phone" || r.status === "approved"))
        ? sum + Number(r.price) : sum, 0);
    const verdict = policy.check({
      amount: Number(rec.price),
      payee: this.cfg.payee,
      ttl: this.cfg.decideWithinSeconds,
      committed,
    });
    if (verdict.ok) return null;
    rec.status = "failed";
    rec.reason = `mandate refused (${verdict.rule}): ${verdict.detail}`;
    rec.mandateBlocked = true;
    rec.challenge = undefined;
    rec.signedXdr = undefined;
    console.log(`[desk] ${rec.id} ${when}: ${rec.reason}`);
    return rec.reason;
  }

  /** The mandate has been satisfied: count the money as spent. */
  private recordSpend(rec: DeskRecord, tx: string) {
    this.cfg.policy?.record({
      at: Date.now(), amount: Number(rec.price), payee: this.cfg.payee,
      uri: rec.uri, mandateHash: tx,
    });
  }

  async approve(id: string) {
    this.sweepExpired();
    const rec = this.records.get(id);
    if (!rec) throw new Error("unknown handle " + id);
    if (rec.status !== "pending") throw new Error(`already ${rec.status}`);
    // An escrow release is money coming IN. The spending mandate caps money
    // going OUT, so applying it here would refuse a release for a budget that
    // the release does not touch — and would make the seller's own money
    // unclaimable on a day they already spent.
    if (rec.kind === "escrow") {
      // dev mode (both keys on this machine): claim straight away.
      if (this.cfg.approver && this.cfg.agentSeed) {
        try {
          const out = await claimEscrow(
            this.cfg.vault.network, rec.escrowId!, this.cfg.vault.address,
            { agent: Keypair.fromSecret(this.cfg.agentSeed), approver: Keypair.fromSecret(this.cfg.approver) },
          );
          rec.status = "settled";
          rec.tx = out.txHash;
          console.log(`[desk] ${rec.id} ESCROW RELEASED ${rec.price} — ledger ${rec.tx}`);
        } catch (e) {
          rec.status = "failed";
          rec.reason = (e as Error).message;
        }
        return rec;
      }
      return this.requestEscrowSignature(rec);
    }
    // Check before asking the phone. A human who approves a payment the mandate
    // will refuse has spent a Face ID scan and a signature for nothing.
    if (this.mandateBlock(rec, "refused before asking")) return rec;
    if (this.cfg.split) return this.requestPhoneSignature(rec);
    if (!this.cfg.principal || !this.cfg.approver) {
      rec.status = "failed";
      rec.reason = "no human keys configured (portal signing not wired yet)";
      return rec;
    }
    try {
      const res = await this.cfg.vault.release(
        this.cfg.payee, rec.price,
        Keypair.fromSecret(this.cfg.principal),
        Keypair.fromSecret(this.cfg.approver),
        id,
      );
      rec.status = "settled";
      rec.tx = String(res?.hash ?? "");
      this.recordSpend(rec, rec.tx);
    } catch (e) {
      rec.status = "failed";
      rec.reason = (e as Error).message;
    }
    return rec;
  }

  /** Split mode step 1: ask the phone to sign. Nothing is submitted yet. */
  private async requestPhoneSignature(rec: DeskRecord) {
    if (!this.cfg.principal) {
      rec.status = "failed";
      rec.reason = "split mode needs the principal seed on the seller's side";
      return rec;
    }
    try {
      const challenge = await createApprovalChallenge({
        vaultAddress: this.cfg.vault.address,
        principal: Keypair.fromSecret(this.cfg.principal),
        payee: this.cfg.payee,
        amount: rec.price,
        tokenCode: this.cfg.vault.token.getCode(),
        tokenIssuer: this.cfg.vault.token.getIssuer() ?? "",
        // Stated, not inferred from the name: a token someone issued and
        // called XLM must not be turned into native XLM on the way to the
        // phone, because that would change what the human is approving.
        native: this.cfg.vault.isNative,
        network: this.cfg.vault.network,
        horizon: this.cfg.vault.horizon,
        id: rec.id,
        memo: rec.id,
        decideWithinSeconds: this.cfg.decideWithinSeconds,
      });
      rec.challenge = challenge;
      rec.qr = challengeQrPayload(challenge);
      rec.status = "awaiting_phone";
      console.log(`[desk] ${rec.id} sent to the phone: ${rec.price} for ${rec.uri}`);
    } catch (e) {
      rec.status = "failed";
      rec.reason = (e as Error).message;
    }
    return rec;
  }

  /**
   * Split mode step 1 for an ESCROW release: build the claim, sign it with the
   * agent key, hand it to the phone. `prepareEscrowRelease` reads the ledger
   * and refuses a balance that does not exist or whose timer has not passed,
   * so a queued-but-fake escrow dies here with a real reason instead of
   * reaching the human as a signable challenge.
   */
  private async requestEscrowSignature(rec: DeskRecord) {
    if (!this.cfg.agentSeed) {
      rec.status = "failed";
      rec.reason = "an escrow release needs the agent seed on this machine to build the claim";
      return rec;
    }
    try {
      const challenge = await prepareEscrowRelease(
        this.cfg.vault.network, rec.escrowId!, this.cfg.vault.address,
        Keypair.fromSecret(this.cfg.agentSeed),
      );
      // The challenge carries its own id; keep the desk's handle so
      // /challenge/:id and /signed/:id line up with what the queue shows.
      challenge.id = rec.id;
      rec.challenge = challenge;
      rec.qr = challengeQrPayload(challenge);
      rec.status = "awaiting_phone";
      console.log(`[desk] ${rec.id} escrow claim sent to the phone: ${rec.price}`);
    } catch (e) {
      rec.status = "failed";
      rec.reason = (e as Error).message;
      console.log(`[desk] ${rec.id} escrow claim refused before asking: ${rec.reason}`);
    }
    return rec;
  }

  /**
   * Split mode step 2 for an ESCROW release: the phone signed the claim.
   * No mandate check — this is money coming IN — and no recordSpend: the
   * daily budget counts payments OUT, and counting a release against it would
   * make the seller's own earned money unclaimable.
   */
  private async completeEscrow(rec: DeskRecord, signedXdr: string) {
    const problem = verifyEscrowAgainstChallenge(signedXdr, rec);
    if (problem) {
      rec.status = "failed";
      rec.reason = problem;
      console.log(`[desk] ${rec.id} rejected: ${problem}`);
      return rec;
    }
    rec.signedXdr = signedXdr;
    try {
      const res = await submitApproved(signedXdr, this.cfg.vault.network, this.cfg.vault.horizon);
      rec.status = "settled";
      rec.tx = res.hash;
      console.log(`[desk] ${rec.id} ESCROW RELEASED ${rec.price} — ledger ${rec.tx}`);
    } catch (e) {
      rec.status = "failed";
      rec.reason = (e as Error).message;
      console.log(`[desk] ${rec.id} failed on the ledger: ${rec.reason}`);
    }
    return rec;
  }

  /**
   * Split mode step 2: the phone answered. `signedXdr` is the transaction with
   * the approver signature added, returned by signChallenge() on the phone.
   * The desk cannot forge this: it does not hold the approver key, and the
   * ledger rejects it if the signature is not over this exact transaction.
   */
  async complete(id: string, signedXdr: string) {
    this.sweepExpired();
    const rec = this.records.get(id);
    if (!rec) throw new Error("unknown handle " + id);
    if (rec.status !== "awaiting_phone") throw new Error(`not awaiting a phone signature (it is ${rec.status})`);
    if (!rec.challenge) throw new Error("no challenge was issued for " + id);
    // An escrow release verifies against its own shape (a claim of THIS
    // balance id) and bypasses the spending mandate, which only caps payments
    // going out.
    if (rec.kind === "escrow") return this.completeEscrow(rec, signedXdr);

    // Bind the answer to the question. Without this check the desk would submit
    // any signed transaction posted to this route — including one the phone
    // signed for a DIFFERENT payment, at a different price. That is how a
    // payments bug becomes a wrong-amount bug.
    const problem = verifyAgainstChallenge(signedXdr, rec);
    if (problem) {
      rec.status = "failed";
      rec.reason = problem;
      console.log(`[desk] ${id} rejected: ${problem}`);
      return rec;
    }

    // Re-check at the last possible moment. The budget was verified when the
    // phone was asked; a day is long and other payments have been approved since.
    // Better to refuse now than to submit a payment the mandate forbids.
    if (this.mandateBlock(rec, "refused at submission")) return rec;

    rec.signedXdr = signedXdr;
    try {
      const res = await submitApproved(signedXdr, this.cfg.vault.network, this.cfg.vault.horizon);
      rec.status = "settled";
      rec.tx = res.hash;
      this.recordSpend(rec, res.hash);
      // The money moving is the one event a seller should never have to
      // discover by refreshing a page.
      console.log(`[desk] ${rec.id} PAID ${rec.price} ${this.cfg.vault.token.getCode()} — ledger ${rec.tx}`);
    } catch (e) {
      rec.status = "failed";
      rec.reason = (e as Error).message;
      console.log(`[desk] ${rec.id} failed on the ledger: ${rec.reason}`);
    }
    return rec;
  }

  /**
   * The human said no.
   *
   * `awaiting_phone` is a valid state to deny from. Opening the phone link
   * builds the challenge on the spot (so a human needs one tap, not two), which
   * means the first thing a person sees on their phone is already
   * `awaiting_phone` — refusing to deny from that state left the Reject button
   * dead, which was verified on live testnet. Denying is always allowed up to
   * the point the transaction is submitted; after that it is too late.
   */
  deny(id: string, reason = "denied by the approver") {
    const rec = this.records.get(id);
    if (!rec) throw new Error("unknown handle " + id);
    if (rec.status === "settled") throw new Error("already settled — the money has moved, it cannot be denied");
    if (rec.status === "denied") return rec;          // idempotent: the app may retry
    rec.status = "denied";
    rec.reason = reason;
    rec.challenge = undefined;                        // the phone's answer is now worthless
    rec.signedXdr = undefined;
    return rec;
  }

  /**
   * What the phone app is allowed to see. Never the paid `content` — that is
   * what the buyer has not paid for yet — and never the raw challenge XDR,
   * which the app fetches per item so the desk can re-check the binding.
   */
  queue(): Record<string, unknown>[] {
    return this.list().map((r) => ({
      id: r.id,
      at: r.at,
      uri: r.uri,
      price: r.price,
      status: r.status,
      reason: r.reason,
      tx: r.tx,
      /** what the buyer says it wants. Agent-controlled text: render as text. */
      wants: (r.body ?? "").slice(0, 200),
      token: r.kind === "escrow" ? r.asset ?? this.cfg.vault.token.getCode() : this.cfg.vault.token.getCode(),
      expiresAt: r.challenge?.summary.expiresAt,
      hash: r.challenge?.hash,
      // The phone renders an escrow row differently: it is money IN, and the
      // human verifies the balance id, not a payee.
      kind: r.kind ?? "payment",
      escrowId: r.escrowId,
      order: r.order,
    }));
  }

  /** Serve the pending list as JSON (the portal polls this). */
  api(handler: (req: IncomingMessage, res: ServerResponse) => void) { return handler; }

  listen(port = this.cfg.port) {
    // A desk reachable from outside this machine must be gated. This is a
    // startup refusal rather than a runtime one because the dangerous case is
    // forgetting a flag: a public desk with no portal key is an open approval
    // button, and it would otherwise start up looking completely healthy.
    if (this.cfg.publicHost && !this.cfg.portalKey) {
      throw new Error(
        "a desk served on " + this.cfg.publicHost + " needs a portalKey; " +
        "refusing to start an ungated approval desk");
    }
    const srv = createServer(async (req, res) => {
      // (server handle kept below so close() can stop it)
      const url = new URL(req.url ?? "/", "http://localhost");
      // Order matters. The Host pin runs first so a request that did not come
      // through the tunnel is refused before the desk reveals anything about
      // itself, including whether a portal key looks correct.
      if (this.cfg.publicHost) {
        const want = this.cfg.publicHost.toLowerCase();
        const got = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
        if (got !== want) {
          res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
          res.end("403 — this desk only answers on " + want + ".");
          return;
        }
        // Cloudflare terminates TLS and forwards both http and https to us, so
        // http://desk.paydlux.com answers too unless we send it away. A human
        // approving a payment over plain HTTP is handing the portal key and the
        // transaction to anyone on the path, so plain HTTP gets a redirect and
        // nothing else. x-forwarded-proto is set by Cloudflare, not the client.
        if (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "http") {
          res.writeHead(301, { location: "https://" + want + (req.url ?? "/") });
          res.end();
          return;
        }
        // Once HTTPS is established, tell the browser to never try plain HTTP
        // again for this host.
        res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
      }
      // Security headers on every response, including the 403. These are set
      // before routing so no branch can forget them.
      //
      // default-src 'self' plus script-src 'self' is the load-bearing one: the
      // portal renders text the buyer's agent chose (its request path and body),
      // so if an escaping bug ever let markup through, CSP still stops it from
      // running or phoning home. Escaping is the fix; CSP is the net under it.
      // frame-ancestors stops another site framing the Approve button, and
      // no-referrer keeps the portal key out of any third-party Referer header.
      res.setHeader("content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader("x-frame-options", "DENY");
      res.setHeader("referrer-policy", "no-referrer");
      res.setHeader("x-content-type-options", "nosniff");
      res.setHeader("cache-control", "no-store");

      // Liveness probe, before the portal-key gate: it proves the desk and its
      // TLS path are up without revealing anything. No data, safe to poll.
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("ok");
        return;
      }
      // The approver app's static shell is served BEFORE the key gate, on
      // purpose. It is index.html, app.js, xdr.js, the icons and the manifest:
      // client code with no secret and no payment data in it, the same as the
      // portal's own portal.js. Serving it unauthenticated is what lets a phone
      // install it to a home screen from a plain URL, with the seller's key
      // arriving separately in the link. Everything that carries data or moves
      // money — /queue, /challenge, /list, /approve, /deny, /signed — stays
      // behind the gate below.
      //
      // The app uses relative script srcs, so it must be served from a
      // directory URL: /phone without the slash would resolve app.js to /app.js.
      if (url.pathname === "/phone") {
        res.writeHead(302, { location: "/phone/" + url.search });
        res.end();
        return;
      }
      if (url.pathname === "/phone/" || url.pathname === "/phone/index.html") {
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          // The approver key goes in IndexedDB behind a non-extractable
          // CryptoKey; an injected script is the realistic threat, so lock the
          // origin. No inline script on the page: app.js and xdr.js are
          // separate files, so script-src 'self' actually holds. connect-src
          // 'self' is what stops the app talking anywhere but the desk that
          // served it.
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
            "form-action 'none'; frame-ancestors 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
        });
        const page = readAppFile("index.html");
        if (page === null) return notFound(res);
        res.end(page);
        return;
      }
      if (url.pathname.startsWith("/phone/")) {
        const file = url.pathname.slice("/phone/".length);
        // Icons and the manifest are part of installing the app to a home
        // screen, so they are served alongside the code. Names are still
        // stripped to a safe set before they touch a path.
        if (!/^[a-z0-9_-]+\.(js|png|webmanifest)$/.test(file)) return notFound(res);
        const type = file.endsWith(".png") ? "image/png"
          : file.endsWith(".webmanifest") ? "application/manifest+json"
          : "text/javascript";
        const body = readAppFile(file);
        if (body === null) return notFound(res);
        res.writeHead(200, {
          "content-type": type + (file.endsWith(".png") ? "" : "; charset=utf-8"),
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        });
        res.end(body);
        return;
      }

      // A public demo link must not be an open approval button. If a portalKey
      // is configured, every route needs it, or the desk answers 403.
      //
      // The key may arrive in the URL (the link the human opened) or in a
      // cookie the desk set when that link was first validated. The cookie is
      // what makes the approver app work: its <script src="xdr.js"> cannot
      // inherit ?k= from the page URL, so without a cookie the app 403s on its
      // own code and shows a blank form. HttpOnly + SameSite=Strict + Secure
      // keeps it out of the DOM and off any cross-site request.
      const presented = url.searchParams.get("k") ?? cookieOf(req, "pd_portal");
      if (this.cfg.portalKey && !same(presented ?? "", this.cfg.portalKey)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("403 — this approval link was never issued or has been rotated.");
        return;
      }
      if (this.cfg.portalKey && url.searchParams.get("k") !== null) {
        res.setHeader("set-cookie",
          `pd_portal=${this.cfg.portalKey}; Path=/; HttpOnly; SameSite=Strict; ` +
          `Secure; Max-Age=${12 * 3600}`);
      }
      const qs = url.search;
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      try {
        if (url.pathname === "/") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(portalPage(this.list(), this.cfg.vault.address, this.cfg.vault.network, qs));
          return;
        }
        // The portal's own css and js. Served as separate files, never inline,
        // so script-src 'self' and style-src 'self' actually hold on the
        // approval page and an injected string can't become executable script.
        if (url.pathname === "/portal.js" || url.pathname === "/portal.css") {
          const file = url.pathname.slice(1);
          const body = readPortalFile(file);
          if (body === null) return notFound(res);
          res.writeHead(200, {
            "content-type": (file.endsWith(".css") ? "text/css" : "text/javascript") + "; charset=utf-8",
            "x-content-type-options": "nosniff",
          });
          res.end(body);
          return;
        }
        if (url.pathname === "/list") return send(200, this.list());

        // The approver app's list view. Key-gated like everything else, and it
        // carries no paid content and no challenge XDR.
        if (url.pathname === "/queue") return send(200, this.queue());
        // The app fetches the pending transaction by handle rather than asking
        // the human to paste 400 characters of base64 on a phone.
        const ch = url.pathname.match(/^\/challenge\/([\w-]+)$/);
        if (ch) {
          const rec = this.records.get(ch[1]);
          if (!rec) return send(404, { error: "unknown handle" });
          // Opening the phone link IS the approval gesture, so build the
          // challenge here if nobody pressed the button yet. The human should
          // need one link, not a button on a desktop plus a link on a phone.
          if (rec.status === "pending") await this.approve(rec.id);
          if (!rec.challenge) return send(409, { error: `not awaiting a phone signature (it is ${rec.status})` });
          return send(200, {
            id: rec.id, network: rec.challenge.network,
            hash: rec.challenge.hash, xdr: rec.challenge.xdr,
            // Which key this vault will actually accept. A phone holding a key
            // from a previous run signs a valid signature over a valid
            // transaction, and the ledger answers BAD_AUTH with no explanation.
            // Naming the expected key here lets the app say so BEFORE signing.
            approver: this.cfg.vault.signers.approver,
            // what the human is being asked to read. Agent-controlled text: the
            // app renders it as text, never as markup.
            wants: (rec.body ?? "").slice(0, 200),
            memo: rec.challenge.summary.memo ?? "",
            expiresAt: rec.challenge.summary.expiresAt,
            // An escrow challenge renders differently on the phone: the op
            // carries no amount and no payee, so the app shows the amount from
            // here and asks the human to check the balance id.
            kind: rec.kind ?? "payment",
            escrowId: rec.escrowId,
            // The claim op carries no amount, so the phone shows the amount
            // the desk read from the ledger alongside the balance id it puts
            // in front of the human.
            amount: rec.kind === "escrow" ? rec.price : undefined,
            asset: rec.kind === "escrow" ? rec.asset : undefined,
          });
        }

        // The CLI's hand-off for `paydlux escrow --release` on a --split vault:
        // queue this balance on the running desk so the phone can sign it.
        // Key-gated like every other route, and it only queues — approving
        // still needs the human's hold-and-sign on the phone.
        if (url.pathname === "/escrow" && req.method === "POST") {
          const body = await readBody(req);
          const input = JSON.parse(body || "{}");
          if (!input.escrowId) return send(400, { error: "escrowId is required" });
          if (!input.amount || !input.asset) return send(400, { error: "amount and asset are required" });
          const rec = this.addEscrow({
            escrowId: String(input.escrowId),
            order: input.order ? String(input.order) : undefined,
            amount: String(input.amount),
            asset: String(input.asset),
            buyer: input.buyer ? String(input.buyer) : undefined,
          });
          return send(200, { id: rec.id, status: rec.status, escrowId: rec.escrowId });
        }

        const m = url.pathname.match(/^\/(approve|deny|signed)\/([\w-]+)$/);
        if (m && req.method === "POST") {
          // These routes move money, so they must not be reachable from another
          // page. A cross-origin fetch POST is a CORS *simple request*: no
          // preflight, so the attacker's page never sees the reply but the
          // approval still happens. Verified end to end: a page on another port
          // settled a parked payment and paid the seller. Browsers always send
          // Origin on POST and Sec-Fetch-Site on every request, so checking both
          // closes that path while leaving local automation (curl, tests, the
          // phone app on its own origin) alone.
          const origin = String(req.headers.origin ?? "");
          if (origin) {
            const here = String(req.headers.host ?? "").toLowerCase();
            let oh: string;
            try { oh = new URL(origin).host.toLowerCase(); } catch { oh = ""; }
            if (oh !== here) {
              return send(403, { error: "cross_origin", reason: `this desk only accepts actions from itself, not from ${origin}` });
            }
          }
          const site = String(req.headers["sec-fetch-site"] ?? "").toLowerCase();
          if (site && site !== "same-origin" && site !== "none") {
            return send(403, { error: "cross_origin", reason: `this desk only accepts same-site actions (got ${site})` });
          }
          if (m[1] === "signed") {
            const body = await readBody(req);
            const { signedXdr } = JSON.parse(body || "{}");
            if (!signedXdr) return send(400, { error: "signedXdr is required" });
            return send(200, await this.complete(m[2], String(signedXdr)));
          }
          const rec = m[1] === "approve" ? await this.approve(m[2]) : this.deny(m[2]);
          return send(200, rec);
        }
        return send(404, { error: "not found" });
      } catch (e) {
        return send(400, { error: (e as Error).message });
      }
    });
    this.server = srv;
    // Loopback only. The public path is the Cloudflare tunnel, which connects
    // back to 127.0.0.1; binding to 0.0.0.0 would expose a plain-HTTP desk to
    // the LAN and defeat both the TLS and the Host pin above.
    return new Promise<void>((r) => srv.listen(port, "127.0.0.1", () => r()));
  }

  /** Stop serving. Without this the process never exits. */
  close() {
    return new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
    });
  }
}