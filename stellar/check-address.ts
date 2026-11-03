// CLI around stellar/address.ts: prove an address is real, and say *why* if it
// isn't. Run it whenever a wallet or exchange claims an address is invalid.
//
//   npm run fund:check
//   npx tsx stellar/check-address.ts G…
//
// The checksum work lives in address.ts now, because the landing-page QR
// generator needs the same proof before it publishes an address to the public
// internet. Keeping one copy means the page and this tool cannot disagree.
import { readFileSync, existsSync } from "node:fs";
import { checkStellarAddress, seedDerives } from "./address";

const A = process.argv[2] ?? (() => {
  try {
    return JSON.parse(readFileSync("paydlux-fund-wallet.json", "utf8")).address;
  } catch { return undefined; }
})();
if (!A) { console.error("usage: check-address <G…address>"); process.exit(1); }

const v = await checkStellarAddress(A, "public");
console.log(`address:  ${A}`);
console.log(`decoded:  ${v.bytes} bytes (expect 35)${v.error ? "  " + v.error : ""}`);
console.log(`version:  ${v.version}  (6 = ed25519 account)`);
console.log(`crc in address: ${v.crcInAddress}   recomputed (little-endian): ${v.crcComputed}`);
console.log(v.checksumOk
  ? "CHECKSUM VALID — this is a well-formed Stellar account address"
  : "CHECKSUM INVALID — the address is corrupt. Do not send to it.");

if (existsSync("paydlux-fund-wallet.json")) {
  const d = JSON.parse(readFileSync("paydlux-fund-wallet.json", "utf8"));
  console.log("address in paydlux-fund-wallet.json matches:", d.address === A);
  console.log("the seed in that file derives this address:", seedDerives(d.seed, A));
}

console.log("mainnet ledger:", v.exists
  ? `exists — ${v.balance} XLM`
  : v.checksumOk
    ? "does not exist yet (needs its first XLM from an exchange withdrawal)"
    : "not checked (bad checksum)");
process.exit(v.checksumOk ? 0 : 1);
