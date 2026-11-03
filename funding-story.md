# Paydlux — why we need the funds

*Written 2026-11-03. Numbers below are from this repo, not a pitch deck.*

---

## The hole in the agent economy

Every AI agent that wants to buy something hits the same wall: it has no card,
and if it had one, nobody sane would hand it one.

So today agents do one of two things. They don't pay at all — they scrape, they
rate-limit, they die at the paywall. Or a human wires them a API key with a
credit card behind it and hopes. Both are losing. The agent web is a wall of
402s that nobody can answer.

The obvious fix is HTTP 402 — "Payment Required" — the status code that has been
reserved and unused since 1997. An agent gets a 402, reads the price, pays,
retries. x402 made that real. What nobody has solved is the next sentence:

> **An agent that can pay is an agent that can be tricked into paying.**

A prompt injection that convinces your assistant to "just buy this" is not a
hypothetical. It is the standard attack. And the current answer in every agent
payment stack is: put a ceiling on it. $5 per transaction, $50 a day. A ceiling
is a seatbelt, not an airbag. It doesn't stop the crash; it just decides how
much you lose when you crash.

## What we built instead

Paydlux puts a **thumb** on the money.

The vault is a Stellar account that requires **two signatures** to spend
anything. One is the agent's key — it lives in the bot, and it can build a
payment. The other is a human's key — it lives on a phone, and it moves only
when a person holds a button down for a second while reading the amount, the
payee, and what the money is for.

That is not a policy check inside our server. It is the ledger's own
multisig threshold. If the human never presses, the transaction is invalid
*on-chain* — not "refused by Paydlux", but structurally unspendable. A runaway
agent, a compromised key, a prompt injection, or a bug in our own code cannot
move a single stroop. There is no ceiling to raise, because there is no
automatic path at all.

And the human is not signing a hash they cannot read. The phone decodes the
transaction locally and shows `4.5000000 AGPAY → GA7GYYMX…` before it signs.
It never sends the seed to us. We never see it.

**The seller side is the harder half, and it works.** A stranger's agent can
pay us from *their* vault, approved on *their* phone. We hold none of their
keys. Our only witness is a public ledger read: did a payment land, in full,
in the right asset, naming this order, from the account this order was issued
to, on a transaction that actually succeeded. Every one of those five clauses
is a separate refusal, because a buyer's claim is attacker-controlled text.

## Proof, not a prototype

Five days of commits (2026-11-03 back to 2026-10-29), 64 commits, ~7,100 lines
of TypeScript in the Stellar layer alone, **336 assertions** in executable
check files. Live right now:

- `https://demo.paydlux.com` — a stranger drives the full 402 loop against a
  real gateway, real mandate, real approval queue.
- `https://desk.paydlux.com` — the approval desk, behind TLS on a domain the
  browser can verify, with the local port pinned so the tunnel can't be driven
  around.
- `https://donate.paydlux.com` — the seller door. Verified end to end against
  the **real ledger** today: order `ord_a22b0090f636`, tx
  `c1dde06072acbdb2…`, ledger **#5531958**, served only after Horizon
  confirmed the money, and the same tx refused when replayed onto a second
  order.
- `@paydlux/agent` on npm — published, and the vulnerable early versions
  deprecated.

The bugs this found are the ones that matter, because they are the ones a demo
never shows you:

- an XLM vault was **blind to its own money** — the balance and daily-spend
  filters dropped native-asset records, so the budget read as unspent forever
  and the ceiling never closed.
- `changeTrust` on a native asset is a ledger error, and it rode in the *same*
  transaction as the signer setup — so a vault would have been created with its
  master key switched off and **nothing able to sign anything ever again**.
- Horizon carries the memo on the *transaction*, not the payment operation. Any
  verification written against the operation record is silently matching
  nothing.
- a page polling for its own order was **minting a new unpaid order every
  poll** — the buyer waits forever and never sees their own payment.
- the approval page rendered an agent-controlled request path into HTML. That is
  XSS into the one screen where a human is about to authorise money. We shipped
  a security release and deprecated the affected npm versions.
- the daily budget reset on restart: `ctrl-c`, start again, the day's total is
  zero. Now it is seeded from the ledger, and the app **refuses to start** if
  that read fails rather than run with a budget that lies.

Every one of those was found by trying to make it real, not by writing a deck.

## What the money is for

