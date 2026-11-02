import Foundation

/// Turning a link a person tapped into the URL this app will actually load.
///
/// This is the security boundary of the whole app. The link arrives from Mail,
/// Messages, a QR code or a browser — none of which are trusted — and it decides
/// which page gets to sit in front of a signing key. So the rule is:
///
///   The origin is never taken from the link.
///
/// A `paydlux://` link carries a host field, and that field is *discarded*: the
/// URL is rebuilt from the pinned host and only the query items are copied over.
/// A message that says `paydlux://evil.example/?k=x` therefore loads
/// `desk.paydlux.com`, not `evil.example`. An `https://` link is accepted only
/// when its host already equals the pinned one.
///
/// Kept as a pure static function with no SwiftUI, no Keychain and no WebView so
/// it can be compiled and attacked with plain `swiftc`, on any machine, without
/// a simulator:
///
///   swiftc ios/PaydluxApprover/LinkResolver.swift ios/Checks/link-check.swift -o /tmp/linkcheck
///   /tmp/linkcheck
enum LinkResolver {
    /// The one desk this build will talk to. Deliberately not configurable: an
    /// approver that can be pointed at an arbitrary host is a phishing surface.
    static let deskHost = "desk.paydlux.com"

    /// The page the approver lives on.
    static let deskPath = "/phone/"

    /// Returns the URL to load, or nil if the link must be refused.
    static func resolve(_ link: URL) -> URL? {
        if link.scheme == "https", link.host == deskHost {
            // Already the right origin. Note the exact host match: a subdomain
            // of paydlux.com is not the desk.
            return link
        }
        if link.scheme == "paydlux" {
            // Rebuild. Scheme, host and path come from us; only the query is
            // copied, and that is where the portal key lives.
            guard var comps = URLComponents(string: "https://\(deskHost)\(deskPath)") else { return nil }
            let incoming = URLComponents(url: link, resolvingAgainstBaseURL: false)
            comps.queryItems = incoming?.queryItems
            return comps.url
        }
        return nil
    }

    /// The portal key inside a stored link, if there is one. Used by the
    /// background poll, which has to authenticate to /queue without a WebView.
    static func portalKey(in link: URL) -> String? {
        URLComponents(url: link, resolvingAgainstBaseURL: false)?
            .queryItems?.first(where: { $0.name == "k" })?.value
    }
}
