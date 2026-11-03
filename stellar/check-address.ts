// Prove a Stellar address is real WITHOUT trusting the SDK: decode base32,
// recompute CRC16-XMODEM, compare. 56 chars = 280 bits = 35 bytes
// (1 version nibble-packed with 3 bits, 32-byte ed25519 key, 2-byte CRC).
import { readFileSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";

const A = process.argv[2]!;
const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
let bits = 0, val = 0;
const b: number[] = [];
for (const ch of A) {
  const i = ALPHA.indexOf(ch);
  if (i < 0) { console.log(`BAD CHAR: ${ch}`); process.exit(1); }
  val = (val << 5) | i; bits += 5;
  if (bits >= 8) { bits -= 8; b.push((val >> bits) & 0xff); }
}
console.log(`chars: ${A.length} -> bytes: ${b.length} (expect 35)`);
const version = b[0] >> 3;
const crc = b.slice(33, 35);
let c = 0;
for (const x of b.slice(0, 33)) {
  c ^= x << 8;
  for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
}
// Stellar writes the CRC16 little-endian (stellar-base: writeUInt16LE), so the
// address carries [low, high]. Comparing big-endian reads a valid address as
// corrupt — which is exactly the kind of false alarm that makes a person send
// money somewhere else.
const le = [c & 0xff, (c >> 8) & 0xff];
const hex = (n: number[]) => n.map((x) => x.toString(16).padStart(2, "0")).join(" ");
console.log(`version byte: ${version}  (6 = ed25519 account)`);
console.log(`crc in address: ${hex(crc)}   recomputed (little-endian): ${hex(le)}`);
console.log(crc[0] === le[0] && crc[1] === le[1]
  ? "CHECKSUM VALID — this is a well-formed Stellar account address"
  : "CHECKSUM INVALID — the address is corrupt");

const d = JSON.parse(readFileSync("paydlux-fund-wallet.json", "utf8"));
console.log("address in paydlux-fund-wallet.json matches:", d.address === A);
console.log("the seed in that file derives this address:", Keypair.fromSecret(d.seed).publicKey() === A);

const h = await fetch("https://horizon.stellar.org/accounts/" + A);
console.log("mainnet ledger:", h.status === 404 ? "account does not exist yet (needs its first XLM)" : "exists, funded");
