// Story mode: sets up a vault + seller, parks one approval request, and stays
// up so the human approval can be done in a real browser (for the demo clip).
//
//   npx tsx stellar/story.ts                    local only: http://127.0.0.1:4022/
//   npx tsx stellar/story.ts --public           throwaway trycloudflare.com link
//   npx tsx stellar/story.ts --tls              https://desk.paydlux.com (named tunnel)
//   add --split to keep the approver key off this machine
//
// --public matters: the portal has no login, so the URL *is* the credential.
// Without a key, anyone who finds the tunnel can approve a payment. With one,
// the link is 22 random characters and a wrong guess gets a 403.
//
// --tls is the one to use for anything real. A trycloudflare.com hostname is
// random and disposable: nothing tells the human they reached *your* desk, and
// there is no HSTS to fall back on. desk.paydlux.com is a named Cloudflare
// tunnel on the same free tier, so the browser can verify where it is going.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { PaydluxAgent } from "./agent.ts";
import { newPortalKey } from "./desk.ts";
import { deskKeys, ensurePayee, VAULT_FILE_DEFAULT } from "./cli.ts";
import { PUBLIC_HOST, runTunnel, tunnelLive, tunnelProblem } from "./tunnel.ts";

const GATEWAY_PORT = 4021, DESK_PORT = 4022;
const PUBLIC = process.argv.includes("--public");
const TLS = process.argv.includes("--tls");
const SPLIT = process.argv.includes("--split");
const FRESH = process.argv.includes("--fresh");
const log = (...a: unknown[]) => console.log("•", ...a);

/**
 * Two ways to get a vault for a demo run.
 *
 * Default: reuse ./paydlux-vault.json. This is the difference between a demo and
 * a product. A run that mints a new vault every boot hands out a new approver
 * key every time, so the key already saved on the phone is stale and the ledger
 * answers BAD_AUTH to a perfectly valid signature — which the app can only
 * report as "failed". Reusing the file means the phone enrolment survives, the
 * portal link survives, and money stays where you put it.
 *
 * --fresh: mint throwaway keys, for a clip where nothing should persist.
 */
async function vaultForRun() {
  const file = resolve(process.cwd(), VAULT_FILE_DEFAULT);
  if (!FRESH && existsSync(file)) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    const network = (data.network ?? "testnet") as "testnet" | "public";
    const pub = (seed: string) => Keypair.fromSecret(seed).publicKey();
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
    const payee = await ensurePayee(file, data, vault);
    log(`reusing the vault in ${VAULT_FILE_DEFAULT} — your phone key stays valid`);
    return {
      persistent: true, file, data, vault, network, payee,
      principalSeed: data.keys.principal as string,
      agentSeed: data.keys.agent as string,
      approverSeed: data.keys.approver as string | undefined,
      portalKey: deskKeys(file, data),
    };
  }

  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "USDC",
  });
  await vault.trustToken(seller.publicKey(), "1000", seller);
  await vault.deposit("50", issuer);
  log("vault", vault.address, "balance", await vault.balance());
  return {
    persistent: false, file, data: null, vault, network: "testnet" as const, payee: seller.publicKey(),
    principalSeed: principal.secret(), agentSeed: agent.secret(), approverSeed: approver.secret(),
    // Any path that puts the desk on a public URL needs the key. --tls is public
    // by definition, so forgetting --public must not silently remove the gate.
    // --key lets a test drive the public desk with a key it already knows.
    portalKey: (PUBLIC || TLS)
      ? (process.argv.includes("--key") ? process.argv[process.argv.indexOf("--key") + 1] : newPortalKey())
      : undefined,
  };
}

