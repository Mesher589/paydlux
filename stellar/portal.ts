// The approval portal — what the human actually looks at.
//
// Served by the desk at http://localhost:4022/. One page, no install, works on
// a phone on the same network. It lists what the agent wants to buy and costs,
// and Approve/Deny post back to the desk. Approving signs a Stellar
// transaction; it is not a checkbox in a database.
//
// SECURITY: almost every string rendered here is text the buyer controls. `uri`
// is the request path the agent asked for and `body` is the agent's request
// body; both are stored verbatim and shown to the human. So everything is
// escaped. A human clicking Approve on a page the agent can script is not a
// human approving a payment — the agent would be approving itself. The
// client-side renderer in portal-app/portal.js escapes the same fields again,
// because /list is polled and re-rendered in the browser.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeskRecord } from "./desk.ts";
import type { Policy } from "./policy.ts";

/**
 * HTML escaping. Not optional: the request path and body are attacker-chosen
 * text that lands inside the one page that can authorise a payment.
 */
export function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function portalPage(records: DeskRecord[], vault: string, network: string, qs = "") {
  const rows = records.length
    ? records.map((r) => render(r, qs)).join("\n")
    : `<tr><td colspan="5" class="empty">nothing waiting</td></tr>`;
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paydlux — approvals</title>
<link rel="stylesheet" href="portal.css"></head><body>
<h1>Paydlux — approvals</h1>
<div class="sub"><a class="nav" href="/${qs}">approvals</a> · <a class="nav" href="/rules${qs}">spending rules</a><br>
vault ${esc(vault)} · ${esc(network)} · refreshed <span id="t">now</span></div>
<table><thead><tr><th>when</th><th>what</th><th>cost</th><th>status</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="foot">Approving signs a Stellar transaction with your key. The vault needs two signatures, so this device alone cannot release funds.</div>
<script src="portal.js"></script></body></html>`;
}

/**
 * The spending rules, as a form the owner can read and edit.
 *
 * This is the surface the "customizable approval policy" request is really
 * about: limits, approved wallets, and categories in one place, instead of
 * command-line flags nobody outside a terminal can see.
 *
 * What it does NOT do is approve anything. Every payment still needs a human
 * signature; these rules only decide what a human gets asked to sign. A rule
 * set here can narrow the agent's reach, never widen what the ledger will
 * accept, and the page says so in the same words the code enforces.
 */
export function rulesPage(policy: Policy, spent: { total: number; byCategory: Record<string, number> }, vault: string, network: string, qs = "", saved = false) {
  const cats = Object.entries(policy.categories ?? {});
  const catRows = cats.length
    ? cats.map(([name, rule]) => categoryRow(name, rule, policy, spent.byCategory[name] ?? 0)).join("\n")
    : `<tr><td colspan="5" class="empty">no categories — every seller shares the daily budget</td></tr>`;
  const mapped = Object.entries(policy.payeeCategory ?? {});
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paydlux — spending rules</title>
<link rel="stylesheet" href="portal.css"></head><body>
<h1>Paydlux — spending rules</h1>
<div class="sub"><a class="nav" href="/${qs}">approvals</a> · <a class="nav" href="/rules${qs}">spending rules</a><br>
vault ${esc(vault)} · ${esc(network)}${saved ? ` · <span class="saved">saved</span>` : ""}</div>

<form id="rules" method="post" action="/rules${qs}">
<h2>Every payment</h2>
<div class="grid">
  <label>Most for one payment
    <input name="maxPerPayment" type="number" min="0.0000001" step="0.0000001" value="${esc(policy.maxPerPayment)}"></label>
  <label>Daily budget
    <input name="dailyBudget" type="number" min="0.0000001" step="0.0000001" value="${esc(policy.dailyBudget)}"></label>
</div>
<p class="note">Spent today: <b>${esc(spent.total.toFixed(7))}</b> of ${esc(policy.dailyBudget)}. The day resets at 00:00 UTC.</p>

<h2>Wallets the agent may pay</h2>
<div class="grid">
  <label>Allowed (one account per line, blank = any)
    <textarea name="allowlist" rows="3" spellcheck="false" autocomplete="off">${esc((policy.allowlist ?? []).join("\n"))}</textarea></label>
  <label>Never allowed, even if listed above
    <textarea name="denylist" rows="3" spellcheck="false" autocomplete="off">${esc((policy.denylist ?? []).join("\n"))}</textarea></label>
</div>

<h2>Categories</h2>
<p class="note">Split the daily budget by what the money is for. A category can only be
tighter than the limits above — it can never raise them.</p>
<table class="cats"><thead><tr><th>name</th><th>max / payment</th><th>daily</th><th>spent today</th><th></th></tr></thead>
<tbody id="catbody">${catRows}</tbody></table>
<div class="addcat">
  <input name="newcat" placeholder="name (a-z, 0-9)" maxlength="32" spellcheck="false" autocomplete="off">
  <input name="newcat_max" type="number" min="0.0000001" step="0.0000001" placeholder="max / payment">
  <input name="newcat_daily" type="number" min="0.0000001" step="0.0000001" placeholder="daily">
  <button class="yes" type="submit" name="action" value="add">Add category</button>
</div>

<h2>Which wallet is in which category</h2>
${mapped.length
  ? `<table class="map"><thead><tr><th>wallet</th><th>category</th></tr></thead><tbody>
${mapped.map(([payee, name]) => `<tr><td class="tx">${esc(payee)}</td><td>${esc(name)}`
  + ` <button class="no mini" data-del="${esc(payee)}" data-map="1">Remove</button></td></tr>`).join("\n")}
</tbody></table>`
  : `<p class="note">Nothing categorised yet. Add a wallet below to cap it on its own.</p>`}
<div class="addcat">
  <input name="newpayee" placeholder="G… wallet address" maxlength="56" spellcheck="false" autocomplete="off">
  <input name="newpayee_cat" placeholder="category" maxlength="32" spellcheck="false" autocomplete="off">
  <button class="yes" type="submit" name="action" value="map">Add</button>
</div>

<div class="save">
  <button class="yes" type="submit" name="action" value="save">Save rules</button>
</div>
</form>

<div class="foot">These rules decide what you are <i>asked</i> to approve. They never approve
anything themselves: every payment still needs your signature, and the vault needs two.</div>
<script src="rules.js"></script></body></html>`;
}

