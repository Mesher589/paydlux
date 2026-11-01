# Stranger test — installing `@paydlux/agent` from npm

Run 2026-11-01 against the published **0.1.6**, in a clean directory
(`/tmp/stranger`), using **only** the published README and the shipped `.d.ts`
files. Nothing from this repo was consulted. Every claim below is from a command
that actually ran.

## What worked

| step | result |
|---|---|
| `npm install @paydlux/agent` | clean, 11 packages, `found 0 vulnerabilities` |
| `import { StellarVault, Gateway, PaydluxAgent } from "@paydlux/agent"` | all three resolve |
| `StellarVault.fundTestnet` + `StellarVault.create` | vault created on testnet |
| gateway `GET /api/data` | `402` with correct `x-payment` terms |
| signed intent → gateway | `202 {"status":"awaiting_approval","handle":"pay_0001"}` |
| `GET /list` | the parked payment, correct price and uri |

The mechanism is sound. Everything that failed was **the instructions**, and one
was a **missing guardrail**.

## Blockers, worst first

### 1. The desk has no gate, and approval is a CSRF target

Following the README quickstart produces a desk where:

```
GET  /                    -> 200   (approval page, no key asked for)
GET  /list                -> 200   [{"id":"pay_0001",...}]
POST /approve/pay_0001    -> 200   (it tried to settle)
Host: evil.example        -> 200   (Host not pinned unless publicHost is set)
```

`portalKey` is optional in `GatewayConfig`, and `publicHost` is what enables Host
pinning — so the default package path has neither. Our own deployment enforces
both (`--tls` refuses to start without a key); the library does not.

The dangerous combination is `POST /approve/<id>` with no token, no Origin check
and no `Sec-Fetch-Site` check. A cross-origin `POST` with no custom headers is a
CORS *simple request*: the browser sends it without a preflight. The page cannot
read the reply, but the approval still happens.

**Confirmed in a real browser, money moved.** Setup: seller on `127.0.0.1:4100`
following the README quickstart (no `portalKey`), buyer parks `pay_0001`, then a
page served on a **different origin** (`127.0.0.1:4199`) with one button:

```js
await fetch('http://127.0.0.1:4100/approve/pay_0001', { method: 'POST' });
```

| | before the click | after |
|---|---|---|
| `pay_0001` | `pending` | **`settled`**, tx `19416753ba03e7f87b9f2e23…` |
| payee USDC | `0.0000000` | **`1.0000000`** |

No key, no token, no preflight, no user interaction with the desk. A malicious
page opened in the seller's own browser approves whatever is in the queue. DNS
rebinding reaches the same port from a remote origin.

With `portalKey` configured the same request is refused — `GET /` → 403,
`POST /approve/pay_0001` → 403 — and the cookie is `SameSite=Strict`, so our own
`--tls` deployment is not exposed. The hole is that the **default** package path
has no key, and nothing tells you to set one.

Fix, shipped in `0.1.7`: the mutating routes (`/approve`, `/deny`, `/signed`)
reject a cross-site `Origin` and a cross-site `Sec-Fetch-Site`. Browsers always
send `Origin` on `POST` and `Sec-Fetch-Site` on every request, so this closes
both the hostile-page and the rebinding path while leaving curl, tests and the
phone app alone. `stellar/xss-check.ts` step 8 asserts it.

Re-run against the fixed build, same attack, same browser:

| | before the click | after |
|---|---|---|
| `pay_0001` | `pending` | **still `pending`** |
| payee USDC | `0.0000000` | **`0.0000000`** |

### 2. `agentKeys` is required and the README never mentions it

`grep -c agentKeys README.md` → **0**. Without it every approval request dies with:

```
{"error":"payment_invalid","reason":"intent signature is not from the agent key"}
```

That error points at the buyer's key. The actual cause is a missing seller-side
setting. It is a public field on the class (`gw.agentKeys = [...]`) but is not in
`GatewayConfig`, so the type definitions do not lead you to it either.

Fix: accept `agentKeys` in `GatewayConfig`, and throw at construction if a route
has `mode: "approval"` and no agent keys are configured.

### 3. The README's "Try it" block runs files that are not in the package

```
MISS stellar/demo.ts      MISS stellar/story.ts
MISS stellar/onboard.ts   MISS stellar/tls-check.ts
```

The package ships `dist/`, `phone-app/`, `portal-app/`, `README.md`, `LICENSE` —
24 files. The first thing a reader is told to run only works after `git clone`.
The README also says `npm i` (not `npm install @paydlux/agent`) in that block,
and later tells you to clone. A reader cannot tell which is which.

### 4. The README's own example does not run

```ts
import { PaydluxAgent } from "./stellar/agent.ts";   // relative path, not the package
const res = await agent.get("https://seller.example.com/api/data", { mandate });
```

`mandate` appears from nowhere, and the path is the repo's, not the package's.

### 5. "prints that key" is ambiguous, and the wrong one fails cryptically

`onboard.ts` prints the agent **secret**; `vault.signers.agent` is the agent
**public** key. Using the public key where a secret is wanted gives:

```
Error: invalid version byte. expected 144, got 48
```

### 6. The desk never starts unless you read the source

`Gateway` takes `deskPort` and builds an `ApprovalDesk`, but `gw.listen()` does
not start it. You need `await gw.desk.listen(port)`, which appears nowhere in the
README. Symptom: gateway answers `402`, desk connection refused.

Same for content: `gw.listen(port, getContent)` — omit the second argument and
approval-mode records are enqueued with empty content.

### 7. The buyer is handed a loopback desk URL

The seller replies `desk: "http://127.0.0.1:4100"`. A remote buyer cannot use
that. There is no config for the seller's public desk URL in the package path
(only `publicHost`, which is about Host pinning).

### 8. Minor

- No `./package.json` export, so `require("@paydlux/agent/package.json")` throws
  `ERR_PACKAGE_PATH_NOT_EXPORTED` — breaks any "which version am I on" check.
- `StellarVault.create` wants `Keypair` objects while `vault.signers` returns
  strings; nothing says so.

## What to do about it

1. Fix #1 and #2 in code — they are a security default and a silent failure.
2. Write a **package quickstart** that is copy-paste runnable from a clean
   directory: seller, buyer, approve, settled. Then a CI check that runs that
   exact snippet against the *published* tarball, so the README cannot drift
   from the package again.
3. Ship the demo/story scripts in the package, or stop telling people to run them.
