# Paydlux — spend-limited payments for AI agents

AI agents are starting to buy things (APIs, data, compute) over HTTP with
stablecoin payments ([x402](https://x402.org)). Today an agent gets a raw
crypto wallet: **no spending cap, no human approval, no refund path** — and
real money has already been drained this way.

Paydlux puts the guardrails **on the ledger** instead of in your code.

## The Stellar path (primary — no smart contract, no faucet, no gas fight)

There is no contract to audit. The whole mechanism is three native Stellar
primitives:

| primitive | what it gives us |
|---|---|
| issued asset / Circle USDC | the payment token |
| multisig account | the vault — releasing funds needs 2 of the signers |
| pre-authorised transaction hash | the spending mandate, as a *signer* |

The mandate is the trick. We pre-build a transaction whose operations are
exactly "pay N tokens to this payee, inside this time window, once", take its
hash, and register that hash as a weight-1 signer on the vault. The agent key
is also weight-1 and the threshold is 2. So the agent can reach threshold only
by presenting **that exact transaction**. Change the amount, the payee, the
token, the window, or try to run it twice, and the ledger refuses. A prompt
injection cannot talk its way past a signature check.

```
stellar/vault.ts     create a 2-of-2 vault, register mandates, settle, revoke
stellar/gateway.ts   HTTP 402 resource server; serves only after the ledger agrees
stellar/agent.ts     the buyer side — one class, one method call
stellar/desk.ts      approval queue: a human decides, in the clear
stellar/portal.ts    the page that human looks at
stellar/policy.ts    daily budget / seller allowlist (the part a ledger can't count)
stellar/demo.ts      17 checks against the live testnet, one command
phone-app/           the approver app a human opens on their own device
stellar/probe-*.ts   the experiments that settled how the ledger behaves
stellar/onboard.ts   keys → funded vault → printed agent key
```

### Try it

```bash
npm i
npx tsx stellar/demo.ts                    # 17 checks, live testnet
npx tsx stellar/story.ts --tls --split     # https://desk.paydlux.com; approve on your phone
```

`--tls` is the one to use for anything real. It runs a named Cloudflare tunnel
so the desk is served over `https://desk.paydlux.com` with a real certificate,
instead of a random `trycloudflare.com` hostname (`--public`) that nothing tells
the human is *your* desk. Setup is one-time and free:

```bash
cloudflared tunnel login
cloudflared tunnel create paydlux-desk
cloudflared tunnel route dns paydlux-desk desk.paydlux.com
```

Then `~/.cloudflared/config.yml` points the hostname at `http://127.0.0.1:4022`.
The tunnel's credentials file stays in `~/.cloudflared/` and must never be
committed: whoever holds it can serve your hostname.

What the desk enforces once it is public (`npx tsx stellar/tls-check.ts`, 19 checks):

- plain `http://` is 301'd to `https://` and never served, with HSTS set
- the desk listens on `127.0.0.1` only, and refuses any `Host` that is not
  `desk.paydlux.com` — so the local port cannot be driven directly to skip TLS
- a desk configured with a public hostname **refuses to start** without a portal
  key, rather than coming up as an open approval button
- the portal key also rides in an `HttpOnly; SameSite=Strict; Secure` cookie, so
  the approver app can load its own scripts (a `<script src>` cannot inherit
  `?k=` from the page URL) without the key ever appearing in the DOM

No wallet, no faucet, no config.

### The human key does not live on the seller's machine

The vault needs two signatures. If both keys sit in one process, that is really
one key. So the approval half is split off:

```bash
npx tsx stellar/phone-check.ts       # 17 checks: seller alone cannot pay; phone alone cannot pay
npx tsx stellar/e2e-phone.ts         # desk with no approver key still settles
npx tsx phone-app/xdr-check.ts       # 32 checks: the phone's own decoder is byte-exact with the SDK
npx tsx phone-app/desk-app-check.ts  # 28 checks: the real app over real HTTP, end to end
```

The seller builds the payment and signs it with their own half. The human opens
one link — `/phone/?id=...` — and the approver app in `phone-app/` shows them the
amount, the token, the payee and the deadline, then signs on the device.

The app is three static files with no dependencies and no build step. It carries
its own Stellar transaction decoder (`phone-app/xdr.js`) rather than the SDK, and
refuses any transaction shape it does not fully understand: path payments,
account merges, signer changes and multi-operation transactions are rejected
outright rather than guessed at. The key is imported into WebCrypto as
**non-extractable** and only the `CryptoKey` object itself is persisted, so the
seed is never in localStorage, IndexedDB, or a file. The page is served with
`connect-src 'self'`, so an injected script cannot phone the key home.

The approver seed never travels to the seller's machine, and the signature is
over the transaction hash — change the amount or the payee and it stops counting.
`tools/phone-sign.ts` is the same flow for a terminal instead of a browser.

Use it as a package instead of cloning:

```bash
npm install @paydlux/agent
```

```ts
import { StellarVault, Gateway, PaydluxAgent } from "@paydlux/agent";
```

### Seller setup, in full (the four things that bite)

A stranger following only the previous version of this README hit four walls.
All four are in the code; here they are up front.

```ts
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault, Gateway } from "@paydlux/agent";

const issuer = Keypair.random(), principal = Keypair.random();
const approver = Keypair.random(), agent = Keypair.random();
const payee = Keypair.random();

await StellarVault.fundTestnet(issuer);          // testnet only
await StellarVault.fundTestnet(payee);
const vault = await StellarVault.create({
  network: "testnet", issuer, principal, approver, agent, tokenCode: "USDC",
});
await vault.trustToken(payee.publicKey(), "1000", payee);   // payee must trust the token
await vault.deposit("50", issuer);                          // vault must hold the money

const gw = new Gateway({
  vault, network: "testnet", payee: payee.publicKey(),
  routes: [{ uri: "/api/data", price: "1.00", mode: "approval" }],
  principal: principal.secret(),
  approver: approver.secret(),      // omit this + set `split: true` to approve on a phone
  agentKeys: [agent.publicKey()],   // (1) without it, no agent can park a payment
  deskPort: 4022,
  portalKey: newPortalKey(),        // (2) required before the desk is public
  deskUrl: "https://desk.example.com",  // (3) what the buyer is told, not loopback
});

await gw.listen(8080, (uri) => myPayload(uri));
await gw.desk.listen(4022);         // (4) gw.listen() does NOT start the desk
```

1. **`agentKeys`** — an intent is only honoured if signed by a listed key. Empty
   list means nothing can request approval, and the failure looks like a plain
   402 with no explanation.
2. **`portalKey`** — the approval page has no login. The key *is* the
   authentication, so it is a 22-character secret in the link. A desk configured
   with a public hostname refuses to start without one.
3. **`deskUrl`** — the 202 the buyer gets says where a human approves. It
   defaults to `http://127.0.0.1:4022`, which is only right when buyer and
   seller share a machine.
4. **`gw.desk.listen(port)`** — the gateway and the desk are two HTTP servers.
   Starting the gateway alone leaves the queue unreachable.

The buyer side needs the agent **secret**, not the vault's signer list:

```ts
const agent = new PaydluxAgent({ agentKey: process.env.AGENT_KEY! });
const res = await agent.get("https://seller.example.com/api/data", { mandate });
if (!res.ok && res.handle) console.log("parked, awaiting a human at", res.desk);
```

`npm run build` produces `dist/`. The package depends only on
`@stellar/stellar-sdk` — no transitive `toml`, so `npm audit` is clean.

`story.ts --public` matters for demos: the portal has no login, so the printed
link carries a 22-character key and every request without it gets a 403.

It prints what it proves:

```
— 4. human pre-authorises a mandate; agent executes it
  ✅ content served, tx cabeb25ec92c2391…
  ✅ seller 2.0000000, vault 48.0000000
— 5. tamper with the envelope — the ledger refuses
  ✅ refused: price mismatch: want 2 got 9.0000000
— 6. replay the same mandate — money moves once
  ✅ refused: mandate is not registered on the vault (expired or revoked)
— 7. over-budget request is declined before anything is built
  ✅ declined [max_per_payment]: 40 exceeds the per-payment ceiling of 10
— 8. approval mode — a human decides
  ✅ human approved → settled on-chain, tx bf4ce06c742f18f2…
— 9. deny path — nothing moves
  ✅ denied, balance unchanged at 42.0000000
```

Plug your own agent in:

```ts
import { PaydluxAgent } from "./stellar/agent.ts";

const agent = new PaydluxAgent({ agentKey: process.env.AGENT_KEY! });
const res = await agent.get("https://seller.example.com/api/data", { mandate });
if (res.ok) console.log(res.data, "paid in tx", res.tx);
```

`npx tsx stellar/onboard.ts` creates the vault and prints that key. The key is
**one of two signatures** — it cannot spend alone.

### What is enforced where (said honestly)

| enforced by Stellar | enforced by `policy.ts` |
|---|---|
| max per payment, payee, token, time window, one-shot execution | payments per day, running daily total, seller allow/deny list |

The vault is one payment at a time; counting payments is our job. A rule break
means we never build the transaction, so nothing reaches the ledger.

Two ledger behaviours we verified rather than assumed, and designed around:

- **A mandate is consumed on use.** After it runs, Stellar removes the pre-auth
  signer. One mandate, one payment — no counter needed.
- **A pre-auth transaction is bound to a sequence number**, so only the newest
  mandate can ever run; an older one is in the past and can never fire.
  `createMandate` therefore revokes previous mandates in the same transaction.
  The product is deliberately one open order at a time.
- **Resubmitting an identical envelope does not error.** Horizon returns the
  *cached* result. The money cannot move twice, but a naive gateway would serve
  the content twice — so `gateway.ts` checks the ledger for an already-applied
  transaction before shipping anything.

### Real money

Circle issues USDC natively on Stellar — not wrapped, not bridged. `vault.ts`
pins the issuer (`GA5ZSEJY…KZVN` on public, `GBBD47IF…FLA5` on testnet) and
rejects any other token that calls itself USDC. The vault's USDC trustline is
verified on testnet. Settlement fee is 0.00001 XLM.

## The EVM path (research, kept for the deeper feature set)

`contracts/` + `sdk/` are the earlier Base Sepolia work: a Solidity vault with
escrow, proof-of-delivery receipts, session keys and Merkle-batched settlement
(~$0.00005/payment). 61 contract tests pass, including 4×512-run fuzz suites
over the core invariants.

```
contracts/src/AgentVault.sol       vault, mandates, settle, escrow, sessions, batches
contracts/src/AgentCreditToken.sol USDC-backed credit token (deferred settlement)
sdk/core.ts                        EIP-712 typed data (mirrors the contract exactly)
sdk/gateway.ts                     x402-style HTTP 402 resource server
sdk/approval.ts                    human-in-the-loop Approval Desk
sdk/economics.ts                   unit economics from measured gas + live prices
```

```bash
anvil --chain-id 31337 &
cd contracts && forge build && forge test
cd ../sdk && node demo.ts
```

## Status

Working prototype on **Stellar testnet**, end to end, verified by `stellar/demo.ts`.
The EVM contracts are tested but **not audited**. Nothing here has run with
real funds. Do not use it with real funds.

## Economics

Stellar settles for ~0.00001 XLM, so per-payment cost is not the constraint —
trust is. Pricing is 0.5¢ per settlement capped at 1%, plus SaaS for mandate
management, dashboards and compliance evidence.

## License

MIT
