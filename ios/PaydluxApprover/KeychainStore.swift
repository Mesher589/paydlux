import Security
import LocalAuthentication
import Foundation

/// The approver key at rest on this device.
///
/// What is stored: the 32 raw Ed25519 bytes, NOT the "S..." text seed. The text
/// form is decoded by phone-app/xdr.js — the audited decoder — once, at
/// enrolment, and the string is then dropped. Storing the string here would
/// mean the app has to decode it again in Swift, which is a second decoder, and
/// a second decoder is a second place to be wrong about what a key is.
///
/// Why the Keychain and not a file or UserDefaults:
///   * kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly — the item is NOT in an
///     iCloud or iTunes backup and does not migrate to a new device. A phone
///     that is replaced or restored from backup does not silently carry the
///     approval half of a vault with it.
///   * .biometryCurrentSet — reading the item requires Face ID / Touch ID, and
///     if the owner re-enrols their fingerprints the item is destroyed rather
///     than quietly kept.
///   * the data-protection class wraps the bytes with the hardware key, like
///     every other secret on the phone.
///
/// What this is NOT: a Secure Enclave key. Stellar signatures are Ed25519
/// (EdDSA). The Secure Enclave only produces P-256 ECDSA, so it cannot sign a
/// Stellar transaction — the primitive does not exist in it. The key is an
/// ordinary Ed25519 key, protected at rest by the Keychain and gated at use by
/// biometrics. Anyone claiming a Secure Enclave Stellar key is describing a
/// different chain.
enum KeychainStore {
    private static let service = "com.paydlux.approver.key"
    private static let account = "approver-ed25519"

    enum StoreError: LocalizedError {
        case seedShape
        case addFailed(Int32)
        case notFound
        case readFailed(Int32)
        case wrongSize

        var errorDescription: String? {
            switch self {
            case .seedShape:   return "That does not look like a Stellar secret seed."
            case .addFailed(let s):  return "Could not store the key on this device (OSStatus \(s))."
            case .notFound:    return "No approver key on this device."
            case .readFailed(let s): return "Could not read the key (OSStatus \(s))."
            case .wrongSize:   return "The stored key is the wrong size; re-import it."
            }
        }
    }

    /// Store the 32 raw key bytes, guarded by biometrics.
    static func save(_ raw: Data) throws {
        guard raw.count == 32 else { throw StoreError.wrongSize }
        delete()
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            .biometryCurrentSet,
            &error
        ) else {
            throw StoreError.addFailed(Int32(truncatingIfNeeded: error?.takeRetainedValue()._code ?? -1))
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String: raw,
            kSecAttrAccessControl as String: access,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else { throw StoreError.addFailed(status) }
    }

    /// Read the key back. This is the call that triggers the system biometric
    /// prompt, so it happens at the moment of signing — not when the app opens.
    static func load(context: LAContext = LAContext()) throws -> Data {
        // The prompt text belongs on the context. kSecUseOperationPrompt was
        // deprecated in iOS 14 and is ignored on newer systems, which would
        // leave the user facing a biometric prompt that never says what it is
        // for — bad for a payment approval, where the words are the point.
        context.localizedReason = "Sign this payment with the Paydlux approver key"
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        switch status {
        case errSecSuccess:
            guard let data = out as? Data else { throw StoreError.readFailed(status) }
            guard data.count == 32 else { throw StoreError.wrongSize }
            return data
        case errSecItemNotFound:      throw StoreError.notFound
        default:                      throw StoreError.readFailed(status)
        }
    }

    /// Metadata only, so the settings screen can say "no key yet" without
    /// demanding a face to answer.
    static func exists() -> Bool {
        // interactionNotAllowed is the current way to say "answer from metadata
        // only, never prompt". The old kSecUseAuthenticationUI key is deprecated
        // and, left in place, would pop a Face ID sheet just to answer whether a
        // key exists.
        let context = LAContext()
        context.interactionNotAllowed = true
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnAttributes as String: true,
            kSecUseAuthenticationContext as String: context,
        ]
        // `== errSecSuccess` here is wrong, and the wrongness is invisible: an
        // item carrying .biometryCurrentSet answers a no-prompt lookup with
        // errSecInteractionNotAllowed, not errSecSuccess. The item EXISTS; the
        // OS simply refuses to hand over attributes without a face. Reading that
        // as "no key" sends a person who already enrolled to the seed screen on
        // every relaunch — which looks exactly like the key was never added, and
        // leaves no way to remove it because the menu that removes it lives on
        // the screen they can no longer reach.
        switch SecItemCopyMatching(query as CFDictionary, nil) {
        case errSecSuccess, errSecInteractionNotAllowed: return true
        default:                                         return false
        }
    }

    static func delete() {
        SecItemDelete([
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ] as CFDictionary)
    }
}
