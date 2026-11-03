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
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Account, Keypair, Asset, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { StellarVault, USDC_ISSUER, passphrase, type Network } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { newPortalKey } from "./desk.ts";
import { PolicyEngine } from "./policy.ts";
import { PUBLIC_HOST, TUNNEL_NAME, runTunnel, tunnelLive, tunnelProblem, tunnelServes } from "./tunnel";
import { DEMO_HOST, DEMO_ROUTE, startDemo } from "./showcase";
import { DONATE_HOST, DONATE_PORT, startDonate } from "./donate";

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

/**
 * Ask the OS whether a port is free, and if not, who owns it. Returns null when
 * the port is available. Naming the owning process is what turns "EADDRINUSE"
 * into something a seller can act on.
 */
function portHolder(port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EADDRINUSE") resolve(findListener(port) ?? "another process");
      else resolve(null); // some other bind problem; let the real listen report it
    });
    probe.once("listening", () => { probe.close(() => resolve(null)); });
    probe.listen(port, "127.0.0.1");
  });
}

/** Best-effort: which command is holding this port, from `lsof`. */
function findListener(port: number): string | null {
  try {
    const out = execSync(`lsof -nP -ti tcp:${port} -sTCP:LISTEN 2>/dev/null`, { encoding: "utf8" });
    const pid = out.trim().split("\n")[0];
    if (!pid) return null;
    const cmd = execSync(`ps -o command= -p ${pid} 2>/dev/null`, { encoding: "utf8" }).trim();
    const mine = cmd.includes("cli") || cmd.includes("paydlux");
    return `${mine ? "another Paydlux (pid " + pid + ")" : cmd || "pid " + pid}`;
  } catch { return null; }
}

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
export function deskKeys(path: string, data: any) {
  if (!data.desk) data.desk = {};
  if (!data.desk.portalKey) {
    data.desk.portalKey = newPortalKey();
    data.desk.createdAt = new Date().toISOString();
    writeFileSync(path, JSON.stringify(data, null, 2));
    chmodSync(path, 0o600);
  }
  return data.desk.portalKey as string;
}

/** Does this account already hold the token the vault pays in? */
async function trusts(vault: StellarVault, address: string) {
  const acc = await vault.horizon.loadAccount(address).catch(() => null);
  if (!acc) return false;
  // Every account can already hold XLM; there is no trustline to be missing.
  if (vault.isNative) return true;
  const code = vault.token.getCode(), issuer = vault.token.getIssuer();
  return (acc.balances as any[]).some((b) => b.asset_type !== "native"
    && b.asset_code === code && b.asset_issuer === issuer);
}

/**
 * Where the money lands.
 *
 * `setup` creates a payee account for you. Two cases break that: a vault made
 * before the payee existed, and a seller who wants the money in their own
 * account (a Binance deposit address, an exchange wallet). Both are handled
 * here, because a payment to an account that does not exist — or that does not
 * trust the token — fails on the ledger with a code the seller never sees.
 *
 * Adding a trustline needs the payee's own key, so for an outside account we can
 * only check and explain. For a payee we generated, we do it ourselves.
 */
