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

## Known open issue, stated plainly

The human approval key is currently a file on the operator's own machine. That
is a design gap we are aware of and are working on, not a bug to discover. Until
it is fixed, the 2-of-2 guarantee only holds as well as the security of that
laptop. Do not put real funds anywhere near this.

## Safe harbour

Research done in good faith against testnet, following this policy, is
authorised. We will not pursue legal action over it, and we will not ask you to
stop disclosing. We do not currently pay bounties — we are a prototype, not a
company with a budget — but we will credit you by name in release notes if you
want it.
