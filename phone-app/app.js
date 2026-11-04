// Paydlux approver — the client half.
//
// Two jobs, and only two: hold the approver key on this device, and sign the
// transaction hash for a payment a human has read.
//
// Rules this file is written to:
//   * The seed is imported into a NON-extractable WebCrypto key and then
//     dropped. What is persisted is the CryptoKey, not the seed. An injected
//     script can call sign(); it cannot read the seed.
//   * Signing is local. The bytes signed are the transaction hash the app
//     computed itself from the XDR it fetched — never a hash the server handed
//     over as an opaque "please sign this".
//   * Every string that came from a buyer's agent (request path, request body,
//     reason) is written with textContent. Never innerHTML. This page authorises
//     payments; one unescaped field there is remote code execution on the
//     approver's phone.
//   * One origin: the desk that served this app. No other fetch is made.
"use strict";

const X = globalThis.PaydluxXdr;
const $ = (id) => document.getElementById(id);
// Null-safe on purpose. `$(id).classList` on a missing id throws, and a throw
// here aborts the rest of the boot sequence — which is how one stale id in
// paintKeyState left the queue panel permanently hidden and the Approve buttons
// unreachable in the native app. A missing element is a cosmetic miss, not a
// reason to stop rendering the queue.
const show = (id, on = true) => { const el = $(id); if (el) el.classList.toggle("hidden", !on); };
const set = (id, v) => { const el = $(id); if (el) el.textContent = v == null || v === "" ? "\u2014" : String(v); };
const err = (id, msg) => { const el = $(id); if (el) el.textContent = msg || ""; };

// A short buzz on the two moments that matter. iOS ignores vibrate(); Android
// and desktop honour it. Guarded so it is never an uncaught error.
const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* no haptics */ } };

