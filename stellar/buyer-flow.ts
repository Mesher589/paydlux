// End-to-end buyer flow against a RUNNING `paydlux sell`.
// Proves the three things that were broken:
//   1. a retry does not park a second payment
//   2. /pay/status does not leak unpaid content
//   3. after a human approves, the buyer's retry gets the content
//
// Run:  npx tsx stellar/buyer-flow.ts <agentSeed> [gatewayUrl]
import { PaydluxAgent } from "./agent.ts";

const seed = process.argv[2];
const base = process.argv[3] ?? "http://127.0.0.1:4021";
if (!seed) { console.error("usage: npx tsx stellar/buyer-flow.ts <agentSeed> [gatewayUrl]"); process.exit(1); }

const agent = new (PaydluxAgent as any)({
  agentKey: seed, network: "testnet", approvalTimeoutMs: 180000, pollMs: 2000,
});
const url = `${base}/api/data`;

let fails = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? "  ok  " : " FAIL "} ${msg}`); if (!ok) fails++; };

const a = await agent.get(url);
console.log(`\n1. first ask        ${a.status} ${a.reason ?? ""} handle=${a.handle}`);
check(a.status === 202 && !!a.handle, "first ask parks a payment");

const b = await agent.get(url);
console.log(`2. retry while pending  ${b.status} handle=${b.handle}`);
check(b.handle === a.handle, "retry reuses the same handle (no duplicate payment parked)");

// The leak test: the buyer-facing status route must not carry the payload.
const st = await fetch(`${base}/pay/status?handle=${a.handle}`).then((r) => r.json());
console.log(`3. status route     ${JSON.stringify(st)}`);
check(st.content === undefined, "status route does NOT leak the unpaid content");

console.log(`4. waiting for a human to approve ${a.handle} …`);
const rec = await agent.waitForApproval(a);
console.log(`   human decided: ${rec?.status} ${rec?.tx ?? rec?.reason ?? ""}`);
check(rec?.status === "settled", "approval settles the payment");

const paid = await agent.get(url);
console.log(`5. retry after approval  ${paid.status} ${JSON.stringify(paid.data ?? paid.reason).slice(0, 80)}`);
// The seller's payload arrives as the string it was written as; parse it rather
// than assuming the gateway reshaped it.
const served = typeof paid.data === "string" ? JSON.parse(paid.data) : paid.data;
check(paid.status === 200 && served?.served === "/api/data", "buyer receives the content they paid for");
check(!!paid.tx, "buyer gets the tx hash as proof of delivery");

const again = await agent.get(url);
check(again.status === 200, "repeat calls stay free (already paid)");

console.log(fails ? `\n${fails} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(fails ? 1 : 0);
