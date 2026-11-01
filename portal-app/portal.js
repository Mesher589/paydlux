// The portal's client half. Served by the desk at /portal.js.
//
// It polls /list and re-renders the table. The desk already escapes the rows it
// sends, but this renderer builds HTML from JSON, so it escapes again: /list is
// the same agent-controlled text (request path and body) arriving through a
// second path, and one unescaped field here is enough to run script on the page
// that authorises payments.
//
// No inline handlers: buttons carry data-act/data-id and are wired here, so the
// page's Content-Security-Policy can forbid inline script entirely.
//
// This must render what the server-side render() in stellar/portal.ts renders.
// The page loads with server-rendered rows, then this replaces them every few
// seconds — anything missing here disappears from the human's screen a moment
// after they act, which is exactly what happened to the phone link.
const Q = new URLSearchParams(location.search).toString();
const qs = Q ? "?" + Q : "";

const esc = (v) => String(v ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const row = (x) => {
  const st = `<span class="st ${esc(x.status)}">${esc(x.status)}</span>`;
  // Split mode: the desk has no approver key, so approving handed the payment to
  // a phone. Keep the link and the amount visible after the poll, or the human
  // presses Approve and then loses the thing they were told to do next.
  const phone = x.status === "awaiting_phone" && x.challenge
    ? `<div class="tx">awaiting your phone · ${esc(x.challenge.summary.amount)} ` +
      `${esc(x.challenge.summary.token)} to ${esc(x.challenge.summary.payee.slice(0, 12))}…</div>` +
      `<div class="tx"><a class="phlink" href="phone/?id=${encodeURIComponent(x.id)}${qs.replace("?", "&")}">` +
      `open on your phone to sign</a></div>` +
      `<details class="tx"><summary>approval payload for the phone</summary>` +
      `<pre class="qr">${esc(x.qr)}</pre></details>`
    : x.status === "awaiting_phone" ? `<div class="tx">awaiting your phone</div>` : "";
  const meta = [
    phone,
    x.tx && `<div class="tx">${esc(x.tx)}</div>`,
    x.reason && `<div class="tx">${esc(x.reason)}</div>`,
  ].filter(Boolean).join("");
  const btns = x.status === "pending"
    ? `<button class="yes" data-act="approve" data-id="${esc(x.id)}">Approve</button>` +
      `<button class="no" data-act="deny" data-id="${esc(x.id)}">Deny</button>`
    : "";
  return `<tr><td>${esc(new Date(x.at).toLocaleTimeString())}</td>` +
    `<td><div class="uri">${esc(x.uri)}</div><div class="body">${esc(x.body)}</div></td>` +
    `<td class="amt">${esc(x.price)}</td><td>${st}${meta}</td>` +
    `<td style="min-width:130px">${btns}</td></tr>`;
};

async function act(kind, id) {
  await fetch("/" + kind + "/" + encodeURIComponent(id) + qs, { method: "POST" });
  load();
}

async function load() {
  const r = await fetch("/list" + qs);
  if (!r.ok) return;
  const d = await r.json();
  document.querySelector("tbody").innerHTML =
    d.map(row).join("") || '<tr><td colspan="5" class="empty">nothing waiting</td></tr>';
  document.getElementById("t").textContent = new Date().toLocaleTimeString();
}

// One delegated listener instead of a handler per button, so nothing about a
// row ever needs to be executable markup.
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b) act(b.dataset.act, b.dataset.id);
});

setInterval(load, 3000);
