// End-to-end demo on Stellar testnet. One command, no faucet, no config.
//
//   npx tsx stellar/demo.ts
//
// Proves, against the live testnet ledger:
//   1. a seller answers an agent's request with HTTP 402
//   2. a pre-authorised mandate pays the exact price and the body ships
//   3. a tampered envelope is refused by the ledger
//   4. an over-budget request is declined before anything is built
//   5. an approval-mode payment waits for a human, then settles on approval
import { Keypair } from "stellar-sdk";
import { StellarVault } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { PaydluxAgent } from "./agent.ts";
import { PolicyEngine } from "./policy.ts";

const GATEWAY_PORT = 4021;
const DESK_PORT = 4022;
const ok = (m: string) => console.log("  ✅", m);
const bad = (m: string) => { console.error("  ❌", m); process.exit(1); };
const step = (m: string) => console.log("\n—", m);

const main = async () => {
  console.log("Paydlux — Stellar testnet end-to-end\n");

  step("1. keys and vault");
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  await vault.trustToken(seller.publicKey(), "1000", seller);
  await vault.deposit("50", issuer);
  console.log("  vault   ", vault.address);
  console.log("  balance ", await vault.balance());

  step("2. seller starts a gateway that answers 402");
  const gw = new Gateway({
    vault, network: "testnet", payee: seller.publicKey(), deskPort: DESK_PORT,
    principal: principal.secret(), approver: approver.secret(),
    routes: [
      { uri: "/api/data", price: "2", mode: "preauth" },
      { uri: "/api/big", price: "40", mode: "approval", holdSeconds: 600 },
    ],
  });
  gw.agentKeys = [agent.publicKey()];
  await gw.listen(GATEWAY_PORT, (u) => `premium payload from ${u} at ${new Date().toISOString()}`);
  await gw.desk.listen(DESK_PORT);
  ok(`seller listening on :${GATEWAY_PORT}, approval desk on :${DESK_PORT}`);

  const buyer = new PaydluxAgent({ agentKey: agent.secret() });

  step("3. agent asks for nothing — gets a 402 with terms");
  const bare = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/api/data`);
  if (bare.status !== 402 || !bare.requirements?.maxAmountRequired) bad("expected 402 with terms");
  ok(`402: ${bare.requirements.maxAmountRequired} ${bare.requirements.token.code} to ${bare.requirements.payTo.slice(0, 8)}…`);

  step("4. human pre-authorises a mandate; agent executes it");
  const policy = new PolicyEngine({ maxPerPayment: 10, dailyBudget: 25, allowlist: [seller.publicKey()] });
  const v1 = policy.check({ amount: 2, payee: seller.publicKey(), ttl: 600 });
  if (!v1.ok) bad("policy wrongly refused a valid payment: " + v1.detail);
  const mandate = await gw.authorise("/api/data",
    { payee: seller.publicKey(), amount: "2", ttl: 600, memo: "order-1" }, principal, approver);
  policy.record({ at: Date.now(), amount: 2, payee: seller.publicKey(), uri: "/api/data", mandateHash: mandate.hash });
  const paid = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/api/data`, { mandate });
  if (!paid.ok) bad("preauth payment failed: " + paid.reason);
  ok(`content served, tx ${paid.tx?.slice(0, 16)}…`);
  ok(`seller ${await vault.balance(seller.publicKey())}, vault ${await vault.balance()}`);

  step("5. tamper with the envelope — the ledger refuses");
  const forged = await gw.authorise("/api/data",
    { payee: seller.publicKey(), amount: "2", ttl: 600 }, principal, approver);
  const tampered = { ...forged, envelope: swapAmount(forged.envelope) };
  const t = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/api/data`, { mandate: tampered as any });
  if (t.ok) bad("a tampered envelope was accepted");
  ok(`refused: ${t.reason}`);

  step("6. replay the same mandate — money moves once");
  const again = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/api/data`, { mandate });
  if (again.ok) bad("mandate replayed and paid twice");
  ok(`refused: ${again.reason}`);

  step("7. over-budget request is declined before anything is built");
  const v2 = policy.check({ amount: 40, payee: seller.publicKey(), ttl: 600 });
  if (v2.ok) bad("over-budget payment should have been declined");
  else ok(`declined [${v2.rule}]: ${v2.detail}`);

  step("8. approval mode — a human decides");
  const ask = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/api/big`);
  if (!ask.handle) bad("expected an approval handle");
  ok(`parked as ${ask.handle}, waiting for a person`);
  const pending = await fetch(`http://127.0.0.1:${DESK_PORT}/list`).then((r) => r.json());
  ok(`desk shows ${pending.length} item(s): ${pending.map((p: any) => `${p.id} ${p.price} ${p.status}`).join(", ")}`);
  const approved = await fetch(`http://127.0.0.1:${DESK_PORT}/approve/${ask.handle}`, { method: "POST" }).then((r) => r.json());
  if (approved.status !== "settled") bad("approval did not settle: " + approved.reason);
  ok(`human approved → settled on-chain, tx ${approved.tx?.slice(0, 16)}…`);
  ok(`seller ${await vault.balance(seller.publicKey())}, vault ${await vault.balance()}`);

  step("9. deny path — nothing moves");
  const before = await vault.balance(seller.publicKey());
  const ask2 = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/api/big`);
  const denied = await fetch(`http://127.0.0.1:${DESK_PORT}/deny/${ask2.handle}`, { method: "POST" }).then((r) => r.json());
  const after = await vault.balance(seller.publicKey());
  if (denied.status !== "denied" || before !== after) bad("deny path moved money");
  ok(`denied, balance unchanged at ${after}`);

  step("10. panic button");
  const rev = await vault.revokeAll(principal, approver);
  ok(`revoked ${rev?.revoked ?? 0} outstanding mandate(s)`);
  const afterRevoke = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/api/data`, { mandate: forged });
  if (afterRevoke.ok) bad("revoked mandate still worked");
  ok(`refused: ${afterRevoke.reason}`);

  step("11. the approval portal renders for a human");
  const html = await fetch(`http://127.0.0.1:${DESK_PORT}/`).then((r) => r.text());
  if (!html.includes("Paydlux") || !html.includes("Approve")) bad("portal did not render");
  ok(`portal served at http://127.0.0.1:${DESK_PORT}/ (${html.length} bytes, ${pending.length + 2} rows)`);

  console.log("\nALL CHECKS PASSED — Stellar-only flow works end to end on testnet.");
  console.log(`explorer: https://stellar.expert/explorer/testnet/account/${vault.address}`);
  if (process.argv.includes("--keep")) {
    console.log(`\nstaying up. open the approval portal: http://127.0.0.1:${DESK_PORT}/  (ctrl-c to stop)`);
    return; // leave the servers listening
  }
  process.exit(0);
};

/** Flip the payment amount inside the XDR without re-signing. */
function swapAmount(xdr: string) {
  const buf = Buffer.from(xdr, "base64");
  // an int64 amount of "2" is 20_000_000 stroops; write 9 into the low bytes
  for (let i = 0; i < buf.length - 8; i++) {
    if (buf.readUInt32BE(i) === 0 && buf.readUInt32BE(i + 4) === 20_000_000) {
      buf.writeUInt32BE(90_000_000, i + 4);
      return buf.toString("base64");
    }
  }
  throw new Error("amount not found in envelope");
}

main().catch((e) => bad(String((e as any)?.message ?? e)));
