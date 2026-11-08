# Security policy

Paydlux moves money. We treat that seriously, including when the report is
about us.

## Report a vulnerability

Email **founder@paydlux.com**. If you cannot reach that address, use
**support@paydlux.com**. Both land in the same inbox.

Please include:

- which part you are looking at — the Stellar SDK (`@paydlux/agent`), the
  approval portal, or the older EVM contracts in `contracts/`
- the version or commit
- steps to reproduce, ideally against Stellar **testnet**

We answer within 3 business days. We will tell you what we found and whether we
are fixing it, in plain language, even if the answer is "not a bug".

## What is and is not live

This matters, because a finding against one is not a finding against the other.

| Component | State |
|---|---|
| `stellar/` — SDK, gateway, vault, approval desk | working prototype; mainnet for the vault and escrow proofs, live demo on **testnet** |
| `contracts/` — Solidity `AgentVault.sol` | earlier EVM prototype, **not shipped**, kept for reference |
| Hosted service | none. There is no Paydlux server holding anyone's funds |

There is **no audit** of any of this. The vault and escrow paths have been run on
**mainnet** with the project's own small amounts (proof transactions, listed in
`docs/scf-traction-update.md`); no third party's funds are held, and there is no
hosted service taking custody of anything.

## Scope we care about most

In rough order:

1. Anything that lets a payment be released without both required signatures
   (the vault is 2-of-2: agent key and human key).
2. Anything that lets a mandate be used outside its ceiling, budget, payee
   allowlist or expiry.
3. Anything that lets a consumed mandate or a settled payment be replayed.
4. Anything that lets the approval portal be reached or driven without its
   unguessable portal key.
5. Anything that lets the buyer's agent get executable markup into the approval
   page. The agent controls the request path and body that the human reads
   before approving, so script there runs on the page that authorises payments.
6. Key handling: how seeds are generated, stored, or logged.

## Key handling: what is fixed, and what is not

The original design gap was that the human approval key sat in the same process
as the seller's key, which made "2 of 2" a single point of failure. That is now
split, and the split is tested rather than asserted:

- `stellar/phone.ts` — the seller builds and signs the payment with their own
  half only, and sends it out unsigned by the human. The human's device signs
  offline and returns the signature. The approver seed never travels to the
  seller's machine.
- `stellar/phone-check.ts` — proves on live testnet that the seller alone cannot
  pay (`BAD_AUTH`), the phone alone cannot pay, a swapped transaction is refused
  before signing, and a signature stolen from one payment is rejected when
  pasted onto another.
- `stellar/desk-split-check.ts` and `stellar/e2e-phone.ts` — the approval desk
  runs with no approver key at all and still settles, and refuses a signature
  that belongs to a different payment.
- `phone-app/` — the approver is now a browser app the human opens on their own
  device. It ships its own transaction decoder instead of the SDK, and
  `phone-app/xdr-check.ts` proves that decoder is byte-exact with the official
  SDK on 32 cases. Anything it does not fully parse — path payments, account
  merges, signer changes, multi-operation transactions, fee-bump or v0
  envelopes, Soroban transactions — is refused rather than interpreted.
  `phone-app/desk-app-check.ts` drives the real app against the real desk over
  real HTTP on live testnet, including path traversal and a signature replayed
  onto a different payment.
- The key is imported into WebCrypto as **non-extractable**; only the
  `CryptoKey` object is persisted, never the seed, never a JWK. The app is
  served with `default-src 'none'; script-src 'self'; connect-src 'self'` and no
  inline script, so a script injected into the page can neither read the key nor
  send it anywhere.

## The approval page renders text the buyer controls

The portal shows the human what the agent asked for. `uri` is the request path
the agent sent and `body` is its request body — both stored verbatim and both
rendered on the one page that can authorise a payment. So both are escaped, on
the server (`esc()` in `stellar/portal.ts`) and again in the browser
(`portal-app/portal.js`, which re-renders from polled JSON).

This was a real hole, not a theoretical one: an agent requesting

    /x<img src=x onerror=...>

