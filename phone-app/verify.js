// Did the key this screen showed actually sign these bytes?
//
// Why this exists: the app asks something else to produce a signature — the
// browser's WebCrypto, or the iOS app's Keychain-backed signer over a script
// bridge. Anything that returns bytes without proving them is a black box. A
// bridge that returned a signature from a different key than the one the review
// screen named would have it attached to a real transaction and sent to the
// ledger as if the human had approved it with the key they were shown.
//
// So the app checks the signature against the public key it displayed, over the
// bytes it asked to be signed, before anything is sent. If the check fails,
// nothing goes out and the human is told.
//
// Implementation note: this deliberately uses the platform's Ed25519 verify,
// not a hand-written one. The app already depends on WebCrypto Ed25519 to sign
// (see importSecretSeedPair in xdr.js), so verifying adds no new dependency —
// and a second hand-rolled curve implementation inside a payment approver would
// be a second place to be wrong, in the one component whose whole job is to be
// right about who signed.
"use strict";

/**
 * verifySignature(sigBytes, hashHex, pubBytes) -> Promise<boolean>
 *
 * A Stellar approver signature covers the 32-byte transaction hash (that is
 * what signaturePreimage returns, and what the ledger verifies), so the app
 * verifies over the identical bytes it asked to be signed.
 */
async function verifySignature(sig, hashHex, pub) {
  const X = globalThis.PaydluxXdr;
  if (!(sig instanceof Uint8Array) || sig.length !== 64) return false;
  if (!(pub instanceof Uint8Array) || pub.length !== 32) return false;
  if (!/^[0-9a-f]{64}$/.test(hashHex)) return false;
  try {
    // The public key is imported as a verify-only key: it cannot sign, and it
    // cannot be exported into something that could.
    const key = await crypto.subtle.importKey(
      "raw", pub, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify(
      "Ed25519", key, sig, X.signaturePreimage(hashHex));
  } catch {
    // A platform without WebCrypto Ed25519 cannot verify, and must not pretend
    // it did. Callers treat false as "nothing was sent".
    return false;
  }
}

globalThis.PaydluxVerify = { verifySignature };
