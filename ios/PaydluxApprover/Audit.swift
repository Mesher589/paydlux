import Foundation
import os.log

/// An on-device audit trail for the only two things that matter here: which
/// desk this app is pointed at, and every signature it refused.
///
/// Why this exists at all: when an approver misbehaves — a link that does not
/// open, a signing request that is denied — the user has one screenshot and a
/// guess. Without a log, "the app refused" and "the app crashed" and "the desk
/// was unreachable" are indistinguishable, and each has a different fix.
///
/// What is deliberately NOT logged:
///   * the portal key (the `k=` query item) — it is the shared secret that
///     authorises the approval link, so it never goes near the system log,
///     which other processes can read.
///   * the transaction hash or signature bytes — a hash is not secret, but a
///     log full of them is a record of every payment you ever approved, in a
///     place your backups can reach. The ledger already has that record.
///   * the seed, ever, in any form.
///
/// Only the host, the stage, counts, and refusal reasons are written.
enum Audit {
    private static let log = OSLog(subsystem: "com.paydlux.approver", category: "audit")
    private static let stamp = ISO8601DateFormatter()

    /// Every line goes to both places: os.log for `log show`, and a capped file
    /// inside the app's own container for a person who needs to open it and
    /// copy it out. os.log is rotated, filtered and unreadable on a device you
    /// are not attached to; a file is not.
    private static func emit(_ level: OSLogType, _ line: String) {
        os_log("%{public}@", log: log, type: level, line)
        file(line)
    }

    private static func file(_ line: String) {
        guard let dir = FileManager.default.urls(for: .applicationSupportDirectory,
                                                 in: .userDomainMask).first else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent("paydlux-audit.log")
        let entry = "\(stamp.string(from: Date())) \(line)\n"
        let bytes = Data(entry.utf8)
        if let fh = try? FileHandle(forWritingTo: url) {
            defer { try? fh.close() }
            // Keep it bounded: an approver runs for years, and a log it cannot
            // open is useless. Truncate-and-restart beats rotating forever.
            if ((try? fh.seekToEnd()) ?? 0) > 256_000 {
                try? bytes.write(to: url)
                return
            }
            fh.write(bytes)          // non-throwing; no try? needed
        } else {
            try? bytes.write(to: url)
        }
    }

    static func stage(_ name: String, link: Bool, key: Bool) {
        emit(.info, "stage=\(name) link=\(link ? "saved" : "none") key=\(key ? "yes" : "no")")
    }

    /// The host only. Never the query string, which carries the portal key.
    static func linkAccepted(host: String) {
        emit(.info, "link accepted host=\(host)")
    }

    static func linkRejected(_ scheme: String?, _ host: String?) {
        emit(.error, "link REFUSED scheme=\(scheme ?? "nil") host=\(host ?? "nil")")
    }

    static func signRefused(_ reason: String) {
        emit(.error, "signature REFUSED \(reason)")
    }

    static func signAllowed(bytes: Int) {
        // A count, not the bytes. Enough to answer "did the app sign anything".
        emit(.info, "signature produced over \(bytes) bytes")
    }

    static func pageLoaded(host: String) {
        emit(.info, "desk page loaded host=\(host)")
    }

    static func pageFailed(_ text: String) {
        emit(.error, "desk page failed: \(text)")
    }
}
