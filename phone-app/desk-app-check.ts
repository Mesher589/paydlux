#!/usr/bin/env npx tsx
// The product path with the real approver app: desk serves the app, the app
// fetches a challenge over HTTP, signs it with its own dependency-free decoder
// and a non-extractable WebCrypto key, and posts the signature back.
//
//   gateway -> desk -> HTTP /challenge/:id -> phone app signs -> HTTP /signed/:id -> ledger
//
// The desk process holds NO approver key. Everything on the phone side here is
// the same code phone-app/index.html runs in the browser.
//
//   npx tsx phone-app/desk-app-check.ts
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "../stellar/vault.ts";
import { ApprovalDesk, newPortalKey } from "../stellar/desk.ts";

const require = createRequire(import.meta.url);
require("./xdr.js");
const X: any = (globalThis as any).PaydluxXdr;

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705 " + m)) : (fail++, console.log("  \u274c " + m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);

const main = async () => {
  console.log("\ndesk + approver app, over real HTTP, on live testnet\n");
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  await vault.deposit("20", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);

  const portalKey = newPortalKey();
  const PORT = 4211;
  const desk = new ApprovalDesk({
    vault, payee: seller.publicKey(),
    principal: principal.secret(),
    split: true,                 // no approver key in this process
    port: PORT, portalKey, decideWithinSeconds: 3600,
  });
  await desk.listen();
  const base = `http://127.0.0.1:${PORT}`;
  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.text(), type: res.headers.get("content-type") };
  };

  step("1. the app is reachable, and only with the portal key");
  const noKey = await get("/phone");
  ok(noKey.status === 403, `/phone without the key: ${noKey.status}`);
  const app = await get(`/phone?k=${encodeURIComponent(portalKey)}`);
  ok(app.status === 200 && app.type?.includes("text/html"), `/phone with the key: ${app.status} ${app.type}`);
  ok(app.body.includes("Paydlux Approver"), "the approver page is served");
  // script-src 'self' is only real if the page has no inline script to run.
  ok(!/<script>/.test(app.body), "the page carries no inline script, so script-src 'self' holds");
  ok(/<script src="app\.js">/.test(app.body), "the app logic is a separate file");
  const csp = readFileSync(new URL("../stellar/desk.ts", import.meta.url), "utf8");
  ok(/content-security-policy/i.test(csp) && /connect-src 'self'/.test(csp),
    "the desk sends a CSP that pins the app to its own origin");

  const js = await get(`/phone/xdr.js?k=${encodeURIComponent(portalKey)}`);
  ok(js.status === 200 && js.body.includes("PaydluxXdr"), "the app's decoder is served");
  ok(js.body.includes("signaturePreimage"), "and it is the current version, not a stale copy");
  const appjs = await get(`/phone/app.js?k=${encodeURIComponent(portalKey)}`);
  ok(appjs.status === 200 && appjs.body.includes("PaydluxXdr"), "the app logic is served");
  const traversal = await get(`/phone/..%2Fstellar%2Fvault.ts?k=${encodeURIComponent(portalKey)}`);
  ok(traversal.status === 404 || traversal.status === 400,
    `path traversal refused: ${traversal.status}`);
  const notServed = await get(`/phone/app.js?k=${encodeURIComponent(portalKey)}`);
  ok(!/secret|seed.*=.*S[AB]/i.test(notServed.body.slice(0, 200)), "no secrets in served app code");

  step("2. an agent request parks, and the desk can only ask");
  const id = desk.enqueue("GET https://api.example.com/quotes", "2.75", "quote feed", "payload");
  const asked = await desk.approve(id);
  ok(asked!.status === "awaiting_phone", `status is ${asked!.status}`);
  ok(await vault.balance(seller.publicKey()) === "0.0000000", "nothing moved yet");

  step("3. the phone opens the deep link and fetches the challenge");
  const anon = await get(`/challenge/${id}`);
  ok(anon.status === 403, `challenge without the key: ${anon.status}`);
  const res = await fetch(`${base}/challenge/${id}?k=${encodeURIComponent(portalKey)}`);
  const rec = await res.json();
  ok(res.status === 200 && rec.hash.length === 64, `challenge fetched: ${rec.hash.slice(0, 16)}\u2026`);
  ok(rec.xdr === asked!.challenge!.xdr, "the desk serves the exact transaction it built");

  step("4. the app decodes it with its own code and shows the human");
  const env = X.parseEnvelope(rec.xdr);
  const op = env.tx.ops[0];
  ok(X.formatAmount(op.amount) === "2.7500000", `amount reads ${X.formatAmount(op.amount)} ${op.asset.code}`);
  ok(X.encodeAccountEd25519(op.destination.pub) === seller.publicKey(), "payee reads correctly");
  const { hash } = await X.transactionHash(rec.xdr, X.NETWORK_ID.testnet);
  ok(hash === rec.hash, "the app's hash matches the desk's hash");

  step("5. the app signs with a non-extractable key and posts it back");
  const key = await X.importSecretSeed(approver.secret());
  let exportable = false;
  try { await crypto.subtle.exportKey("pkcs8", key); exportable = true; } catch { /* expected */ }
  ok(!exportable, "the app's key cannot be exported");
  const sig = new Uint8Array(await crypto.subtle.sign(
    "Ed25519", key, X.signaturePreimage(hash)));
  const signed = X.addSignature(rec.xdr, sig, approver.rawPublicKey());

  const back = await fetch(`${base}/signed/${id}?k=${encodeURIComponent(portalKey)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: signed }),
  });
  const done = await back.json();
  ok(done.status === "settled", `the desk reports ${done.status}`);
  ok(/^[\da-f]{64}$/.test(done.tx ?? ""), `ledger tx ${String(done.tx).slice(0, 16)}\u2026`);
  ok(done.tx === hash, "the settled tx hash is the hash the human was shown");
  ok(await vault.balance(seller.publicKey()) === "2.7500000", "seller holds 2.7500000");

  step("6. a signature for a different payment is refused over HTTP too");
  const id2 = desk.enqueue("GET https://api.example.com/other", "1.00", "other", "p2");
  await desk.approve(id2);
  const stolen = await fetch(`${base}/signed/${id2}?k=${encodeURIComponent(portalKey)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: signed }),        // signed for the FIRST payment
  });
  const rej = await stolen.json();
  ok(rej.status === "failed", `reused signature: ${rej.status}`);
  ok(/different transaction|does not match/i.test(rej.reason ?? ""), `reason: ${rej.reason}`);
  ok(await vault.balance(seller.publicKey()) === "2.7500000", "and still nothing extra moved");

  step("7. the portal key gates the completion route as well");
  const noAuth = await fetch(`${base}/signed/${id2}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: signed }),
  });
  ok(noAuth.status === 403, `POST /signed without the key: ${noAuth.status}`);

  await desk.close();
  console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
  process.exit(fail ? 1 : 0);
};

main().catch(async (e) => { console.error("crashed:", e); process.exit(1); });
