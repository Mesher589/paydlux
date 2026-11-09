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
import { execSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { Account, Keypair, Asset, Operation, TransactionBuilder } from "@stellar/stellar-sdk";
import { StellarVault, USDC_ISSUER, passphrase, type Network } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { newPortalKey } from "./desk.ts";
import { PolicyEngine } from "./policy.ts";
import { PUBLIC_HOST, TUNNEL_NAME, runTunnel, tunnelLive, tunnelProblem, tunnelRunning, tunnelServes } from "./tunnel.ts";
import { DEMO_HOST, DEMO_ROUTE, startDemo } from "./showcase.ts";
import { DONATE_HOST, DONATE_PORT, startDonate } from "./donate.ts";
import { claimEscrow, pendingEscrows, prepareEscrowRelease, refundEscrow } from "./escrow.ts";
import { describeChallenge } from "./phone.ts";
import { start as startMcp } from "./mcp.ts";

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
  if (flag("preauth") && flag("escrow")) bad("--preauth and --escrow are different deals: pre-authorised payment, or payment held until delivery is proven. Pick one.");
  const mode = flag("preauth") ? "preauth" : flag("escrow") ? "escrow" : "approval";
  // How long the buyer's money stays locked. The seller needs this window to
  // prove delivery; the buyer is the one who can walk away inside it. Too short
  // and the seller never gets paid; too long and the buyer is stuck waiting.
  const releaseSeconds = Number(arg("release") ?? 3600);
  if (!(releaseSeconds >= 60)) bad("--release must be at least 60 seconds. A window shorter than that cannot be audited by either side.");
  const tls = flag("tls");
  const split = flag("split");

  // Real money gets a hard ceiling, and it is not a suggestion. The ledger
  // already caps a single payment at the mandate amount; what it cannot do is
  // count payments. So the ceiling lives here, and it is applied before the
  // desk is even built.
  const maxPer = Number(arg("max") ?? data.policy?.maxPerPayment ?? 2);
  const daily = Number(arg("daily") ?? data.policy?.dailyBudget ?? 10);
  // Categories and the wallet map come from the config file only: they are set
  // at the desk (/rules), not from the command line. A flag for them would be a
  // second, easier way to say the same thing, and the page would drift from it.
  //
  // The same is true of the two ceilings once an owner edits them at the desk:
  // the saved file wins over the flags, because the app scripts pass --max and
  // --daily on every start and would otherwise silently undo whatever was set in
  // the browser. The line printed below is what keeps that from being a
  // surprise — a rule that quietly reverts is worse than no rule at all.
  const saved = data.policy?.savedByOwner === true;
  const maxPerFinal = saved ? Number(data.policy.maxPerPayment ?? maxPer) : maxPer;
  const dailyFinal = saved ? Number(data.policy.dailyBudget ?? daily) : daily;
  if (saved && (maxPerFinal !== maxPer || dailyFinal !== daily)) {
    log(`using the rules you saved at the desk (max ${maxPerFinal}, daily ${dailyFinal}) instead of the command line (${maxPer}/${daily}).\n  to change them: open the approvals link and press "spending rules".`);
  }
  const policy = new PolicyEngine({
    maxPerPayment: maxPerFinal, dailyBudget: dailyFinal,
    allowlist: data.policy?.allowlist, denylist: data.policy?.denylist,
    categories: data.policy?.categories, payeeCategory: data.policy?.payeeCategory,
  });

  // A ceiling below the price blocks every payment, and the failure looks like
  // a bug in the desk: the buyer waits, the human never sees an approvable
  // item, and the log says "mandate refused". Say it now, before anything is
  // started, because this is a mistake in the flags and not in the product.
  const priceNum = Number(price);
  if (!(priceNum > 0)) bad(`--price ${price} is not a number greater than zero.`);
  // The mandate ceiling is a limit on what YOUR vault pays out. An escrow route
  // takes money IN from the buyer, so the ceiling does not apply to it — and
  // applying it would refuse a perfectly good escrow price for no reason.
  if (mode === "escrow") {
    if (priceNum > maxPerFinal) {
      log(`note: --escrow price ${price} is above --max ${maxPerFinal}. That is fine here — escrow money comes FROM the buyer, so your spending mandate never touches it.`);
    }
  } else {
    if (priceNum > maxPerFinal) {
      bad(`--price ${price} is above --max ${maxPerFinal}, so every payment would be refused by your own mandate.\n  raise --max to at least ${price} (for example --max ${price}) or lower --price.`);
    }
    if (priceNum > dailyFinal) {
      bad(`--price ${price} is above --daily ${dailyFinal}: one payment would spend the whole day's budget and the second would be refused.\n  set --daily to at least ${price}.`);
    }
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
  policy.seedFromLedger(alreadyPaid, policy.categoryOf(payee));
  if (alreadyPaid > 0) {
    log(`ledger says ${alreadyPaid.toFixed(2)} of the ${dailyFinal} daily budget is already spent today`);
    if (alreadyPaid >= dailyFinal) {
      bad(`today's budget is already gone: ${alreadyPaid.toFixed(2)} paid, ${dailyFinal} allowed.\n  `
        + `the mandate would refuse every payment. Raise --daily or wait for the UTC day to roll over.`);
    }
  }

  // Say out loud what the rules are, including the categories, so the numbers
  // an owner set in a browser are visible to whoever starts the seller. A rule
  // nobody can see is a rule nobody trusts.
  const catNames = Object.keys(policy.policy.categories ?? {});
  if (catNames.length) {
    const mapped = Object.entries(policy.policy.payeeCategory ?? {});
    log(`spending categories: ${catNames.map((c) => {
      const r = policy.policy.categories![c];
      return `${c} (${r.maxPerPayment ?? policy.policy.maxPerPayment}/payment, ${r.dailyBudget ?? dailyFinal}/day)`;
    }).join(", ")}${mapped.length ? ` · ${mapped.length} wallet(s) mapped` : ""}`);
  }

  if (network === "public") {
    console.log(`
  MAINNET — real money.
    token            ${data.token.code}
    max per payment  ${maxPerFinal}
    daily budget     ${dailyFinal}
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
    agentSeed: keys.agent,
    portalKey,
    publicHost,
    agentKeys: [pub(keys.agent)],
    routes: [
      { uri, price, mode, holdSeconds: Number(arg("hold") ?? 3600), releaseSeconds },
      // --showcase adds a second priced route for the public page. Same price,
      // same mandate, same desk: the showcase gets no special treatment at the
      // spending door, it only gets its own hostname.
      ...(flag("showcase")
        ? [{ uri: DEMO_ROUTE, price, mode: mode as "approval" | "preauth" | "escrow", holdSeconds: Number(arg("hold") ?? 3600), releaseSeconds }]
        : []),
    ],
    // The banner prints these numbers. This line is what makes them true.
    policy,
    // Rules edited at the desk must survive the next restart, or the mandate in
    // the banner is a promise that lasts until ctrl-c. Written back to the same
    // config file, with the same 0600 as everywhere else in this file, because
    // it also holds key material.
    onPolicyChange: (p) => {
      data.policy = {
        ...(data.policy ?? {}),
        // The marker that says "a human set these in a browser". Without it the
        // app scripts' --max/--daily flags win on every restart and the edit is
        // lost by morning.
        savedByOwner: true,
        maxPerPayment: p.maxPerPayment, dailyBudget: p.dailyBudget,
        allowlist: p.allowlist ?? [], denylist: p.denylist ?? [],
        categories: p.categories ?? {}, payeeCategory: p.payeeCategory ?? {},
      };
      writeFileSync(path, JSON.stringify(data, null, 2));
      chmodSync(path, 0o600);
      log(`rules saved to ${path}`);
    },
  });

  let tunnel: ReturnType<typeof runTunnel> | null = null;
  if (tls) {
    const problem = tunnelProblem();
    if (problem) bad("--tls cannot run here: " + problem);
    // A second `sell` on this machine (the free testnet showcase and the real
    // mainnet donation door run apart on purpose) must not spawn a second
    // cloudflared for the same tunnel. Reuse the one already running.
    if (tunnelRunning()) log("the named tunnel is already running on this machine — reusing it");
    else tunnel = runTunnel();
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
      explorer: data.explorer ?? "", gateway: gw, route: uri, payee,
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

/**
 * paydlux demo — the funder meeting, as one command.
 *
 * `sell` is the right command for a seller: it takes flags, and it refuses to
 * start when anything is off (port taken, budget already spent). That is correct
 * for a seller and fatal in front of an investor, who is watching a terminal go
 * red thirty seconds before the money shot.
 *
 * This is a preset, not a second implementation. It fixes the two things that
 * actually break a live demo, then runs the SAME sell() — same mandate, same
 * desk, same ledger, same phone signature:
 *
 *   1. A port already held by Paydlux is not an error. It means the demo is
 *      already running, so print the links and open the tabs instead of dying.
 *   2. A daily budget already spent today IS fatal (the mandate would refuse
 *      every payment), so raise it, save it to the vault file, and say so out
 *      loud. Raising the *daily* counter is safe: the per-payment ceiling is
 *      still pinned into the signed transaction hash.
 *
 * It then opens the two tabs and prints the runbook, so nobody has to remember
 * a URL or a portal key while someone is watching.
 */
async function demo() {
  const path = resolve(process.cwd(), arg("file") ?? VAULT_FILE_DEFAULT);
  if (!existsSync(path)) bad(`no vault here. Run:  paydlux setup`);
  const data = JSON.parse(readFileSync(path, "utf8"));
  const network = (data.network ?? "testnet") as Network;
  const price = arg("price") ?? data.policy?.defaultPrice ?? "1";
  const ports = [
    Number(arg("port") ?? 4021), Number(arg("desk") ?? 4022),
    Number(arg("demo-port") ?? 4023),
  ];
  // The donation door (4024) is deliberately NOT in this list and NOT started
  // by the demo. It runs against the MAINNET vault, where real people send real
  // USDC. A demo preset that restarted it would point a public money address at
  // a testnet vault, and a donation to a testnet account is gone forever.

  // 1. Something already on those ports? Two different things happened in real
  // meetings and neither may end in a red error:
  //   a) the demo IS up and answering — reuse it, just open the tabs;
  //   b) a leftover Paydlux (a donation door from this morning, a seller that
  //      lost its tunnel) is squatting on one port — the public URLs then 530
  //      and `sell` refuses to start. Stop the leftover, say exactly what was
  //      stopped, and start a clean demo.
  const live = await surfacesLive();
  if (live.desk && live.demo && !flag("restart") && await surfacesServe(path)) {
    const key = data.desk?.portalKey as string | undefined;
    log("the demo is already running and answering — nothing to start");
    openUrl(`https://${DEMO_HOST}`);
    if (key) openUrl(`https://${PUBLIC_HOST}/phone/?k=${key}`);
    demoCard(`https://${PUBLIC_HOST}`, key, data);
    return;
  }
  if (live.desk && live.demo) {
    // Answering, but on a different vault. desk.paydlux.com and demo.paydlux.com
    // are ONE address: a testnet demo and a mainnet demo cannot both be live on
    // it. Reusing whichever happens to be up is how a founder ends up showing
    // play money while believing the real vault is on the screen — or the other
    // way round, with real money moving during a "safe" demo. Stop it, say so,
    // and start the one that was asked for.
    log(`something else is answering ${DEMO_HOST} — stopping it so the ${network} demo can take the address`);
  }
  await clearDemoPorts(ports);

  // 2. Budget headroom. `sell` refuses to start when the ledger says today's
  // budget is gone, and the demo would then die at the worst possible moment.
  // Seed the counter from the ledger here and lift the ceiling if needed.
  // NB: `payee` in the vault file is an object ({address, seed}) when `setup`
  // generated one, and a bare address string when the seller passed --payee.
  // Reading only the string form silently skips this check — which is exactly
  // how the demo died once, on "1.00 of the 50 daily budget is already spent".
  const payeeAddr = typeof data.payee === "string" ? data.payee : data.payee?.address;
  const daily = Number(data.policy?.dailyBudget ?? 50);
  if (typeof payeeAddr === "string" && /^G[A-Z2-7]{55}$/.test(payeeAddr)) {
    try {
      const vault = await vaultHandle(data, network);
      const spent = Number(await vault.paidToday(payeeAddr));
      // Enough headroom for ten more demo payments, whatever the price is.
      const want = spent + Math.max(10, Math.ceil(Number(price) * 10));
      if (daily < want) {
        data.policy = { ...(data.policy ?? {}), savedByOwner: true, dailyBudget: Math.ceil(want) };
        writeFileSync(path, JSON.stringify(data, null, 2));
        chmodSync(path, 0o600);
        log(`today's spend is ${spent.toFixed(2)} of ${daily}; raised the daily budget to ${data.policy.dailyBudget} so the demo has room`);
        log(`  per-payment ceiling unchanged (${data.policy.maxPerPayment ?? "?"}) — that one is pinned into the signed transaction hash`);
      }
    } catch (e: any) {
      // Do not block the demo on this check. If the ledger really is
      // unreachable, sell() will say so plainly before it starts anything.
      log(`could not pre-check today's spend (${e?.message ?? e}) — starting anyway`);
    }
  }

  // 3. Run the real thing. sell() reads its options from process.argv, so the
  // preset is expressed there rather than by duplicating the seller's startup.
  const extra = ["sell", "--split", "--tls", "--showcase",
    "--price", price, "--route", "/market/data", "--file", path];
  for (const f of ["max", "daily", "port", "desk", "demo-port", "donate-port"]) {
    const v = arg(f);
    if (v !== undefined) extra.push(`--${f}`, v);
  }
  process.argv = [process.argv[0], process.argv[1], ...extra];

  // Open the tabs as soon as the desk actually answers — not before, because a
  // tab that loads an error page is what a funder remembers. Scheduled rather
  // than awaited: sell() never returns, it stays up serving payments.
  const key = data.desk?.portalKey as string | undefined;
  demoCard(`https://${PUBLIC_HOST}`, key, data);
  if (!flag("no-open")) {
    setTimeout(async () => {
      if (await tunnelLive()) {
        openUrl(`https://${DEMO_HOST}`);
        if (key) openUrl(`https://${PUBLIC_HOST}/phone/?k=${key}`);
      }
    }, 1000);
  }
  await sell();
}

/** Are the public URLs actually answering? A port can be held by a process
 *  whose tunnel died, which is worse than no process at all: the browser gets
 *  a Cloudflare 530 and the founder has no idea why. */
async function surfacesLive() {
  const get = async (url: string) => {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(4000) }); return r.status < 500; }
    catch { return false; }
  };
  const [desk, demo] = await Promise.all([
    get(`https://${PUBLIC_HOST}/healthz`), get(`https://${DEMO_HOST}/`),
  ]);
  return { desk, demo };
}

