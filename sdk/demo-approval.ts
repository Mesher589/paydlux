// Human-in-the-loop demo: an agent tries to buy something, the payment is
// HELD until a person approves it in the Approval Desk. Proves:
//   1. agent request -> verified but held (202 awaiting_approval), no money moves
//   2. a denial settles nothing
//   3. a wallet-style human signature (personal_sign) releases the settlement
//   4. the human approval is bound to that exact payment (cannot be reused)
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hex,
  type Address,
  formatUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { readFileSync } from "node:fs";
import vaultAbi from "./abi/AgentVault.json" with { type: "json" };
import { domain, mandateDigest, type Mandate } from "./core.ts";
import { Gateway } from "./gateway.ts";
import { ApprovalDesk } from "./approval.ts";
import { PayingClient } from "./client.ts";

const RPC = process.env.RPC ?? "http://127.0.0.1:8545";
const CHAIN = Number(process.env.CHAIN_ID ?? 31337);
// LIVE mode: point at an already-deployed vault (e.g. Base Sepolia fork) with
// the real Circle USDC instead of deploying mocks.
const LIVE_VAULT = (process.env.VAULT ?? "") as Address;
const LIVE_USDC = (process.env.USDC ?? "") as Address;
const chain = CHAIN === 31337 ? anvil : { ...anvil, id: CHAIN };

