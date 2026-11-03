# SCF Build Interest Form — SUBMITTED

Submitted 2026-11-03 via https://communityfund.stellar.org/ (Indicate Your Interest ->
"I don't have an account"). Page returned: **"Interest form successfully submitted."**
No confirmation email address was captured by the form itself; the contact email below is
the one SDF will use.

This file is the exact text that went in, so the full Build proposal can reuse it.
Field limits enforced by the form: description 1100, traction 1000, integration 1100,
team 2000 characters.

## Project Information

**Project Title**
Paydlux — spending mandates for AI agents, enforced on the Stellar ledger

**Project Description** (1105 chars)
AI agents now buy things over HTTP with stablecoins (x402). Today an agent gets a raw wallet key: no cap it cannot break, no human in the loop. The usual defence is a soft ceiling in the SDK - $5 a transaction, $50 a day. A ceiling is a seatbelt, not an airbag: it does not stop the crash, it decides how much you lose. A prompt-injected agent that can talk past a config value can talk past any number written in code.

Paydlux moves the guardrail onto the ledger. The vault is a Stellar account with spending threshold 2. The agent's key is one weight-1 signer; the mandate is the other, registered as a pre-authorised transaction hash - a transaction whose operations are exactly "pay N to this payee, in this asset, in this window, once". The agent reaches threshold only by presenting it. Change the amount, payee, asset or window, or run it twice, and the ledger refuses. There is no ceiling to raise: there is no automatic path.

Goals: a reusable Stellar primitive for human-approved agent payments, no contract to audit; the human's key kept off the agent's machine; the seller side proven.

**Project Category:** Financial Protocols
(the dropdown offered only "End-User Application" and "Financial Protocols")

**Current Traction** (991 chars)
Live on Stellar MAINNET.
Vault GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB: thresholds 2/2/2, three weight-1 signers (agent, human, mandate hash), live Circle USDC trustline. Verify on horizon.stellar.org.
6 successful mainnet transactions / 9 operations on 2026-11-03, a payment accepted only after Horizon confirmed it landed in full, in the expected asset - and refused when replayed onto a second order.
Anyone can run the real 402 loop: demo.paydlux.com, donate.paydlux.com, desk.paydlux.com, paydlux.com.
npm @paydlux/agent: 3,536 downloads last month, 22 versions.
75 commits, ~11,000 lines TS (8,173 Stellar layer), 21 check suites, 140+ checks on live networks. github.com/Mesher589/paydlux
The checks caught real bugs: an XLM vault blind to its own money, a changeTrust that would have bricked a vault, XSS into the approval screen, a budget that reset on restart.
Stage: working mainnet prototype, real USDC, no customer funds at risk. Missing: hosting, audit.

**Website:** https://paydlux.com

**Planned Stellar Integration** (1091 chars)
Stellar is not an integration here - it is the product. The guarantee is three native ledger features, no smart contract, no Soroban deployment.
1. Circle USDC on Stellar (issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN) is the payment token.
2. Multisig is the vault: thresholds all 2, agent key weight 1, so no payment is possible on the agent's signature alone.
3. A pre-authorised transaction hash is the mandate: a pre-built transaction whose operations are exactly "pay N to payee P, asset A, between T0 and T1, once", registered as a weight-1 signer via set_options. Threshold 2 is reached only by presenting that envelope; any change or reuse fails signature verification on-chain. Revocation removes the signer.
Built on @stellar/stellar-sdk v17: vault lifecycle, Horizon-backed payment verification, an approver app with its own XDR decoder that rejects path payments, merges, signer changes and multi-op transactions, a native iOS approver, and a setup CLI.
Award funds: a Soroban policy layer for daily spend across mandates, hosted onboarding, and an audit.

**Build Track:** Open track (for net-new protocols, primitives, etc.)
(the dropdown offered: Open track / Integration Track / Dev Tooling RFP: coming soon)

## Team Information

**Submitter type:** Individual
**Email:** founder@paydlux.com

**Team Description** (1728 chars)
Solo builder, one person, full time. Better said plainly than dressed up: the upside is that the whole stack - ledger layer, gateway, approver web app, iOS app, docs, tests - is already built and shipped by one person in six days. The risk is bus factor, and I would spend part of the award bringing in a second pair of hands for the audit response.
Expertise: TypeScript/Node (~11,000 lines here, 8,173 in the Stellar layer; npm package with 3,536 downloads last month). Stellar specifically: @stellar/stellar-sdk v17, account thresholds and signer weights, pre-authorised transaction hashes, trustlines, XDR. I wrote a standalone XDR decoder for the approver (32 byte-exactness checks against the SDK) because an approver must not trust a library's rendering of what a human is about to sign. Security engineering learned the hard way and documented in public: SECURITY.md, three security releases, vulnerable npm versions deprecated rather than quietly patched; the bug class I keep finding is trust boundaries. Also in the repo: Solidity/EVM contracts from an earlier attempt, an XRPL experiment, and a native Swift iOS approver.
Previous companies: none - this is my first project. What I can point at instead is the work, in public: github.com/Mesher589/paydlux (75 commits) and npmjs.com/package/@paydlux/agent (22 versions). No LinkedIn profile; those histories are the verifiable record.
AI disclosure, per Open Track guidance: this project is AI-assisted. Part of the commit history, including tests and docs, is authored by an AI coding agent under my direction. I own the architecture, the threat model and every merge decision, and the check suites run against live networks rather than being trusted as written.

## Target Markets & Jurisdictions

**Target markets:** Global / Not region-specific
**Team based in:** European Union
**Local currencies / payment rails / financial infrastructure:** No

## Referral Information

**Working with someone from SDF or the Stellar ecosystem:** No

## What happens next

1. The interest form is a gate, not the award. It is reviewed on a rolling basis; if
   eligible, SDF emails an invitation plus a deadline for the full Build proposal.
2. The full proposal is the real work: per-tranche deliverables with costs, a complete
   architecture outline, and a budget. Cap is $150,000 in XLM, paid 10/20/30/40.
3. Competitors already funded in SCF #45: "AgentSmith x402: Stellar Facilitator and
   Bazaar Discovery" and "Rail402: x402 Facilitator + Bazaar for Stellar". Both are the
   seller/facilitator side (clearing + discovery). Paydlux is the buyer-side spending
   control primitive — the mandate and the human veto. Complementary, not competing:
   Paydlux can settle through a facilitator. Say this in the full proposal.
4. Do not overclaim traction. Mainnet activity is 6 transactions; the honest framing is
   "a verified end-to-end payment on mainnet, not volume". Reviewers check the Horizon links.
5. Side effect to note: the homepage HubSpot email gate was submitted with
   founder@paydlux.com while probing for the form, so that address is now on the SCF
   newsletter list.
