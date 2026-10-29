// Simulates the browser+MetaMask path end-to-end using a wallet that is NOT
// the mandate principal: adopt -> personal_sign -> approve. Run with: npx tsx sdk/probe-adopt.ts
import { privateKeyToAccount } from "viem/accounts";
import { http } from "viem";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const ID = process.env.PAY_ID ?? "pay_0003";
// anvil dev account #7 — deliberately NOT the principal/approver
const userKey = (process.env.USER_PK ?? "0x976e7b34ab41837fc82794f4507dde97b3eee0c63f7149829a3e5eb8263e29e7") as never;
const acct = privateKeyToAccount(("0x" + String(userKey).replace("0x", "")) as never);

const post = async (path: string, body: unknown) => {
  const r = await fetch(`http://127.0.0.1:4022/api/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
};

const main = async () => {
  console.log("simulated browser wallet:", acct.address);
  const a = await post(`adopt/${ID}`, { address: acct.address });
  console.log("adopt ->", a);
  const d = await (await fetch("http://127.0.0.1:4022/api/pending")).json();
  const item = d.items.find((x: any) => x.id === ID);
  // MetaMask personal_sign over a 0x hex message hex-decodes it -> EIP-191 over raw digest
  const sig = await acct.signMessage({ message: { raw: item.digest } });
  const r = await post(`approve/${ID}`, { signature: sig });
  console.log("approve ->", r);
  void http;
};
main().catch((e) => { console.error("PROBE FAILED", e); process.exit(1); });
