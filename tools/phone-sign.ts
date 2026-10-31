#!/usr/bin/env node
// Paydlux phone signer — run this where the human's key lives.
//
// It never talks to the network. It reads an approval payload (from a QR code,
// a paste, or stdin), shows a person what it says, and prints the signed
// transaction to send back. The approver seed is read from PAYDLUX_APPROVER_SEED
// or passed with --seed; it is never sent anywhere.
//
//   PAYDLUX_APPROVER_SEED=S... npx tsx tools/phone-sign.ts --qr-file payload.txt
//   npx tsx tools/phone-sign.ts --qr-file payload.txt --seed S...
//   pbpaste | npx tsx tools/phone-sign.ts
//
// Refuses to sign anything whose hash disagrees with the payload.
import { readFileSync } from "node:fs";
import { parseChallengeQr, describeChallenge, signChallenge } from "../stellar/phone.ts";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};

const main = () => {
  const qrFile = flag("qr-file");
  const seed = flag("seed") ?? process.env.PAYDLUX_APPROVER_SEED;
  let payload = qrFile ? readFileSync(qrFile, "utf8").trim() : "";
  if (!payload) {
    try { payload = readFileSync(0, "utf8").trim(); } catch { /* no stdin */ }
  }
  if (!payload) {
    console.error("usage: phone-sign.ts --qr-file FILE [--seed S...]   or pipe the payload on stdin");
    process.exit(2);
  }
  if (!seed) {
    console.error("no approver key. Set PAYDLUX_APPROVER_SEED or pass --seed.");
    console.error("This key is the human half of the vault. Keep it on this device only.");
    process.exit(2);
  }

  const challenge = parseChallengeQr(payload);
  console.error("\nApprove this payment?\n");
  console.error(describeChallenge(challenge));
  console.error(`\nid       ${challenge.id}\n`);

  const signed = signChallenge(challenge, seed);
  // stdout is machine-readable: pipe it straight into the desk.
  console.log(JSON.stringify({ id: challenge.id, signedXdr: signed }));
  console.error("signed. post it to:  POST /signed/" + challenge.id + "  body " + JSON.stringify({ signedXdr: "<the line above>" }));
};

try { main(); } catch (e) {
  console.error("refused:", (e as Error).message);
  process.exit(1);
}
