// Balance check for a Paydlux vault and its payee, straight off the ledger.
// Run:  npx tsx stellar/balances.ts [path/to/paydlux-vault.json]
import { readFileSync } from "node:fs";
import { Horizon } from "@stellar/stellar-sdk";

const file = process.argv[2] ?? "paydlux-vault.json";
const d: any = JSON.parse(readFileSync(file, "utf8"));
const h = new Horizon.Server(d.network === "public"
  ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org");

for (const [name, addr] of [["vault", d.vault], ["payee", d.payee?.address]]) {
  if (!addr) continue;
  const acc: any = await h.loadAccount(addr);
  const tok = acc.balances.find((b: any) => b.asset_code === d.token.code);
  const xlm = acc.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";
  console.log(`${name.padEnd(6)} ${addr}`);
  console.log(`       ${tok?.balance ?? "0"} ${d.token.code}   |   ${xlm} XLM`);
}
