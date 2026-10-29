# Launch copy — ready to post

## Show HN / Reddit r/crypto title
> Show HN: AgentVault – on-chain spending caps and human approval for AI agents

## Body (HN)
AI agents are starting to pay for APIs over HTTP (x402: HTTP 402 + USDC). The
standard integration gives the agent a raw wallet: no spend cap, no human
approval, no refund path. In May an agent wallet was drained of ~$150-200k via
prompt injection; the x402 SDK itself shipped without a default spend cap until
Aug 2026.

We put the guardrails on-chain instead:

- Mandates: a human registers per-call / daily / total caps + payee allowlist +
  expiry. The agent key physically cannot exceed them.
- Request-bound signatures: each payment proof is bound to the exact HTTP
  request (method, URI, body hash, nonce). arXiv 2605.30998 showed captured
  proofs being replayed against other resources at up to 100% leakage; our
  fuzz tests (4x512 runs) prove substitution reverts.
- Human-in-the-loop: mandates can require a person to sign the exact payment
  before settlement. Web portal shows amount / what / who. Approvals are
  single-use and payment-bound.
- Escrow with proof-of-delivery, and Merkle-batched settlement at ~$0.00005
  per payment so sub-cent micropayments work.

61 contract tests, MIT, no real funds. Local demo: `node demo-approval.ts`
opens a human approval portal at :4022.

Repo: https://github.com/Mesher589/agentvault

## x402 community / Discord one-liner
> Built mandate-enforced payments on top of the x402 flow: on-chain spending
> caps, request-bound proofs (kills the replay class from arXiv 2605.30998),
> human-approval portal, escrow + Merkle batch settlement (~$0.00005/tx).
> MIT, 61 tests: https://github.com/Mesher589/agentvault — feedback welcome.

## X/Twitter thread (3 posts)
1/ AI agents can now pay for APIs with USDC (x402). Nobody should be giving an
agent a raw wallet. We built the guardrails into the chain itself.
2/ A human sets the rules on-chain: max per call, per day, total, who gets
paid. A prompt-injected agent literally cannot overspend. Every proof is
bound to the exact request it pays for — captured proofs can't be replayed.
3/ And for big buys, a human signs the exact payment in a web portal before
anything moves. MIT + 61 tests: https://github.com/Mesher589/agentvault

## Where to post (needs the owner's accounts — I can't post without them)
- news.ycombinator.com (Show HN) — best reach for this audience
- x402 Discord / Linux Foundation channel
- r/CryptoCurrency + r/base
- X/Twitter from the owner's account
- Dev.to / Mirror.xyz long-form version of the README
