#!/usr/bin/env npx tsx
// Regenerate the QR that sits on the public landing page.
//
// Why a script and not a picture someone saved once: the landing page is a
// manual Cloudflare Pages upload (site/ is gitignored), so nothing redeploys it
// when the vault changes. A QR saved by hand would keep pointing at the OLD
// account after a re-setup, and a donation sent to a dead address is gone
// forever. So the file is generated from the vault file, and it refuses to
// write anything it cannot verify.
//
//   npm run site:qr
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { qrSvg } from "./qr";
import { checkStellarAddress } from "./address";

const VAULT_FILE = process.argv[2] ?? "paydlux-mainnet.json";
const OUT = process.argv[3] ?? "site/qr.svg";

async function main() {
  if (!existsSync(VAULT_FILE)) {
    console.error(`no vault file at ${VAULT_FILE}. Nothing was written.`);
    process.exit(1);
  }
  const data = JSON.parse(readFileSync(VAULT_FILE, "utf8"));
  const address: string = typeof data.vault === "string" ? data.vault : data.vault?.address;
  const network = data.network === "public" ? "public" : "testnet";

  if (network !== "public") {
    console.error(`${VAULT_FILE} is a ${network} vault. A testnet address on the public\n`
      + "landing page would collect nothing. Point this at the mainnet vault file.");
    process.exit(1);
  }

  // Verify before publishing. This is the same independent check that proved the
  // funding wallet's address was real: decode the base32, recompute the CRC16,
  // compare. A typo in a vault file becomes a visible error here instead of a
  // scannable code that sends money into the void.
  const verdict = await checkStellarAddress(address, "public");
  if (!verdict.checksumOk) {
    console.error(`refusing to publish: ${address} fails Stellar's own checksum.\n`
      + `  crc in address ${verdict.crcInAddress}, recomputed ${verdict.crcComputed}`);
    process.exit(1);
  }
  if (!verdict.exists) {
    console.error(`refusing to publish: ${address} does not exist on the mainnet ledger yet.\n`
      + "  It needs its first XLM before it can receive a donation.");
    process.exit(1);
  }

  const svg = qrSvg(address);
  writeFileSync(OUT, svg);
  console.log(`wrote ${resolve(OUT)}`);
  console.log(`  encodes  ${address}`);
  console.log(`  network  mainnet (real money)`);
  console.log(`  ledger   ${verdict.balance} XLM in the account today`);
  console.log(`\nthe landing page is a manual upload: re-deploy site/ after this changes.`);
}
main().catch((e) => { console.error("failed:", e?.message ?? e); process.exit(1); });
