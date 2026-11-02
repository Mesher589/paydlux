import SwiftUI
import WebKit

/// The desk, in a WKWebView, plus the only bridge it is allowed to have.
///
/// Why a WebView and not a native rewrite of the approver: the approver's job is
/// to decode a Stellar transaction and show a human what it says. That decoder
/// exists, is tested (xdr-check.ts, desk-app-check.ts, xss-check.ts), and is the
/// thing standing between an agent's request and your money. Porting it to Swift
/// would create a second decoder with a second set of bugs, and the two would
/// drift. So the UI and the parsing stay in the audited code, and Swift adds
/// exactly what a browser cannot do: a Keychain key behind Face ID, a real
/// notification, and an icon badge.
///
/// The bridge is deliberately narrow. Three messages, none of which can move
/// money by themselves:
///   publicKey -> the approver's public half (public data)
///   sign      -> sign a 32-byte Stellar transaction hash; Face ID required
///   queue     -> report how many payments are waiting (drives badge + notif)
///
/// There is no message that reads the seed, no message that posts to the ledger,
/// and no message that accepts a URL — the desk link comes from the user
/// tapping it in Mail, or from the URL the WebView actually loaded, never from
/// script.
struct WebViewHost: UIViewRepresentable {
    @ObservedObject var model: ApproverModel

    func makeCoordinator() -> Bridge { Bridge(model: model) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        let controller = WKUserContentController()
        // Bridge implements WKScriptMessageHandlerWithReply, so it registers
        // through the contentWorld: overload — that is the one that takes a
        // reply-capable handler (the SDK renamed the old ...WithReply selector).
        // The reply API is what lets page code await the signature instead of
        // polling for it.
        for name in Bridge.names {
            controller.addScriptMessageHandler(context.coordinator, contentWorld: .page, name: name)
        }
        config.userContentController = controller
        config.allowsInlineMediaPlayback = false

        // No private-data surprises: the approver page must not be able to put
        // its own cookies or storage somewhere a later app could read, and the
        // WebView must not autofill anything.
        config.websiteDataStore = .nonPersistent()
        if #available(iOS 17.0, *) { config.preferences.isElementFullscreenEnabled = false }

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = true
        // The same brand colour as the SwiftUI background, given as RGB.
        // UIColor(named:) needs an asset catalog and this project has none.
        web.backgroundColor = UIColor(red: 0.043, green: 0.059, blue: 0.078, alpha: 1)
        web.allowsBackForwardNavigationGestures = false
        context.coordinator.web = web
        load(into: web, model: model)
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        // A reload request from the menu, or a link captured from Mail.
        if context.coordinator.lastReload != model.reloadRequested {
            context.coordinator.lastReload = model.reloadRequested
            load(into: web, model: model)
        }
    }

    private func load(into web: WKWebView, model: ApproverModel) {
        model.webError = nil
        guard let url = model.deskURL ?? URL(string: "https://\(Bridge.deskHost)/phone/") else {
            model.webError = "No approval link yet. Open the link the seller sent you."
            return
        }
        web.load(URLRequest(url: url))
    }
}

final class Bridge: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    // nonisolated: the background poll reads this too, and a String constant is
    // safe anywhere. Left main-actor isolated it would be an error under Swift 6
    // language mode, i.e. the notification path would stop compiling.
    /// Aliased, not restated. A pinned origin that is typed out twice is two
    /// constants that can drift; bridge-check enforces one literal in the app.
    nonisolated static let deskHost = LinkResolver.deskHost
    static let names = ["publicKey", "sign", "queue"]

    private let model: ApproverModel
    weak var web: WKWebView?
    var lastReload = 0

    init(model: ApproverModel) { self.model = model }

    // ------------------------------------------------------------- bridge
    func userContentController(_ ucc: WKUserContentController,
                               didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        // The page must be the desk. A redirect to an attacker origin inside this
        // WebView would otherwise still have the bridge available.
        guard let url = web?.url, url.host == Self.deskHost, url.scheme == "https" else {
            replyHandler(nil, "Refused: this page is not your Paydlux desk.")
            return
        }
        switch message.name {
        case "publicKey":
            replyHandler(model.publicKeyHex(), nil)

        case "sign":
            guard let body = message.body as? [String: Any],
                  let preimage = body["preimage"] as? String else {
                replyHandler(nil, "Refused: expected { preimage: hex }.")
                return
            }
            Task { @MainActor in
                do { replyHandler(["signature": try await model.sign(preimageHex: preimage)], nil) }
                catch { replyHandler(nil, (error as? LocalizedError)?.errorDescription ?? "Signing was refused.") }
            }

        case "queue":
            if let body = message.body as? [String: Any], let n = body["waiting"] as? Int {
                Task { @MainActor in model.queueCount(n) }
            }
            replyHandler(true, nil)

        default:
            replyHandler(nil, "Refused: unknown message.")
        }
    }

    // ------------------------------------------------------- navigation
    /// Only the desk origin may be displayed. Anything else — a redirect, a
    /// target=_blank, a malicious ad — is blocked rather than followed, because
    /// a page inside this WebView is a page that can ask for a signature.
    func webView(_ web: WKWebView,
                 decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url,
              url.scheme == "https", url.host == Self.deskHost else {
            decisionHandler(.cancel)
            // Worth a log line even though the UI says so: a blocked navigation
            // is an attack attempt, and the user may not be looking.
            Audit.linkRejected(navigationAction.request.url?.scheme,
                               navigationAction.request.url?.host)
            Task { @MainActor in model.webError = "Blocked a navigation away from your desk." }
            return
        }
        decisionHandler(.allow)
    }

    /// The desk 302-redirects a bare /phone to /phone/?k=<portal key>, so the
    /// keyed URL is learned here rather than relying on the page to report it.
    /// Only a URL that carries the key is stored: a keyless /phone is not a link
    /// worth remembering.
    func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
        if let url = web.url, url.host == Self.deskHost { Audit.pageLoaded(host: url.host ?? "?") }
        if let url = web.url, url.host == Self.deskHost, url.scheme == "https",
           url.query?.contains("k=") == true {
            Task { @MainActor in model.capture(link: url) }
        }
    }

    func webView(_ web: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Audit.pageFailed(error.localizedDescription)
        Task { @MainActor in model.webError = error.localizedDescription }
    }
    func webView(_ web: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in model.webError = error.localizedDescription }
    }
}
