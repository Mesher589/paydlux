# Paydlux — Technical Architecture

**Paydlux: spending mandates for AI agents, enforced on the Stellar ledger.**
This document describes how Paydlux works today (running on mainnet), how it integrates
with Stellar, and the planned Soroban smart-contract layer. Live code:
[github.com/Mesher589/paydlux](https://github.com/Mesher589/paydlux). Live demo:
[demo.paydlux.com](https://demo.paydlux.com) (full flow, no install, testnet).

## 1. What the system is

An AI agent that pays for things (APIs, content, goods) is a liability: one prompt
injection and it can drain a wallet. Paydlux puts the limit **outside the agent**.
The agent holds a paydlux credential, not a wallet key. Money sits in a Stellar
vault the agent cannot sign from. Every payment must pass two independent checks —
the local desk policy and the vault's own mandate ledger — before any XDR is built.
The vault refuses to sign anything that would breach the mandate, even if the agent's
software is fully compromised.

## 2. Component architecture (running today)

```
 AI agent (any framework)
   │  HTTP 402 loop:  402 Payment Required → pay → 200 result
   ▼
 Gateway (localhost, port 4021)          ← speaks the x402-style payment loop,
   │                                      builds Stellar payment XDRs
   ▼
 Approval desk (localhost, port 4022)    ← the human half of the mandate:
   │  · per-merchant categories, wallet allowlists
   │  · per-payment cap (e.g. 10 XLM) and daily budget (e.g. 50 XLM)
   │  · daily budget is SEEDED FROM THE LEDGER on restart, so restarting
   │    the desk cannot reset the spend counter
   │  · phone approver (desk.paydlux.com/phone) — human signs off over TLS
   ▼
 Vault (Stellar account, threshold-controlled)
   │  · mandate checks re-run here independently of the desk
   │  · asset identity enforced by assetMatches() (native-asset filters,
   │    so a USDC vault can never be blinded into paying native XLM and vice versa)
   │  · memo discipline: each payment names its order; wrong memo = rejected
   ▼
 Stellar Horizon (testnet + mainnet)     ← mainnet vault:
                                          GCJGF…VWUB, 26 successful transactions
```

Public surfaces (all live, served through one named Cloudflare TLS tunnel;
servers bind to 127.0.0.1 only):

| URL | What a reviewer sees |
|---|---|
| [paydlux.com](https://paydlux.com) | product site |
| [demo.paydlux.com](https://demo.paydlux.com) | the complete 402 loop end-to-end, testnet, no install |
| [donate.paydlux.com](https://donate.paydlux.com) | mainnet donation door (XLM + USDC via Circle trustline) |
| [desk.paydlux.com](https://desk.paydlux.com) | the approval desk + phone approver |

## 3. Money flow (the 402 loop, step by step)

1. Agent requests a paid resource → Gateway answers `402 Payment Required` with the
   price, asset, and a one-time payment address (order id in memo).
2. Agent asks the desk for a payment. The desk evaluates the mandate: category rule,
   wallet allowlist, per-payment cap, daily budget **counted from the ledger**.
3. If the mandate holds, the desk builds and submits the payment XDR from the vault.
   If any check fails, no XDR is ever constructed — failure is the default.
4. Gateway verifies the transaction on Horizon (asset, amount, memo) before releasing
   the resource. Order state is written to the ledger and shown live on the desk.

## 4. Security model — threats and controls

| Threat | Control |
|---|---|
| Prompt-injected / compromised agent | Agent has no signing key; vault mandate re-checks every payment independently of the desk |
| Desk restart wiping the budget | Daily budget re-seeded from the on-chain ledger history |
| Asset confusion (fake assets, wrong trustline) | `assetMatches()` identity checks at vault layer; USDC pinned to Circle issuer |
| Memo/order confusion & replay | Memo must name the exact order; verification against Horizon before delivery |
| Human-in-the-loop bypass | Threshold vault: high-value moves need the phone approver signature |
| TLS/transport | Public doors behind Cloudflare named tunnel; origin bound to localhost |

Every control above is covered by an executable check in the repo: 21 suites
(mandate, escrow, XDR, portal XSS, phone bridge, receive, donate, showcase…),
run on every release. Example: the portal suite proves an XSS payload cannot
approve a payment; the mandate suite proves both doors refuse over-budget spend.

## 5. Stellar integration — present and planned

**Today (classic Stellar):** payment XDRs via Horizon, memo-based order binding,
trustline and native-asset identity rules, threshold-controlled vault, donation
door in XLM and Circle USDC, real mainnet spend (26 transactions).

**Planned (SCF Build Award scope — Soroban):**
1. **Mandate as a smart contract.** Move the budget ceiling, category rules and
   per-payment cap into a Soroban contract that the vault invokes before any
   payment executes. On-chain enforcement removes the last trusted off-chain
   component: even a compromised desk cannot build a payment the contract rejects.
2. **Escrow & session budgets.** Time-boxed, purpose-boxed budgets minted as
   contract state (an agent gets a budget for a task, not a wallet).
3. **Attestations.** Payment receipts emitted by the contract — auditable spend
   history for whoever supervises the agent, without trusting Paydlux's own logs.

## 6. Tech stack

TypeScript throughout (~11k lines, 8.2k in the Stellar layer). Node ≥ 22, tsx;
Horizon for submission/verification; `stellar-sdk` for XDR; Cloudflare named
tunnel for public TLS; iOS phone-approver app (Swift bridge, signed approvals);
npm SDK [`@paydlux/agent`](https://www.npmjs.com/package/@paydlux/agent)
(4,697 downloads/month, 25 releases) that any agent can adopt in one call.

*Numbers verified 2026-11-07. Maintainer:  (solo, full-time).*
