// Drives the live desk at https://desk.paydlux.com exactly the way the phone
// app does: fetch the challenge, decode it with the app's own xdr.js, sign with
// a non-extractable WebCrypto key, post the signature back.
const BASE = "https://desk.paydlux.com";
const KEY = process.argv[2]!;
const SEED = process.argv[3]!;
const ID = process.argv[4] ?? "pay_0001";
await import("../phone-app/xdr.js");  // attaches globalThis.PaydluxXdr
const X: any = (globalThis as any).PaydluxXdr;

const get = async (p: string) => {
  const r = await fetch(BASE + p + (p.includes("?") ? "&" : "?") + "k=" + encodeURIComponent(KEY));
  return { status: r.status, body: await r.json().catch(() => null) };
};

const ch = await get("/challenge/" + ID);
console.log("challenge:", ch.status, JSON.stringify(ch.body)?.slice(0, 200));
if (!ch.body?.xdr) throw new Error("no challenge");

const env = X.parseEnvelope(ch.body.xdr);
const op = env.tx.ops[0];
console.log("decoded  :", X.formatAmount(op.amount), op.asset.code || "XLM",
  "->", X.encodeAccountEd25519(op.destination.pub).slice(0, 12) + "…");
console.log("memo     :", env.tx.memo?.value ?? "(none)");
console.log("deadline :", env.tx.cond?.timeBounds?.max ?? "(none)");

const pair = await X.importSecretSeedPair(SEED);
console.log("approver :", pair.address);
const { hash } = await X.transactionHash(ch.body.xdr, X.NETWORK_ID[ch.body.network]);
console.log("hash     :", hash, hash === ch.body.hash ? "== desk hash" : "!! MISMATCH");
if (hash !== ch.body.hash) throw new Error("hash mismatch, refusing to sign");

const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.key, X.signaturePreimage(hash)));
const signed = X.addSignature(ch.body.xdr, sig, pair.pub);
const out = await fetch(`${BASE}/signed/${ID}?k=${encodeURIComponent(KEY)}`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ signedXdr: signed }),
});
const res = await out.json();
console.log("result   :", out.status, JSON.stringify(res));
