# Launch copy — Paydlux

Everything below is true as of 31 Oct 2026 and matches what the code actually
does. Do not post a claim that isn't in this file. The previous version of this
file described the old EVM build (AgentVault, 61 contract tests, Merkle
batching) — that is no longer what we ship, so it was replaced rather than
edited.

Verified today:

- `npx tsx stellar/demo.ts` → 12 checks, `ALL CHECKS PASSED`, live Stellar testnet
- `npm install @paydlux/agent` → installs, imports, `found 0 vulnerabilities`
- https://paydlux.com → live, matches the local build byte-for-byte
- https://github.com/Mesher589/paydlux → public

---

## X / Twitter — main post (paste with the clip)

> AI agents are now paying for APIs over HTTP 402. Most of them are handed a raw
> wallet to do it: no ceiling, no human, no refund path.
>
> Paydlux puts the guardrails on the chain instead. A human sets a ceiling. The
> agent's key physically cannot exceed it. Big buys wait for a person to click
> Approve. Deny, and nothing moves — not even the fee.
>
> 12 checks pass on Stellar testnet. `npm install @paydlux/agent`
>
> https://paydlux.com

Alt text for the clip: *Approval desk showing a parked payment; clicking Approve
settles it on-chain, clicking Deny moves nothing.*

Clip: `brand/deliverables/approval-flow.mp4` (998x450, 4.2s) — X prefers MP4.
`approval-flow-x.gif` is the fallback if the upload is rejected.

## X — thread, 4 posts

1/ An AI agent can buy an API call today. The standard way is to hand it a
wallet key. That key has no ceiling, no approval step, and no way back.

2/ Paydlux: a human registers a mandate — max per payment, daily budget, who may
be paid, when it expires. It lives on-chain. The agent's key is not allowed to
sign anything outside it. The ledger rejects it, not our server.

3/ Bigger buys park until a person decides. A web page shows the amount, what it
buys, and who gets paid. Approve and it settles. Deny and nothing moves — not
even the transaction fee. Replaying a payment is refused. Tampering with an
amount is refused.

4/ It runs on Stellar, so escrow is native multisig and fees are fractions of a
cent. `npm install @paydlux/agent`, MIT, 12 checks pass on testnet, no real
funds at risk. https://paydlux.com

## Show HN

Title: **Show HN: Paydlux – on-chain spending caps and human approval for AI agents**

Body:

> AI agents are starting to pay for APIs over HTTP (x402: HTTP 402 + USDC). The
> usual integration hands the agent a raw wallet key: no spend cap, no human
> approval, no refund path.
>
> We put the guardrails on-chain instead of in the SDK:
>
> - **Mandates.** A human registers a per-payment ceiling, a daily budget, a
>   payee allowlist and an expiry. The agent key cannot sign outside them; the
>   ledger refuses, so a prompt-injected agent cannot overspend by construction.
> - **Human approval.** Above a threshold the payment parks. A web page shows
>   amount / what / who. Approve settles it; deny moves nothing, not even a fee.
> - **No replay.** A mandate is consumed on use, and we check the transaction
>   actually exists on-chain rather than trusting a local record.
> - **Escrow.** Funds sit in a 2-of-2 multisig vault. Release needs the agent
>   key *and* the human key.
>
> We chose Stellar over an EVM chain because escrow is native multisig, USDC is
> real there, and fees are fractions of a cent.
>
> Honest limits: this is a working prototype on Stellar's public testnet, not a
> product. No audit. No customer funds. The approval key is still a file on a
> laptop, which is the next thing we are fixing.
>
> `npm install @paydlux/agent` · MIT ·
> https://github.com/Mesher589/paydlux

## x402 community / Discord one-liner

> Built mandate-enforced payments on the x402 flow: on-chain spending caps,
> native multisig escrow, human-approval portal, replay refused by checking the
> tx exists on-chain. Stellar, MIT, 12 checks on testnet:
> https://github.com/Mesher589/paydlux — feedback welcome.

---

## Where to post

| Channel | Who can post | Note |
|---|---|---|
| X @paydlux | owner in a browser, or API once registered | first stop — we own the account |
| news.ycombinator.com (Show HN) | owner | best reach for this audience |
| x402 Discord / Linux Foundation | owner | the actual buyer audience |
| r/stellar, r/CryptoCurrency | owner | r/stellar is far friendlier than r/crypto |
| Dev.to / long-form | owner | the README is already close to this |

## Claims that are NOT true yet — never post these

- "audited" — no audit has happened
- "handles real money today" — testnet only; mainnet is untested
- "hosted demo" — the demo runs on a laptop, not a server
- "phone approval" — not built; the approver key is a file on disk
- any customer count, revenue, or savings figure — we have none
