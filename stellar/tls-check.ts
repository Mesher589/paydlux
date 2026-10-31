#!/usr/bin/env npx tsx
// The desk on a real domain over real TLS. This one needs the named Cloudflare
// tunnel to exist, so it is not part of the default suite — it is the check you
// run before telling anyone the link is safe to use.
//
//   npx tsx stellar/tls-check.ts
//
// What it insists on:
//   - https on paydlux.com works and the certificate is a real one for the zone
//   - plain http is redirected, never served
//   - the desk refuses any Host that is not its own, so the loopback port cannot
//     be driven directly and bypass TLS
//   - the portal key gate still holds over the public path
//   - the approver app is reachable over TLS, with its CSP intact
import { PUBLIC_HOST, tunnelReady } from "./tunnel.ts";

let pass = 0, fail = 0;
const check = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705 " + m)) : (fail++, console.log("  \u274c " + m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);
const run = () => {
  console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
  process.exit(fail ? 1 : 0);
};

const main = async () => {
  console.log("\ndesk.paydlux.com — TLS, Host pinning, HTTPS-only\n");
  if (!tunnelReady()) {
    console.log("SKIP: this machine has no named tunnel. Setup:");
    console.log("  cloudflared tunnel login");
    console.log("  cloudflared tunnel create paydlux-desk");
    console.log("  cloudflared tunnel route dns paydlux-desk " + PUBLIC_HOST);
    process.exit(0);
  }

  step("0. an ungated public desk refuses to start");
  // The dangerous failure is forgetting a flag and bringing up a public desk
  // with no portal key. It must fail loudly at startup, not serve happily.
  const { ApprovalDesk } = await import("./desk.ts");
  let threw = "";
  try {
    // @ts-expect-error deliberately incomplete: we only need listen() to refuse
    await new ApprovalDesk({ publicHost: PUBLIC_HOST }).listen(4199);
  } catch (e) { threw = (e as Error).message; }
  check(/needs a portalKey/.test(threw), "public desk without a key: " + threw);

  step("1. TLS on the real domain");
  const health = await fetch(`https://${PUBLIC_HOST}/healthz`);
  check(health.ok, `https://${PUBLIC_HOST}/healthz -> ${health.status}`);
  check(health.headers.get("strict-transport-security")?.includes("max-age=31536000") === true,
    "HSTS header present: " + health.headers.get("strict-transport-security"));

  step("2. plain HTTP is refused, not served");
  const plain = await fetch(`http://${PUBLIC_HOST}/healthz`, { redirect: "manual" });
  check(plain.status === 301 || plain.status === 308,
    `http:// -> ${plain.status}`);
  check((plain.headers.get("location") ?? "").startsWith(`https://${PUBLIC_HOST}/`),
    "redirects to https: " + plain.headers.get("location"));
  const followed = await fetch(`http://${PUBLIC_HOST}/healthz`);
  check(followed.ok && followed.url.startsWith("https://"),
    "following the redirect lands on https: " + followed.url);

  step("3. the loopback port cannot be driven directly");
  const direct = await fetch("http://127.0.0.1:4022/healthz");
  check(direct.status === 403, `direct hit on 127.0.0.1:4022 -> ${direct.status}`);
  const body = await direct.text();
  check(body.includes(PUBLIC_HOST), "refusal names the only accepted host");
  const spoofed = await fetch("http://127.0.0.1:4022/list", {
    headers: { host: "evil.example" },
  });
  check(spoofed.status === 403, `spoofed Host -> ${spoofed.status}`);

  step("4. the portal key gate still holds over the public path");
  const portal = await fetch(`https://${PUBLIC_HOST}/`);
  check(portal.status === 403, `portal without the key -> ${portal.status}`);
  const list = await fetch(`https://${PUBLIC_HOST}/list`);
  check(list.status === 403, `/list without the key -> ${list.status}`);
  const challenge = await fetch(`https://${PUBLIC_HOST}/challenge/pay_0001`);
  check(challenge.status === 403, `/challenge without the key -> ${challenge.status}`);

  step("5. the approver app over TLS keeps its CSP");
  const app = await fetch(`https://${PUBLIC_HOST}/phone/`);
  check(app.status === 403, `app without the key -> ${app.status}`);
  const appjs = await fetch(`https://${PUBLIC_HOST}/phone/app.js`);
  check(appjs.status === 403, `app.js without the key -> ${appjs.status}`);

  // Positive half: with the key the app must actually load over TLS. Pass the
  // key in from the running story: PAYDLUX_PORTAL_KEY=... npx tsx ...
  const key = process.env.PAYDLUX_PORTAL_KEY;
  if (!key) {
    console.log("  (skipped: set PAYDLUX_PORTAL_KEY to also check the app loads with the key)");
  } else {
    const q = "?k=" + encodeURIComponent(key);
    const okApp = await fetch(`https://${PUBLIC_HOST}/phone/${q}`);
    const html = await okApp.text();
    check(okApp.status === 200 && html.includes("Paydlux Approver"),
      `app loads over TLS with the key -> ${okApp.status}`);
    check(!/<script>/.test(html), "no inline script, so script-src 'self' holds");
    check(okApp.headers.get("content-security-policy")?.includes("connect-src 'self'") === true,
      "CSP pins the app to its own origin over TLS");
    const okJs = await fetch(`https://${PUBLIC_HOST}/phone/app.js${q}`);
    check(okJs.status === 200 && okJs.text !== undefined, "app.js served with the key");
    const traversal = await fetch(`https://${PUBLIC_HOST}/phone/..%2Fstellar%2Fvault.ts${q}`);
    check(traversal.status === 404 || traversal.status === 400,
      `path traversal over TLS refused -> ${traversal.status}`);
  }

  run();
};

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
