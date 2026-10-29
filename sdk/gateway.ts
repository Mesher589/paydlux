// x402-style payment gateway: an HTTP resource server that demands a
// request-bound payment proof, verifies it against the on-chain mandate, and
// settles in USDC-backed credits.
//
// Protocol shape (matches x402):
//   -> 402 Payment Required + X-PAYMENT header describing requirements
//   <- retry with X-PAYMENT header carrying the signed payment payload
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodePacked,
  concat,
  stringToBytes,
  toBytes,
  numberToHex,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  domain,
  types,
  requestHash,
  bodyHash as hashBody,
  emptyHash,
  mandateDigest,
  type Domain,
  type Mandate,
  type PaymentIntent,
} from "./core.ts";
import vaultAbi from "./abi/AgentVault.json" with { type: "json" };

export type Pricing = { uri: string; price: bigint; escrowWindow?: number; requiresApproval?: boolean };

export type GatewayConfig = {
  rpcUrl: string;
  chainId: number;
  vault: Address;
  payee: Address;
  settleKey: Hex; // hot key that submits settlements
  pricing: Pricing[];
  mandate: Hex; // mandate this gateway accepts
  desk?: import("./approval.ts").ApprovalDesk; // human-in-the-loop hold
};

export type PaymentPayload = {
  intent: {
    mandateId: Hex;
    payee: Address;
    amount: bigint;
    validUntil: bigint;
    nonce: bigint;
    requestHash: Hex;
  };
  sig: Hex;
  binding: { method: string; uri: string; bodyHash: Hex };
  contentHash: Hex;
};

const HEADER = "x-payment";

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let acc = "";
    req.on("data", (c) => (acc += c));
    req.on("end", () => resolve(acc));
  });
}

export class Gateway {
  private public: ReturnType<typeof createPublicClient>;
  private wallet: ReturnType<typeof createWalletClient>;
  private account;
  private d: Domain;
  private priceFor = new Map<string, Pricing>();
  private escrowCount = 0;

  cfg: GatewayConfig;
  constructor(cfg: GatewayConfig) {
    this.cfg = cfg;
    this.public = createPublicClient({ chainId: cfg.chainId as never, transport: http(cfg.rpcUrl) }) as never;
    this.account = privateKeyToAccount(cfg.settleKey);
    this.wallet = createWalletClient({ account: this.account, chain: { id: cfg.chainId, name: "local", rpcUrls: { default: { http: [cfg.rpcUrl] } } } as never, transport: http(cfg.rpcUrl) }) as never;
    this.d = domain({ chainId: cfg.chainId, verifyingContract: cfg.vault });
    for (const p of cfg.pricing) this.priceFor.set(p.uri, p);
  }

  /** 402 body advertised to the client. */
  requirements(uri: string) {
    const p = this.priceFor.get(uri)!;
    return {
      scheme: "exact",
      network: "eip155:" + this.cfg.chainId,
      maxAmountRequired: String(p.price),
      resource: uri,
      payTo: this.cfg.payee,
      maxTimeoutSeconds: 3600,
      schemeMeta: { mandate: this.cfg.mandate, name: "AgentVault", version: "1" },
    };
  }

  /** Verify a payment payload against the live request and the on-chain mandate. */
  async verify(req: { method: string; uri: string; body: string; payment: PaymentPayload }) {
    const p = this.priceFor.get(req.uri);
    if (!p) throw new Error("unpriced resource " + req.uri);
    const { intent, sig, binding } = req.payment;

    if (intent.mandateId !== this.cfg.mandate) throw new Error("wrong mandate");
    if (intent.payee !== this.cfg.payee) throw new Error("wrong payee");
    if (intent.amount !== p.price) throw new Error(`price mismatch: want ${p.price} got ${intent.amount}`);
    if (binding.method !== req.method || binding.uri !== req.uri) throw new Error("binding does not match request");

    // for escrowed resources the request body is committed to as well, so a
    // captured proof cannot be reused with a different request payload
    const bh = p.escrowWindow ? hashBody(req.body || "") : emptyHash();
    if (p.escrowWindow && binding.bodyHash !== bh) throw new Error("body hash mismatch");
    if (p.escrowWindow && req.payment.contentHash === ("0x" + "00".repeat(32) as Hex)) {
      throw new Error("escrowed payment must declare a content hash");
    }

    const rh = requestHash({ method: binding.method, uri: binding.uri, bodyHash: binding.bodyHash, nonce: intent.nonce });
    if (rh !== intent.requestHash) throw new Error("request hash mismatch (floating authorization)");

    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now > intent.validUntil) throw new Error("intent expired");

