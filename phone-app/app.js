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
const show = (id, on = true) => $(id).classList.toggle("hidden", !on);
const set = (id, v) => { $(id).textContent = v == null || v === "" ? "\u2014" : String(v); };
const err = (id, msg) => { $(id).textContent = msg || ""; };

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
let approverKey = null;      // the non-extractable CryptoKey
let approverPublic = null;   // its G... address, for display
let approverPubBytes = null; // its 32 raw bytes, for addSignature

async function loadKey() {
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
  show("enrol", !approverKey);
  show("ready", !!approverKey);
  if (approverKey) set("who", approverPublic || "imported on this device");
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

/** A queue row. Built from DOM nodes so agent text can never be markup. */
function row(rec) {
  const wrap = document.createElement("div");
  wrap.className = "item" + (rec.status === "settled" || rec.status === "denied" ? " hist" : "");

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

  const actionable = rec.status === "pending" || rec.status === "awaiting_phone";
  if (actionable) {
    const btns = document.createElement("div");
    btns.className = "btns";
    const yes = document.createElement("button");
    yes.textContent = "Review";
    yes.addEventListener("click", () => openReview(rec.id));
    const no = document.createElement("button");
    no.className = "danger";
    no.textContent = "Reject";
    no.addEventListener("click", () => reject(rec.id));
    btns.append(yes, no);
    foot.append(btns);
  }

  wrap.append(top, uri, wants, foot);
  return wrap;
}

let queueTimer = null;
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
    err("qerr", "");
  } catch (e) {
    err("qerr", e.message + " — if this is new, open the seller's approval link again");
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
    if (env.tx.ops.length !== 1 || op.type !== X.OP_PAYMENT) {
      throw new Error("this transaction is not a single payment \u2014 refusing to sign it");
    }
    const { hash } = await X.transactionHash(rec.xdr, X.NETWORK_ID[rec.network] || rec.network);
    if (rec.hash && hash !== rec.hash) {
      throw new Error("the transaction does not hash to what the desk advertised \u2014 refusing");
    }
    current = {
      id, xdr: rec.xdr, hash,
      amount: X.formatAmount(op.amount),
      token: op.asset.code || "XLM",
      issuer: op.asset.issuer || "",
      payee: X.encodeAccountEd25519(op.destination.pub),
      vault: X.encodeAccountEd25519(env.tx.source.pub),
      memo: op.source ? "(payment from a secondary key)" : (rec.memo || ""),
      deadline: rec.expiresAt || env.tx.cond?.timeBounds?.max || "",
      network: rec.network,
      wants: rec.wants || "",
    };
    set("amount", `${current.amount} ${current.token}`);
    set("token", current.issuer ? `${current.token} (${current.issuer.slice(0, 12)}\u2026)` : current.token);
    set("payee", current.payee);
    set("vault", current.vault);
    set("wants", current.wants);
    set("memo", current.memo);
    set("deadline", current.deadline ? new Date(Number(current.deadline) * 1000).toLocaleString() : "none");
    set("network", current.network === "public" ? "Stellar mainnet" : current.network);
    set("hash", current.hash);
    err("signErr", "");
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

// ------------------------------------------------------------------ sign
async function signAndSubmit() {
  if (!current) return;
  if (!approverKey) { err("signErr", "no approver key on this device"); return; }
  const button = $("approve");
  button.disabled = true;
  try {
    // Re-hash at the moment of signing. What is signed is what was on screen.
    const { hash } = await X.transactionHash(current.xdr, X.NETWORK_ID[current.network] || current.network);
    if (hash !== current.hash) throw new Error("the transaction changed under you \u2014 nothing was signed");
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", approverKey, X.signaturePreimage(hash)));
    if (!approverPubBytes) throw new Error("this device lost the approver's public key — re-import it");
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
  } catch (e) {
    err("signErr", e.message);
  } finally {
    button.disabled = false;
  }
}

async function reject(id) {
  try {
    await api("/deny/" + encodeURIComponent(id), { method: "POST" });
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
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", approverKey, X.signaturePreimage(hash)));
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
  $("approve").addEventListener("click", signAndSubmit);
  $("reject").addEventListener("click", () => current && reject(current.id) && backToQueue());
  $("again").addEventListener("click", backToQueue);
  $("read").addEventListener("click", readPasted);
  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("signed").textContent); $("copy").textContent = "Copied"; }
    catch { $("copy").textContent = "Copy failed \u2014 select the text"; }
    setTimeout(() => { $("copy").textContent = "Copy"; }, 1500);
  });

  if (key()) {
    await refreshQueue();
    queueTimer = setInterval(refreshQueue, 4000);
    const id = new URLSearchParams(localStorage.getItem(LINK)?.split("?")[1] || "").get("id");
    if (id) openReview(id);
  }
}

boot().catch((e) => { err("qerr", e.message); });