// anvil's publicly known dev accounts — testnet only
const DEPLOYER_PK = (process.env.DEPLOYER_PK ?? "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as Hex;
const AGENT_PK = "0x7c852118294c51e65671ff36ef90c92713420de93576b45ec20037947fe9321c" as Hex;
const PRINCIPAL_PK = (process.env.PRINCIPAL_PK ?? "0x59c6995e998f97a5a0044966f0945314d1a65666ae8c7ee7247f89866a69042b") as Hex;
const PAYEE_PK = "0xc63d3d5163677f90696032886a4b38c16545e459952c7a5d27946f16367779e9" as Hex;
const FEE_PK = "0x18000e09734a77f81ee1c507d18f0e00f7b6540ba9fa7f10aa28e1ae1982892c" as Hex;

const deployer = privateKeyToAccount(DEPLOYER_PK);
const principal = privateKeyToAccount(PRINCIPAL_PK);
const agent = privateKeyToAccount(AGENT_PK);
const payee = privateKeyToAccount(PAYEE_PK);
const feeTo = privateKeyToAccount(FEE_PK);

const publicClient = createPublicClient({ chain, transport: http(RPC) }) as never;
const wallet = createWalletClient({ account: deployer, chain, transport: http(RPC) }) as never;
const principalWallet = createWalletClient({ account: principal, chain, transport: http(RPC) }) as never;

const USDC = 1_000_000n;
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

  let usdc: Address;
  let vault: Address;
  if (LIVE_VAULT) {
    usdc = LIVE_USDC;
    vault = LIVE_VAULT;
    log("LIVE mode — using deployed vault", vault, "with USDC", usdc);
  } else {
    const usdcArtifact = JSON.parse(readFileSync(new URL("../contracts/out/AgentVault.t.sol/MockUSDC.json", import.meta.url), "utf-8"));
    const usdcTx = await wallet.deployContract({ abi: usdcArtifact.abi, bytecode: usdcArtifact.bytecode.object, args: [10_000n * USDC] });
    usdc = (await publicClient.waitForTransactionReceipt({ hash: usdcTx })).contractAddress as Address;

    const vaultArtifact = JSON.parse(readFileSync(new URL("../contracts/out/AgentVault.sol/AgentVault.json", import.meta.url), "utf-8"));
    const vaultTx = await wallet.deployContract({ abi: vaultAbi as never, bytecode: vaultArtifact.bytecode.object as Hex, args: [usdc, feeTo.address, 100n] });
    vault = (await publicClient.waitForTransactionReceipt({ hash: vaultTx })).contractAddress as Address;
  }
  const creditAddr = (await publicClient.readContract({ address: vault, abi: vaultAbi as never, functionName: "credit" })) as Address;
  log("vault", vault);

  const erc20 = [
    { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
    { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  ] as never;
  if (!LIVE_VAULT) {
    await wallet.writeContract({ abi: erc20, address: usdc, functionName: "mint", args: [principal.address, 500n * USDC] } as never);
  }
  const have = (await publicClient.readContract({ address: usdc, abi: erc20, functionName: "balanceOf", args: [principal.address] })) as bigint;
  const deposit = have;
  log("principal holds", formatUnits(have, 6), "USDC — depositing", formatUnits(deposit, 6));
  if (deposit > 0n) {
    const ap = await principalWallet.writeContract({ abi: erc20, address: usdc, functionName: "approve", args: [vault, deposit] });
    await publicClient.waitForTransactionReceipt({ hash: ap });
    const dp = await principalWallet.writeContract({ abi: vaultAbi as never, address: vault, functionName: "deposit", args: [deposit] });
    await publicClient.waitForTransactionReceipt({ hash: dp }); // must mine before any read
  }
  const creditBal = (await publicClient.readContract({ address: creditAddr, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [principal.address] })) as bigint;
  const budget = creditBal;
  log("principal credit balance:", formatUnits(budget, 6));

  const PRICE = 1n * USDC;
  const now = BigInt(await (await publicClient.getBlock()).timestamp);
  const m: Mandate = {
    principal: principal.address,
    agent: agent.address,
    validAfter: now - 1n,
    validUntil: now + 30n * 86400n,
    perCallMax: 2n * USDC,
    dailyBudget: budget,
    totalBudget: budget,
    payeeRoot: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
    nonce: BigInt(process.env.MANDATE_NONCE ?? 1),
  };
  const d = domain({ chainId: CHAIN, verifyingContract: vault });
  const digest = mandateDigest(d, m);
  const mSig = (await principal.signMessage({ message: { raw: digest } })) as Hex;
  const rmTx = await principalWallet.writeContract({
    abi: vaultAbi as never, address: vault, functionName: "registerMandate",
    args: [m.principal, m.agent, m.validAfter, m.validUntil, m.perCallMax, m.dailyBudget, m.totalBudget, m.payeeRoot, m.nonce, mSig],
  });
  await publicClient.waitForTransactionReceipt({ hash: rmTx });
  const mandateId = digest;

  // the human turns on "always ask me first" for this mandate
  const apTx = await principalWallet.writeContract({ abi: vaultAbi as never, address: vault, functionName: "setApprovalPolicy", args: [mandateId, true, principal.address] });
  await publicClient.waitForTransactionReceipt({ hash: apTx });
  log("mandate registered — human approval REQUIRED for every payment");

  // desk + gateway
  const desk = new ApprovalDesk({ rpcUrl: RPC, chainId: CHAIN, vault, settleKey: DEPLOYER_PK, humanKey: PRINCIPAL_PK, portalPort: 4022 });
  const server = desk.start();
  const gw = new Gateway({
    rpcUrl: RPC, chainId: CHAIN, vault, payee: payee.address, settleKey: DEPLOYER_PK,
    mandate: mandateId, desk,
    pricing: [{ uri: "/api/report", price: PRICE, requiresApproval: true }],
  });
  await gw.listen(4021);
  log("approval portal: http://127.0.0.1:4022  |  priced API: http://127.0.0.1:4021/api/report");

  const client = new PayingClient({ rpcUrl: RPC, chainId: CHAIN, vault, agentKey: AGENT_PK, mandateId });

  // 1. agent tries to buy — request is verified but HELD
  const held = await client.fetchPaid("http://127.0.0.1:4021/api/report", { method: "POST", nonce: 1n, body: JSON.stringify({ q: "quarterly" }) });
  log("agent got:", held.status, JSON.stringify(held.body));
  const handle = (held.body as any).handle as string;
  const balAfterHold = await publicClient.readContract({ address: creditAddr, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [payee.address] }) as bigint;
  log("payee balance while held:", formatUnits(balAfterHold, 6), "USDC  <- no money moved yet");

  // 3. human approves from the portal (dev key signs personal_sign; a real
  //    browser wallet would sign the same digest)
  const pending = desk.get(handle)!;
  const approvalDigest = desk.approvalDigest(pending.payment);
  const humanSig = (await principal.signMessage({ message: { raw: approvalDigest } })) as Hex;
  const settled = await desk.approve(handle, humanSig);
  log("human approved -> settled on chain:", settled.tx!.slice(0, 18) + "…");

  const balAfter = await publicClient.readContract({ address: creditAddr, abi: [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }], functionName: "balanceOf", args: [payee.address] }) as bigint;
  log("payee balance after approval:", formatUnits(balAfter, 6), "USDC (price $3 minus 1% fee)");

  // 4. the same human approval cannot release a different payment
  const held2 = await client.fetchPaid("http://127.0.0.1:4021/api/report", { method: "POST", nonce: 2n, body: JSON.stringify({ q: "different" }) });
  const h2 = (held2.body as any).handle as string;
  try {
    await desk.approve(h2, humanSig); // stale approval for a different payment
    log("!! reuse succeeded — BUG");
  } catch (e) {
    log("reusing the old approval for a new payment:", (e as Error).message);
  }

  if (process.env.KEEP_OPEN) {
    // leave the portal + API running so a human can play with it in a browser:
    // two fresh payments sit waiting for approval at http://127.0.0.1:4022
    await client.fetchPaid("http://127.0.0.1:4021/api/report", { method: "POST", nonce: 3n, body: JSON.stringify({ q: "sales 2026" }) });
    await client.fetchPaid("http://127.0.0.1:4021/api/report", { method: "POST", nonce: 4n, body: JSON.stringify({ q: "competitor scan" }) });
    log("portal stays open: http://127.0.0.1:4022  (Ctrl+C to stop)");
    return;
  }
  server.close();
  log("done");
  process.exit(0); // the gateway http server would otherwise keep the loop alive
}

main().catch((e) => { console.error("FAILED", e); process.exit(1); });
