// Paydlux as the SELLER: accept a payment drawn on someone else's vault.
//
// Everything built so far pays OUT of our vault. This is the other door — a
// stranger's agent pays US, from THEIR vault, approved on THEIR phone. Our
// thumb is nowhere in it, and it cannot be: we hold no key that can move their
// money, and they hold none that can move ours.
//
// The security question flips. When we pay, we sign, so we already know. When
// we receive, a stranger CLAIMS they paid, and the claim is attacker-controlled
// text. So the claim is worth nothing until this file has re-read the ledger and
// matched every field against the order we issued. The ledger is the only
// witness; the buyer is a witness against themselves.
//
// Why this is safe to expose publicly: verifying an incoming payment needs a
// public ledger read and nothing else. No custody, no key, no counterparty
// risk. A wrong answer costs us content we did not get paid for, and the checks
// below are what stop that.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export type Network = "testnet" | "public";

const HORIZON: Record<Network, string> = {
  testnet: "https://horizon-testnet.stellar.org",
  public: "https://horizon.stellar.org",
};

export type Want = {
  /** the account the money must land in */
  payee: string;
  /** minimum amount, as a decimal string */
  amount: string;
  /** "XLM" for native, otherwise a code+issuer pair */
  asset: { code: string; issuer?: string };
  /** the order the payment must name in its memo */
  memo: string;
  /** the vault the payment must come from (bound when the order was issued) */
  from?: string;
  /** how old a payment may be and still count */
  maxAgeSeconds?: number;
  /** which network to read */
  network?: Network;
};

export type Verdict =
  | { ok: true; tx: string; amount: string; paidAt: string; from: string; ledger: number }
  | { ok: false; reason: string };

type Json = Record<string, any>;
type FetchJson = (url: string) => Promise<{ status: number; body: any } | null>;

const defaultFetch: FetchJson = async (url) => {
  const r = await fetch(url).catch(() => null);
  if (!r || !r.ok) return r ? { status: r.status, body: null } : null;
  return { status: r.status, body: await r.json().catch(() => null) };
};

/**
 * Has this transaction really paid us, in full, for this order?
 *
 * Every field below is a separate forgery attempt, so each is checked against
 * the ledger's own answer rather than the caller's:
 *
 *   hash unknown / tx failed        → nothing happened
 *   pays a different account        → not our money
 *   underpays                       → partial payment is not payment
 *   a fake token called "XLM"       → anyone can name a token anything; only
 *                                     native XLM, or an exact code+issuer pair,
 *                                     is the asset we priced the order in
 *   wrong or missing memo           → cannot be tied to this order, so one
 *                                     real payment could be reused for many
 *   pays us for someone else's order→ same reason, from the other side
 *   ancient payment                 → a payment from last year is not this one
 *   from a vault we never issued    → the order binds its buyer at 402 time
 *
 * Amounts are compared as numbers because Stellar normalises to 7 decimals.
 */
