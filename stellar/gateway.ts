// Paydlux gateway on Stellar — an HTTP resource server that answers 402 and
// only serves the body once payment has actually landed on the ledger.
//
// Two modes per route:
//
//   preauth   the human already registered a mandate envelope for this seller
//             and amount. The gateway hands it over, the agent signs, submits,
//             and the ledger enforces the cap. No human needed at buy time.
//
//   approval  nothing is pre-authorised. The gateway verifies the request,
//             holds it at the approval desk, and a person approves or denies.
//             On approval the vault releases with principal + approver.
//
// Either way the agent's key alone can never move money: threshold is 2.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { Keypair, StrKey, Transaction } from "@stellar/stellar-sdk";
import { StellarVault, StellarTxError, hex, passphrase, type Amount, type Mandate, type Network } from "./vault.ts";
import { ApprovalDesk, type DeskStore } from "./desk.ts";

export const PAY_HEADER = "x-payment";

export type Route = {
  uri: string;
  price: Amount;
  mode: "preauth" | "approval";
  /** seconds the seller's content stays reserved while a human decides */
  holdSeconds?: number;
  /**
   * How long one approved payment keeps buying this route. Defaults to
   * holdSeconds. Set it to 0 to make every single call cost its own approval.
   */
  collectSeconds?: number;
};

export type GatewayConfig = {
  vault: StellarVault;
  network: Network;
  /** the seller receiving payment (usually the vault owner's merchant account) */
  payee: string;
  routes: Route[];
  /** human keys. In production these live on the phone, never here. */
  principal?: string;
  approver?: string;
  /**
   * Split mode: the desk gets the principal key (the seller's own half) but NOT
   * the approver key, so this process cannot approve anything. Approval happens
   * on a second device through the approver app. Pass `approver: undefined`
   * together with this; the gateway still settles, using the signature the
   * phone sends back.
   */
  split?: boolean;
  deskPort?: number;
  /** gate the approval portal behind a single unguessable link */
  portalKey?: string;
  /** hostname the desk is publicly served on; pins the Host header. See DeskConfig. */
  publicHost?: string,
  /** how long a human gets to decide before the parked payment's tx is dead */
  decideWithinSeconds?: number,
  /**
   * Agent public keys allowed to park a payment for approval. An intent is only
   * honoured if it is signed by one of these, so an unlisted key gets a plain
   * 402 instead of a queue entry. Leave empty and nothing can request approval.
   */
  agentKeys?: string[];
  /**
   * Where a human approves, as the BUYER should see it. Set this to the public
   * desk URL (e.g. "https://desk.paydlux.com") when the desk is reachable there;
   * it is returned in the 202 so the buyer knows where to go. Defaults to the
   * loopback address, which is only useful on one machine.
   */
  deskUrl?: string;
};

export type PaymentProof = {
  /** pre-authorised envelope, base64 XDR, as issued by the vault */
  envelope?: string;
  /** hex hash of the envelope, also the vault's preauth signer */
  mandateHash?: string;
  /** approval mode: a signed statement of what the agent wants to buy */
  intent?: { payload: string; signature: string };
};

