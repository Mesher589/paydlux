import Foundation

/// Hex helpers, shared by the app and by the standalone SeedCheck binary.
///
/// A script message cannot carry bytes, so every value that crosses the
/// Swift/JS boundary is hex. Converting in one place, with strict parsing, is
/// what stops a half-decoded signature from becoming an invalid transaction
/// instead of an error.
enum Hex {
    enum ParseError: Error { case notHex }

    static func decode(_ s: String) throws -> [UInt8] {
        let clean = s.lowercased().replacingOccurrences(of: " ", with: "")
        guard clean.count % 2 == 0, clean.allSatisfy({ $0.isHexDigit }) else { throw ParseError.notHex }
        var out = [UInt8]()
        out.reserveCapacity(clean.count / 2)
        var index = clean.startIndex
        while index < clean.endIndex {
            let next = clean.index(index, offsetBy: 2)
            guard let byte = UInt8(clean[index..<next], radix: 16) else { throw ParseError.notHex }
            out.append(byte)
            index = next
        }
        return out
    }

    static func encode(_ bytes: [UInt8]) -> String {
        bytes.map { String(format: "%02x", $0) }.joined()
    }
    static func encode(_ data: Data) -> String { encode(Array(data)) }
}