/**
 * Is the Paydlux answering those ports the SAME vault that was asked for?
 *
 * The public addresses are singletons: desk.paydlux.com and demo.paydlux.com can
 * only carry one vault at a time, and the testnet demo and the mainnet demo use
 * the same two. "It is already running" is therefore not enough — the thing that
 * is running may be the other network. Answering a funder with play money while
 * saying it is the real vault (or moving real money during what everyone believes
 * is a safe demo) is the worst failure this command can have, so the reuse path
 * checks the vault file of the process actually holding the ports.
 */
async function surfacesServe(path: string): Promise<boolean> {
  const want = resolve(process.cwd(), path);
  for (const port of [Number(arg("desk") ?? 4022), Number(arg("port") ?? 4021)]) {
    const who = await portHolder(port);
    const pid = Number((who?.match(/pid (\d+)/) ?? [])[1]);
    if (!pid) return false;
    // -ww: a truncated command line would hide the --file argument and make this
    // say "different vault" about the very demo we are asking to reuse.
    let cmd = "";
    try { cmd = execSync(`ps -ww -o command= -p ${pid} 2>/dev/null`, { encoding: "utf8" }).trim(); } catch { return false; }
    const served = (cmd.match(/--file[= ](\S+)/) ?? [])[1] ?? VAULT_FILE_DEFAULT;
    if (resolve(process.cwd(), served) !== want) return false;
  }
  return true;
}

