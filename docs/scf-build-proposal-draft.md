# SCF Build Proposal — FULL DRAFT (Open Track)

Drafted 2026-11-04, before the invite email arrives. When the invitation lands,
paste these sections into the form fields and re-verify every number against
Horizon/npm/git the day you submit (they move).

Rules this draft is built to (SCF handbook, checked 2026-11-04):
- Cap $150k in XLM; paid in 4 payments: T0 10% at award, then 20/30/40 on the
  three deliverable tranches. Each tranche submitted within 90 days of last payment.
- Three tranches, final one = Mainnet launch. Each deliverable needs: cost,
  realistic timing, and how reviewers verify it.
- Timeline ≤ 6 months.
- Tranche 2 must include a threat model and a monitoring plan (new requirement).
- No marketing/user-acquisition costs. Budget = dev hours + direct project costs.
- "Requesting the maximum award is not expected; overreach performs poorly."
  → We ask **$95,000**, not $150k. Solo builder, 6 months, the math is shown.
- Audit Bank: credits granted on testnet-tranche completion → the external audit
  line is a top-up, not the full cost.

---

## 1. One-paragraph summary

Paydlux is a spending-mandate primitive for AI agents on Stellar: the vault is a
2-of-2 account, the agent's key is one signer, and the mandate — a pre-authorised
transaction hash whose operations are exactly "pay N to P, in asset A, in window
T, once" — is the other. The human veto is enforced by the ledger's multisig
threshold, not by app code, so a prompt-injected or compromised agent cannot move
money no matter what ceiling is configured. It is live on mainnet today: 22
successful vault transactions, including five escrow releases whose second
signature came from a native iOS approver on a phone. This proposal funds the
distance between "proven prototype" and "production primitive": hosted
onboarding, installable approver apps, an external audit, and integrations with
agent frameworks — in 6 months, $95,000.

## 2. Problem and positioning (incl. the competitor question)

x402/HTTP-402 agent payments are shipping now. SCF #45 funded **AgentSmith x402**
and **Rail402** — both are the *seller/facilitator* side: clearing and discovery
for agent payments. Paydlux is the *buyer-side* control primitive: the mandate
and the human veto. They are complementary layers, not competitors — a Paydlux
vault can settle through an SCF-funded facilitator. Every funded x402 project
assumes the buyer's agent can pay safely; nobody has funded the thing that makes
that assumption true.

The status-quo defence in every agent-payment stack is a soft ceiling in the SDK
($5/tx, $50/day). A ceiling is a seatbelt, not an airbag: a prompt-injected agent
that can talk past a config value can talk past any number written in code.
Paydlux removes the automatic path entirely.

## 3. Current traction (verified 2026-11-04 — re-verify at submission)

Mainnet vault `GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB`
(thresholds 2/2/2; signers: agent key, human key, mandate hash; Circle USDC
trustline): https://horizon.stellar.org/accounts/GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB

- **22 successful mainnet transactions** on the vault.
- **5 escrow releases signed by the human approver's iPhone** — the human veto
  proven end-to-end with real money via native claimable balances (machine +
  phone 2-of-2, time-locked):

  | order | release tx (explorer: stellar.expert/explorer/public/tx/…) |
  |---|---|
  | ord_phone_mainnet_2 | 60c56764533c89c75227f5f27d85c89b49a4761788e5b3e673ee9e97cb56c144 |
  | ord_phone_take3 | 23862737111b8e67658982e7110ed4bfac9d049e63a1546ad61e6efc9e57db3a |
  | ord_phone_take4 | 602689ab2539c3e196a34d76487997542c5fb006591e67f084b04c99555ed439 |
  | ord_phone_take5 | 6d89d21adb3d01f46dfe7a98642890d5626d583b0c29fa2f1a6d8cd242df5471 |
  | ord_phone_take6 | 0d394546c9e8304395149ec22e53349bcb93001e7192eeb482809bcd5c47288e |

  Each release tx carries memo `release <order>` and exactly two signatures
  (machine key + phone approver key), verified cryptographically against the
  envelope — not just from app logs.
