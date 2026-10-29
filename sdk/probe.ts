// Focused probe: settle an escrow payment directly and print the full revert.
import { createPublicClient, createWalletClient, http, type Hex, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { readFileSync } from "node:fs";
import vaultAbi from "./abi/AgentVault.json" with { type: "json" };
import { domain, mandateDigest, type Mandate } from "./core.ts";
import { requestHash, emptyHash, bodyHash } from "./core.ts";

const RPC = "http://127.0.0.1:8545";
const USDC = 1_000_000n;
const dep = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex);
const principal = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945314d1a65666ae8c7ee7247f89866a69042b" as Hex);
const agent = privateKeyToAccount("0x7c852118294c51e65671ff36ef90c92713420de93576b45ec20037947fe9321c" as Hex);
const payee = privateKeyToAccount("0xc63d3d5163677f90696032886a4b38c16545e459952c7a5d27946f16367779e9" as Hex);

const pub = createPublicClient({ chain: anvil, transport: http(RPC) }) as never;
const w = createWalletClient({ account: dep, chain: anvil, transport: http(RPC) }) as never;
const pw = createWalletClient({ account: principal, chain: anvil, transport: http(RPC) }) as never;

{
  for (const a of [principal, agent, payee]) {
    await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [a.address, "0x" + (10n ** 21n).toString(16)] }) });
  }
}

const usdcA = JSON.parse(readFileSync(new URL("../contracts/out/AgentVault.t.sol/MockUSDC.json", import.meta.url), "utf-8"));
const vaultA = JSON.parse(readFileSync(new URL("../contracts/out/AgentVault.sol/AgentVault.json", import.meta.url), "utf-8"));

const usdc = (await pub.waitForTransactionReceipt({ hash: await w.deployContract({ abi: usdcA.abi, bytecode: usdcA.bytecode.object, args: [10_000n * USDC] }) })).contractAddress as Address;
const vault = (await pub.waitForTransactionReceipt({ hash: await w.deployContract({ abi: vaultAbi as never, bytecode: vaultA.bytecode.object as Hex, args: [usdc, dep.address, 100n] }) })).contractAddress as Address;

await w.writeContract({ abi: usdcA.abi as never, address: usdc, functionName: "mint", args: [principal.address, 500n * USDC] });
await pw.writeContract({ abi: usdcA.abi as never, address: usdc, functionName: "approve", args: [vault, 500n * USDC] });
await pw.writeContract({ abi: vaultAbi as never, address: vault, functionName: "deposit", args: [500n * USDC] });

const now = BigInt(await (await pub.getBlock()).timestamp);
const m: Mandate = { principal: principal.address, agent: agent.address, validAfter: now - 1n, validUntil: now + 30n * 86400n, perCallMax: 5n * USDC, dailyBudget: 50n * USDC, totalBudget: 200n * USDC, payeeRoot: "0x" + "00".repeat(32) as Hex, nonce: 1n };
const d = domain({ chainId: 31337, verifyingContract: vault });
const id = mandateDigest(d, m);
const mSig = (await principal.signMessage({ message: { raw: id } })) as Hex;
const regTx = await pw.writeContract({ abi: vaultAbi as never, address: vault, functionName: "registerMandate", args: [m.principal, m.agent, m.validAfter, m.validUntil, m.perCallMax, m.dailyBudget, m.totalBudget, m.payeeRoot, m.nonce, mSig] });
await pub.waitForTransactionReceipt({ hash: regTx });
console.log("mandate ok", id);

const method = "POST", uri = "/api/report", body = JSON.stringify({ q: "quarterly" });
const bh = bodyHash(body);
const nonce = 2n;
const intent = { mandateId: id, payee: payee.address, amount: 3n * USDC, validUntil: now + 3600n, nonce, requestHash: requestHash({ method, uri, bodyHash: bh, nonce }) };
const sig = await agent.signTypedData({ domain: d, types: { PaymentIntent: [
  { name: "mandateId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "amount", type: "uint128" },
  { name: "validUntil", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "requestHash", type: "bytes32" } ] } as never, primaryType: "PaymentIntent" as never, message: intent as never });

// simulate the escrow settle to surface the exact custom error
try {
  await pub.simulateContract({ account: dep, address: vault, abi: vaultAbi as never, functionName: "settle",
    args: [intent, sig, { method, uri, bodyHash: bh }, { payeeProof: [], contentHash: ("0x" + "00".repeat(32)) as Hex, releaseAfter: 86400n }] });
  console.log("escrow settle SIMULATES OK");
} catch (e: any) {
  let root: any = e; while (root.cause) root = root.cause;
  console.log("escrow settle REVERT:", root.shortMessage ?? root.message);
}

// and the immediate (non-escrow) settle for contrast
try {
  const i2 = { ...intent, nonce: 3n, requestHash: requestHash({ method: "GET", uri: "/api/data", bodyHash: emptyHash(), nonce: 3n }) };
  const s2 = await agent.signTypedData({ domain: d, types: { PaymentIntent: [
    { name: "mandateId", type: "bytes32" }, { name: "payee", type: "address" }, { name: "amount", type: "uint128" },
    { name: "validUntil", type: "uint64" }, { name: "nonce", type: "uint256" }, { name: "requestHash", type: "bytes32" } ] } as never, primaryType: "PaymentIntent" as never, message: i2 as never });
  await pub.simulateContract({ account: dep, address: vault, abi: vaultAbi as never, functionName: "settle",
    args: [i2, s2, { method: "GET", uri: "/api/data", bodyHash: emptyHash() as Hex }, { payeeProof: [], contentHash: ("0x" + "00".repeat(32)) as Hex, releaseAfter: 0n }] });
  console.log("immediate settle SIMULATES OK");
} catch (e: any) {
  console.log("immediate settle REVERT:", e.shortMessage ?? e.message);
}
process.exit(0);