export async function verifyIncomingPayment(
  hash: string,
  want: Want,
  fetchJson: FetchJson = defaultFetch,
): Promise<Verdict> {
  if (!/^[0-9a-f]{64}$/.test(hash ?? "")) return { ok: false, reason: "not a transaction hash" };

  const network = want.network ?? "public";
  const base = HORIZON[network];

  const txRes = await fetchJson(`${base}/transactions/${hash}`);
  if (!txRes) return { ok: false, reason: "the ledger could not be reached" };
  if (txRes.status === 404) return { ok: false, reason: "no such transaction on this network" };
  if (!txRes.body) return { ok: false, reason: "the ledger returned an unreadable answer" };
  const tx: Json = txRes.body;

  // A transaction can exist and still have failed. Its hash is real and its
  // money never moved.
  if (tx.successful !== true) return { ok: false, reason: "the transaction failed on the ledger" };

  // The memo is on the transaction, so it is bound to the payment itself and
  // cannot be chosen later by whoever submits it.
  if (tx.memo_type !== "text" || tx.memo !== want.memo) {
    return { ok: false, reason: "the payment does not name this order" };
  }

  const age = want.maxAgeSeconds ?? 3600;
  const at = Date.parse(tx.created_at ?? "");
  if (!Number.isFinite(at)) return { ok: false, reason: "the payment has no readable time" };
  if (Date.now() - at > age * 1000) {
    return { ok: false, reason: `the payment is older than ${age} seconds` };
  }

  const opsRes = await fetchJson(`${base}/transactions/${hash}/operations?limit=100`);
  if (!opsRes || !opsRes.body) return { ok: false, reason: "the ledger operations could not be read" };
  const ops: Json[] = opsRes.body?._embedded?.records ?? [];

  // Exactly one payment to us, at the right price, in the right asset. More
  // than one would let a bundle hide a short payment inside it.
  const ours = ops.filter((o) => o.type === "payment" && o.to === want.payee);
  if (ours.length === 0) return { ok: false, reason: "the transaction does not pay this account" };
  if (ours.length > 1) return { ok: false, reason: "the transaction pays this account more than once" };

  const op = ours[0];
  if (Number(op.amount) < Number(want.amount)) {
    return { ok: false, reason: `underpaid: sent ${op.amount}, the order is ${want.amount}` };
  }

  if (want.asset.issuer) {
    if (op.asset_type === "native") return { ok: false, reason: "the order is priced in a token, not XLM" };
    if (op.asset_code !== want.asset.code || op.asset_issuer !== want.asset.issuer) {
      return { ok: false, reason: `paid in ${op.asset_code}, not the priced asset` };
    }
  } else {
    // Native XLM only. A token someone else issued and *named* XLM is not XLM:
    // asset_type is the only field that distinguishes them.
    if (op.asset_type !== "native") {
      return { ok: false, reason: `paid in a token called ${op.asset_code}, not native XLM` };
    }
  }

  if (want.from && op.from !== want.from) {
    return { ok: false, reason: "the payment did not come from the vault this order was issued to" };
  }

  return {
    ok: true,
    tx: hash,
    amount: String(op.amount),
    paidAt: tx.created_at,
    from: op.from,
    ledger: Number(tx.ledger),
  };
}

// ------------------------------------------------------------------ order book

type Order = {
  id: string;
  memo: string;
  amount: string;
  asset: { code: string; issuer?: string };
  buyer?: string;
  createdAt: number;
  /** set once a payment has been matched, so one payment buys one order */
  redeemedTx?: string;
};

/**
 * Orders live in memory on purpose. An unpaid order is worth nothing to anyone,
 * and a redeemed one is recorded on the ledger forever — the durable record is
 * the payment, not our book. A restart loses pending orders, which is correct:
 * the buyer just asks again.
 */
export class OrderBook {
  private orders = new Map<string, Order>();
  private byMemo = new Map<string, string>();
  /** tx hashes already spent, so one payment can never buy two orders */
  private spent = new Set<string>();

  constructor(private ttlSeconds = 3600) {}

  issue(amount: string, asset: { code: string; issuer?: string }, buyer?: string): Order {
    this.sweep();
    const id = "ord_" + randomBytes(6).toString("hex");
    // The memo is what ties a ledger payment to an order, so it has to be
    // unguessable and unique. A short or sequential memo would let a stranger
    // pay for an order they never asked for and claim someone else's.
    const memo = id;
    const o: Order = { id, memo, amount, asset, buyer, createdAt: Date.now() };
    this.orders.set(id, o);
    this.byMemo.set(memo, id);
    return o;
  }

  get(id: string): Order | undefined { return this.orders.get(id); }
  isSpent(tx: string): boolean { return this.spent.has(tx); }
  markSpent(tx: string, id: string) {
    this.spent.add(tx);
    const o = this.orders.get(id);
    if (o) o.redeemedTx = tx;
  }
  get size(): number { return this.orders.size; }

  private sweep() {
    const cut = Date.now() - this.ttlSeconds * 1000;
    for (const [id, o] of this.orders) if (o.createdAt < cut) {
      this.orders.delete(id); this.byMemo.delete(o.memo);
    }
  }
}

// ---------------------------------------------------------------------- server

export type ReceiveConfig = {
  port: number;
  host?: string;
  hostname: string;
  payee: string;
  network: Network;
  price: string;
  asset: { code: string; issuer?: string };
  /** what the buyer gets once the ledger confirms they paid */
  deliver: (order: Order) => { content: any; receipt: string };
  explorer?: string;
  fetchJson?: FetchJson;
};

