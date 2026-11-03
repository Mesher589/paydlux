# SCF Build Interest Form — answers (paste-ready)

Filled 2026-11-03. Every number below was checked against the live repo, npm,
the SCF handbook, and Horizon mainnet on that date. One blank: the country
dropdown (see ⚠️ at the end).

---

## Project Information

**Project Title**

```
Paydlux — spending mandates for AI agents, enforced on the Stellar ledger
```

**Project Description**

```
AI agents are starting to buy things over HTTP with stablecoin payments (x402: HTTP 402 + USDC). Today an agent is handed a raw wallet key: no spending cap it cannot break, no human in the loop, no refund path. The standard defence is a soft ceiling in the SDK — $5 per transaction, $50 a day. A ceiling is a seatbelt, not an airbag: it does not stop the crash, it only decides how much you lose when you crash. A prompt-injected agent that can talk its way past a config value can talk its way past any number written in code.

Paydlux moves the guardrail from the code onto the ledger. The vault is a Stellar account whose spending threshold is 2. The agent's key is a weight-1 signer; the spending mandate is registered as the other weight-1 signer, as a pre-authorised transaction hash. The mandate is a transaction whose operations are exactly "pay N units to this payee, in this asset, inside this time window, once". So the agent reaches threshold only by presenting that exact transaction. Change the amount, the payee, the asset, the window, or try to run it twice, and the ledger itself refuses. There is no ceiling to raise, because there is no automatic path at all.

Three objectives:

1. Make human-approved agent payments a reusable Stellar primitive — no smart contract to audit, using only native Stellar features (issued asset / Circle USDC, multisig accounts, pre-authorised transaction hashes).
2. Put the human's key off the machine the agent runs on. The approver signs on their own device, in an installable web app (and a native iOS app) that decodes the transaction locally and shows amount, asset, payee and deadline before it signs. The seed is imported into WebCrypto as non-extractable and never leaves the device.
3. Prove the harder half — the seller side. A stranger's agent can pay a Paydlux gateway from *their* vault, approved on *their* phone. The seller holds none of their keys; the only witness is a public ledger read.

Why this matters for Stellar: agent payments are high-frequency, low-value, and machine-initiated — exactly the profile where Stellar's sub-cent fees, native USDC, and native multisig beat a smart contract. Paydlux is a new use case for the network (autonomous buyers with a human veto), not a port of something that already exists on it.

MIT-licensed, open source, published on npm as @paydlux/agent.
```

**Project Category**

Pick **Financial Protocols** if offered (the vault + mandate is an on-chain payment primitive).
Fallbacks in order: **Payments** → **Applications / End-User Applications**.
Avoid **Developer Tooling** for a Build Award — the SCF FAQ states the main Build categories are End-User Applications and Financial Protocols, and dev tooling is mostly funded through RFPs and the Public Goods Award.

**Current Traction**

