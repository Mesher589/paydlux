#!/usr/bin/env node
// paydlux — the seller app. One command, no repo checkout, no config file to
// hand-edit.
//
//   paydlux setup                 create a vault (testnet by default)
//   paydlux sell                  start the gateway + approval desk
//   paydlux status                what a vault holds and who can sign for it
//
// Everything reads one file, ./paydlux-vault.json, which `setup` writes. That
// file holds the vault's private keys, so it is 0600 and it is in .gitignore.
//
// This is the difference between a demo and a product: before, running Paydlux
// meant reading stellar/demo.ts and editing an array of routes in TypeScript.
// A seller should type one command and get a price, a link, and a key to paste
// into their bot.
import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair, Asset } from "@stellar/stellar-sdk";
import { StellarVault, USDC_ISSUER, type Network } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { newPortalKey } from "./desk.ts";
import { PolicyEngine } from "./policy.ts";
import { PUBLIC_HOST, runTunnel, tunnelLive, tunnelProblem } from "./tunnel.ts";

export const VAULT_FILE_DEFAULT = "paydlux-vault.json";

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const log = (...a: unknown[]) => console.log("•", ...a);
/** Print a reason and stop. Declared as a function (not an arrow in a const) so
 *  TypeScript's control-flow analysis actually narrows the caller after it. */
function bad(msg: string): never { console.error("\n" + msg + "\n"); process.exit(1); }

/** The one file that holds everything. Refuses to read a file that is world-readable. */
export function loadVault(path = resolve(process.cwd(), arg("file") ?? VAULT_FILE_DEFAULT)) {
  if (!existsSync(path)) {
    bad(`no vault here. Run:  paydlux setup`);
  }
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!data.keys?.principal) bad(`${path} has no keys.principal — it is not a Paydlux vault file`);
  return { path, data };
}

function pub(seed: string) { return Keypair.fromSecret(seed).publicKey(); }

/**
 * Persist the portal key so the phone link survives a restart. A new key every
 * boot means the human re-scans a QR every time and any link already opened on
 * a phone stops working mid-payment.
 */
function deskKeys(path: string, data: any) {
  if (!data.desk) data.desk = {};
  if (!data.desk.portalKey) {
    data.desk.portalKey = newPortalKey();
    data.desk.createdAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(data, null, 2));
    chmodSync(path, 0o600);
  }
  return data.desk.portalKey as string;
}

// ------------------------------------------------------------------------ sell

