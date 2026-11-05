# VC outreach — the two X posts, triaged

Source posts:
- `https://x.com/vahidf24/status/2118024929085890621` — Vee, part 1 of a 20-part pre-seed list (5 firms).
- `https://x.com/JoinFoundersHub/status/2117802865183900093` — Founder's Hub, 8 firms.

13 firms total. Checked against Paydlux's actual shape: **pre-seed, live mainnet product,
crypto/Stellar, AI-agent payments, solo builder, EU-based, no US entity, no deck yet.**

Every number below was re-verified on 2026-11-05 (see "Traction block").

## Verdict

| # | Firm | Check | Fit | Why / why not | Route |
|---|------|-------|-----|---------------|-------|
| 1 | **Afore Capital** | $500K–$2M+ | **Strong** | Pre-seed, pre-traction OK, "any industry, anywhere in the world", no referral needed. Has crypto/fintech (Fractal, Anagram, Anchorage, Mezo). | Apply form: `afore.vc/afore-alpha` (also `afore.vc/apply`) |
| 2 | **Boost VC** | $500K leading; $50K "Founder Start" | **Strong** | Explicitly crypto + deep tech, invests outside the USA (33+ countries), no demo day, no pitch competition, pre-revenue OK. Wants teams raising ≤$2M. | `apply@boost.vc` + form on `boost.vc` |
| 3 | **Y Combinator** | $500K for 7% + $100K uncapped MFN | **Strong** | Funds anywhere in the world, solo founders accepted, crypto is in the portfolio. Winter 2027 deadline closed 2026-11-02 — apply now for the next batch / early decision. | `ycombinator.com/apply` |
| 4 | **Underscore VC** | $500K–$1M pre-seed | **Good** | "Applied AI" thesis, geography-agnostic, $500K first cheque, 100% first-cheque rate. Paydlux is applied AI + financial services. | `hello@underscore.vc` |
| 5 | **Array VC** | $250K–$3M first cheque | **Good** | B2B deep tech: AI infra, dev tools, fintech. Agent payments sits in all three. | `deals@array.vc` |
| 6 | **2048 VC** | $500K–$3M | **Medium** | Fast-track pre-seed, web3 in their industry list, but stated geographies are US/Canada/UK. | `2048.vc/fasttrack_pitch` |
| 7 | **Speedrun (a16z)** | up to $1M for 10% | **Medium** | Any sector, can apply from outside the US — but the program is 4 months in the SF area and acceptance is ~0.4%. Only worth it if relocation is on the table. | `speedrun.com` |
| 8 | **Techstars** | $220K | **Medium** | One application covers many programs incl. **Techstars Anywhere** (remote). Needs a US corporation or approved foreign equivalent. Deadline 2026-11-18 for the March 2027 term. | `apply.techstars.com` |
| 9 | **Drive Capital Seed Program** | $500K SAFE | **Low** | $80M program, pre-seed OK, but the seed program is built around Austin/Atlanta/Boulder/Chicago/Columbus/Toronto. | `drivecapital.com/seed-program` |
| 10 | **Mighty Capital** | from $200K | **Low** | B2B product-led SaaS thesis, Bay Area. Not a crypto thesis. Contact form, not an apply form. | `mighty.capital/for-founders` |
| 11 | **Mu Ventures** | $200K–$600K | **No** | Their own gate: registered company + **active bank account**, full-time **two-person** team (a hacker and a hustler), commerce/vertical AI, NYC preferred. | Fit-check GPT → Airtable form |
| 12 | **South Loop Ventures** | up to $500K | **No** | "Invests **only** in U.S.-based companies." Disqualifies us today. | `southloop.vc` |
| 13 | **South Park Commons** | $1M ($400K + $600K follow-on) | **No** | "-1 to 0" stage for technologists exploring an idea, SF residency, mostly sourced from their own community. We are past -1 to 0 and not in SF. | `southparkcommons.com` |

**Apply to 5 now, 3 with conditions, skip 5.**

## Ranked order

1. **Afore** — best fit-per-effort. Form, no referral, pre-traction is fine, they already know
   regulated money movement (Anchorage, Anagram).
2. **Boost** — the only firm on either list whose thesis is literally "crypto, pre-revenue,
   outside the USA, no demo day". Dave Friedman's "no-BS" filter is also the kindest test of
   our pitch.
3. **Underscore** — applied-AI thesis, geography-agnostic, $500K first cheque, plain email.
4. **Array** — AI infra + fintech + dev tools, plain email.
5. **Y Combinator** — biggest cheque and the crypto-accepting one, but a long application and
   the Winter 2027 window just closed. Start it, don't rush it.
6. Techstars Anywhere (deadline **2026-11-18**) — only if the entity question is solved.
7. 2048 fast-track — 48-hour answer, cheap to try.
8. Speedrun — only if moving to SF for 4 months is real.

## Traction block (verified 2026-11-05 — cite these, nothing else)

- Live on Stellar **mainnet**: 23 successful transactions from the vault
  `GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB`
  (`https://horizon.stellar.org/accounts/GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB/transactions`)
- Public npm SDK `@paydlux/agent`, latest **0.1.23**, **25** releases,
  **4,583 downloads in the last 30 days** (`api.npmjs.org/downloads/point/last-month/@paydlux/agent`)
- Public repo: `github.com/Mesher589/paydlux`, **85 commits**
- Live surfaces: `paydlux.com`, `demo.paydlux.com`, `desk.paydlux.com`, `donate.paydlux.com`
- A real payment approved from a real iPhone and settled on mainnet (escrow release via
  claimable balances)
- Stellar Community Fund Build application submitted
- No paying customers yet. Say so. Do not imply revenue.

## What blocks a submission

1. **Founder identity** — full name and a real email on a domain we control. Every form asks.
2. **Legal entity** — YC wants a US/Canada/Cayman/Singapore parent; Techstars wants a US
   corporation or approved equivalent; South Loop wants US-only. Afore, Boost, Underscore and
   Array do not require one at first contact.
3. **A deck** — 8–10 slides. Not written yet. Boost and Afore will read a form without one;
   YC and Techstars will not.
4. **Team** — solo. Mu Ventures requires two full-time founders; that one is out on its own rule.
5. **Relocation** — Speedrun and SPC need SF. YC/Techstars want SF for parts of the program.

## Cold email (for the email-route firms: Boost, Underscore, Array)

> **Subject: Paydlux — an AI agent that can pay you, and a human who has to say yes**
>
> We built the payment rail for AI agents that buy things.
>
> An agent gets a **mandate**: a spending ceiling, a list of approved wallets, a daily budget,
> and named categories. It can pay inside that box without asking anyone. Anything outside it
> stops and waits for a human to sign on their phone. The ceiling is baked into the signed
> transaction, so the agent cannot widen its own authority — the limit is enforced on-chain, not
> in our code.
>
> Live on Stellar mainnet: 23 settled transactions, a real payment approved from a real iPhone,
> and a public npm SDK (`@paydlux/agent`, 4,583 downloads in the last 30 days).
> Demo you can click right now: https://demo.paydlux.com
>
> Pre-seed, [AMOUNT] raise. Two-minute call this week?

Swap the second paragraph for the firm's own language when you can: Boost cares that it's
crypto and pre-revenue; Underscore cares that it's *applied* AI; Array cares that it's AI
infrastructure and fintech.

## Do not send

- Anything that claims customers, revenue or pilots. None exist.
- Anything that calls Paydlux an "x402 competitor" without checking what x402 is today.
- The same text to all 13. Five of them will never fund this; a form submission there costs
  nothing but a reply costs the founder credibility.