// ------------------------------------------------------------------ storage
// The approver key goes in IndexedDB, not localStorage. localStorage can only
// hold strings, which would force us to re-encode the key as something
// readable; IndexedDB stores the CryptoKey object itself, and a
// non-extractable key has no readable form to store.
const DB = "paydlux-approver";
const idb = () => new Promise((res, rej) => {
  const open = indexedDB.open(DB, 1);
  open.onupgradeneeded = () => open.result.createObjectStore("keys");
  open.onsuccess = () => res(open.result);
  open.onerror = () => rej(open.error);
});
async function idbPut(value) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("keys", "readwrite");
    t.objectStore("keys").put(value, "approver");
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}
async function idbGet() {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("keys", "readonly");
    const g = t.objectStore("keys").get("approver");
    g.onsuccess = () => res(g.result ?? null);
    g.onerror = () => rej(g.error);
  });
}
async function idbDel() {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction("keys", "readwrite");
    t.objectStore("keys").delete("approver");
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

// The approval link carries the seller's portal key. It is the thing that makes
// this app useful, so it is kept on the device after the seller opens it once.
const LINK = "paydlux.link";
const linkParams = () => {
  const raw = localStorage.getItem(LINK) || "";
  const u = new URL(raw, location.href);
  return u.searchParams;
};
const key = () => linkParams().get("k") || "";

// ------------------------------------------------------------------- api
// Same origin always: the desk that served this file.
async function api(path, opts = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(path + sep + "k=" + encodeURIComponent(key()), {
    ...opts,
    headers: { ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    throw new Error((body && (body.reason || body.error)) || `the desk answered ${res.status}`);
  }
  return body;
}

// ---------------------------------------------------------------- key state
let approverKey = null;      // the non-extractable CryptoKey (browser path)
let approverPublic = null;   // its G... address, for display
let approverPubBytes = null; // its 32 raw bytes, for addSignature

// The native app (ios/) exposes a Keychain key behind Face ID through a
// WKWebView script bridge. When it is present it wins: the key is in the
// iPhone's hardware-protected Keychain, marked ThisDeviceOnly, and every sign
// is gated by a biometric. The WebCrypto path below stays for the browser, and
// the two are never both used — a payment is signed by exactly one key.
//
// WebKit gives a page registered against WKScriptMessageHandlerWithReply a
// promise-returning postMessage, so the round trip is a plain await. No
// callback registry, no global to collide with.
const native = {
  available: () => !!(globalThis.webkit?.messageHandlers?.sign
                  && globalThis.webkit?.messageHandlers?.publicKey),
  publicKey: async () => {
    const out = await globalThis.webkit.messageHandlers.publicKey.postMessage({});
    return typeof out === "string" && out ? out : null;
  },
  sign: async (preimageHex) => {
    const out = await globalThis.webkit.messageHandlers.sign.postMessage({ preimage: preimageHex });
    if (out && out.signature) return out.signature;
    throw new Error((out && out.error) || "the native signer refused");
  },
};

async function loadKey() {
  if (native.available()) {
    // The native key needs no import: it is already on the device, behind Face
    // ID. The public half is read from the bridge so the review screen can show
    // which key will sign, and addSignature can attach the result.
    try {
      const hex = await native.publicKey();
      if (hex) {
        approverPubBytes = X.hexToBytes(hex);
        approverPublic = X.encodeAccountEd25519(approverPubBytes);
        return true;
      }
    } catch { /* fall through to the browser key */ }
  }
  try { approverKey = await idbGet(); } catch { approverKey = null; }
  if (!approverKey) return false;
  // A non-extractable key cannot be asked for its own public bytes, so they were
  // captured at enrolment and kept next to it. The address is for display; the
  // raw bytes are what addSignature needs to attach the signature.
  approverPublic = localStorage.getItem("paydlux.pub") || null;
  const raw = localStorage.getItem("paydlux.pubraw") || "";
  approverPubBytes = raw ? X.hexToBytes(raw) : null;
  return true;
}

// The one place a signature is produced. Both paths end here, so the audit
// question "what can sign?" has one answer: this function, over a hash this file
// computed, after the human held the button.
async function signPreimage(preimageHex) {
  // One return type for both paths: 64 raw bytes. The bridge answers in hex
  // because a script message cannot carry a byte array, and a half-converted
  // signature is the kind of bug that shows up as an invalid transaction rather
  // than an error.
  if (native.available()) {
    const hex = await native.sign(preimageHex);
    return X.hexToBytes(hex);
  }
  if (!approverKey) throw new Error("no approver key on this device");
  return new Uint8Array(
    await crypto.subtle.sign("Ed25519", approverKey, X.hexToBytes(preimageHex)));
}

async function enrol(seed) {
  const trimmed = seed.trim();
  // Import once as non-extractable (what we keep) and once as extractable
  // purely to read back the public half, which the temporary key is then
  // discarded for. The seed itself is never stored anywhere.
  const { key: kp, pub, address } = await X.importSecretSeedPair(trimmed);
  approverKey = kp;
  approverPublic = address;
  approverPubBytes = pub;
  await idbPut(kp);
  localStorage.setItem("paydlux.pub", address);
  localStorage.setItem("paydlux.pubraw", X.hex(pub));
  $("seed").value = "";
  return true;
}

// ------------------------------------------------------------------ render
function paintKeyState() {
  const have = !!approverKey || native.available();
  show("enrol", !have);
  show("ready", have);
  if (have) {
    set("who", approverPublic || "held by this app");
    // In the native app the seed lives in the Keychain and the page has no way
    // to write it, so the paste box would be a lie — and the remove button
    // worse: idbDel() below clears the browser key, which does not exist here,
    // so it would look like it worked while the real key stayed on the device.
    // Removal belongs to the app (its menu, and the enrol screen), not the page.
    if (native.available()) show("forget", false);
  }
}

function paintLinkState() {
  const have = !!key();
  show("nolink", !have);
  show("queue", have);
  if (!have) show("paste", false);   // no link, no queue: nothing to fall back to yet
  if (!have) $("link").value = "";
}

const ago = (iso) => {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return Math.round(s) + "s ago";
  if (s < 3600) return Math.round(s / 60) + "m ago";
  return Math.round(s / 3600) + "h ago";
};

const STATUS_TAG = {
  pending: ["warn", "waiting"],
  awaiting_phone: ["warn", "on your phone"],
  settled: ["ok", "paid"],
  denied: ["bad", "rejected"],
  failed: ["bad", "failed"],
  expired: ["bad", "expired"],
};

/** Minutes left on a live request, or null. */
function minutesLeft(rec) {
  if (!rec.expiresAt) return null;
  if (rec.status !== "pending" && rec.status !== "awaiting_phone") return null;
  return Math.round((Number(rec.expiresAt) * 1000 - Date.now()) / 60000);
}

/** A queue row. Built from DOM nodes so agent text can never be markup. */
function row(rec) {
  const wrap = document.createElement("div");
  const live = rec.status === "pending" || rec.status === "awaiting_phone";
  wrap.className = "item" + (live ? " live" : "") +
    (rec.status === "settled" || rec.status === "denied" ? " hist" : "");

  const top = document.createElement("div");
  top.className = "top";
  const amt = document.createElement("div");
  amt.className = "amt";
  amt.textContent = `${rec.price} ${rec.token || ""}`;
  const [, cls] = STATUS_TAG[rec.status] || ["warn", rec.status];
  const tag = document.createElement("span");
  tag.className = "tag " + cls;
  tag.textContent = (STATUS_TAG[rec.status] || [null, rec.status])[1] || rec.status;
  top.append(amt, tag);

  const uri = document.createElement("div");
  uri.className = "uri";
  uri.textContent = rec.uri || "";

  const wants = document.createElement("div");
  wants.className = "wants";
  wants.textContent = rec.wants || "";

  const foot = document.createElement("div");
  foot.className = "foot";
  const when = document.createElement("span");
  when.className = "ago";
  when.textContent = ago(rec.at) + (rec.tx ? " \u00b7 " + rec.tx.slice(0, 12) + "\u2026" : "");
  foot.append(when);

  // The other way a payment dies is the clock. Show the time left on the row,
  // so "I approved it and nothing happened" is not the first warning.
  const left = minutesLeft(rec);
  if (left !== null) {
    const clock = document.createElement("span");
    clock.className = "clock" + (left <= 5 ? " low" : "");
    clock.textContent = left > 0 ? left + " min left" : "expired";
    foot.append(clock);
  }

  // A failed row with no reason is a dead end: the human cannot tell a passed
  // deadline from a wrong key, and both look like "it says failed".
  if (rec.status === "failed" && rec.reason) {
    const why = document.createElement("div");
    why.className = "wants";
    why.textContent = rec.reason;
    wrap.append(top, uri, wants, why, foot);
    return wrap;
  }

  if (live) {
    const btns = document.createElement("div");
    btns.className = "btns";
    const yes = document.createElement("button");
    yes.textContent = "Review & approve";
    yes.addEventListener("click", () => openReview(rec.id));
    const no = document.createElement("button");
    no.className = "danger";
    no.textContent = "Reject";
    no.addEventListener("click", () => reject(rec.id));
    btns.append(yes, no);
    foot.append(btns);
    // Say what the next screen asks for. Approving is a deliberate hold, not a
    // tap, and a person who expects a button on this row concludes the page is
    // broken and gives up before ever seeing the hold control.
    const how = document.createElement("div");
    how.className = "howto";
    how.textContent = `Approving takes a ${holdSeconds()}-second hold on the next screen. Reject is one tap.`;
    wrap.append(how);
  }

  wrap.append(top, uri, wants, foot);
  return wrap;
}

// The home-screen icon badge: the count of what is waiting. On an installed PWA
// this is the only way a person learns money is waiting without opening the app.
async function badge(n) {
  try {
    if (n > 0 && navigator.setAppBadge) await navigator.setAppBadge(n);
    else if (navigator.clearAppBadge) await navigator.clearAppBadge();
  } catch { /* badging is not granted, or not supported */ }
}

let queueTimer = null;
let lastLive = 0;
async function refreshQueue() {
  if (!key()) return;
  try {
    const list = await api("/queue");
    const live = list.filter((r) => r.status === "pending" || r.status === "awaiting_phone");
    const past = list.filter((r) => r.status !== "pending" && r.status !== "awaiting_phone").slice(0, 5);
    const box = $("qlist");
    box.replaceChildren();
    if (!live.length && !past.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "nothing waiting";
      box.append(e);
    }
    live.forEach((r) => box.append(row(r)));
    past.forEach((r) => box.append(row(r)));
    // The hand-paste box is the fallback for a seller who sends a transaction by
    // message instead of a link. It appears when there is nothing in the queue,
    // so a fresh device never meets "paste the transaction" before its payments.
    show("paste", !live.length);
    set("qwhen", new Date().toLocaleTimeString());
    set("qtitle", live.length ? `${live.length} waiting for you` : "Waiting for you");
    err("qerr", "");
    show("offline", false);
    // buzz once when a new request arrives while the app is open
    if (live.length > lastLive) buzz(30);
    lastLive = live.length;
    badge(live.length);
    // Hand the count to the native shell: it owns the icon badge and the local
    // notification, which a web page cannot raise on iOS. It gets a number and
    // nothing else — no amount, no payee — because a lock-screen payment prompt
    // is a payment decision made on a screen nobody unlocked deliberately.
    try { globalThis.webkit?.messageHandlers?.queue?.postMessage({ waiting: live.length }); } catch { /* not native */ }
  } catch (e) {
    // Distinguish "the desk is down" from "this link was never issued": the
    // first is a network problem the seller fixes, the second is a key problem.
    err("qerr", e.message + " — if this is new, open the seller's approval link again");
    if (!navigator.onLine) show("offline", true);
  }
}

// ----------------------------------------------------------------- review
let current = null;   // { id, xdr, hash, summary }

async function openReview(id) {
  err("qerr", "");
  try {
    const rec = await api("/challenge/" + encodeURIComponent(id));
    const env = X.parseEnvelope(rec.xdr);
    const op = env.tx.ops[0];
    // Two shapes are signable: a single payment, and a single escrow claim
    // (the vault taking money a buyer locked in a claimable balance). Anything
    // else is refused, and the escrow branch verifies the claim targets the
    // balance id the desk says this approval is for.
    const isClaim = op.type === X.OP_CLAIM_CLAIMABLE_BALANCE;
    if (env.tx.ops.length !== 1 || (op.type !== X.OP_PAYMENT && !isClaim)) {
      throw new Error("this transaction is not a single payment or escrow claim \u2014 refusing to sign it");
    }
    if (isClaim && rec.escrowId && op.balanceId !== rec.escrowId) {
      throw new Error("the claim targets a different balance than this approval is for \u2014 refusing");
    }
    const { hash } = await X.transactionHash(rec.xdr, X.NETWORK_ID[rec.network] || rec.network);
    if (rec.hash && hash !== rec.hash) {
      throw new Error("the transaction does not hash to what the desk advertised \u2014 refusing");
    }
    // The vault only accepts the key it was built with. A seed from an earlier
    // run produces a perfectly valid signature over a perfectly valid
    // transaction, and the ledger's only reply is BAD_AUTH \u2014 which reads like a
    // bug and is really the wrong key. Say it before signing instead.
    if (rec.approver && approverPublic && rec.approver !== approverPublic) {
      throw new Error(
        "this vault expects a different approver key.\n" +
        "vault wants: " + rec.approver.slice(0, 12) + "\u2026\n" +
        "this device: " + approverPublic.slice(0, 12) + "\u2026\n" +
        "The seller re-ran the desk, which made a new key. Get the new seed.");
    }
    current = {
      id, xdr: rec.xdr, hash,
      // A claim op carries no amount: the money is whatever the ledger says the
      // balance holds. The desk read that number when it queued the release,
      // so the human sees it from the desk, and the balance id next to it is
      // what ties the number to the order.
      amount: isClaim ? String(rec.amount ?? "") : X.formatAmount(op.amount),
      token: isClaim ? String(rec.asset ?? "") : (op.asset.code || "XLM"),
      issuer: isClaim ? "" : (op.asset.issuer || ""),
      payee: isClaim ? op.balanceId : X.encodeAccountEd25519(op.destination.pub),
      vault: X.encodeAccountEd25519(env.tx.source.pub),
      // Read the memo out of the envelope, not out of the server's summary:
      // the envelope is what is being signed, so it is the only source that
      // cannot disagree with the bytes. xdr.js already renders every memo type
      // to a plain string, so this is display-safe by construction.
      memo: env.tx.memo || "(none)",
      deadline: rec.expiresAt || env.tx.cond?.timeBounds?.max || "",
      network: rec.network,
      wants: rec.wants || "",
    };
    // The amount is the one number a person must read. It gets the biggest type
    // on the screen and the token sits next to it, so "4.50" is never read
    // without its unit.
    $("amount").replaceChildren();
    const num = document.createElement("span");
    num.textContent = current.amount;
    const tk = document.createElement("span");
    tk.className = "tk";
    tk.textContent = " " + current.token;
    $("amount").append(num, tk);
    set("wantsBig", current.wants);
    set("token", current.issuer ? `${current.token} (${current.issuer.slice(0, 12)}\u2026)` : current.token);
    // An escrow claim has no payee: the money goes to the vault itself. What
    // the human verifies instead is the balance id — the ledger address of the
    // locked money — so the row is labelled for that.
    $("payeeLabel").textContent = isClaim ? "Escrow balance" : "Payee";
    set("payee", current.payee);
    set("vault", current.vault);
    set("wants", current.wants);
    set("memo", current.memo);
    set("deadline", current.deadline ? new Date(Number(current.deadline) * 1000).toLocaleString() : "none");
    set("network", current.network === "public" ? "Stellar mainnet" : current.network);
    set("hash", current.hash);
    // The network belongs in the header, not buried in the list: signing a
    // testnet transaction and signing real money look identical otherwise, and
    // the chip is the one place a person glances before holding the button.
    set("netChip", current.network === "public" ? "mainnet" : current.network);
    show("netChip", true);
    $("netChip").style.color = current.network === "public" ? "var(--ok)" : "var(--warn)";
    err("signErr", "");
    resetHold();
    // The hold button says what it does. Releasing an escrow is not paying
    // anyone: it is the vault taking money a buyer already locked. After
    // resetHold, which resets the label to the payment wording.
    if (isClaim) set("holdLbl", "Hold to release \u0026 sign");
    show("review", true);
    show("queue", false);
    $("review").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) {
    err("qerr", e.message);
  }
}

function backToQueue() {
  current = null;
  show("review", false);
  show("result", false);
  show("queue", !!key());
  refreshQueue();
}

// ------------------------------------------------------ hold-to-approve
// Approving money is the expensive action; rejecting is the safe one. So Reject
// is one tap and Approve needs a deliberate hold. This is what stops a pocket
// tap, a mis-tap, and the person who taps Approve and only then starts reading.
const HOLD_MS = 1200;
// The queue row quotes this number, so it is stated once and read from the
// constant. Copy that says "one second" over a 1.2s gesture teaches the wrong
// gesture and reads as broken the first time it does not fire.
const holdSeconds = () => (HOLD_MS / 1000).toFixed(1).replace(/\.0$/, "");
let holdStart = 0, holdTimer = null;

function resetHold() {
  $("holdFill").style.width = "0";
  $("holdLbl").textContent = "Hold to approve & sign";
  $("approve").classList.remove("armed");
}

function armHold() {
  holdStart = Date.now();
  $("holdLbl").textContent = "Keep holding\u2026";
  holdTimer = setInterval(() => {
    const p = Math.min(1, (Date.now() - holdStart) / HOLD_MS);
    $("holdFill").style.width = (p * 100) + "%";
    if (p >= 1) {
      clearInterval(holdTimer); holdTimer = null;
      $("approve").classList.add("armed");
      $("holdLbl").textContent = "Signed";
      buzz([20, 40, 20]);
      signAndSubmit();
    }
  }, 40);
}

function cancelHold() {
  if (holdTimer) { clearInterval(holdTimer); holdTimer = null; }
  if (!holdStart) return;
  holdStart = 0;
  if (!$("approve").classList.contains("armed")) resetHold();
}

function wireHold() {
  const b = $("approve");
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); if (!holdTimer) armHold(); });
  b.addEventListener("pointerup", cancelHold);
  b.addEventListener("pointercancel", cancelHold);
  b.addEventListener("pointerleave", cancelHold);
  // keyboard / VoiceOver: hold is a pointer gesture, so Enter needs a confirm
  b.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (!confirm("Approve and sign this payment?")) return;
      $("holdFill").style.width = "100%";
      signAndSubmit();
    }
  });
}

