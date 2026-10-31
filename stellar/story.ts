// Story mode: sets up a vault + seller, parks one approval request, and stays
// up so the human approval can be done in a real browser (for the demo clip).
//
//   npx tsx stellar/story.ts              local only:  http://127.0.0.1:4022/
//   npx tsx stellar/story.ts --public     also opens a free Cloudflare tunnel
//                                         and prints a single unguessable link
//
// --public matters: the portal has no login, so the URL *is* the credential.
// Without a key, anyone who finds the tunnel can approve a payment. With one,
// the link is 22 random characters and a wrong guess gets a 403.
import { spawn } from "node:child_process";
import { Keypair } from "stellar-sdk";
import { StellarVault } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { PaydluxAgent } from "./agent.ts";
import { newPortalKey } from "./desk.ts";

const GATEWAY_PORT = 4021, DESK_PORT = 4022;
const PUBLIC = process.argv.includes("--public");
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

  const portalKey = PUBLIC ? newPortalKey() : undefined;
  const gw = new Gateway({
    vault, network: "testnet", payee: seller.publicKey(), deskPort: DESK_PORT,
    principal: principal.secret(), approver: approver.secret(),
    portalKey,
    routes: [{ uri: "/market/data", price: "4.50", mode: "approval", holdSeconds: 3600 }],
  });
  gw.agentKeys = [agent.publicKey()];
  await gw.listen(GATEWAY_PORT, (u) => `{"ok":true,"data":"market snapshot","served_by":"${u}"}`);
  await gw.desk.listen(DESK_PORT);

  const buyer = new PaydluxAgent({ agentKey: agent.secret() });
  const ask = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/market/data`);
  log("agent parked", ask.handle, "— waiting for a human");
  log("seller balance before:", await vault.balance(seller.publicKey()));

  console.log("\nPORTAL  http://127.0.0.1:" + DESK_PORT + "/" + (portalKey ? `?k=${portalKey}` : ""));
  if (PUBLIC) tunnel(portalKey!);
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
