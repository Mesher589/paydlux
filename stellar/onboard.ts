#!/usr/bin/env npx tsx
// Paydlux onboarding — one command, from nothing to a working vault.
//
//   npx tsx stellar/onboard.ts
//
// Asks for nothing except a token code. Creates the vault on Stellar testnet,
// funds it, writes the keys to ./paydlux-vault.json (0600) and prints the two
// things you need: the seller address and the agent key to paste into your bot.
import { createInterface } from "node:readline/promises";
import { mkdirSync, existsSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";

const FILE = resolve(process.cwd(), "paydlux-vault.json");

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};

const main = async () => {
  console.log("\nPaydlux setup — Stellar testnet\n");
  // flags first so it also works non-interactively (CI, scripts, agents)
  const flags = { code: arg("code"), max: arg("max"), daily: arg("daily"), force: process.argv.includes("--force") };
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  if (existsSync(FILE) && !flags.force) {
    const ans = await rl.question(`${FILE} already exists. Overwrite? [y/N] `);
    if (!/^y(es)?$/i.test(ans.trim())) { console.log("keeping the existing vault."); rl.close(); return; }
  }
  const ask = async (q: string, def: string) =>
    process.stdin.isTTY ? (await rl.question(`${q} [${def}]: `)).trim() || def : def;
  const code = ((flags.code ?? await ask("token code for your payments", "AGPAY")) || "AGPAY").toUpperCase();
  const budget = flags.max ?? await ask("max per payment", "10");
  const daily = flags.daily ?? await ask("daily budget", "50");
  rl.close();

  console.log("\ncreating keys…");
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random();

  console.log("funding on testnet (friendbot, no captcha)…");
  for (const k of [issuer, principal, approver]) await StellarVault.fundTestnet(k);

  console.log("creating the 2-of-2 vault…");
  const vault = await StellarVault.create({ network: "testnet", issuer, principal, approver, agent, tokenCode: code });
  await vault.deposit(daily, issuer);

  const data = {
    createdAt: new Date().toISOString(),
    network: "testnet",
    vault: vault.address,
    token: { code, issuer: issuer.publicKey() },
    policy: { maxPerPayment: Number(budget), dailyBudget: Number(daily) },
    keys: {
      principal: principal.secret(),
      approver: approver.secret(),
      agent: agent.secret(),
      issuer: issuer.secret(),
    },
    explorer: `https://stellar.expert/explorer/testnet/account/${vault.address}`,
  };
  writeFileSync(FILE, JSON.stringify(data, null, 2));
  chmodSync(FILE, 0o600);

  console.log(`
done.

  vault account   ${vault.address}
  balance         ${await vault.balance()} ${code}
  explorer        ${data.explorer}
  keys written to ${FILE}  (permissions 0600 — treat like a password)

next:
  1. start a seller:   npx tsx stellar/demo.ts
  2. open approvals:   http://localhost:4022
  3. hand the agent key to your bot:
       new PaydluxAgent({ agentKey: "${agent.secret()}" })

the agent key is ONE of two signatures. It cannot spend on its own.
`);
};

main().catch((e) => { console.error("setup failed:", (e as Error).message); process.exit(1); });