// ------------------------------------------------------------------ sign
async function signAndSubmit() {
  if (!current) return;
  if (!approverKey && !native.available()) { err("signErr", "no approver key on this device"); return; }
  const button = $("approve");
  button.disabled = true;
  try {
    // Re-hash at the moment of signing. What is signed is what was on screen.
    const { hash } = await X.transactionHash(current.xdr, X.NETWORK_ID[current.network] || current.network);
    if (hash !== current.hash) throw new Error("the transaction changed under you \u2014 nothing was signed");
    // One signer for both paths. The preimage is built here, from the hash this
    // file computed, so the native side is asked to sign exactly what was on
    // screen and is never handed a transaction to interpret.
    const pre = X.signaturePreimage(hash);
    if (!approverPubBytes) throw new Error("this device lost the approver's public key — re-import it");
    if (!globalThis.PaydluxVerify) throw new Error("this approver page is missing verify.js — nothing was signed");
    const sig = new Uint8Array(await signPreimage(X.hex(pre)));
    // Prove the signature came from the key this screen named, before a byte
    // of it leaves the device. A bridge that signs with some other key is then
    // useless: its output never reaches the ledger.
    if (!await globalThis.PaydluxVerify.verifySignature(sig, hash, approverPubBytes)) {
      throw new Error("the signature does not match this key — nothing was sent");
    }
    const signed = X.addSignature(current.xdr, sig, approverPubBytes);
    const out = await api("/signed/" + encodeURIComponent(current.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ signedXdr: signed }),
    });
    set("signed", signed);
    const tag = $("resultTag");
    tag.className = "tag " + (out.status === "settled" ? "ok" : "bad");
    tag.textContent = out.status === "settled" ? "Paid" : out.status;
    if (out.tx) set("resultLabel", `Signed \u00b7 ledger tx ${out.tx}`);
    if (out.reason) set("resultLabel", out.reason);
    show("result", true);
    show("review", false);
    buzz(out.status === "settled" ? [20, 40, 20] : 200);
    badge(0);
  } catch (e) {
    err("signErr", e.message);
    resetHold();
    buzz(200);
  } finally {
    button.disabled = false;
  }
}

