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
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { PaydluxAgent } from "./agent.ts";
import { newPortalKey } from "./desk.ts";
import { PUBLIC_HOST, runTunnel, tunnelLive, tunnelReady } from "./tunnel.ts";

const GATEWAY_PORT = 4021, DESK_PORT = 4022;
const PUBLIC = process.argv.includes("--public");
const TLS = process.argv.includes("--tls");
const SPLIT = process.argv.includes("--split");
const log = (...a: unknown[]) => console.log("•", ...a);

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "USDC",
  });
  await vault.trustToken(seller.publicKey(), "1000", seller);
  await vault.deposit("50", issuer);
  log("vault", vault.address, "balance", await vault.balance());

  // Any path that puts the desk on a public URL needs the key. --tls is public
  // by definition, so forgetting --public must not silently remove the gate.
  // Any path that puts the desk on a public URL needs the key. --tls is public
  // by definition, so forgetting --public must not silently remove the gate.
  // --key lets a test drive the public desk with a key it already knows.
  const keyAt = process.argv.indexOf("--key");
  const portalKey = (PUBLIC || TLS)
    ? (keyAt > -1 ? process.argv[keyAt + 1] : newPortalKey())
    : undefined;
  const gw = new Gateway({
    vault, network: "testnet", payee: seller.publicKey(), deskPort: DESK_PORT,
    principal: principal.secret(),
    // --split is the honest demo: the approver key is printed for the phone and
    // never given to this process. Without it the laptop holds both halves, and
    // "2 of 2" is really 1 of 1.
    approver: SPLIT ? undefined : approver.secret(),
    split: SPLIT,
    portalKey,
    // In --tls mode the desk only answers for the tunnel hostname, so a direct
    // hit on the loopback port cannot drive it.
    publicHost: TLS ? PUBLIC_HOST : undefined,
    routes: [{ uri: "/market/data", price: "4.50", mode: "approval", holdSeconds: 3600 }],
  });
  gw.agentKeys = [agent.publicKey()];
  await gw.listen(GATEWAY_PORT, (u) => `{"ok":true,"data":"market snapshot","served_by":"${u}"}`);
  await gw.desk.listen(DESK_PORT);

  const buyer = new PaydluxAgent({ agentKey: agent.secret() });
  const ask = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/market/data`);
  log("agent parked", ask.handle, "— waiting for a human");
  log("seller balance before:", await vault.balance(seller.publicKey()));

  // In --tls mode the desk pins its Host header, so the loopback URL is refused
  // on purpose: the only way in is the tunnel. Print the link the human will
  // actually use, not one that 403s.
  const host = TLS ? `https://${PUBLIC_HOST}` : `http://127.0.0.1:${DESK_PORT}`;
  console.log("\nPORTAL  " + host + "/" + (portalKey ? `?k=${portalKey}` : ""));
  if (SPLIT) {
    console.log("\nAPPROVER APP  " + host + "/phone/" +
      (portalKey ? `?k=${portalKey}` : ""));
    console.log("  approver seed for that device ONLY (this process never sees it):");
    console.log("  " + approver.secret());
    console.log("  keep it off this machine. Re-run without --split to skip the phone.");
  }
  if (TLS) {
    if (!tunnelReady()) {
      console.log("\n--tls needs a named tunnel on this machine. One-time setup:");
      console.log("  cloudflared tunnel login");
      console.log("  cloudflared tunnel create paydlux-desk");
      console.log("  cloudflared tunnel route dns paydlux-desk " + PUBLIC_HOST);
      console.log("  and ~/.cloudflared/config.yml pointing at 127.0.0.1:" + DESK_PORT);
      process.exit(1);
    }
    runTunnel();
    log("opening https://" + PUBLIC_HOST + " ...");
    if (!(await tunnelLive())) {
      console.log("the tunnel did not answer on https://" + PUBLIC_HOST +
        ". Check ~/.cloudflared/config.yml and that the DNS route exists.");
      process.exit(1);
    }
    log("TLS verified on https://" + PUBLIC_HOST);
  } else if (PUBLIC) tunnel(portalKey!);
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
