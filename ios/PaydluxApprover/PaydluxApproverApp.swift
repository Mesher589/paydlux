import UIKit
import SwiftUI
import WebKit

@main
struct PaydluxApproverApp: App {
    @StateObject private var model = ApproverModel()

    init() {
        // Registration has to happen before this call returns, and the
        // identifier must appear in Info.plist under
        // BGTaskSchedulerPermittedIdentifiers or register() throws. Without
        // either of these the app never wakes and never notifies, which is a
        // silent failure: the approver looks idle rather than broken.
        Watcher.shared.register()
        Watcher.shared.askForPermission()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(model)
                .onOpenURL { url in
                    // The seller's approval link, opened from Mail or Messages.
                    // The app keeps the URL and hands it to the web layer, which
                    // is the only place that parses it.
                    model.capture(link: url)
                }
        }
    }
}

/// Brand colours, defined in code. There is no asset catalog in this project, so
/// Color("SomeName") silently resolves to nothing and the app draws on an
/// undefined background — which is exactly what it looked like on the simulator.
enum Brand {
    static let background = Color(red: 0.043, green: 0.059, blue: 0.078) // #0B0F14
    static let accent = Color(red: 0.388, green: 0.639, blue: 1.0)       // Paydlux blue
}

struct RootView: View {
    @EnvironmentObject var model: ApproverModel

    var body: some View {
        ZStack {
            Brand.background.ignoresSafeArea()
            switch model.stage {
            case .locked:
                LockView(model: model)
            case .needsKey:
                EnrolView(model: model)
            case .needsLink:
                LinkView(model: model)
            case .ready:
                DeskView(model: model)
            }
        }
        // Pinned to dark on purpose: the approver page inside the WebView is a
        // dark design, and light-mode chrome over a dark page makes the Approve
        // button the least obvious thing on the screen.
        .preferredColorScheme(.dark)
        .tint(Brand.accent)
        .task { await model.start() }
    }
}

/// The gate before anything payment-shaped is on screen.
///
/// Why a gate at all: the web layer holds the portal key and would otherwise
/// render the queue as soon as it loads. A person who picks up an unlocked
/// phone in a pocket should not be able to reach the Approve button. Face ID is
/// asked for here, once, before the desk is loaded — and again by the Keychain
/// at the moment of signing.
struct LockView: View {
    @ObservedObject var model: ApproverModel

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "lock.shield.fill")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Paydlux").font(.title.bold())
            Text("Approve payments with Face ID.\nYour key never leaves this device.")
                .font(.callout)
                .multilineTextAlignment(.center)
                .foregroundStyle(.secondary)
            Button {
                Task { await model.unlock() }
            } label: {
                Text("Unlock").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            if let message = model.lockMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(32)
    }
}

/// Enrolment: paste the approver seed once.
///
/// The seed is decoded here only to get its 32 raw bytes, then dropped. What is
/// stored is the raw key in the Keychain behind biometrics. The web layer never
/// sees the seed at all — it gets the public half, and asks for signatures.
struct EnrolView: View {
    @ObservedObject var model: ApproverModel
    @State private var seed = ""
    @State private var reveal = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Add your approver key").font(.title2.bold())

            // A key already on the device has to be visible here. Without this
            // line the screen reads "you have no key" while the Keychain holds
            // one, and the only way to remove a key lived in a menu on a screen
            // this state makes unreachable — so a person who wants to start over
            // cannot. Replace is the safe path: it deletes then stores.
            if model.keyAlreadyOnDevice {
                Text("A key is already stored on this device"
                     + (model.keyPublicSummary.map { " (\($0))" } ?? "")
                     + ". Adding a new one replaces it.")
                    .font(.callout)
                    .foregroundStyle(.tint)
                Button("Forget the stored key", role: .destructive) {
                    model.forgetKey()
                    model.enrolMessage = "Key removed. This device can no longer sign."
                }
                .font(.footnote)
            }

            Text("""
            Paste the seed the seller gave you, once.

            It is stored in this iPhone's Keychain, behind Face ID, and is not \
            included in any backup. It is the approval half of your vault: with \
            it you can approve a payment, and it cannot move money on its own.
            """)
            .font(.callout)
            .foregroundStyle(.secondary)