async function reject(id) {
  try {
    await api("/deny/" + encodeURIComponent(id), { method: "POST" });
    buzz(60);
    refreshQueue();
  } catch (e) {
    err("qerr", e.message);
  }
}

// ------------------------------------------------------- hand-pasted xdr
// For a seller who sends the pending transaction by hand. There is no trusted
// source for it, so the app makes the human type back the hash the seller
// quoted: signing then proves the human saw the same bytes, not a swapped one.
async function readPasted() {
  err("readErr", "");
  try {
    if (!approverKey || !approverPubBytes) throw new Error("import the approver key first");
    const xdr = $("xdr").value.trim();
    if (!xdr) throw new Error("paste the transaction first");
    const env = X.parseEnvelope(xdr);
    if (env.tx.ops.length !== 1 || env.tx.ops[0].type !== X.OP_PAYMENT) {
      throw new Error("not a single payment \u2014 refusing");
    }
    const op = env.tx.ops[0];
    const local = location.hostname === "localhost" || /^127\./.test(location.hostname);
    const net = local ? "testnet" : "public";
    const { hash } = await X.transactionHash(xdr, X.NETWORK_ID[net]);
    // No trusted source, so the human proves they saw these exact bytes by
    // typing back the hash the seller quoted. A swapped transaction hashes
    // differently and this check fails.
    const want = prompt(
      `Network: ${net}\n` +
      `This pays ${X.formatAmount(op.amount)} ${op.asset.code || "XLM"} to ` +
      `${X.encodeAccountEd25519(op.destination.pub)}.\n\n` +
      `Type the first 12 characters of the hash the seller quoted to confirm you are ` +
      `signing the same transaction.`);
    if (!want) return;
    if (want.trim().toLowerCase() !== hash.slice(0, 12)) {
      throw new Error("that is not the hash the seller quoted \u2014 nothing was signed");
    }
    const sig = new Uint8Array(await signPreimage(X.hex(X.signaturePreimage(hash))));
    if (!globalThis.PaydluxVerify) throw new Error("this approver page is missing verify.js \u2014 nothing was signed");
    if (!await globalThis.PaydluxVerify.verifySignature(sig, hash, approverPubBytes)) {
      throw new Error("the signature does not match this key — nothing was produced");
    }
    set("signed", X.addSignature(xdr, sig, approverPubBytes));
    set("resultLabel", "Signed \u2014 send this back to the seller");
    $("resultTag").className = "tag ok";
    $("resultTag").textContent = "Signed";
    show("result", true);
  } catch (e) {
    err("readErr", e.message);
  }
}

