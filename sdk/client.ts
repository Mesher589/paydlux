// Agent-side client: hits a 402-gated resource, builds a payment proof bound to
// that exact request, signs it with the agent key, retries once with X-PAYMENT.
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { domain, types, requestHash, bodyHash as hashBody, emptyHash, signerFromKey, signStructure, type Domain, type PaymentIntent } from "./core.ts";

export type ClientConfig = {
  rpcUrl: string;
  chainId: number;
  vault: Address;
  agentKey: Hex;
  mandateId: Hex;
};

export type PayResult = { status: number; body: unknown; payment?: unknown };

export class PayingClient {
  private signer;
  private d: Domain;

  cfg: ClientConfig;
  constructor(cfg: ClientConfig) {
    this.cfg = cfg;
    this.signer = signerFromKey(cfg.agentKey);
    this.d = domain({ chainId: cfg.chainId, verifyingContract: cfg.vault });
  }

  /**
   * Fetch `url` and pay for it. `nonce` must be unique per mandate — the contract
   * rejects any reuse, and the nonce is folded into the request hash so a captured
   * proof cannot be replayed against a different endpoint.
   */
  async fetchPaid(url: string, opts: { method?: string; nonce: bigint; validFor?: number; body?: string; contentHash?: Hex } ): Promise<PayResult> {
    const method = opts.method ?? "GET";
    const u = new URL(url);
    const uri = u.pathname;

    const first = await fetch(url, { method, headers: opts.body ? { "content-type": "application/json" } : undefined, body: opts.body });
    if (first.status !== 402) return { status: first.status, body: await first.json().catch(() => null) };

    const req = (await first.json()) as { accepts: { maxAmountRequired: string; payTo: string } };
    const amount = BigInt(req.accepts.maxAmountRequired);
    const payee = req.accepts.payTo as Address;

    const bh = opts.body ? hashBody(opts.body) : emptyHash();
    const rh = requestHash({ method, uri, bodyHash: bh, nonce: opts.nonce });
    const validUntil = BigInt(Math.floor(Date.now() / 1000) + (opts.validFor ?? 3600));

    const intent: PaymentIntent = {
      mandateId: this.cfg.mandateId,
      payee,
      amount,
      validUntil,
      nonce: opts.nonce,
      requestHash: rh,
    };
    const sig = await signStructure(this.signer, this.d, "PaymentIntent", intent as unknown as Record<string, unknown>);

    const payload = {
      scheme: "exact",
      intent,
      sig,
      binding: { method, uri, bodyHash: bh },
      contentHash: opts.contentHash ?? ("0x" + "00".repeat(32) as Hex),
    };

    const second = await fetch(url, { method, headers: { "x-payment": JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) }, body: opts.body });
    return { status: second.status, body: await second.json().catch(() => null), payment: payload };
  }
}