got that markup injected live into the approval page, same-origin, on the page
holding the portal key. A human clicking Approve on a page the agent can script
is not a human approving a payment. Fixed by escaping every field plus removing
inline handlers and inline script entirely, so the page's CSP is meaningful:

    default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self';
    frame-ancestors 'none'; base-uri 'none'; form-action 'self'

`stellar/xss-check.ts` (`npm run test:portal`) drives hostile paths and bodies
through a real gateway and a real desk, checks none of them survive as live
markup, evaluates the browser renderer directly, and asserts the clickjacking,
referrer and caching headers. It also asserts the two renderers agree — the page
loads server-rendered and is then replaced by the client renderer on each poll,
so anything the client omits vanishes from the human's screen a few seconds
after they act.

Still open, and worth reporting if you find it worse than described:

- The default development path (`DeskConfig.approver`) still accepts both seeds
  on one machine. It is kept for demos and is marked DEV ONLY; `--split` is the
  mode that reflects the real key model.
- The signing device is a browser tab, not a secure enclave. There is no
  biometric gate, no hardware attestation, and nothing proving the device that
  answers the desk is the intended one. Clearing site data loses the key (it can
  be re-imported from the seed; the seed itself is the thing to keep safe).
- The portal key is the only thing between the public internet and the ability
  to *request* a signature. It cannot spend anything by itself — spending still
  needs the approver signature — but a leaked portal key does expose pending
  requests and their amounts.
- The payload travels as text. It is integrity-checked by hash, but not
  confidential, and there is no channel binding between the desk and the device
  that answers it.
- ~~The desk is plain HTTP on a throwaway tunnel.~~ Closed: `story.ts --tls`
  serves the desk over `https://desk.paydlux.com` through a named Cloudflare
  tunnel, with a real certificate, HSTS, plain HTTP 301'd away, the desk bound to
  `127.0.0.1` only, and a `Host` pin so the local port cannot be driven directly
  to skip TLS. `stellar/tls-check.ts` asserts all of it. A desk configured with a
  public hostname also refuses to start without a portal key.
  Still open on that path: the portal key travels in the URL of the link the
  human opens, so it lands in browser history and in any proxy log that sees the
  request line. `Referrer-Policy: no-referrer` and `frame-ancestors 'none'` keep
  it out of third-party `Referer` headers and stop another site framing the
  Approve button, and the desk sets an `HttpOnly; SameSite=Strict; Secure`
  cookie so subsequent requests do not need it in the URL. It is still in the
  history of the device that opened the link. Rotating it per session limits the
  damage; it still cannot spend anything by itself.

## The rules page edits the ceilings that gate money (`/rules`)

The desk now has a page where the owner edits their own spending rules: per-payment
ceiling, daily budget, seller allow/deny list, and named transaction categories with
their own ceilings. That is a form which changes what the human is *asked* to approve,
so it is treated as a money route, not a settings page.

Three properties hold it, all asserted in `stellar/policy-check.ts`
(`npm run test:policy`):

- **Key-gated.** `/rules` requires the same unguessable portal key as `/approve`.
  Without it: 403, no information about whether the route exists.
- **Same-origin-gated.** The same cross-origin POST hole that once let another page
  approve a payment would also let another page raise your daily budget. `/rules`
  shares `/approve`'s `Origin` + `Sec-Fetch-Site` gate, so a form posted from another
  site is refused before the fields are read.
- **A category can only tighten the mandate, never widen it.** Category ceilings are
  checked *after* the base ceilings, so a category limit above the base limit is inert
  by construction. The per-payment ceiling that actually binds is the one baked into
  the mandate's transaction hash; raising it in the form changes a number this file
  counts, and the ledger still refuses above the mandate amount.

Input handling: category names are reduced to `[a-z0-9_-]` before storage, seller
lists accept only `G…` account ids, and a blank or negative number falls back to the
**previous** value rather than a default — so a malformed edit is a no-op instead of a
silent loosening. Deleting a category also deletes its wallet mappings, so no wallet
keeps an invisible ceiling.