const main = async () => {
  // Preflight before anything is funded. Funding testnet accounts takes ~30s and
  // prints a portal link; if the tunnel then fails to start, that link and the
  // approver seed are already on screen pointing at nothing, and the human has
  // no way to tell the run died. Fail first, explain what is missing.
  if (TLS) {
    const problem = tunnelProblem();
    if (problem) { console.log("\n--tls cannot run here: " + problem); process.exit(1); }
  }

  const run = await vaultForRun();
  const { vault, network, payee, portalKey } = run;

  const gw = new Gateway({
    vault, network, payee, deskPort: DESK_PORT,
    principal: run.principalSeed,
    // --split is the honest demo: the approver key is printed for the phone and
    // never given to this process. Without it the laptop holds both halves, and
    // "2 of 2" is really 1 of 1.
    // If the approver key is not on this machine, split is not a choice — it is
    // the only thing that can work. Saying so here beats a BAD_AUTH later.
    approver: (SPLIT || !run.approverSeed) ? undefined : run.approverSeed,
    split: SPLIT || !run.approverSeed,
    portalKey,
    // In --tls mode the desk only answers for the tunnel hostname, so a direct
    // hit on the loopback port cannot drive it.
    publicHost: TLS ? PUBLIC_HOST : undefined,
    routes: [{ uri: "/market/data", price: "4.50", mode: "approval", holdSeconds: 3600 }],
    // A demo that expires while the human is still reading the email is a demo
    // that failed. 30 minutes is a workday courtesy; the deadline is shown in
    // the app either way.
    decideWithinSeconds: 3600,
  });
  gw.agentKeys = [Keypair.fromSecret(run.agentSeed).publicKey()];
  await gw.listen(GATEWAY_PORT, (u) => `{"ok":true,"data":"market snapshot","served_by":"${u}"}`);
  await gw.desk.listen(DESK_PORT);

  const buyer = new PaydluxAgent({ agentKey: run.agentSeed });
  const ask = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/market/data`);
  log("agent parked", ask.handle, "— waiting for a human");
  log("seller balance before:", await vault.balance(payee));

  // Bring the public path up BEFORE printing anything a human would act on.
  // Printing the portal link and the approver seed first means a failed run
  // leaves a live-looking link and a real secret on screen pointing at nothing.
  if (TLS) {
    const t = runTunnel();
    log("opening https://" + PUBLIC_HOST + " ...");
    if (!(await tunnelLive())) {
      // Report the actual reason rather than a guess. A silent timeout here is
      // how a broken config.yml or a missing DNS route gets blamed on the code.
      console.log("\nthe tunnel did not answer on https://" + PUBLIC_HOST + ".");
      if (t.lastError()) console.log("cloudflared said: " + t.lastError());
      console.log("check ~/.cloudflared/config.yml (service: http://127.0.0.1:" + DESK_PORT +
        ") and that the DNS route exists:");
      console.log("  cloudflared tunnel route dns paydlux-desk " + PUBLIC_HOST);
      process.exit(1);
    }
    log("TLS verified on https://" + PUBLIC_HOST);
  } else if (PUBLIC) tunnel(portalKey!);

  // In --tls mode the desk pins its Host header, so the loopback URL is refused
  // on purpose: the only way in is the tunnel. Print the link the human will
  // actually use, not one that 403s.
  const host = TLS ? `https://${PUBLIC_HOST}` : `http://127.0.0.1:${DESK_PORT}`;
  console.log("\nPORTAL  " + host + "/" + (portalKey ? `?k=${portalKey}` : ""));
  if (SPLIT) {
    console.log("\nAPPROVER APP  " + host + "/phone/" +
      (portalKey ? `?k=${portalKey}` : ""));
    // A persistent vault has already been enrolled on the phone. Printing a seed
    // again invites a re-enrolment and reads like a secret that must be copied,
    // so only say what to do.
    if (run.persistent) {
      console.log("  this vault is already enrolled on your phone — open the link and tap Review.");
      if (!run.approverSeed) console.log("  (this machine holds only one of the two keys, as intended)");
    } else {
      console.log("  approver seed for that device ONLY (this process never sees it):");
      console.log("  " + run.approverSeed);
      console.log("  keep it off this machine. Re-run without --split to skip the phone.");
    }
  }
  console.log("\nSTORY READY — click Approve in the browser, then ctrl-c to stop.");
};

/** Free throwaway tunnel. Prints the public link once Cloudflare assigns it. */
function tunnel(portalKey: string) {
  const cf = spawn("cloudflared", ["tunnel", "--url", `http://127.0.0.1:${DESK_PORT}`],
    { stdio: ["ignore", "pipe", "pipe"] });
  let shown = false;
  const grab = (buf: Buffer) => {
    const m = buf.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !shown) {
      shown = true;
      console.log("\nPUBLIC  " + m[0] + `/?k=${portalKey}`);
      console.log("          (stop with ctrl-c — the link dies with this process)");
    }
  };
  cf.stdout.on("data", grab);
  cf.stderr.on("data", grab);
  cf.on("exit", () => console.log("[tunnel] closed"));

  // An orphaned cloudflared is a public approval desk with nobody watching it.
  // Kill the child on every exit path, including ctrl-c and SIGTERM.
  const close = () => { if (!cf.killed) cf.kill("SIGTERM"); };
  process.on("exit", close);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { close(); process.exit(0); });
  }
}

main().catch((e) => console.error("FAIL:", (e as Error).message));
