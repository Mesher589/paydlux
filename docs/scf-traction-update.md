# SCF traction — refreshed 2026-11-04 (post interest-form submission)

The interest form was submitted 2026-11-03 with the numbers in
`scf-interest-submitted.md` (6 mainnet txs, 3,536 downloads, 22 versions, 75
commits). Those numbers are now stale and every one moved UP. Use these in the
full Build proposal; all verified against Horizon/npm/git on 2026-11-04.

## Ledger (mainnet, vault GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB)

- **22 successful mainnet transactions** on the vault (was 6).
  Verify: https://horizon.stellar.org/accounts/GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB/transactions?limit=100
- **5 escrow releases signed by the human approver's iPhone** — the human-veto
  loop proven end to end with real money (0.5 XLM each, claimable balances):

  | order | release tx |
  |---|---|
  | ord_phone_mainnet_2 | 60c56764533c89c75227f5f27d85c89b49a4761788e5b3e673ee9e97cb56c144 |
  | ord_phone_take3 | 23862737111b8e67658982e7110ed4bfac9d049e63a1546ad61e6efc9e57db3a |
  | ord_phone_take4 | 602689ab2539c3e196a34d76487997542c5fb006591e67f084b04c99555ed439 |
  | ord_phone_take5 | 6d89d21adb3d01f46dfe7a98642890d5626d583b0c29fa2f1a6d8cd242df5471 |
  | ord_phone_take6 | 0d394546c9e8304395149ec22e53349bcb93001e7192eeb482809bcd5c47288e |

  Each release tx carries memo `release <order>` and exactly two signatures:
  the machine key and the phone approver key. Verified cryptographically
  (`tmp/sigcheck3.mjs`), not just from app logs. Explorer pattern:
  https://stellar.expert/explorer/public/tx/<hash>
- Escrow mechanics used: claimable balances with claimants (machine 2-of-2),
  time-locked; the desk never holds the money and never holds the human key.

## npm @paydlux/agent

- **4,216 downloads last month** (was 3,536). https://api.npmjs.org/downloads/point/last-month/@paydlux/agent
- **24 versions**, latest 0.1.22 (escrow release wired into CLI/SDK/desk).

## Repo

- **79 commits** (was 75). github.com/Mesher589/paydlux

## Wording for the full proposal

Replace "6 successful mainnet transactions" with:

> 22 successful mainnet transactions, including five escrow releases where the
> second signature came from a native iOS approver on a phone — the human veto
> proven with real money, each release verifiable on Horizon by memo and the
> two-signature envelope.

Do not claim volume or users; this is depth of proof, not adoption.

## Still missing (say so, as before)

Hosting, audit, and the demo recording (frames captured, MP4 not rendered —
optional, the Horizon links are the stronger evidence).
