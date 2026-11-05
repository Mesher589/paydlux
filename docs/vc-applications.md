# Applications — ready to submit

Four targets, chosen 2026-11-05. Field-by-field answers below are drafted and fact-checked.
Anything in `[[SQUARES]]` only the founder can supply. Nothing here has been submitted.

**Hard blockers before any of these go out:** full name, a real email address, a LinkedIn URL
(Afore and Boost both mark it required), and your city/country.

---

## 1. Afore Capital — Afore Alpha, pre-seed checks

Form: `https://airtable.com/apprAAsE4JhFBd8nL/pagQ6YvjLzhmbBGML/form`
Their own words: "any industry or located anywhere in the world", "never need a referral",
"it doesn't need to be incorporated", "we do not require traction (or even a product) at all".
$50k–$2m. Their filter: "exceptionally talented founding teams with technical + operational chops"
and "show us why you're best suited to tackle the problem".

| Field | Answer |
|---|---|
| First and last name * | `[[FOUNDER NAME]]` |
| Email * | `[[EMAIL]]` |
| LinkedIn URL * | `[[LINKEDIN]]` |
| Applying to * | **Pre-seed checks** |
| Company name | Paydlux |
| Pitch deck URL | `[[DECK LINK — must be "anyone with link can view"]]` (optional but they say "strongly suggested" for pre-seed checks) |
| Location * | `[[CITY, COUNTRY]]` |
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
| Full name * | `[[FOUNDER NAME]]` |
| Email * | `[[EMAIL]]` |
| LinkedIn URL * | `[[LINKEDIN]]` |
| Location * | `[[CITY, COUNTRY]]` |
| How did you hear about Boost VC? * | An X post listing pre-seed funds that back pre-revenue founders outside the US (2026-11-05) |
| Why did you decide to become a founder? * | `[[ONLY YOU CAN ANSWER THIS TRUTHFULLY — they will smell a written-for-you answer. Draft prompt: what was the moment you decided to build this instead of taking a job? Two or three honest sentences.]]` |
| Startup name * | Paydlux |
| One-liner * | A payment rail for AI agents, with a human signature in the loop. |
| Progress so far * | see below |
| What does a $50K check unlock? * | see below |
| Deck / demo / video | `https://demo.paydlux.com` + `https://github.com/Mesher589/paydlux` + `[[DECK LINK]]` |

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
> Pre-seed raise, no revenue yet, working solo from `[[CITY, COUNTRY]]`. Two minutes this week?

Their thesis is *applied* AI and they are geography-agnostic with $500K first cheques — the first
paragraph is deliberately about a working product, not a model.

---

## 4. Array VC — email

To: `deals@array.vc` — same body, swap the first line for:

> Infrastructure for the agent economy: when an AI agent buys an API, who authorises the payment
> and who is liable if it buys the wrong thing?

They list AI infra, dev tools and fintech — Paydlux is all three, and they want a first cheque of
$250K–$3M.

---

## Deck

Afore says a deck URL is optional but strongly suggested for pre-seed checks; Boost says it's
optional; the two email routes will ask for one in the reply. There is no deck yet.
8–10 slides, built from the numbers above, is the highest-value missing artefact.
