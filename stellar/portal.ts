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
<div class="sub">vault ${esc(vault)} · ${esc(network)} · refreshed <span id="t">now</span></div>
<table><thead><tr><th>when</th><th>what</th><th>cost</th><th>status</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="foot">Approving signs a Stellar transaction with your key. The vault needs two signatures, so this device alone cannot release funds.</div>
<script src="portal.js"></script></body></html>`;
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
