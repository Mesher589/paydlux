// Minimal Stellar transaction codec for the phone. No dependencies, no network.
//
// The phone must be able to (a) read a payment so a human can see what they are
// approving, (b) recompute the transaction hash so it can prove the bytes it was
// given are the bytes it was shown, and (c) append its signature.
//
// It deliberately understands only the payment envelope shape. Anything it does
// not recognise is an error, not a guess — refusing to sign is always safe.
//
// Field order below is taken from the Stellar XDR schema (Transaction,
// Operation, PaymentOp, Preconditions, Memo, Asset, TransactionExt,
// DecoratedSignature). phone-app/xdr-check.ts asserts this decoder agrees with
// the official SDK on a real vault payment.
//
// This file runs unchanged in the browser and in Node (tests).
(function (root) {
  "use strict";

  // ------------------------------------------------------------------ reader
  function Reader(bytes) {
    this.b = bytes; this.i = 0;
  }
  Reader.prototype.u32 = function () {
    if (this.i + 4 > this.b.length) throw new Error("xdr: truncated reading uint32");
    const v = (this.b[this.i] << 24 | this.b[this.i + 1] << 16 | this.b[this.i + 2] << 8 | this.b[this.i + 3]) >>> 0;
    this.i += 4; return v;
  };
  // Sequence numbers and amounts are int64 and routinely exceed
  // Number.MAX_SAFE_INTEGER, so 64-bit values stay BigInt until displayed.
  Reader.prototype.u64 = function () {
    const hi = BigInt(this.u32()), lo = BigInt(this.u32());
    return (hi << 32n) | lo;
  };
  Reader.prototype.i64 = function () {
    const v = this.u64();
    return v >= (1n << 63n) ? v - (1n << 64n) : v;
  };
  Reader.prototype.fixed = function (n) {
    if (this.i + n > this.b.length) throw new Error("xdr: truncated fixed bytes");
    const out = this.b.slice(this.i, this.i + n);
    this.i += n;
    const pad = (4 - (n % 4)) % 4;
    for (let p = 0; p < pad; p++) {
      if (this.b[this.i + p] !== 0) throw new Error("xdr: bad padding");
    }
    this.i += pad;
    return out;
  };
  Reader.prototype.varOpaque = function (max) {
    const n = this.u32();
    if (n > max) throw new Error(`xdr: opaque length ${n} exceeds the ${max}-byte limit`);
    return this.fixed(n);
  };

  // ------------------------------------------------------------------ writer
  function Writer() { this.b = []; }
  Writer.prototype.u32 = function (v) {
    this.b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  };
  Writer.prototype.u64 = function (v) {
    const b = BigInt(v);
    this.u32(Number((b >> 32n) & 0xffffffffn)); this.u32(Number(b & 0xffffffffn));
  };
  Writer.prototype.fixed = function (bytes) {
    for (const x of bytes) this.b.push(x);
    const pad = (4 - (bytes.length % 4)) % 4;
    for (let p = 0; p < pad; p++) this.b.push(0);
  };
  Writer.prototype.varOpaque = function (bytes) { this.u32(bytes.length); this.fixed(bytes); };
  Writer.prototype.bytes = function () { return Uint8Array.from(this.b); };

  // ------------------------------------------------------------------ constants
  const ENVELOPE_TYPE_TX = 2;          // TransactionEnvelope holding a v1 tx
  const KEY_TYPE_ED25519 = 0;
  const KEY_TYPE_MUXED_ED25519 = 256;
  const SC_ADDRESS = 4;                // soroban account: we refuse it
  const ASSET_NATIVE = 0, ASSET_ALPHANUM4 = 1, ASSET_ALPHANUM12 = 2;
  const OP_PAYMENT = 1;
  const PRECOND_NONE = 0, PRECOND_TIME = 1, PRECOND_V2 = 2;
  const MEMO_NONE = 0, MEMO_TEXT = 1, MEMO_ID = 2, MEMO_HASH = 3, MEMO_RETURN = 4;
  const STROOPS = 10000000;

  // ------------------------------------------------------------------ strkey
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

  /** Stellar account id (G...) from a 32-byte ed25519 public key. */
  function encodeAccountEd25519(pub) {
    if (pub.length !== 32) throw new Error("public key must be 32 bytes");
    return encodeStrKey(6 << 3, pub);
  }

  /** 32-byte public key from a Stellar account id. */
  function decodeAccountEd25519(str) {
    if (typeof str !== "string" || str[0] !== "G") {
      throw new Error("not a Stellar account id (expected G...)");
    }
    return decodeStrKey(str, 6 << 3, 32);
  }

  /**
   * Stellar secret seed (S...) -> 32-byte seed. Same base32 envelope as an
   * account id, different version byte.
   */
  function decodeSecretSeed(str) {
    if (typeof str !== "string" || str[0] !== "S") {
      throw new Error("not a Stellar secret seed (expected S...)");
    }
    return decodeStrKey(str, 18 << 3, 32);
  }

  /** Stellar secret seed (S...) from a 32-byte seed. */
  function encodeSecretSeed(seed) {
    if (seed.length !== 32) throw new Error("seed must be 32 bytes");
    return encodeStrKey(18 << 3, seed);
  }

  function encodeStrKey(version, body) {
    const bytes = [version, ...body, 0, 0];
    const crc = crc16Xmodem(bytes.slice(0, 1 + body.length));
    bytes[bytes.length - 2] = crc & 255;
    bytes[bytes.length - 1] = (crc >> 8) & 255;
    const bits = [];
    for (const byte of bytes) for (let k = 7; k >= 0; k--) bits.push((byte >> k) & 1);
    let out = "";
    for (let k = 0; k + 5 <= bits.length; k += 5) {
      out += B32[bits[k] * 16 + bits[k + 1] * 8 + bits[k + 2] * 4 + bits[k + 3] * 2 + bits[k + 4]];
    }
    return out;
  }

  function decodeStrKey(str, version, bodyLen) {
    if (str.length !== 56) throw new Error("strkey must be 56 characters");
    const bits = [];
    for (const ch of str) {
      const v = B32.indexOf(ch);
      if (v < 0) throw new Error("not a valid strkey: bad character " + ch);
      for (let k = 4; k >= 0; k--) bits.push((v >> k) & 1);
    }
    const bytes = [];
    for (let k = 0; k + 8 <= bits.length; k += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[k + j];
      bytes.push(byte);
    }
    if (bytes[0] !== version) throw new Error("wrong strkey version byte");
    const body = Uint8Array.from(bytes.slice(1, 1 + bodyLen));
    const checksum = (bytes[1 + bodyLen] | (bytes[2 + bodyLen] << 8)) >>> 0;
    if (checksum !== crc16Xmodem(bytes.slice(0, 1 + bodyLen))) {
      throw new Error("strkey checksum does not match — the key was mistyped");
    }
    return body;
  }

  /** CRC16-XMODEM, the checksum Stellar strkeys use. */
  function crc16Xmodem(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
      }
    }
    return crc & 0xffff;
  }

  /**
   * Turn a Stellar secret seed into a WebCrypto signing key.
   *
   * The result is NON-extractable: the app can sign with it, but nothing — not
   * the page's own JavaScript, not an injected script — can read the seed back
   * out of it. That is the point of the phone holding the approval half.
   * The public half is captured at enrolment and stored separately.
   */
  async function importSecretSeed(seedStr) {
    const seed = decodeSecretSeed(seedStr);
    const pkcs8 = new Uint8Array(16 + 32);
    pkcs8.set([
      0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
      0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    ], 0);
    pkcs8.set(seed, 16);
    const privateKey = await crypto.subtle.importKey(
      "pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
    seed.fill(0);                       // drop the plaintext copy as soon as we can
    return privateKey;
  }

  // ------------------------------------------------------------------ parsing
  function readMuxedAccount(r) {
    const type = r.u32();
    if (type === KEY_TYPE_ED25519) return { kind: "ed25519", pub: r.fixed(32) };
    if (type === KEY_TYPE_MUXED_ED25519) {
      const id = r.u64();
      const pub = r.fixed(32);
      return { kind: "muxed", id: id.toString(), pub };
    }
    if (type === SC_ADDRESS) throw new Error("a smart-contract address cannot approve a payment");
    throw new Error("unknown account key type " + type);
  }

  function readAsset(r) {
    const type = r.u32();
    if (type === ASSET_NATIVE) return { code: "XLM", issuer: null };
    if (type === ASSET_ALPHANUM4 || type === ASSET_ALPHANUM12) {
      const code = asciiTrim(r.fixed(type === ASSET_ALPHANUM4 ? 4 : 12));
      return { code, issuer: encodeAccountEd25519(readPublicKey(r)) };
    }
    throw new Error("asset type " + type + " is not supported; refusing to sign");
  }

  /**
   * Asset issuers use public_key, which is a union: a 4-byte key-type word
   * before the 32 bytes. Missing that word shifts every later field by four
   * bytes and silently misreads the amount, so it is read explicitly.
   */
  function readPublicKey(r) {
    const type = r.u32();
    if (type !== KEY_TYPE_ED25519) {
      throw new Error("issuer key type " + type + " is not supported; refusing to sign");
    }
    return r.fixed(32);
  }

  function asciiTrim(bytes) {
    let s = "";
    for (const b of bytes) { if (b === 0) break; s += String.fromCharCode(b); }
    if (!/^[A-Za-z0-9]{1,12}$/.test(s)) {
      throw new Error("asset code is not alphanumeric: " + JSON.stringify(s));
    }
    return s;
  }

  function readMemo(r) {
    const type = r.u32();
    if (type === MEMO_NONE) return null;
    if (type === MEMO_TEXT) {
      const s = r.varOpaque(28);
      let text = "";
      for (const b of s) {
        if (b < 0x20 || b > 0x7e) throw new Error("memo text is not printable");
        text += String.fromCharCode(b);
      }
      return text;
    }
    if (type === MEMO_ID) return "id:" + r.u64().toString();
    if (type === MEMO_HASH) return "hash:" + hex(r.fixed(32));
    if (type === MEMO_RETURN) return "return:" + hex(r.fixed(32));
    throw new Error("unknown memo type " + type);
  }

  function readPreconditions(r) {
    const type = r.u32();
    if (type === PRECOND_NONE) return null;
    if (type === PRECOND_TIME) {
      const minTime = r.u64().toString(), maxTime = r.u64().toString();
      return { minTime, maxTime };
    }
    if (type === PRECOND_V2) {
      // timeBounds? ledgerBounds? minSeqNum? minSeqAge minSeqLedgerGap extraSigners[2]
      const hasTime = r.u32();
      const bounds = hasTime
        ? { minTime: r.u64().toString(), maxTime: r.u64().toString() }
        : null;
      const hasLedger = r.u32();
      if (hasLedger) throw new Error("ledger bounds are not supported; refusing to sign");
      const hasSeq = r.u32();
      if (hasSeq) throw new Error("sequence preconditions are not supported; refusing to sign");
      r.u64();                                  // minSeqAge
      r.u32();                                  // minSeqLedgerGap
      const n = r.u32();
      if (n !== 0) throw new Error("extra signers are not supported; refusing to sign");
      return bounds;
    }
    throw new Error("unknown precondition type " + type);
  }

  function readOperation(r) {
    const hasSource = r.u32();
    const source = hasSource ? readMuxedAccount(r) : null;
    const type = r.u32();                          // OperationBody union switch
    if (type !== OP_PAYMENT) {
      throw new Error("operation type " + type + " is not a payment; this app only signs payments");
    }
    const destination = readMuxedAccount(r);
    const asset = readAsset(r);
    const amount = r.i64();
    if (amount < 0n) throw new Error("payment amount is negative; refusing to sign");
    return { type, source, destination, asset, amount: amount.toString() };
  }

  function readTransaction(r) {
    const source = readMuxedAccount(r);
    const fee = r.u32();
    const seq = r.u64();
    const bounds = readPreconditions(r);
    const memo = readMemo(r);
    const numOps = r.u32();
    if (numOps !== 1) {
      throw new Error("this app signs single-payment transactions, and this one has "
        + numOps + " operations");
    }
    const ops = [];
    for (let i = 0; i < numOps; i++) ops.push(readOperation(r));
    // TransactionExt is a union: v0 carries nothing at all.
    const ext = r.u32();
    if (ext !== 0) throw new Error("transaction carries soroban data; refusing to sign");
    return { source, fee, seq, bounds, memo, ops };
  }

  function readDecorativeSignature(r) {
    const hint = r.fixed(4);
    const sig = r.varOpaque(64);
    return { hint, sig };
  }

  /** Parse a base64 TransactionEnvelope, returning the tx plus its raw bytes. */
  function parseEnvelope(base64) {
    const bytes = base64ToBytes(base64);
    const r = new Reader(bytes);
    const type = r.u32();
    if (type !== ENVELOPE_TYPE_TX) {
      throw new Error("expected a v1 transaction envelope (type 2), got " + type
        + " — a fee-bump or v0 envelope is not supported");
    }
    const txStart = r.i;
    const tx = readTransaction(r);
    const txEnd = r.i;
    const n = r.u32();
    if (n === 0 || n > 20) throw new Error("envelope has " + n + " signatures; expected 1 or 2");
    const signatures = [];
    for (let i = 0; i < n; i++) signatures.push(readDecorativeSignature(r));
    if (r.i !== bytes.length) {
      throw new Error("trailing bytes after the envelope (" + (bytes.length - r.i) + ")");
    }
    return { tx, signatures, txBytes: bytes.slice(txStart, txEnd), bytes };
  }

  // ------------------------------------------------------------------ hashing
  /**
   * The hash a Stellar signature covers:
   *   sha256( sha256(passphrase) || ENVELOPE_TYPE_TX(4) || transactionBytes )
   *
   * The leading 32 bytes are the hash of the network passphrase, not the
   * passphrase itself. Recomputing this on the phone is what stops a swapped
   * transaction: the human is shown this value, and the bytes actually signed
   * have to produce it.
   */
  async function transactionHash(base64, passphraseStr) {
    const env = parseEnvelope(base64);
    const networkId = new Uint8Array(await crypto.subtle.digest(
      "SHA-256", new TextEncoder().encode(passphraseStr)));
    const buf = new Uint8Array(32 + 4 + env.txBytes.length);
    buf.set(networkId, 0);
    buf[32] = 0; buf[33] = 0; buf[34] = 0; buf[35] = ENVELOPE_TYPE_TX;
    buf.set(env.txBytes, 36);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return { hash: hex(new Uint8Array(digest)), env };
  }

  // ------------------------------------------------------------------ signing
  /**
   * The bytes an approver signature must cover: the transaction hash itself,
   * as 32 raw bytes. NOT sha256 of the hex text the human reads. Signing the
   * wrong preimage produces a well-formed envelope the ledger refuses with
   * BAD_AUTH, so this is exported rather than left to each caller to guess.
   */
  function signaturePreimage(hashHex) { return hexToBytes(hashHex); }

  /** Append one ed25519 signature to the envelope. Returns new base64 XDR. */
  function addSignature(base64, signatureBytes, pubKeyBytes) {
    if (signatureBytes.length !== 64) throw new Error("signature must be 64 bytes");
    if (pubKeyBytes.length !== 32) throw new Error("public key must be 32 bytes");
    const env = parseEnvelope(base64);
    if (env.signatures.length >= 2) {
      throw new Error("envelope already has " + env.signatures.length + " signatures");
    }
    const w = new Writer();
    w.u32(ENVELOPE_TYPE_TX);
    w.fixed(env.txBytes);
    const sigs = env.signatures.concat([{
      hint: pubKeyBytes.slice(28), sig: signatureBytes,
    }]);
    w.u32(sigs.length);
    for (const s of sigs) { w.fixed(s.hint); w.varOpaque(s.sig); }
    return bytesToBase64(w.bytes());
  }

  // ------------------------------------------------------------------ amounts
  /** int64 stroops -> "4.5000000", the way the ledger prints it. */
  function formatAmount(stroopAmount) {
    const v = typeof stroopAmount === "bigint" ? stroopAmount : BigInt(stroopAmount);
    if (v < 0n) throw new Error("negative payment amount");
    const whole = v / BigInt(STROOPS);
    const frac = v % BigInt(STROOPS);
    return whole.toString() + "." + frac.toString().padStart(7, "0");
  }

  // ------------------------------------------------------------------ base64
  function base64ToBytes(s) {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToBase64(bytes) {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  function hexToBytes(s) {
    if (!/^[0-9a-fA-F]+$/.test(s) || s.length % 2) throw new Error("not a hex string");
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  function hex(bytes) {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
  }

  const NETWORK_ID = {
    testnet: "Test SDF Network ; September 2015",
    public: "Public Global Stellar Network ; September 2015",
  };

  root.PaydluxXdr = {
    parseEnvelope, transactionHash, addSignature, formatAmount,
    hex, hexToBytes, signaturePreimage,
    encodeAccountEd25519, decodeAccountEd25519,
    decodeSecretSeed, encodeSecretSeed, importSecretSeed,
    NETWORK_ID, crc16Xmodem,
    ENVELOPE_TYPE_TX, OP_PAYMENT, STROOPS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
