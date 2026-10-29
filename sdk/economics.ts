// Unit economics for the AgentVault payment gateway.
// Gas figures are MEASURED from `forge --gas-report` on the via-IR build.
// Gas price and ETH price are fetched live from Base mainnet + CoinGecko.
const U = 1_000_000n; // 1.00 USDC in token units

// ---- measured gas (forge --gas-report) --------------------------------------
const GAS = {
  settle_repeat_payee: 91_000,
  settle_new_payee: 143_000,
  settle_escrow: 160_000,
  charge_stream: 31_419, // session sub-charge
  open_session: 152_459,
  publish_batch: 111_077,
  claim_batch: 32_079, // per leaf
  register_mandate: 153_644,
  deposit: 113_732,
} as const;

type Costs = { gasWei: bigint; ethUsd: number };

const usdCost = (gasUnits: number, c: Costs) => (gasUnits * Number(c.gasWei) * c.ethUsd) / 1e18;

async function liveCosts(): Promise<Costs> {
  const j = async (url: string, body?: object) =>
    (await (await fetch(url, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined })).json()) as any;
  const [gp, px] = await Promise.all([
    j("https://mainnet.base.org", { jsonrpc: "2.0", id: 1, method: "eth_gasPrice", params: [] }),
    j("https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd"),
  ]);
  return { gasWei: BigInt(gp.result ?? "0x1"), ethUsd: px.ethereum.usd };
}

const f = (n: number, d = 4) => n.toFixed(d);
const pc = (n: number) => (n * 100).toFixed(1) + "%";
const money = (n: number) => "$" + Math.round(n).toLocaleString();

