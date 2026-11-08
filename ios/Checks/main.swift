// Seed.swift self-check, runnable without Xcode:
//
//   swiftc ios/PaydluxApprover/Seed.swift ios/PaydluxApprover/SeedCheck.swift -o /tmp/seedcheck
//   /tmp/seedcheck
//
// The vector below was printed by the JS implementation (phone-app/xdr.js) that
// the web layer uses, so the Swift decoder and the JS decoder are held to the
// same answer. If they drift, this fails — which is the point: the app stores
// raw key bytes decoded by Swift, and the web layer decodes the same seed in JS.
// Two decoders that disagree would produce two different approver keys from one
// seed, and every approval would come back BAD_AUTH from the ledger.
import Foundation
import CryptoKit

var failures = 0
func check(_ ok: Bool, _ what: String) {
    print((ok ? "  ok   " : "  FAIL ") + what)
    if !ok { failures += 1 }
}

// Throwaway fixture keypair, generated for this check and never funded: the
// derived account returns 404 on both mainnet and testnet (verified 2026-11-08).
// It is a decoder vector, not a live key. If you ever need a real one, generate it
// with `Keypair.random()` and keep it out of git.
let seed = "SBUNWLOBGPWIOOKIQNDQGI6IWTFAVKIR5JLBJRGLSKW6LPSB636RC5QA"
let wantRaw = "68db2dc133ec87394883470323c8b4ca0aa911ea5614c4cb92ade5be41f6fd11"
let wantAddress = "GC2X7YOVDV63D7SVI4KJIM7CZFFVVMTGK7B3UWHY7TX7CKG45BLQFMKV"

let raw = try Seed.decode(seed)
check(raw.count == 32, "seed decodes to 32 raw bytes (got \(raw.count))")
check(Hex.encode(Array(raw)) == wantRaw, "and the bytes match what the JS decoder produced")

// The public half comes from CryptoKit, not from the seed bytes: the seed IS the
// private key, and encoding it as an address would name the wrong account.
let key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
let pubHex = Hex.encode(Array(key.publicKey.rawRepresentation))
let address = Seed.accountAddress(key.publicKey.rawRepresentation) ?? ""
check(address == wantAddress, "the derived address matches the SDK's: \(address)")

// Round-trip: base32 encode/decode must be exact, both directions.
let back = try Seed.base32Decode(address)
check(back.count == 35 && back[0] == 0x30, "address is 0x30 || pub || crc (35 bytes)")
check(Hex.encode(Array(back[1..<33])) == pubHex, "and the 32 bytes inside it are the public key")

// CRC-16/XMODEM against the value the JS implementation prints for the same input.
check(Seed.crc16Xmodem(Array("123456789".utf8)) == 0x31C3, "crc16 XMODEM check value 0x31C3")

// A signature made here must verify as a Stellar signature would: over the
// 32-byte hash, with the key the review screen named.
let hash = Data(SHA256.hash(data: Data("paydlux-check".utf8)))
let sig = try key.signature(for: hash)
check(key.publicKey.isValidSignature(sig, for: hash), "CryptoKit signs and verifies a 32-byte hash")
check(!key.publicKey.isValidSignature(sig, for: Data("other".utf8)), "and refuses a different message")

// Bad input must be refused, not silently accepted.
func rejects(_ s: String, _ why: String) {
    do { _ = try Seed.decode(s); check(false, "rejects \(why)") }
    catch { check(true, "rejects \(why)") }
}
rejects("GDBIIGDOLLOGCJ6KVUPKNTK5MIPUZD5KQKWK6626FHJJBC235CLNZ77S", "an account address used as a seed")
rejects("SBUNWLOBGPWIOOKIQNDQGI6IWTFAVKIR5JLBJRGLSKW6LPSB636RC5QM", "a seed with one wrong character")
rejects("short", "a seed that is too short")
rejects("S!!!IGDOLLOGCJ6KVUPKNTK5MIPUZD5KQKWK6626FHJJBC235CLNY3MN", "characters outside the base32 alphabet")

print(failures == 0 ? "ALL SEED CHECKS PASSED" : "\(failures) SEED CHECKS FAILED")
exit(failures == 0 ? 0 : 1)