export async function ensurePayee(path: string, data: any, vault: StellarVault) {
  const specified = arg("payee");
  if (specified) {
    if (!/^G[A-Z2-7]{55}$/.test(specified)) bad(`--payee must be a Stellar account (G…56 chars), got "${specified}"`);
    if (specified === vault.address) bad("--payee cannot be the vault itself");
    if (!(await trusts(vault, specified))) {
      bad(`${specified} does not hold ${vault.token.getCode()} yet, so a payment to it would be\n  rejected by the ledger (OP_NO_TRUST).\n\n  add a trustline for ${vault.token.getCode()} from ${vault.token.getIssuer()} to that account\n  (the exchange or wallet that owns it does this), or drop --payee and Paydlux will\n  create and manage a payee account for you.`);
    }
    data.payee = { address: specified, external: true };
    writeFileSync(path, JSON.stringify(data, null, 2));
    chmodSync(path, 0o600);
    log(`payments land in your account ${specified}`);
    return specified;
  }

  if (data.payee?.address && !data.payee.seed) return data.payee.address;
  if (data.payee?.address && (await trusts(vault, data.payee.address))) return data.payee.address;

  const keys = data.keys;
  if (!keys.approver) {
    bad(`this vault has no payee account yet, and creating one needs both human keys —\n  this machine holds only one.\n\n  point the payments at an account you already own that holds ${vault.token.getCode()}:\n\n  paydlux sell --payee G…`);
  }
  const kp = Keypair.fromSecret(data.payee?.seed ?? Keypair.random().secret());
  if (!data.payee?.address) {
    log(`creating the payee account (2 XLM of ledger rent)…`);
    const acc = await vault.horizon.loadAccount(vault.address);
    const tx = new TransactionBuilder(new Account(vault.address, acc.sequence), {
      fee: "100", networkPassphrase: passphrase((data.network ?? "testnet") as Network),
    })
      .addOperation(Operation.createAccount({ destination: kp.publicKey(), startingBalance: "2" }))
      .setTimeout(120).build();
    tx.sign(Keypair.fromSecret(keys.principal));
    tx.sign(Keypair.fromSecret(keys.approver));
    await vault.horizon.submitTransaction(tx);
  }
  if (!(await trusts(vault, kp.publicKey()))) await vault.trustToken(kp.publicKey(), "1000000", kp);
  data.payee = { address: kp.publicKey(), seed: kp.secret() };
  writeFileSync(path, JSON.stringify(data, null, 2));
  chmodSync(path, 0o600);
  log(`payments land in ${kp.publicKey()}`);
  return kp.publicKey();
}

/**
 * Change what the vault settles in. USDC only: a custom token would need an
 * issuer key, and holding one quietly is not a decision to make in a flag.
 * The trustline needs both human keys, so this has to run before
 * `approver --forget` takes one away.
 */
async function switchToken(path: string, data: any, code: string) {
  if (code !== "USDC") {
    bad(`switching to a custom token means holding an issuer key. Only USDC can be\n  switched to here. Create a token vault with: paydlux setup --token ${code}`);
  }
  const network = (data.network ?? "testnet") as Network;
  if (!data.keys.approver) bad(`adding the USDC trustline needs both human keys and this machine holds one. Re-run on the machine with both, then use approver --forget.`);
  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    { principal: pub(data.keys.principal), approver: pub(data.keys.approver), agent: pub(data.keys.agent) } as any,
    network,
  );
  log(`adding a USDC trustline to the vault…`);
  await vault.trustUsdc(Keypair.fromSecret(data.keys.principal), Keypair.fromSecret(data.keys.approver));
  data.token = { code: "USDC", issuer: USDC_ISSUER[network] };
  writeFileSync(path, JSON.stringify(data, null, 2));
  chmodSync(path, 0o600);
  log("the vault now settles in Circle USDC");
}

// ------------------------------------------------------------------------ sell

