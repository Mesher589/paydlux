#!/usr/bin/env node
// Paydlux as an MCP server: the tools an agent calls when it wants to buy
// something and a human has to approve the money.
//
//   npx -y @paydlux/agent mcp --file paydlux-mainnet.json
//
// This is the BUYER side of the protocol, and it is deliberately narrow. The
// only signing key this process ever loads is the agent key: one of two signers
// on the vault, weight 1 against a release threshold of 2. It can ask, and it
// can execute a mandate a human already signed. It cannot release money on its
// own, and there is no flag here that accepts a principal or approver key at
// all. The guardrail is the ledger, so this server does not have to be trusted.
//
// Why the tool set looks like this: an agent's failure mode is not malice, it
// is confidence. It will retry a refused payment forever, and it will spend a
// budget it believes is free. So the read-only tools come first — what the
// human allowed, what is already spent according to the ledger, whether a
// specific payment would pass — and the one tool that moves anything returns
// the handle and the human's link rather than pretending the answer is in.
import { existsSync, readFileSync, statSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { StellarVault, assetMatches, type Network } from "./vault.ts";
import { PaydluxAgent, type PayResponse } from "./agent.ts";
import { PolicyEngine, type Policy } from "./policy.ts";
import { readEscrow, escrowOutcome, pendingEscrows } from "./escrow.ts";

const HOME = "https://paydlux.com";

// ------------------------------------------------------------------ config

type Cfg = {
  path: string;
  network: Network;
  vault: string;
  token: { code: string; issuer?: string };
  payee?: string;
  policy: Partial<Policy>;
  /** the only secret this process holds. One of two vault signers. */
  agentSeed: string;
  principalPub: string;
  approverPub?: string;
  agentPub: string;
  readOnly: boolean;
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function pub(seed: string): string { return Keypair.fromSecret(seed).publicKey(); }

/**
 * Load the vault file and keep only what the buyer role needs.
 *
 * The file also holds the principal and approver seeds — the human's half of
 * the vault. They are read once, converted to public keys for the ledger's
 * signer check, and then the parsed object goes out of scope. A process that
 * never holds the human keys cannot be talked into using them, which is the
 * whole point of splitting them in the first place.
 */
function load(path: string): Cfg {
  if (!existsSync(path)) {
    throw new Error(`no vault file at ${path}. Point --file at a paydlux-*.json created by \`paydlux setup\`.`);
  }
  // Same stance as the CLI: a key file other users can read is not a key file.
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) {
    throw new Error(`${path} is readable by others (${mode.toString(8)}). Run: chmod 600 ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const keys = raw.keys ?? {};
  if (!keys.agent) throw new Error(`${path} has no keys.agent — this server buys on the agent key's behalf`);
  if (!keys.principal) throw new Error(`${path} has no keys.principal — it is not a Paydlux vault file`);
  if (!raw.vault) throw new Error(`${path} has no vault address`);

  return {
    path,
    network: (raw.network === "public" ? "public" : "testnet") as Network,
    vault: String(raw.vault),
    token: { code: String(raw.token?.code ?? "XLM"), issuer: raw.token?.issuer },
    payee: raw.payee?.address,
    policy: raw.policy ?? {},
    agentSeed: String(keys.agent),
    principalPub: pub(String(keys.principal)),
    approverPub: keys.approver ? pub(String(keys.approver)) : undefined,
    agentPub: pub(String(keys.agent)),
    readOnly: flag("read-only"),
  };
}

// ----------------------------------------------------------------- helpers

let vaultHandle: StellarVault | undefined;
async function vault(cfg: Cfg): Promise<StellarVault> {
  if (vaultHandle) return vaultHandle;
  vaultHandle = await StellarVault.load(
    cfg.vault, cfg.token.code, cfg.token.issuer,
    { principal: cfg.principalPub, approver: cfg.approverPub, agent: cfg.agentPub } as any,
    cfg.network,
  );
  if (cfg.token.code === "USDC") vaultHandle.useUsdc();
  return vaultHandle;
}

/**
 * What left this vault today, straight from the ledger, for every payee.
 *
 * StellarVault.paidToday() answers for one payee. An agent asking "how much of
 * my budget is left" means the total, and the in-RAM PolicyEngine counter resets
 * on restart — a budget that reads as unspent after a restart is worse than no
 * budget, so the honest number comes from Horizon. assetMatches is the same
 * single comparison the rest of the codebase uses, so a native-XLM vault is not
 * blind to its own money here.
 */
async function spentTodayAll(v: StellarVault): Promise<{ total: number; byPayee: Record<string, number> }> {
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const byPayee: Record<string, number> = {};
  let total = 0;
  let cursor: string | undefined;
  const base = v.network === "public" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
  for (let page = 0; page < 10; page++) {
    const url = `${base}/accounts/${v.address}/payments?order=desc&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`ledger payments query failed: ${res.status}`);
    const recs: any[] = (await res.json())?._embedded?.records ?? [];
    if (!recs.length) break;
    for (const e of recs) {
      if (new Date(e.created_at).getTime() < start.getTime()) return { total, byPayee };
      if (e.type !== "payment" && e.type !== "claimable_balance_claim") continue;
      if (e.from !== v.address) continue;      // money leaving the vault only
      if (!assetMatches(v.token, e)) continue; // the vault's own token, incl. XLM
      total += Number(e.amount);
      byPayee[e.to] = (byPayee[e.to] ?? 0) + Number(e.amount);
    }
    cursor = recs[recs.length - 1].paging_token;
  }
  return { total, byPayee };
}

async function recentPayments(v: StellarVault, limit: number) {
  const base = v.network === "public" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
  const res = await fetch(`${base}/accounts/${v.address}/payments?order=desc&limit=${Math.min(limit, 50)}`);
  if (!res.ok) throw new Error(`ledger payments query failed: ${res.status}`);
  return ((await res.json())?._embedded?.records ?? []).map((e: any) => ({
    at: e.created_at, type: e.type, from: e.from, to: e.to,
    amount: e.amount, asset: e.asset_type === "native" ? "XLM" : `${e.asset_code}:${String(e.asset_issuer).slice(0, 6)}…`,
    transaction: e.transaction_hash,
  }));
}

/**
 * Last line of defence on output. A Stellar secret seed is an S-prefixed
 * 56-character base32 string; nothing this server returns has any business
 * containing one, so if one ever reaches a tool result it is replaced before it
 * reaches a model's context — and a model's context is a place secrets leak
 * from, usually by being summarised into a public answer.
 */
function redact(s: string): string {
  return s.replace(/S[A-Z2-7]{55}/g, "[redacted: a secret seed reached an MCP tool result — report this]");
}

function text(obj: unknown) {
  return { content: [{ type: "text" as const, text: redact(JSON.stringify(obj, null, 2)) }] };
}
function fail(reason: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: redact(JSON.stringify({ ok: false, reason, ...extra }, null, 2)) }] };
}

/** Sellers answer with the payload an agent asked for; keep tool results small. */
function clip(data: unknown, max = 4000): unknown {
  if (typeof data !== "string") return data;
  return data.length > max ? `${data.slice(0, max)}… [+${data.length - max} chars]` : data;
}

// ------------------------------------------------------------------ server

function version(): string {
  try {
    return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version ?? "0.0.0";
  } catch { return "0.0.0"; }
}

export function buildServer(cfg: Cfg): McpServer {
  const policy = new PolicyEngine(cfg.policy);
  const server = new McpServer(
    { name: "paydlux", version: version() },
    {
      instructions: [
        "Paydlux is spend-limited payments for AI agents. The money sits in a 2-of-2",
        "Stellar vault; the agent key is one signer, a human is the other, so an agent",
        "cannot release funds alone. Read paydlux_payment_rules before buying, check",
        "paydlux_check_payment for the specific amount, then paydlux_buy. If a buy",
        "returns needs_approval, tell the human and poll paydlux_payment_status — do not",
        `retry the purchase, and do not open the desk link yourself. ${HOME}`,
      ].join("\n"),
    },
  );

  // ---------------------------------------------------------------- reading

  server.registerTool("paydlux_status", {
    title: "Paydlux vault status",
    description: "Which vault this agent spends from: network, token, live balance, the XLM rent that keeps the account alive, who can sign, and how many spending mandates are live. Read-only.",
  }, async () => {
    const v = await vault(cfg);
    const signers = await v.signerSummary();
    const acc: any = await v.horizon.loadAccount(v.address);
    const xlm = acc.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";
    const min = ((2 + (acc.subentry_count ?? 0)) * 0.5).toFixed(1);
    return text({
      ok: true,
      network: cfg.network === "public" ? "mainnet (real money)" : "testnet",
      vault: v.address,
      token: cfg.token.code,
      balance: await v.balance(),
      xlm_rent: { have: xlm, need: min, short: Number(xlm) < Number(min) },
      thresholds: signers.thresholds,
      signers: signers.signers.map((s: any) => ({ weight: s.weight, kind: s.type })),
      live_mandates: signers.signers.filter((s: any) => s.type === "preauth-mandate").length,
      agent_key: cfg.agentPub,
      explorer: `https://stellar.expert/explorer/${cfg.network === "public" ? "account" : "testnet/account"}/${v.address}`,
      about: HOME,
    });
  });

  server.registerTool("paydlux_payment_rules", {
    title: "What the human allowed",
    description: "The spending mandate as the human set it: per-payment ceiling, daily budget, seller allow/deny lists, category ceilings — plus what has actually been spent today according to the ledger, not this process's memory. Call this before buying.",
  }, async () => {
    const v = await vault(cfg);
    const spent = await spentTodayAll(v);
    const p = policy.policy;
    return text({
      ok: true,
      token: cfg.token.code,
      max_per_payment: p.maxPerPayment,
      daily_budget: p.dailyBudget,
      spent_today_ledger: Number(spent.total.toFixed(4)),
      budget_left_today: Number((Number(p.dailyBudget ?? 0) - spent.total).toFixed(4)),
      paid_to: spent.byPayee,
      allowlist: p.allowlist?.length ? p.allowlist : "(any seller)",
      denylist: p.denylist ?? [],
      categories: p.categories ?? {},
      payee_categories: p.payeeCategory ?? {},
      max_live_mandates: p.maxLiveMandates,
      note: "The ceiling is enforced on the ledger, not here. Refusing you early only saves you a failed transaction.",
    });
  });

  server.registerTool("paydlux_check_payment", {
    title: "Would this payment be allowed?",
    description: "Dry-run one payment against the mandate: amount, seller, and anything already approved and waiting. Answers ok plus the headroom left, or which rule it breaks (max_per_payment, daily_budget, allowlist, denylist, category ceiling). No money moves.",
    inputSchema: {
      amount: z.number().positive().describe(`How much to pay, in the vault's token (${cfg.token.code})`),
      payee: z.string().optional().describe("Seller account id (G…, 56 chars). Defaults to the vault's configured payee."),
      committed: z.number().min(0).optional().describe("Amount already approved and still waiting on a signature, so the ceiling counts promises as well as payments"),
    },
  }, async ({ amount, payee, committed }) => {
    const to = payee ?? cfg.payee;
    if (!to) return fail("no payee: pass payee, or set payee.address in the vault file");
    const v = await vault(cfg);
    const spent = await spentTodayAll(v);
    // Seed the engine's day counter from the ledger before asking it anything.
    // Its own counter starts empty in every fresh process, so an unseeded check
    // would cheerfully approve a payment that blows a budget already spent —
    // and a restart would reset the ceiling the mandate advertises.
    policy.seedFromLedger(spent.total);
    const verdict = policy.check({ amount, payee: to, committed });
    return text({
      ok: verdict.ok,
      amount, payee: to, token: cfg.token.code,
      rule: verdict.ok ? undefined : (verdict as any).rule,
      why: verdict.ok ? undefined : (verdict as any).detail,
      spent_today_ledger: Number(spent.total.toFixed(4)),
      daily_budget: policy.policy?.dailyBudget,
      max_per_payment: policy.policy?.maxPerPayment,
    });
  });

  server.registerTool("paydlux_recent_payments", {
    title: "Recent payments from the vault",
    description: "The last payments in or out of the vault, straight from the Stellar ledger, with transaction hashes an explorer can verify. Read-only proof of what actually happened.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many records, default 10") },
  }, async ({ limit }) => text({ ok: true, payments: await recentPayments(await vault(cfg), limit ?? 10) }));

  server.registerTool("paydlux_escrow_status", {
    title: "Escrow state",
    description: "Look up a locked escrow by claimable-balance id: amount, when the seller can claim it, and until when the buyer can still take it back without the seller. Also reports who claimed it if it is already settled.",
    inputSchema: { balance_id: z.string().describe("The escrow's claimable balance id (starts with B…)") },
  }, async ({ balance_id }) => {
    const e = await readEscrow(cfg.network, balance_id);
    const outcome = await escrowOutcome(cfg.network, balance_id);
    if (!e) return text({ ok: true, escrow: null, outcome, note: "no live escrow with that id — it was claimed, refunded, or never existed" });
    const now = Math.floor(Date.now() / 1000);
    return text({
      ok: true,
      // One timer, two meanings: before releaseAt the buyer can take the money
      // back alone, after it the seller can claim it alone. There is no separate
      // refund deadline on the ledger, so do not invent one here.
      escrow: {
        balance_id: e.balanceId, amount: e.amount, asset: e.asset,
        buyer: e.buyer, vault: e.vault, release_at: e.releaseAt,
        lock_tx: e.txHash, memo: e.memo, claimed: e.claimed,
      },
      buyer_can_refund: !e.claimed && now < e.releaseAt,
      seconds_until_seller_can_claim: Math.max(0, e.releaseAt - now),
      outcome,
    });
  });

  server.registerTool("paydlux_pending_escrows", {
    title: "Escrows this vault is part of",
    description: "Every live escrow the vault is a claimant on, oldest release first, with each one's refund window. Read-only.",
  }, async () => {
    const list = await pendingEscrows(cfg.network, cfg.vault);
    const now = Math.floor(Date.now() / 1000);
    return text({
      ok: true, count: list.length,
      escrows: list.map((e) => ({
        balance_id: e.balanceId, amount: e.amount, asset: e.asset, buyer: e.buyer,
        release_at: e.releaseAt, buyer_can_refund: !e.claimed && now < e.releaseAt,
      })),
    });
  });

  // ---------------------------------------------------------------- buying

  if (!cfg.readOnly) {
    server.registerTool("paydlux_buy", {
      title: "Buy from a 402-gated seller",
      description: "GET (or POST to) a URL that prices itself with HTTP 402. If the seller runs in approval mode the request is parked for a human: the result carries `handle`, `status_url` and the human's `desk` link — report those to the human and poll paydlux_payment_status. Do NOT retry the buy: a second request creates a second approval. A seller demanding a pre-authorised mandate is refused here, because creating that mandate needs the human's keys, which this server does not hold.",
      inputSchema: {
        url: z.string().url().describe("The paid resource, e.g. https://seller.example.com/api/data"),
        body: z.string().optional().describe("Request body; sends POST instead of GET"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    }, async ({ url, body }) => {
      const agent = new PaydluxAgent({
        agentKey: cfg.agentSeed,
        network: cfg.network,
        // The agent must not sit inside one MCP call waiting for a person.
        approvalTimeoutMs: 5_000, pollMs: 2_000,
      });
      // Escrow routes are funded by the buyer's own account, never by the agent
      // key on a vault. The key is supplied out of band by whoever runs this
      // server; without it the seller's refusal is reported as-is.
      const buyerKey = process.env.PAYDLUX_BUYER_SECRET;
      const res: PayResponse = await agent.get(url, { body, buyerKey });
      const needsApproval = !res.ok && (res.handle || res.statusUrl);
      return text({
        ok: res.ok,
        status: res.status,
        data: clip(res.data),
        tx: res.tx,
        order: res.order,
        escrow: res.escrow,
        needs_approval: needsApproval || undefined,
        handle: res.handle,
        status_url: res.statusUrl,
        desk: res.desk ? `${res.desk} (open this yourself — it needs the human's portal key)` : undefined,
        reason: res.reason,
        error: res.error,
        requirements: res.requirements,
        next: needsApproval
          ? "tell the human to approve on their desk, then call paydlux_payment_status with status_url and handle"
          : undefined,
      });
    });

    server.registerTool("paydlux_payment_status", {
      title: "Did the human approve?",
      description: "One status check on a parked payment, using the status_url and handle paydlux_buy returned. Polls the seller's gateway, which needs no key. Returns the settled record (with the tx hash) once decided, or the current pending state.",
      inputSchema: {
        status_url: z.string().url().describe("The status_url from paydlux_buy — never the desk link"),
        handle: z.string().describe("The payment handle from paydlux_buy"),
        wait_seconds: z.number().int().min(0).max(120).optional().describe("Keep polling up to this long inside the call. Default 0 = one check"),
      },
    }, async ({ status_url, handle, wait_seconds }) => {
      const agent = new PaydluxAgent({
        agentKey: cfg.agentSeed, network: cfg.network,
        approvalTimeoutMs: (wait_seconds ?? 0) * 1000 + 2_000, pollMs: 2_000,
      });
      const rec = wait_seconds ? await agent.waitForApproval({ statusUrl: status_url } as any, handle)
        : await fetch(status_url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!rec) return text({ ok: true, status: "pending", handle, note: "no decision yet — check again in a few seconds" });
      return text({ ok: true, decision: rec });
    });
  }

  return server;
}

// ------------------------------------------------------------------- main

export async function start() {
  const file = resolve(process.cwd(), arg("file") ?? process.env.PAYDLUX_VAULT_FILE ?? "paydlux-vault.json");
  const cfg = load(file);
  const server = buildServer(cfg);
  await server.connect(new StdioServerTransport());
  // stdout is the JSON-RPC channel. Any human-facing line goes to stderr.
  console.error(`paydlux mcp: ${cfg.network} vault ${cfg.vault}, token ${cfg.token.code}, tools ${cfg.readOnly ? "read-only" : "read + buy"}. ${HOME}`);
}

// Run only when this file is the entry point, so importing it in a check is
// safe. Compare realpaths, not the invocation string: npm's bin launcher runs
// this as .../node_modules/.bin/paydlux-mcp, which does not end in .js, so a
// name-based test silently turns the published command into a no-op.
const invoked = process.argv[1]
  ? pathToFileURL(existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : process.argv[1]).href
  : undefined;
if (invoked === import.meta.url) {
  start().catch((e) => { console.error("paydlux mcp failed:", (e as Error).message); process.exit(1); });
}
