# Paydlux Approver — the iPhone app

This is the approval half of a Paydlux vault, running as a native iPhone app.

It is deliberately **thin**. The transaction decoding, the amount you read on
screen, the hashing, and the signature attachment all happen in the same
audited JavaScript the browser approver uses (`phone-app/app.js`, `xdr.js`,
`verify.js`), loaded from `https://desk.paydlux.com`. Swift does four things
and refuses to do anything else:

| Swift owns | Why it is Swift and not JS |
|---|---|
| the Keychain | a web page cannot hold a key that survives a reboot and a reboot alone |
| Face ID | a browser prompt can be satisfied by a fingerprint left on a sensor |
| the icon badge and the local notification | iOS does not give a web page either |
| refusing to sign anything that is not a Stellar transaction hash | a key that signs arbitrary bytes is an oracle |

Everything else — what the payment says, how much it is, who gets paid — is
decoded and displayed by the JS, which is one implementation shared by the
browser approver and this app. A second decoder written in Swift would be a
second place to be wrong about what a payment says, and the human approves what
the screen shows, so "wrong" there means money.

## Why not the Secure Enclave

Stellar signatures are Ed25519. The Secure Enclave only produces P-256 ECDSA,
so it cannot sign a Stellar transaction — full stop. The key therefore lives in
the iOS Keychain with:

- `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — not backed up, not
  migrated to a new phone, so a cloud backup cannot leak it and a new device
  cannot silently inherit it.
- `.biometryCurrentSet` — the item is destroyed if you re-enrol Face ID or add a
  fingerprint. A phone that has changed hands loses the key.

The seed is decoded once, at enrolment, and only its 32 raw bytes are stored.
The `S…` text never sits in a file, and the WebView never sees it.

## Why notifications are local

The app polls the desk in the background and raises a **local** notification.
There is no APNs server, no device-token registry, no third-party SDK. Push
that way would need a server that knows which phone belongs to which vault —
a new privacy surface and a new thing to break, for a buzz that arrives seconds
sooner.

The alert says only that a payment is waiting. It never contains the amount or
the payee: a lock-screen prompt is a payment decision made on a screen nobody
unlocked deliberately. The number is on the review screen, after Face ID.

## Build it

Requires Xcode (free) and a free personal Apple ID. No App Store account, no
$99/year programme.

```sh
brew install xcodegen
cd ios
xcodegen generate
open PaydluxApprover.xcodeproj
```

Then in Xcode, once:

1. Select the **PaydluxApprover** target → *Signing & Capabilities*.
2. Set **Team** to your personal Apple ID.
3. Set a **Bundle Identifier** you own or are happy with, e.g.
   `com.yourname.paydlux-approver`.
4. Plug the iPhone in over USB, select it as the run destination, press **Run**.
5. On the phone: *Settings → General → VPN & Device Management* → trust your
   own developer certificate.

A free personal team re-signs every **7 days**. Re-run step 4 when the app
stops opening. The App Store removes that chore and costs $99/year; it is not
required to use this.

`DEVELOPMENT_TEAM` in `project.yml` can be set to your Team ID so the generated
project is pre-signed; leaving it empty and picking the team in Xcode works too.

## Run the seed decoder checks without Xcode

`Seed.swift` is the one piece of Stellar parsing in Swift. It has to agree byte
for byte with the JS decoder, or the app and the page would derive two different
approver keys from one seed and every approval would come back `BAD_AUTH`.

```sh
DEVELOPER_DIR=/Library/Developer/CommandLineTools /usr/bin/swiftc \
  -target arm64-apple-macosx14.0 \
  ios/PaydluxApprover/Seed.swift ios/PaydluxApprover/Hex.swift ios/Checks/main.swift \
  -o /tmp/seedcheck && /tmp/seedcheck
```

The vectors in `ios/Checks/main.swift` are printed by `phone-app/xdr.js` itself,
so the two decoders are held to the same answers.

## Adding your key

1. Start the seller: `npm run app` (or `npx tsx stellar/cli.ts sell --split --tls`).
2. Open the approval link the desk prints, or the one in the mail it sends.
3. The app asks for the approver seed once. Paste it, tap *Store on this device*.
4. From then on: Face ID, then the queue.

If the app and the desk disagree about the approver key, the review screen says
so **before** it signs. That mismatch is the single most common failure in this
flow — it happens when a demo mints a fresh vault while the phone still holds
the old key — and it is a ledger `BAD_AUTH` that looks like a network error if
nobody checks it up front.

## What is not here yet

- No App Store build, no TestFlight, no notarised macOS build.
- No receipt/withdraw screens; those stay on the seller desktop.
- No multi-vault support: one approver key per device, on purpose.
- No watch complication.
- The desk link is stored on first open; changing desks means *Forget this key*
  and re-opening a new link.
