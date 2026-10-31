const { createRequire } = require("node:module");
require("/users/project1/phone-app/xdr.js");
const X = globalThis.PaydluxXdr;
const { Keypair, xdr } = require("@stellar/stellar-sdk");

const base = "AAAAAAAAAAACy73VpJvE6aOoht765Knir0se2Ty5xyo/Sqpt+sYYQIgAAAAZABUyo4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAIAAAAAAAA";
// build a real one instead: use the SDK to make a 1-sig envelope, then add ours
const kp = Keypair.random(), src = Keypair.random();
const acc = { id: src.publicKey(), sequenceNumber: "1", raw: () => {} };
const { TransactionBuilder, Operation, Asset } = require("@stellar/stellar-sdk");
const accObj = new (require("@stellar/stellar-sdk").Account)(src.publicKey(), "1");
const tx = new TransactionBuilder(accObj, { fee: "100", networkPassphrase: X.NETWORK_ID.testnet })
  .addOperation(Operation.payment({ destination: kp.publicKey(), asset: Asset.native(), amount: "1.00" }))
  .setTimeout(600).build();
tx.sign(src);
const one = tx.toXDR();
console.log("one-sig len:", Buffer.from(one, "base64").length);

const sig = new Uint8Array(64).fill(7);
const mine = X.addSignature(one, sig, kp.rawPublicKey());
console.log("mine len:", Buffer.from(mine, "base64").length);
console.log("mine b64:", mine);
try {
  const e = xdr.TransactionEnvelope.fromXDR(mine, "base64");
  console.log("SDK parsed mine:", e.switch?.name ?? Object.keys(e), "sigs:", e.v1?.signatures?.length);
} catch (err) { console.log("SDK ERR:", err.message); }
try {
  const e = xdr.TransactionEnvelope.fromXDR(one, "base64");
  console.log("SDK parsed original sigs:", e.v1?.signatures?.length);
} catch (err) { console.log("SDK ERR orig:", err.message); }
console.log("mine hex tail:", Buffer.from(mine, "base64").toString("hex").slice(-160));
console.log("orig hex tail:", Buffer.from(one, "base64").toString("hex").slice(-160));
