// The approver app's own logic. Loaded by phone-app/index.html and served by the
// desk at /phone/app.js. Kept in a separate file so the Content-Security-Policy
// (script-src 'self') is real rather than defeated by an inline <script>.
(function () {
  "use strict";
  const X = window.PaydluxXdr;
  const $ = (id) => document.getElementById(id);
  const DB = "paydlux-approver", STORE = "keys";

  let signingKey = null;

  function idb(mode, fn) {
    return new Promise((res, rej) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => rej(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error);
      };
    });
  }
  const saveKey = (k) => idb("readwrite", (s) => s.put(k, "approver"));
  const loadKey = () => idb("readonly", (s) => s.get("approver"));
  const dropKey = () => idb("readwrite", (s) => s.delete("approver"));

  function base64urlToBytes(s) {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async function showReady(pub) {
    $("who").textContent = X.encodeAccountEd25519(pub);
    $("enrol").classList.add("hidden");
    $("ready").classList.remove("hidden");
  }

  // ------------------------------------------------------------- enrolment
  $("enrolBtn").addEventListener("click", async () => {
    $("enrolErr").textContent = "";
    const seed = $("seed").value.trim();
    try {
      // Imported twice on purpose: once extractable purely to read the PUBLIC
      // half back for display, once non-extractable as the key we keep.
      const seedBytes = X.decodeSecretSeed(seed);
      const pkcs8 = new Uint8Array(16 + 32);
      pkcs8.set([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20], 0);
      pkcs8.set(seedBytes, 16);

      // "verify" is not a legal usage for a private Ed25519 key — the browser
      // refuses the import outright. Sign only.
      const tmp = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
      const jwk = await crypto.subtle.exportKey("jwk", tmp);
      const pub = base64urlToBytes(jwk.x);

      signingKey = await X.importSecretSeed(seed);      // non-extractable
      seedBytes.fill(0); pkcs8.fill(0); $("seed").value = "";

      // What is persisted is the non-extractable CryptoKey object, not the seed.
      // Whatever backs IndexedDB can use that key to sign; no code path can read
      // the seed out of it. Losing the database leaks nothing; stealing it leaks
      // nothing either.
      await saveKey({ key: signingKey, x: jwk.x });
      await showReady(pub);
    } catch (e) {
      $("enrolErr").textContent = e.message;
    }
  });

  $("forget").addEventListener("click", async () => {
    signingKey = null;
    await dropKey();
    location.reload();
  });

  // --------------------------------------------------------------- review
  let pending = null;

  /**
   * Deep link from the desk: /phone/?id=pay_0001&k=PORTALKEY
   * The human taps a link instead of pasting 400 characters of base64 on a
   * phone. The desk returns its own record of the challenge, so the amount the
   * phone displays is the amount the desk recorded.
   */
  async function loadFromDesk() {
    const q = new URLSearchParams(location.search);
    const id = q.get("id"), k = q.get("k");
    if (!id) return;
    try {
      const res = await fetch("/challenge/" + encodeURIComponent(id) +
        (k ? "?k=" + encodeURIComponent(k) : ""), { cache: "no-store" });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
      const rec = await res.json();
      $("xdr").value = rec.xdr;
      pending = { fromDesk: true, id, k };
      await renderChallenge(rec.xdr);
      $("readErr").textContent = "";
    } catch (e) {
      $("readErr").textContent = "could not load " + id + ": " + e.message;
    }
  }

  async function renderChallenge(xdrText) {
    const env = X.parseEnvelope(xdrText);
    const op = env.tx.ops[0];
    const testnet = await X.transactionHash(xdrText, X.NETWORK_ID.testnet);
    const publicNet = await X.transactionHash(xdrText, X.NETWORK_ID.public);
    pending = Object.assign({}, pending, {
      xdrText, env, hashes: { testnet: testnet.hash, public: publicNet.hash },
    });

    $("amount").textContent = X.formatAmount(op.amount) + " " + op.asset.code;
    $("token").textContent = op.asset.issuer
      ? op.asset.code + " issued by " + op.asset.issuer
      : "XLM (native)";
    $("payee").textContent = X.encodeAccountEd25519(op.destination.pub);
    $("vault").textContent = X.encodeAccountEd25519(env.tx.source.pub);
    $("memo").textContent = env.tx.memo || "(none)";
    const max = env.tx.bounds && env.tx.bounds.maxTime;
    $("deadline").textContent = max && max !== "0"
      ? new Date(Number(max) * 1000).toLocaleString() + " (" + remaining(Number(max)) + ")"
      : "none — this transaction never expires";

    // Which network an envelope belongs to is NOT inside the envelope, so the
    // human picks it. Signing for the wrong network yields a signature the
    // ledger refuses; it cannot silently move funds somewhere else.
    $("hash").innerHTML =
      '<label class="tag ok"><input type="radio" name="net" value="testnet" checked> testnet</label> '
      + testnet.hash +
      '<br><label class="tag warn"><input type="radio" name="net" value="public"> mainnet</label> '
      + publicNet.hash;
    $("review").classList.remove("hidden");
  }

  function remaining(unix) {
    const s = unix - Math.floor(Date.now() / 1000);
    if (s <= 0) return "EXPIRED";
    if (s < 120) return s + "s left";
    return Math.round(s / 60) + " min left";
  }

  $("read").addEventListener("click", async () => {
    $("readErr").textContent = "";
    $("review").classList.add("hidden");
    const xdrText = $("xdr").value.trim().replace(/\s+/g, "");
    try {
      await renderChallenge(xdrText);
    } catch (e) {
      $("readErr").textContent = e.message;
    }
  });

  $("reject").addEventListener("click", () => reset());
  $("again").addEventListener("click", () => reset());
  function reset() {
    pending = null;
    $("result").classList.add("hidden");
    $("review").classList.add("hidden");
    $("xdr").value = "";
  }

  // ---------------------------------------------------------------- sign
  $("approve").addEventListener("click", async () => {
    $("signErr").textContent = "";
    if (!signingKey) {
      $("signErr").textContent = "Import the approver key first.";
      return;
    }
    if (!pending) return;

    const picked = document.querySelector("input[name=net]:checked");
    const which = picked ? picked.value : "testnet";
    const network = which === "testnet" ? X.NETWORK_ID.testnet : X.NETWORK_ID.public;

    // A pasted transaction has no trusted source, so the human proves they were
    // shown this exact one by typing its hash back. A transaction fetched from
    // the desk over the portal key is already bound to the desk's own record,
    // which the desk re-checks before submitting.
    if (!pending.fromDesk) {
      const quoted = prompt("Type the first 16 characters of the hash the seller quoted you:");
      if (!quoted) return;
      const q = quoted.trim().toLowerCase();
      if (q !== pending.hashes.testnet.slice(0, 16) && q !== pending.hashes.public.slice(0, 16)) {
        $("signErr").textContent = "That hash matches neither. Nothing was signed.";
        return;
      }
    }

    try {
      const { hash } = await X.transactionHash(pending.xdrText, network);
      // The signature covers the 32 raw hash bytes. sha256-ing the hex text
      // instead yields a well-formed envelope the ledger refuses with BAD_AUTH.
      const sig = new Uint8Array(await crypto.subtle.sign(
        "Ed25519", signingKey, X.signaturePreimage(hash)));
      const rec = await loadKey();
      const signed = X.addSignature(pending.xdrText, sig, base64urlToBytes(rec.x));

      if (pending.fromDesk) {
        const res = await fetch("/signed/" + encodeURIComponent(pending.id) +
          (pending.k ? "?k=" + encodeURIComponent(pending.k) : ""), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ signedXdr: signed }),
        });
        const out = await res.json().catch(() => ({}));
        if (out.status === "settled") {
          // Show the ledger hash and keep the panel up: this is the only proof
          // the human gets that the payment actually landed. reset() would hide
          // it again, so clear the form by hand instead.
          pending = null;
          $("xdr").value = "";
          $("review").classList.add("hidden");
          $("signed").textContent = "settled on ledger\n" + (out.tx || "");
          $("result").classList.remove("hidden");
          return;
        }
        $("signErr").textContent = "the desk refused it: " +
          (out.reason || out.error || out.status || res.status);
        return;
      }
      $("signed").textContent = signed;
      $("result").classList.remove("hidden");
    } catch (e) {
      $("signErr").textContent = e.message;
    }
  });

  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("signed").textContent);
      $("copy").textContent = "Copied";
    } catch (e) {
      $("copy").textContent = "Select the text above and copy it manually";
    }
  });

  // On reload, pull the non-extractable CryptoKey back out of IndexedDB. It can
  // sign; it cannot be exported. The seed itself is never stored anywhere.
  (async () => {
    try {
      const rec = await loadKey();
      if (rec && rec.key instanceof CryptoKey) {
        signingKey = rec.key;
        await showReady(base64urlToBytes(rec.x));
      }
    } catch (e) { /* enrolment UI stays up */ }
    await loadFromDesk();
  })();
})();