async function main() {
  const c = await liveCosts();
  console.log(`live inputs: Base gas ${f(Number(c.gasWei) / 1e9, 4)} gwei, ETH $${c.ethUsd}\n`);

  console.log("=== on-chain cost per action (Base, live gas) ===");
  for (const [name, g] of [
    ["settle (repeat payee)", GAS.settle_repeat_payee],
    ["settle (new payee)", GAS.settle_new_payee],
    ["settle into escrow", GAS.settle_escrow],
    ["session sub-charge", GAS.charge_stream],
    ["open session", GAS.open_session],
    ["register mandate", GAS.register_mandate],
    ["deposit", GAS.deposit],
  ] as const) {
    console.log(`  ${name.padEnd(22)} ${String(g).padStart(7)} gas  $${f(usdCost(g, c), 5)}`);
  }

  const batchPer = (n: number) => usdCost((GAS.publish_batch + n * GAS.claim_batch) / n, c);
  console.log("\n=== batch settlement amortisation ===");
  for (const n of [10, 100, 1000, 10_000]) {
    console.log(`  ${String(n).padStart(6)} leaves/tx -> $${f(batchPer(n), 5)}/payment  (${f(usdCost(GAS.settle_repeat_payee, c) / batchPer(n), 1)}x cheaper than direct)`);
  }

  // ---- the two segments that actually exist ---------------------------------
  // Coinbase-reported x402 average call value is ~$0.30 (micro agent calls).
  // Commercial API/data/compute purchases run $5-$500 per call.
  const gasDirect = usdCost(GAS.settle_repeat_payee, c);
  const gasBatch = batchPer(1000);

  console.log("\n=== gross margin per payment, by segment and take rate ===");
  const segments: [string, number][] = [["micro agent call", 0.3], ["API/data call", 5], ["compute/marketplace call", 75], ["enterprise procurement", 400]];
  const rates = [0.001, 0.005, 0.01, 0.02];
  console.log("  segment                       avg    " + rates.map((r) => pc(r).padStart(9)).join(""));
  for (const [name, avg] of segments) {
    const cells = rates.map((r) => {
      const m = avg * r - gasBatch;
      return (m >= 0 ? "$" + f(m, 4) : "LOSS").padStart(9);
    });
    console.log(`  ${name.padEnd(27)} $${String(avg).padStart(5)}  ` + cells.join(""));
  }
  console.log(`  (cost basis: batched settlement $${f(gasBatch, 5)}/payment; direct settle $${f(gasDirect, 5)})`);

  // ---- why per-tx take alone fails ------------------------------------------
  console.log("\n=== why settlement fees alone cannot fund a company ===");
  const industryAnnualVolume = 600_000_000; // ~$600M annualised x402 volume (Coinbase-reported)
  for (const r of [0.001, 0.005, 0.01]) {
    console.log(`  whole-industry x402 volume $${(industryAnnualVolume / 1e6).toFixed(0)}M/yr at ${pc(r)} take = ${money(industryAnnualVolume * r)}/yr for EVERY player combined`);
  }
  console.log("  => settlement is a commodity rail. margin must come from policy/compliance/escrow.");

  // ---- the defensible model: SaaS + bps + float ------------------------------
  console.log("\n=== revenue model: platform subscription + bps + float ===");
  const plans: [string, number, string][] = [
    ["Developer", 0, "free tier, 10k tx/mo, community support"],
    ["Team", 249, "mandate policies, escrow, 500k tx/mo included"],
    ["Business", 1490, "payee allowlists, audit export, 5M tx/mo"],
    ["Enterprise", 9900, "MiCA/AI-Act evidence pack, custom policy, SLA"],
  ];
  for (const [name, price, why] of plans) console.log(`  ${name.padEnd(11)} $${String(price).padStart(5)}/mo  ${why}`);

  console.log("\n=== monthly P&L scenarios (batched settlement) ===");
  const infra = 250;
  const scen = [
    { name: "seed", accounts: { Team: 20, Business: 2 }, tx: 1_000_000, avg: 2, bps: 0.005, staff: 0 },
    { name: "growth", accounts: { Team: 180, Business: 40, Enterprise: 4 }, tx: 12_000_000, avg: 6, bps: 0.006, staff: 40_000 },
    { name: "scale", accounts: { Team: 900, Business: 260, Enterprise: 40 }, tx: 90_000_000, avg: 12, bps: 0.007, staff: 220_000 },
  ];
  const priceOf = { Developer: 0, Team: 249, Business: 1490, Enterprise: 9900 } as Record<string, number>;
  console.log("  scenario   subs      bps rev    total rev    gas+infra   staff     profit     net margin");
  for (const s of scen) {
    const subRev = Object.entries(s.accounts).reduce((a, [k, n]) => a + n * priceOf[k], 0);
    const bpsRev = s.tx * s.avg * s.bps;
    const rev = subRev + bpsRev;
    const varCost = s.tx * gasBatch + infra;
    const profit = rev - varCost - s.staff;
    console.log(
      `  ${s.name.padEnd(8)} ${money(subRev).padStart(8)}  ${money(bpsRev).padStart(9)}  ${money(rev).padStart(10)}  ${money(varCost).padStart(9)}  ${money(s.staff).padStart(8)}  ${money(profit).padStart(9)}   ${pc(profit / rev)}`,
    );
  }

  // ---- float: the margin nobody prices --------------------------------------
  console.log("\n=== settlement float (USDC held between capture and payout) ===");
  for (const [label, held] of [
    ["seed: 1 day of $2 avg x 1M tx", 1 * 1_000_000 * 2],
    ["growth: 3 days of $6 avg x 12M tx", 3 * 12_000_000 * 6],
    ["scale: 3 days of $12 avg x 90M tx", 3 * 90_000_000 * 12],
  ] as const) {
    const apr = 0.04;
    console.log(`  ${label.padEnd(34)} float ${money(held).padStart(11)} -> ${money((held * apr) / 12)}/mo at ${pc(apr)} APR`);
  }

  // ---- break-even ------------------------------------------------------------
  console.log("\n=== break-even ===");
  const seedSubRev = 20 * 249 + 2 * 1490;
  console.log(`  subscriptions at seed: ${money(seedSubRev)}/mo vs fixed+gas ${money(1_000_000 * gasBatch + infra)}/mo -> ${seedSubRev > 1_000_000 * gasBatch + infra ? "profitable before headcount" : "not yet"}`);
  const need = (infra + 40_000) / (2 * 0.006 + (249 * 12) / 1_000_000);
  console.log(`  payments/mo to cover $40k staff at $2 avg + 0.6% bps: ~${Math.ceil(need / 1000) * 1000}`);
}

main().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
