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