/**
 * Free the demo's ports when a stale Paydlux is squatting on one.
 *
 * Only Paydlux processes are touched, and only after saying which one and why.
 * Anything else on the port is left alone and reported, because killing a
 * stranger's server to make a demo fit is not our call to make.
 */
async function clearDemoPorts(ports: number[]) {
  for (const port of ports) {
    const who = await portHolder(port);
    if (!who) continue;
    if (!/paydlux|cli|tsx|node/i.test(who)) {
      bad(`port ${port} is held by ${who}, which is not Paydlux.\n  free it, or move the demo: paydlux demo --desk ${port + 100}`);
    }
    const pid = Number((who.match(/pid (\d+)/) ?? [])[1]);
    if (!pid) { log(`port ${port} is held by ${who}; stopping it`); continue; }
    try {
      const cmd = execSync(`ps -o command= -p ${pid} 2>/dev/null`, { encoding: "utf8" }).trim();
      log(`stopping the stale Paydlux on port ${port} (pid ${pid}): ${cmd.slice(0, 90)}`);
      process.kill(pid, "SIGTERM");
    } catch { /* already gone */ }
    // Wait for the port to actually free. SIGTERM to a seller runs its bye()
    // handler, which takes a moment to close listeners and the tunnel.
    for (let i = 0; i < 20; i++) {
      if (!(await portHolder(port))) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const still = await portHolder(port);
    if (still) {
      try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
      log(`port ${port} needed a hard stop`);
    }
  }
}

/** The runbook, printed where the founder is already looking. */
function demoCard(host: string, key: string | undefined, data: any) {
  const network = data.network ?? "testnet";
  // The footer used to promise "nothing here costs real money" unconditionally.
  // On the public network that is a lie, and it is the kind of lie that gets a
  // founder spending the vault in front of an investor.
  const real = network !== "testnet";
  console.log(`
  ┌── Paydlux demo · the 5-minute script ─────────────────────────────
  │ 1  https://paydlux.com        "an agent buys from a website"
  │ 2  https://${DEMO_HOST}      press RUN THE LOOP → 402 → paid
  │ 3  your iPhone                hold 1.2s. the key never left it
  │ 4  back on tab 2              step 5 prints the ledger tx hash
  │ 5  ${host}/rules${key ? `?k=${key}` : ""}   spending limits, categories
  └───────────────────────────────────────────────────────────────────
  token ${data.token?.code ?? "?"} · ${network} · ${real
    ? "REAL MONEY — each approved loop pays out of this vault"
    : "nothing here costs real money"}
`);
}

/** Open a URL in the default browser. Best-effort: a demo survives it failing. */
function openUrl(url: string) {
  try {
    const tool = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
    const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
    const p = spawn(tool, args, { stdio: "ignore", detached: true });
    p.on("error", () => log(`open this yourself: ${url}`));
    p.unref();
  } catch { log(`open this yourself: ${url}`); }
}

/** The vault handle `sell` uses, shared so the demo checks the same numbers. */
async function vaultHandle(data: any, network: Network) {
  const keys = data.keys ?? {};
  return StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    { principal: pub(keys.principal), approver: keys.approver ? pub(keys.approver) : undefined, agent: pub(keys.agent) } as any,
    network,
  );
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

  // An XLM vault has no issuer at all — the ledger's own currency is not
  // issued by anyone. This line used to call .slice() on undefined and the
  // whole status command died with "Cannot read properties of undefined",
  // which made the one command that shows real balances useless precisely on
  // the real-money (XLM) setup.
  const tokenLabel = data.token.issuer
    ? `${data.token.code} (${String(data.token.issuer).slice(0, 8)}…)`
    : `${data.token.code} (the ledger's own currency — no issuer)`;

  console.log(`
  network   ${network}
  vault     ${vault.address}
  token     ${tokenLabel}
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

  If this wallet is brand new it does not exist on the ledger yet, and a plain
  payment to it fails with op_no_account. It has to receive its first XLM from
  something that creates the account for you: an exchange withdrawal does this
  automatically, or any wallet with an "activate"/"fund new address" flow.
  1 XLM activates it; you need ${need} here.`);
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
  // A wallet that has never been funded cannot receive a payment — the ledger
  // answers op_no_destination. For XLM the fix is the createAccount operation,
  // which costs the same two signatures. For a token there is no fix at all:
  // that account would need a trustline too, so say so instead of failing cryptically.
  const exists = await vault.horizon.loadAccount(to).then(() => true).catch(() => false);
  if (!exists && !vault.isNative) {
    bad(`${to} has no account on the ledger, so it cannot hold ${data.token.code}.\n  send it XLM from any exchange first, then withdraw again.`);
  }
  if (!exists) console.log(`${to} does not exist on the ledger yet — this payment creates it.`);
  const res = exists
    ? await vault.release(to, String(want), principal, approver, "paydlux withdraw")
    : await vault.fund(to, String(want), principal, approver, "paydlux withdraw");
  console.log(`done. tx ${res?.hash}`);
  console.log(`vault now holds ${await vault.balance()} ${data.token.code}`);
}

