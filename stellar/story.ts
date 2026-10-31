// Story mode: sets up a vault + seller, parks one approval request, and stays
// up so the human approval can be done in a real browser (for the demo clip).
//
//   npx tsx stellar/story.ts
//
// Then open http://127.0.0.1:4022/ and click Approve.
import { Keypair } from "stellar-sdk";
import { StellarVault } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { PaydluxAgent } from "./agent.ts";

const GATEWAY_PORT = 4021, DESK_PORT = 4022;
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

  const gw = new Gateway({
    vault, network: "testnet", payee: seller.publicKey(), deskPort: DESK_PORT,
    principal: principal.secret(), approver: approver.secret(),
    routes: [{ uri: "/market/data", price: "4.50", mode: "approval", holdSeconds: 3600 }],
  });
  gw.agentKeys = [agent.publicKey()];
  await gw.listen(GATEWAY_PORT, (u) => `{"ok":true,"data":"market snapshot","served_by":"${u}"}`);
  await gw.desk.listen(DESK_PORT);

  const buyer = new PaydluxAgent({ agentKey: agent.secret() });
  const ask = await buyer.get(`http://127.0.0.1:${GATEWAY_PORT}/market/data`);
  log("agent parked", ask.handle, "— waiting for a human");
  log("open the portal:  http://127.0.0.1:" + DESK_PORT + "/");
  log("seller balance before:", await vault.balance(seller.publicKey()));
  console.log("\nSTORY READY — click Approve in the browser, then ctrl-c to stop.");
};
main().catch((e) => console.error("FAIL:", (e as Error).message));
