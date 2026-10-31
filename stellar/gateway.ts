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
import { Keypair, StrKey, Transaction } from "stellar-sdk";
import { StellarVault, StellarTxError, passphrase, type Amount, type Mandate, type Network } from "./vault.ts";
import { ApprovalDesk, type DeskStore } from "./desk.ts";

export const PAY_HEADER = "x-payment";

export type Route = {
  uri: string;
  price: Amount;
  mode: "preauth" | "approval";
  /** seconds the seller's content stays reserved while a human decides */
  holdSeconds?: number;
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
  deskPort?: number;
  /** gate the approval portal behind a single unguessable link */
  portalKey?: string;
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
    for (const r of cfg.routes) this.routes.set(r.uri, r);
    this.desk = new ApprovalDesk({
      vault: cfg.vault,
      payee: cfg.payee,
      principal: cfg.principal,
      approver: cfg.approver,
      port: cfg.deskPort ?? 4022,
      portalKey: cfg.portalKey,
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

  /** The intent must be signed by a real agent key on the vault. */
  private verifyIntent(intent: { payload: string; signature: string }) {
    if (!intent?.payload || !intent?.signature) return false;
    const [url, amount, vault] = intent.payload.split("|");
    if (vault !== this.cfg.vault.address) return false;
    if (Number(amount) <= 0) return false;
    const age = Date.now() - Number(intent.payload.split("|").at(-1));
    if (!Number.isFinite(age) || age > 5 * 60 * 1000) return false;
    const msg = Buffer.from(intent.payload);
    const sig = Buffer.from(intent.signature, "base64");
    for (const s of this.agentKeys) {
      try { if (Keypair.fromPublicKey(s).verify(msg, sig)) return true; } catch { /* keep going */ }
    }
    return false;
  }

  /** Keys allowed to place approval requests. */
  agentKeys: string[] = [];

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
    const hash = tx.hash().toString("hex");
    if (hash !== proof.mandateHash) throw new Error("envelope hash does not match the declared mandate");

    // The vault stores the mandate as a strkey "T…" signer (base32 of the hash),
    // so decode it back to hex before comparing.
    const live = await this.cfg.vault.signerSummary();
    const registered = live.signers
      .filter((s: { type: string }) => s.type === "preauth-mandate")
      .map((s: { key: string }) => StrKey.decodePreAuthTx(s.key).toString("hex"));
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
        res.writeHead(rec ? 200 : 404, { "content-type": "application/json" });
        res.end(JSON.stringify(rec ?? { error: "unknown handle" }));
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
        if (!this.verifyIntent(proof.intent)) {
          res.writeHead(402, { [PAY_HEADER]: JSON.stringify(this.requirements(uri)) });
          res.end(JSON.stringify({ error: "payment_invalid", reason: "intent signature is not from the agent key" }));
          return;
        }
        const handle = this.desk.enqueue(uri, r.price, body, getContent(uri));
        res.writeHead(202, { "content-type": "application/json", "x-payment-hold": handle });
        res.end(JSON.stringify({ status: "awaiting_approval", handle, desk: `http://127.0.0.1:${this.cfg.deskPort ?? 4022}` }));
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
        const envHash = tx.hash().toString("hex");
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