async function sell() {
  const { path, data } = loadVault();
  const network = (data.network ?? "testnet") as Network;
  const keys = data.keys;

  // Settle in real money instead of the token this vault issued. Needs a
  // trustline, which needs both human keys, so it happens here — before
  // `approver --forget` takes one of them away.
  const wantToken = arg("token")?.toUpperCase();
  if (wantToken && wantToken !== data.token.code) await switchToken(path, data, wantToken);

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

  // A ceiling below the price blocks every payment, and the failure looks like
  // a bug in the desk: the buyer waits, the human never sees an approvable
  // item, and the log says "mandate refused". Say it now, before anything is
  // started, because this is a mistake in the flags and not in the product.
  const priceNum = Number(price);
  if (!(priceNum > 0)) bad(`--price ${price} is not a number greater than zero.`);
  if (priceNum > maxPer) {
    bad(`--price ${price} is above --max ${maxPer}, so every payment would be refused by your own mandate.\n  raise --max to at least ${price} (for example --max ${price}) or lower --price.`);
  }
  if (priceNum > daily) {
    bad(`--price ${price} is above --daily ${daily}: one payment would spend the whole day's budget and the second would be refused.\n  set --daily to at least ${price}.`);
  }

  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    { principal: pub(keys.principal), approver: keys.approver ? pub(keys.approver) : undefined, agent: pub(keys.agent) } as any,
    network,
  );
  if (data.token.code === "USDC") vault.useUsdc();

  // Resolve where the money lands before anything starts listening. A parked
  // payment with no valid payee is a payment that fails an hour later, after
  // the human already said yes.
  const payee = await ensurePayee(path, data, vault);

  // The daily budget has to survive a restart. Counting only what this process
  // has seen means `ctrl-c`, `npm run app` again, and the day's total is back to
  // zero — so the mandate in the banner is a promise the code does not keep.
  // Ask the ledger what the vault already paid this payee today and start from
  // there. If the query fails, refuse to start rather than run with a budget
  // that silently reads as unspent.
  let alreadyPaid = 0;
  try {
    alreadyPaid = Number(await vault.paidToday(payee));
  } catch (e: any) {
    bad(`cannot read today's spending from the ledger (${e?.message ?? e}).\n  `
      + `the daily budget of ${daily} cannot be enforced without it, so nothing was started. `
      + `Check the network and try again.`);
  }
  policy.seedFromLedger(alreadyPaid);
  if (alreadyPaid > 0) {
    log(`ledger says ${alreadyPaid.toFixed(2)} of the ${daily} daily budget is already spent today`);
    if (alreadyPaid >= daily) {
      bad(`today's budget is already gone: ${alreadyPaid.toFixed(2)} paid, ${daily} allowed.\n  `
        + `the mandate would refuse every payment. Raise --daily or wait for the UTC day to roll over.`);
    }
  }

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

  // A taken port used to surface as an unhandled EADDRINUSE stack trace from
  // inside Node. To someone following the README that reads as a broken
  // install, and the stack names neither port nor remedy.
  for (const [label, port] of [["gateway", gwPort], ["approval desk", deskPort]] as const) {
    const who = await portHolder(port);
    if (who) {
      // Suggest the pair, not the clashing port twice: --port and --desk with
      // the same number would fail on the next line.
      bad(`port ${port} (${label}) is already in use by ${who}.\n` +
          `  another Paydlux is probably running. Stop it, or move this one:\n` +
          `  paydlux sell --port ${gwPort + 100} --desk ${deskPort + 100}`);
    }
  }

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
    routes: [
      { uri, price, mode, holdSeconds: Number(arg("hold") ?? 3600) },
      // --showcase adds a second priced route for the public page. Same price,
      // same mandate, same desk: the showcase gets no special treatment at the
      // spending door, it only gets its own hostname.
      ...(flag("showcase")
        ? [{ uri: DEMO_ROUTE, price, mode: mode as "approval" | "preauth", holdSeconds: Number(arg("hold") ?? 3600) }]
        : []),
    ],
    // The banner prints these numbers. This line is what makes them true.
    policy,
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

  // The public showcase: a page where a stranger drives the real 402 loop.
  // It is a second listener in front of the SAME gateway, so the mandate, the
  // desk and the daily budget are the ones already under test. It is refused
  // without --tls because a payment request over plain HTTP is a request
  // somebody else can replay.
  if (flag("showcase")) {
    if (!tls) {
      bad("--showcase needs --tls. The page hands out agent identities to strangers; "
        + "doing that over plain HTTP means anyone on the path can collect them.");
    }
    const demoPort = Number(arg("demo-port") ?? 4023);
    const who = await portHolder(demoPort);
    if (who) bad(`port ${demoPort} (showcase) is already in use by ${who}.`);
    await startDemo({
      port: demoPort, price, network, vault: vault.address, token: data.token.code,
      explorer: data.explorer ?? "", gateway: gw,
      onKeys: (pubs) => { gw.agentKeys = [pub(keys.agent), ...pubs]; },
    });
    log(`showcase is listening on 127.0.0.1:${demoPort} for https://${DEMO_HOST}`);
    if (!tunnelServes(DEMO_HOST)) {
      log(`  the tunnel does not route ${DEMO_HOST} yet. Add to ~/.cloudflared/config.yml:`);
      log(`    - hostname: ${DEMO_HOST}`);
      log(`      service: http://127.0.0.1:${demoPort}`);
      log(`  then: cloudflared tunnel route dns ${TUNNEL_NAME} ${DEMO_HOST}`);
    }
  }

  // The donation door: a stranger's agent pays US from THEIR vault. This is
  // the seller door (stellar/receive.ts) with a page a human can read. It is a
  // separate listener on a separate hostname because it has a different trust
  // profile: it holds no key, signs nothing, and can only ever hand out content
  // the ledger confirms we were paid for.
  if (flag("donate")) {
    if (!tls) bad("--donate needs --tls. The order and its memo travel to a stranger's agent; over plain HTTP someone on the path can take them and pay for your order instead of theirs.");
    const dPort = Number(arg("donate-port") ?? DONATE_PORT);
    const who = await portHolder(dPort);
    if (who) bad(`port ${dPort} (donations) is already in use by ${who}.`);
    const door = startDonate({
      port: dPort, hostname: DONATE_HOST, payee, network,
      price: arg("donate-price") ?? price,
      asset: vault.isNative
        ? { code: vault.token.getCode() }
        : { code: vault.token.getCode(), issuer: vault.token.getIssuer() },
      vault: vault.address,
    });
    // startReceive builds the routes and hands back listen(); without this call
    // the door answers nothing and the tunnel returns 502 with no local error.
    await door.listen(dPort);
    log(`donations are listening on 127.0.0.1:${dPort} for https://${DONATE_HOST}`);
    if (!tunnelServes(DONATE_HOST)) {
      log(`  the tunnel does not route ${DONATE_HOST} yet. Add to ~/.cloudflared/config.yml:`);
      log(`    - hostname: ${DONATE_HOST}`);
      log(`      service: http://127.0.0.1:${dPort}`);
      log(`  then: cloudflared tunnel route dns ${TUNNEL_NAME} ${DONATE_HOST}`);
    }
  }

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

