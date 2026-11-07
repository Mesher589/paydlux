# SCF #46 — paste sheet (field by field, in form order)

Round: **SCF #46 (November 9, 2026)** ✓ already set
Build Award Track: **Open Track** ✓ already set

---

## Submission Title * (max 40 chars)
```
Mandate-as-Contract on Soroban
```
(30 chars; names exactly what the funding buys. Alternatives if you prefer tone:
```
Soroban spend-guard for AI agents   (33 chars)
No overspend: contract budgets      (30 chars)
```
)

## Project Type *
Pick the closest to **"End-User Application"** (it was "Financial Protocols" on the
interest form — match whichever option the dropdown actually offers; both fit).

## Project URL
```
https://paydlux.com
```

## Technical Architecture Document *
```
https://github.com/Mesher589/paydlux/blob/main/docs/technical-architecture.md
```

## GitHub URL
```
https://github.com/Mesher589/paydlux
```

## Video URL
Leave empty (optional). If you want it: brand/deliverables/approval-flow.mp4 is a
ready <3-min pitch — needs a YouTube upload from your Google account first.

## Products & Services *
```
Paydlux gives AI agents a wallet they cannot overspend. Products live today:

• Donation door (donate.paydlux.com) — a mainnet Stellar door taking XLM and Circle
  USDC for a human recipient, with per-payment and daily caps the door refuses to
  breach. Stellar used for: Horizon payment XDRs, trustline/asset identity rules,
  memo-bound order matching.

• Agent payment SDK (npm @paydlux/agent) — any agent speaks the HTTP-402 payment
  loop and pays in XLM/USDC without ever holding a key. Stellar used for: the whole
  settlement rail (build → sign at the vault → verify on Horizon before release).

• Approval desk + phone approver (desk.paydlux.com) — the human half of the
  mandate: category rules, wallet allowlists, per-payment cap, daily budget seeded
  from the ledger so restarts cannot reset it; approvals from an iPhone over TLS.

• Demo showcase (demo.paydlux.com) — the complete 402 loop, testnet, no install.

This submission builds the Soroban layer: mandate-as-contract so the budget ceiling
and category rules are enforced ON-chain at execution time, session/escrow budgets
minted per task, and on-chain payment attestations anyone can audit. Impact: removes
the last trusted off-chain component and makes Paydlux the default spend-control
primitive for agents on Stellar.
```

## Traction Evidence *
```
• Live mainnet vault with 26 successful transactions:
  https://horizon.stellar.org/accounts/GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB/transactions?limit=200&order=desc
  (explorer view: https://stellar.expert/explorer/public/account/GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB)
• Live doors reviewers can use right now: https://paydlux.com ·
  https://demo.paydlux.com (full loop, testnet) · https://donate.paydlux.com (mainnet) ·
  https://desk.paydlux.com (approval desk + phone approver)
• npm SDK @paydlux/agent: 4,697 downloads in the last month, 25 releases
  (https://www.npmjs.com/package/@paydlux/agent)
• 98 commits, ~11k lines TypeScript (8.2k in the Stellar layer), 21 executable
  test suites run on every release:
  https://github.com/Mesher589/paydlux
All figures verified 7 Nov 2026.
```

## Resubmission Feedback
Leave empty (first submission).

## Ambassador Affiliation *
Select **No affiliation** (or the "None" option).

## Thumbnail *
Upload: `/users/project1/brand/deliverables/scf-thumbnail-16x9.png`
(1920×1080, on-brand)

## Team Members
Leave empty — solo builder.

## Mailing List *
**zii137** chip ✓ (keep it)

## Team Description *
```
Solo builder — Sebastian Sikora, Warsaw, Poland. One person, full time, and that is
stated plainly rather than dressed up: every line of the 11k-line TypeScript codebase,
all 25 npm releases and all 26 mainnet transactions ship from one builder who runs
the product publicly, bugs and all. That is the upside for a funder: no coordination
tax, decisions land in days, and the whole surface (site, demo, mainnet doors, repo)
is maintained under one accountable name. For finalist stage I will bring in one
named advisor for the audits and enterprise pilots track.
```

## Budget *
```
95000
```
(USD worth of XLM. Deliberately under the $150k cap — scoped to what one builder
can actually deliver in 6 months.)

## Tranche #1 Deliverables *
```
• Mandate model V2 — categories, per-merchant caps, session budgets off-chain first: $8,000
• Soroban contract design — mandate-as-contract spec, budget state, rule schema: $5,000
• SDK v0.2 — session budgets + budget introspection for agents: $3,500
• Threat model + monitoring — public threat-model doc, anomaly flags on the desk: $2,500
Total: $19,000
```
Verified how: live demo of V2 rules on demo.paydlux.com, published spec, npm release,
repo docs.

## Tranche #1 Completion Date *
```
15/02/2027
```

## Tranche #2 Deliverables *
```
• On-chain mandate enforcement — Soroban contract gates every vault payment: $10,000
• Dual-signature flows — human + agent signatures for high-value moves: $6,500
• SDK v1 — public API for JS/TS and Python, session-budget minting: $6,000
• Developer docs + sample integrations — worked examples, quickstarts: $3,000
• Third-party security review — contract audit + bug-fix window: $3,000
Total: $28,500
```
Verified how: contract deployed to testnet, on-chain demo where a breached mandate
reverts, published docs, audit report.

## Tranche #2 Completion Date *
```
15/04/2027
```

## Tranche #3 Deliverables *
```
• Mainnet launch of the contract-enforced mandate: $10,000
• Self-custody ops tooling — vault rotation, policy import, budget minting UI: $8,000
• Exchange integrations — two anchor/exchange flows accepting mandates: $10,000
• Enterprise pilots — two production deployments with real spend policies: $10,000
Total: $38,000
```
Verified how: on-chain contract live on mainnet, named pilots with real transaction
history, published integration guides.

## Tranche #3 Completion Date *
```
15/06/2027
```

## Legal Acknowledgements
Read and tick (bottom of form).

Then: **submit** — and double-check every red * is satisfied before you do.
