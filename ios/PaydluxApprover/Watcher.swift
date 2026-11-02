import UIKit
import BackgroundTasks

/// Notifications and the icon badge.
///
/// Why a local notification and not APNs push: push needs a server, an Apple
/// Developer account, a device-token registry, and a place to store which phone
/// belongs to which vault. That is a real privacy surface for an app whose whole
/// job is to say no to payments. A local notification driven by a background
/// fetch needs none of it: the app already knows the desk URL, it asks the desk
/// for a count, and it tells the phone.
///
/// What it does NOT do: it never carries an amount or a payee in the alert. A
/// lock-screen notification that reads "4.50 USDC to GA7GYY…" is a payment
/// prompt on a screen you did not unlock deliberately. The alert says "a payment
/// is waiting" and nothing else; the reading happens in the app, behind Face ID.
final class Watcher {
    static let shared = Watcher()
    private init() {}
    private let fetchID = "com.paydlux.approver.fetch"
    private var lastNotified = Set<String>()

    func register() {
        // The scheduler hands back a BGTask; this identifier was registered as a
        // refresh task, so narrow it and drop anything else rather than force-
        // casting. A crash in a background handler is a silent dead approver.
        BGTaskScheduler.shared.register(forTaskWithIdentifier: fetchID, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else { task.setTaskCompleted(success: false); return }
            self.handle(task: refresh)
        }
    }

    /// Ask once, at launch. Denied permission is not an error to surface: the
    /// in-app badge and the queue still work, and a payment approver should not
    /// nag for a permission it can do without.
    func askForPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { _, _ in }
    }

    func schedule() {
        // BGAppRefreshTaskRequest has earliestBeginDate but no expiresAt — that
        // one belongs to BGProcessingTaskRequest. iOS decides how long a refresh
        // gets; asking for a budget here would not be honoured anyway.
        let request = BGAppRefreshTaskRequest(identifier: fetchID)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }

    /// Called by the UI whenever the page reports a count. Keeps the badge
    /// truthful while the app is open.
    @MainActor func report(waiting: Int) {
        // UNUserNotificationCenter.setBadgeCount is the current API (iOS 16+);
        // UIApplication.applicationIconBadgeNumber is deprecated at this target.
        UNUserNotificationCenter.current().setBadgeCount(waiting)
    }

    private func handle(task: BGAppRefreshTask) {
        schedule()   // always re-arm before doing work, or the app stops waking
        let work = Task {
            do {
                let ids = try await Self.pendingIDs()
                let fresh = Set(ids).subtracting(lastNotified)
                if !fresh.isEmpty { notify(count: fresh.count) }
                lastNotified = Set(ids)
                task.setTaskCompleted(success: true)
            } catch {
                task.setTaskCompleted(success: false)
            }
        }
        task.expirationHandler = { work.cancel() }
    }

    /// The desk's queue, read with the portal key from the stored link. Only the
    /// ids and statuses are read; nothing here is shown to the user.
    private static func pendingIDs() async throws -> [String] {
        guard let link = LinkStore.load(), let portal = LinkResolver.portalKey(in: link)
        else { return [] }
        var comps = URLComponents(string: "https://\(Bridge.deskHost)/queue")!
        comps.queryItems = [URLQueryItem(name: "k", value: portal)]
        var request = URLRequest(url: comps.url!)
        request.timeoutInterval = 15
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else { return [] }
        struct Row: Decodable { let id: String; let status: String }
        let rows = try JSONDecoder().decode([Row].self, from: data)
        return rows.filter { $0.status == "pending" || $0.status == "awaiting_phone" }.map(\.id)
    }

    private func notify(count: Int) {
        let content = UNMutableNotificationContent()
        content.title = "Paydlux"
        content.body = count == 1
            ? "A payment is waiting for you."
            : "\(count) payments are waiting for you."
        content.sound = .default
        content.badge = NSNumber(value: count)
        let request = UNNotificationRequest(
            identifier: "paydlux-waiting-\(Date().timeIntervalSince1970)",
            content: content, trigger: nil)   // deliver now
        UNUserNotificationCenter.current().add(request)
    }
}

/// The host constant, shared with the WebView file without a circular import.