We are not asking for money to write code. The code is written, it runs, and it
is public. The blockers are all things a grant buys and a laptop does not:

1. **A machine that is always on.** Everything above currently runs on a
   founder's MacBook. If the lid closes, the approval desk is down, a buyer is
   parked mid-payment, and the tunnel is dead. A payment system that sleeps
   when its author sleeps is not a payment system. This is the single most
   important line item.

2. **Real settlement capital.** The public demo settles in a token we issued on
   testnet. Real money needs a mainnet vault funded in XLM, and a stranger
   paying us needs a reason to believe the asset they're paying in is worth
   anything. The Stellar Community Fund pays in XLM — which is *exactly* the
   asset this product settles in. That is not a coincidence we're exploiting;
   it's why this project is a Stellar project and not an EVM one. Stellar is
   where a payment costs a fraction of a cent, where escrow is a native
   multisig rather than a contract, and where Circle USDC is real.

3. **A phone app strangers can actually install.** The approver today is an
   installable PWA — WebCrypto Ed25519, key in IndexedDB, seed dropped after
   import. It works, and a native iOS build runs on the founder's iPhone. But a
   stranger cannot install a free-provisioning build, and the money-critical
   component of this product should not be a browser tab. An Apple Developer
   account, TestFlight, and a signed Android build are a few hundred dollars and
   a lot of attention.

4. **A real security review.** This product's entire value is that a human
   authorises money. If the signing path has a bug, the value is negative — we
   would be selling a false guarantee. We found and fixed an XSS in the
   approval page ourselves; we should not be the only people who looked. An
   external audit of the signing path and the ledger verification is the line
   item that decides whether this can be trusted with other people's money.

5. **Time to talk to the people who need it.** The buyers here are not
   hobbyists. They are agent frameworks, API marketplaces, and anyone selling
   to bots. Finding them, and shipping the integrations they ask for, is
   full-time work. Right now it is nights.

## Why this is worth funding

The agent economy is going to need a payment rail whether we build this or not.
The question is what the safety story is when it does. "We capped it at $50 a
day" is what everyone is shipping. It fails the moment the attacker only needs
one payment.

Paydlux's answer is that the human's approval is not a feature we enforce — it
is a property of the money itself. That is a Stellar-shaped answer: cheap
enough for micropayments, multisig at the account layer rather than in a
contract, and every payment public and checkable afterwards. The buyer can
verify they were charged correctly without asking us. The seller can verify
they were paid without trusting the buyer.

Five days in, the loop works end to end on a real ledger, the forgeries are
refused by test rather than by promise, and the whole thing runs on free
infrastructure because we have not yet been allowed to need a server.

$150,000 in XLM, non-dilutive, no equity, no debt, buys: an always-on
deployment, real settlement capital, installable approver apps, an external
audit, and someone working on this full time instead of at 2am.

That is the whole ask. The hard part — the design, the verification model, and
the discipline to refuse a payment when the ledger disagrees — already exists,
in public, running.

---

## One-paragraph version (for the interest form)

Paydlux is a payment gateway for AI agents on Stellar that replaces the
spending cap with a human signature. An agent gets an HTTP 402, builds a
payment mandate on its own 2-of-2 Stellar vault, and the transaction is only
valid if a human approves it on a phone — enforced by the ledger's multisig
threshold, not by our server, so a compromised or hallucinating agent cannot
move money no matter what ceiling is set. The seller side verifies incoming
payments drawn on the *buyer's* vault using only public ledger reads, so we
hold no buyer keys and accept no counterparty risk. Five days of work produced
64 commits, ~7,100 lines, 336 executable assertions, a published npm SDK, and
three live services on paydlux.com, including a donation door verified
end-to-end against the real ledger today. The grant funds an always-on
deployment (it currently runs on a laptop), mainnet settlement capital in the
same XLM the product settles in, installable iOS/Android approver apps, and an
external audit of the signing path.

## Where the money goes

| | |
|---|---|
| Always-on deployment + monitoring, 12 months | ~$3,000 |
| Apple Developer + Android, signed approver apps | ~$1,500 |
| External audit of signing path + ledger verification | ~$40,000 |
| Mainnet settlement capital + demo liquidity | ~$20,000 |
| Integration work (agent frameworks, marketplaces), 12 months | ~$70,000 |
| Documentation, examples, support for early sellers | ~$15,500 |
