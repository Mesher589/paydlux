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
5. Key handling: how seeds are generated, stored, or logged.

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
- The desk is plain HTTP on a throwaway tunnel. Until it runs behind TLS on a
  domain you control, the human is signing over a connection they cannot verify.

There is still **no audit** and **no real money**. Do not put real funds
anywhere near this.

## Safe harbour

Research done in good faith against testnet, following this policy, is
authorised. We will not pursue legal action over it, and we will not ask you to
stop disclosing. We do not currently pay bounties — we are a prototype, not a
company with a budget — but we will credit you by name in release notes if you
want it.
