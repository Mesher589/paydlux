import Foundation

/// Stellar strkey decoding — just enough to turn an "S..." secret seed into its
/// 32 raw Ed25519 bytes.
///
/// This is deliberately the ONLY Stellar parsing in Swift. Everything about
/// transactions (decoding, hashing, attaching signatures) stays in
/// phone-app/xdr.js, which is covered by xdr-check.ts and desk-app-check.ts. A
/// second transaction decoder in Swift would be a second place to be wrong
/// about what a payment says, and what a payment says is the whole product.
///
/// The seed decode is small and self-contained: base32, a version byte, a
/// CRC-16/XMODEM checksum. Tests for it are in PaydluxApproverTests/SeedTests.swift
/// and it is cross-checked against the JS implementation's vectors.
enum Seed {
    enum Error: LocalizedError {
        case tooShort, badVersion, badChecksum, badBase32

        var errorDescription: String? {
            switch self {
            case .tooShort:   return "That seed is too short to be a Stellar secret."
            case .badVersion: return "That is not a Stellar secret seed (wrong prefix)."
            case .badChecksum: return "That seed has a typo in it — the checksum does not match."
            case .badBase32:  return "That seed contains characters that are not in the Stellar alphabet."
            }
        }
    }

    /// Stellar's base32 alphabet is RFC 4648 without padding.
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")

    /// A secret seed starts with 'S' (version byte 0x90). Returns 32 raw bytes.
    static func decode(_ seed: String) throws -> Data {
        let s = seed.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        // A strkey is 35 bytes: 1 version + 32 key + 2 CRC. In base32 that is
        // 56 characters (280 bits, 8 of them padding).
        guard s.count == 56 else { throw Error.tooShort }
        guard let first = decodeByte(s) else { throw Error.badBase32 }
        // version byte: 18 << 3 = 0x90, which base32-encodes to a leading 'S'
        guard first == 0x90 else { throw Error.badVersion }

        let bytes = try base32Decode(s)
        guard bytes.count == 35 else { throw Error.tooShort }
        let payload = bytes[1..<33]
        // Stellar writes the CRC little-endian (low byte first). Getting this
        // backwards rejects every real seed while accepting none.
        let want = UInt16(bytes[33]) | UInt16(bytes[34]) << 8
        // The checksum covers the version byte AND the key body — everything
        // before it. Checksumming only the body rejects every real seed.
        guard crc16Xmodem(Array(bytes[0..<33])) == want else { throw Error.badChecksum }
        return Data(payload)
    }

    /// The G... address that corresponds to a public key, for display only.
    /// Stellar's account version byte is 6 << 3 = 0x30, which is what makes the
    /// first base32 character a "G". (A seed is 18 << 3 = 0x90, which is "S".)
    static func accountAddress(_ raw32: Data) -> String? {
        guard raw32.count == 32 else { return nil }
        var bytes = [UInt8]([0x30])
        bytes.append(contentsOf: raw32)
        let crc = crc16Xmodem(bytes)   // version byte included, as above
        bytes.append(UInt8(crc & 0xff))      // low byte first, as Stellar does
        bytes.append(UInt8(crc >> 8))
        return base32Encode(bytes)
    }

    private static func decodeByte(_ s: String) -> UInt8? {
        let bytes = try? base32Decode(String(s.prefix(2)))   // first 2 chars = 10 bits >= 1 byte
        return bytes?.first
    }

    static func base32Decode(_ s: String) throws -> [UInt8] {
        var bits = 0, count = 0, out = [UInt8]()
        for ch in s {
            guard let idx = alphabet.firstIndex(of: ch) else { throw Error.badBase32 }
            bits = (bits << 5) | idx
            count += 5
            if count >= 8 {
                count -= 8
                out.append(UInt8((bits >> count) & 0xff))
            }
        }
        return out
    }

    static func base32Encode(_ bytes: [UInt8]) -> String {
        var bits = 0, count = 0, out = ""
        for b in bytes {
            bits = (bits << 8) | Int(b)
            count += 8
            while count >= 5 {
                count -= 5
                out.append(alphabet[(bits >> count) & 31])
            }
        }
        if count > 0 { out.append(alphabet[(bits << (5 - count)) & 31]) }
        return out
    }

    /// CRC-16/XMODEM: poly 0x1021, init 0x0000. Same function as xdr.js.
    static func crc16Xmodem(_ bytes: [UInt8]) -> UInt16 {
        var crc: UInt16 = 0
        for b in bytes {
            crc ^= UInt16(b) << 8
            for _ in 0..<8 {
                crc = (crc & 0x8000) != 0 ? (crc << 1) ^ 0x1021 : (crc << 1)
            }
        }
        return crc
    }
}