    // on-chain: mandate must be live and the signature must come from its agent
    // `mandates` is a public mapping getter: viem returns a positional tuple.
    const t = (await this.public.readContract({
      address: this.cfg.vault,
      abi: vaultAbi as never,
      functionName: "mandates",
      args: [intent.mandateId],
    })) as readonly unknown[];
    const m = { principal: t[0] as Address, agent: t[1] as Address, validAfter: t[2] as bigint, validUntil: t[3] as bigint, perCallMax: t[4] as bigint, dailyBudget: t[5] as bigint, totalBudget: t[6] as bigint, payeeRoot: t[7] as Hex, active: t[8] as boolean, requiresApproval: t[9] as boolean, approver: t[10] as Address, spent: t[11] as bigint };
    if (!m.active) throw new Error("mandate inactive");
    // the agent identity comes from the signature, exactly as on chain
    const signer = await recoverTypedDataAddress({
      domain: this.d,
      types: types as never,
      primaryType: "PaymentIntent",
      message: intent as never,
      signature: sig,
    });
    if (signer !== m.agent) throw new Error("payment signed by an agent outside this mandate");
    if (intent.amount > m.perCallMax) throw new Error("over per-call cap");
    const now2 = BigInt(Math.floor(Date.now() / 1000));
    if (now2 < m.validAfter || now2 > m.validUntil) throw new Error("mandate window closed");

    return { mandate: m, pricing: p };
  }

  /** Submit the settlement on chain. */
  async settle(payment: PaymentPayload, escrowWindow?: number) {
    const terms = {
      payeeProof: [] as Hex[],
      contentHash: payment.contentHash,
      releaseAfter: BigInt(escrowWindow ?? 0),
    };
    const hash = await this.wallet.writeContract({
      address: this.cfg.vault,
      abi: vaultAbi as never,
      functionName: "settle",
      args: [payment.intent, payment.sig, { method: payment.binding.method, uri: payment.binding.uri, bodyHash: payment.binding.bodyHash }, terms],
    });
    return hash;
  }

  /** node:http handler implementing the 402 handshake. */
  handler(getContent: (uri: string) => string) {
    return async (req: IncomingMessage, res: ServerResponse) => {
      const uri = (req.url ?? "/").split("?")[0];
      const p = this.priceFor.get(uri);
      if (!p) {
        res.writeHead(404).end("not found");
        return;
      }

      const body = await readBody(req);
      const raw = req.headers[HEADER];
      if (!raw) {
        res.writeHead(402, { [HEADER]: JSON.stringify(this.requirements(uri)) });
        res.end(JSON.stringify({ error: "payment_required", accepts: this.requirements(uri) }));
        return;
      }

      let payment: PaymentPayload;
      try {
        payment = JSON.parse(String(raw), (_k, v) => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : v)) as PaymentPayload;
      } catch {
        res.writeHead(400).end("bad payment header");
        return;
      }

      try {
        await this.verify({ method: req.method ?? "GET", uri, body, payment });
      } catch (e) {
        res.writeHead(402, { [HEADER]: JSON.stringify(this.requirements(uri)) });
        res.end(JSON.stringify({ error: "payment_invalid", reason: (e as Error).message }));
        return;
      }

      const content = getContent(uri);

      // human-in-the-loop: hold the verified payment until a person approves it
      if (p.requiresApproval && this.cfg.desk) {
        const handle = this.cfg.desk.enqueue(uri, p.price, payment, content);
        res.writeHead(202, { "content-type": "application/json", "x-payment-hold": handle });
        res.end(JSON.stringify({ status: "awaiting_approval", handle }));
        return;
      }

      let tx: Hex;
      try {
        tx = await this.settle(payment, p.escrowWindow);
      } catch (e) {
        // an on-chain revert means the payment is not spendable: refuse the body
        const msg = (e as any)?.shortMessage ?? (e as any)?.message ?? String(e);
        res.writeHead(402, { [HEADER]: JSON.stringify(this.requirements(uri)) });
        res.end(JSON.stringify({ error: "payment_invalid", reason: msg.split("\n")[0] }));
        return;
      }
      if (p.escrowWindow) this.escrowCount++;

      res.writeHead(200, { "content-type": "application/json", "x-payment-response": JSON.stringify({ tx, escrow: !!p.escrowWindow }) });
      res.end(JSON.stringify({ data: content, tx }));
    };
  }

  listen(port: number) {
    const s = createServer(this.handler((uri) => `payload for ${uri} @ ${new Date().toISOString()}`));
    return new Promise<void>((r) => s.listen(port, () => r()));
  }
}

export { hashBody, emptyHash, mandateDigest };
