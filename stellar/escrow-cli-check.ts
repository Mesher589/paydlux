// The escrow promise, tested through the published CLI.
//
// escrow-check.ts proves the ledger primitives. escrow-gateway-check.ts proves
// the HTTP deal. This proves the SELLER'S EXPERIENCE: everything here happens by
// running `node dist/cli.js escrow ...` in a temp directory, exactly as a person
// would after `npm i -g @paydlux/agent`. Nothing calls the escrow module to move
// the seller's money, so if the CLI is not wired to the ledger this fails.
//
// Run: npx tsx stellar/escrow-cli-check.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { createEscrow, readEscrow } from "./escrow.ts";

const CLI = join(new URL("../dist/cli.js", import.meta.url).pathname);
const FILE = join(mkdtempSync(join(tmpdir(), "paydlux-escrow-")), "paydlux-vault.json");

function cli(args: string[], env: Record<string, string> = {}) {
  try {
    return { code: 0, out: execFileSync("node", [CLI, ...args, "--file", FILE], { encoding: "utf8", timeout: 180_000, env: { ...process.env, ...env } }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout ?? "") + String(e.stderr ?? "") };
  }
}

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + what); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + what); }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log("\nsetup a testnet vault through the CLI");
  // Native XLM, not the vault's own token: a stranger's buyer account has no
  // trustline for AGPAY, so an escrow priced in it fails OP_NO_TRUST before the
  // CLI is ever reached. XLM is also what the live doors actually settle in.
  const setup = cli(["setup", "--token", "XLM"]);
  ok(setup.code === 0, "`paydlux setup` exits 0");
  const v = JSON.parse(readFileSync(FILE, "utf8"));
  const asset = v.token.code === "XLM" ? Asset.native() : new Asset(v.token.code, v.token.issuer);
  const vault = await StellarVault.load(v.vault, v.token.code, v.token.issuer,
    {
      principal: Keypair.fromSecret(v.keys.principal).publicKey(),
      agent: Keypair.fromSecret(v.keys.agent).publicKey(),
      approver: Keypair.fromSecret(v.keys.approver).publicKey(),
    } as any, "testnet");
  const start = Number(await vault.balance());

  console.log("\nnothing locked yet: the CLI says so and sells the next step");
  const empty = cli(["escrow"]);
  ok(empty.code === 0, "`paydlux escrow` exits 0");
  ok(/no escrow is locked/.test(empty.out), "says nothing is locked");
  ok(/sell --escrow/.test(empty.out), "and names the command that starts one");

  console.log("\na buyer locks money for one order");
  const buyer = Keypair.random();
  await StellarVault.fundTestnet(buyer);
  const releaseAt = Math.floor(Date.now() / 1000) + 50;
  const { escrow } = await createEscrow("testnet", {
    orderId: "ord_cli_demo_1", asset, amount: "4",
    buyer: buyer.publicKey(), vault: v.vault, releaseAt,
  }, buyer);
  ok(!!escrow.balanceId, `locked on the ledger (${escrow.balanceId.slice(0, 14)}…)`);

  console.log("\n`paydlux escrow` shows the deal in the seller's words");
  const list = cli(["escrow"]);
  ok(list.code === 0, "exits 0");
  ok(/ord_cli_demo_1/.test(list.out), "prints the order id off the memo");
  ok(/4\.0000000/.test(list.out), "prints the locked amount");
  ok(list.out.includes(buyer.publicKey()), "prints who locked it");
  ok(/buyer can still take it back/.test(list.out), "says the buyer can still walk away");
  ok(/do not release it: refund it/i.test(list.out), "warns about an order id you never quoted");

  console.log("\nreleasing before the timer is refused, in words");
  const early = cli(["escrow", "--release", "ord_cli_demo_1"]);
  ok(early.code !== 0, `non-zero exit (${early.code})`);
  ok(/release timer has not passed/.test(early.out), "names the reason");
  ok(/min to go/.test(early.out), "says how long is left");
  ok((await readEscrow("testnet", escrow.balanceId))?.balanceId === escrow.balanceId, "the money is still locked");

  console.log("\na near-miss order id is not released 'approximately'");
  const typo = cli(["escrow", "--release", "ord_cli_demo"]);
  ok(typo.code !== 0 && /nothing locked matches/.test(typo.out), "refused, and tells you to list first");

  console.log("\nafter the timer the CLI releases it with both keys");
  while (Math.floor(Date.now() / 1000) < releaseAt) await sleep(1000);
  await sleep(3000);
  const after = cli(["escrow"]);
  ok(/release timer passed/.test(after.out), "the listing flips to claimable");
  ok(/--release ord_cli_demo_1/.test(after.out), "and prints the exact release command");
  const rel = cli(["escrow", "--release", "ord_cli_demo_1"]);
  ok(rel.code === 0, `release exits 0 (${rel.code})`);
  ok(/released 4\.0000000 for order ord_cli_demo_1/.test(rel.out), "says what it released and for which order");
  ok(/tx [0-9a-f]{64}/.test(rel.out), "prints the ledger tx");
  ok((await readEscrow("testnet", escrow.balanceId)) === null, "the escrow is gone from the ledger");
  ok(Number(await vault.balance()) >= start + 4 - 0.001, `the vault now holds ${await vault.balance()} ${v.token.code}`);

  console.log("\nthe buyer's refund is a command, not a paragraph");
  const { escrow: e2 } = await createEscrow("testnet", {
    orderId: "ord_cli_refund_1", asset, amount: "2",
    buyer: buyer.publicKey(), vault: v.vault, releaseAt: Math.floor(Date.now() / 1000) + 900,
  }, buyer);
  const noKey = cli(["escrow", "--refund", e2.balanceId]);
  ok(noKey.code !== 0 && /buyer's key/.test(noKey.out), "refuses without the buyer's key and says why");
  ok((await readEscrow("testnet", e2.balanceId))?.balanceId === e2.balanceId, "the money stayed locked");
  const back = cli(["escrow", "--refund", e2.balanceId], { PAYDLUX_BUYER_SEED: buyer.secret() });
  ok(/refunded/.test(back.out), "the buyer took it back from the command line");
  ok((await readEscrow("testnet", e2.balanceId)) === null, "and the escrow is gone");

  console.log(`\nexplorer: https://stellar.expert/explorer/testnet/account/${v.vault}`);
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

main().catch((e: any) => {
  console.error("\nCLI escrow check crashed:", e?.response?.data ?? e?.stdout ?? e?.message ?? e);
  process.exit(1);
});
