// Transaction categories and the rules editor.
//
// The mandate already pins a per-payment ceiling and a daily budget. Categories
// are the new idea: the same vault, sliced by what the money is FOR, each slice
// with its own ceiling. That only helps if a category can never widen what the
// agent may spend — so the property worth proving is the asymmetric one:
//
//   a category can TIGHTEN the mandate, and can never loosen it.
//
// The second half of this file is the editor: an untrusted form POST arrives at
// a route that gates money. It must not be able to smuggle markup, invent a
// ceiling, or be triggered from another site.
//
//   npx tsx stellar/policy-check.ts
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { ApprovalDesk, newPortalKey } from "./desk.ts";
import { PolicyEngine, normalizeCategory } from "./policy.ts";
import { signChallenge } from "./phone.ts";
import { rulesPage } from "./portal.ts";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705", m)) : (fail++, console.log("  \u274c", m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  const other = Keypair.random();
  for (const k of [issuer, principal, approver, seller, other]) await StellarVault.fundTestnet(k);

  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  await vault.deposit("100", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);

  // Base mandate: 10 per payment, 100 per day. The category below is far
  // tighter, so every refusal in section 1 must name the CATEGORY rule and not
  // the base one — otherwise the category did nothing.
  const policy = new PolicyEngine({
    maxPerPayment: 10, dailyBudget: 100, maxMandateTtl: 3600,
    categories: { "data-api": { maxPerPayment: 3, dailyBudget: 6 } },
    payeeCategory: { [seller.publicKey()]: "data-api" },
  });

  const key = newPortalKey();
  const desk = new ApprovalDesk({
    vault, payee: seller.publicKey(),
    principal: principal.secret(),
    split: true,
    port: 4197,
    portalKey: key,
    decideWithinSeconds: 3600,
    policy,
  });

  step("1. a category ceiling refuses what the base mandate would allow");
  const big = desk.enqueue("GET https://api.example.com/big", "9.00", "over the category", "payload");
  const refused = await desk.approve(big);
  ok(refused!.status === "failed", `status is ${refused!.status}`);
  ok(/category_max_per_payment/.test(refused!.reason ?? ""), `the rule named is the category's: ${refused!.reason}`);
  ok(!refused!.challenge, "nothing signable was built");
  ok(await vault.balance(seller.publicKey()) === "0.0000000", "no money moved");

  step("2. the category daily budget binds before the vault-wide one");
  const a1 = desk.enqueue("GET https://api.example.com/a1", "3.00", "one", "payload");
  const asked1 = await desk.approve(a1);
  ok(asked1!.status === "awaiting_phone", "3.00 fits the category, so the phone is asked");
  const done1 = await desk.complete(a1, signChallenge(asked1!.challenge!, approver.secret()));
  ok(done1!.status === "settled", `settled at ledger ${done1!.tx?.slice(0, 12)}\u2026`);
  ok(policy.spentInCategory("data-api") === 3, `the category counter reads ${policy.spentInCategory("data-api")}`);
  ok(policy.spentToday() === 3, `and the day's total reads ${policy.spentToday()}`);

  const a2 = desk.enqueue("GET https://api.example.com/a2", "3.00", "two", "payload");
  const asked2 = await desk.approve(a2);
  const done2 = await desk.complete(a2, signChallenge(asked2!.challenge!, approver.secret()));
  ok(done2!.status === "settled", "a second 3.00 still fits the 6 category budget");

  const a3 = desk.enqueue("GET https://api.example.com/a3", "3.00", "three", "payload");
  const third = await desk.approve(a3);
  ok(third!.status === "failed", "a third 3.00 is refused");
  ok(/category_daily_budget/.test(third!.reason ?? ""), `and it names the category, not the vault: ${third!.reason}`);
  ok(policy.spentToday() === 6, `the vault-wide budget still has 94 of 100 free — the category is what stopped it`);

  step("3. a category can never widen the mandate");
  // A category ceiling above the base ceiling is inert by construction: the
  // base check already ran, so the wider number can never bind. Say it out loud
  // rather than trusting the UI to only offer tighter values.
  const wide = new PolicyEngine({ maxPerPayment: 10, dailyBudget: 100 });
  wide.update({ categories: { loose: { maxPerPayment: 999, dailyBudget: 9999 } }, payeeCategory: { [other.publicKey()]: "loose" } });
  const v = wide.check({ amount: 50, payee: other.publicKey() });
  ok(!v.ok && v.ok === false && v.rule === "max_per_payment", `50 is refused by the BASE ceiling: ${v.ok ? "allowed!" : v.rule}`);
  ok(wide.check({ amount: 9, payee: other.publicKey() }).ok === true, "9 still fits — the loose category added no new room and took none away");

  step("4. an uncategorised wallet is unaffected by categories");
  const plain = new PolicyEngine({ maxPerPayment: 10, dailyBudget: 100, categories: { "data-api": { dailyBudget: 1 } } });
  ok(plain.check({ amount: 10, payee: other.publicKey() }).ok === true, "a wallet with no category pays the full 10");
  ok(plain.categoryOf(other.publicKey()) === undefined, "and categoryOf says so instead of guessing");

  step("5. the queue is counted inside the category too");
  // Without this the human approves four payments, burns four signatures, and
  // watches the last one fail at submission.
  const q = new PolicyEngine({
    maxPerPayment: 10, dailyBudget: 100,
    categories: { api: { dailyBudget: 6 } }, payeeCategory: { [seller.publicKey()]: "api" },
  });
  ok(q.check({ amount: 3, payee: seller.publicKey(), committedInCategory: 4 }).ok === false,
    "3 + 4 already approved and waiting is refused at the button");
  ok(q.check({ amount: 3, payee: seller.publicKey(), committedInCategory: 2 }).ok === true, "3 + 2 waiting still fits");

  step("6. the editor cannot invent a rule the mandate does not allow");
  const edited = new PolicyEngine({ maxPerPayment: 10, dailyBudget: 100 });
  edited.update({
    maxPerPayment: -5, dailyBudget: 0,
    allowlist: ["not-an-account", seller.publicKey(), "<script>steal()</script>"],
    denylist: ["G" + "A".repeat(55)],
    categories: { "<img onerror=1>": { maxPerPayment: -1, dailyBudget: 0 }, "ok-cat": { maxPerPayment: 4 } },
    payeeCategory: { "bogus": "ok-cat", [seller.publicKey()]: "ok-cat", [other.publicKey()]: "ghost-cat" },
  });
  ok(edited.policy.maxPerPayment === 10, `a negative ceiling falls back to 10, not -5: ${edited.policy.maxPerPayment}`);
  ok(edited.policy.dailyBudget === 100, `a zero daily budget falls back to 100, not 0: ${edited.policy.dailyBudget}`);
  ok(JSON.stringify(edited.policy.allowlist) === JSON.stringify([seller.publicKey()]),
    `only a real account id survives the allowlist: ${JSON.stringify(edited.policy.allowlist)}`);
  ok(Object.keys(edited.policy.categories!).join(",") === "imgonerror1,ok-cat",
    `a markup category name is sanitised to a safe alphabet, never kept raw: ${Object.keys(edited.policy.categories!)}`);
  ok(JSON.stringify(edited.policy.payeeCategory) === JSON.stringify({ [seller.publicKey()]: "ok-cat" }),
    "a wallet is only mapped to a category that exists, and only under a real account id");
  ok(normalizeCategory("  Data API<img src=x onerror=alert(1)>  ") === "dataapiimgsrcxonerroralert1",
    `names are reduced to a safe alphabet: ${normalizeCategory("  Data API<img src=x onerror=alert(1)>  ")}`);

  step("7. the rules page cannot be scripted by a category name");
  const html = rulesPage(
    { maxPerPayment: 5, dailyBudget: 9, categories: { "a\"><script>steal()</script>": { maxPerPayment: 1 } }, payeeCategory: { [seller.publicKey()]: "a\"><script>steal()</script>" } } as any,
    { total: 1, byCategory: {} }, vault.address, "testnet", "?k=x");
  ok(!/<script>steal\(\)<\/script>/.test(html), "no raw script tag from a category name");
  ok(/&lt;script&gt;steal\(\)&lt;\/script&gt;/.test(html), "and it is still visible to the human, escaped");

  step("8. /rules is key-gated and same-origin-gated");
  await desk.listen();
  const base = "http://127.0.0.1:4197";
  const noKey = await fetch(`${base}/rules`);
  ok(noKey.status === 403, `no key: ${noKey.status}`);
  const wrongKey = await fetch(`${base}/rules?k=WRONGWRONGWRONG`);
  ok(wrongKey.status === 403, `wrong key: ${wrongKey.status}`);
  const page = await fetch(`${base}/rules?k=${key}`);
  ok(page.status === 200 && /spending rules/.test(await page.text()), `with the key: ${page.status}`);
  const script = await fetch(`${base}/rules.js?k=${key}`);
  ok(script.status === 200 && /text\/javascript/.test(script.headers.get("content-type") ?? ""),
    `the page's script is served as javascript: ${script.headers.get("content-type")}`);

  // A form POST from another site: no preflight, so the action would happen
  // even though the attacker never sees the reply. Same hole /approve had.
  const cross = await fetch(`${base}/rules?k=${key}`, {
    method: "POST",
    headers: { origin: "http://evil.example", "content-type": "application/x-www-form-urlencoded" },
    body: "action=save&dailyBudget=99999",
  });
  ok(cross.status === 403, `cross-origin POST refused: ${cross.status}`);
  ok(policy.policy.dailyBudget === 100, `and the budget is untouched: ${policy.policy.dailyBudget}`);
  const site = await fetch(`${base}/rules?k=${key}`, {
    method: "POST",
    headers: { "sec-fetch-site": "cross-site", "content-type": "application/x-www-form-urlencoded" },
    body: "action=save&dailyBudget=99999",
  });
  ok(site.status === 403, `cross-site Sec-Fetch-Site refused: ${site.status}`);

  step("9. a same-origin save changes the rules that gate the next payment");
  // redirect:"manual" so the assertion is about the desk's own answer. Following
  // it would report the GET's 200 and hide a missing 303.
  const save = await fetch(`${base}/rules?k=${key}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      action: "save", dailyBudget: "100", maxPerPayment: "10",
      newcat: "coding", newcat_max: "1", newcat_daily: "2",
      newpayee: other.publicKey(), newpayee_cat: "coding",
    }),
  });
  ok(save.status === 303, `save redirects: ${save.status}`);
  ok(!!policy.policy.categories?.coding, "the category exists now");
  ok(policy.policy.payeeCategory?.[other.publicKey()] === "coding", "and the wallet is mapped into it");
  ok(policy.check({ amount: 5, payee: other.publicKey() }).ok === false,
    "so a 5 payment to that wallet is now refused by its own category");
  ok(policy.check({ amount: 1, payee: other.publicKey() }).ok === true, "and 1 is allowed");

  // Deleting a category must also delete its mappings, or a wallet keeps a
  // bucket that no longer appears on the page — an invisible rule.
  const del = await fetch(`${base}/rules?k=${key}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ action: "save", dailyBudget: "100", maxPerPayment: "10", delcat: "coding" }),
  });
  ok(del.status === 303, `delete redirects: ${del.status}`);
  ok(!policy.policy.categories?.coding, "the category is gone");
  ok(!policy.policy.payeeCategory?.[other.publicKey()], "and so is its wallet mapping");
  ok(policy.check({ amount: 5, payee: other.publicKey() }).ok === true, "the wallet is back under the base mandate only");

  await desk.close();
  console.log(`\n${fail ? "FAILURES: " + fail : "ALL CHECKS PASSED"}  (${pass} passed)\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => { console.error(e); process.exit(1); });
