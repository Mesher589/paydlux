// Can Paydlux settle in XLM itself? Run: npx tsx stellar/xlm-check.ts
//
// Why this is a separate check from native-check.ts: that file proves the
// *filters* count native money. This one proves the whole setup path works for
// a vault whose settlement asset is the ledger's own currency — the asset the
// public demo should use, because a visitor can fund a wallet from any exchange
// in one step and needs no trustline to pay us.
//
// The specific traps this covers:
//   - "XLM" as a token name builds a FAKE asset that merely shares the name.
//     Only Asset.native() is real XLM, and assetMatches() refuses the fake.
//   - changeTrust on a native asset is a ledger error. If setup sent one, the
//     whole signer/threshold transaction aborts and you get a vault that exists
//     but can never sign anything.
//   - an XLM vault's balance() must read the native balance, and paidToday()
//     must count native payments, or the daily budget never moves.
//
// The live half funds real testnet accounts and submits real transactions.
import { Asset, Keypair } from "@stellar/stellar-sdk";
import { StellarVault, assetMatches, parseToken, passphrase } from "./vault.ts";

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${what}`); }
  else { fail++; console.log(`  \x1b[31m✗ ${what}\x1b[0m`); }
}
function why(e: any) { return e?.message ?? String(e); }

// ---------------------------------------------------------------- name -> asset
console.log("\nthe token name, resolved once");
{
  const xlm = parseToken("XLM");
  ok(xlm.getAssetType() === "native", "XLM resolves to the ledger's own currency");
  ok(parseToken("xlm").getAssetType() === "native", "the name is case-insensitive");
  ok(parseToken("native").getAssetType() === "native", "NATIVE is accepted as a synonym");

  // The forgery this prevents: anyone can issue a token and call it XLM.
  let threw = "";
  try { parseToken("XLM", Keypair.random().publicKey()); } catch (e) { threw = why(e); }
  ok(!!threw, "XLM with an issuer is refused instead of building a fake XLM");
  ok(!assetMatches(parseToken("XLM"), { asset_type: "credit_alphanum4", asset_code: "XLM", asset_issuer: "G…" }),
    "a token someone issued and named XLM does not count as XLM");

  const usdc = parseToken("USDC", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
  ok(usdc.getAssetType() !== "native" && usdc.getCode() === "USDC", "USDC stays a code+issuer pair");
  let t2 = "";
  try { parseToken("AGPAY"); } catch (e) { t2 = why(e); }
  ok(!!t2, "a custom token with no issuer is refused, not guessed");
  let t3 = "";
  try { parseToken(""); } catch (e) { t3 = why(e); }
  ok(!!t3, "an empty token name is refused");
}

// ---------------------------------------------------------------------- live
async function live() {
  console.log("\nagainst the live testnet ledger");
  const principal = Keypair.random(), approver = Keypair.random(), agent = Keypair.random();
  const payee = Keypair.random();
  // No issuer key: XLM has none. One throwaway funded account pays for the
  // vault's creation and is never a signer on it.
  const funder = Keypair.random();
  for (const k of [funder, principal, approver, payee]) await StellarVault.fundTestnet(k);

  const vault = await StellarVault.create({
    network: "testnet", issuer: funder, principal, approver, agent,
    tokenCode: "XLM",
  });
  ok(vault.isNative, "the vault knows it settles in XLM");

  // The trap: a changeTrust for a native asset would have aborted the signer
  // transaction, leaving an account with no signers at all.
  const acc: any = await vault.horizon.loadAccount(vault.address);
  ok((acc.signers ?? []).length >= 4, "the vault has its signers (no aborted trustline)");
  ok((acc.balances ?? []).filter((b: any) => b.asset_type !== "native").length === 0,
    "no trustline was created — XLM needs none");
  ok((acc.balances ?? []).some((b: any) => b.asset_type === "native" && Number(b.balance) > 0),
    "the vault holds XLM");

  // balance() must see the vault's own currency. The old `asset_type !== native`
  // filter made this read 0 forever.
  const bal = await vault.balance();
  ok(Number(bal) > 0, `balance() reads the native balance (${bal} XLM)`);

  // A payment the vault actually signs and submits, in XLM, to a payee that
  // needed no trustline to receive it.
  const price = "2.5";
  const m = await vault.createMandate({ payee: payee.publicKey(), amount: price, ttl: 600, memo: "xlm-check" }, principal, approver);
  const before = await vault.balance(payee.publicKey());
  const res = await vault.executeMandate(m, agent);
  ok(!!res?.hash, `mandate paid ${price} XLM — ledger ${String(res?.hash).slice(0, 16)}…`);
  const after = await vault.balance(payee.publicKey());
  ok(Number(after) - Number(before) === Number(price),
    `the payee received exactly ${price} XLM (${before} -> ${after})`);

  // The budget has to move. If paidToday() skipped native payments the seller
  // could drain an XLM vault while the banner still said the day was unspent.
  const spent = Number(await vault.paidToday(payee.publicKey()));
  ok(spent === Number(price), `paidToday() counts it: ${spent} of the budget spent`);
  ok(Number(await vault.balance()) < Number(bal), "the vault's own XLM balance went down");

  // A wallet that has never been funded cannot receive a payment: the ledger
  // answers op_no_destination. Found the hard way topping up the mainnet demo's
  // agent account, where the CLI's withdraw failed with a bare "FAILED".
  // createAccount is the operation that works, and it costs the same two
  // signatures — so the fix belongs in the vault, not in a hand-rolled script.
  const fresh = Keypair.random();
  const paid = await vault.release(fresh.publicKey(), "1", principal, approver, "xlm-check fresh")
    .then(() => "paid").catch((e) => why(e));
  ok(/no_destination|FAILED/i.test(String(paid)),
    `a payment to an unfunded address is refused (${String(paid).slice(0, 45)})`);
  const made: any = await vault.fund(fresh.publicKey(), "1.5", principal, approver, "xlm-check fund")
    .catch((e) => ({ err: why(e) }));
  ok(!!made?.hash, `fund() creates that account instead (${made?.err ?? "ledger " + String(made.hash).slice(0, 16) + "…"})`);
  ok(String(await vault.balance(fresh.publicKey())).startsWith("1.5"),
    "the new account holds the starting balance");

  // Replay. Two different attacks, two different defences:
  //   (a) resubmit the identical envelope — Horizon de-duplicates it and hands
  //       back the ORIGINAL result, so "submit succeeded" does NOT mean "money
  //       moved again". That is why sellers must check the hash, and why the
  //       money assertion below is the one that counts.
  //   (b) edit the envelope (new amount, new payee, new memo) — the hash is the
  //       signer, so any edit breaks the signature pair and the ledger refuses.
  const again = await vault.executeMandate(m, agent).then(() => "resubmitted").catch((e) => why(e));
  ok(typeof again === "string", `identical resubmission returned: ${String(again).slice(0, 40)}`);
  ok(Number(await vault.balance(payee.publicKey())) === Number(after),
    "the payee was NOT paid twice — the de-dup is real, not a lucky race");

  // What the ledger, not the policy engine, guarantees: the agent key alone can
  // never move this vault's XLM. It reaches threshold 2 only by presenting the
  // exact registered mandate hash. Build a different payment with the same
  // amount and payee and sign it with the agent alone — the ledger says no.
  const { Operation, TransactionBuilder, Account } = await import("@stellar/stellar-sdk");
  const free = await vault.horizon.loadAccount(vault.address);
  const rogue = new TransactionBuilder(new Account(vault.address, free.sequence), {
    fee: "100", networkPassphrase: passphrase("testnet"),
  })
    .addOperation(Operation.payment({ destination: payee.publicKey(), asset: vault.token, amount: "0.5" }))
    .setTimeout(120).build();
  rogue.sign(agent);
  const tam = await vault.horizon.submitTransaction(rogue).then(() => "paid").catch((e: any) => why(e));
  ok(tam !== "paid", `an agent-only payment is refused: ${String(tam).slice(0, 60)}`);
  ok(Number(await vault.balance(payee.publicKey())) === Number(after),
    "and the payee still holds the original amount — nothing extra landed");

  console.log(`\nexplorer: https://stellar.expert/explorer/testnet/account/${vault.address}`);
}

(async () => {
  try { await live(); }
  catch (e) { fail++; console.log(`  \x1b[31m✗ live run threw: ${why(e)}\x1b[0m`); }
  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})();
