# Paydlux — funder demo in 5 minutes

Run this yourself. No engineer, no terminal on stage, no agent needed.

## The night before (once)

1. **Charge the iPhone** and open the Paydlux app once so the approver key is loaded.
2. **Put the demo on your laptop.** Double-click **Paydlux Demo** on the Desktop. It
   starts the desk, waits until the desk actually answers over HTTPS, then opens the
   two tabs you need. Nothing else to type.
   (Rebuild the app after code changes with `npm run app:demo:build`. To run it
   without the app: `npm run app:demo`.)
3. **Test the loop once** (below). If it settles, you are ready.

The app cannot fail in the two ways that used to kill a demo:
- **already running** → it says so and opens the tabs instead of dying on a taken port
- **today's budget already spent** → it raises the *daily* budget (the per-payment
  ceiling is untouched, it is pinned into the signed transaction hash) and says so
- **a stale Paydlux squatting on a port** → it stops that process, names it, and starts clean

It never touches the donation door on `donate.paydlux.com`: that one runs on mainnet
with real USDC, and a demo must not restart a public money address.

## On stage: the 5-minute script

**Step 1 — the hook (30 s, no clicking).**
Open `https://paydlux.com`. Say: *"An agent buys from a website. No card, no account,
no API key for money."*

**Step 2 — run the loop (10 s).**
On `https://demo.paydlux.com` press **Run the loop**. Steps 1–3 tick by themselves:
the agent asks, the site answers **402 Payment Required**, the agent pays through
Paydlux. Stop at step 4 — *"a human decides"* — and say: *"this part cannot be
skipped by any code."*

**Step 3 — the approval (60 s, the money shot).**
Pick up the **iPhone**. The payment is sitting there with the amount, the payee, the
deadline and the network. Hold the button for 1.2 seconds. The phone signs; the key
never left the device.

> No iPhone in the room? The laptop tab `desk.paydlux.com/phone/?k=…` does the same
> thing in a browser — same hold, same WebAuthn key.

**Step 4 — the proof (30 s).**
Back on the demo page, step 5 turns green and prints the **transaction hash**. Open
`https://stellar.expert/explorer/testnet/tx/HASH` in front of them: a public,
permanent record. *"You don't have to believe me. This is the ledger."*

**Step 5 — the rules (60 s, answers the obvious question).**
Open `https://desk.paydlux.com/rules?k=YOUR_KEY`. Show the spending rules: per-payment
ceiling, daily budget, approved wallets, and **categories** (e.g. "data feeds: $5 per
payment, $20 a day"). Say: *"the agent can only ever spend inside a bucket I set.
Anything outside it comes back to me for a signature."*

## If something goes wrong

| Symptom | Fix |
|---|---|
| Demo page says "waiting for you" and the phone shows nothing | the desk restarted — reload the phone tab, then press **Run the loop** again |
| Phone says "no approver key on this device" | re-open the app (or paste the approver seed into the phone tab and press Import) |
| Approval fails with a key/sequence error | the vault expects a different key than this device holds — use the device that enrolled the current approver |
| No internet | run the loop on the laptop's own network: `npm run app:testnet:sell`, then open `http://127.0.0.1:8787` — same page, no tunnel |

## What to say when they ask the hard questions

- **"Real money?"** — Mainnet escrow releases are already on the ledger, signed on a
  real iPhone. This demo is testnet so nobody spends anything.
- **"What stops a rogue agent?"** — the ceiling is baked into the signed transaction
  hash, not a checkbox in a form; the vault needs two keys, one of which is your
  phone; and every release is a human hold.
- **"What's left?"** — the Soroban tranche: standing mandates, subscriptions,
  refunds. Ask for that.

## Proof this script works

Verified end-to-end on 2026-11-04: demo loop parked `pay_0001`, phone held and
signed, desk went `awaiting_phone → settled`, ledger tx
`E0BBD6FF34160DF559211369CE93F70853BCF693AE1DDD056286DBC…` on testnet.