async function sell() {
  const { path, data } = loadVault();
  const network = (data.network ?? "testnet") as Network;
  const keys = data.keys;
  const payee = data.payee?.address;
  if (!payee) bad(`${path} has no payee.address — where should payment land?\n  add it, or re-run: paydlux setup`);

  const price = arg("price") ?? data.policy?.defaultPrice ?? "1";
  if (!(Number(price) > 0)) bad("--price must be a positive number");
  const uri = arg("route") ?? "/api/data";
  const mode = flag("preauth") ? "preauth" : "approval";
  const tls = flag("tls");
  const split = flag("split");

  // Real money gets a hard ceiling, and it is not a suggestion. The ledger
  // already caps a single payment at the mandate amount; what it cannot do is
  // count payments. So the ceiling lives here, and it is applied before the
  // desk is even built.
  const maxPer = Number(arg("max") ?? data.policy?.maxPerPayment ?? 2);
  const daily = Number(arg("daily") ?? data.policy?.dailyBudget ?? 10);
  const policy = new PolicyEngine({ maxPerPayment: maxPer, dailyBudget: daily });

  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    { principal: pub(keys.principal), approver: pub(keys.approver), agent: pub(keys.agent) },
    network,
  );
  if (data.token.code === "USDC") vault.useUsdc();

  if (network === "public") {
    console.log(`
  MAINNET — real money.
    token            ${data.token.code}
    max per payment  ${maxPer}
    daily budget     ${daily}
    vault            ${vault.address}
    balance          ${await vault.balance()} ${data.token.code}
`);
    if (!flag("yes") && process.stdin.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ans = await rl.question("  every payment here is real and irreversible. continue? [y/N] ");
      rl.close();
      if (!/^y(es)?$/i.test(ans.trim())) bad("stopped. nothing was started.");
    }
  }

  // A vault that cannot pay its ledger rent stops working with a confusing
  // error, so say what is actually wrong before starting anything.
  const rent = await vaultRent(vault);
  if (rent.short) {
    bad(`the vault is short of XLM for its own ledger rent.\n  needs ${rent.min} XLM, has ${rent.xlm} XLM.\n  send more XLM to ${vault.address} and try again.`);
  }

  const portalKey = deskKeys(path, data);
  const publicHost = tls ? PUBLIC_HOST : (arg("host") ?? undefined);
  const deskPort = Number(arg("desk") ?? 4022);
  const gwPort = Number(arg("port") ?? 4021);

  const gw = new Gateway({
    vault, network, payee,
    deskPort,
    principal: keys.principal,
    // --split is the honest mode: this process cannot approve anything.
    approver: split ? undefined : keys.approver,
    split,
    portalKey,
    publicHost,
    agentKeys: [pub(keys.agent)],
    routes: [{ uri, price, mode, holdSeconds: Number(arg("hold") ?? 3600) }],
  });

  let tunnel: ReturnType<typeof runTunnel> | null = null;
  if (tls) {
    const problem = tunnelProblem();
    if (problem) bad("--tls cannot run here: " + problem);
    tunnel = runTunnel();
  }

  await gw.listen(gwPort, (u) => JSON.stringify({
    served: u, at: new Date().toISOString(),
    note: "paid through Paydlux; the payment is on the Stellar ledger",
  }));
  await gw.desk.listen(deskPort);

  const deskUrl = tls ? `https://${PUBLIC_HOST}` : `http://127.0.0.1:${deskPort}`;
  if (tls) {
    const live = await tunnelLive();
    log(live ? `desk is live at https://${PUBLIC_HOST}` : `tunnel started but https://${PUBLIC_HOST} is not answering yet`);
    if (!live) {
      const why = tunnel?.lastError();
      log(why ? "tunnel said: " + why : "give it a few seconds, then open the link");
    }
  }

  console.log(`
  selling ${uri} for ${price} ${data.token.code}   (${mode})
  gateway    http://127.0.0.1:${gwPort}${uri}
  approvals  ${deskUrl}/?k=${portalKey}
  phone      ${deskUrl}/phone/?k=${portalKey}

  paste into your bot:
      import { PaydluxAgent } from "@paydlux/agent";
      const agent = new PaydluxAgent({ agentKey: "${keys.agent}", network: "${network}" });
      const res = await agent.get("http://127.0.0.1:${gwPort}${uri}");

  ${split
    ? "approvals need your phone. this machine holds one of the two keys."
    : "WARNING: this process holds BOTH human keys. Anyone with this machine can approve. Use --split for anything real."}
  policy: max ${maxPer} per payment, ${daily} per day
  ctrl-c to stop
`);

  // The desk is a queue, not a database. If it dies with a payment parked, the
  // buyer is waiting on nothing, so say so rather than exiting silently.
  const bye = () => {
    const open = gw.desk.list().filter((r) => r.status === "pending" || r.status === "awaiting_phone");
    if (open.length) console.log(`\n  stopping with ${open.length} payment(s) still waiting: ${open.map((r) => r.id).join(", ")}`);
    if (tunnel && !tunnel.proc.killed) tunnel.proc.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", bye);
  process.on("SIGTERM", bye);
}

/** XLM the vault must hold to exist, versus what it actually has. */
async function vaultRent(vault: StellarVault) {
  const acc: any = await vault.horizon.loadAccount(vault.address);
  const xlm = acc.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";
  const min = ((2 + (acc.subentry_count ?? 0)) * 0.5).toFixed(1);
  return { xlm, min, short: Number(xlm) < Number(min) };
}

// ---------------------------------------------------------------------- status

async function status() {
  const { data } = loadVault();
  const network = (data.network ?? "testnet") as Network;
  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    { principal: pub(data.keys.principal), approver: pub(data.keys.approver), agent: pub(data.keys.agent) },
    network,
  );
  if (data.token.code === "USDC") vault.useUsdc();

  const rent = await vaultRent(vault);
  const signers = await vault.signerSummary();
  const live = signers.signers.filter((s: any) => s.type === "preauth-mandate");

  console.log(`
  network   ${network}
  vault     ${vault.address}
  token     ${data.token.code} (${data.token.issuer.slice(0, 8)}…)
  balance   ${await vault.balance()} ${data.token.code}
  xlm rent  ${rent.xlm} / ${rent.min} XLM  ${rent.short ? "SHORT — payments will fail" : "ok"}
  payee     ${data.payee?.address ?? "(not set)"}
  thresholds ${JSON.stringify(signers.thresholds)}
  signers   ${signers.signers.map((s: any) => `${s.type}${s.weight === 0 ? " (off)" : ""}`).join(", ")}
  live mandates ${live.length}
  explorer  https://stellar.expert/explorer/${network === "public" ? "account" : "testnet/account"}/${vault.address}
`);
}

// ----------------------------------------------------------------------- setup

/**
 * Create a vault. Testnet is the default and needs nothing from you.
 * --mainnet is a different conversation: it needs a wallet to fund the accounts
 * and it puts real XLM and real USDC into play, so it asks before spending.
 */
