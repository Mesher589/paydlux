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

  step("1. the app shell is public, the data behind it is not");
  // The shell (html, js, icons) carries no secret and no payment data, and it
  // has to load before the key does — that is what lets a phone install it to a
  // home screen. Every route that returns data or moves money stays gated.
  const shell = await get("/phone/");
  ok(shell.status === 200 && shell.type?.includes("text/html"), `/phone/ without the key: ${shell.status}`);
  ok(shell.body.includes("Paydlux Approver"), "the approver page is served");
  ok(!/<script>/.test(shell.body), "the page carries no inline script, so script-src 'self' holds");
  ok(/<script src="app\.js">/.test(shell.body), "the app logic is a separate file");
  ok(/rel="manifest"/.test(shell.body), "the app declares a manifest, so it installs to a home screen");
  // The hand-paste box must not be the first thing a human meets. It asks for
  // 400 characters of base64 nobody was given, and a tap on "Read it" with an
  // empty box produced "paste the transaction first" on a real phone.
  ok(/<div class="panel hidden" id="paste">/.test(shell.body),
    "the hand-paste box starts hidden; the queue is what a new device should see");
  const csp = readFileSync(new URL("../stellar/desk.ts", import.meta.url), "utf8");
  ok(/content-security-policy/i.test(csp) && /connect-src 'self'/.test(csp),
    "the desk sends a CSP that pins the app to its own origin");

  const js = await get("/phone/xdr.js");
  ok(js.status === 200 && js.body.includes("PaydluxXdr"), "the app's decoder is served");
  ok(js.body.includes("signaturePreimage"), "and it is the current version, not a stale copy");
  const appjs = await get("/phone/app.js");
  ok(appjs.status === 200 && appjs.body.includes("PaydluxXdr"), "the app logic is served");
  // The approval screen is the most dangerous place on the network to run
  // injected script: it holds the approver key. Agent-controlled text must
  // therefore never reach innerHTML.
  ok(!/\.innerHTML/.test(appjs.body), "the app never writes innerHTML, so agent text cannot become script");
  ok(/textContent/.test(appjs.body), "and it renders through textContent instead");
  const icon = await fetch(`${base}/phone/icon-192.png`);
  const iconBytes = Buffer.from(await icon.arrayBuffer());
  ok(icon.status === 200 && icon.headers.get("content-type") === "image/png", "the app icon is served as a png");
  ok(iconBytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    "and it is real png bytes, not text with replacement characters in it");
  // Regression: a request for a file that is not in the folder used to throw
  // inside the request handler and take the whole desk down. A missing file is a
  // 404 and the desk must still answer afterwards.
  const missing = await get("/phone/nope.js");
  ok(missing.status === 404, `a file that does not exist: ${missing.status}`);
  const css = await get("/phone/app.css");
  ok(css.status === 404, `the page has no stylesheet, so app.css is not a route: ${css.status}`);
  const alive = await get("/phone/app.js");
  ok(alive.status === 200, "and the desk is still serving after those");
  const traversal = await get(`/phone/..%2Fstellar%2Fvault.ts`);
  ok(traversal.status === 404 || traversal.status === 400, `path traversal refused: ${traversal.status}`);
  const dotfile = await get(`/phone/../../package.json`);
  ok([400, 403, 404].includes(dotfile.status), `dot-dot path refused: ${dotfile.status}`);

  // The gate that matters: data and money.
  const noKey = await get("/list");
  ok(noKey.status === 403, `/list without the key: ${noKey.status}`);
  const queueNoKey = await get("/queue");
  ok(queueNoKey.status === 403, `/queue without the key: ${queueNoKey.status}`);

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

  step("8. the queue view shows a human what is waiting, and nothing else");
  const id3 = desk.enqueue("GET https://api.example.com/feed", "1.25", "feed", "give me the feed");
  const q = await (await fetch(`${base}/queue?k=${encodeURIComponent(portalKey)}`)).json();
  const seen = q.find((r: any) => r.id === id3);
  ok(!!seen, "the parked payment appears in /queue");
  ok(seen.price === "1.25" && typeof seen.token === "string" && seen.token.length > 0,
    `it reads ${seen.price} ${seen.token}`);
  ok(seen.wants === "feed", "and it carries the buyer's request text, not the paid content");
  ok(!("content" in seen), "/queue never carries the paid content");
  ok(!("xdr" in seen) && !("challenge" in seen), "/queue never carries a challenge the app could sign blind");
  const keys = Object.keys(seen).sort().join(",");
  ok(!/secret|seed|principal|approver|portal/i.test(keys), `no key material in the row fields: ${keys}`);

  step("9. Reject works from the phone, not just from the desktop");
  // Opening the phone link builds the challenge, which puts the record in
  // awaiting_phone before the human has read anything. If deny refused that
  // state, the Reject button on the phone would be dead — verified broken on
  // live testnet before this was fixed.
  await fetch(`${base}/challenge/${id3}?k=${encodeURIComponent(portalKey)}`);
  const afterOpen = desk.get(id3)!.status;
  ok(afterOpen === "awaiting_phone", `opening the link moved it to ${afterOpen}`);
  const denied = await fetch(`${base}/deny/${id3}?k=${encodeURIComponent(portalKey)}`, { method: "POST" });
  const deniedBody = await denied.json();
  ok(deniedBody.status === "denied", `Reject from the phone: ${deniedBody.status}`);
  ok(desk.get(id3)!.status === "denied", "the record is denied");
  ok(await vault.balance(seller.publicKey()) === "2.7500000", "and no money moved");
  const challengeAfterDeny = await fetch(`${base}/challenge/${id3}?k=${encodeURIComponent(portalKey)}`);
  ok(challengeAfterDeny.status === 409, "a denied payment can no longer be signed: " + challengeAfterDeny.status);
  const denyAgain = await (await fetch(`${base}/deny/${id3}?k=${encodeURIComponent(portalKey)}`, { method: "POST" })).json();
  ok(denyAgain.status === "denied", "denying twice is harmless");

  step("10. the app can import a key and read back its own public half");
  // A non-extractable key cannot report its own public bytes, and addSignature
  // needs them. importSecretSeedPair captures them once at enrolment.
  const fresh = Keypair.random();
  const pair = await X.importSecretSeedPair(fresh.secret());
  ok(pair.address === fresh.publicKey(), "the app derives the right approver address");
  ok(Buffer.from(pair.pub).equals(Buffer.from(fresh.rawPublicKey())), "and the right public bytes");
  let pairExportable = false;
  try { await crypto.subtle.exportKey("pkcs8", pair.key); pairExportable = true; } catch { /* expected */ }
  ok(!pairExportable, "the key it keeps is still non-extractable");
  const sig2 = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.key, X.signaturePreimage(hash)));
  const signed2 = X.addSignature(rec.xdr, sig2, pair.pub);
  const env3 = X.parseEnvelope(signed2);
  ok(env3.signatures.length === 2, "the app can attach its signature to a pending payment");
  ok(X.hex(env3.signatures[1].hint) === X.hex(pair.pub.slice(28)), "with the right key hint");

  step("11. a hand-pasted transaction still needs the human to confirm the hash");
  const id4 = desk.enqueue("GET https://api.example.com/hand", "0.50", "hand", "p4");
  await desk.approve(id4);
  const hand = await (await fetch(`${base}/challenge/${id4}?k=${encodeURIComponent(portalKey)}`)).json();
  const handHash = await X.transactionHash(hand.xdr, X.NETWORK_ID.testnet);
  ok(handHash.hash === hand.hash, "the app re-hashes a hand-sent transaction to the same value");
  const wrong = X.addSignature(hand.xdr, sig2, pair.pub);
  const wrongOut = await (await fetch(`${base}/signed/${id4}?k=${encodeURIComponent(portalKey)}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: wrong }),
  })).json();
  ok(wrongOut.status === "failed", `a signature from the wrong approver: ${wrongOut.status}`);
  ok(await vault.balance(seller.publicKey()) === "2.7500000", "and nothing moved");

  await desk.close();
  console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
  process.exit(fail ? 1 : 0);
};

main().catch(async (e) => { console.error("crashed:", e); process.exit(1); });