- Live public surfaces: demo.paydlux.com (full 402 loop, no install),
  donate.paydlux.com (seller door), desk.paydlux.com (approval desk), paydlux.com.
- npm `@paydlux/agent`: **4,216 downloads last month**, 24 versions, latest 0.1.22;
  vulnerable early versions deprecated, not left up.
- GitHub: **79 commits**, ~11k lines TS (8.2k Stellar layer), 21 executable check
  suites, 140+ checks against live networks. github.com/Mesher589/paydlux
- Bugs the checks caught (the ones a demo never shows): XLM vault blind to its own
  money; changeTrust that would have bricked a vault at creation; XSS into the
  approval screen; daily budget that reset on restart (now seeded from ledger).

Honest framing: this is depth of proof, not volume. No customer funds at risk yet.

## 4. Architecture (what exists, what gets built)

Existing (all MIT, no smart contracts):
- **Vault lifecycle** — create 2-of-2 vault, register/revoke mandate signers
  (preauth_tx_hash, 10-min validity), settle, withdraw. @stellar/stellar-sdk v17.
- **Mandate engine** — pre-built payment envelope as weight-1 signer; any change
  to amount/payee/asset/window or reuse fails signature verification on-chain.
- **Escrow** — native claimable balances, claimants = machine + human, time-locked;
  the desk never holds money or the human key. Release = phone signature on
  claimClaimableBalance. (Proven: the 5 txs above.)
- **Gateway/seller side** — HTTP 402 surface; payment accepted only after Horizon
  confirms: landed, in full, right asset, right order memo, right source account,
  successful tx. Five separate refusals because a buyer's claim is attacker text.
- **Approver** — PWA (WebCrypto Ed25519, non-extractable key, seed never leaves
  device) + native iOS app with its own XDR decoder (32 byte-exactness checks vs
  SDK); rejects path payments, merges, signer changes, multi-op txs.
