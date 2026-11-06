# Paydlux — funder demo in 5 minutes

Run this yourself. No engineer, no terminal on stage, no agent needed.

## The night before (once)

1. **Charge the iPhone** and open the Paydlux app once so the approver key is loaded.
2. **Put the demo on your laptop.** Double-click **Paydlux Demo** on the Desktop. A
   menu opens — no terminal, nothing to type:

   | Button | What it does |
   |---|---|
   | Start the demo | starts the Cloudflare tunnel if it is down, starts the desk and the demo page, waits until both actually answer over HTTPS, opens the two tabs |
   | Check-up: what is wrong? | one page: tunnel, desk, demo page, donation door, and whether the iPhone has talked to this desk — in plain words, with the fix |
   | Is the iPhone connected? | the same iPhone check on its own |
   | Show the iPhone link (QR code) | draws the desk link as a QR on screen; the iPhone camera opens the app with the link already filled in |
   | Copy the demo key to the clipboard | the testnet approver seed onto the clipboard, for the app's Re-add key screen. It is never printed |
   | Open the demo page and the desk | the two tabs, without restarting anything |
   | Restart / Stop the demo | clean restart, or shut the demo down (the donation door is never touched) |

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

## Which approver key is on the iPhone (read this once)

There are two vaults and they do **not** share an approver key:

| What you are running | Vault | Approver key the phone must hold |
|---|---|---|
| the demo (`demo.paydlux.com`) | testnet `GCGT7S4J…` | starts `fd942abc…` |
| the donation door (`donate.paydlux.com`) | mainnet `GCJGF6DY…` | starts `ed5a1125…` |

The app holds **one** approver key. If you set the phone up for mainnet, the demo
will park a payment and wait forever: the vault on testnet does not recognise that
key. The app shows the key it holds as 8 hex characters on the "Add your approver
key" screen, and the **Paydlux Demo** app prints the 8 characters the running desk
expects, so you can tell which one is in there before changing anything.

To put the demo key on the phone (about a minute, no typing):

1. Open **Paydlux Demo** on the Desktop and press **Copy the demo key to the
   clipboard**. The seed never appears on screen and never goes into a chat.
2. On the iPhone: open the Paydlux app → the **⋯** menu → **Re-add key**.
3. **Forget the stored key**, long-press in the `S…` field, **Paste**, press
   **Store on this device**. (Mac and iPhone copy-paste across devices when both
   are on the same iCloud account, Wi-Fi and Bluetooth.)
4. If it asks for the desk link, press **Show the iPhone link (QR code)** on the
   Mac and scan it with the iPhone camera — the app opens with the link filled in.

Forgetting a key on the phone loses nothing: both seeds live on this Mac in
`paydlux-vault.json` (testnet) and `paydlux-mainnet.json` (mainnet), both `0600`,
so you can re-import either one at any time. What you must never do is paste a seed
into a chat, an email, a screenshot or a form on a website.

If you would rather not swap keys before every demo, the alternative is to make the
testnet vault accept the mainnet approver key as a signer (one ledger change, done
from this Mac, and a Stellar signature cannot be replayed across networks because
the network is part of the hash). That is a decision to make deliberately, not at
2am before a meeting.

## On stage: the 5-minute script

**Step 1 — the hook (30 s, no clicking).**
Open `https://paydlux.com`. Say: *"An agent buys from a website. No card, no account,
no API key for money."*

**Step 2 — run the loop (10 s).**
On `https://demo.paydlux.com` press **Run the loop**. Steps 1–3 tick by themselves:
the agent asks, the site answers **402 Payment Required**, the agent pays through
Paydlux. Stop at step 4 — *"a human decides — and it isn't you"* — and say: *"the
buyer half ends here. What you are watching is the buyer. The next signature can
only come from this device."* and hold up the iPhone.

The page now says this out loud too, so a visitor reading it alone cannot mistake
step 4 for a hang: if nobody signs, it stops after a few seconds and prints the
most recent payment this exact loop really settled, with a hash they can open on
the explorer. That is the answer to *"okay, but has it ever actually happened?"*
without handing anyone a way to spend your money.

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
| Demo page sits on *"the seller's phone decides"* and the phone shows nothing | press **Check-up: what is wrong?** in the Paydlux Demo app. It names the cause. The usual one: the iPhone app only polls the queue **while it is open on screen** — open Paydlux and pull to refresh |
| Check-up says the iPhone last talked to this desk minutes ago | the phone is pointed at an older desk (usually the mainnet one). Press **Show the iPhone link (QR code)** and scan it with the iPhone camera |
| Demo page prints *"nobody signed, so nothing was paid"* | expected when the phone is not holding the key for **this** network — see "Which approver key is on the iPhone" above |
| Phone says "no approver key on this device" | press **Copy the demo key to the clipboard**, then Re-add key on the phone and paste |
| Approval fails with a key/sequence error | the vault expects a different key than this device holds — the demo needs the **testnet** approver (`fd942abc…`), the donation door needs the **mainnet** one (`ed5a1125…`) |
| `desk.paydlux.com` and `demo.paydlux.com` both fail to load | the Cloudflare tunnel is not running (it dies on a reboot). **Start the demo** starts it for you |
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