/**
 * A public seller endpoint. Two routes only:
 *
 *   GET  /donate            → 402 with the price and how to pay
 *   POST /donate             → same, and issues an order to name in the memo
 *   GET  /donate?tx=HASH     → verify on the ledger, then deliver
 *
 * Nothing else is reachable: no queue, no keys, no admin. The worst this port
 * can do is hand out content we were actually paid for.
 */
export function startReceive(cfg: ReceiveConfig) {
  const book = new OrderBook(3600);
  const explorer = cfg.explorer ?? `https://stellar.expert/explorer/${cfg.network === "public" ? "account" : "testnet/account"}`;

  const terms = (order?: Order) => ({
    scheme: "stellar-exact",
    network: `stellar:${cfg.network}`,
    maxAmountRequired: cfg.price,
    payTo: cfg.payee,
    token: cfg.asset.issuer ? cfg.asset : { code: "XLM", issuer: null },
    mode: "buyer-escrow",
    memo: order?.memo,
    order: order?.id,
    buyerVault: order?.buyer,
    maxTimeoutSeconds: 3600,
    version: "1",
    note: "pay from your own vault with your own mandate; we verify on the ledger",
  });

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://${cfg.hostname}`);
    const p = url.pathname;

    const send = (code: number, body: any, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", ...extra });
      res.end(JSON.stringify(body));
    };

    // Host pinning, same rule as the desk and the showcase: a public hostname
    // must not be reachable by IP or by another name pointed at this port.
    if ((req.headers.host ?? "").split(":")[0] !== cfg.hostname) {
      send(403, { error: "wrong_host" });
      return;
    }

    if (p !== "/donate") { send(404, { error: "not_found" }); return; }

    const tx = url.searchParams.get("tx");
    if (tx) {
      const id = url.searchParams.get("order");
      const order = id ? book.get(id) : undefined;
      if (!order) { send(400, { error: "unknown_order", hint: "POST /donate first, then pay, then retry with ?tx=" }); return; }
      if (order.redeemedTx) { send(409, { error: "order_already_paid", tx: order.redeemedTx }); return; }
      // One payment, one order. Without this a stranger who learns a real hash
      // could spend it against every order that names the same amount.
      if (book.isSpent(tx)) { send(409, { error: "payment_already_used" }); return; }

      const v = await verifyIncomingPayment(tx, {
        payee: cfg.payee, amount: cfg.price, asset: cfg.asset,
        memo: order.memo, from: order.buyer, network: cfg.network,
      }, cfg.fetchJson);

      if (!v.ok) {
        // Still unpaid: the buyer retries, that is the protocol. 202 keeps the
        // order alive rather than burning it on a bad guess.
        send(202, { error: "not_paid_yet", reason: v.reason, order: order.id, memo: order.memo });
        return;
      }

      book.markSpent(tx, order.id);
      const out = cfg.deliver(order);
      send(200, {
        data: out.content,
        receipt: out.receipt,
        proof: {
          tx: v.tx, amount: v.amount, paidAt: v.paidAt, from: v.from, ledger: v.ledger,
          explorer: `${explorer}/${cfg.payee}`,
          verify: `curl ${HORIZON[cfg.network]}/transactions/${v.tx}`,
        },
      }, { "x-payment-response": JSON.stringify({ tx: v.tx, ledger: v.ledger }) });
      return;
    }

    // No tx yet: issue an order and answer 402. The memo in the terms is what
    // the buyer's mandate must carry, and it is what we will match later.
    const body = await readBody(req);
    const buyer = body?.vault ? String(body.vault) : undefined;
    const order = book.issue(cfg.price, cfg.asset, buyer);
    send(402, { error: "payment_required", ...terms(order) }, { "x-payment": JSON.stringify(terms(order)) });
  });

  return { server, book };
}

async function readBody(req: IncomingMessage): Promise<any> {
  if (req.method !== "POST") return null;
  let raw = "";
  for await (const c of req) { raw += c; if (raw.length > 64_000) break; }
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

/** Stable, non-secret id for an order, used in logs. */
export function orderTag(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8);
}
