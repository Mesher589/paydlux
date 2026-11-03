#!/usr/bin/env npx tsx
// The donation door, end to end, at the HTTP layer.
//
// receive-check.ts proves verifyIncomingPayment refuses forged claims. This
// file proves the *server around it* is safe to put on a public hostname:
//   - the page and its script serve with a strict CSP and no inline script
//   - polling an order never mints a new order (the bug that would make a
//     buyer poll forever and never see their own payment)
//   - one payment can never redeem two orders
//   - a wrong-host request is refused, so the loopback port cannot be driven
//     directly past the tunnel
//   - the full happy path: 402 -> pay with the memo -> 200 with a ledger proof
//
//   npx tsx stellar/donate-check.ts
import http from "node:http";
import { startDonate } from "./donate";
import { verifyIncomingPayment } from "./receive";
import { qrSvg } from "./qr";
import jsQR from "jsqr";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \x1b[32m✓\x1b[0m " + m)) : (fail++, console.log("  \x1b[31m✗ " + m + "\x1b[0m")); };
const why = (e: any) => e?.message ?? String(e);
// node:http gives a plain object of lowercased header names, not a Headers map.
const hdr = (h: any, n: string) => String(h?.[n.toLowerCase()] ?? "");

const HOST = "donate.test";
const PAYEE = "GA7GYYMXCFBRKT4L3YLBRVL4ZKTBZ3CQ5LT4L4Q27VDASISNSGLLEQ3R";
const BUYER = "GCGT7S4J5G5TCWIXCUY5VVDMW3FGWXMPRLALAVHYXOLMSZU7IKJF2FHJ";
// The seller side of the page: whose vault the money lands in. Distinct from
// PAYEE on purpose, so a test can tell "the page shows the seller's vault" from
// "the page shows whatever the 402 terms happen to name".
const SELLER_VAULT = "GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB";

// A stub ledger: the same shape Horizon returns, so the route logic is under
// test here rather than the network.
// Mirrors the fields verifyIncomingPayment actually reads: the memo and
// success live on the TRANSACTION, the money lives on the OPERATION.
function stubLedger(pay: { hash: string; amount: string; memo: string; from: string; asset?: any; fail?: boolean }) {
  return async (url: string) => {
    if (url.includes("/operations")) {
      return { status: 200, body: { _embedded: { records: [{
        hash: pay.hash, type: "payment", transaction_successful: !pay.fail,
        from: pay.from, to: PAYEE, amount: pay.amount,
        ...(pay.asset ?? { asset_type: "native" }),
      }] } } };
    }
    if (url.includes("/transactions/")) {
      const hash = url.split("/transactions/")[1].split("?")[0];
      if (hash !== pay.hash) return { status: 404, body: null };
      return { status: 200, body: {
        hash, successful: !pay.fail, ledger: 5526645,
        created_at: new Date().toISOString(),
        memo_type: "text", memo: pay.memo, source_account: pay.from,
      } };
    }
    return { status: 404, body: null };
  };
}

/**
 * fetch() refuses to set Host (forbidden header), and the Host pin is exactly
 * what this file has to prove. So drive the socket directly: connect to
 * loopback, claim whatever hostname the test wants.
 */
function raw(port: number, path: string, opts: { host?: string; method?: string; body?: any } = {}) {
  return new Promise<any>((resolve, reject) => {
    const r = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path,
        headers: { Host: opts.host ?? HOST, ...(opts.body ? { "content-type": "application/json" } : {}) } },
      (res) => {
        let text = "";
        res.on("data", (c: Buffer) => text += c);
        res.on("end", () => {
          let json: any = null; try { json = JSON.parse(text); } catch { /* html */ }
          resolve({ status: res.statusCode, json, text, headers: res.headers });
        });
      });
    r.on("error", reject);
    if (opts.body) r.write(JSON.stringify(opts.body));
    r.end();
  });
}
const askFor = (port: number) => raw(port, "/donate", { method: "POST", body: {} });

async function main() {
  const port = 4199;
  const svc = startDonate({
    port, hostname: HOST, payee: PAYEE, network: "testnet",
    price: "3", asset: { code: "XLM" }, vault: SELLER_VAULT,
    explorer: "https://stellar.expert/explorer/testnet/account",
  });
  // The stub has to be installed before any request, and startDonate builds
  // its own config, so drive the routes through a second instance the test owns.
  await svc.listen(port);
  const get = (path: string, host = HOST, method = "GET", body?: any) =>
    raw(port, path, { host, method, body });

  console.log("\nthe page a human opens");
  {
    const p = await get("/");
    ok(p.status === 200 && p.text.includes("<h1>"), "GET / serves a page, not a 404");
    const csp = hdr(p.headers, "content-security-policy");
    ok(/script-src 'self'/.test(csp) && !/script-src[^;]*unsafe-inline/.test(csp),
      "the page allows no inline script");
    ok(!/<script>[^<]/.test(p.text), "and contains no inline script either");
    ok(hdr(p.headers, "x-content-type-options") === "nosniff", "nosniff is set");
    const s = await get("/donate.js");
    ok(s.status === 200 && /fetch\("\/donate"/.test(s.text), "the page's script is a separate file");
    ok(!/crypto|Keypair|secretKey|signTransaction|ed25519/i.test(s.text),
      "the browser script holds no key material and calls no signing primitive");
  }

  // The QR is the one part of this page that moves money by itself: a person
  // scans it and sends. So the picture must encode the SAME account this server
  // verifies payments into — not a constant baked in at build time, and not the
  // vault address when the money actually lands in the payee account.
  console.log("\nthe QR encodes the address this door actually gets paid into");
  {
    const q = await get("/qr.svg");
    ok(q.status === 200 && /^image\/svg\+xml/.test(hdr(q.headers, "content-type")),
      `GET /qr.svg serves svg (${q.status} ${hdr(q.headers, "content-type")})`);
    ok(hdr(q.headers, "x-content-type-options") === "nosniff", "the svg is not sniffable");
    const p = await get("/");
    ok(/<img src="\/qr\.svg"/.test(p.text), "the page embeds the QR from its own origin");
    ok(/img-src 'self'/.test(hdr(p.headers, "content-security-policy")),
      "and the CSP still allows only same-origin images");
    ok(p.text.includes(`<pre class="addr">${PAYEE}</pre>`),
      "the address printed next to the QR is the account this door verifies payments into");

    // Decode the served svg back into a module matrix and compare against a
    // fresh render of the payee address. A stale or hardcoded address fails here.
    const modules = (svg: string): string => {
      const n = Number(svg.match(/viewBox="0 0 (\d+) /)![1]) / 4;
      const grid: boolean[] = Array(n * n).fill(false);
      for (const m of svg.matchAll(/M(\d+) (\d+)h(\d+)v4h-\3z/g)) {
        const c = Number(m[1]) / 4, r = Number(m[2]) / 4, w = Number(m[3]) / 4;
        for (let k = 0; k < w; k++) grid[r * n + c + k] = true;
      }
      return grid.map((x) => (x ? "1" : "0")).join("");
    };
    ok(modules(q.text) === modules(qrSvg(PAYEE)),
      "the QR's modules match a fresh render of the verified payee account");
    // The page also names the seller's vault, a DIFFERENT account here. If the
    // QR and the printed address ever disagreed, a human scanning the code
    // would send money somewhere the 402 terms never named. This stops that.
    ok(modules(q.text) !== modules(qrSvg(SELLER_VAULT)),
      "and it is not the vault address the page also mentions");
    ok(!p.text.includes(`<pre class="addr">${SELLER_VAULT}</pre>`),
      "the page prints exactly one scannable address, and it matches the QR");

    // The strongest version of this test: put the served picture through a real
    // QR decoder and read the address back out. If the svg were malformed, the
    // quiet zone wrong, or the encoding off, a phone would scan nothing and the
    // page would silently stop taking money.
    const bitmap = (svg: string) => {
      const n = Number(svg.match(/viewBox="0 0 (\d+) /)![1]) / 4;
      const dark = new Set<number>();
      for (const m of svg.matchAll(/M(\d+) (\d+)h(\d+)v4h-\3z/g)) {
        const c = Number(m[1]) / 4, r = Number(m[2]) / 4, w = Number(m[3]) / 4;
        for (let k = 0; k < w; k++) dark.add(r * n + c + k);
      }
      const scale = 8, quiet = 4, size = (n + quiet * 2) * scale;
      const px = new Uint8ClampedArray(size * size * 4).fill(255);
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        if (!dark.has(r * n + c)) continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
          const y = (r + quiet) * scale + dy, x = (c + quiet) * scale + dx;
          const i = (y * size + x) * 4;
          px[i] = px[i + 1] = px[i + 2] = 0; px[i + 3] = 255;
        }
      }
      return { px, size };
    };
    const { px, size } = bitmap(q.text);
    const read = jsQR(px, size, size);
    ok(read?.data === PAYEE, read ? `a scanner reads the address back: ${read.data.slice(0, 12)}…`
      : "nothing decodable in the served QR");
  }

  console.log("\nthe door refuses to be driven around the tunnel");
  {
    const wrong = await get("/donate", "127.0.0.1");
    ok(wrong.status === 403 && wrong.json?.error === "wrong_host",
      `a request by IP is refused (${wrong.status} ${wrong.json?.error})`);
    const other = await get("/", "evil.example");
    ok(other.status === 403, "the page is refused on another hostname too");
    const admin = await get("/queue");
    ok(admin.status === 404, "no desk/admin route is reachable from this port");
    const keys = await get("/donate/../desk");
    ok(keys.status === 404 || keys.status === 400, "path tricks still get nothing");
  }

  console.log("\nthe 402, and the order it issues");
  let order = "", memo = "";
  {
    const a = await get("/donate", HOST, "POST", {});
    ok(a.status === 402, `POST /donate answers 402 (${a.status})`);
    order = a.json?.order; memo = a.json?.memo;
    ok(/^ord_[0-9a-f]{12}$/.test(order ?? "") && memo === order, `an unguessable order id doubles as the memo (${order})`);
    ok(a.json?.payTo === PAYEE && a.json?.maxAmountRequired === "3", "the terms name the payee and the price");
    ok(a.json?.token?.code === "XLM" && a.json?.token?.issuer === null,
      "XLM terms carry NO issuer — a token named XLM would be a different asset");
    ok(!!hdr(a.headers, "x-payment"), "the x-payment header is present for x402 clients");
    const b = await get("/donate", HOST, "POST", {});
    ok(b.json?.order !== order, "a second ask is a second order, with its own memo");
  }

  console.log("\npolling must not mint orders");
  {
    const before = svc.book.size;
    const p1 = await get(`/donate?order=${order}`);
    const p2 = await get(`/donate?order=${order}`);
    ok(p1.status === 202 && p2.status === 202, `polling answers 202 (${p1.status}/${p2.status})`);
    ok(p1.json?.paid === false, "and says paid:false honestly");
    ok(p1.json?.order === order, "the same order id every time — no new order per poll");
    ok(svc.book.size === before, `the book did not grow (${before} -> ${svc.book.size})`);
    const ghost = await get(`/donate?order=ord_nope`);
    ok(ghost.status === 404, "an unknown order is a 404, not a fresh 402");
  }

  console.log("\nthe ledger decides, not the buyer");
  const HASH = "05b2e5b31e15a2a0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0babe";
  {
    const fake = await get(`/donate?order=${order}&tx=${"f".repeat(64)}`);
    ok(fake.status === 202 && fake.json?.error === "not_paid_yet",
      `an invented hash serves nothing (${fake.status})`);

    // Each case below is one forgery, run against its own stub ledger.
    const refuse = async (label: string, over: any, port: number) => {
      const rec: any = { hash: HASH, amount: "3", memo: "", from: BUYER, ...over };
      const svc = startDonate({ port, hostname: HOST, payee: PAYEE, network: "testnet", price: "3", asset: { code: "XLM" }, vault: BUYER, fetchJson: stubLedger(rec) });
      await svc.listen(port);
      const o = (await askFor(port)).json;
      if (over.memo === undefined) rec.memo = o.memo;   // a forged memo stays forged
      const r = (await raw(port, `/donate?order=${o.order}&tx=${HASH}`)).json;
      ok(r.error === "not_paid_yet" && new RegExp(label).test(r.reason ?? ""), `${r.reason ?? "NOT REFUSED — the forgery was accepted"}`);
      svc.server.close();
    };
    await refuse("underpaid", { amount: "2.9" }, port + 1);
    await refuse("does not name this order", { memo: "ord_someone_elses" }, port + 2);
    await refuse("native", {
      asset: { asset_type: "credit_alphanum4", asset_code: "XLM", asset_issuer: "GD2ECUS746FADZJP7UXRBYAGH4K2SDFKUWBZXEBPQDCC44OJGE4R3DIE" },
    }, port + 3);
    // pays someone else: the ledger says the money went elsewhere
    {
      const rec: any = { hash: HASH, amount: "3", memo: "", from: BUYER };
      const svc = startDonate({ port: port + 4, hostname: HOST, payee: PAYEE, network: "testnet", price: "3", asset: { code: "XLM" }, vault: BUYER, fetchJson: async (url: string) => {
        if (url.includes("/operations")) return { status: 200, body: { _embedded: { records: [{ hash: HASH, type: "payment", from: BUYER, to: "GOTHERACCOUNTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: "3", asset_type: "native" }] } } };
        if (url.includes("/transactions/")) return { status: 200, body: { hash: HASH, successful: true, ledger: 1, created_at: new Date().toISOString(), memo_type: "text", memo: rec.memo } };
        return { status: 404, body: null };
      } });
      await svc.listen(port + 4);
      const o = (await askFor(port + 4)).json; rec.memo = o.memo;
      const r = (await raw(port + 4, `/donate?order=${o.order}&tx=${HASH}`)).json;
      ok(r.error === "not_paid_yet" && /pay this account/.test(r.reason ?? ""), `${r.reason}`);
      svc.server.close();
    }
  }

  console.log("\nthe happy path, and one payment = one order");
  {
    // The stub reads a mutable record so the memo can be filled in after the
    // order is issued — the same order of events a real buyer follows.
    const rec = { hash: HASH, amount: "3", memo: "", from: BUYER };
    const g = startDonate({ port: port + 5, hostname: HOST, payee: PAYEE, network: "testnet", price: "3", asset: { code: "XLM" }, vault: BUYER, fetchJson: stubLedger(rec as any) });
    await g.listen(port + 5);
    const ask = (await raw(port + 5, "/donate", { method: "POST", body: {} })).json;
    rec.memo = ask.memo;
    const r = (await raw(port + 5, `/donate?order=${ask.order}&tx=${HASH}`)).json;
    ok(!!r.data, `the paid order is served (${r.data ? "200" : r.error + ": " + r.reason})`);
    ok(r.proof?.tx === HASH && r.proof?.ledger === 5526645, "the receipt carries the ledger proof");
    ok(/curl/.test(r.proof?.verify ?? ""), "and a command to verify it yourself without trusting us");
    ok(!!r.receipt, "a human-readable receipt comes back");

    // A failed transaction has a real hash and moved nothing.
    const gf = startDonate({ port: port + 6, hostname: HOST, payee: PAYEE, network: "testnet", price: "3", asset: { code: "XLM" }, vault: BUYER, fetchJson: stubLedger({ ...rec, fail: true }) });
    await gf.listen(port + 6);
    const askF = (await raw(port + 6, "/donate", { method: "POST", body: {} })).json;
    const fr = (await raw(port + 6, `/donate?order=${askF.order}&tx=${HASH}`)).json;
    ok(fr.error === "not_paid_yet" && /failed/.test(fr.reason ?? ""), `a failed tx serves nothing: ${fr.reason}`);

    // Same payment, a second order that happens to ask for the same amount.
    const ask2 = (await raw(port + 5, "/donate", { method: "POST", body: {} })).json;
    const again = (await raw(port + 5, `/donate?order=${ask2.order}&tx=${HASH}`)).json;
    ok(again.error === "payment_already_used", `the same tx cannot buy a second order (${again.error})`);
    const re = (await raw(port + 5, `/donate?order=${ask.order}`)).json;
    ok(re.paid === true && re.tx === HASH, "the original order now reports paid:true");
    const twice = (await raw(port + 5, `/donate?order=${ask.order}&tx=${HASH}`)).json;
    ok(twice.error === "order_already_paid", "and cannot be redeemed twice");
  }

  // A door priced in real Circle USDC. This is the asset-integration case:
  // Circle is the issuer, so the door holds no issuer key and can only check
  // that the payment names Circle's address. A token someone else minted and
  // *named* USDC must be refused, and so must XLM — otherwise a donor pays the
  // wrong money and the page still says thank you.
  console.log("\na door priced in real Circle USDC");
  {
    const USDC_ISSUER_MAINNET = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
    const FAKE_ISSUER = "GD2ECUS746FADZJP7UXRBYAGH4K2SDFKUWBZXEBPQDCC44OJGE4R3DIE";
    const p = port + 7;
    // A real-shaped 64-hex hash: a malformed one is rejected before the asset
    // check, so the test would "pass" for the wrong reason.
    const UHASH = "05b2e5b31e15a2a0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0e0beef";
    const circle = { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: USDC_ISSUER_MAINNET };
    const want = { payee: PAYEE, amount: "1", asset: { code: "USDC", issuer: USDC_ISSUER_MAINNET }, network: "public" as const };

    // The memo is minted by the server, so the stub ledger has to echo the one
    // this order actually got — same trick the forgery cases above use.
    const rec: any = { hash: UHASH, amount: "1", memo: "", from: BUYER, asset: circle };
    const svcU = startDonate({
      port: p, hostname: HOST, payee: PAYEE, network: "public", price: "1",
      asset: { code: "USDC", issuer: USDC_ISSUER_MAINNET }, vault: SELLER_VAULT,
      fetchJson: stubLedger(rec),
    });
    await svcU.listen(p);
    const askU = (await raw(p, "/donate", { method: "POST", body: {} })).json;
    rec.memo = askU.memo;
    ok(askU.token?.code === "USDC" && askU.token?.issuer === USDC_ISSUER_MAINNET,
      "the 402 terms name Circle as the issuer, not a lookalike");
    ok(askU.network === "stellar:public", `and the mainnet network: ${askU.network}`);
    const gotU = (await raw(p, `/donate?order=${askU.order}&tx=${UHASH}`));
    // A served USDC payment comes back as 200 with data + a ledger proof, not a
    // `paid` flag — that flag belongs to the polling path. Asserting the wrong
    // shape here would read as a broken door when the door actually took money.
    ok(gotU.status === 200 && !!gotU.json?.data && gotU.json?.proof?.amount === "1",
      `a real-USDC payment is served with proof: ${gotU.status} ${gotU.json?.error ?? gotU.json?.proof?.tx?.slice(0, 12)}`);
    const pageU = (await raw(p, "/")).text;
    ok(/USDC/.test(pageU) && !/>\s*1 XLM\s*</.test(pageU), "the page prices in USDC, not XLM");
    svcU.server.close();

    // XLM sent to a USDC-priced door: the ledger says native, the order says Circle.
    const vX = await verifyIncomingPayment(UHASH, { ...want, memo: rec.memo, from: BUYER },
      stubLedger({ ...rec, asset: { asset_type: "native" } }));
    ok(vX.ok === false && /native XLM|priced asset|token/.test((vX as any).reason ?? ""),
      `XLM to a USDC door is refused: ${(vX as any).reason}`);

    // Same code, wrong issuer. Anyone can list a token called USDC.
    const vF = await verifyIncomingPayment(UHASH, { ...want, memo: rec.memo, from: BUYER },
      stubLedger({ ...rec, asset: { ...circle, asset_issuer: FAKE_ISSUER } }));
    ok(vF.ok === false && /priced asset/.test((vF as any).reason ?? ""),
      `a token named USDC from the wrong issuer is refused: ${(vF as any).reason}`);

    // And the same payment is accepted when the issuer IS Circle — otherwise the
    // two refusals above prove nothing.
    const vOK = await verifyIncomingPayment(UHASH, { ...want, memo: rec.memo, from: BUYER },
      stubLedger(rec));
    ok(vOK.ok === true, `the identical payment is accepted when the issuer is Circle: ${(vOK as any).reason ?? "accepted"}`);
  }

  console.log("\nthe real verifier agrees with these stubs");
  {
    const v = await verifyIncomingPayment(HASH, {
      payee: PAYEE, amount: "3", asset: { code: "XLM" }, memo, from: BUYER, network: "testnet",
    }, stubLedger({ hash: HASH, amount: "3", memo, from: BUYER }));
    ok(v.ok === true, "verifyIncomingPayment accepts the same shape the server accepted");
    const v2 = await verifyIncomingPayment(HASH, {
      payee: PAYEE, amount: "3", asset: { code: "XLM" }, memo: "other", from: BUYER, network: "testnet",
    }, stubLedger({ hash: HASH, amount: "3", memo, from: BUYER }));
    ok(v2.ok === false, `and rejects a different memo (${(v2 as any).reason})`);
  }

  for (const s of [svc, ...( [] as any[])]) s.server.close();
  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log("crashed:", why(e)); process.exit(1); });
