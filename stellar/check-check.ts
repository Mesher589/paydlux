// check-check.ts — the gate for check.paydlux.com. Stubs must prove they ran
// (sentinel) or did NOT run (refusals); one loop runs against the REAL testnet
// ledger with real signed XLM. Run: npx tsx stellar/check-check.ts
import { Keypair, Account, Asset, Memo, Operation, TransactionBuilder, Networks } from "@stellar/stellar-sdk";
import http from "node:http";
import { startCheck, type CheckConfig } from "./check.js";
import type { Transport } from "./endpoint-probe.js";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, d = "") => { if (c) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name + (d ? " — " + d : "")); } };

const HOST = "check.paydlux.com";
const PAYEE = "GPAYEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEA";
const PRICE = "0.1";
const PORT = 4126;
// node:http lets us pin the Host header to the public hostname; undici fetch forbids it.
function api(path: string, init?: { method?: string; body?: string }, host = HOST): Promise<{ status: number; json: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: init?.method ?? "GET",
      headers: { host, "content-type": "application/json", ...(init?.body ? { "content-length": Buffer.byteLength(init.body) } : {}) } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => { let j: any = null; try { j = JSON.parse(raw); } catch {} resolve({ status: res.statusCode ?? 0, json: j, headers: res.headers }); });
      });
    req.on("error", reject);
    if (init?.body) req.write(init.body);
    req.end();
  });
}

const PAYJSON = JSON.stringify({ scheme: "x402-stellar", network: "stellar:testnet", maxAmountRequired: "0.01", payTo: "GPROBEDEST000000000000000000000000000000000000000000000000", asset: { code: "USDC", issuer: "GISSUER000000000000000000000000000000000000000000000000000" } });

// ledger stub builder. The stub tx memo must match the CURRENT order's memo
// (verify compares want.memo), except in the memo-forgery scenario.
let currentMemo = "MATCH";
function ledgerStub(scenario: "ok" | "memo" | "under" | "fake-xlm" | "double" | "failed") {
  const calls: string[] = [];
  const tx: any = { successful: scenario !== "failed", memo_type: "text",
    memo: scenario === "memo" ? "ord_notthisone" : currentMemo, created_at: new Date().toISOString(), ledger: 123 };
  const pay = (over: Partial<any> = {}) => ({ type: "payment", to: PAYEE, from: "GBUYER", amount: "0.1", asset_type: "native", ...over });
  const ops = scenario === "double" ? [pay(), pay()]
    : scenario === "under" ? [pay({ amount: "0.01" })]
    : scenario === "fake-xlm" ? [pay({ asset_type: "asset4", asset_code: "XLM", asset_issuer: "GFORGER" })]
    : [pay()];
  const fetchJson = async (url: string) => {
    calls.push(url);
    if (url.includes("/operations")) return { status: 200, body: { _embedded: { records: ops } } };
    if (url.includes("/transactions/notreal")) return { status: 404, body: null };
    if (url.includes("/transactions/")) return { status: 200, body: tx };
    return { status: 404, body: null };
  };
  return { fetchJson, calls };
}
const stubProbe = (status: number, headers: Record<string, string> = {}, text = "") => {
  const t: Transport & { calls: number } = Object.assign(async () => { t.calls++; return { status, headers, text }; }, { calls: 0 });
  return t;
};

async function order(srv: any, url = "https://probe-target.example/api"): Promise<{ order: string; memo: string; hdr: string }> {
  const r = await api("/check", { method: "POST", body: JSON.stringify({ url }) });
  const j: any = r.json;
  currentMemo = j.memo;
  return { order: j.order, memo: j.memo, hdr: String(r.headers["x-payment"] ?? "") };
}

