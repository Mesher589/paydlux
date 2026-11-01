// The agent side. This is all a buyer has to write.
//
//   const agent = new PaydluxAgent({ gateway: "http://localhost:4021", agentKey });
//   const res = await agent.get("https://api.example.com/data");
//
// The agent holds one key of two. It can ask, and it can execute a mandate a
// human already signed. It cannot move money on its own — the ledger refuses.
import { Horizon, Keypair, Transaction } from "@stellar/stellar-sdk";
import { passphrase, type Mandate } from "./vault.ts";

const PAY_HEADER = "x-payment";

export type AgentConfig = {
  /** the agent's own key. One of two signers on the vault. */
  agentKey: string;
  /** where to send the payment proof once a gateway asks for one */
  network?: "testnet" | "public";
  /** max attempts before giving up */
  maxRetries?: number;
  /** approval mode: how long to wait for a human, and how often to poll */
  approvalTimeoutMs?: number;
  pollMs?: number;
  fetch?: typeof fetch;
};

export type PayResponse<T = string> = {
  ok: boolean;
  status: number;
  data?: T;
  tx?: string;
  /** set when a human has to approve */
  handle?: string;
  /** where a human approves (the seller's desk) */
  desk?: string;
  /** where THIS buyer polls for the answer (the gateway, no key needed) */
  statusUrl?: string;
  reason?: string;
  requirements?: any;
};

export class PaydluxAgent {
  private key: Keypair;
  private cfg: Required<Pick<AgentConfig, "network" | "maxRetries" | "approvalTimeoutMs" | "pollMs">> & AgentConfig;

  constructor(cfg: AgentConfig) {
    this.key = Keypair.fromSecret(cfg.agentKey);
    this.cfg = {
      network: "testnet", maxRetries: 3, approvalTimeoutMs: 120_000, pollMs: 2_000, ...cfg,
    };
  }

  get publicKey() { return this.key.publicKey(); }

  /**
   * GET a paid resource. Handles the 402 handshake: read what the seller
   * wants, satisfy it, retry once with the proof attached.
   */
  async get<T = string>(url: string, opts: { mandate?: Mandate; body?: string } = {}): Promise<PayResponse<T>> {
    const f = this.cfg.fetch ?? fetch;

    const first = await f(url, { method: opts.body ? "POST" : "GET", body: opts.body });
    if (first.status !== 402) {
      return { ok: first.ok, status: first.status, data: (await first.json().catch(() => first.text())) as T };
    }
    const reqs = parseRequirements(first.headers.get(PAY_HEADER));
    if (!reqs) return { ok: false, status: 402, reason: "seller sent 402 without payment terms", requirements: null };

    if (reqs.mode === "approval") {
      // Tell the seller we want it. The seller parks the request at the
      // approval desk and a person decides. We do not get to decide.
      const intent = signIntent(url, reqs, this.key);
      const parked = await f(url, {
        method: opts.body ? "POST" : "GET", body: opts.body,
        headers: { [PAY_HEADER]: JSON.stringify({ intent }) },
      });
      const j: any = await parked.json().catch(() => ({}));
      // A 200 here means the human already approved this request — the seller
      // serves the content on the retry. Reporting "needs approval" in that case
      // would leave a buyer polling forever for a payment that is already paid.
      if (parked.status === 200) {
        return { ok: true, status: 200, data: (j.data ?? j) as T, tx: j.tx };
      }
      return { ok: false, status: parked.status, handle: j.handle, desk: j.desk,
        statusUrl: j.statusUrl, requirements: reqs,
        reason: j.reason ?? "a human has to approve this payment" };
    }

    if (!opts.mandate) {
      return { ok: false, status: 402, requirements: reqs,
        reason: "seller wants a pre-authorised mandate and none was supplied" };
    }

    // Sign locally, then send. Signing does not change the hash (the hash is
    // over the unsigned body), so the vault still recognises the mandate.
    const signed = new Transaction(opts.mandate.envelope, passphrase(this.cfg.network!));
    signed.sign(this.key);
    const proof = { envelope: signed.toXDR(), mandateHash: opts.mandate.hash };
    const retry = await f(url, {
      method: opts.body ? "POST" : "GET",
      body: opts.body,
      headers: { [PAY_HEADER]: JSON.stringify(proof) },
    });
    const j: any = await retry.json().catch(() => ({}));
    if (retry.status === 200) {
      return { ok: true, status: 200, data: (j.data ?? j) as T, tx: j.tx, requirements: reqs };
    }
    return { ok: false, status: retry.status, reason: j.reason ?? "payment rejected", requirements: reqs };
  }

  /**
   * Sign and submit a mandate envelope directly to Horizon. Used when the
   * gateway wants the payment settled before it serves anything.
   */
  async submitEnvelope(mandate: Mandate): Promise<Awaited<ReturnType<Horizon.Server["submitTransaction"]>>> {
    const tx = new Transaction(mandate.envelope, passphrase(this.cfg.network!));
    tx.sign(this.key);
    const h = new Horizon.Server(this.cfg.network === "public"
      ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org");
    return h.submitTransaction(tx);
  }

  /**
   * Wait for a human to decide on an approval-mode payment.
   * Returns the settled record, or null on deny/timeout.
   *
   * Pass the response you got from get() — that is the whole point of the
   * handle. It carries the exact URL to poll. Poll the GATEWAY, never the desk:
   * the desk is the human's surface, gated behind a portal key, and whoever
   * holds that key can approve. A buyer must never have it. The gateway's
   * status route answers for a handle it handed out and reveals only what the
   * buyer already knows (id, price, status) plus the tx hash once it settles.
   */
  async waitForApproval(res: PayResponse | string, handle?: string) {
    const f = this.cfg.fetch ?? fetch;
    const url = typeof res === "string"
      ? `${res.replace(/\/+$/, "")}/pay/status?handle=${encodeURIComponent(handle ?? "")}`
      : (res.statusUrl ?? `${res.desk?.replace(/\/+$/, "")}/list`);
    const want = typeof res === "string" ? handle : res.handle;
    if (!want) throw new Error("nothing to wait on: this response has no payment handle");
    const deadline = Date.now() + this.cfg.approvalTimeoutMs!;
    while (Date.now() < deadline) {
      const r = await f(url).catch(() => null);
      if (!r?.ok) {
        // A desk /list fallback needs the portal key, so it 403s for a buyer.
        // That is correct behaviour, not a bug to work around.
        if (url.endsWith("/list")) throw new Error(
          "cannot poll the desk for status — pass the response from get(), which carries statusUrl");
        await new Promise((res2) => setTimeout(res2, this.cfg.pollMs));
        continue;
      }
      const rec: any = await r.json().catch(() => null);
      const found = Array.isArray(rec) ? rec.find((x) => x.id === want) : rec;
      if (found && found.status !== "pending" && found.status !== "awaiting_phone") return found;
      await new Promise((res2) => setTimeout(res2, this.cfg.pollMs));
    }
    return null;
  }
}

/**
 * A signed intent: proof the request came from the real agent key, so a random
 * visitor cannot spam the approval desk with pending payments.
 */
function signIntent(url: string, reqs: any, key: Keypair) {
  const payload = `${url}|${reqs.maxAmountRequired}|${reqs.vault}|${Date.now()}`;
  return { payload, signature: Buffer.from(key.sign(Buffer.from(payload))).toString("base64") };
}

function parseRequirements(header: string | null) {
  if (!header) return null;
  try { return JSON.parse(header); } catch { return null; }
}
