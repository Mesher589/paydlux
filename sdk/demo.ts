// End-to-end demo: anvil + real contracts + gateway + paying agent.
// Proves the whole loop: deposit -> mandate -> 402 -> signed proof -> settle -> paid.
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatUnits,
  type Hex,
  type Address,
  encodePacked,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { readFileSync } from "node:fs";
import vaultAbi from "./abi/AgentVault.json" with { type: "json" };
import creditAbi from "./abi/AgentCreditToken.json" with { type: "json" };
import { domain, domainSeparator, mandateDigest, MANDATE_TYPEHASH, type Mandate } from "./core.ts";
import { decodeEventLog, keccak256, toBytes, concat, encodeAbiParameters } from "viem";
import { Gateway } from "./gateway.ts";
import { PayingClient } from "./client.ts";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const CHAIN = 31337;

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const AGENT_PK = "0x7c852118294c51e65671ff36ef90c92713420de93576b45ec20037947fe9321c" as Hex;
const deployer = privateKeyToAccount(DEPLOYER_PK);
const principal = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945314d1a65666ae8c7ee7247f89866a69042b" as Hex);
const agent = privateKeyToAccount(AGENT_PK);
// all keys below are anvil's publicly known dev accounts — testnet only
const payee = privateKeyToAccount("0xc63d3d5163677f90696032886a4b38c16545e459952c7a5d27946f16367779e9" as Hex);
const feeTo = privateKeyToAccount("0x18000e09734a77f81ee1c507d18f0e00f7b6540ba9fa7f10aa28e1ae1982892c" as Hex);

const publicClient = createPublicClient({ chain: anvil, transport: http(RPC) }) as never;
const wallet = createWalletClient({ account: deployer, chain: anvil, transport: http(RPC) }) as never;
const principalWallet = createWalletClient({ account: principal, chain: anvil, transport: http(RPC) }) as never;

const USDC = 1_000_000n; // 1.00 with 6 decimals
const log = (...a: unknown[]) => console.log("•", ...a);

async function fund() {
  for (const a of [principal, agent, payee, feeTo]) {
    await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setBalance", params: [a.address, "0x" + (10n ** 21n).toString(16)] }),
    });
  }
}

