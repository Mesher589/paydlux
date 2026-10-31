// Smoke test for StellarVault: create, fund, deposit, mandate, execute, revoke.
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";

const log = (...a: unknown[]) => console.log("•", ...a);
const fail = (m: string) => { console.error("FAIL:", m); process.exit(1); };

const main = async () => {
  const issuer = Keypair.random();
  const principal = Keypair.random();
  const approver = Keypair.random();
  const agent = Keypair.random();
  const seller = Keypair.random();

  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  log("keys funded");

  const v = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  log("vault:", v.address);

  await v.trustToken(seller.publicKey(), "1000", seller);
  const bal0 = await v.deposit("25", issuer);
  log("deposited, vault balance:", bal0);

  const s = await v.signerSummary();
  log("thresholds:", JSON.stringify(s.thresholds), "signers:", s.signers.length);
  if (s.thresholds.med !== 2) fail("expected med threshold 2");

  const rogue = await v.createMandate({ payee: seller.publicKey(), amount: "1" }, principal, approver);
  log("mandate hash:", rogue.hash.slice(0, 16) + "…");

  const paid = await v.executeMandate(rogue, agent);
  log("mandate executed, tx:", String(paid.hash).slice(0, 14) + "…");
  log("seller:", await v.balance(seller.publicKey()), "vault:", await v.balance());

  // human path
  await v.release(seller.publicKey(), "4", principal, approver, "manual-order");
  log("after human release — seller:", await v.balance(seller.publicKey()), "vault:", await v.balance());

  // revoke: outstanding mandates die
  const pending = await v.createMandate({ payee: seller.publicKey(), amount: "2", ttl: 600 }, principal, approver);
  await v.revokeAll(principal, approver);
  try {
    await v.executeMandate(pending, agent);
    fail("revoked mandate still executed");
  } catch (e) { log("revoked mandate rejected:", (e as Error).message); }

  log("SMOKE PASSED");
};
main().catch((e) => fail(String((e as any)?.message ?? e)));
