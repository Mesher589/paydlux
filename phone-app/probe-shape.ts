#!/usr/bin/env npx tsx
import { Keypair, Horizon, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { StellarVault, createApprovalChallenge } from "../stellar/index.ts";

const hexOf = (v: any) => {
  if (v instanceof Uint8Array) return Buffer.from(v).toString("hex");
  if (v && typeof v === "object") {
    const o: any = {};
    for (const k of Object.keys(v)) o[k] = hexOf(v[k]);
    return o;
  }
  return v;
};

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  const horizon = new Horizon.Server("https://horizon-testnet.stellar.org");
  await vault.deposit("20", issuer);
  const c = await createApprovalChallenge({
    vaultAddress: vault.address, principal, payee: seller.publicKey(),
    tokenCode: "AGPAY", tokenIssuer: issuer.publicKey(), network: "testnet",
    horizon, memo: "pay_0001", amount: "4.50", id: "pay_0001", decideWithinSeconds: 3600,
  });
  const env: any = xdr.TransactionEnvelope.fromXDR(c.xdr, "base64");
  const t = env.v1.tx;
  console.log("sourceAccount:", hexOf(t.sourceAccount));
  console.log("fee:", t.fee, "seq:", t.seqNum?.toString?.() ?? t.seqNum);
  const safe = (v: any) => JSON.stringify(v, (k, x) =>
    typeof x === "bigint" ? x.toString() : hexOf(x));
  console.log("cond:", safe(t.cond));
  console.log("memo:", safe(t.memo));
  console.log("ext:", safe(t.ext));
  console.log("numOps:", t.operations.length, "op.sourceAccount:", safe(t.operations[0].sourceAccount));
  console.log("op.body:", safe(t.operations[0].body));
  console.log("sigs:", safe(env.v1.signatures));
  const raw = xdr.TransactionEnvelope.fromXDR(c.xdr, "base64").toXDR();
  console.log("raw hex:", Buffer.from(raw).toString("hex"));
  console.log("raw len:", raw.length);

  console.log("ext:", JSON.stringify(hexOf(t.ext)));
  console.log("op[0].sourceAccount:", JSON.stringify(hexOf(t.operations[0].sourceAccount)));
  console.log("op[0].body keys:", Object.keys(t.operations[0].body));
  console.log("op[0].body:", JSON.stringify(hexOf(t.operations[0].body)).slice(0, 400));
  console.log("sig[0]:", JSON.stringify(hexOf(env.v1.signatures[0])));
  console.log("sdk hash:", Buffer.from((TransactionBuilder as any).fromXDR(c.xdr, "Test SDF Network ; September 2015").hash()).toString("hex"));
};
main().catch((e) => { console.error(e); process.exit(1); });
