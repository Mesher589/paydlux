#!/usr/bin/env npx tsx
// The approver page must not reference an element that isn't in its own HTML.
//
// Why this exists: `show("seedRow", false)` in paintKeyState named an id that
// index.html never defined. `$("seedRow")` returned null, `.classList` threw,
// and the throw aborted the boot sequence one line before paintLinkState() — so
// the queue panel stayed hidden and the Approve buttons never appeared. It only
// happened inside the native app, because that branch is guarded by
// native.available(), so every browser test passed while the phone was broken.
// A missing id is a one-line typo with a UI-shaped failure; this makes it a
// build failure instead.
//
//   npx tsx phone-app/ui-check.ts
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "index.html"), "utf8");
const js = readFileSync(join(here, "app.js"), "utf8");
const sw = readFileSync(join(here, "sw.js"), "utf8");

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705 " + m)) : (fail++, console.log("  \u274c " + m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);

const ids = new Set<string>();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);

step("1. every element the page reaches for exists in the page");
// The four helpers that take an element id, plus the raw DOM call. Anything
// reaching an element by another route (querySelector on a class) is not an id
// lookup and cannot hit this bug.
const wanted = new Set<string>();
const patterns = [
  /\$\(\s*"([^"]+)"\s*\)/g,
  /\bshow\(\s*"([^"]+)"/g,
  /\bset\(\s*"([^"]+)"/g,
  /\berr\(\s*"([^"]+)"/g,
  /getElementById\(\s*"([^"]+)"\s*\)/g,
];
for (const re of patterns) for (const m of js.matchAll(re)) wanted.add(m[1]);
const missing = [...wanted].filter((id) => !ids.has(id));
ok(missing.length === 0, missing.length === 0
  ? `${wanted.size} ids referenced by app.js, all present in index.html`
  : `MISSING from index.html: ${missing.join(", ")}`);

step("2. the boot sequence cannot be aborted by one dead lookup");
// The helpers themselves must be null-safe, so a future stale id degrades to a
// cosmetic miss instead of killing the render.
ok(/const show = \(id, on = true\) => \{ const el = \$\(id\); if \(el\)/.test(js),
  "show() is null-safe");
ok(/const set = \(id, v\) => \{ const el = \$\(id\); if \(el\)/.test(js),
  "set() is null-safe");
ok(/const err = \(id, msg\) => \{ const el = \$\(id\); if \(el\)/.test(js),
  "err() is null-safe");

step("3. the native app does not offer a browser-only control");
// In the WKWebView the key is in the Keychain, so the page's "Remove key"
// button would clear a browser key that does not exist and report success while
// the real signing key stayed on the device.
ok(/if \(native\.available\(\)\) show\("forget", false\)/.test(js),
  "the remove-key button is hidden when the native bridge holds the key");
ok(!/show\("seedRow"/.test(js), "the stale seedRow reference is gone");

step("4. the offline shell caches code, never payment data");
// Re-asserted here because this file is the cheap static gate: the rule belongs
// next to the other rules about the page itself.
ok(!/cache\.addAll|caches\.open\(\s*["']payments/.test(sw), "no payment cache in sw.js");

console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
process.exit(fail ? 1 : 0);
