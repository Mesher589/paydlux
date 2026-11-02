import Foundation
import CryptoKit
import LocalAuthentication
import Combine

/// The app's state machine, and the only place that touches the Keychain.
///
///   locked   -> nothing payment-shaped is on screen; Face ID needed
///   needsKey -> no approver key on this device; enrolment screen
///   ready    -> the desk is loaded and usable
///
/// The important boundary is in `sign`. The web layer never receives the key,
/// and never receives the seed either — it holds only the public half, which it
/// needs to attach a signature. The page sends the 32-byte transaction hash it
/// computed itself (all Stellar semantics stay in the audited JS), and this
/// returns a signature over those exact bytes. So an injected script inside the
/// WebView cannot read the seed even if it fully owns the page — it can only ask
/// for a signature over a Stellar hash, and that ask is checked, gated by Face
/// ID, and verified by the page before anything is sent to the ledger.
@MainActor
final class ApproverModel: ObservableObject {
    /// needsKey = no approver key yet. needsLink = key is stored but the app has
    /// never been given the desk link, so it needs one typed in. Without that
    /// third stage, enrolling before tapping a link left the app showing the
    /// seed field again with no way forward: the WebView that would otherwise
    /// hand over a link never loads when there is no URL to load.
    enum Stage { case locked, needsKey, needsLink, ready }

    @Published var stage: Stage = .locked
    @Published var lockMessage: String?
    @Published var enrolMessage: String?
    @Published var linkSummary: String?
    @Published var webError: String?
    @Published var waiting: Int = 0
    @Published var reloadRequested: Int = 0
    /// Whether the Keychain holds a key while the enrol screen is on screen.
    /// The screen must not claim there is no key when there is one, and the
    /// user needs a way to remove it from here.
    @Published var keyAlreadyOnDevice: Bool = false
    @Published var keyPublicSummary: String?

    private(set) var deskURL: URL?

    // ---------------------------------------------------------------- boot
    func start() async {
        if let saved = LinkStore.load() {
            deskURL = saved
            linkSummary = saved.absoluteString
            Audit.linkAccepted(host: saved.host ?? "?")
        }
        let hasKey = KeychainStore.exists()
        keyAlreadyOnDevice = hasKey
        // The public half is not secret and lives outside the Keychain, so it
        // can be shown on the enrol screen without a biometric prompt. Showing
        // it is what lets a person tell "wrong key" from "no key".
        keyPublicSummary = IdentityStore.publicHex().map { String($0.prefix(8)) + "\u{2026}" }
        let next = route(keyExists: hasKey)
        stage = next
        Audit.stage("\(next)", link: deskURL != nil, key: hasKey)
    }

    /// One place decides where the user lands, so every transition agrees.
    private func route(keyExists: Bool) -> Stage {
        if !keyExists { return .needsKey }
        if deskURL == nil { return .needsLink }
        return .locked
    }

    func unlock() async {
        lockMessage = nil
        // The Keychain read IS the biometric check: the item carries
        // .biometryCurrentSet, so it cannot be read without a face. Asking
        // LAContext separately as well would be theatre — and worse, it would
        // suggest the key could be read without it.
        do {
            _ = try KeychainStore.load()
            stage = deskURL != nil ? .ready : .needsLink
        } catch {
            lockMessage = (error as? LocalizedError)?.errorDescription ?? "Face ID did not unlock the key."
        }
    }

    // -------------------------------------------------------------- enrol
    /// Decode the seed here ONLY to get its 32 raw bytes for the Keychain, then
    /// derive the public half. The seed string itself is dropped at the end of
    /// this function and is never passed to the WebView: the page signs nothing
    /// in the native app, it only asks for a signature and attaches it.
    func enrol(seed: String) async {
        enrolMessage = nil
        do {
            let raw = try Seed.decode(seed)
            try KeychainStore.save(raw)
            // The public half is derived here, once, from the private half we
            // just stored. It is kept in plain defaults because it is public and
            // because the review screen needs it before any biometric prompt —
            // and because addSignature in the web layer needs it to attach the
            // result. A wrong public half is caught later: the app verifies the
            // signature against it before sending.
            let key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
            let pubHex = Hex.encode(Array(key.publicKey.rawRepresentation))
            IdentityStore.save(publicHex: pubHex)
            keyAlreadyOnDevice = true
            keyPublicSummary = String(pubHex.prefix(8)) + "\u{2026}"
            // Straight to the link prompt when this was the first run: the key
            // is in, and the only thing missing is which desk to talk to.
            stage = deskURL != nil ? .ready : .needsLink
            Watcher.shared.schedule()
        } catch {
            enrolMessage = (error as? LocalizedError)?.errorDescription ?? "That seed was rejected."
        }
    }

