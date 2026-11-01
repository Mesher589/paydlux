# Security policy

Paydlux moves money. We treat that seriously, including when the report is
about us.

## Report a vulnerability

Email **security@paydlux.com**. If you cannot reach that address, use
**founder@paydlux.com**.

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
| `stellar/` — SDK, gateway, vault, approval desk | working prototype, runs on Stellar **testnet** only |
| `contracts/` — Solidity `AgentVault.sol` | earlier EVM prototype, **not shipped**, kept for reference |
| Hosted service | none. There is no Paydlux server holding anyone's funds |

There is **no audit** of any of this. There is **no real money** in the system.
Anyone using it today is using test tokens.

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

## Safe harbour

Research done in good faith against testnet, following this policy, is
authorised. We will not pursue legal action over it, and we will not ask you to
stop disclosing. We do not currently pay bounties — we are a prototype, not a
company with a budget — but we will credit you by name in release notes if you
want it.
