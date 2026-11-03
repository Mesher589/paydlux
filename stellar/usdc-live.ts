#!/usr/bin/env npx tsx
// The real Circle USDC path, end to end, with money that Circle issued.
//
// usdc-check.ts can only add a trustline: Circle's testnet faucet used to be a
// JSON API and is now a web page, so a script can no longer mint testnet USDC.
// That left the actual money path untested — a trustline proves an account may
// HOLD USDC, not that a mandate can move it.
//
// So this uses USDC that already exists on the test ledger. The testnet vault's
// payee holds ~10,000 testnet USDC from an earlier faucet run, and the issuer
// on that line is Circle's testnet issuer, not ours. That is enough to walk a
// real USDC payment through the whole machine:
//
//   Circle USDC in the payee  ->  into the 2-of-2 vault  ->  out to a seller
//                                via a ledger mandate the agent key executes
//
// and to check the one thing that matters most: the seller receives USDC whose
// issuer is Circle, not a token that merely shares the name.
//
//   npx tsx stellar/usdc-live.ts [paydlux-vault.json]
import { existsSync, readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault, USDC_ISSUER, type Network } from "./vault.ts";

const FILE = process.argv[2] ?? "paydlux-vault.json";
let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \x1b[32m✓\x1b[0m " + m)) : (fail++, console.log("  \x1b[31m✗ " + m + "\x1b[0m")); };
const log = (...a: unknown[]) => console.log("•", ...a);

async function main() {
  if (!existsSync(FILE)) { console.log(`no vault file at ${FILE}`); process.exit(1); }
  const data = JSON.parse(readFileSync(FILE, "utf8"));
  const network = (data.network ?? "testnet") as Network;
  const circle = USDC_ISSUER[network];
  const keys = data.keys ?? {};
  if (!keys.principal || !keys.approver || !keys.agent) {
    console.log("this needs a vault file holding all three keys (a testnet setup vault).");
    process.exit(1);
  }
  if (!data.payee?.seed) { console.log("the payee in this file is not ours to sign for."); process.exit(1); }

  const principal = Keypair.fromSecret(keys.principal);
  const approver = Keypair.fromSecret(keys.approver);
  const agent = Keypair.fromSecret(keys.agent);
  const payeeKp = Keypair.fromSecret(data.payee.seed);

  // Load the vault AS a USDC vault. Note the file's own token is a test token
  // (AGPAY); useUsdc() is what points the object at Circle.
  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    { principal: principal.publicKey(), approver: approver.publicKey(), agent: agent.publicKey() } as any,
    network,
  ).then((v) => v.useUsdc());

  const usdcLine = async (addr: string): Promise<number> => {
    const acc = await vault.horizon.loadAccount(addr).catch(() => null);
    if (!acc) return 0;
    const b = (acc.balances as any[]).find((x) => x.asset_type !== "native"
      && x.asset_code === "USDC" && x.asset_issuer === circle);
    return b ? Number(b.balance) : 0;
  };

  const have = await usdcLine(data.payee.address);
  if (have < 2) {
    console.log(`the payee ${data.payee.address} holds ${have} USDC — nothing to move.
  send it some testnet USDC (from https://faucet.circle.com in a browser) and re-run.`);
    process.exit(1);
  }
  log(`starting with ${have} testnet USDC in the payee, issuer Circle ${circle.slice(0, 10)}…`);

  // 1. USDC into the vault. The vault must already trust Circle; if it does not,
  // the ledger refuses with OP_NO_TRUST and the money never arrives.
  const before = await usdcLine(vault.address);
  await vault.deposit("5", payeeKp);
  const inVault = await usdcLine(vault.address);
  ok(inVault >= before + 5, `Circle USDC entered the 2-of-2 vault: ${before} -> ${inVault}`);

  // 2. A seller with a USDC trustline, then a mandate the AGENT key executes.
  const seller = Keypair.random();
  await StellarVault.fundTestnet(seller);
  await vault.trustToken(seller.publicKey(), "1000", seller);

  const mandate = await vault.createMandate(
    { payee: seller.publicKey(), amount: "2", ttl: 600 }, principal, approver);
  log("mandate created on the ledger for 2 USDC");
  await vault.executeMandate(mandate, agent);

  const got = await usdcLine(seller.publicKey());
  ok(got === 2, `the seller received exactly 2 USDC via the mandate: ${got}`);
  ok((await usdcLine(vault.address)) === inVault - 2, `the vault is down by 2: ${await usdcLine(vault.address)}`);

  // 3. The asset the seller holds must be Circle's, not a namesake. Read it off
  // the ledger rather than trusting what we intended to send.
  const acc = await vault.horizon.loadAccount(seller.publicKey());
  const lines = (acc.balances as any[]).filter((b) => b.asset_code === "USDC");
  ok(lines.length === 1 && lines[0].asset_issuer === circle,
    `the only USDC line names Circle as issuer (${lines.map((l) => l.asset_issuer.slice(0, 10)).join(",")})`);

  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`);
  console.log(fail ? "the real USDC path is NOT proven" : "REAL CIRCLE USDC PATH WORKS: payee -> vault -> mandate -> seller");
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.log("crashed:", (e as Error).message); process.exit(1); });