What this does *not* do: the rules never approve anything. They decide what the human
is offered. Every payment still needs the human's signature and the vault's 2-of-2.

## Another page could approve a payment (`<0.1.7`)

Found by our own onboarding audit: we installed `@paydlux/agent` into an empty
directory, wrote a seller from nothing but the published README, and tried to
break it the way a stranger would.

`POST /approve/<id>` accepted any origin. A cross-origin `fetch` `POST` with no
custom headers is a CORS *simple request*, so the browser sends it with no
preflight: the hostile page never sees the reply, but the approval happens
anyway. Reproduced in a real browser against a desk started exactly as the
README describes (no `portalKey`):

| | before the click | after |
|---|---|---|
| payment | `pending` | `settled`, on-chain |
| payee token balance | `0.0000000` | `1.0000000` |

One button on a page on another port moved the money. DNS rebinding reaches the
same loopback port from a remote origin, so "it only listens on 127.0.0.1" was
not a defence.

Fixed in `0.1.7`: the mutating routes (`/approve`, `/deny`, `/signed`) now
require `Origin` to name the desk's own host and `Sec-Fetch-Site` to be
`same-origin` or `none`. `stellar/xss-check.ts` asserts both, plus that the
portal's own actions still work. Verified again in a browser: the same attack
against `0.1.7` leaves the payment `pending` and the payee at zero.

A desk configured with a `portalKey` was never exposed — the key gate 403s the
request first, and the cookie is `SameSite=Strict`. The problem was that the
**default** path has no key and the README never mentioned one. `0.1.7` also
documents `portalKey`, `agentKeys` and `deskUrl`, and makes `agentKeys` a
config field instead of a hidden property.

If you are on `0.1.5` or earlier you also have the approval-page XSS described
above. Upgrade to `0.1.7`.

There is still **no audit** and **no real money**. Do not put real funds
anywhere near this.

## The EVM session path skipped the mandate's rules (`contracts/`, fixed)