    // --------------------------------------------------------------- link
    /// A link from Mail/Messages, or pasted. Validated before it is trusted:
    /// https, and the desk host only. An approver app that will load any URL a
    /// message contains is a phishing surface with a signing key attached.
    func capture(link: URL) {
        // Two shapes are accepted, and neither takes the origin from the link.
        //
        //   https://desk.paydlux.com/phone/?k=...  — the host must match exactly.
        //   paydlux://desk?k=...                   — the custom scheme. Here the
        //      host is not read at all: the URL is rebuilt from the pinned host,
        //      so a message cannot point the approver anywhere else. That is why
        //      this scheme is safe next to a signing key, and a free-text https
        //      box would not be.
        // One implementation, compiled and attacked on its own by
        // ios/Checks/link-check.swift. The rule it enforces: the origin this
        // app loads is never taken from the link.
        let resolved = LinkResolver.resolve(link)
        guard let good = resolved else {
            // Log the rejected origin: this is the one event that tells the user
            // a message tried to point the approver somewhere else.
            Audit.linkRejected(link.scheme, link.host)
            lockMessage = "That link is not a Paydlux desk link."
            return
        }
        Audit.linkAccepted(host: good.host ?? "?")
        // Store the *rebuilt* URL, never the one that arrived. A paydlux:// link
        // carries no host of its own, and saving the incoming URL would put an
        // app-controlled origin in front of the WebView.
        deskURL = good
        linkSummary = good.absoluteString
        LinkStore.save(good)
        // Only needsLink advances to the desk. A link arriving from Mail while
        // the app is .locked must not skip the Face ID gate, so .locked is left
        // alone here and the desk loads after the next unlock.
        if stage == .needsLink { stage = .ready }
        Watcher.shared.schedule()
    }

    // --------------------------------------------------------------- sign
    /// The bridge call. Returns a hex signature, or throws with a message the
    /// page can show.
    ///
    /// Checks, in order:
    ///   1. the bytes are exactly a Stellar signature preimage — the 32-byte
    ///      transaction hash. Anything else is refused. Without this, a
    ///      compromised page could ask the hardware-backed key to sign arbitrary
    ///      data (a signature over attacker-chosen bytes is a real oracle) and
    ///      the app would oblige.
    ///   2. the Keychain read, which IS the Face ID gate.
    ///
    /// What the native side deliberately does NOT check: whether that hash
    /// belongs to a testnet or mainnet transaction, or what the transaction
    /// says. Deciding that needs a Stellar XDR decoder, and a second decoder in
    /// Swift would be a second place to be wrong about what a payment says. The
    /// web layer computed this hash from the XDR it fetched, showed the human the
    /// decoded payment, and verifies the returned signature against the key it
    /// named before sending anything. The native key's job is narrower: hold the
    /// seed, refuse anything that is not a Stellar hash, and require a face.
    func sign(preimageHex: String) async throws -> String {
        let bytes: [UInt8]
        do { bytes = try Hex.decode(preimageHex) }
        catch { Audit.signRefused("preimage is not hex"); throw error }
        guard bytes.count == 32 else {
            Audit.signRefused("preimage is \(bytes.count) bytes, not a 32-byte transaction hash")
            throw BridgeError.badLength(bytes.count)
        }
        let raw: Data
        do { raw = try KeychainStore.load() }
        catch { Audit.signRefused("keychain read failed: \(error.localizedDescription)"); throw error }
        let key = try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        let sig = try key.signature(for: Data(bytes))
        Audit.signAllowed(bytes: bytes.count)
        return Hex.encode(Array(sig))
    }

    /// The approver's public key, for the page to attach the signature with.
    /// Public, so no biometric gate is needed to hand it over.
    func publicKeyHex() -> String? {
        IdentityStore.publicHex()
    }

    func queueCount(_ n: Int) {
        waiting = n
        Watcher.shared.report(waiting: n)
    }
}

enum BridgeError: LocalizedError {
    case badLength(Int)

    var errorDescription: String? {
        switch self {
        case .badLength(let n):
            return "Refused: a Stellar approver signature covers a 32-byte transaction hash, got \(n) bytes."
        }
    }
}

/// The approval link, kept on the device so the app is usable after one tap on
/// a Mail link. Not a secret in the cryptographic sense, but it does carry the
/// portal key, so it lives in the Keychain too — without the biometric flag,
/// because the app has to read it before any prompt.
enum LinkStore {
    private static let service = "com.paydlux.approver.link"
    private static let account = "desk-link"

    static func save(_ url: URL) {
        delete()
        SecItemAdd([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: Data(url.absoluteString.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ] as CFDictionary, nil)
    }
    static func load() -> URL? {
        var out: CFTypeRef?
        let status = SecItemCopyMatching([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
        ] as CFDictionary, &out)
        guard status == errSecSuccess, let data = out as? Data, let s = String(data: data, encoding: .utf8)
        else { return nil }
        return URL(string: s)
    }
    static func delete() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}

/// The approver's own public half. Public, so UserDefaults is honest here — and
/// the app needs it before any biometric prompt, to label the screen and to let
/// the web layer attach the signature.
enum IdentityStore {
    private static let key = "paydlux.approver.public"

    static func save(publicHex: String) { UserDefaults.standard.set(publicHex, forKey: key) }
    static func publicHex() -> String? {
        guard let hex = UserDefaults.standard.string(forKey: key), hex.count == 64 else { return nil }
        return hex
    }
    static func clear() { UserDefaults.standard.removeObject(forKey: key) }
}
