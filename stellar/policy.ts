// Spending policy — what the ledger cannot enforce by itself.
//
// Split honestly:
//
//   ENFORCED BY STELLAR   max per payment, which seller gets paid, which token,
//                         when the payment may run, one-shot execution.
//                         These are baked into the mandate's transaction hash.
//                         Change any of them and the signature stops working.
//
//   ENFORCED BY THIS FILE how many payments per day, the running daily total,
//                         and which sellers may be paid at all. The vault is
//                         one payment at a time; counting them is our job.
//
// If a rule is violated we refuse to create the mandate, so nothing ever
// reaches the ledger. Declined, not warned.
export type Policy = {
  /** hard ceiling on any single payment */
  maxPerPayment: number;
  /** total across a calendar day */
  dailyBudget: number;
  /** sellers that may be paid; empty = any */
  allowlist?: string[];
  /** sellers that may never be paid, even if allowlisted */
  denylist?: string[];
  /** longest a mandate may stay live, seconds */
  maxMandateTtl: number;
  /**
   * Mandates live at once. Stellar binds a pre-auth transaction to a sequence
   * number, so only the newest can ever run — keep this at 1 and the state
   * matches what the ledger will actually honour.
   */
  maxLiveMandates: number;
};

export const DEFAULT_POLICY: Policy = {
  maxPerPayment: 50,
  dailyBudget: 200,
  allowlist: [],
  denylist: [],
  maxMandateTtl: 3600,
  maxLiveMandates: 1,
};

export type SpendEvent = {
  at: number;
  amount: number;
  payee: string;
  uri?: string;
  mandateHash?: string;
};

export type Verdict = { ok: true } | { ok: false; rule: string; detail: string };

export class PolicyEngine {
  private events: SpendEvent[] = [];
  policy: Policy;

  constructor(policy: Partial<Policy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  record(e: SpendEvent) { this.events.push(e); }

  /**
   * Seed the day's total from the ledger instead of from this process's memory.
   *
   * `events` starts empty, so a fresh seller process believes it has spent
   * nothing today. The mandate printed in the banner ("20 per day") then only
   * holds until the next restart. Seeding from the ledger makes the budget a
   * property of the vault, not of the uptime of whichever machine ran `sell`.
   */
  seedFromLedger(amount: number) {
    if (!(amount > 0)) return;
    // One synthetic event at the start of the day: it counts toward the total
    // without pretending to be a payment this process can re-enact.
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    this.record({ at: start.getTime(), amount, payee: "ledger" });
  }

  /** Everything spent in the current UTC day. */
  spentToday(): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const t = start.getTime();
    return this.events.filter((e) => e.at >= t).reduce((a, b) => a + b.amount, 0);
  }

  today(): SpendEvent[] {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    return this.events.filter((e) => e.at >= start.getTime());
  }

  /**
   * Check a request BEFORE any transaction is built. Returns the reason a
   * payment is refused; the caller must not proceed on ok:false.
   */
  check(req: {
    amount: number; payee: string; ttl?: number; liveMandates?: number;
    /**
     * Money not spent yet but already promised: payments a human has approved
     * and is waiting on a signature for. Without this the ceiling only counts
     * settled payments, so a seller with a 20/day budget can approve six 4.50
     * requests, spend six Face ID scans, and watch two of them fail at
     * submission. Counting the queue refuses the fifth one at the button
     * instead, which is the point of having a human in the loop.
     */
    committed?: number;
  }): Verdict {
    const p = this.policy;
    if (!(req.amount > 0)) return no("amount", "amount must be greater than zero");
    if (req.amount > p.maxPerPayment) {
      return no("max_per_payment", `${req.amount} exceeds the per-payment ceiling of ${p.maxPerPayment}`);
    }
    const spent = this.spentToday() + (req.committed ?? 0);
    if (spent + req.amount > p.dailyBudget) {
      return no("daily_budget", `${req.amount} would take today to ${(spent + req.amount).toFixed(2)}, over the ${p.dailyBudget} budget (${this.spentToday().toFixed(2)} paid${req.committed ? ` + ${req.committed.toFixed(2)} already approved and waiting` : ""})`);
    }
    if (p.denylist?.includes(req.payee)) return no("denylist", `${short(req.payee)} is blocked`);
    if (p.allowlist?.length && !p.allowlist.includes(req.payee)) {
      return no("allowlist", `${short(req.payee)} is not on the approved seller list`);
    }
    if (req.ttl !== undefined && req.ttl > p.maxMandateTtl) {
      return no("max_ttl", `mandate would live ${req.ttl}s, longer than the ${p.maxMandateTtl}s limit`);
    }
    if (req.liveMandates !== undefined && req.liveMandates >= p.maxLiveMandates) {
      return no("max_live", `${req.liveMandates} mandates already live (limit ${p.maxLiveMandates})`);
    }
    return { ok: true };
  }
}

const no = (rule: string, detail: string): Verdict => ({ ok: false, rule, detail });
const short = (k: string) => k.slice(0, 6) + "…" + k.slice(-4);
