# Applications — ready to submit

Four targets, chosen 2026-11-05. Field-by-field answers below are drafted and fact-checked.
Anything in `[[SQUARES]]` only the founder can supply. Nothing here has been submitted.

**Identity supplied 2026-11-05:** Sebastian Sikora · founder@paydlux.com · Warsaw, Poland ·
**no LinkedIn** (see the LinkedIn note at the bottom — it is the one field still open).

**Deck:** `brand/deliverables/paydlux-deck.pdf` — 10 slides, 16:9, built from `brand/deck.html`.
Needs a public URL before the Afore form is filled (see "Hosting the deck").

---

## 1. Afore Capital — Afore Alpha, pre-seed checks

Form: `https://airtable.com/apprAAsE4JhFBd8nL/pagQ6YvjLzhmbBGML/form`
Their own words: "any industry or located anywhere in the world", "never need a referral",
"it doesn't need to be incorporated", "we do not require traction (or even a product) at all".
$50k–$2m. Their filter: "exceptionally talented founding teams with technical + operational chops"
and "show us why you're best suited to tackle the problem".

| Field | Answer |
|---|---|
| First and last name * | Sebastian Sikora |
| Email * | founder@paydlux.com |
| LinkedIn URL * | **open — no account exists.** See "The LinkedIn problem" below. |
| Applying to * | **Pre-seed checks** |
| Company name | Paydlux |
| Pitch deck URL | `[[public link — see "Hosting the deck"]]`. Deck is built: `brand/deliverables/paydlux-deck.pdf`. They call it "strongly suggested" for pre-seed checks. |
| Location * | Warsaw, Poland |
| ~5 sentences * | see below |
| Current realized monthly revenue * | `0` |
| Co-founder? * | **Working solo** |
| Voice AI call opt-in | **No thank you** |
| How did you hear about this? * | **Social media post (Twitter / Linkedin)** |

**The 5-sentence answer:**

> AI agents are now buying things — APIs, data, compute, other agents — and there is no way to
> pay them that a human can safely authorise. Paydlux is that way: an agent gets a mandate with a
> per-payment ceiling, approved wallets, a daily budget and named categories, and it pays inside
> that box without asking anyone; anything outside it stops and waits for a human signature on
> their phone. The ceiling is committed into the signed transaction itself, so the agent cannot
> widen its own authority — the limit is enforced on-chain, not in our code. I landed on it by
> building the seller side first and discovering that every buyer I talked to had the same
> blocker: nobody would let an autonomous process hold a card or a key. I like this problem space
> because it is a rail, not an app: whoever owns the authorisation layer for agent spending sits
> under every agent economy that gets built. Live now: https://demo.paydlux.com — click "Run the
> loop" and approve the payment from a phone.

---

## 2. Boost VC — Fellowship, $50K for 3%

Form: `https://boostvc.fillout.com/boostfellowship` — **applications due 12/1**.
Their thesis: crypto is one of their named categories, they invest globally, "cockroaches",
"Energy, Authenticity, Intelligence". For the $500K pre-seed check there is no public form —
their process starts with a call, so that one goes by email to the team.

| Field | Answer |
|---|---|
| Full name * | Sebastian Sikora |
| Email * | founder@paydlux.com |
| LinkedIn URL * | **open — no account exists.** See "The LinkedIn problem" below. |
| Location * | Warsaw, Poland |
| How did you hear about Boost VC? * | An X post listing pre-seed funds that back pre-revenue founders outside the US (2026-11-05) |
| Why did you decide to become a founder? * | see the founder answer below — his words, grammar only |
| Startup name * | Paydlux |
| One-liner * | A payment rail for AI agents, with a human signature in the loop. |
| Progress so far * | see below |
| What does a $50K check unlock? * | see below |
| Deck / demo / video | `https://demo.paydlux.com` + `https://github.com/Mesher589/paydlux` + `[[deck PDF link]]` (the form takes an upload too) |

**Progress (all verified today, nothing inflated):**

> It is built and it moves real money. 23 successful transactions on Stellar mainnet from the
> Paydlux vault (`GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB`), including a payment
> that was released only after a human signed it on a real iPhone — the escrow is a claimable
> balance that the agent cannot touch alone. Public npm SDK `@paydlux/agent`, 25 releases, latest
> 0.1.23, 4,583 downloads in the last 30 days. Public repo, 85 commits. Four live surfaces:
> paydlux.com, demo.paydlux.com, desk.paydlux.com, donate.paydlux.com. A Stellar Community Fund
> Build application is in. Revenue: zero, and I am not going to dress that up.

