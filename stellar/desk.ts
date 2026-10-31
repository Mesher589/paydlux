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
import { Keypair } from "stellar-sdk";
import type { StellarVault } from "./vault.ts";
import { portalPage } from "./portal.ts";

/** A portal link is a capability: whoever holds it can approve. So it is long,
 *  random, and compared without leaking timing. */
export function newPortalKey() { return randomBytes(16).toString("base64url"); }

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
  status: "pending" | "approved" | "denied" | "settled" | "failed";
  content?: string;
  tx?: string;
  reason?: string;
};

export type DeskStore = DeskRecord;

export type DeskConfig = {
  vault: StellarVault;
  payee: string;
  /** seeds of the two human keys. DEV ONLY — in production these live on the phone. */
  principal?: string;
  approver?: string;
  port: number;
  /** If set, the portal and its actions require this key in the URL.
   *  Required before putting the desk on any public URL. */
  portalKey?: string;
};

export class ApprovalDesk {
  private records = new Map<string, DeskRecord>();
  private seq = 0;
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

  /** The human clicked Approve: sign and submit the release. */
  async approve(id: string) {
    const rec = this.records.get(id);
    if (!rec) throw new Error("unknown handle " + id);
    if (rec.status !== "pending") throw new Error(`already ${rec.status}`);
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
        const m = url.pathname.match(/^\/(approve|deny)\/([\w-]+)$/);
        if (m && req.method === "POST") {
          const rec = m[1] === "approve" ? await this.approve(m[2]) : this.deny(m[2]);
          return send(200, rec);
        }
        return send(404, { error: "not found" });
      } catch (e) {
        return send(400, { error: (e as Error).message });
      }
    });
    return new Promise<void>((r) => srv.listen(port, () => r()));
  }
}