async function setup() {
  const mainnet = flag("mainnet");
  const network: Network = mainnet ? "public" : "testnet";
  const file = resolve(process.cwd(), arg("file") ?? VAULT_FILE_DEFAULT);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def: string) =>
    process.stdin.isTTY ? (await rl.question(`${q} [${def}]: `)).trim() || def : def;

  if (existsSync(file) && !flag("force")) {
    const ans = await ask(`${file} already exists. Overwrite? [y/N] `, "n");
    if (!/^y(es)?$/i.test(ans.trim())) { console.log("keeping the existing vault."); rl.close(); return; }
  }

  const code = ((arg("token") ?? await ask("token for your payments", mainnet ? "USDC" : "AGPAY")) || "AGPAY").toUpperCase();
  const budget = Number(arg("max") ?? await ask("max per payment", mainnet ? "2" : "10"));
  const daily = Number(arg("daily") ?? await ask("daily budget", mainnet ? "10" : "50"));
  if (mainnet && code !== "USDC") {
    bad("on mainnet this first release only supports USDC. Custom tokens need an issuer key you would have to hold and protect — not a first-money decision.");
  }
  rl.close();

  console.log(`\nPaydlux setup — Stellar ${network}${mainnet ? " (REAL MONEY)" : ""}\n`);

  const principal = Keypair.random(), approver = Keypair.random(), agent = Keypair.random();
  const payee = Keypair.random();
  const issuer = code === "USDC" ? null : Keypair.random();

  // The account that pays the XLM for creating everything. On testnet that is
  // friendbot. On mainnet it has to be a wallet the human already controls.
  let funder: Keypair;
  if (!mainnet) {
    if (!issuer) throw new Error("internal: a custom token needs an issuer key");
    console.log("funding on testnet (friendbot, no captcha)…");
    for (const k of [issuer, principal, approver, payee]) await StellarVault.fundTestnet(k);
    funder = issuer;
  } else {
    const seed = arg("fund-seed") ?? process.env.PAYDLUX_FUND_SEED;
    if (!seed) {
      bad(`mainnet needs a wallet to pay the account-creation costs.

  paydlux setup --mainnet --fund-seed S…

  The wallet only needs a few XLM (about 8 XLM covers everything here, at
  ~0.17 USDT per XLM). It is used to CREATE two accounts; it cannot touch the
  vault afterwards, because the vault's own keys are made fresh right now and
  its master key is switched off in the same transaction that creates it.`);
    }
    funder = Keypair.fromSecret(seed);
    const h = new (await import("@stellar/stellar-sdk")).Horizon.Server("https://horizon.stellar.org");
    const acc: any = await h.loadAccount(funder.publicKey()).catch(() => null);
    if (!acc) bad(`the funding wallet ${funder.publicKey()} does not exist on mainnet. Send it some XLM first.`);
    const xlm = acc.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";
    if (Number(xlm) < 8) bad(`the funding wallet has ${xlm} XLM. Creating a vault + a payee account needs about 8 XLM.`);
    console.log(`funding wallet ${funder.publicKey()} — ${xlm} XLM`);
  }

  console.log("creating the 2-of-2 vault…");
  const vault = await StellarVault.create({
    network,
    issuer: funder,
    principal, approver, agent,
    tokenCode: code,
    tokenIssuer: code === "USDC" ? USDC_ISSUER[network] : undefined,
    // mainnet: 2 base reserves + 3 signers + 1 trustline = 3 XLM locked, plus
    // room for one live mandate (0.5 XLM) and fees. 5 leaves a margin.
    startingBalance: mainnet ? "5" : undefined,
  });
  console.log("vault created. master key is off: it can never act alone again.");

  // A Stellar account must exist before it can be paid, and a payment cannot
  // create one — only createAccount can. And holding a token is not automatic:
  // the receiving account has to open a trustline first, or the payment fails
  // with OP_NO_TRUST. This is the single most common reason a first real
  // payment is rejected, so it happens here, once, at setup.
  if (mainnet) {
    console.log("creating the payee account (2 XLM) and its USDC trustline…");
    const { Horizon, TransactionBuilder, Operation, Account, Networks } = await import("@stellar/stellar-sdk");
    const h = new Horizon.Server("https://horizon.stellar.org");
    const fa = await h.loadAccount(funder.publicKey());
    const t1 = new TransactionBuilder(new Account(funder.publicKey(), fa.sequence),
      { fee: "100", networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.createAccount({ destination: payee.publicKey(), startingBalance: "2" }))
      .setTimeout(120).build();
    t1.sign(funder);
    await h.submitTransaction(t1);
  }
  await vault.trustToken(payee.publicKey(), "100000", payee);
  console.log("payee account ready and trusted for " + code + ".");
  if (issuer) await vault.deposit(String(daily), issuer);

  const data = {
    createdAt: new Date().toISOString(),
    network,
    vault: vault.address,
    token: { code, issuer: code === "USDC" ? USDC_ISSUER[network] : issuer!.publicKey() },
    policy: { maxPerPayment: budget, dailyBudget: daily, defaultPrice: mainnet ? "1" : "2" },
    payee: { address: payee.publicKey(), seed: payee.secret() },
    keys: {
      principal: principal.secret(),
      approver: approver.secret(),
      agent: agent.secret(),
      ...(issuer ? { issuer: issuer.secret() } : {}),
    },
    explorer: `https://stellar.expert/explorer/${network === "public" ? "account" : "testnet/account"}/${vault.address}`,
  };
  writeFileSync(file, JSON.stringify(data, null, 2));
  chmodSync(file, 0o600);

  console.log(`
done.

  vault account   ${vault.address}
  payee account   ${payee.publicKey()}
  balance         ${await vault.balance()} ${code}
  keys written to ${file}  (permissions 0600 — treat like a password)
`);

  if (mainnet) {
    console.log(`next — put real money in it:
  1. send ${daily} USDC to ${vault.address}
     (from any exchange or wallet that supports USDC on Stellar; the vault
      already trusts Circle USDC, so the transfer will land)
  2. check it arrived:   paydlux status
  3. start selling:      paydlux sell --split --tls

  keep the approver key off this machine:
     paydlux sell --split   prints the approver seed for your phone only
`);
  } else {
    console.log(`next:
  1. start selling:   paydlux sell
  2. open approvals:  http://127.0.0.1:4022
  3. hand the agent key to your bot (printed by paydlux sell)

the agent key is ONE of two signatures. It cannot spend on its own.
`);
  }
}