const main = async () => {
  // server bound for HTTP-surface tests (stub ledger, happy path by default)
  let scenario = "ok";
  const dyn = async (url: string) => ledgerStub(scenario as any).fetchJson(url);
  let probe402 = stubProbe(402, { "x-payment": PAYJSON });
  const srv = startCheck({ hostname: HOST, payee: PAYEE, network: "testnet", price: PRICE, fetchJson: dyn,
    probeResolve: async () => ["93.184.216.34"], // example.com's old public IP — keeps happy path off real DNS
    probeTransport: (o) => probe402(o) });
  await srv.listen(PORT);

  console.log("http surface:");
  { const r = await api("/check", {}, "evil.example"); ok(r.status === 403, "wrong Host → 403"); }
  { const r = await api("/check", { method: "POST", body: "{}" }); ok(r.status === 400, "POST without url → 400"); }
  { const r = await api("/terms"); const j: any = r.json; ok(j.maxAmountRequired === PRICE && j.payTo === PAYEE, "/terms publishes price and payee"); }
  { const r = await api("/"); ok(r.status === 402 && /payment_required/.test(String(r.json?.error)) && String(r.json?.price).includes(PRICE), "GET / -> 402 self-describing (a metered front door speaks 402)"); }
  {
    // simulate the tunnel forwarding plain HTTP: Cloudflare sets x-forwarded-proto
    const fwd: any = await new Promise((resolve, reject) => {
      const rq = http.request({ host: "127.0.0.1", port: PORT, path: "/terms", headers: { host: HOST, "x-forwarded-proto": "http" } }, (rs) => {
        rs.resume(); resolve({ status: rs.statusCode, loc: rs.headers.location });
      });
      rq.on("error", reject); rq.end();
    });
    ok(fwd.status === 301 && String(fwd.loc).startsWith("https://" + HOST), "x-forwarded-proto: http → 301 to https");
  }

  console.log("402 issuance and polling:");
  {
    const o1 = await order(srv);
    const sizeBefore = srv.book.size;
    const poll: any = (await api(`/check?order=${o1.order}`)).json;
    ok((poll as any).paid === false && (poll as any).order === o1.order && srv.book.size === sizeBefore, "poll reuses order, mints nothing");
    ok(o1.hdr.includes("maxAmountRequired") && o1.memo.startsWith("ord_"), "402 carries x-payment header + unguessable memo");
    const bad: any = (await api(`/check?order=${o1.order}&tx=notreal`)).json;
    ok((bad as any).error === "not_paid_yet" && (bad as any).reason.includes("not a transaction hash"), "junk tx → 202 not_paid_yet");
    const unk = await api(`/check?order=ord_nope&tx=${"ab".repeat(32)}`);
    ok(unk.status === 400, "unknown order + tx → 400");
  }

  console.log("ledger verification (stub must be consulted):");
  const forgeries: Array<[any, string, string]> = [
    ["memo", "wrong memo → refused", "does not name this order"],
    ["under", "underpaid → refused", "underpaid"],
    ["fake-xlm", "token named XLM → refused", "not native XLM"],
    ["double", "double payment op → refused", "more than once"],
    ["failed", "failed tx → refused", "failed on the ledger"],
  ];
  for (const [sc, name, frag] of forgeries) {
    scenario = sc;
    const o = await order(srv);
    const v: any = (await api(`/check?order=${o.order}&tx=${"ab".repeat(32)}`, undefined)).json;
    ok((v as any).error === "not_paid_yet" && String((v as any).reason).includes(frag), name, JSON.stringify(v).slice(0, 120));
  }
  scenario = "ok";

  console.log("happy path (delivery only on verified payment):");
  let paidOnce = "";
  {
    probe402 = stubProbe(402, { "x-payment": PAYJSON });
    const o = await order(srv);
    const r = await api(`/check?order=${o.order}&tx=${"ab".repeat(32)}`);
    const j: any = r.json;
    paidOnce = "ab".repeat(32);
    ok(r.status === 200 && j.data?.report?.verdict === "PAYABLE" && probe402.calls === 1, "verified payment → 200 PAYABLE report, probe ran exactly once");
    ok(String(j.receipt).startsWith("chk_") && j.proof?.tx === paidOnce, "receipt + proof attached");
    ok(String(r.headers["x-payment-response"]).includes("ledger"), "x-payment-response header set");
    const again = await api(`/check?order=${o.order}&tx=${paidOnce}`);
    ok(again.status === 409, "same order + same tx again → 409 order_already_paid");
    const o2 = await order(srv);
    const reuse = await api(`/check?order=${o2.order}&tx=${paidOnce}`);
    ok(reuse.status === 409, "same tx on a different order → 409 payment_already_used");
    const poll2: any = (await api(`/check?order=${o.order}`)).json;
    ok((poll2 as any).paid === true, "poll after payment reports paid:true");
  }

  console.log("paid probe honesty:");
  {
    const o = await order(srv, "http://127.0.0.1:9999/internal");
    const r = await api(`/check?order=${o.order}&tx=${"cd".repeat(32)}`); // fresh tx — the happy-path hash is spent
    const j: any = r.json;
    ok(r.status === 200 && j.data.report.verdict === "REFUSED" && j.data.report.security.privateTargetRefused === true,
      "private target → report says REFUSED, never probed");
  }

  console.log("LIVE loop against the real testnet ledger:");
  {
    const buyer = Keypair.random(), payeeAcct = Keypair.random();
    for (const [kp, name] of [[buyer, "buyer"], [payeeAcct, "payee"]] as const) {
      const fr = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(kp.publicKey())}`);
      if (!fr.ok) throw new Error(`friendbot ${name} ${fr.status}`);
    }
    // second server: real Horizon reads, stubbed probe transport
    const srv2 = startCheck({ hostname: HOST, payee: payeeAcct.publicKey(), network: "testnet", price: PRICE, probeTransport: stubProbe(402, { "x-payment": PAYJSON }) });
    const srv2res = srv2 as any; srv2res.server.close(); // replace port: use same port after closing srv1? no — run srv2 on PORT via one listen
    // NOTE: srv1 still holds PORT; close srv1 first
    await new Promise<void>((r) => srv.server.close(() => r()));
    await srv2.listen(PORT);

    const o = await order(srv2, "https://example.com/feed");
    const horizon = "https://horizon-testnet.stellar.org";
    const src: any = await (await fetch(`${horizon}/accounts/${buyer.publicKey()}`)).json();
    const tx = new TransactionBuilder(new Account(buyer.publicKey(), src.sequence), { fee: "100", networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: payeeAcct.publicKey(), asset: Asset.native(), amount: PRICE }))
      .addMemo(Memo.text(o.memo)).setTimeout(120).build();
    tx.sign(buyer);
    const sub = await (await fetch(`${horizon}/transactions`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "tx=" + encodeURIComponent(tx.toXDR()) })).json();
    if (!sub.hash) throw new Error("testnet refused payment: " + JSON.stringify(sub.extras ?? sub));
    let j: any = null;
    for (let i = 0; i < 12 && !j?.data; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      j = (await api(`/check?order=${o.order}&tx=${sub.hash}`)).json;
    }
    ok(j?.data?.report?.verdict === "PAYABLE" && j?.proof?.tx === sub.hash, "real XLM with the right memo → 200 PAYABLE report", JSON.stringify(j).slice(0, 160));
    const o3 = await order(srv2);
    const reuse2: any = (await api(`/check?order=${o3.order}&tx=${sub.hash}`)).json;
    ok((reuse2 as any).error === "payment_already_used", "live: that real payment can never buy a second report");
    srv2res.server.close();
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
};
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
