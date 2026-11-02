// Checks for the seller door: accepting a payment drawn on someone else's vault.
// Run: npx tsx stellar/receive-check.ts
//
// Two kinds of test here. The forgeries run against a stub ledger so they are
// deterministic and offline. The happy path runs against the REAL testnet
// ledger, using a payment this project actually made today, because a stub
// cannot prove the Horizon field names are the ones the code reads.
import { verifyIncomingPayment, OrderBook } from "./receive";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log("  \x1b[32m✅\x1b[0m " + what); }
  else { fail++; console.log("  \x1b[31m❌\x1b[0m " + what); }
}

const PAYEE = "GSELLER0000000000000000000000000000000000000000000000000000";
const BUYER = "GBUYER00000000000000000000000000000000000000000000000000000";
const HASH = "a".repeat(64);
const NOW = new Date().toISOString();

/** A ledger answer that says: this paid us, in full, for order X. */
function goodLedger(over: Record<string, any> = {}, opOver: Record<string, any> = {}) {
  const tx = {
    hash: HASH, successful: true, memo: "ord_abc123", memo_type: "text",
    created_at: NOW, ledger: 1234, ...over,
  };
  // opOver may be a field override OR a whole list of operations.
  const op = Array.isArray(opOver)
    ? opOver
    : [{ type: "payment", from: BUYER, to: PAYEE, amount: "5.0000000", asset_type: "native", ...opOver }];
  return async (url: string) => ({
    status: 200,
    body: url.includes("/operations") ? { _embedded: { records: op } } : tx,
  });
}

/** reason text from a failed verdict, without narrowing every call site. */
const why = (v: any) => String(v?.reason ?? "");

const WANT = {
  payee: PAYEE, amount: "5", asset: { code: "XLM" },
  memo: "ord_abc123", from: BUYER, network: "testnet" as const,
};