// -------------------------------------------------------------------- approver

/**
 * The approver key is the human's half of the vault. While it sits in
 * paydlux-vault.json on this laptop, this machine can approve its own payments
 * and the 2-of-2 vault is really 1-of-1 with extra steps.
 *
 * `paydlux approver` prints it once so it can be put on the phone.
 * `paydlux approver --forget` then deletes it from this machine for good: the
 * laptop keeps the principal half, the phone holds the other, and neither can
 * release money alone. That is the point of the design, so it is a command and
 * not a paragraph in a README.
 */
async function approver() {
  const { path, data } = loadVault();
  const forget = flag("forget");
  const seed = data.keys?.approver;
  if (!seed) {
    console.log(`no approver key on this machine — approvals already need your phone.
  sell with:  paydlux sell --split --tls`);
    return;
  }
  const pub = Keypair.fromSecret(seed).publicKey();
  const portalKey = data.desk?.portalKey;
  const host = flag("tls") || portalKey ? `https://${PUBLIC_HOST}` : `http://127.0.0.1:4022`;

  console.log(`
approver key (the human half of the vault)

  public   ${pub}
  secret   ${seed}

Put that secret on the phone approver. It is the only thing that can release
money besides this laptop, so anyone holding it can spend up to your cap.

phone link:  ${host}/phone/?k=${portalKey ?? "(run paydlux sell --tls first)"}
`);

  if (!forget) {
    console.log("this laptop still holds it, so it can still approve alone.\n"
      + "when the phone is set up, run:\n\n  paydlux approver --forget\n");
    return;
  }

  // Confirm: deleting this is irreversible unless the seed was written down.
  if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question("  the phone has it and you do not need it here again. delete? [y/N] ");
    rl.close();
    if (!/^y(es)?$/i.test(ans.trim())) { console.log("kept. nothing changed."); return; }
  }
  delete data.keys.approver;
  data.keys.approverRemovedAt = new Date().toISOString();
  writeFileSync(path, JSON.stringify(data, null, 2));
  chmodSync(path, 0o600);
  console.log(`
removed from ${path}. this machine can no longer approve anything by itself.
sell with:  paydlux sell --split --tls
`);
}

// ------------------------------------------------------------------------- main

const HELP = `paydlux — get paid by AI agents, with a human in the loop.

  paydlux setup [--mainnet] [--token USDC] [--fund-seed S…]
      create a vault. testnet by default (free, no wallet needed).
  paydlux sell  [--price 1] [--route /api/data] [--split] [--tls] [--preauth]
      start the gateway and the approval desk.
  paydlux status
      balances, signers, live mandates, ledger rent.
  paydlux approver [--forget]
      print the human half of the vault, then optionally delete it from this
      machine so only the phone can approve.

one file holds it all: ./paydlux-vault.json (0600, never commit it)
`;

export async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { console.log(HELP); return; }
  if (cmd === "setup") return setup();
  if (cmd === "sell") return sell();
  if (cmd === "status") return status();
  if (cmd === "approver") return approver();
  bad(`unknown command "${cmd}".\n\n${HELP}`);
}

// Only run when this file is the entry point, so importing it in a test is safe.
if (process.argv[1] && /cli\.(ts|js)$/.test(process.argv[1])) {
  main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
}
