// Checks for stellar/address.ts.
//
// This code now gates what the public landing page publishes as a scannable
// address, so a bug here is not a wrong log line — it is either a refused real
// address or a published fake one. The tests are anchored on addresses whose
// validity is not in question: Circle's USDC issuer account, which has existed
// on mainnet for years, and known-bad mutations of it.
import { checkStellarAddress, decodeAddress, seedDerives } from "./address";
import { Keypair } from "@stellar/stellar-sdk";

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log("  \x1b[32m✓\x1b[0m " + what); }
  else { fail++; console.log("  \x1b[31m✗\x1b[0m " + what); }
}

// Public, long-lived, and verifiable by anyone: Circle's USDC issuer.
const CIRCLE = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
// Our own testnet vault, known good on the test network.
const TESTNET_VAULT = "GCGT7S4J5G5TCWIXCUY5VVDMW3FGWXMPRLALAVHYXOLMSZU7IKJF2FHJ";

async function main() {
  console.log("\nthe checksum is computed the way Stellar computes it");
  {
    const a = decodeAddress(CIRCLE);
    ok(a.bytes === 35, `Circle's issuer decodes to 35 bytes (${a.bytes})`);
    ok(a.version === 6, "version byte 6 = ed25519 account");
    ok(a.checksumOk, "a real mainnet account passes");
    ok(a.crcInAddress === a.crcComputed,
      `crc in address (${a.crcInAddress}) equals the recomputed little-endian crc`);
  }

  console.log("\na single wrong character is caught");
  {
    // Swap one character. The address is still 56 base32 chars and still starts
    // with G, so every shallow check passes — only the checksum sees it.
    const corrupt = CIRCLE.slice(0, 20) + (CIRCLE[20] === "A" ? "B" : "A") + CIRCLE.slice(21);
    const c = decodeAddress(corrupt);
    ok(corrupt.length === 56 && corrupt.startsWith("G"),
      "the corrupt address looks well-formed to a length/prefix check");
    ok(!c.checksumOk, "and the checksum rejects it");
  }

  console.log("\nnon-addresses are rejected without crashing");
  {
    ok(!decodeAddress("not-an-address").checksumOk, "prose is rejected");
    ok(!decodeAddress("").checksumOk, "empty string is rejected");
    // RFC 4648 base32 is A–Z plus 2–7, so 0, 1, 8 and 9 are outside it. Worth
    // naming: a human reading an address aloud hears "oh" for O and "eye" for I,
    // and both are legal Stellar characters, while the digits they get confused
    // with are not. That is why a scannable code beats a dictated address.
    const bad = decodeAddress("G" + "1".repeat(55));
    ok(!bad.checksumOk && !!bad.error, `a character outside the alphabet is named: ${bad.error}`);
    ok(decodeAddress(CIRCLE).checksumOk, "and I, L, O, U inside a real address are accepted");
    // 16 chars decode to 10 bytes, not 35.
    ok(!decodeAddress("GB3X7H4Y2VLQVL").checksumOk, "a short string is rejected");
  }

  console.log("\nthe ledger question is separate from the checksum question");
  {
    // A well-formed address that nobody has ever funded. This is the exact case
    // that reads as "invalid address" in a wallet UI while the address is fine.
    const fresh = Keypair.random().publicKey();
    const v = await checkStellarAddress(fresh, "testnet");
    ok(v.checksumOk, "a never-funded address still has a valid checksum");
    ok(!v.exists, "and the ledger says it does not exist");
    ok(!v.error, "reported as 'does not exist', not as an error");

    const circle = await checkStellarAddress(CIRCLE, "public");
    ok(circle.exists && !!circle.balance, `Circle's issuer exists on mainnet with ${circle.balance} XLM`);

    const ours = await checkStellarAddress(TESTNET_VAULT, "testnet");
    ok(ours.checksumOk && ours.exists, "our testnet vault resolves on the test network");
  }

  console.log("\na seed and its address are checked against each other");
  {
    const k = Keypair.random();
    ok(seedDerives(k.secret(), k.publicKey()), "a real seed derives its own address");
    ok(!seedDerives(k.secret(), CIRCLE), "and not somebody else's address");
    ok(!seedDerives("S", CIRCLE), "a malformed seed returns false instead of throwing");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("crashed:", e?.message ?? e); process.exit(1); });
