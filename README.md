# Paydlux — spend-limited payments for AI agents

AI agents are starting to buy things (APIs, data, compute) over HTTP with
stablecoin payments ([x402](https://x402.org)). Today an agent gets a raw
crypto wallet: **no spending cap, no human approval, no refund path** — and
real money has already been drained this way.

Paydlux puts the guardrails **on the ledger** instead of in your code.

**Homepage: [paydlux.com](https://paydlux.com)** — product, pricing and the
live demo. Source: this repo. Docs and setup: below.

## Install

The published package is [`@paydlux/agent`](https://www.npmjs.com/package/@paydlux/agent)
(npm, Node.js >= 20). No clone, no build, no contract to deploy:

```bash
npx -y @paydlux/agent setup      # makes a spend-limited vault and prints the agent key
npx -y @paydlux/agent mcp        # runs the MCP server over stdio
```

Or install it once and use the `paydlux` command:

```bash
npm install -g @paydlux/agent
paydlux mcp --file /absolute/path/to/paydlux-vault.json
```

The vault the agent may spend from is chosen by flag or environment variable —
`--file` and `PAYDLUX_VAULT_FILE` do the same thing:

```bash
PAYDLUX_VAULT_FILE=/absolute/path/to/paydlux-vault.json npx -y @paydlux/agent mcp
```

Add it to any MCP client (LobeHub, Claude Desktop, Cursor, Codex) as a stdio
server. This is the whole configuration:

```json
{
  "mcpServers": {
    "paydlux": {
      "command": "npx",
      "args": ["-y", "@paydlux/agent", "mcp"],
      "env": { "PAYDLUX_VAULT_FILE": "/absolute/path/to/paydlux-vault.json" }
    }
  }
}
```

Only the **agent key** is ever read by the MCP server, so the spending ceiling
survives a compromised agent. See
[MCP server](#mcp-server-your-agent-calls-paydlux-instead-of-a-wallet) for the
eight tools and what each one is allowed to do.

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
stellar/mcp.ts       the same buyer side as an MCP server, for any agent client
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

### MCP server: your agent calls Paydlux instead of a wallet

The buyer side also speaks [Model Context Protocol](https://modelcontextprotocol.io),
so an agent in Claude, Cursor, LobeHub, Codex or any other MCP client gets Paydlux's
tools directly — no wallet, no signing library, no payment code in the agent:

```bash
npx -y @paydlux/agent mcp --file /absolute/path/to/paydlux-vault.json
```

Add it to the client the same way you add any stdio server:

```json
{
  "mcpServers": {
    "paydlux": {
      "command": "npx",
      "args": ["-y", "@paydlux/agent", "mcp", "--file", "/absolute/path/to/paydlux-vault.json"]
    }
  }
}
```

| tool | what the agent gets |
|---|---|
| `paydlux_status` | which vault, which token, live balance, who can sign, how many mandates are live |
| `paydlux_payment_rules` | the ceiling the human set — plus what the ledger says is already spent today |
| `paydlux_check_payment` | dry run: would *this* amount to *this* seller pass, and which rule breaks if not |
| `paydlux_buy` | pay a 402-gated seller. If a human has to approve, the answer is a handle and a status URL |
| `paydlux_payment_status` | has the human decided yet |
| `paydlux_recent_payments` | the last payments in/out, with transaction hashes an explorer can check |
| `paydlux_escrow_status` / `paydlux_pending_escrows` | what is locked in escrow, and who can still take it back |

Two prompt templates come with it — the order of the calls, not just the calls:
`paydlux_budget_review` (what may I still spend today, in plain numbers) and
`paydlux_buy_safely` (rules → dry run → buy once → poll for the human's
decision). `--read-only` drops the buying prompt along with the buying tools.

Two things this server deliberately cannot do:

- **It cannot release money on its own.** It loads the agent key and nothing
  else — one signer of weight 1 against a release threshold of 2. There is no
  flag that accepts the principal or approver key, so it cannot be talked into
  using a key it never holds. A payment the mandate does not cover comes back as
  `needs_approval`, with the handle and the desk link for the human.
- **It cannot read a carelessly stored key file.** If the vault file is readable
  by other users, the server refuses to start until you `chmod 600` it, and no
  tool result will ever print a secret seed.

Run it with `--read-only` and the two tools that touch money disappear from the
tool listing entirely — useful for an agent that should report on spend but not
cause any. `npx tsx stellar/mcp-check.ts` drives the server with a real MCP
client and asserts all of the above (20 checks, testnet).

Product page, pricing and the hosted demo: **[https://paydlux.com](https://paydlux.com)**.

### The human key does not live on the seller's machine

The vault needs two signatures. If both keys sit in one process, that is really
one key. So the approval half is split off:

```bash
npx tsx stellar/phone-check.ts       # 17 checks: seller alone cannot pay; phone alone cannot pay
npx tsx stellar/e2e-phone.ts         # desk with no approver key still settles
npx tsx phone-app/xdr-check.ts       # 32 checks: the phone's own decoder is byte-exact with the SDK
npx tsx phone-app/desk-app-check.ts  # 57 checks: the real app over real HTTP, end to end
```

The seller builds the payment and signs it with their own half. The human opens
one link — `/phone/?k=...` — and the approver app in `phone-app/` shows them the
`https://desk.paydlux.com/phone/` link opens an installable app: it has a manifest
and icons, so a phone can put it on the home screen and it runs full-screen. The
shell (html, js, icons) is public because it holds no secret and no payment data
and must load before the key does; every route that returns data or moves money
(`/queue`, `/challenge`, `/approve`, `/signed`, `/deny`) still answers 403 without
the portal key.
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

### Your spending mandate (one command, enforced at the approve button)

```bash
paydlux sell --price 4.50 --max 10 --daily 20
```

No payment above 10, nothing past 20 in a day. The desk checks this **before**
it asks your phone, and again at submission — the budget can be spent between
your approval and the ledger call, so a stale signature is refused rather than
honoured. Approvals already waiting count against the budget, so a queue of six
4.50 requests against a 20/day cap sends four to your phone and refuses two at
the button instead of letting you approve six and watch two fail.

A refusal answers the buyer with `error: "mandate_refused"` on the **same**
handle, so a polite agent cannot park-refuse-park forever. `paydlux sell` also
refuses to start if `--price` is above `--max` or `--daily`, because that
combination blocks every payment and looks like a bug in the desk.

Verified on the published package: 6 x 4.50 against `--daily 20` -> four
settled, two refused, vault balance moved exactly 18.00 and stopped.

**The budget survives a restart.** `paydlux sell` asks the ledger what the vault
already paid that payee today and starts from that number, so `ctrl-c` and
`npm run app` again does not hand the day back. If the day is already spent it
refuses to start and says so; if the ledger cannot be read it refuses to start
too, because a budget that silently reads as unspent is worse than no budget.
The banner shows what is left: `policy: max 10 per payment, 50 per day (27.50
left today)`.

### Spend it by category, and edit the rules in a browser

One vault, several pockets. Open **spending rules** on the approvals page (or
`/rules` on the desk) and set, per named category, its own per-payment ceiling and
daily budget — then say which seller wallet belongs to which category:

```
data-api    max 3 / payment    6 / day     ← api.example.com wallet
coding      max 1 / payment    2 / day     ← assistant wallet
```

A category can only be **tighter** than the limits above it; it can never raise
them, because the base ceilings are checked first. That asymmetry is the security
property, and `npm run test:policy` proves it, along with the queue counting
inside a category and the fact that a form posted from another site cannot raise
your budget.

Edits are saved to the vault's config file, so they survive a restart. Once you
have edited them there, the saved numbers win over `--max`/`--daily` on the next
start, and the seller prints which it is using — a rule that quietly reverts by
morning is worse than no rule.

`stellar/policy.ts` is the engine; the page is a plain HTML form, so it works with
JavaScript off.

### What is enforced where (said honestly)

| enforced by Stellar | enforced by the desk (`policy.ts`) |
|---|---|
| payee, token, time window, one-shot execution, per-payment ceiling as a signer rule | per-payment ceiling and daily total at the approve button and again at submission, running daily total **seeded from the ledger's own payment history**, seller allow/deny list |

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

### Escrow: proof of delivery, not a promise

The claim on the landing page is that a payment can be held until delivery is
proven. That is only worth anything if the hold is enforced by the network, so
escrow is built from **native Stellar claimable balances** — not a smart
contract.

```
paydlux sell --escrow --price 3.5 --release 3600
```

A buyer locks the price in a claimable balance with two claimants:

| claimant | predicate | what it means |
|---|---|---|
| the seller's vault | `NOT(abs_before = releaseAt)` | can claim **only after** the release timer, and only with both human keys |
| the buyer | `abs_before = releaseAt` | can take the money back **any time before** the timer, alone, no seller consent |

Why claimable balances instead of a contract:

- **No contract to audit.** The rules are a ledger primitive, not code we wrote.
- **No contract address to get wrong.** A wrong address in a payment path is an
  irreversible loss; there is no address here.
- **The money never sits in an account the seller controls.** The seller cannot
  spend it, pledge it, or lose it to a bug in their own server.
- **The reserve is paid by whoever creates the balance and returned when it is
  claimed.** No standing rent for an idle escrow.
- **The rules hold when the seller's server is down.** Uptime cannot unlock a
  predicate.

The seller gets paid by *proving delivery before the timer*, not by waiting it
out. The buyer's leverage is the refund right, which is real: it works up to the
release second and needs nobody's permission.

Matching money to a deal is the part that is easy to get wrong. Horizon does not
put a memo on the balance record, so `readEscrow` fetches the creating
transaction and reads the memo off it. The memo **must** equal the order id the
gateway handed out in the `402`; an escrow whose memo matches nothing buys
nothing. Without that join, two orders at the same price to the same vault are
indistinguishable, and a seller could deliver order A and claim the escrow locked
for order B.

```bash
paydlux escrow                       # what is locked, who locked it, when it releases
paydlux escrow --release ord_7f3a…   # needs both human keys; on --split, prints the phone challenge
PAYDLUX_BUYER_SEED=S… paydlux escrow --refund <escrow id>   # the buyer's way out
```

`--release` refuses before the timer in words ("42 min to go") — the ledger would
refuse the transaction anyway, but a seller deserves to know why before they
reach for a key.

Three suites, all against the live test network, none mocked:

```bash
npm run test:escrow        # ledger primitives + the HTTP 402 escrow deal
npx tsx stellar/escrow-cli-check.ts   # the whole thing through the published CLI
```

`escrow-check.ts` locks real balances and asserts the ledger's answer: the vault
cannot claim early, a wrong second key gets `tx_bad_auth`, the buyer's refund
lands, and after the timer a 2-of-2 claim settles. `escrow-gateway-check.ts`
drives the product: `402` with escrow terms, the buyer locking money, the body
served against the escrow id, a different request body refused because the memo
names the other order, and the release queue flipping from `locked` to
`releasable`. `escrow-cli-check.ts` runs `dist/cli.js` the way a user does, so a
command printed in `--help` that is not actually dispatched fails the build.

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
