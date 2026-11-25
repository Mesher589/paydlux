// check-client-check.ts — the client flow gate. A stub server plays the check
// API; a sentinel pay fn must run exactly once. No money. npx tsx stellar/check-client-check.ts
import { checkAsk, checkBuy, verdictLine } from "./check-client.js";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, d = "") => { if (c) { pass++; console.log("  ok  " + name); } else { fail++; console.log("  FAIL " + name + (d ? " — " + d : "")); } };

const TERMS = { order: "ord_aaa", memo: "ord_aaa", maxAmountRequired: "0.08", payTo: "GV", network: "stellar:public", token: { code: "XLM", issuer: null } };

function stubScript(script: Array<(req: { url: string; init?: any }) => any>) {
  const seen: string[] = [];
  let i = 0;
  const fn = async (url: string, init?: any) => {
    seen.push((init?.method ?? "GET") + " " + url);
    const step = script[Math.min(i, script.length - 1)]; i++;
    const body = step({ url, init });
    return { status: body?.status ?? 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
  };
  return { fn: fn as unknown as typeof fetch, seen };
}

const main = async () => {
  { // ask only
    const s = stubScript([() => ({ status: 402, ...TERMS })]);
    const a = await checkAsk("https://x.example/api", { fetchFn: s.fn });
    ok(a.ok && a.terms.memo === "ord_aaa", "ask returns the payable order + memo");
  }
  { // ask on a dead API
    const dead = (async () => { throw new Error("down"); }) as unknown as typeof fetch;
    const a = await checkAsk("https://x.example", { fetchFn: dead });
    ok(!a.ok && a.error.includes("cannot reach"), "unreachable API → honest error, no crash");
  }
  { // ask answered 200 (API changed) → refuse to guess
    const s = stubScript([() => ({ hello: 1 })]);
    const a = await checkAsk("https://x.example", { fetchFn: s.fn });
    ok(!a.ok && a.error.includes("unexpected answer"), "non-402 answer → refused");
  }
  { // full buy: 402 → paid → not_yet → report
    let paid = 0;
    const s = stubScript([
      () => ({ status: 402, ...TERMS }),
      () => ({ error: "not_paid_yet" }),
      () => ({ data: { checked: "https://x.example/api", report: { verdict: "PAYABLE", terms: TERMS } }, receipt: "chk_1", proof: { tx: "t".repeat(64) } }),
    ]);
    const r = await checkBuy("https://x.example/api", async () => { paid++; return "t".repeat(64); },
      { fetchFn: s.fn, pollMs: 10, timeoutMs: 5000 });
    ok(r.ok && paid === 1, "pay called exactly once", "paid=" + paid);
    ok(r.ok && r.receipt === "chk_1" && verdictLine(r).startsWith("PAYABLE"), "report + receipt + verdict line");
    ok(s.seen.filter((x) => x.startsWith("GET")).every((x) => x.includes("order=ord_aaa&tx=") ), "poll always names OUR order and tx");
  }
  { // 409 (double-spend of our own tx) surfaces, does not loop
    const s = stubScript([() => ({ status: 402, ...TERMS }), () => ({ error: "payment_already_used" })]);
    const r = await checkBuy("https://x.example", async () => "ff".repeat(32), { fetchFn: s.fn, pollMs: 5, timeoutMs: 2000 });
    ok(!r.ok && r.reason === "payment_already_used", "terminal error stops polling, reason surfaces");
  }
  { // payment throws → no poll, honest reason
    const s = stubScript([() => ({ status: 402, ...TERMS })]);
    const r = await checkBuy("https://x.example", async () => { throw new Error("insufficient balance"); }, { fetchFn: s.fn, pollMs: 5, timeoutMs: 500 });
    ok(!r.ok && r.reason.includes("insufficient balance"), "failed payment reported, not swallowed");
  }
  { // known terms are reused — a second ask would mint a second order
    let paid = 0;
    const s = stubScript([
      () => ({ error: "not_paid_yet" }),
      () => ({ data: { report: { verdict: "NOT_PAYABLE", reason: "answered 200, not 402" } }, receipt: "chk_2", proof: {} }),
    ]);
    const r = await checkBuy("https://x.example", async () => { paid++; return "ab".repeat(32); },
      { fetchFn: s.fn, pollMs: 5, timeoutMs: 3000, terms: TERMS as any });
    ok(r.ok && paid === 1 && s.seen.every((x) => x.startsWith("GET")), "known terms: no second ask, no second order", s.seen.join(" | "));
    ok(verdictLine(r).startsWith("NOT_PAYABLE"), "NOT_PAYABLE verdict line honest");
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
};
main().catch((e) => { console.error("crashed:", e); process.exit(1); });