${flag("donate") ? `  donations  https://${DONATE_HOST}   (they pay YOU from THEIR vault)
` : ""}
  paste into your bot:
      import { PaydluxAgent } from "@paydlux/agent";
      const agent = new PaydluxAgent({ agentKey: "${keys.agent}", network: "${network}" });
      const res = await agent.get("http://127.0.0.1:${gwPort}${uri}");

  ${split
    ? "approvals need your phone. this machine holds one of the two keys."
    : "WARNING: this process holds BOTH human keys. Anyone with this machine can approve. Use --split for anything real."}
  policy: max ${maxPer} per payment, ${daily} per day${alreadyPaid > 0 ? ` (${(daily - alreadyPaid).toFixed(2)} left today)` : ""}
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
    { principal: pub(data.keys.principal), approver: data.keys.approver ? pub(data.keys.approver) : undefined, agent: pub(data.keys.agent) } as any,
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
  // XLM is a first-class settlement asset now, not a fallback. It is the
  // cheapest way to take real money: no trustline for the buyer, no issuer to
  // trust, and a visitor can fund a wallet from any exchange in one step.
  const native = code === "XLM" || code === "NATIVE";
  if (mainnet && !native && code !== "USDC") {
    bad("on mainnet this first release only supports XLM and USDC. Custom tokens need an issuer key you would have to hold and protect — not a first-money decision.");
  }
  if (native && (budget < 1 || daily < 1)) {
    bad("an XLM budget under 1 is not usable: Stellar amounts are 7 decimals but rent is paid in XLM, so a sub-1 daily budget would be eaten by the vault's own ledger rent.");
  }
  rl.close();

  console.log(`\nPaydlux setup — Stellar ${network}${mainnet ? " (REAL MONEY)" : ""}\n`);

  const principal = Keypair.random(), approver = Keypair.random(), agent = Keypair.random();
  const payee = Keypair.random();
  // XLM and USDC both have no issuer key for us to hold: XLM is the ledger's
  // own currency and Circle mints USDC. Only a custom token needs one.
  const issuer = native || code === "USDC" ? null : Keypair.random();

  // The account that pays the XLM for creating everything. On testnet that is
  // friendbot. On mainnet it has to be a wallet the human already controls.
  let funder: Keypair;
  if (!mainnet) {
    console.log("funding on testnet (friendbot, no captcha)…");
    const toFund = [principal, approver, payee, ...(issuer ? [issuer] : [])];
    for (const k of toFund) await StellarVault.fundTestnet(k);
    // With no issuer key, one of the throwaway funded accounts pays for the
    // vault's creation. It is not a key the vault ever trusts.
    funder = issuer ?? toFund[0];
  } else {
    const seed = arg("fund-seed") ?? process.env.PAYDLUX_FUND_SEED;
    if (!seed) {
      const need = native ? 15 : 8;
      bad(`mainnet needs a wallet to pay the account-creation costs.

  paydlux setup --mainnet --token ${code} --fund-seed S…

  The wallet needs ${need} XLM (at ~0.17 USDT per XLM that is a few dollars). It
  is used to CREATE two accounts and nothing else: it cannot touch the vault
  afterwards, because the vault's own keys are made fresh right now and its
  master key is switched off in the same transaction that creates it.

  The wallet must already EXIST on mainnet. A brand-new Stellar address cannot
  be paid into — the ledger refuses with op_no_account — so buy XLM on an
  exchange and withdraw it to a wallet, or send from an existing account.`);
    }
    funder = Keypair.fromSecret(seed);
    const h = new (await import("@stellar/stellar-sdk")).Horizon.Server("https://horizon.stellar.org");
    const acc: any = await h.loadAccount(funder.publicKey()).catch(() => null);
    if (!acc) bad(`the funding wallet ${funder.publicKey()} does not exist on mainnet. Send it some XLM first.`);
    const xlm = acc.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";
    // The vault's starting balance is locked partly as ledger reserve, and the
    // payee account costs 2 more. An XLM vault needs a working balance on top
    // of its reserve because it SPENDS XLM, so it costs more to open than a
    // token vault. Say the real number instead of a guess.
    const need = native ? 15 : 8;
    if (Number(xlm) < need) bad(`the funding wallet ${funder.publicKey()} has ${xlm} XLM and needs at least ${need}.
  an XLM vault locks 2.5 XLM of reserve but also has to hold spendable XLM, so it
  opens with 12; the payee account costs 2 more; fees are under 0.01.
  Send more XLM to ${funder.publicKey()} and re-run. Nothing was created.`);
    console.log(`funding wallet ${funder.publicKey()} — ${xlm} XLM`);
  }

  console.log("creating the 2-of-2 vault…");
  const vault = await StellarVault.create({
    network,
    issuer: funder,
    principal, approver, agent,
    tokenCode: code,
    // XLM has no issuer at all; USDC's issuer is Circle's account, which we
    // hold no key for. Only a custom token gets the funder as issuer.
    tokenIssuer: native ? undefined : (code === "USDC" ? USDC_ISSUER[network] : undefined),
    // mainnet: 2 base reserves + 3 signers + 1 trustline = 3 XLM locked, plus
    // room for one live mandate (0.5 XLM) and fees. 5 leaves a margin.
    // An XLM vault skips the trustline, so it needs 0.5 XLM less — but the
    // vault also *spends* XLM, so it needs a working balance, not just rent.
    startingBalance: mainnet ? (native ? "12" : "5") : undefined,
  });
  console.log("vault created. master key is off: it can never act alone again.");

  // A Stellar account must exist before it can be paid, and a payment cannot
  // create one — only createAccount can. And holding a token is not automatic:
  // the receiving account has to open a trustline first, or the payment fails
  // with OP_NO_TRUST. This is the single most common reason a first real
  // payment is rejected, so it happens here, once, at setup.
  if (mainnet) {
    console.log(`creating the payee account (2 XLM)${native ? "" : " and its " + code + " trustline"}…`);
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
  console.log(native
    ? "payee account ready. XLM needs no trustline — it can already be paid."
    : "payee account ready and trusted for " + code + ".");
  // A custom token has to be minted into the vault before it can pay anything.
  // XLM and USDC arrive from outside, so there is nothing to mint here.
  if (issuer) await vault.deposit(String(daily), issuer);

  const data = {
    createdAt: new Date().toISOString(),
    network,
    vault: vault.address,
    // XLM is stored with no issuer on purpose. A recorded issuer next to the
    // name "XLM" would describe a fake token that anyone could issue, and
    // parseToken() refuses that combination outright.
    token: { code, ...(native ? {} : { issuer: code === "USDC" ? USDC_ISSUER[network] : issuer!.publicKey() }) },
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

// --------------------------------------------------------------------- withdraw

/**
 * Take your money back out of the vault. This is a normal 2-of-2 payment:
 * principal (this laptop) + approver (your phone, or the laptop until you run
 * `approver --forget`). The agent key cannot do this — it has no path to an
 * arbitrary destination, which is the whole point of the vault.
 *
 * The XLM the vault pays in ledger rent stays locked while the account exists.
 * Closing the vault (not done here) returns that too.
 */
async function withdraw() {
  const { data } = loadVault();
  const to = arg("to");
  const amount = arg("amount");
  const all = flag("all");
  if (!to) bad(`where should it go?\n\n  paydlux withdraw --to G… [--all | --amount 8]\n\n  --to can be any Stellar account, including your Binance deposit address.`);

  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    {
      principal: pub(data.keys.principal),
      approver: data.keys.approver ? pub(data.keys.approver) : undefined,
      agent: pub(data.keys.agent),
    } as any,
    (data.network ?? "testnet") as Network,
  );

  if (data.token.code === "USDC") vault.useUsdc();
  const bal = await vault.balance();
  const want = all ? bal : amount;
  if (!want) bad(`say how much: --all, or --amount 8 (vault holds ${bal} ${data.token.code})`);
  if (Number(want) > Number(bal)) bad(`the vault holds ${bal} ${data.token.code}, not ${want}.`);

  const keys = data.keys ?? {};
  const principal = Keypair.fromSecret(keys.principal);
  const approver = keys.approver ? Keypair.fromSecret(keys.approver) : null;
  if (!approver) {
    console.log(`this laptop holds only one of the two keys, so the withdrawal needs your phone.
  open:  ${flag("tls") ? `https://${PUBLIC_HOST}` : "http://127.0.0.1:4022"}/?k=${data.desk?.portalKey ?? "…"}`);
    bad("then run this again — approvals from the phone land automatically.");
  }

  console.log(`sending ${want} ${data.token.code} from the vault to ${to} …`);
  const res = await vault.release(to, String(want), principal, approver, "paydlux withdraw");
  console.log(`done. tx ${res?.hash}`);
  console.log(`vault now holds ${await vault.balance()} ${data.token.code}`);
}

// ------------------------------------------------------------------------- main

const HELP = `paydlux — get paid by AI agents, with a human in the loop.

  paydlux setup [--mainnet] [--token USDC] [--fund-seed S…]
      create a vault. testnet by default (free, no wallet needed).
  paydlux sell  [--price 1] [--route /api/data] [--max N] [--daily N]
                [--split] [--tls] [--preauth]
      start the gateway and the approval desk.
      --max / --daily are your spending mandate: no single payment above --max,
      and nothing past --daily in a day. The desk refuses at the approve button,
      so a runaway agent cannot drain the vault even if you approve in error.
  paydlux status
      balances, signers, live mandates, ledger rent.
  paydlux approver [--forget]
      print the human half of the vault, then optionally delete it from this
      machine so only the phone can approve.
  paydlux withdraw --to G… [--all | --amount N]
      take your money back out of the vault. Needs both human keys; the agent
      key can never do this.

one file holds it all: ./paydlux-vault.json (0600, never commit it)
`;

export async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { console.log(HELP); return; }
  if (cmd === "setup") return setup();
  if (cmd === "sell") return sell();
  if (cmd === "status") return status();
  if (cmd === "approver") return approver();
  if (cmd === "withdraw") return withdraw();
  bad(`unknown command "${cmd}".\n\n${HELP}`);
}

// Run only when this file is the entry point, so importing it in a test is safe.
// Compare realpaths, not the invocation string: npm's bin launcher runs this as
// .../node_modules/.bin/paydlux, which does not end in .js, so a name-based test
// silently turns the published `paydlux` command into a no-op.
const invoked = process.argv[1]
  ? pathToFileURL(existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : process.argv[1]).href
  : undefined;
if (invoked === import.meta.url) {
  main().catch((e) => { console.error("failed:", (e as Error).message); process.exit(1); });
}