function categoryRow(name: string, rule: { maxPerPayment?: number; dailyBudget?: number }, policy: Policy, spent: number) {
  // Names go in both a hidden value and the delete button's data-*, so they are
  // escaped like any other attacker-chosen string — even though update() already
  // reduced them to [a-z0-9_-].
  //
  // The name is deliberately NOT an editable input. Renaming a bucket would
  // orphan every wallet mapped to it, and an orphaned wallet stops having a
  // category ceiling — a rename would silently loosen the rules while looking
  // like a cosmetic edit. Renaming is therefore remove + add, which forces the
  // human to re-map the wallets and see what they are doing.
  return `<tr>
  <td><span class="catname">${esc(name)}</span><input type="hidden" name="cat_${esc(name)}_name" value="${esc(name)}"></td>
  <td><input name="cat_${esc(name)}_max" type="number" min="0.0000001" step="0.0000001" value="${esc(rule.maxPerPayment ?? "")}" placeholder="${esc(policy.maxPerPayment)}"></td>
  <td><input name="cat_${esc(name)}_daily" type="number" min="0.0000001" step="0.0000001" value="${esc(rule.dailyBudget ?? "")}" placeholder="${esc(policy.dailyBudget)}"></td>
  <td class="amt">${esc(spent.toFixed(7))}</td>
  <td><button class="no" data-del="${esc(name)}">Remove</button></td></tr>`;
}

function render(r: DeskRecord, qs = "") {
  // qs is the portal key query string ("?k=..."). The approver link has to carry
  // it, because the desk answers 403 for anything without it.
  const link = `phone/?id=${encodeURIComponent(r.id)}${qs.replace("?", "&")}`;
  // The id is desk-generated (pay_NNNN) but it still lands in an attribute, so it
  // is escaped like everything else. Buttons are wired by portal.js through
  // data-*, not an inline onclick, so the page needs no 'unsafe-inline'.
  const btns = r.status === "pending"
    ? `<button class="yes" data-act="approve" data-id="${esc(r.id)}">Approve</button>
       <button class="no" data-act="deny" data-id="${esc(r.id)}">Deny</button>`
    : "";
  // Split mode: the desk has no approver key, so approving hands the payment to
  // a phone. Show the human exactly what the phone will be asked to sign, and
  // give the approver app a link so nobody pastes base64 on a small screen.
  const phone = r.status === "awaiting_phone" && r.challenge
    ? `<div class="tx">awaiting your phone · ${esc(r.challenge.summary.amount)} ${esc(r.challenge.summary.token)} to ${esc(r.challenge.summary.payee.slice(0, 12))}…</div>
       <div class="tx"><a class="phlink" href="${esc(link)}">open on your phone to sign</a></div>
       <details class="tx"><summary>approval payload for the phone</summary><pre class="qr">${esc(r.qr)}</pre></details>`
    : "";
  const meta = [phone, r.tx && `<div class="tx">${esc(r.tx)}</div>`,
    r.reason && `<div class="tx">${esc(r.reason)}</div>`].filter(Boolean).join("");
  return `<tr>
  <td>${esc(new Date(r.at).toLocaleTimeString())}</td>
  <td><div class="uri">${esc(r.uri)}</div><div class="body">${esc(r.body)}</div></td>
  <td class="amt">${esc(r.price)}</td>
  <td><span class="st ${esc(r.status)}">${esc(r.status)}</span>${meta}</td>
  <td style="min-width:130px">${btns}</td></tr>`;
}

export function servePortal(req: IncomingMessage, res: ServerResponse, html: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