**What $50K unlocks (draft — edit to what you'd actually do):**

> Two things I cannot do by shipping at night. First, make the buyer side real: three named
> integrations where an agent actually pays for a metered API and a human approves on their phone,
> which is the proof every funder asks for after the demo. Second, stop being an unincorporated
> person who cannot sign a contract or hold a bank account — entity, accounting, and the compliance
> work that a money product needs before a US fund can wire anything.

---

## 3. Underscore VC — email

To: `hello@underscore.vc` · Subject: **Paydlux — an AI agent that can pay you, and a human who has to say yes**

> We built the payment rail for AI agents that buy things.
>
> An agent gets a mandate: a per-payment ceiling, a list of approved wallets, a daily budget, and
> named categories. It pays inside that box without asking anyone. Anything outside it stops and
> waits for a human to sign on their phone. The ceiling is committed into the signed transaction,
> so the agent cannot widen its own authority — the limit is enforced on-chain, not in our code.
>
> Live on Stellar mainnet: 23 settled transactions, one of them released only after a real iPhone
> signature. Public SDK `@paydlux/agent`, 4,583 downloads in the last 30 days. Demo you can click
> right now: https://demo.paydlux.com
>
> Pre-seed raise, no revenue yet, working solo from Warsaw, Poland. Two minutes this week?

Their thesis is *applied* AI and they are geography-agnostic with $500K first cheques — the first
paragraph is deliberately about a working product, not a model.

---

## 4. Array VC — email

To: `deals@array.vc` — same body, swap the first line for:

> Infrastructure for the agent economy: when an AI agent buys an API, who authorises the payment
> and who is liable if it buys the wrong thing?

They list AI infra, dev tools and fintech — Paydlux is all three, and they want a first cheque of
$250K–$3M. **Read "Are these firms real?" below first: Array already funds Sapiom, a company selling
payment controls for AI agents.** Same category. Send the deck, not the design internals.

---

## The founder answer (Boost's "why did you decide to become a founder?")

His words, grammar tidied, nothing added:

> I was retired, and I got bored — I wanted something new to work on. For a while now I have been
> building small projects with AI agents, and they kept hitting the same wall: they could do the work,
> but they had no way to pay for anything. Nothing existed that I could hand an agent and still safely
> authorise as a human. So I stopped looking for one and built the thing I was missing. It is live on
> Stellar mainnet now. I am not chasing a market — I am solving a problem I ran into myself.

Cut on purpose: the winter-garden line (opaque to a stranger) and any hint of apology for being
retired. Kept: "retired and bored", because it is true, it is unusual, and Boost's own FAQ asks for
authenticity over polish.

## The LinkedIn problem

Afore and Boost both mark it **required**, and an Airtable/Fillout required field will not accept a
blank. Options, in order of preference:

1. **Create a minimal LinkedIn** — real name, "Founder, Paydlux", Warsaw. Ten minutes. Investors look
   at it anyway, and a missing one is a small, avoidable deduction.
2. Put the GitHub profile in that field instead. It is a real, verifiable profile
   (`github.com/Mesher589/paydlux`, 85 public commits) and it is honest about what it is. Weaker than
   a LinkedIn, better than a blank or a lie.
3. Do not submit to those two until 1 or 2 is settled. Underscore and Array are email — no LinkedIn
   needed, so those two can go out today either way.

## Deck

Built: **`brand/deliverables/paydlux-deck.pdf`** — 10 slides, 16:9, in the site's own design language
(Instrument Serif / Archivo / JetBrains Mono, the same ink-and-gold palette as paydlux.com).
Source: `brand/deck.html`; regenerate with the print step below.

1. Title and one-liner
2. The problem — agents can buy, cannot pay
3. Why now — machine counterparties, metered APIs, cheap programmable rails
4. The product — mandate → inside the box → outside the box → a person signs
5. How it is built — split keys, claimable-balance escrow, ledger-seeded budgets, rules only tighten
6. Traction — 23 mainnet transactions, 4,583 npm downloads/30d, 89 commits, revenue 0 stated plainly
7. The demo — the live desk screenshot, "not a mockup" (OCR-checked: amounts, seller address,
   public agent signatures and TX hashes only — no PIN, key, seed or URL in the image)
8. The raise — three integrations, an entity, a buyer SDK, a published mandate format; pricing unset
9. Risks out loud — no demand proof, moving standards, solo and unincorporated, one chain proven
10. Founder and the ask

Regenerate: open `brand/deck.html` in a browser and print to PDF, 1280×720 px pages, no margins,
background graphics on.

### Hosting the deck — done

**Live: <https://paydlux.com/deck.pdf>** — 200, `application/pdf`, 447,063 bytes, sha256
`a7f1fc33…51ec3` identical to `brand/deliverables/paydlux-deck.pdf`. The edge can serve a stale
`cf-cache-status: HIT` for ~10s after a deploy: re-check with `?v=n` before concluding a deploy failed.

`site/robots.txt` now carries `Disallow: /deck.pdf`, so the deck is unlisted rather than indexed:
anyone with the link can read it, search engines should not surface it.

Note for future deploys: `npm run site:deploy` calls bare `wrangler`, which is **not installed** on
this machine — the shell exports `NODE_ENV=production`, so `npm install` prunes devDependencies.
Install once with `NODE_ENV=development npm install --save-dev wrangler`, then deploy with the
credentials from `~/.hermes/secrets/cloudflare.token` (that file is two `KEY=value` lines, so
`CLOUDFLARE_API_TOKEN=$(cat …)` produces an invalid header — grep the line and `cut -d= -f2-`).

---

## Are these firms real? (checked 5 Nov 2026)

The four funds are real and independently verifiable. The two X accounts that listed them are not
funds and are not a reliable source — treat them as leads, then verify each fund itself, which is
what was done here.

| Firm | Verifiable record | Notes |
|---|---|---|
| Afore Capital | SEC exempt reporting adviser, **CRD 285601 / SEC 802-110177**, registered since 9 Mar 2017, 17 VC funds, $731.9M gross private-fund assets, 680 2nd St, San Francisco. Domain `afore.vc` registered 2016. | Real. See the data caveat below. |
| Boost VC | Operating since 2012 (`boost.vc` registered 2012), ~$400M AUM, 440 startups funded, 6 unicorns; portfolio includes Deepgram, Colossal, Radiant Nuclear, K2Space. Founder reviews of the 2016 batch on Hacker News. | Real. No fee is charged to apply. |
| Underscore VC | SEC exempt reporting adviser, **CRD 283164 / SEC 802-107555**, Boston, $451M regulatory AUM, 9 funds, Form D filings for Fund II ($117M, 2018), Fund II Extension ($18M, 2022), Fund III ($58M, 2023); named principals Michael Skok, John Pearce et al. `underscore.vc` registered 2016. | Real. |
| Array Ventures | `array.vc` registered 2015, founded 2016, SF, ~$250M AUM across 4 funds, 80+ investments, 11 staff on LinkedIn. Contact `deals@array.vc`. | Real — **but see the conflict below.** |

**Do not confuse Array Ventures (`array.vc`) with Array Capital (`arraycapital.com`)** — the second
is a Zürich sell-side M&A advisory with no relation to the fund in that X post.

### What the two X posts actually are

- **@vahidf24 ("Vee")** — ex-VC, now founder of a fundraising product (@Evalyze_ai), ~2K followers,
  follows 824. The list is content marketing for his own tool: useful as a directory, not vetted.
- **@JoinFoundersHub ("Founder's Hub")** — joined **December 2025**, 221 posts, ~1.1K followers,
  11 following, links a Discord. An engagement account, not an investor and not a referral channel.

Neither one is investing anyone. Applying because their post says so costs nothing; treating them as
a source of facts does.

### The data we are actually handing over

Name, email, city, a LinkedIn, and a public link to the deck. No code, no cap table, no customer
data, no keys, no wallet secrets. That is the normal price of an application. Three real caveats:

1. **Afore redistributes the application.** Their own FAQ: they share founders' applications with
   investors in their curated network unless you email `jack@afore.vc` to opt out. Decide before
   submitting, not after.
2. **Array Ventures already funds a direct competitor.** Their portfolio lists **Sapiom — "payment
   infrastructure and spending controls for AI agents"** (Series A), plus agent companies Runable and
   Happyrobot. They are a fine thematic fit *and* a fund that now owns a rival in the same category.
   Send the short version, not the internals, and expect them to be slow or cold on it.
3. **`paydlux.com` was registered 30 Oct 2026 — six days old.** That is the weakest trust signal in
   the whole application, and it is ours, not theirs. The live demo and the mainnet ledger history are
   the counterweight; do not hide the date, and do not backdate anything.

### What to refuse, from anyone

A fund or "accelerator" that asks to be paid a fee to apply or to be listed; asks for private repo
access, a seed phrase, a private key, or a wallet they control; DMs first with generic praise; or
offers a term sheet before a call. None of the four above has done any of this. If one does, it is an
impersonator using a real firm's name — check the sender domain against the CRD record above.

