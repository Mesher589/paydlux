// Can two mandates be live at once, and in what order must they run?
// A pre-auth transaction consumes a sequence number, so this is the real limit.
import { Keypair } from "stellar-sdk";
import { StellarVault } from "./vault.ts";

const log = (...a: unknown[]) => console.log("•", ...a);

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random();
  const s1 = Keypair.random(), s2 = Keypair.random();
  for (const k of [issuer, principal, approver, s1, s2]) await StellarVault.fundTestnet(k);

  const v = await StellarVault.create({ network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY" });
  await v.trustToken(s1.publicKey(), "1000", s1);
  await v.trustToken(s2.publicKey(), "1000", s2);
  await v.deposit("50", issuer);

  log("creating mandate A (pay s1, 1)");
  const A = await v.createMandate({ payee: s1.publicKey(), amount: "1", ttl: 900 }, principal, approver);
  log("creating mandate B (pay s2, 2)");
  const B = await v.createMandate({ payee: s2.publicKey(), amount: "2", ttl: 900 }, principal, approver);
  log("A seq", A.sequence, "B seq", B.sequence);

  log("executing B first");
  try { await v.executeMandate(B, agent); log("  B ok"); }
  catch (e) { log("  B refused:", (e as Error).message); }

  log("executing A");
  try { await v.executeMandate(A, agent); log("  A ok"); }
  catch (e) { log("  A refused:", (e as Error).message); }

  log("executing B again");
  try { await v.executeMandate(B, agent); log("  B ok"); }
  catch (e) { log("  B refused:", (e as Error).message); }

  log("s1:", await v.balance(s1.publicKey()), "s2:", await v.balance(s2.publicKey()), "vault:", await v.balance());
};
main().catch((e) => console.error("FAIL:", (e as Error).message));
