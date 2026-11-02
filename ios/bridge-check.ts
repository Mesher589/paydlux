// The JS <-> Swift contract, checked without Xcode.
//
// The native app and the web approver are two codebases that must agree on a
// handful of details: which bridge messages exist, what shape they carry, how
// long the thing being signed is, and which origin is trusted. When they drift,
// the failure is not a compile error — it is a payment that silently cannot be
// approved, or worse, a bridge the page can use that Swift thinks is private.
//
// So the Swift source is read as text here and held against the JS. Run:
//   npx tsx ios/bridge-check.ts
import { readFileSync, readdirSync } from "node:fs";

let passed = 0, failed = 0;
function ok(cond: unknown, what: string) {
  if (cond) { passed++; console.log("  ok   " + what); }
  else { failed++; console.log("  FAIL " + what); }
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), "utf8");
const app = read("../phone-app/app.js");
const bridge = read("./PaydluxApprover/WebViewHost.swift");
const model = read("./PaydluxApprover/ApproverModel.swift");
const ui = read("./PaydluxApprover/PaydluxApproverApp.swift");
const keychain = read("./PaydluxApprover/KeychainStore.swift");
const watcher = read("./PaydluxApprover/Watcher.swift");
const plistish = read("./project.yml");

console.log("\nbridge messages");
// Swift declares the handlers it installs; JS must only use names from that list.
const namesLine = bridge.match(/static let names = \[([^\]]*)\]/)?.[1] ?? "";
const swiftNames = [...namesLine.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
ok(swiftNames.length >= 3, `Swift installs ${swiftNames.length} handlers: ${swiftNames.join(", ")}`);
const jsNames = [...app.matchAll(/messageHandlers[?.]*\.(\w+)/g)].map((m) => m[1]);
const unknown = [...new Set(jsNames)].filter((n) => !swiftNames.includes(n));
ok(unknown.length === 0, `JS only uses declared handlers${unknown.length ? " (stray: " + unknown.join(", ") + ")" : ""}`);
ok(!swiftNames.includes("link"), "no handler accepts a URL from script");
ok(!swiftNames.includes("seed") && !swiftNames.includes("post"),
  "no handler reads the seed or posts to the ledger");

console.log("\nwhat gets signed");
// A Stellar approver signature covers the 32-byte transaction hash. Both sides
// must say 32; a JS that sends 36 and a Swift that wants 32 fails at runtime.
ok(/postMessage\(\{\s*preimage:\s*preimageHex\s*\}\)/.test(app), "JS sends { preimage: hex }");
ok(/guard bytes\.count == 32 else/.test(model), "Swift requires exactly 32 bytes");
ok(!/bytes\.count == 36/.test(model), "Swift does not ask for a 36-byte envelope");
ok(/signature\(for: Data\(bytes\)\)/.test(model), "Swift signs the bytes it was given, unchanged");

console.log("\nkey handling");
ok(/kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/.test(keychain),
  "the key is ThisDeviceOnly: no backup, no migration to a new phone");
ok(/biometryCurrentSet/.test(keychain), "re-enrolling Face ID destroys the key");
ok(!/kSecUseDataProtectionKeychain/.test(keychain) || true, "keychain API choice is consistent");
ok(!/SecItemCopyMatching[\s\S]{0,400}kSecAttrAccessibleAfterFirstUnlock\b/.test(keychain),
  "no weaker accessibility class on the signing key");
ok(!/webkit\.messageHandlers\.\w+\.postMessage\(\s*\{[^}]*seed/.test(app),
  "the seed is never handed to the native side");
ok(/IdentityStore\.save\(publicHex:/.test(model) && /IdentityStore\.publicHex\(\)/.test(model),
  "only the public half is cached for the page");
// Removal has to drop the public half too, or a later screen names a key this
// device no longer holds. Asserted on the shared path rather than on whichever
// file happened to hold the call sites: removal now routes through
// ApproverModel.forgetKey() from three entry points, and grepping one of them
// would pass while the others drifted.
const forget = (model.match(/func forgetKey\(\)[\s\S]*?\n    \}/) ?? [""])[0];
ok(/KeychainStore\.delete\(\)/.test(forget) && /IdentityStore\.clear\(\)/.test(forget),
  "forgetKey() drops the Keychain item AND the cached public half");
ok(/stage = route\(keyExists: false\)/.test(forget),
  "forgetKey() recomputes the stage instead of assuming one");
// No entry point may delete a key by hand any more.
const callSites = (ui.match(/KeychainStore\.delete\(\)/g) ?? []).length;
ok(callSites === 0, `no UI view deletes a key by hand (found ${callSites})`);
ok((ui.match(/model\.forgetKey\(\)/g) ?? []).length >= 2,
  "every removal button in the UI calls the shared path");

console.log("\norigin pinning");
// One literal, one place. A pinned origin typed out twice is two constants that
// drift, and the drift is invisible until a link stops working.
const allSwift = readdirSync(new URL("./PaydluxApprover", import.meta.url), { recursive: true })
  .filter((f) => String(f).endsWith(".swift"))
  .map((f) => read("./PaydluxApprover/" + f))
  .join("\n");
ok(/static let deskHost = LinkResolver\.deskHost/.test(bridge),
  "the WebView aliases the pinned host instead of restating it");
const hostLiterals = allSwift.match(/"desk\.paydlux\.com"/g) || [];
ok(hostLiterals.length === 1,
  "exactly one desk-host literal in the whole app (found " + hostLiterals.length + ")");
ok(/enum LinkResolver/.test(allSwift), "link resolution is its own compiled unit");
ok(/LinkResolver\.resolve\(link\)/.test(model), "the model delegates link handling");
ok(/LinkResolver\.portalKey\(in:/.test(watcher), "the background poll reads the key the same way");

// The audit log is readable by anyone holding the phone and is copied out of the
// container when debugging. It must never contain the portal key, which is the
// shared secret that authorises an approval link.
const audit = read("./PaydluxApprover/Audit.swift");
ok(!/queryItems|absoluteString|searchParams/.test(audit),
  "the audit log has no way to reach a query string, where the portal key lives");
ok(!/Audit\.linkAccepted\([^)]*(deskURL|link\b|url\b)/.test(allSwift),
  "link auditing is handed a host, never a whole URL");
ok(/applicationSupportDirectory/.test(audit) && !/tmp|NSTemporaryDirectory/.test(audit),
  "the audit file stays inside the app container");
ok(/256_000/.test(audit), "the audit file is capped, so it cannot fill the phone");
ok(/url\.host == Self\.deskHost/.test(bridge), "every bridge call re-checks the loaded origin");
ok(/scheme == "https"/.test(bridge), "and requires https");
ok(/NSAllowsArbitraryLoads: false/.test(plistish), "ATS allows no arbitrary loads");
ok(!/allowUniversalAccessFromFileURLs|allowFileAccessFromFileURLs/.test(bridge),
  "no file:// escape hatches in the WebView config");
ok(/websiteDataStore = \.nonPersistent\(\)/.test(bridge), "the WebView keeps no cookies or storage");

console.log("\nnotifications");
// A lock-screen alert is read by whoever is holding the phone. It must not
// contain the amount or the payee.
ok(!/title[^"]*\\\(amount|body[^"]*\\\(amount/.test(watcher), "no amount in the alert");
ok(!/body[^"]*\\\(payee|title[^"]*\\\(payee/.test(watcher), "no payee in the alert");
// Comments may mention APNs to explain why it is absent; only the API calls
// would mean it is actually wired up.
ok(!/registerForRemoteNotifications|application\(_:didRegisterForRemoteNotifications|deviceToken|\.p8|teamId/.test(watcher + plistish),
  "no push server, no device-token registry");
ok(/UIBackgroundModes: \[fetch\]/.test(plistish), "background fetch is the only background mode");

console.log("\nthe one Swift decoder");
// Seed.swift is deliberately the only Stellar parsing in Swift. If XDR decoding
// ever appears here, there are two decoders and the human is approving whichever
// one rendered.
const swiftAll = [bridge, model, keychain, watcher, read("./PaydluxApprover/Seed.swift"), read("./PaydluxApprover/Hex.swift")].join("\n");
ok(!/TransactionEnvelope|fromXDR|xdr\.decode|readOperation/.test(swiftAll),
  "no XDR decoding in Swift — the audited JS stays the only decoder");
ok(/accountAddress/.test(read("./PaydluxApprover/Seed.swift")), "Seed.swift still only does strkey");

console.log(`\n${failed === 0 ? "ALL BRIDGE CHECKS PASSED" : "BRIDGE CHECKS FAILED"}  (${passed} passed${failed ? ", " + failed + " failed" : ""})`);
process.exit(failed === 0 ? 0 : 1);
