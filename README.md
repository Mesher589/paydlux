# Paydlux — spend-limited payments for AI agents

AI agents are starting to buy things (APIs, data, compute) over HTTP with
stablecoin payments ([x402](https://x402.org)). Today an agent gets a raw
crypto wallet: **no spending cap, no human approval, no refund path** — and
real money has already been drained this way.

Paydlux puts the guardrails **on the ledger** instead of in your code.

## The Stellar path (primary — no smart contract, no faucet, no gas fight)

There is no contract to audit. The whole mechanism is three native Stellar
primitives:

| primitive | what it gives us |
|---|---|
| issued asset / Circle USDC | the payment token |
| multisig account | the vault — releasing funds needs 2 of the signers |
| pre-authorised transaction hash | the spending mandate, as a *signer* |

The mandate is the trick. We pre-build a transaction whose operations are
exactly "pay N tokens to this payee, inside this time window, once", take its
hash, and register that hash as a weight-1 signer on the vault. The agent key
is also weight-1 and the threshold is 2. So the agent can reach threshold only
by presenting **that exact transaction**. Change the amount, the payee, the
token, the window, or try to run it twice, and the ledger refuses. A prompt
injection cannot talk its way past a signature check.

```
stellar/vault.ts     create a 2-of-2 vault, register mandates, settle, revoke
stellar/gateway.ts   HTTP 402 resource server; serves only after the ledger agrees
stellar/agent.ts     the buyer side — one class, one method call
stellar/desk.ts      approval queue: a human decides, in the clear
stellar/portal.ts    the page that human looks at
stellar/policy.ts    daily budget / seller allowlist (the part a ledger can't count)
stellar/demo.ts      11 checks against the live testnet, one command
stellar/probe-*.ts   the experiments that settled how the ledger behaves
stellar/onboard.ts   keys → funded vault → printed agent key
```

### Try it

```bash
npm i
npx tsx stellar/demo.ts
```

No wallet, no faucet, no config. It prints what it proves:

```
— 4. human pre-authorises a mandate; agent executes it
  ✅ content served, tx cabeb25ec92c2391…
  ✅ seller 2.0000000, vault 48.0000000
— 5. tamper with the envelope — the ledger refuses
  ✅ refused: price mismatch: want 2 got 9.0000000
— 6. replay the same mandate — money moves once
  ✅ refused: mandate is not registered on the vault (expired or revoked)
— 7. over-budget request is declined before anything is built
  ✅ declined [max_per_payment]: 40 exceeds the per-payment ceiling of 10
— 8. approval mode — a human decides
  ✅ human approved → settled on-chain, tx bf4ce06c742f18f2…
— 9. deny path — nothing moves
  ✅ denied, balance unchanged at 42.0000000
```

Plug your own agent in:

```ts
import { PaydluxAgent } from "./stellar/agent.ts";

const agent = new PaydluxAgent({ agentKey: process.env.AGENT_KEY! });
const res = await agent.get("https://seller.example.com/api/data", { mandate });
if (res.ok) console.log(res.data, "paid in tx", res.tx);
```

`npx tsx stellar/onboard.ts` creates the vault and prints that key. The key is
**one of two signatures** — it cannot spend alone.

### What is enforced where (said honestly)

| enforced by Stellar | enforced by `policy.ts` |
|---|---|
| max per payment, payee, token, time window, one-shot execution | payments per day, running daily total, seller allow/deny list |

The vault is one payment at a time; counting payments is our job. A rule break
means we never build the transaction, so nothing reaches the ledger.

Two ledger behaviours we verified rather than assumed, and designed around:

- **A mandate is consumed on use.** After it runs, Stellar removes the pre-auth
  signer. One mandate, one payment — no counter needed.
- **A pre-auth transaction is bound to a sequence number**, so only the newest
  mandate can ever run; an older one is in the past and can never fire.
  `createMandate` therefore revokes previous mandates in the same transaction.
  The product is deliberately one open order at a time.
- **Resubmitting an identical envelope does not error.** Horizon returns the
  *cached* result. The money cannot move twice, but a naive gateway would serve
  the content twice — so `gateway.ts` checks the ledger for an already-applied
  transaction before shipping anything.

### Real money

Circle issues USDC natively on Stellar — not wrapped, not bridged. `vault.ts`
pins the issuer (`GA5ZSEJY…KZVN` on public, `GBBD47IF…FLA5` on testnet) and
rejects any other token that calls itself USDC. The vault's USDC trustline is
verified on testnet. Settlement fee is 0.00001 XLM.

## The EVM path (research, kept for the deeper feature set)

`contracts/` + `sdk/` are the earlier Base Sepolia work: a Solidity vault with
escrow, proof-of-delivery receipts, session keys and Merkle-batched settlement
(~$0.00005/payment). 61 contract tests pass, including 4×512-run fuzz suites
over the core invariants.

```
contracts/src/AgentVault.sol       vault, mandates, settle, escrow, sessions, batches
contracts/src/AgentCreditToken.sol USDC-backed credit token (deferred settlement)
sdk/core.ts                        EIP-712 typed data (mirrors the contract exactly)
sdk/gateway.ts                     x402-style HTTP 402 resource server
sdk/approval.ts                    human-in-the-loop Approval Desk
sdk/economics.ts                   unit economics from measured gas + live prices
```

```bash
anvil --chain-id 31337 &
cd contracts && forge build && forge test
cd ../sdk && node demo.ts
```

## Status

Working prototype on **Stellar testnet**, end to end, verified by `stellar/demo.ts`.
The EVM contracts are tested but **not audited**. Nothing here has run with
real funds. Do not use it with real funds.

## Economics

Stellar settles for ~0.00001 XLM, so per-payment cost is not the constraint —
trust is. Pricing is 0.5¢ per settlement capped at 1%, plus SaaS for mandate
management, dashboards and compliance evidence.

## License

MIT