Reported by **blacklitosphere88** (GitHub issue #1, then email). Real, and
confirmed by a Foundry proof before anything was changed.

`AgentVault.sol` had two doors into the same budget. `settle()` checked the
mandate's rules. `openSession()` + `charge()` re-implemented the spend path and
dropped them. An agent holding only the AGENT key — exactly the compromised
agent the contract's own docstring promises to contain — could:

| The principal configured | On the session path |
|---|---|
| payee allowlist (`payeeRoot`) | ignored — drain to any address, including the agent's own |
| human approval on every payment (`requiresApproval`) | ignored — no approver signature needed |
| per-call ceiling (`perCallMax`) | ignored — one `charge()` moved the whole budget |
| expiry / revocation | ignored at open, and an open session kept paying after |

Only the daily and total budgets held, because both paths route through
`_debit()`. So the two guarantees that matter most — "only my approved sellers"
and "a human signs every payment" — protected against nothing for the actor they
exist to contain. The tests missed it because every session test used a mandate
with an empty allowlist and no approval policy, so the gap had no test that
could see it.

Fixed by making the session path enforce the same policy: the allowlist is
checked at `openSession()` (the payee is fixed for the session's life, so one
check covers every later deduction), `perCallMax` is checked per `charge()`, and
the mandate window plus revocation are checked on both calls. A mandate that
requires a human over every payment now refuses sessions outright rather than
silently downgrading the policy — one signature paying many times is the
opposite of a human signing each intent.

`openSession()` gained a `payeeProof` argument, so its signature changed. That
breaks any caller written against the old ABI. Nothing shipped calls it: the
Stellar path never had sessions, and the EVM SDK only mirrors the (unchanged)
EIP-712 types. `sdk/abi/AgentVault.json` is regenerated.

`contracts/test/SessionPolicy.t.sol` is the regression suite: 11 tests, one per
bypass, each asserting the refusal, plus two proving an allowlisted payee can
still stream — the fix must not quietly kill the feature it is guarding.

## A revoked mandate could be put back (`contracts/`, fixed)

Reported by **Kupia** (sales@kupia.io).

`registerMandate()` guarded with `if (mandates[id].active) revert AlreadyUsed()`. The mandate
id is a hash of the mandate's own parameters, so `revokeMandate()` left an *inactive* slot at
that same id — and the principal's signature over that digest stays valid forever. Anyone
holding the signature could re-register the revoked mandate exactly as it was: the agent, or
anyone who read the signature off the registration transaction, which is public. Revocation was
advice, not a control.

Fixed by making a mandate id spent forever: `mandateSeen` is set at registration and never
cleared. Resuming requires a new nonce, which is what makes the revocation mean something — the
old id can never come back. `contracts/test/MandateRevocation.t.sol` covers the replay, the
case that must keep working (a new nonce after a revocation), and that a registration failing on
a bad signature does not burn an id.

The Stellar path is not affected: there the mandate is a pre-authorised transaction hash held as
a *signer*, and revoking removes the signer. There is no id to re-register.

There is still **no audit** and **no real money** in the EVM prototype.

## A batch leaf could be claimed again and again (`contracts/`, fixed)

Reported by **Lars** (lars@haenggi.com), who read the source and wrote to
`founder@paydlux.com` per this policy. Confirmed against the code, and reproduced in
Foundry, before anything was changed.

`publishBatch()` burns the publisher's ACT for the batch total and stores only an
aggregate `claimed`. `claimBatch()` checked that the leaf opened to the published root
and that `claimed + amount <= total`. Nothing recorded that *this* leaf had been spent.
So one valid leaf+proof was spendable once per call, until the batch total ran out.

The report's own scenario, now a test:

| | |
|---|---|
| principal deposits | 100 USDC, publishes a batch of two 50-ACT leaves |
| leaves | attacker 50, honest payee 50 |
| attacker submits their leaf+proof | twice |
| ACT minted to the attacker | 100 (entitled to 50) |
| honest payee then claims | `BatchNotLive` — the batch closed at `claimed == total` |
| attacker withdraws | 100 USDC, i.e. 50 of someone else's entitlement |

Fixed by marking the leaf spent before anything is minted: `_claimedLeaves[batchId][leaf]`
is checked and set ahead of the `credit.mint()`. It is keyed by the leaf hash
(`hash(leafIndex, payee, amount)`) rather than by `leafIndex`, so the check is exact
whatever index convention the publisher used — a tree with reused indexes cannot slip a
second claim through, and a sparse-index tree still claims normally.

Two guards came with it. `leafIndex` must be inside the published tree
(`LeafOutOfRange`), and `publishBatch` refuses to overwrite an id that already exists
(`BatchExists`): the batch id is `hash(root, leafCount, total, block.timestamp)`, so the
same parameters in the same block collided and would have reset a live batch's claimed
accounting while its first publisher's ACT stayed burned.

Cost: one extra storage write per claim, 72,991 → 95,698 gas. `sdk/economics.ts` is
updated. Re-measuring it turned up a second, unrelated error in that table: `claim_batch`
held 32,079, which is the gas-report *minimum* — the reverted `BadProof` call — not the
cost of a claim that works. The table now records successful calls.

`contracts/test/AgentVault.t.sol` gained `test_batch_claim_replay_rejected` (the report's
exact two-recipient case: replay refused, honest payee still paid, attacker capped at
their own leaf) and `test_batch_leaf_index_and_id_guards`. Both fail with the spent-leaf
write removed, so they test the fix rather than the shape of the code.

`claimBatch`'s signature is unchanged, so no existing caller breaks.
`sdk/abi/AgentVault.json` is regenerated: it adds `isLeafClaimed` and the three new errors.

The Stellar path has no Merkle batch claim, so it was never exposed to this. And the
reporter's own caveat stands: this EVM prototype is not shipped and holds no real money.

## Safe harbour

Research done in good faith against testnet, following this policy, is
authorised. We will not pursue legal action over it, and we will not ask you to
stop disclosing. We do not currently pay bounties — we are a prototype, not a
company with a budget — but we will credit you by name in release notes if you
want it.