```
Working, live on Stellar mainnet and public testnet — not a deck.

Live on MAINNET (verifiable on Horizon):
- Vault GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB — thresholds low/med/high all 2, three weight-1 signers (agent key, human key, mandate hash), a live trustline to Circle-issued USDC (issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN).
  Check it: https://horizon.stellar.org/accounts/GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB
- 6 successful mainnet transactions / 9 operations on 2026-11-03, including a payment that was served only after Horizon confirmed it landed, in full, in the right asset, on a transaction that actually succeeded — and the same transaction refused when replayed onto a second order.

Live public endpoints (anyone can drive the real 402 loop, no install):
- https://demo.paydlux.com — a stranger completes the full 402 loop against a real gateway, real mandate, real approval queue.
- https://donate.paydlux.com — the seller door, priced in USDC, on a real domain.
- https://desk.paydlux.com — the approval desk, behind TLS, answering 403 without the portal key.
- https://paydlux.com — landing page with a scannable receiving address.

Package adoption:
- @paydlux/agent on npm: 3,536 downloads in the last month (2026-10-04 → 2026-11-02), 22 published versions, latest 0.1.20. https://www.npmjs.com/package/@paydlux/agent
- Vulnerable early versions (0.1.18, 0.1.19) were deprecated rather than left up.

Engineering depth:
- 75 commits, 2026-10-29 → 2026-11-03. ~11,000 lines of TypeScript, 8,173 of it in the Stellar layer.
- 21 executable check suites run against live networks: 142+ named end-to-end checks (17 testnet settlement checks, 19 TLS checks, 32 byte-exact XDR decoder checks, 57 approver-app-over-real-HTTP checks, 17 key-split checks, plus XSS, mandate, native-asset, USDC and dist-packaging suites).
- https://github.com/Mesher589/paydlux

What the checks found (the bugs a demo never shows you):
- an XLM vault was blind to its own money — balance and daily-spend filters dropped native-asset records, so the budget read as unspent forever and the ceiling never closed.
- changeTrust on a native asset is a ledger error, and it rode in the same transaction as the signer setup — a vault would have been created with its master key switched off and nothing able to sign anything ever again.
- the approval page rendered an agent-controlled request path into HTML: XSS into the one screen where a human is about to authorise money. Security release shipped, affected npm versions deprecated.
- the daily budget reset on restart. It is now seeded from the ledger, so a restart cannot hand the agent a fresh allowance.

Stage: functional prototype on mainnet with real USDC and no customer funds at risk. Not yet: production hosting, an audit, and a wallet-agnostic onboarding flow — which is what this award funds.
```

**Website**

```
https://paydlux.com
```

**Planned Stellar Integration**

```
Stellar is not an integration here — it is the product. The whole safety guarantee is three native Stellar ledger features, with no smart contract, no Soroban deployment, and no custom consensus:

1. Issued assets / native USDC. Circle USDC on Stellar (issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN) is the payment token; XLM works as a settlement asset too. Trustlines are opened at vault setup.

2. Multisig accounts = the vault. The vault account's low/medium/high thresholds are all set to 2. The agent key is a weight-1 signer. So no payment is possible on the agent's signature alone.

3. Pre-authorised transaction hashes = the mandate. We pre-build a transaction whose operations are exactly "pay N units to payee P, in asset A, between T0 and T1, once", take its hash, and register that hash as a weight-1 signer on the vault (via set_options with a preauth_tx_hash signer and a 10-minute validity window). The agent can only reach threshold 2 by presenting that exact envelope. Any change to amount, payee, asset, window, or a second use, fails signature verification on the ledger. Revocation is a set_options that removes the signer — and a revoked mandate id is refused permanently, so it cannot come back.

Already built on the Stellar stack (@stellar/stellar-sdk v17, the current stable line):
- vault lifecycle: create 2-of-2 vault, register/revoke mandates, settle, withdraw
- a Horizon-backed verification path: a payment is only accepted after the transaction is confirmed to exist on-chain, in full, in the expected asset, matching the order — five separate refusals, because a buyer's claim is attacker-controlled text
- the approver app carries its own Stellar transaction decoder (phone-app/xdr.js) and refuses any transaction shape it does not fully understand: path payments, account merges, signer changes and multi-operation transactions are rejected outright rather than guessed at
- an iOS approver that parses and re-encodes Stellar XDR natively
- a CLI (`paydlux setup|sell|status|approver`) that turns keys into a funded, trustlined vault in one command

What the award funds on Stellar:
- Soroban is deliberately not used today — the mandate mechanism is ledger-native, so there is no contract to audit. We plan to evaluate a Soroban policy layer for the one thing a ledger cannot count on its own (spend totals across many mandates in a day), rather than adding a contract for its own sake.
- Production-grade hosted vault onboarding, key recovery, and an audit through the SCF Audit Bank.
```

**Build Track**

```
Open Track
```

Why: the mandate-as-signer mechanism is a novel on-chain primitive, not an integration of an existing ecosystem building block, and it already has traction. Integration Track would require most of the budget to go to integrating an item from the SCF Integration List, which is not what this is. RFP Track only fits an active RFP.

---

## Team Information

**Submitter type**

```
Individual
```

**Email**

```
founder@paydlux.com
```

(backup: support@paydlux.com — same inbox, listed in SECURITY.md)

**Team Description**

