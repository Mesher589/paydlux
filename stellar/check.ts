// check.paydlux.com — the metered endpoint-check API. POST a URL, pay $0.01
// (0.1 XLM) through Paydlux's own 402 door, get back a verified safety report
// of what that endpoint would demand from an agent before it pays.
//
// Built entirely from primitives that already carry regression suites:
//   OrderBook + verifyIncomingPayment (receive.ts) — the ledger is the only witness
//   probeEndpoint (endpoint-probe.ts)             — refuses what it cannot fully read
//
// The probe runs AFTER payment is verified — a free probe would turn this
// service into a free scanner, which is exactly the abuse the probe prevents.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { OrderBook, verifyIncomingPayment, type Network } from "./receive.js";
import { probeEndpoint, type Resolver, type Transport } from "./endpoint-probe.js";

export const CHECK_PORT = 4026;
export const CHECK_HOST = "check.paydlux.com";
type FetchJson = (url: string) => Promise<{ status: number; body: any } | null>; // same seam shape as receive.ts
export type CheckConfig = {
  hostname: string;
  payee: string;
  network: Network;
  price: string;                        // decimal XLM string
  fetchJson?: FetchJson;                // ledger seam for tests
  probeResolve?: Resolver;              // DNS seam
  probeTransport?: Transport;           // probe network seam
};

type Pending = { url: string; createdAt: number };

export function startCheck(cfg: CheckConfig) {
  const book = new OrderBook(3600);
  const pending = new Map<string, Pending>();
  const sweepPending = () => {
    const cut = Date.now() - 3600_000;
    for (const [id, p] of pending) if (p.createdAt < cut) pending.delete(id);
  };

  const terms = (order?: { id: string; memo: string }) => ({
    scheme: "stellar-exact",
    network: `stellar:${cfg.network}`,
    maxAmountRequired: cfg.price,
    payTo: cfg.payee,
    token: { code: "XLM", issuer: null },
    mode: "metered-check",
    memo: order?.memo, order: order?.id,
    maxTimeoutSeconds: 3600, version: "1",
    note: "is endpoint safe before your agent pays it; verified on the ledger",
  });

  const server = createServer(async (req, res) => {
    // The tunnel forwards plain HTTP too. Order+memo over http are stealable
    // — a watcher could pay for YOUR order and collect the report — so any
    // x-forwarded-proto: http (set by Cloudflare, not the client) is 301'd.
    if (req.headers["x-forwarded-proto"] === "http") {
      res.writeHead(301, { location: "https://" + (req.headers.host ?? cfg.hostname) + (req.url ?? "/"), "cache-control": "no-store" });
      res.end();
      return;
    }
    const send = (code: number, body: any, extra: Record<string, string> = {}) => {
      res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "strict-transport-security": "max-age=31536000; includeSubDomains", ...extra });
      res.end(JSON.stringify(body));
    };
    if ((req.headers.host ?? "").split(":")[0] !== cfg.hostname) { send(403, { error: "wrong_host" }); return; }

    const url = new URL(req.url ?? "/", `http://${cfg.hostname}`);
    const p = url.pathname;
    if (p === "/terms") { send(200, terms()); return; }
    // A metered service whose front door answers 404 fails the one test the
    // x402 world runs on it: GET / must say Payment Required. This 402 is
    // self-describing (how to buy, what it costs) without issuing an order —
    // issuance stays POST-only by design.
    if (p === "/") {
      send(402, {
        error: "payment_required",
        service: "paydlux check — read a 402 endpoint's terms before your agent pays it",
        how: 'POST /check {"url":"https://target"} to open an order, pay the terms it returns, then GET /check?order=ID&tx=HASH',
        price: cfg.price + " XLM (native) on stellar:public",
        docs: "https://paydlux.com/check/",
        terms: "https://check.paydlux.com/terms",
      });
      return;
    }
    if (p !== "/check") { send(404, { error: "not_found", hint: "POST /check {url, vault?}; then GET /check?order=ID&tx=HASH" }); return; }

    sweepPending();
    let body: any = null;
    if (req.method === "POST") {
      let raw = "";
      for await (const c of req) { raw += c; if (raw.length > 16_000) break; }
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
    }

    const tx = url.searchParams.get("tx");
    const asked = url.searchParams.get("order") ?? body?.order;

    // paid delivery
    if (tx) {
      const order = asked ? book.get(asked) : undefined;
      if (!order) { send(400, { error: "unknown_order", hint: "POST /check {url} first, then pay, then retry with ?tx=" }); return; }
      if (order.redeemedTx) { send(409, { error: "order_already_paid", tx: order.redeemedTx }); return; }
      if (book.isSpent(tx)) { send(409, { error: "payment_already_used" }); return; }
      const v = await verifyIncomingPayment(tx, {
        payee: cfg.payee, amount: cfg.price, asset: { code: "XLM" },
        memo: order.memo, from: order.buyer, network: cfg.network,
      }, cfg.fetchJson);
      if (!v.ok) { send(202, { error: "not_paid_yet", reason: v.reason, order: order.id, memo: order.memo }); return; }

      book.markSpent(tx, order.id);
      const target = pending.get(order.id)?.url ?? "";
      pending.delete(order.id);
      const report = await probeEndpoint(target, { resolve: cfg.probeResolve, transport: cfg.probeTransport });
      const receipt = "chk_" + createHash("sha256").update(order.id + "|" + tx).digest("hex").slice(0, 12);
      send(200, {
        data: { checked: target, report },
        receipt,
        proof: { tx: v.tx, amount: v.amount, paidAt: v.paidAt, from: v.from, ledger: v.ledger,
          verify: `curl https://horizon${cfg.network === "public" ? "" : "-testnet"}.stellar.org/transactions/${v.tx}` },
      }, { "x-payment-response": JSON.stringify({ tx: v.tx, ledger: v.ledger }) });
      return;
    }

    // status poll — must not mint
    if (asked) {
      const order = book.get(asked);
      if (!order) { send(404, { error: "unknown_order", hint: "the order expired; ask for a new one" }); return; }
      if (order.redeemedTx) { send(200, { paid: true, tx: order.redeemedTx, order: order.id }); return; }
      send(202, { paid: false, order: order.id, memo: order.memo, reason: "no payment seen for this order yet" });
      return;
    }

    // new request → 402 with a bound order
    if (req.method !== "POST" || typeof body?.url !== "string" || body.url.length > 2048) {
      send(400, { error: "bad_request", hint: "POST /check with {\"url\": \"https://…\", \"vault\": \"G…\"(optional)}" });
      return;
    }
    const order = book.issue(cfg.price, { code: "XLM" }, body.vault ? String(body.vault) : undefined);
    pending.set(order.id, { url: body.url, createdAt: Date.now() });
    send(402, { error: "payment_required", ...terms(order) }, { "x-payment": JSON.stringify(terms(order)) });
  });

  return {
    server, book, pending,
    listen: (port: number) => new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r())),
  };
}