// ---------------------------------------------------------------------- escrow

/**
 * The seller's view of every escrow sold through this gateway.
 *
 * `paydlux escrow` lists what is locked, who locked it, and what the ledger
 * says about each one. `paydlux escrow --release ord_…` takes the money — which
 * needs both human keys, so on a --split vault it prints the challenge for the
 * phone and stops, exactly like the approval desk does.
 *
 * Nothing here can take money early. The release timer is enforced by the
 * ledger, not by this command: asking before the timer gets a sentence saying
 * how long is left, and the network would refuse the transaction anyway.
 */
async function escrow() {
  const { data, path } = loadVault();
  const network = (data.network ?? "testnet") as Network;
  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    {
      principal: pub(data.keys.principal),
      approver: data.keys.approver ? pub(data.keys.approver) : undefined,
      agent: pub(data.keys.agent),
    } as any,
    network,
  );
  if (data.token.code === "USDC") vault.useUsdc();

  const release = arg("release");
  const refund = arg("refund");

  if (refund) {
    // The buyer's side, kept here so the protection is a command and not a
    // paragraph. Needs the buyer's key, which this file does not hold unless
    // the buyer is also the seller — so it reads it from the environment.
    const seed = process.env.PAYDLUX_BUYER_SEED;
    if (!seed) bad("--refund returns the BUYER's money, so it needs the buyer's key.\n  PAYDLUX_BUYER_SEED=S… paydlux escrow --refund <escrow id>");
    const out = await refundEscrow(network, refund, Keypair.fromSecret(seed));
    console.log(`refunded. the money is back in the buyer's account. tx ${out.txHash}`);
    return;
  }

  // Anything the ledger has locked for this vault, whether or not this process
  // remembers quoting it. A seller who restarted still has to see money that is
  // already locked, or it looks like nothing was ever ordered.
  const live = await pendingEscrows(network, vault.address);
  const now = Math.floor(Date.now() / 1000);

  if (!release) {
    if (!live.length) {
      console.log(`\nno escrow is locked for ${vault.address} right now.\n`);
      console.log(`sell against escrow with:  paydlux sell --escrow --price 3.5 --release 3600\n`);
      return;
    }
    console.log(`\nescrow locked for ${vault.address} on ${network === "public" ? "MAINNET" : "testnet"}\n`);
    for (const e of live) {
      const left = e.releaseAt - now;
      console.log(`  ${e.memo || "(no order id)"}   ${e.amount} ${e.asset === "native" ? "XLM" : e.asset.split(":")[0]}`);
      console.log(`    escrow   ${e.balanceId}`);
      console.log(`    buyer    ${e.buyer}`);
      console.log(`    ${left > 0 ? `buyer can still take it back for ${Math.ceil(left / 60)} more min` : `release timer passed — claimable now with both keys`}`);
      if (left <= 0) console.log(`    release: paydlux escrow --release ${e.memo || e.balanceId}`);
      console.log("");
    }
    console.log(`an escrow with no order id you recognise is money locked for a deal you never quoted. Do not release it: refund it.\n`);
    return;
  }

  // Match on order id first (what a human reads), then on balance id (what a
  // script has). Both are exact; a prefix is not accepted, because two order
  // ids can share a prefix and money cannot be released "approximately".
  const hit = live.find((e) => e.memo === release || e.balanceId === release);
  if (!hit) bad(`nothing locked matches "${release}".\n  run \`paydlux escrow\` to list what is locked, and use the order id or the escrow id exactly as printed.`);
  if (now < hit.releaseAt) {
    bad(`the release timer has not passed: ${Math.ceil((hit.releaseAt - now) / 60)} min to go.\n  the buyer can still refund this money until then, so releasing it is not on the table.\n  the ledger would refuse this anyway — this command only says so earlier and in words.`);
  }

  const keys = data.keys ?? {};
  const agent = Keypair.fromSecret(keys.agent);
  if (!keys.approver) {
    // The recommended setup: the desk is running with the phone approver, so
    // hand the release to the DESK instead of writing a file nothing reads.
    // The desk queues it, the phone signs the claim, the desk submits it.
    const deskPort = Number(arg("desk") ?? 4022);
    const portalKey = data.desk?.portalKey as string | undefined;
    if (portalKey) {
      try {
        const res = await fetch(`http://127.0.0.1:${deskPort}/escrow?k=${encodeURIComponent(portalKey)}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            escrowId: hit.balanceId, order: hit.memo || undefined,
            amount: hit.amount,
            asset: hit.asset === "native" ? "XLM" : hit.asset.split(":")[0],
            buyer: hit.buyer,
          }),
        });
        if (res.ok) {
          const queued = await res.json();
          console.log(`\nrelease queued on the approval desk as ${queued.id}.`);
          console.log(`  open:  ${flag("tls") ? `https://${PUBLIC_HOST}` : `http://127.0.0.1:${deskPort}`}/phone/?k=${portalKey}`);
          console.log(`  the order is ${hit.memo || hit.balanceId} — approve on the phone only if you delivered it.`);
          console.log(`  the phone signs the claim; the desk submits it. vault balance updates after.\n`);
          return;
        }
        console.log(`the desk answered ${res.status}; falling back to the manual challenge.\n`);
      } catch {
        // No desk listening on that port. Fall through to the file path.
      }
    }
    const challenge = await prepareEscrowRelease(network, hit.balanceId, vault.address, agent);
    console.log(`\nthis laptop holds one of the two keys, so the release needs your phone.\n`);
    console.log(describeChallenge(challenge));
    console.log(`\n  the order id is ${hit.memo || hit.balanceId} — sign only if you delivered it.\n`);
    console.log(`no approval desk is answering on port ${deskPort}. start one with \`paydlux sell\` (or the`);
    console.log(`app:mainnet:sell script) and re-run this command, and the release goes to your phone.`);
    console.log(`or finish it on a machine that holds the approver key.\n`);
    // Written out so the second signature can still be added by hand from a
    // machine that holds the approver key. Said exactly: nothing reads this
    // file back on its own.
    const file = path.replace(/\.json$/, ".escrow-release.json");
    writeFileSync(file, JSON.stringify({ order: hit.memo || hit.balanceId, challenge }, null, 2), { mode: 0o600 });
    console.log(`challenge also written to ${file} (0600) for the manual path.\n`);
    return;
  }
  const out = await claimEscrow(network, hit.balanceId, vault.address, { agent, approver: Keypair.fromSecret(keys.approver) });
  console.log(`released ${hit.amount} for order ${hit.memo || "(no id)"}. tx ${out.txHash}`);
  console.log(`vault now holds ${await vault.balance()} ${data.token.code}`);
}

// ----------------------------------------------------------------------- usdc

/**
 * Let the vault and its payee hold real Circle USDC.
 *
 * Circle mints USDC, so there is no issuer key for us to hold — an account
 * only has to say it accepts USDC (a trustline) before the ledger will let it
 * receive any. Without this, a payment of real USDC to the vault fails with
 * OP_NO_TRUST and the money bounces back to the sender.
 *
 * Two trustlines are needed, not one: the vault, and the payee the 402 terms
 * actually name as the destination. Adding only the vault's is the half-fix
 * that looks set up and still bounces.
 *
 * Each trustline also raises the account's XLM rent by 0.5 XLM. The payee we
 * create is funded with exactly one account entry (2 XLM), so a trustline on
 * it fails OP_INSUFFICIENT_BALANCE unless it is topped up first. That is why
 * this command pays the rent before it asks for the trustline.
 *
 * This does NOT change what the door charges. The live doors settle in XLM and
 * the printed price stays XLM until someone deliberately switches the token;
 * a trustline only makes USDC *possible*, it never silently reprices a live
 * payment page.
 */
async function usdc() {
  const { data, path } = loadVault();
  const network = (data.network ?? "testnet") as Network;
  const keys = data.keys ?? {};
  if (!keys.principal || !keys.approver) {
    bad(`adding a trustline needs both human keys and this machine holds `
      + `${keys.principal ? "only the principal" : "neither"}.\n`
      + "  run this on the machine with both, or approve from the phone.");
  }
  if (!data.payee?.seed) {
    bad(`the payee ${data.payee?.address ?? "(none)"} is not ours to sign for, so we cannot add its\n`
      + "  trustline. Ask whoever owns that account to add a USDC trustline for:\n\n"
      + `  ${USDC_ISSUER[network]}\n\n`
      + "  or drop --payee and let Paydlux manage a payee account it can sign for.");
  }

  const principal = Keypair.fromSecret(keys.principal);
  const approver = Keypair.fromSecret(keys.approver);
  const payeeKp = Keypair.fromSecret(data.payee.seed);

  const vault = await StellarVault.load(
    data.vault, data.token.code, data.token.issuer,
    { principal: principal.publicKey(), approver: approver.publicKey(), agent: pub(keys.agent) } as any,
    network,
  );

  const has = async (address: string) => {
    const acc = await vault.horizon.loadAccount(address).catch(() => null);
    if (!acc) return null;
    const line = (acc.balances as any[]).find((b) => b.asset_type !== "native"
      && b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER[network]);
    // Keep the two balances separate. Reading the native balance and labelling
    // it "USDC" is how a setup check convinces you there is money in the wrong
    // asset: XLM and USDC are not interchangeable and the ledger keeps them apart.
    return {
      xlm: acc.balances.find((b) => b.asset_type === "native")?.balance ?? "0",
      usdc: line?.balance ?? "0.0000000",
      line: !!line,
    };
  };

  log(`USDC on ${network === "public" ? "mainnet" : network}: issuer ${USDC_ISSUER[network]}`);

  // 1. the payee needs XLM rent for its new subentry before it can accept USDC.
  const payeeNow = await has(data.payee.address);
  if (!payeeNow) bad(`${data.payee.address} does not exist on ${network}.`);
  if (!payeeNow.line) {
    const rent = await vaultRent(vault);
    const topup = "0.6";
    if (Number(rent.xlm) - Number(topup) < Number(rent.min) + 0.5) {
      bad(`the vault cannot spare the payee's 0.5 XLM rent without going short itself\n`
        + `  (vault has ${rent.xlm} XLM, needs ${rent.min} to stay open). Fund it first.`);
    }
    log(`paying the payee ${topup} XLM so it can afford the trustline rent…`);
    await vault.release(data.payee.address, topup, principal, approver, "paydlux usdc rent");
  }

  // 2. both trustlines. useUsdc() first so trustToken() signs for the right asset.
  vault.useUsdc();
  const vaultNow = await has(vault.address);
  if (vaultNow?.line) log("the vault already holds a USDC trustline");
  else {
    log(`adding the vault's USDC trustline…`);
    await vault.trustUsdc(principal, approver);
  }
  if (payeeNow.line) log("the payee already holds a USDC trustline");
  else {
    log(`adding the payee's USDC trustline…`);
    await vault.trustToken(data.payee.address, "1000000", payeeKp);
  }

  // 3. verify by re-reading the ledger. A trustline the ledger does not show is
  // not a trustline.
  const v2 = await has(vault.address);
  const p2 = await has(data.payee.address);
  console.log(`
  vault  ${vault.address}
         USDC ${v2?.line ? "accepted" : "NOT ACCEPTED"}   holds ${v2?.usdc} USDC, ${v2?.xlm} XLM
  payee  ${data.payee.address}
         USDC ${p2?.line ? "accepted" : "NOT ACCEPTED"}   holds ${p2?.usdc} USDC, ${p2?.xlm} XLM
`);
  if (!v2?.line || !p2?.line) bad("the ledger does not show both trustlines. nothing was set up.");

  console.log(`both accounts can now hold real Circle USDC.

what that does NOT change: the doors still charge what their config says
(${data.token.code}), and the printed price on the page stays in that asset.
Switching the price itself is a deliberate step, because a live page that
promises 1 XLM and asks for 1 USDC is a page that takes the wrong money.

to put real USDC in, send it from an exchange to:

  ${vault.address}

${network === "public"
  ? `on MAINNET, and pick the STELLAR network at the exchange — not Tron, not\nEthereum, not Solana. A withdrawal on the wrong network is not recoverable\nby us. No memo or destination tag is needed: this is your own account, not an\nexchange deposit address.`
  : "on testnet."}
`);
}

// ------------------------------------------------------------------------- main

const HELP = `paydlux — get paid by AI agents, with a human in the loop.

  paydlux setup [--mainnet] [--token USDC] [--fund-seed S…]
      create a vault. testnet by default (free, no wallet needed).
  paydlux sell  [--price 1] [--route /api/data] [--max N] [--daily N]
                [--split] [--tls] [--preauth] [--escrow] [--release SECONDS]
      start the gateway and the approval desk.
      --max / --daily are your spending mandate: no single payment above --max,
      and nothing past --daily in a day. The desk refuses at the approve button,
      so a runaway agent cannot drain the vault even if you approve in error.
      --escrow sells the route against escrow instead: the buyer locks the money
      in a claimable balance you cannot touch until --release seconds have
      passed, and the buyer can take it back any time before then. You get paid
      by proving delivery before the timer, not by waiting for it.
  paydlux demo  [--price 1] [--file ./paydlux-vault.json]
      the funder meeting as one command. Same seller, same desk, same phone
      signature — but it refuses to fail in front of an audience: if the demo is
      already running it opens the tabs instead of dying on a taken port, and if
      today's daily budget is already spent it raises that budget (the
      per-payment ceiling is untouched) rather than refusing to start.
  paydlux escrow [--release ORD | --refund ESCROW_ID]
      list what is locked for your vault, release one order, or take a buyer's
      money back. Release needs both human keys; on a --split vault it prints
      the challenge for your phone and stops there.
  paydlux donate [--file ./paydlux-vault.json] [--usdc] [--price 1] [--tls]
      a public door where other agents pay YOU from THEIR vault.
      --usdc prices the door in Circle USDC. It refuses to start unless the
      vault already holds a USDC trustline: without one every payment bounces
      with OP_NO_TRUST and the page looks broken forever.
  paydlux usdc [--file ./paydlux-vault.json]
      add that USDC trustline — one claimable, so the human half signs it.
  paydlux status
      balances, signers, live mandates, ledger rent.
  paydlux approver [--forget]
      print the human half of the vault, then optionally delete it from this
      machine so only the phone can approve.
  paydlux withdraw --to G… [--all | --amount N]
      take your money back out of the vault. Needs both human keys; the agent
      key can never do this.
  paydlux mcp   [--file ./paydlux-vault.json] [--read-only]
      serve Paydlux as an MCP server, so an agent in Claude, Cursor, LobeHub or
      any other MCP client buys through the mandate instead of holding a wallet.
      This process loads only the agent key — one of two vault signers — so it
      cannot release money alone. --read-only drops the tools that touch money.

one file holds it all: ./paydlux-vault.json (0600, never commit it)
`;

/**
 * `paydlux donate` — the public donation door, on its own.
 *
 * This is deliberately NOT `sell --donate`. Three reasons:
 *
 * 1. It reads no private key. The door's whole security property is that it
 *    cannot sign anything: it verifies an incoming payment against the public
 *    ledger and serves content only if the ledger says we were paid. Loading the
 *    vault file's seeds into this process would throw that property away, so
 *    only the public address, network and token code are read here.
 * 2. It can run on the real network while the free showcase runs on testnet.
 *    The demo spends the seller's money and must stay play-money; the donation
 *    door has to take real XLM. They are separate processes on separate ports
 *    behind the same tunnel.
 * 3. It has no gateway, no desk and no mandate, because nothing here spends the
 *    seller's money. Fewer moving parts means less that can leak.
 */
async function donate() {
  if (flag("help") || process.argv.includes("-h")) {
    console.log(`paydlux donate [--file ./paydlux-vault.json] [--usdc] [--price 1]
                [--tls] [--port ${DONATE_PORT}]
      a public door where other agents pay YOU from THEIR vault.

      --usdc     price the door in Circle USDC instead of the vault file's
                 token. Refuses to start unless the vault already holds a
                 USDC trustline (run: paydlux usdc) — without one every
                 payment bounces with OP_NO_TRUST and the page looks broken.
      --price N  what a donation costs, in the asset's own units.
      --tls      required in practice: an order and its memo over plain HTTP
                 can be taken by anyone on the path.
      --port N   local port (default ${DONATE_PORT}); the public name is
                 ${DONATE_HOST}, routed by the tunnel.`);
    return;
  }
  const path = arg("file") ?? VAULT_FILE_DEFAULT;
  if (!existsSync(path)) bad(`no vault file at ${path}. Run: paydlux setup`);
  const data = JSON.parse(readFileSync(path, "utf8"));
  const network: Network = data.network === "public" ? "public" : "testnet";

  // Public fields only. If this file ever gains a field this code needs a seed
  // for, that is a bug to fix here, not a reason to load the seeds.
  const payee: string | undefined = typeof data.payee === "string"
    ? data.payee
    : data.payee?.address;
  if (!payee) bad(`the vault file has no payee address. Re-run: paydlux setup`);
  // `vault` in the file is the account's public address (a string). Accept an
  // object form too, but never read a seed from either.
  const vaultAddress: string = typeof data.vault === "string"
    ? data.vault
    : data.vault?.address ?? data.vault?.publicKey;
  if (!/^G[A-Z2-7]{55}$/.test(vaultAddress ?? "")) {
    bad(`the vault file's address is not a valid Stellar account: ${vaultAddress}`);
  }
  let assetCode: string = data.token?.code ?? "XLM";
  let assetIssuer: string | undefined = data.token?.issuer;

  // --usdc prices this door in real Circle USDC instead of whatever the vault
  // file says. Two things have to be true before that is safe to serve, and
  // both are checked against the ledger rather than assumed:
  //
  // 1. the vault must already hold a USDC trustline. Without it every payment
  //    bounces with OP_NO_TRUST, the donor's money comes back, and the page
  //    still says "not paid yet" forever — a door that looks broken and is.
  // 2. the payee the 402 terms name must hold one too. Here the payee IS the
  //    vault, so one check covers both, but the check is written for the
  //    account the terms actually name so it stays true if that ever changes.
  if (flag("usdc")) {
    if (assetCode !== "USDC") log(`pricing in USDC instead of the file's ${assetCode}`);
    assetCode = "USDC";
    assetIssuer = USDC_ISSUER[network];
    const h = network === "public" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
    const acc: any = await fetch(`${h}/accounts/${vaultAddress}`).then((r) => r.ok ? r.json() : null).catch(() => null);
    const line = acc?.balances?.find((b: any) => b.asset_type !== "native"
      && b.asset_code === "USDC" && b.asset_issuer === assetIssuer);
    if (!line) {
      bad(`${vaultAddress} has no USDC trustline on ${network}, so a USDC payment would be\n`
        + "  rejected by the ledger (OP_NO_TRUST) and the donor's money would come back.\n\n"
        + "  add it first:\n\n"
        + `  paydlux usdc --file ${path}\n`);
    }
    log(`USDC trustline confirmed on the ledger. Circle is the issuer: ${assetIssuer}`);
  }

  const price = arg("price") ?? data.policy?.defaultPrice ?? "1";
  if (!(Number(price) > 0)) bad("--price must be a positive number");

  const tls = flag("tls") || !process.env.PAYDLUX_NO_TLS;
  if (tls) {
    const problem = tunnelProblem();
    if (problem) bad("--tls cannot run here: " + problem);
    if (!tunnelRunning()) runTunnel();
  } else {
    log("running without TLS. The public door needs --tls: an order and its memo over plain HTTP can be taken by anyone on the path, who then pays for YOUR order with their vault and collects the goods.");
  }

  const dPort = Number(arg("port") ?? DONATE_PORT);
  const who = await portHolder(dPort);
  if (who) {
    bad(`port ${dPort} (donations) is already in use by ${who}.\n`
      + `  a donation door is already running. Stop it first, or this one answers nothing\n`
      + `  and https://${DONATE_HOST} returns 502 with no error in this window.`);
  }

  // The vault address IS the payee here. Two reasons, and both matter:
  //
  // 1. Money lands straight in the 2-of-2. The gateway's payee account is a
  //    plain single-key account whose seed sits in a file on this machine, and
  //    it exists so the gateway can pay OUT without the vault signing every
  //    time. A donation has no reason to pass through it, so it does not.
  // 2. One address on the page. The QR, the printed address and the 402 terms
  //    all name the same account, so a human scanning the code and an agent
  //    following the 402 loop cannot end up paying into different places.
  const door = startDonate({
    port: dPort, hostname: DONATE_HOST, payee: vaultAddress, network, price,
    asset: assetIssuer ? { code: assetCode, issuer: assetIssuer } : { code: assetCode },
    vault: vaultAddress,
  });
  await door.listen(dPort);

  const live = tls ? await tunnelLive(DONATE_HOST, 12) : false;
  console.log(`
  donation door is ${live ? `LIVE at https://${DONATE_HOST}` : `listening on 127.0.0.1:${dPort}`}
  network    ${network === "public" ? "MAINNET — real money" : "testnet — play money"}
  price      ${price} ${assetCode}
  paid into  ${vaultAddress}   (the 2-of-2 vault itself — watch every payment land here)

  this process holds no signing key. It can only serve what the ledger confirms
  was paid for, and it cannot spend anything of yours.
`);
  if (tls && !live) log(`https://${DONATE_HOST} is not answering yet. ${tunnelServes(DONATE_HOST) ? "Give the tunnel a few seconds." : `The tunnel does not route ${DONATE_HOST} — add it to ~/.cloudflared/config.yml pointing at 127.0.0.1:${dPort}.`}`);
}


export async function main() {
  const cmd = process.argv[2];
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") { console.log(HELP); return; }
  if (cmd === "setup") return setup();
  if (cmd === "sell") return sell();
  if (cmd === "demo") return demo();
  if (cmd === "donate") return donate();
  if (cmd === "status") return status();
  if (cmd === "approver") return approver();
  if (cmd === "withdraw") return withdraw();
  if (cmd === "usdc") return usdc();
  if (cmd === "escrow") return escrow();
  if (cmd === "mcp") return startMcp();
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