- **Spending policy + rules editor** — per-payment ceiling, daily budget, seller
  allow/deny list, and **named transaction categories** with their own ceilings,
  edited by the owner in a browser at `/rules` and persisted to the vault config.
  A category can only tighten the mandate, never widen it (42 checks in
  `stellar/policy-check.ts` prove the asymmetry, the queue accounting, and that a
  cross-origin POST cannot raise a budget). Shipped 2026-11-04 in response to
  public demand on X (@Mrchrisxyz: "customizable approval policy … spending
  limits, approved wallet addresses, transaction categories, daily budgets").
- **CLI** — `paydlux setup|sell|status|approver`; one command to a funded,
  trustlined vault.

To build (this award):
- Hosted vault onboarding + key recovery (currently laptop-bound).
- Signed iOS (App Store/TestFlight) + Android approver.
- Soroban policy layer evaluation: daily spend totals across mandates — the one
  thing the ledger can't count natively. Contract, if built, is open-sourced.
- Framework integrations: Vercel AI SDK, LangChain tool wrapper, OpenAI Agents
  SDK — each a thin adapter over the npm SDK.
- External audit of the signing path + ledger verification (Audit Bank credits +
  top-up).

## 5. Tranches (deliverables → cost → how reviewers verify)

### Tranche 1 — MVP hardening (months 1–2) — $19,000 (20%)
| Deliverable | Cost | Verification |
|---|---|---|
| Hosted onboarding: browser vault setup, funded via friendbot/anchor flow, no CLI needed | $7,000 | URL + Horizon: reviewer creates a vault in <5 min, sees it on-chain |
| Escrow release GA: claimable-balance escrow in the public SDK + docs | $5,000 | npm version + runnable example; txs on testnet+mainnet |
| Key recovery v1: mandate revocation, signer rotation, recovery document | $4,000 | documented procedure executed on testnet vault, Horizon-verified |
| Always-on deployment: 24/7 hosting of gateway+desk, uptime monitoring | $3,000 | public uptime page; desk reachable during review window |

### Tranche 2 — Testnet program + threat model + monitoring (months 2–4) — $28,500 (30%)
| Deliverable | Cost | Verification |
|---|---|---|
| Threat model (full doc: key compromise, prompt injection, replay, mandate forgery, XSS-to-approver, desk takeover) | $4,000 | published in repo; reviewed by panel |
| Monitoring plan + live telemetry: vault anomaly alerts, failed-verification counters, uptime SLO | $5,000 | public status page; alert rules in repo |
| Signed iOS approver on TestFlight + Android build | $6,500 | TestFlight link + APK, reviewers install |
| Testnet integrator program: 3+ third-party devs run the full loop on testnet | $8,000 | their txs on testnet Horizon, named in report |
| Soroban policy-layer evaluation + prototype (daily spend across mandates) | $5,000 | repo + testnet contract if built (open source) |

### Tranche 3 — Mainnet launch (months 4–6) — $38,000 (40%)
| Deliverable | Cost | Verification |
|---|---|---|
| External audit of signing path + ledger verification (Audit Bank credits + top-up) | $16,000 | published audit report, findings resolved |
| App Store / Play Store release of approver | $4,000 | store listings |
| Framework integrations shipped: Vercel AI SDK, LangChain, OpenAI Agents SDK | $10,000 | published packages/examples; demo txs |
| Mainnet production launch: hosted onboarding GA, docs site, 3+ live integrations | $12,000 | live URLs + Horizon txs from third-party vaults |

Budget total: **$85,500** in tranche deliverables + **$9,500** T0 (10% at award:
kickoff, infra deposits, Audit Bank onboarding) = **$95,000**.

Hour sanity: ~700 engineering hours over 6 months (solo + contract help for
mobile/audit response) at ~$95/hr ≈ $66.5k, plus hosting $3k, store/dev accounts
$1.5k, audit top-up $16k, testnet-program support $8k. Matches the tranche
table; no marketing, no user acquisition, no operational padding.

## 6. Open source plan

Everything stays MIT: SDK, gateway, approver, CLI, check suites. If the Soroban
policy layer is built, the contract and tests are open-sourced from day one.
No token, no custom consensus, no closed core.

## 7. Team

Solo builder (Individual submitter). Six days produced the existing stack:
79 commits, ~11k lines TS, 24 npm releases. Stellar depth: sdk v17, thresholds/
signer weights, preauth tx hashes, trustlines, XDR (wrote a standalone decoder
because an approver must not trust a library's rendering of what a human signs).
Security track record in public: SECURITY.md, three security releases, vulnerable
versions deprecated. AI-assisted development disclosed up front; architecture,
threat model, and merge decisions owned by the founder. Part of tranche 2/3
budget assumes contract help for mobile + audit response (bus factor named, not
hidden).

## 8. Why fund this now

The agent economy will have a payment rail whether or not the buyer side is
safe. Every funded x402 project this round assumes agents can pay; Paydlux is
the primitive that makes the assumption true, using only native Stellar features
— multisig, preauth hashes, claimable balances — which is why it is a Stellar
project and not an EVM one. The prototype is proven on mainnet with real money
and a real phone. The award buys the last mile to production, in 6 months, at a
solo-builder budget with the math shown.

---

## Notes for when the invite arrives (do not paste these)

1. Re-verify every number the day of submission: Horizon tx count, npm
   downloads/versions, commit count. They only move up.
2. If the form asks for the 4-payment schedule explicitly: T0 $9,500 / T1
   $19,000 / T2 $28,500 / T3 $38,000.
3. If asked why tranches aren't literally "MVP→testnet→mainnet": mainnet
   prototype already exists (that's the traction); the tranches keep the shape —
   MVP hardening → testnet integrator program → mainnet production launch — and
   the handbook allows a defined path as long as the final tranche is mainnet.
4. Audit Bank credits arrive at tranche-2 completion; keep the $16k audit line
   as top-up + audit-response engineering, and say so.
5. Do not raise the ask to $150k. Overreach is explicitly penalised in review.
6. The demo recording (phone+desk side-by-side MP4) is optional garnish; the
   Horizon links are the evidence. If time allows before submission, render it.