// ------------------------------------------------------------------ boot
async function boot() {
  // A deep link from the seller's desk saves the approval link automatically.
  const here = new URL(location.href);
  if (here.searchParams.get("k")) {
    const u = new URL(location.pathname, location.origin);
    const p = new URLSearchParams();
    for (const [k2, v] of here.searchParams) p.set(k2, v);
    localStorage.setItem(LINK, u.pathname + "?" + p.toString());
  }

  await loadKey();
  paintKeyState();
  paintLinkState();

  // iOS gives an installed PWA no browser chrome, and Safari offers no install
  // button, so the instruction has to live inside the app. Shown once per device.
  const standalone = matchMedia("(display-mode: standalone)").matches
    || navigator.standalone === true;
  show("install", !standalone && !localStorage.getItem("paydlux.installDismissed"));
  $("install").addEventListener("click", () => {
    localStorage.setItem("paydlux.installDismissed", "1");
    show("install", false);
  });

  // The offline shell: the app launches from cache with its icon and code even
  // with no network, then fails honestly when it tries to read the queue. It
  // never caches payment data — see sw.js.
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js", { scope: "./" }).catch(() => { /* not fatal */ });
  }

  $("enrolBtn").addEventListener("click", async () => {
    err("enrolErr", "");
    try {
      await enrol($("seed").value);
      paintKeyState();
      refreshQueue();
    } catch (e) {
      err("enrolErr", e.message);
    }
  });
  $("seed").addEventListener("keydown", (e) => { if (e.key === "Enter") $("enrolBtn").click(); });
  $("forget").addEventListener("click", async () => {
    await idbDel();
    localStorage.removeItem("paydlux.pub");
    approverKey = null; approverPublic = null;
    paintKeyState();
  });
  $("linkBtn").addEventListener("click", () => {
    const raw = $("link").value.trim();
    if (!raw) return;
    const u = new URL(raw, location.origin);
    if (!u.searchParams.get("k")) { err("linkErr", "that link has no approval key in it"); return; }
    localStorage.setItem(LINK, u.pathname + "?" + u.searchParams.toString());
    err("linkErr", "");
    paintLinkState();
    refreshQueue();
  });
  wireHold();
  $("reject").addEventListener("click", () => current && reject(current.id) && backToQueue());
  $("again").addEventListener("click", backToQueue);
  $("read").addEventListener("click", readPasted);
  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("signed").textContent); $("copy").textContent = "Copied"; }
    catch { $("copy").textContent = "Copy failed \u2014 select the text"; }
    setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
  });

  // Poll only while visible. An approver app left open on a phone should not
  // wake the radio every few seconds in a pocket.
  const startPolling = () => {
    if (queueTimer) return;
    queueTimer = setInterval(refreshQueue, 4000);
    refreshQueue();
  };
  const stopPolling = () => { if (queueTimer) { clearInterval(queueTimer); queueTimer = null; } };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPolling(); else if (key()) startPolling();
  });
  window.addEventListener("online", () => { show("offline", false); refreshQueue(); });
  window.addEventListener("offline", () => show("offline", true));

  if (key()) {
    await refreshQueue();
    if (!document.hidden) startPolling();
    const id = new URLSearchParams(localStorage.getItem(LINK)?.split("?")[1] || "").get("id");
    if (id) openReview(id);
  }
}

boot().catch((e) => { err("qerr", e.message); });