```
Solo builder — one person, working on this full time. I am honest about that rather than dressing it up: the upside is that the whole stack (ledger layer, gateway, approver web app, iOS app, docs, tests) is already built and shipped by one person in six days; the risk is bus factor, and I would use part of the award to bring in a second pair of hands for the audit response.

Expertise:
- TypeScript / Node. ~11,000 lines in this repo, 8,173 of it in the Stellar layer. Published npm package with 3,536 downloads last month.
- Stellar specifically: @stellar/stellar-sdk v17, account thresholds and signer weights, pre-authorised transaction hashes, trustlines, XDR. I wrote a standalone XDR decoder for the approver app (32 byte-exactness checks against the SDK) because the approver must not trust the SDK's rendering of what a human is about to sign.
- Security engineering, learned the hard way and documented in public: SECURITY.md, three security releases, and vulnerable npm versions deprecated rather than quietly patched. The class of bug I keep finding is trust boundaries — an agent-controlled string reaching an HTML page, a buyer's claim treated as a fact, a revoked signer that can come back.
- Also built, in the same repo: Solidity/EVM contracts (an earlier attempt at the same problem, kept for reference), an XRPL experiment, and a native Swift approver for iOS.

Previous companies: none. This is my first project. What I can point at instead is the work itself, in public:
- GitHub: https://github.com/Mesher589/paydlux (75 commits, 2026-10-29 → 2026-11-03)
- npm: https://www.npmjs.com/package/@paydlux/agent (22 versions)
No LinkedIn profile — the GitHub and npm histories above are the verifiable record.

AI disclosure (per Open Track guidance): this project is AI-assisted. Part of the commit history is authored by an AI coding agent under my direction, including test suites and documentation. I own the architecture, the threat model, and every merge decision, and the check suites are run against live networks rather than trusted as written. I would rather state this up front than have it found in the git log.
```

---

## Target Markets & Jurisdictions

**Which countries or regions will your project target or operate in?**

```
Global / Not region-specific
```

Rationale to paste if the form allows a note: Paydlux is a payment rail and open-source SDK for AI agents — usable by any developer anywhere, with no country-specific product at launch. The only hard geographic constraint is the end-user surface (a hosted approval desk), which is reachable worldwide and holds no customer funds.

**Where is your team based?**

⚠️ Pick your actual EU country in the dropdown. I did not guess it. If the dropdown only offers regions, choose **Europe / European Union**.

**Will your project involve any local currencies, local payment rails, or local financial infrastructure?**

```
No
```

Explanation to paste if a note is allowed: No fiat on/off-ramps, no local banking or mobile-money integration, no domestic payment processing, no locally issued or self-issued stablecoins. Paydlux moves only Circle-issued USDC on Stellar (and XLM as a settlement asset), between a user's own vault and a payee they choose. Paydlux never custodies third-party funds: the vault is the user's own Stellar account, and the human half of the signing key never leaves their device.

---

## Referral Information

**Have you been working with someone from SDF or the broader Stellar community on your submission?**

```
No
```

If the form has an optional "who / code" field, leave it empty. Do not invent a name.

---

## Before you submit — three things that matter more than the wording

1. **The interest form is a gate, not the award.** It is reviewed on a rolling basis; if eligible you get emailed an invitation and a deadline for the full Build proposal. The full proposal is where the real work is: per-tranche deliverables with costs attached, a complete architecture outline, and a budget. Budget cap is $150k in XLM, paid 10/20/30/40.
2. **Competitors already funded.** SCF #45 funded "AgentSmith x402: Stellar Facilitator and Bazaar Discovery" and "Rail402: x402 Facilitator + Bazaar for Stellar". Expect a reviewer to ask how Paydlux differs. The answer, and it is a real one: those are the *seller/facilitator* side (clearing and discovery for x402 payments). Paydlux is the *buyer-side spending control* primitive — the mandate and the human veto. They are complementary, and Paydlux can settle through a facilitator rather than competing with one. Say this in the full proposal, not the interest form.
3. **Do not overclaim traction.** The mainnet activity is 6 transactions, and the honest framing is "a verified end-to-end payment on mainnet, not volume". Reviewers check Horizon links. Everything above is link-checkable; nothing above is rounded up.
