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
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { passphrase } from "./vault.ts";
import type { StellarVault } from "./vault.ts";
import { portalPage } from "./portal.ts";
import {
  createApprovalChallenge, submitApproved, challengeQrPayload,
  type ApprovalChallenge,
} from "./phone.ts";

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
  status: "pending" | "awaiting_phone" | "approved" | "denied" | "settled" | "failed";
  content?: string;
  tx?: string;
  reason?: string;
  /** split mode: what the phone is asked to sign, and what it sent back */
  challenge?: ApprovalChallenge;
  qr?: string;
  signedXdr?: string;
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
  /** how long a human has to decide before the payment is dead */
  decideWithinSeconds?: number;
  port: number;
  /** If set, the portal and its actions require this key in the URL.
   *  Required before putting the desk on any public URL. */
  portalKey?: string;
};

export class ApprovalDesk {
  private records = new Map<string, DeskRecord>();
  private seq = 0;
  private server?: ReturnType<typeof createServer>;
  cfg: DeskConfig;

  constructor(cfg: DeskConfig) { this.cfg = cfg; }

  enqueue(uri: string, price: string, body: string, content: string): string {
    const id = `pay_${(++this.seq).toString().padStart(4, "0")}`;
    this.records.set(id, { id, at: Date.now(), uri, price, body, status: "pending", content });
    console.log(`[desk] ${id} awaiting a human: ${price} for ${uri}`);
    return id;
  }

  get(id: string) { return this.records.get(id) ?? null; }
  list(): DeskRecord[] { return [...this.records.values()]; }

  /**
   * The human clicked Approve.
   *
   * dev mode  (approver seed present): sign and submit here. One machine holds
   *             both keys, which is fine for a testnet demo and nothing else.
   * split mode (no approver seed):     build the challenge, sign it with the
   *             principal only, and hand it to the phone. The money moves when
   *             /signed comes back with the phone's signature.
   */
  async approve(id: string) {
    const rec = this.records.get(id);
    if (!rec) throw new Error("unknown handle " + id);
    if (rec.status !== "pending") throw new Error(`already ${rec.status}`);
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
   * Split mode step 2: the phone answered. `signedXdr` is the transaction with
   * the approver signature added, returned by signChallenge() on the phone.
   * The desk cannot forge this: it does not hold the approver key, and the
   * ledger rejects it if the signature is not over this exact transaction.
   */
  async complete(id: string, signedXdr: string) {
    const rec = this.records.get(id);
    if (!rec) throw new Error("unknown handle " + id);
    if (rec.status !== "awaiting_phone") throw new Error(`not awaiting a phone signature (it is ${rec.status})`);
    if (!rec.challenge) throw new Error("no challenge was issued for " + id);

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

    rec.signedXdr = signedXdr;
    try {
      const res = await submitApproved(signedXdr, this.cfg.vault.network, this.cfg.vault.horizon);
      rec.status = "settled";
      rec.tx = res.hash;
    } catch (e) {
      rec.status = "failed";
      rec.reason = (e as Error).message;
    }
    return rec;
  }

  deny(id: string, reason = "denied by the approver") {
    const rec = this.records.get(id);
    if (!rec) throw new Error("unknown handle " + id);
    if (rec.status !== "pending") throw new Error(`already ${rec.status}`);
    rec.status = "denied";
    rec.reason = reason;
    return rec;
  }

  /** Serve the pending list as JSON (the portal polls this). */
  api(handler: (req: IncomingMessage, res: ServerResponse) => void) { return handler; }

  listen(port = this.cfg.port) {
    const srv = createServer(async (req, res) => {
      // (server handle kept below so close() can stop it)
      const url = new URL(req.url ?? "/", "http://localhost");
      // A public demo link must not be an open approval button. If a portalKey
      // is configured, every route needs it, or the desk answers 403.
      if (this.cfg.portalKey && !same(url.searchParams.get("k") ?? "", this.cfg.portalKey)) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("403 — this approval link was never issued or has been rotated.");
        return;
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
        if (url.pathname === "/list") return send(200, this.list());
        const m = url.pathname.match(/^\/(approve|deny|signed)\/([\w-]+)$/);
        if (m && req.method === "POST") {
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
    return new Promise<void>((r) => srv.listen(port, () => r()));
  }

  /** Stop serving. Without this the process never exits. */
  close() {
    return new Promise<void>((r) => {
      if (!this.server) return r();
      this.server.close(() => r());
    });
  }
}
