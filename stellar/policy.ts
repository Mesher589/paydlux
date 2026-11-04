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
/**
 * A named bucket of spending with its own ceilings.
 *
 * This is the "transaction categories" idea: the same mandate, sliced by what
 * the money is for. A vault can say "data APIs cost me $5 a day, my coding
 * assistant costs $50 a month" without two vaults or two mandates.
 *
 * A category can only TIGHTEN the base mandate. It has no floor of its own:
 * a category ceiling above the base ceiling is a number that can never bind,
 * because the base ceiling already refused the payment. That asymmetry is the
 * security property — adding a category can never widen what the agent may
 * spend, only narrow it.
 */
export type CategoryRule = {
  /** ceiling on any single payment in this category */
  maxPerPayment?: number;
  /** total across a calendar day for this category */
  dailyBudget?: number;
};

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
  /** named spend buckets, keyed by category name */
  categories?: Record<string, CategoryRule>;
  /** which category a seller's account falls into */
  payeeCategory?: Record<string, string>;
};

export const DEFAULT_POLICY: Policy = {
  maxPerPayment: 50,
  dailyBudget: 200,
  allowlist: [],
  denylist: [],
  maxMandateTtl: 3600,
  maxLiveMandates: 1,
  categories: {},
  payeeCategory: {},
};

/** A category name is rendered into HTML and stored in a config file, so it is
 *  reduced to a safe alphabet here rather than escaped at every use site. */
export function normalizeCategory(name: unknown): string {
  return String(name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 32);
}

export type SpendEvent = {
  at: number;
  amount: number;
  payee: string;
  uri?: string;
  mandateHash?: string;
  /** the bucket this spend counts against, when the payee is categorised */
  category?: string;
};

export type Verdict = { ok: true } | { ok: false; rule: string; detail: string };

export class PolicyEngine {
  private events: SpendEvent[] = [];
  policy: Policy;

  constructor(policy: Partial<Policy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  record(e: SpendEvent) {
    if (!e.category) {
      const named = this.categoryOf(e.payee);
      if (named) e = { ...e, category: named };
    }
    this.events.push(e);
  }

  /** Which bucket a seller's account belongs to, or undefined if uncategorised. */
  categoryOf(payee: string): string | undefined {
    const named = this.policy.payeeCategory?.[payee];
    return named ? normalizeCategory(named) : undefined;
  }

  /**
   * Replace the policy from an untrusted source (the rules editor, a config
   * file). Names are normalised and numbers validated here, so a bad value
   * cannot smuggle markup or a negative ceiling into the engine.
   *
   * The owner may widen the counters this file keeps — the daily total and the
   * allowlist are ours to count. What this cannot touch is the per-payment
   * ceiling baked into the mandate's transaction hash: raise it here and the
   * ledger still refuses above the mandate amount. `effectiveMaxPerPayment()`
   * reports the number that actually binds so the UI can say so honestly.
   */
  update(next: Partial<Policy>) {
    const merged: Policy = { ...this.policy, ...next };
    // A garbage or blank number falls back to the rule that was in force a
    // moment ago, NOT to DEFAULT_POLICY. Falling back to the default would make
    // a malformed edit silently LOOSEN the mandate — an empty maxPerPayment on
    // a form would turn a 2 into the default 50. Keeping the previous value
    // means a bad field is a no-op, which is the only safe reading of a form
    // that gates money.
    merged.maxPerPayment = positive(merged.maxPerPayment, this.policy.maxPerPayment);
    merged.dailyBudget = positive(merged.dailyBudget, this.policy.dailyBudget);
    merged.maxMandateTtl = positive(merged.maxMandateTtl, this.policy.maxMandateTtl);
    merged.maxLiveMandates = 1; // Stellar sequence binding: see Policy.maxLiveMandates
    merged.allowlist = (merged.allowlist ?? []).filter(isAccount);
    merged.denylist = (merged.denylist ?? []).filter(isAccount);
    const cats: Record<string, CategoryRule> = {};
    for (const [name, rule] of Object.entries(merged.categories ?? {})) {
      const key = normalizeCategory(name);
      if (!key) continue;
      cats[key] = {
        maxPerPayment: rule?.maxPerPayment === undefined ? undefined : positive(rule.maxPerPayment, merged.maxPerPayment),
        dailyBudget: rule?.dailyBudget === undefined ? undefined : positive(rule.dailyBudget, merged.dailyBudget),
      };
    }
    merged.categories = cats;
    const map: Record<string, string> = {};
    for (const [payee, name] of Object.entries(merged.payeeCategory ?? {})) {
      if (!isAccount(payee)) continue;
      const key = normalizeCategory(name);
      if (key && cats[key]) map[payee] = key;
    }
    merged.payeeCategory = map;
    this.policy = merged;
    return this.policy;
  }

  /**
   * Seed the day's total from the ledger instead of from this process's memory.
   *
   * `events` starts empty, so a fresh seller process believes it has spent
   * nothing today. The mandate printed in the banner ("20 per day") then only
   * holds until the next restart. Seeding from the ledger makes the budget a
   * property of the vault, not of the uptime of whichever machine ran `sell`.
   */
  seedFromLedger(amount: number, category?: string) {
    if (!(amount > 0)) return;
    // One synthetic event at the start of the day: it counts toward the total
    // without pretending to be a payment this process can re-enact.
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    this.record({ at: start.getTime(), amount, payee: "ledger", category });
  }

  /** Everything spent in the current UTC day. */
  spentToday(): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const t = start.getTime();
    return this.events.filter((e) => e.at >= t).reduce((a, b) => a + b.amount, 0);
  }

  /** Everything spent in one category in the current UTC day. */
  spentInCategory(category: string): number {
    const start = new Date(); start.setUTCHours(0, 0, 0, 0);
    const t = start.getTime();
    return this.events
      .filter((e) => e.at >= t && e.category === category)
      .reduce((a, b) => a + b.amount, 0);
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
    /**
     * Same, per category. A category budget that ignores the queue has the same
     * hole the daily budget had: the human approves five payments, the fifth
     * fails, and the approval gesture was wasted.
     */
    committedInCategory?: number;
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
    // Category ceilings, checked last so a refusal names the narrowest rule it
    // actually broke. A category can only tighten the base mandate: the base
    // ceilings above already ran, so a category limit above them is inert.
    const category = this.categoryOf(req.payee);
    if (category) {
      const rule = p.categories?.[category];
      if (rule?.maxPerPayment !== undefined && req.amount > rule.maxPerPayment) {
        return no("category_max_per_payment",
          `${req.amount} exceeds the ${category} per-payment ceiling of ${rule.maxPerPayment}`);
      }
      if (rule?.dailyBudget !== undefined) {
        const inCat = this.spentInCategory(category) + (req.committedInCategory ?? 0);
        if (inCat + req.amount > rule.dailyBudget) {
          return no("category_daily_budget",
            `${req.amount} would take the ${category} budget to ${(inCat + req.amount).toFixed(2)}, over its ${rule.dailyBudget} limit (${this.spentInCategory(category).toFixed(2)} paid${req.committedInCategory ? ` + ${req.committedInCategory.toFixed(2)} already approved and waiting` : ""})`);
        }
      }
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

/** A Stellar account id, and nothing else. */
const isAccount = (s: unknown) => /^G[A-Z2-7]{55}$/.test(String(s ?? ""));

/** Coerce to a usable positive number, falling back to the default. */
function positive(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