async function main() {
  console.log("\n\x1b[1mreceive: the seller door\x1b[0m\n");

  // ---- 1. a real payment, read from the real ledger ------------------------
  // This is the part a stub cannot fake: the Horizon field names.
  try {
    const vault = JSON.parse(readFileSync(new URL("../paydlux-vault.json", import.meta.url), "utf8"));
    const payee: string = vault.payee.address;
    const net: "testnet" | "public" = vault.network === "public" ? "public" : "testnet";
    const base = net === "public" ? "https://horizon.stellar.org" : "https://horizon-testnet.stellar.org";
    const res = await fetch(`${base}/accounts/${payee}/payments?order=desc&limit=10`);
    const recs: any[] = res.ok ? ((await res.json())?._embedded?.records ?? []) : [];
    // A payment OPERATION record has no memo field at all — the memo is on the
    // TRANSACTION. That is exactly why verifyIncomingPayment reads the memo from
    // /transactions/{hash} and not from the operation it matches on. Probing the
    // operation for a memo here would have "found" nothing and hidden the check.
    let paid: any = null;
    for (const r of recs) {
      if (r.type !== "payment") continue;
      const t = await fetch(`${base}/transactions/${r.transaction_hash}`).then((x) => x.json()).catch(() => null);
      if (t && t.memo_type === "text" && t.memo) { paid = { ...r, memo: t.memo }; break; }
    }
    if (paid) {
      const v = await verifyIncomingPayment(paid.transaction_hash, {
        payee, amount: "0.0000001",
        asset: paid.asset_type === "native"
          ? { code: "XLM" }
          : { code: paid.asset_code, issuer: paid.asset_issuer },
        memo: paid.memo, maxAgeSeconds: 60 * 60 * 24 * 365, network: net,
      });
      ok(v.ok, `a payment this project really made verifies on the live ${net} ledger`);
      if (v.ok) console.log(`      ${v.amount} → ${payee.slice(0, 8)}…  tx ${v.tx.slice(0, 12)}…  ledger ${v.ledger}`);
      // Same real payment, wrong memo: must be refused.
      const wrong = await verifyIncomingPayment(paid.transaction_hash, {
        payee, amount: "0.0000001",
        asset: paid.asset_type === "native" ? { code: "XLM" } : { code: paid.asset_code, issuer: paid.asset_issuer },
        memo: "ord_not_this_one", network: net,
      });
      ok(!wrong.ok && /does not name this order/.test(why(wrong)),
        "the same real payment is refused for a different order");
    } else {
      ok(false, "no memo'd payment found on the live ledger to verify against");
    }
  } catch (e) {
    ok(false, `live ledger check could not run: ${(e as Error).message}`);
  }

  // ---- 2. every forgery a stranger could try ------------------------------
  ok(!(await verifyIncomingPayment("not-a-hash", WANT)).ok, "a non-hash is refused");

  const missing = async (url: string) => (url.includes("/transactions/") && !url.includes("operations")
    ? null : await goodLedger()(url));
  ok(!(await verifyIncomingPayment(HASH, WANT, missing)).ok, "an unreachable ledger is refused, not assumed");

  const noTx = async () => ({ status: 404, body: null });
  ok(!(await verifyIncomingPayment(HASH, WANT, noTx)).ok, "a hash that is not on this network is refused");

  const failed = await verifyIncomingPayment(HASH, WANT, goodLedger({ successful: false }));
  ok(!failed.ok && /failed on the ledger/.test(why(failed)),
    "a transaction that exists but FAILED is refused (hash real, money never moved)");

  const noMemo = await verifyIncomingPayment(HASH, WANT, goodLedger({ memo: null, memo_type: "none" }));
  ok(!noMemo.ok && /does not name this order/.test(why(noMemo)),
    "a payment with no memo cannot be tied to an order");

  const otherMemo = await verifyIncomingPayment(HASH, WANT, goodLedger({ memo: "ord_someone_elses_order" }));
  ok(!otherMemo.ok, "a payment for a DIFFERENT order is refused");

  const notUs = await verifyIncomingPayment(HASH, WANT, goodLedger({}, { to: "GSOMEONE_ELSE" }));
  ok(!notUs.ok && /does not pay this account/.test(why(notUs)), "a payment to someone else is refused");

  const short = await verifyIncomingPayment(HASH, WANT, goodLedger({}, { amount: "4.9999999" }));
  ok(!short.ok && /underpaid/.test(why(short)), "an underpayment is refused (partial is not payment)");

  const fakeXlm = await verifyIncomingPayment(HASH, WANT,
    goodLedger({}, { asset_type: "credit_alphanum4", asset_code: "XLM", asset_issuer: "GFRAUD" }));
  ok(!fakeXlm.ok && /not native XLM/.test(why(fakeXlm)),
    "a token someone issued and NAMED XLM is refused — only asset_type native is XLM");

  const wrongToken = await verifyIncomingPayment(HASH,
    { ...WANT, asset: { code: "USDC", issuer: "GCIRCLE" } },
    goodLedger({}, { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GFRAUD_ISSUER" }));
  ok(!wrongToken.ok && /not the priced asset/.test(why(wrongToken)),
    "the right code from the wrong issuer is refused");

  const bundle = await verifyIncomingPayment(HASH, WANT, goodLedger({}, [
    { type: "payment", from: BUYER, to: PAYEE, amount: "5.0000000", asset_type: "native" },
    { type: "payment", from: BUYER, to: PAYEE, amount: "0.0000001", asset_type: "native" },
  ]));
  ok(!bundle.ok && /more than once/.test(why(bundle)),
    "a transaction that pays us twice is refused (a bundle could hide a short payment)");

  const ancient = await verifyIncomingPayment(HASH, WANT,
    goodLedger({ created_at: new Date(Date.now() - 4000_000).toISOString() }));
  ok(!ancient.ok && /older than/.test(why(ancient)),
    "an old payment cannot be replayed onto a new order");

  const wrongVault = await verifyIncomingPayment(HASH, WANT, goodLedger({}, { from: "GSOMEONE_ELSES_VAULT" }));
  ok(!wrongVault.ok && /did not come from the vault/.test(why(wrongVault)),
    "a payment from a vault this order was never issued to is refused");

  ok((await verifyIncomingPayment(HASH, WANT, goodLedger())).ok, "the honest case passes");

  // ---- 3. one payment buys one order --------------------------------------
  const book = new OrderBook(3600);
  const a = book.issue("5", { code: "XLM" }, BUYER);
  const b = book.issue("5", { code: "XLM" }, BUYER);
  ok(a.memo !== b.memo, "each order gets its own unguessable memo");
  ok(a.memo.startsWith("ord_") && a.memo.length >= 10, "the memo is not sequential or guessable");
  book.markSpent(HASH, a.id);
  ok(book.isSpent(HASH), "a spent payment is remembered");
  ok(book.get(b.id)?.redeemedTx === undefined, "the other order is still unpaid");
  ok(book.size === 2, "the book holds both orders");

  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
}
main();