async function main() {
  await fund();
  // 1. a USDC stand-in (6 decimals, mintable) — mainnet would use Circle's USDC
  const usdcArtifact = JSON.parse(readFileSync(new URL("../contracts/out/AgentVault.t.sol/MockUSDC.json", import.meta.url), "utf-8"));
  const usdcTx = await wallet.deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object, args: [10_000n * USDC] });
  const usdc = (await publicClient.waitForTransactionReceipt({ hash: usdcTx })).contractAddress as Address;
  log("USDC mock", usdc);

  // 2. the vault (deploys its own credit token)
  const vaultArtifact = JSON.parse(readFileSync(new URL("../contracts/out/AgentVault.sol/AgentVault.json", import.meta.url), "utf-8"));
  const vaultTx = await wallet.deployContract({
    abi: vaultAbi as never,
    bytecode: vaultArtifact.bytecode.object as Hex,
    args: [usdc, feeTo.address, 100n], // 1% fee
  });
  const vault = (await publicClient.waitForTransactionReceipt({ hash: vaultTx })).contractAddress as Address;
  const creditAddr = (await publicClient.readContract({ address: vault, abi: vaultAbi as never, functionName: "credit" })) as Address;
  log("AgentVault", vault, "credits", creditAddr);

  // 3. principal funds the vault
  await wallet.writeContract({ abi: usdcArtifact.abi as never, address: usdc, functionName: "mint", args: [principal.address, 500n * USDC] });
  await principalWallet.writeContract({ abi: usdcArtifact.abi as never, address: usdc, functionName: "approve", args: [vault, 500n * USDC] });
  await principalWallet.writeContract({ abi: vaultAbi as never, address: vault, functionName: "deposit", args: [500n * USDC] });
  log("principal deposited 500 USDC");

  // 4. principal delegates to the agent under hard limits
  const now = BigInt(await (await publicClient.getBlock()).timestamp);
  const m: Mandate = {
    principal: principal.address,
    agent: agent.address,
    validAfter: now - 1n,
    validUntil: now + 30n * 86400n,
    perCallMax: 5n * USDC,
    dailyBudget: 50n * USDC,
    totalBudget: 200n * USDC,
    payeeRoot: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    nonce: 1n,
  };
  const d = domain({ chainId: CHAIN, verifyingContract: vault });
  const digest = mandateDigest(d, m);
  const onchainDigest = (await publicClient.readContract({
    address: vault,
    abi: vaultAbi as never,
    functionName: "mandateDigest",
    args: [m.principal, m.agent, m.validAfter, m.validUntil, m.perCallMax, m.dailyBudget, m.totalBudget, m.payeeRoot, m.nonce],
  })) as Hex;
  // cross-check the SDK's EIP-712 implementation against the contract. This
  // caught a real SDK bug (viem concat() corrupts Hex+Uint8Array mixes), which
  // would have made every externally-signed mandate unregisterable.
  if (digest !== onchainDigest) throw new Error(`mandate digest mismatch: SDK ${digest} != vault ${onchainDigest}`);
  log("mandate digest SDK == vault ✓");
  // sign the way a browser wallet does (EIP-191 personal_sign over the id)
  const mSig = (await principal.signMessage({ message: { raw: digest } })) as Hex;
  const mandateId = digest;
  await principalWallet.writeContract({
    abi: vaultAbi as never,
    address: vault,
    functionName: "registerMandate",
    args: [m.principal, m.agent, m.validAfter, m.validUntil, m.perCallMax, m.dailyBudget, m.totalBudget, m.payeeRoot, m.nonce, mSig],
  });
  log("mandate registered (cap $5/call, $50/day, $200 total)");

  // 5. gateway serves a priced resource
  const gw = new Gateway({
    rpcUrl: RPC,
    chainId: CHAIN,
    vault,
    payee: payee.address,
    settleKey: DEPLOYER_PK,
    mandate: mandateId as Hex,
    pricing: [
      { uri: "/api/data", price: 2n * USDC },
      { uri: "/api/report", price: 3n * USDC, escrowWindow: 86400 },
    ],
  });
  await gw.listen(4021);
  log("gateway listening on :4021");

  // 6. the agent pays
  const client = new PayingClient({ rpcUrl: RPC, chainId: CHAIN, vault, agentKey: AGENT_PK, mandateId: mandateId as Hex });

  const paid = await client.fetchPaid("http://127.0.0.1:4021/api/data", { nonce: 1n });
  log("GET /api/data ->", paid.status, JSON.stringify(paid.body).slice(0, 120));

  // 7. replay must fail
  const replay = await client.fetchPaid("http://127.0.0.1:4021/api/data", { nonce: 1n });
  log("replay same nonce ->", replay.status, JSON.stringify(replay.body).slice(0, 200));

  // 8. balances
  const payeeBal = (await publicClient.readContract({ address: creditAddr, abi: creditAbi as never, functionName: "balanceOf", args: [payee.address] })) as bigint;
  const feeBal = (await publicClient.readContract({ address: creditAddr, abi: creditAbi as never, functionName: "balanceOf", args: [feeTo.address] })) as bigint;
  const remaining = (await publicClient.readContract({ address: vault, abi: vaultAbi as never, functionName: "remainingBudget", args: [mandateId] })) as bigint;
  log("payee received", formatUnits(payeeBal, 6), "USDC (net of fee)");
  log("platform fee", formatUnits(feeBal, 6), "USDC");
  log("mandate budget left", formatUnits(remaining, 6), "USDC");

  // 9. escrow path: payee must deliver a signed receipt
  const contentHash = keccak256(toBytes("quarterly report v1"));
  const esc = await client.fetchPaid("http://127.0.0.1:4021/api/report", {
    nonce: 2n,
    method: "POST",
    body: JSON.stringify({ q: "quarterly" }),
    contentHash,
  });
  log("POST /api/report (escrow) ->", esc.status, JSON.stringify((esc.body as any)?.reason ?? "").slice(0,200));
  const escrowBal = (await publicClient.readContract({ address: creditAddr, abi: creditAbi as never, functionName: "balanceOf", args: [payee.address] })) as bigint;
  log("payee balance after escrow hold", formatUnits(escrowBal, 6), "USDC (unchanged = funds held)");

  // 10. payee delivers: a signed receipt releases the hold
  const paidTx = (esc.body as any).tx as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({ hash: paidTx, timeout: 15_000 });
  let paymentId: Hex | undefined;
  for (const lg of receipt.logs) {
    if (lg.address !== vault) continue;
    const decoded = decodeEventLog({ abi: vaultAbi as never, data: lg.data, topics: lg.topics as never });
    if (decoded.eventName === "PaymentSettled") paymentId = decoded.args.paymentId as Hex;
  }
  const deliveredAt = BigInt(await (await publicClient.getBlock()).timestamp);
  const recSig = await payee.signTypedData({
    domain: domain({ chainId: CHAIN, verifyingContract: vault }),
    types: { DeliveryReceipt: [
      { name: "paymentId", type: "bytes32" },
      { name: "contentHash", type: "bytes32" },
      { name: "deliveredAt", type: "uint64" },
    ] } as never,
    primaryType: "DeliveryReceipt" as never,
    message: { paymentId, contentHash, deliveredAt } as never,
  });
  const escState = (await publicClient.readContract({ address: vault, abi: vaultAbi as never, functionName: "escrows", args: [paymentId!] })) as readonly unknown[];
  log("escrow holds", formatUnits(escState[2] as bigint, 6), "USDC until delivery");
  const relTx = await wallet.writeContract({
    abi: vaultAbi as never,
    address: vault,
    functionName: "release",
    args: [paymentId!, contentHash, deliveredAt, recSig],
  });
  await publicClient.waitForTransactionReceipt({ hash: relTx });
  const supply = (await publicClient.readContract({ address: creditAddr, abi: creditAbi as never, functionName: "totalSupply" })) as bigint;
  log("credit totalSupply", formatUnits(supply, 6), "USDC == custodied deposit (value conserved)");
  const released = (await publicClient.readContract({ address: creditAddr, abi: creditAbi as never, functionName: "balanceOf", args: [payee.address] })) as bigint;
  log("after delivery receipt, payee holds", formatUnits(released, 6), "USDC (escrow released)");

  process.exit(0);
}

main().catch((e) => {
  console.error("FAILED:", e.shortMessage ?? e.message);
  console.error((e.stack||"").split("\n").slice(0,6).join("\n"));
  process.exit(1);
});
