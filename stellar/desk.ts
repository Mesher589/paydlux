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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * The approver app is plain static files under phone-app/. Read on each request
 * rather than bundled, so the desk and the app can never drift apart.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..", "phone-app");
const PORTAL_DIR = join(HERE, "..", "portal-app");
const staticCache = new Map<string, string>();

/**
 * Static files are read on each process start rather than bundled, so the desk
 * and its front ends can never drift apart. The name is stripped to [a-z.]
 * before it touches a path, so a request can't walk out of the directory.
 */
function readStatic(dir: string, name: string, label: string): string {
  const safe = name.replace(/[^a-z.]/g, "");
  const hit = staticCache.get(dir + "/" + safe);
  if (hit) return hit;
  let text: string;
  try {
    text = readFileSync(join(dir, safe), "utf8");
  } catch {
    // A package install that shipped without the folder should say so instead of
    // throwing out of the request handler.
    throw new Error(label + " is missing from this install (expected " + join(dir, safe) + ")");
  }
  staticCache.set(dir + "/" + safe, text);
  return text;
}
const readAppFile = (name: string) => readStatic(APP_DIR, name, "approver app");
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
  /**
   * The hostname this desk is served on, e.g. "desk.paydlux.com". When set, the
   * desk answers ONLY requests for that Host. A named Cloudflare tunnel gives
   * real TLS on your own domain, but the local port it forwards to is still
   * plain HTTP: if anything on this machine (or network) reached 127.0.0.1:4022
   * directly it would bypass TLS and the HSTS/cookie protections the domain
   * gives you. Pinning the Host means the only way in is through the tunnel.
   */
  publicHost?: string;
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
          res.writeHead(200, {
            "content-type": (file.endsWith(".css") ? "text/css" : "text/javascript") + "; charset=utf-8",
            "x-content-type-options": "nosniff",
          });
          res.end(readPortalFile(file));
          return;
        }
        if (url.pathname === "/list") return send(200, this.list());

        // The approver app. Served from the desk so the human opens one link on
        // their phone instead of pasting XDR around. The app itself makes no
        // requests after loading, and the portalKey gate above already covers
        // these paths: without the key, nothing here is reachable.
        // The app uses relative script srcs, so it must be served from a
        // directory URL. /phone without the slash would resolve app.js to
        // /app.js, so send it to the canonical path with the key intact.
        if (url.pathname === "/phone") {
          res.writeHead(302, { location: "/phone/" + url.search });
          res.end();
          return;
        }
        if (url.pathname === "/phone/" || url.pathname === "/phone/index.html") {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            // The key lives in IndexedDB behind a non-extractable CryptoKey;
            // an injected script is the realistic threat, so lock the origin.
            // No inline script on the page: app.js and xdr.js are separate
            // files, so script-src 'self' actually holds. connect-src 'self' is
            // what stops the app talking anywhere but the desk that served it.
            "content-security-policy":
              "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
              "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
              "form-action 'none'; frame-ancestors 'none'",
            "referrer-policy": "no-referrer",
            "x-content-type-options": "nosniff",
          });
          res.end(readAppFile("index.html"));
          return;
        }
        if (url.pathname.startsWith("/phone/")) {
          const file = url.pathname.slice("/phone/".length);
          if (!/^[a-z]+\.(js|css)$/.test(file)) return send(404, { error: "not found" });
          res.writeHead(200, {
            "content-type": (file.endsWith(".css") ? "text/css" : "text/javascript") + "; charset=utf-8",
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          res.end(readAppFile(file));
          return;
        }
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
          });
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
