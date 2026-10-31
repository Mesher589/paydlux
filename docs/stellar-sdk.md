# Stellar SDK — overnight build notes (31 Oct 2026)

What exists now, and what it actually proves. Everything below was run against
the live Stellar **testnet**, not simulated.

## Run it

```bash
npx tsx stellar/demo.ts        # 11 checks, prints pass/fail, exits
npx tsx stellar/onboard.ts     # makes you a real vault + prints the agent key
```

`demo.ts` output ends with `ALL CHECKS PASSED`. It creates fresh keys every
run, so it is safe to run repeatedly.

## The mechanism, in one paragraph

The vault is a normal Stellar account with three signers — you (principal),
your phone (approver), your agent — each weight 1, threshold 2, and the
account's own master key set to weight 0. To authorise a payment we build the
payment transaction in advance, hash it, and register that hash as a fourth
signer. The agent reaches threshold 2 only by submitting *that exact
transaction*. Any edit changes the hash, so the signature stops working. There
is no contract, nothing to audit, no gas.

## What the ledger enforces for free

max per payment · which seller · which token · the time window · one-shot
execution · the agent key alone can never reach threshold · revoking the agent
key kills every outstanding mandate.

## What our code enforces (`policy.ts`)

payments per day · running daily total · seller allow/deny list. The ledger
handles one payment at a time; counting is ours. A violation means we never
build the transaction.

## Three ledger behaviours we measured, not assumed

1. **A mandate is consumed when used.** Stellar deletes the pre-auth signer
   after it runs. Verified: signer count drops from 5 to 4.
2. **Pre-auth transactions are sequence-bound.** Only the newest mandate can
   ever run — an older one sits at a sequence number in the past and is
   permanently dead (`probe-multi.ts` proved this: B ran, A was refused).
   `createMandate` now revokes older mandates in the same transaction, so the
   state is never ambiguous. Product consequence: **one open order at a time.**
3. **Replay does not throw.** Horizon returns the cached result for an
   identical resubmission. Money cannot move twice, but a naive gateway would
   serve the content twice, so `gateway.ts` checks the ledger for an
   already-applied transaction before shipping.

## Real money

Circle issues USDC natively on Stellar. `vault.ts` pins Circle's own issuer
addresses and rejects any other token named USDC. The vault's USDC trustline
was created and confirmed on-ledger (`usdc-check.ts`). Circle's testnet faucet
returned 200 but did not deliver test USDC during the run — their faucet is
rate-limited; the trustline and mandate path were still verified.

## Not done / not claimed

- No production deploy. Everything runs on a laptop against testnet.
- The approval portal signs with keys held in the desk process. That is fine
  for a demo and **not** acceptable for real money — the approver key must move
  to the phone (browser extension / wallet signature) before mainnet.
- No auth, no multi-tenant accounts, no billing.
- The landing page's "funds get held" step is accurate for the vault model —
  the money already sits in a 2-of-2 account nobody can spend from alone. What
  is *not* on-chain yet is a seller-visible reservation of a specific amount:
  today the pending order lives in `desk.ts`. If we want the seller to see a
  real hold, add claimable balances. Worth doing before charging sellers.
- Nothing has ever touched real funds. Do not use it with real funds.

## Files

```
stellar/vault.ts      vault lifecycle, mandates, release, revoke, rotate, USDC
stellar/gateway.ts    HTTP 402 seller; serves only after the ledger agrees
stellar/agent.ts      PaydluxAgent — the buyer side
stellar/desk.ts       approval queue; approve = a real ledger signature
stellar/portal.ts     the page a human approves on (http://localhost:4022)
stellar/policy.ts     daily budget, allow/deny list
stellar/onboard.ts    one command: keys -> funded vault -> printed agent key
stellar/demo.ts       the 11-check end-to-end proof
stellar/smoke.ts      vault-only smoke test
stellar/probe-*.ts    the experiments behind the three findings above
```

Typechecks clean: `npx tsc --noEmit` (probes excluded).
