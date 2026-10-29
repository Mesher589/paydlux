// Approval Desk: the human-in-the-loop layer.
//
// When a route is marked `requiresApproval`, the gateway verifies the agent's
// payment proof, then HOLDS it here instead of settling. A human looks at the
// request in a browser and clicks Approve or Deny. Only on approval does the
// payment go on chain — signed by the human's key over the exact same
// PaymentIntent the agent signed, so the approval is bound to that one payment
// and can never be reused for another one.
//
// Two ways for the human to sign:
//   1. browser wallet (MetaMask etc.) — the page calls personal_sign; the
//      contract accepts EIP-191 wrapped approvals (see _recoverPersonalM).
//   2. server-held key — DEMO/DEV ONLY, used when no wallet is connected.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  type Address,
  type Hex,
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  encodeAbiParameters,
  recoverMessageAddress,
  toBytes,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import vaultAbi from "./abi/AgentVault.json" with { type: "json" };
import { domain, domainSeparator, types, type Domain, type PaymentIntent } from "./core.ts";
import type { PaymentPayload } from "./gateway.ts";

export type Pending = {
  id: string;
  at: number;
  uri: string;
  price: bigint;
  payment: PaymentPayload;
  status: "pending" | "approved" | "denied" | "settled";
  content?: string;
  tx?: Hex;
  reason?: string;
};

export type DeskConfig = {
  rpcUrl: string;
  chainId: number;
  vault: Address;
  settleKey: Hex; // hot key that submits the settlement tx
  humanKey?: Hex; // DEV ONLY fallback signer (the principal/approver)
  portalPort: number;
};

const INTENT_TYPEHASH = keccak256(
  toBytes("PaymentIntent(bytes32 mandateId,address payee,uint128 amount,uint64 validUntil,uint256 nonce,bytes32 requestHash)"),
);

export class ApprovalDesk {
  private public: ReturnType<typeof createPublicClient>;
  private wallet: ReturnType<typeof createWalletClient>;
  private d: Domain;
  private pending = new Map<string, Pending>();
  private seq = 0;
  cfg: DeskConfig;

  constructor(cfg: DeskConfig) {
    this.cfg = cfg;
    const transport = http(cfg.rpcUrl);
    this.public = createPublicClient({ transport }) as never;
    this.wallet = createWalletClient({
      account: privateKeyToAccount(cfg.settleKey),
      transport,
    }) as never;
    this.d = domain({ chainId: cfg.chainId, verifyingContract: cfg.vault });
  }

  /** Gateway calls this instead of settling. Returns a handle the agent polls. */
  enqueue(uri: string, price: bigint, payment: PaymentPayload, content: string): string {
    const id = `pay_${(++this.seq).toString().padStart(4, "0")}`;
    this.pending.set(id, {
      id,
      at: Date.now(),
      uri,
      price,
      payment,
      status: "pending",
      content,
    });
    console.log(`[desk] ${id} awaiting human approval: $${formatUnits(price, 6)} for ${uri}`);
    return id;
  }

  get(id: string) {
    return this.pending.get(id);
  }

  list(): Pending[] {
    return [...this.pending.values()].sort((a, b) => b.at - a.at);
  }

  /** The exact EIP-712 digest the human is being asked to approve. */
  approvalDigest(p: PaymentPayload): Hex {
    // identical composition to the contract's _intentDigest: padded abi.encode
    const body = encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "address" },
        { type: "uint128" },
        { type: "uint64" },
        { type: "uint256" },
        { type: "bytes32" },
      ],
      [
        INTENT_TYPEHASH,
        p.intent.mandateId,
        p.intent.payee,
        p.intent.amount,
        p.intent.validUntil,
        p.intent.nonce,
        p.intent.requestHash,
      ],
    );
    const sh = keccak256(body);
    return keccak256(`0x1901${domainSeparator(this.d).slice(2)}${sh.slice(2)}` as Hex);
  }

  /**
   * Settle a held payment. `approvalSig` must be the human's signature over
   * approvalDigest(payment) — either raw EIP-712 or wallet personal_sign.
   */
  async approve(id: string, approvalSig: Hex, escrowWindow?: number): Promise<Pending> {
    const p = this.pending.get(id);
    if (!p) throw new Error("unknown payment");
    if (p.status !== "pending") throw new Error(`payment already ${p.status}`);

    const digest = this.approvalDigest(p.payment);
    // verify locally before spending gas: the approval must come from the
    // mandate's approver and bind to this exact payment
    const approver = await this.public.readContract({
      address: this.cfg.vault,
      abi: vaultAbi as never,
      functionName: "mandates",
      args: [p.payment.intent.mandateId],
    });
    const t = approver as unknown as any[];
    const expectedApprover = ((t[10] as Address) && t[10] !== "0x0000000000000000000000000000000000000000" ? (t[10] as Address) : (t[0] as Address));
    const fromWallet = await recoverMessageAddress({ message: { raw: digest }, signature: approvalSig }).catch(() => null);
    const fromRaw = await recoverTypedDataAddress({
      domain: this.d,
      types: types as never,
      primaryType: "PaymentIntent",
      message: p.payment.intent as never,
      signature: approvalSig,
    }).catch(() => null);
    if (fromWallet !== expectedApprover && fromRaw !== expectedApprover) {
      p.status = "denied";
      p.reason = "approval signature is not from the mandate approver";
      throw new Error(p.reason);
    }

    const tx = await this.wallet.writeContract({
      address: this.cfg.vault,
      abi: vaultAbi as never,
      functionName: "settleWithApproval",
      args: [
        p.payment.intent,
        p.payment.sig,
        approvalSig,
        { method: p.payment.binding.method, uri: p.payment.binding.uri, bodyHash: p.payment.binding.bodyHash },
        { payeeProof: [] as Hex[], contentHash: p.payment.contentHash, releaseAfter: BigInt(escrowWindow ?? 0) },
      ],
    });
    await this.public.waitForTransactionReceipt({ hash: tx });
    p.status = "settled";
    p.tx = tx;
    console.log(`[desk] ${id} approved and settled: ${tx}`);
    return p;
  }

  deny(id: string, reason = "denied by approver"): Pending {
    const p = this.pending.get(id);
    if (!p) throw new Error("unknown payment");
    p.status = "denied";
    p.reason = reason;
    console.log(`[desk] ${id} denied: ${reason}`);
    return p;
  }

  /** Human-facing web UI + JSON API. */
  start() {
    const s = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(obj, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
      };

      if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PORTAL_HTML);
        return;
      }
      if (url.pathname === "/api/pending") return send(200, { items: this.list() });

      if (req.method === "POST" && url.pathname.startsWith("/api/")) {
        const id = url.pathname.split("/").pop()!;
        const body = await new Promise<string>((r) => {
          let acc = "";
          req.on("data", (c) => (acc += c));
          req.on("end", () => r(acc));
        });
        const j = JSON.parse(body || "{}") as { signature?: Hex; reason?: string };
        try {
          if (url.pathname.endsWith("/approve")) {
            if (!j.signature && !this.cfg.humanKey) return send(400, { error: "no signature and no dev key" });
            let sig = j.signature;
            if (!sig) {
              // DEV ONLY: sign with the locally-held approver key
              const acct = privateKeyToAccount(this.cfg.humanKey!);
              const digest = await this.approvalDigest(this.pending.get(id)!.payment);
              sig = (await acct.signMessage({ message: { raw: digest } })) as Hex;
            }
            const p = await this.approve(id, sig as Hex);
            return send(200, { ok: true, tx: p.tx });
          }
          if (url.pathname.endsWith("/deny")) return send(200, { ok: true, status: this.deny(id, j.reason).status });
        } catch (e) {
          return send(409, { error: (e as Error).message });
        }
      }
      res.writeHead(404).end("not found");
    });
    s.listen(this.cfg.portalPort);
    return s;
  }
}

