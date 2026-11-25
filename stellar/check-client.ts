// The client half of check.paydlux.com: ask, (optionally) pay, poll, report.
// Pure-ish functions with every side effect injectable (fetch, pay) so the
// whole flow is testable without money — stellar/check-client-check.ts.
export const CHECK_API = "https://check.paydlux.com";

export type CheckTerms = { order: string; memo: string; maxAmountRequired: string; payTo: string; network: string; token: { code: string; issuer: string | null } };
export type CheckOpts = { api?: string; fetchFn?: typeof fetch };

type Ask = { ok: true; terms: CheckTerms } | { ok: false; error: string };

/** Free step: ask the check API what a check on this URL would cost. No money, no data leaves except the URL itself. */
export async function checkAsk(url: string, opts: CheckOpts = {}): Promise<Ask> {
  const f = opts.fetchFn ?? fetch;
  let res: Response;
  try {
    res = await f((opts.api ?? CHECK_API) + "/check", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }),
    });
  } catch { return { ok: false, error: "cannot reach check.paydlux.com" }; }
  if (res.status !== 402) return { ok: false, error: "unexpected answer " + res.status };
  const j: any = await res.json().catch(() => null);
  if (!j?.order || !j?.memo) return { ok: false, error: "402 without an order we can pay" };
  return { ok: true, terms: j as CheckTerms };
}

export type BuyResult =
  | { ok: true; report: any; receipt: string; proof: any; tx: string }
  | { ok: false; reason: string; tx?: string };

/** Full buy: pay the order's terms exactly once, then poll until the ledger verifies the payment. */
export async function checkBuy(url: string, pay: (t: CheckTerms) => Promise<string>, opts: CheckOpts & { pollMs?: number; timeoutMs?: number; terms?: CheckTerms } = {}): Promise<BuyResult> {
  let t = opts.terms;
  if (!t) {
    const ask = await checkAsk(url, opts);
    if (!ask.ok) return { ok: false, reason: ask.error };
    t = ask.terms;
  }
  let tx: string;
  try { tx = await pay(t); } catch (e) { return { ok: false, reason: "payment failed: " + String(e) }; }
  const f = opts.fetchFn ?? fetch;
  const deadline = Date.now() + (opts.timeoutMs ?? 90_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 4000));
    let j: any;
    try { j = await (await f(`${opts.api ?? CHECK_API}/check?order=${t.order}&tx=${tx}`)).json(); }
    catch { continue; }
    if (j?.data) return { ok: true, report: j.data, receipt: j.receipt, proof: j.proof, tx };
    if (j?.error && j.error !== "not_paid_yet") return { ok: false, reason: j.error + (j.tx ? " (tx " + j.tx + ")" : ""), tx };
  }
  return { ok: false, reason: "payment sent but no report within the timeout — poll later: " +
    `${opts.api ?? CHECK_API}/check?order=${t.order}&tx=${tx}`, tx };
}

/** One honest line a human or an agent can act on. */
export function verdictLine(r: BuyResult): string {
  if (!r.ok) return "check failed: " + r.reason;
  const rep = r.report.report;
  if (rep.verdict === "PAYABLE") return `PAYABLE — pays ${rep.terms.token?.code ?? rep.terms.assetCode} to ${String(rep.terms.payTo).slice(0, 8)}… (${r.receipt})`;
  return rep.verdict + " — " + (rep.reason ?? "see report") + ` (${r.receipt})`;
}
