// Where is the money? Run: npx tsx stellar/funds-check.ts
//
// Before switching the public demo to real money, one question has a hard
// answer: does any key this machine already holds actually hold mainnet XLM?
// Guessing here means starting a seller that cannot pay anything.
//
// Prints public keys and balances only. Never prints a secret.
import { readFileSync, existsSync } from "node:fs";
import { Keypair } from "@stellar/stellar-sdk";

const file = process.argv[2] ?? "paydlux-vault.json";
if (!existsSync(file)) {
  console.log(`no vault file at ${file}. Nothing to check.`);
  process.exit(0);
}
const data = JSON.parse(readFileSync(file, "utf8"));

const NETS: Record<string, string> = {
  MAINNET: "https://horizon.stellar.org",
  testnet: "https://horizon-testnet.stellar.org",
};

async function balance(url: string, pub: string) {
  const r = await fetch(`${url}/accounts/${pub}`).catch(() => null);
  if (!r || !r.ok) return null;
  const a: any = await r.json();
  const native = (a.balances ?? []).find((b: any) => b.asset_type === "native");
  const token = data.token?.code && data.token.code !== "XLM"
    ? (a.balances ?? []).find((b: any) => b.asset_code === data.token.code && b.asset_issuer === data.token.issuer)
    : undefined;
  return {
    xlm: native?.balance ?? "0",
    token: token?.balance,
    reserve: ((2 + (a.subentry_count ?? 0)) * 0.5).toFixed(1),
  };
}

console.log(`vault file   ${file}`);
console.log(`network      ${data.network}`);
console.log(`token        ${data.token?.code}${data.token?.issuer ? " from " + data.token.issuer : " (the ledger's own currency)"}`);
console.log(`vault        ${data.vault}`);
console.log(`payee        ${data.payee?.address}${data.payee?.external ? " (your own account)" : ""}\n`);

const rows: string[] = [];
const seen = new Set<string>();
for (const [label, pub] of [
  ["vault", data.vault],
  ["payee", data.payee?.address],
  ...Object.entries(data.keys ?? {}).map(([k, v]) =>
    [k, String(v).startsWith("S") ? Keypair.fromSecret(String(v)).publicKey() : String(v)] as [string, string]),
]) {
  if (!pub || seen.has(pub)) continue;
  seen.add(pub);
  const line = [label.padEnd(12), pub];
  for (const [net, url] of Object.entries(NETS)) {
    const b = await balance(url, pub);
    line.push(b
      ? `${net}=${b.xlm} XLM${b.token ? ` + ${b.token} ${data.token.code}` : ""} (rent ${b.reserve})`
      : `${net}=no account`);
  }
  rows.push(line.join("  "));
}
console.log(rows.join("\n"));

const vaultMain = await balance(NETS.MAINNET, data.vault);
const vaultNet = await balance(NETS.testnet, data.vault);
console.log(`\nverdict:`);
console.log(`  the ${data.network} vault ${data.vault} holds ${data.network === "public" ? vaultMain?.xlm : vaultNet?.xlm} XLM`);
if (data.network !== "public") {
  console.log(`  it is a testnet vault. Real money needs a mainnet vault:`);
  console.log(`    npm run app -- setup --mainnet --token XLM --max 2 --daily 20 --fund-seed S…`);
  console.log(`  (the funding wallet needs ~14 XLM: 12 for the vault, 2 for the payee)`);
}