const PORTAL_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Approval Desk</title>
<style>
 body{font:15px/1.5 -apple-system,system-ui,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:32px}
 h1{font-size:20px;margin:0 0 4px} .sub{color:#8b949e;margin-bottom:24px}
 .card{background:#161b22;border:1px solid #30363d;border-radius:10px;padding:16px;margin-bottom:14px}
 .amt{font-size:26px;font-weight:600} .k{color:#8b949e;font-size:12px;text-transform:uppercase;letter-spacing:.05em}
 .row{display:flex;gap:24px;flex-wrap:wrap;margin:10px 0}
 button{padding:9px 18px;border-radius:8px;border:1px solid #30363d;background:#21262d;color:#e6edf3;cursor:pointer;font-size:14px;margin-right:8px}
 .ok{background:#238636;border-color:#2ea043} .no{background:#a11;border-color:#c33}
 .st{font-size:12px;padding:3px 8px;border-radius:99px;background:#21262d}
 .settled{background:#238636}.denied{background:#a11}.pending{background:#9e6a03}
 code{font-size:11px;color:#8b949e;word-break:break-all}
</style></head><body>
<h1>Approval Desk</h1>
<div class="sub">Every payment below was initiated by an AI agent. Nothing is settled until you approve it.</div>
<div id="list"></div>
<script>
const fmt = n => '$' + (Number(n)/1e6).toFixed(2);
async function act(id, kind, sig){
  const r = await fetch('/api/'+kind+'/'+id, {method:'POST', headers:{'content-type':'application/json'},
    body: JSON.stringify({signature: sig})});
  const j = await r.json(); if(j.error) alert(j.error); load();
}
async function approve(id){
  if (window.ethereum) {
    const acc = (await window.ethereum.request({method:'eth_requestAccounts'}))[0];
    const d = await (await fetch('/api/pending')).json();
    const item = d.items.find(x=>x.id===id);
    // the wallet signs the exact payment digest — personal_sign wraps it EIP-191
    const sig = await window.ethereum.request({method:'eth_sign', params:[acc, item.digest]});
    return act(id,'approve',sig);
  }
  return act(id,'approve',undefined); // dev key fallback
}
async function load(){
  const d = await (await fetch('/api/pending')).json();
  document.getElementById('list').innerHTML = d.items.map(x=>\`
   <div class="card">
     <div class="row"><div><div class="k">Amount</div><div class="amt">\${fmt(x.price)}</div></div>
       <div><div class="k">Buying</div><div>\${x.uri}</div></div>
       <div><div class="k">Seller</div><code>\${x.payment.intent.payee}</code></div>
       <div><div class="k">Status</div><span class="st \${x.status}">\${x.status}</span></div></div>
     <div class="k">Agent signature</div><code>\${x.payment.sig}</code>
     \${x.tx ? '<div class="k">Tx</div><code>'+x.tx+'</code>' : ''}
     \${x.status==='pending' ? '<div style="margin-top:12px"><button class="ok" onclick="approve(\\''+x.id+'\\')">Approve</button><button class="no" onclick="act(\\''+x.id+'\\',\\'deny\\')">Deny</button></div>' : ''}
   </div>\`).join('') || '<div class="sub">Nothing waiting.</div>';
}
load(); setInterval(load, 2000);
</script></body></html>`;
