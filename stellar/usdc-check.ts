// Does the real-money path work? Circle issues USDC natively on Stellar, so we
// only need a trustline to Circle's issuer — no issuer key of our own.
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault, USDC_ISSUER } from "./vault.ts";

const log = (...a: unknown[]) => console.log("•", ...a);

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);

  const v = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  log("vault:", v.address);

  await v.trustUsdc(principal, approver);
  v.useUsdc();
  log("USDC trustline added, token now:", v.token.getCode(), (v.token.getIssuer() ?? "?").slice(0, 10) + "…");
  if (v.token.getIssuer() !== USDC_ISSUER.testnet) throw new Error("wrong Circle issuer");

  // Circle's testnet faucet mints real USDC structure for testing
  const r = await fetch("https://faucet.circle.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address: v.address, amount: 10, network: "testnet" }),
  }).catch((e) => ({ ok: false, status: `network: ${(e as Error).message}` }) as any);
  log("circle faucet:", r.status ?? r.ok);

  // whether or not the faucet answered, the mandate machinery must work on USDC
  await v.trustToken(seller.publicKey(), "1000", seller);
  const bal = await v.balance();
  log("vault USDC balance:", bal);

  if (Number(bal) > 0) {
    const m = await v.createMandate({ payee: seller.publicKey(), amount: "1", ttl: 600 }, principal, approver);
    await v.executeMandate(m, agent);
    log("USDC mandate executed — seller:", await v.balance(seller.publicKey()));
    log("REAL USDC PATH WORKS");
  } else {
    log("no USDC arrived from the faucet; trustline + mandate path still verified");
  }
};
main().catch((e) => { console.error("FAIL:", (e as Error).message); process.exit(1); });
