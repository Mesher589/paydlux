// Does an XLM vault see its own money? Run: npx tsx stellar/native-check.ts
//
// Two filters used to hard-code "skip native". On a vault that settles in XLM
// itself, that makes the vault blind to its own balance and blind to its own
// spending — the daily budget would read as fully unspent forever, so a seller
// could drain an XLM vault while the banner still said the whole day was left.
import { assetMatches } from "./vault";
import { Asset, Keypair } from "@stellar/stellar-sdk";

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log("  \x1b[32m✅\x1b[0m " + what); }
  else { fail++; console.log("  \x1b[31m❌\x1b[0m " + what); }
}

async function main() {
  console.log("\n\x1b[1mnative XLM: the vault must see its own money\x1b[0m\n");

  const TOKEN = new Asset("AGPAY", Keypair.random().publicKey());
  const XLM = Asset.native();
  const issuer = TOKEN.getIssuer();

  // The record shapes Horizon actually returns.
  const nativeRec = { asset_type: "native", amount: "1.0000000" };
  const tokenRec = { asset_type: "credit_alphanum12", asset_code: "AGPAY", asset_issuer: issuer, amount: "1" };
  const otherRec = { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: issuer, amount: "1" };
  const poolRec = { asset_type: "liquidity_pool_shares", amount: "1" };

  ok(XLM.getAssetType() === "native", "an XLM asset reports itself native");
  ok(TOKEN.getAssetType() !== "native", "a token asset reports itself not native");

  ok(assetMatches(XLM, nativeRec), "XLM vault counts a native payment");
  ok(!assetMatches(XLM, tokenRec), "XLM vault ignores a token payment");
  ok(assetMatches(TOKEN, tokenRec), "token vault counts its own token");
  ok(!assetMatches(TOKEN, nativeRec), "token vault ignores native XLM (rent, not spend)");
  ok(!assetMatches(TOKEN, otherRec), "token vault ignores someone else's token");
  ok(!assetMatches(TOKEN, poolRec), "neither counts a liquidity pool share");
  ok(!assetMatches(XLM, undefined), "a missing record is refused, not counted");

  // The exact bug: the old `asset_type !== "native"` filter. Applied to an XLM
  // vault it drops every one of that vault's own payments, so paidToday()
  // returns 0 forever and the daily ceiling never closes.
  const oldFilter = (rec: any) =>
    rec.asset_type !== "native" && rec.asset_code === XLM.getCode() && rec.asset_issuer === XLM.getIssuer();
  ok(!oldFilter(nativeRec) && assetMatches(XLM, nativeRec),
    "the old native-skipping filter would have zeroed an XLM budget");

  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
}
main();