            // One field, masked or not. A visible seed is a seed a shoulder can
            // read, so masked is the default and the text is cleared the moment
            // enrolment is attempted either way.
            Group {
                if reveal {
                    TextField("S…", text: $seed)
                } else {
                    SecureField("S…", text: $seed)
                }
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .font(.system(.body, design: .monospaced))
            .padding(12)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))

            Toggle("Show what I am typing", isOn: $reveal)
                .font(.footnote)

            Button {
                Task { await model.enrol(seed: seed); seed = "" }
            } label: {
                Text("Store on this device").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(seed.trimmingCharacters(in: .whitespaces).isEmpty)

            if let message = model.enrolMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(24)
    }
}

/// The desk link, entered once. Normally this arrives by tapping the link the
/// seller sent, but that only works if the app is already installed and the link
/// is opened *in* it — so a first run that enrolled the key needs a way to
/// accept the address by hand. Validated by model.capture(), which refuses
/// anything that is not https on the desk host: a free-text URL box next to a
/// signing key is a phishing surface unless the host is pinned.
struct LinkView: View {
    @ObservedObject var model: ApproverModel
    @State private var link = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Connect to your desk").font(.title2.bold())
            Text("Paste the desk link the seller sent you, or type the address "
                + "exactly as they gave it. The app only accepts https links to "
                + Bridge.deskHost + " — anything else is refused.")
            .font(.callout)
            .foregroundStyle(.secondary)

            TextField("https://desk.paydlux.com/phone/?k=...", text: $link)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .font(.system(.footnote, design: .monospaced))
                .padding(12)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 12))

            Button {
                model.capture(link: URL(string: link.trimmingCharacters(in: .whitespaces))
                              ?? URL(string: "https://invalid.invalid")!)
            } label: {
                Text("Connect").frame(maxWidth: .infinity).padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty)

            if let message = model.lockMessage {
                Text(message).font(.footnote).foregroundStyle(.red)
            }
        }
        .padding(24)
    }
}

/// The desk itself: the same audited approver page, in a WKWebView.
///
/// Deliberate choices in the configuration:
///   * the page is loaded from https://desk.paydlux.com — the audited server,
///     not a bundled copy. A bundled copy would be a frozen version of the
///     approver that keeps signing after a security fix ships.
///   * no arbitrary loads, no mixed content, no JS eval of remote strings.
///   * the only native bridge is: read the key, report the queue count, badge,
///     notify. There is no bridge that can move money by itself.
struct DeskView: View {
    @ObservedObject var model: ApproverModel

    var body: some View {
        VStack(spacing: 0) {
            Header(model: model)
            WebViewHost(model: model)
                .overlay {
                    if model.webError != nil {
                        OfflineCard(model: model)
                    }
                }
        }
    }
}

private struct Header: View {
    @ObservedObject var model: ApproverModel
    @State private var confirmForget = false

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("Paydlux").font(.headline)
                Text(model.linkSummary ?? "no approval link yet")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if model.waiting > 0 {
                Text("\(model.waiting) waiting")
                    .font(.caption.bold())
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(.red.opacity(0.18), in: Capsule())
                    .foregroundStyle(.red)
            }
            // Removal has to be visible. It used to live only inside the menu
            // below, and the web page inside the WebView deliberately hides its
            // own remove control (it would clear a browser key that does not
            // exist here and look like it worked). So on the phone there was no
            // visible way to take the seed off the device — the exact complaint.
            Button("Remove key", role: .destructive) { confirmForget = true }
                .font(.footnote)
                .buttonStyle(.bordered)
            Menu {
                Button("Re-add key", action: { model.showEnrol() })
                Button("Forget this key", role: .destructive) { confirmForget = true }
                Button("Reload desk") { model.reloadRequested += 1 }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
        .background(.bar)
        // A visible destructive button is only safe if it cannot fire on a
        // mis-tap: the confirmation names the consequence in plain words.
        .confirmationDialog("Remove the approver key from this iPhone?",
                            isPresented: $confirmForget,
                            titleVisibility: .visible) {
            Button("Remove key", role: .destructive) { model.forgetKey() }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("This iPhone can no longer approve payments. The seller must give you a seed again to start over.")
        }
    }
}

private struct OfflineCard: View {
    @ObservedObject var model: ApproverModel

    var body: some View {
        VStack(spacing: 14) {
            Text("Cannot reach your desk").font(.headline)
            Text(model.webError ?? "")
                .font(.callout).foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Try again") { model.reloadRequested += 1 }
                .buttonStyle(.borderedProminent)
        }
        .padding(28)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18))
        .padding(24)
    }
}