export class Gateway {
  private routes = new Map<string, Route>();
  private mandates = new Map<string, Mandate>();
  /** envelope hashes already redeemed, so one mandate = one delivery */
  private settled = new Set<string>();
  desk: ApprovalDesk;
  cfg: GatewayConfig;

  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
    this.agentKeys = cfg.agentKeys ?? [];
    for (const r of cfg.routes) this.routes.set(r.uri, r);
    this.desk = new ApprovalDesk({
      vault: cfg.vault,
      payee: cfg.payee,
      principal: cfg.principal,
      approver: cfg.approver,
      port: cfg.deskPort ?? 4022,
      portalKey: cfg.portalKey,
      split: cfg.split,
      publicHost: cfg.publicHost,
      decideWithinSeconds: cfg.decideWithinSeconds,
    });
  }

  /** Mandates the vault currently holds, so the gateway can hand them out. */
  async syncMandates() {
    const s = await this.cfg.vault.signerSummary();
    return s.signers.filter((x: { type: string }) => x.type === "preauth-mandate");
  }

  /** Register a pre-authorised mandate for a route (needs both human keys). */
  async authorise(uri: string, spec: Parameters<StellarVault["createMandate"]>[0], principal: Parameters<StellarVault["createMandate"]>[1], approver: Parameters<StellarVault["createMandate"]>[2]) {
    const r = this.routes.get(uri);
    if (!r) throw new Error(`no route ${uri}`);
    if (spec.payee !== this.cfg.payee) throw new Error("mandate payee does not match this gateway's payee");
    const m = await this.cfg.vault.createMandate(spec, principal, approver);
    this.mandates.set(m.hash, m);
    return m;
  }

  /**
   * This gateway's own externally visible base URL, as the client sees it.
   * Behind a TLS proxy (a Cloudflare tunnel) the Host header is the public name
   * and X-Forwarded-Proto says https, so links handed to a buyer point at the
   * address they can actually reach instead of a loopback port.
   */
  private selfUrl(req: IncomingMessage) {
    const proto = (req.headers["x-forwarded-proto"] ?? "").toString().split(",")[0].trim()
      || (this.cfg.publicHost ? "https" : "http");
    const host = req.headers.host ?? "127.0.0.1";
    return `${proto}://${host}`;
  }

  /** The intent must be signed by a real agent key on the vault. */
  private verifyIntent(intent: { payload: string; signature: string }) {
    if (!intent?.payload || !intent?.signature) return null;
    const [url, amount, vault] = intent.payload.split("|");
    if (vault !== this.cfg.vault.address) return null;
    if (Number(amount) <= 0) return null;
    const age = Date.now() - Number(intent.payload.split("|").at(-1));
    if (!Number.isFinite(age) || age > 5 * 60 * 1000) return null;
    const msg = Buffer.from(intent.payload);
    const sig = Buffer.from(intent.signature, "base64");
    for (const s of this.agentKeys) {
      // Returning WHICH key signed it matters downstream: the dedupe key is
      // built from the buyer's identity, so two different agents asking for the
      // same resource must not share one queue entry.
      try { if (Keypair.fromPublicKey(s).verify(msg, sig)) return s; } catch { /* keep going */ }
    }
    return null;
  }

  /** Keys allowed to place approval requests. */
  agentKeys: string[];

  requirements(uri: string) {
    const r = this.routes.get(uri)!;
    return {
      scheme: "stellar-exact",
      network: `stellar:${this.cfg.network}`,
      maxAmountRequired: r.price,
      resource: uri,
      payTo: this.cfg.payee,
      token: { code: this.cfg.vault.token.getCode(), issuer: this.cfg.vault.token.getIssuer() },
      vault: this.cfg.vault.address,
      mode: r.mode,
      maxTimeoutSeconds: r.holdSeconds ?? 3600,
      version: "1",
    };
  }

  /**
   * Check a proof against the live request before spending anything.
   * The envelope must name this gateway's payee and this exact price, and it
   * must be a hash the vault actually recognises.
   */
  async verify(uri: string, proof: PaymentProof) {
    const r = this.routes.get(uri);
    if (!r) throw new Error("unpriced resource " + uri);
    if (r.mode !== "preauth") throw new Error("route requires human approval, not a preauth envelope");

    if (!proof.envelope) throw new Error("preauth mode needs an envelope");
    const tx = new Transaction(proof.envelope, passphrase(this.cfg.vault.network));

    if (tx.source !== this.cfg.vault.address) throw new Error("envelope is not drawn on this vault");
    const ops = tx.operations;
    if (ops.length !== 1 || ops[0].type !== "payment") throw new Error("envelope must contain exactly one payment");
    const op = ops[0] as any;
    // Stellar normalises amounts to 7 decimals, so compare as numbers.
    if (Number(op.amount) !== Number(r.price)) {
      throw new Error(`price mismatch: want ${r.price} got ${op.amount}`);
    }
    if (op.destination !== this.cfg.payee) throw new Error("envelope pays a different seller");
    if (op.asset?.getCode?.() !== this.cfg.vault.token.getCode()
      || op.asset?.getIssuer?.() !== this.cfg.vault.token.getIssuer()) {
      throw new Error("envelope pays in a different token");
    }
    const hash = hex(tx.hash());
    if (hash !== proof.mandateHash) throw new Error("envelope hash does not match the declared mandate");

    // The vault stores the mandate as a strkey "T…" signer (base32 of the hash),
    // so decode it back to hex before comparing.
    const live = await this.cfg.vault.signerSummary();
    const registered = live.signers
      .filter((s: { type: string }) => s.type === "preauth-mandate")
      .map((s: { key: string }) => hex(StrKey.decodePreAuthTx(s.key)));
    if (!registered.includes(hash)) {
      throw new Error("mandate is not registered on the vault (expired or revoked)");
    }
    const tb = (tx as any).timebounds;
    if (tb?.maxTime && Number(tb.maxTime) * 1000 < Date.now()) throw new Error("mandate window closed");

    return { route: r, tx, hash };
  }

  handler(getContent: (uri: string) => string) {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const uri = (req.url ?? "/").split("?")[0];

      if (uri === "/pay/status") {
        const handle = new URL(req.url!, "http://x").searchParams.get("handle");
        const rec = handle ? this.desk.get(handle) : null;
        // A projection, never the record. The desk record carries `content` —
        // the payload the seller only ships once money has landed. Handing the
        // whole object to this ungated route would let anyone holding a handle
        // read the paid content while the payment still sits pending, which
        // defeats the entire product. The buyer already knows the id, price and
        // uri; the tx hash is theirs once it settles. Nothing else goes out.
        const safe = rec
          ? {
              id: rec.id, status: rec.status, price: rec.price, uri: rec.uri,
              ...(rec.tx ? { tx: rec.tx } : {}),
              ...(rec.reason ? { reason: rec.reason } : {}),
            }
          : { error: "unknown handle" };
        res.writeHead(rec ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(safe));
        return;
      }

      const r = this.routes.get(uri);
      if (!r) { res.writeHead(404).end("not found"); return; }

      const body = await readBody(req);
      const raw = req.headers[PAY_HEADER];

      if (!raw) {
        const reqs = this.requirements(uri);
        res.writeHead(402, { [PAY_HEADER]: JSON.stringify(reqs) });
        res.end(JSON.stringify({ error: "payment_required", accepts: reqs }));
        return;
      }

      let proof: PaymentProof;
      try { proof = JSON.parse(String(raw)); }
      catch { res.writeHead(400).end("bad payment header"); return; }
      if (!proof.intent && !proof.envelope) {
        res.writeHead(400).end("payment header needs an envelope or an intent"); return;
      }

      // approval mode: the agent sends a signed intent, a human decides
      if (r.mode === "approval") {
        if (!proof.intent) {
          res.writeHead(402, { [PAY_HEADER]: JSON.stringify(this.requirements(uri)) });
          res.end(JSON.stringify({ error: "payment_invalid", reason: "approval mode needs a signed intent" }));
          return;
        }
        const signer = this.verifyIntent(proof.intent);
        if (!signer) {
          res.writeHead(402, { [PAY_HEADER]: JSON.stringify(this.requirements(uri)) });
          res.end(JSON.stringify({ error: "payment_invalid", reason: "intent signature is not from the agent key" }));
          return;
        }

        // One request per buyer + body + price, not one per HTTP call. A buyer
        // retries by design (that is how they wait for a human), so without this
        // each retry parks a fresh payment: the human approves twice, money moves
        // twice, and the buyer still has no content. The signer is in the key so
        // two different agents never share one queue entry.
        const key = createHash("sha256")
          .update(`${signer}|${uri}|${r.price}|${body}`).digest("hex");
        const hit = this.desk.findByKey(key);

        if (hit) {
          // Already paid: hand over the content. This is the whole point of the
          // retry. It stays collectable for the route's hold window, then a
          // fresh payment is required — otherwise one approval would buy the
          // resource forever, which is not what the human agreed to.
          if (hit.status === "settled") {
            const windowMs = (r.collectSeconds ?? r.holdSeconds ?? 3600) * 1000;
            if (Date.now() - hit.at <= windowMs) {
              res.writeHead(200, {
                "content-type": "application/json",
                "x-payment-response": JSON.stringify({ tx: hit.tx }),
              });
              res.end(JSON.stringify({ data: getContent(uri), tx: hit.tx }));
              return;
            }
          }
          // A human said no. Do not silently re-open the same request and nag
          // them with it: the buyer has to change the request to ask again.
          if (hit.status === "denied") {
            res.writeHead(402, { [PAY_HEADER]: JSON.stringify(this.requirements(uri)) });
            res.end(JSON.stringify({
              error: "payment_denied", handle: hit.id,
              reason: hit.reason ?? "denied by the approver",
            }));
            return;
          }
          // pending / awaiting_phone: reuse the existing handle.
          // failed: the human approved but the ledger refused, so no money moved
          // and the buyer is not at fault — park a fresh one below.
          if (hit.status === "pending" || hit.status === "awaiting_phone") {
            const deskUrl = this.cfg.deskUrl
              ?? (this.cfg.publicHost ? `https://${this.cfg.publicHost}` : `http://127.0.0.1:${this.cfg.deskPort ?? 4022}`);
            res.writeHead(202, { "content-type": "application/json", "x-payment-hold": hit.id });
            res.end(JSON.stringify({
              status: "awaiting_approval", handle: hit.id, desk: deskUrl,
              statusUrl: `${this.selfUrl(req)}/pay/status?handle=${encodeURIComponent(hit.id)}`,
            }));
            return;
          }
        }

        const handle = this.desk.enqueue(uri, r.price, body, getContent(uri), key);

        res.writeHead(202, { "content-type": "application/json", "x-payment-hold": handle });
        // The buyer needs to know where a human approves. Loopback is only
        // right when both sides are on one machine; anything real sets deskUrl
        // (or publicHost) so this points at the https desk.
        const deskUrl = this.cfg.deskUrl
          ?? (this.cfg.publicHost ? `https://${this.cfg.publicHost}` : `http://127.0.0.1:${this.cfg.deskPort ?? 4022}`);
        // ...and where to poll for the answer. That is THIS gateway, not the
        // desk: the desk is the human's surface and is gated behind a portal key
        // the buyer must never hold. Without this the buyer has no way to learn
        // that a payment was approved and waits until timeout.
        res.end(JSON.stringify({
          status: "awaiting_approval", handle, desk: deskUrl,
          statusUrl: `${this.selfUrl(req)}/pay/status?handle=${encodeURIComponent(handle)}`,
        }));
        return;
      }

      try {
        await this.verify(uri, proof);
      } catch (e) {
        res.writeHead(402, { [PAY_HEADER]: JSON.stringify(this.requirements(uri)) });
        res.end(JSON.stringify({ error: "payment_invalid", reason: (e as Error).message }));
        return;
      }

      // Submit the envelope. The agent signed it; the preauth hash is the
      // second signature. If the ledger refuses, the body does not ship.
      //
      // Replay: Stellar de-duplicates an identical resubmission and hands back
      // the ORIGINAL result instead of an error. So the money cannot move
      // twice, but a naive gateway would happily serve the body twice. Check
      // the ledger for an already-applied transaction before serving.
      try {
        const tx = new Transaction(proof.envelope!, passphrase(this.cfg.vault.network));
        const agentSig = (tx as any).signatures?.[0];
        if (!agentSig) throw new Error("envelope carries no agent signature");
        const envHash = hex(tx.hash());
        if (this.settled.has(envHash)) throw new Error("mandate already redeemed");
        const applied = await this.cfg.vault.txExists(envHash);
        if (applied) { this.settled.add(envHash); throw new Error("mandate already redeemed"); }
        const out = await this.cfg.vault.horizon.submitTransaction(tx).catch(() => null);
        if (!out) throw new Error("ledger rejected the envelope");
        this.settled.add(envHash);
        const content = getContent(uri);
        res.writeHead(200, {
          "content-type": "application/json",
          "x-payment-response": JSON.stringify({ tx: out.hash, ledger: out.ledger }),
        });
        res.end(JSON.stringify({ data: content, tx: out.hash }));
      } catch (e) {
        res.writeHead(402, { [PAY_HEADER]: JSON.stringify(this.requirements(uri)) });
        res.end(JSON.stringify({ error: "payment_invalid", reason: (e as Error).message }));
      }
    };
  }

  listen(port: number, getContent: (uri: string) => string = (u) => `payload for ${u} at ${new Date().toISOString()}`) {
    const srv = createServer(this.handler(getContent));
    return new Promise<void>((resolve) => srv.listen(port, () => resolve()));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let acc = "";
    req.on("data", (c: Buffer) => (acc += c.toString()));
    req.on("end", () => resolve(acc));
  });
}

export { StellarTxError };
export type { DeskStore };
