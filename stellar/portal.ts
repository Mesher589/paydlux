// The approval portal — what the human actually looks at.
//
// Served by the desk at http://localhost:4022/. One page, no install, works on
// a phone on the same network. It lists what the agent wants to buy and costs,
// and Approve/Deny post back to the desk. Approving signs a Stellar
// transaction; it is not a checkbox in a database.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DeskRecord } from "./desk.ts";

export function portalPage(records: DeskRecord[], vault: string, network: string, qs = "") {
  const rows = records.length
    ? records.map((r) => render(r, qs)).join("\n")
    : `<tr><td colspan="5" class="empty">nothing waiting</td></tr>`;
  return `<!doctype html><html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paydlux — approvals</title>
<style>
 :root{--ink:#0d0f0e;--line:#262a28;--text:#eceae4;--muted:#9aa39d;--gold:#e8b04b;--green:#5fbf8b}
 *{box-sizing:border-box}
 body{margin:0;background:var(--ink);color:var(--text);font:16px/1.5 -apple-system,"Avenir Next",system-ui,sans-serif;padding:24px}
 h1{font-size:20px;margin:0 0 4px}
 .sub{color:var(--muted);font-size:13px;margin-bottom:24px;word-break:break-all}
 table{width:100%;border-collapse:collapse}
 th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:8px;border-bottom:1px solid var(--line)}
 td{padding:14px 8px;border-bottom:1px solid var(--line);vertical-align:middle}
 .amt{font-weight:700;color:var(--gold);white-space:nowrap}
 .uri{font-family:ui-monospace,monospace;font-size:13px}
 .body{color:var(--muted);font-size:12px;max-width:340px;word-break:break-word}
 button{border:0;border-radius:10px;padding:12px 18px;font-size:15px;font-weight:600;cursor:pointer;display:block;width:100%;margin:4px 0}
 .yes{background:var(--green);color:#08110c}
 .no{background:transparent;color:var(--muted);border:1px solid var(--line)}
 .st{font-size:12px;text-transform:uppercase;letter-spacing:.06em}
 .settled{color:var(--green)} .denied,.failed{color:#e07a6b} .pending{color:var(--gold)}
 .tx{font-family:ui-monospace,monospace;font-size:11px;color:var(--muted);word-break:break-all}
 .qr{font-size:10px;white-space:pre-wrap;background:#141715;padding:8px;border-radius:8px;color:var(--text)}
 details summary{cursor:pointer}
 .phlink{color:var(--gold);text-decoration:underline;font-size:12px}
 .foot{margin-top:28px;color:var(--muted);font-size:12px}
 @media(max-width:640px){.body{max-width:180px}}
</style></head><body>
<h1>Paydlux — approvals</h1>
<div class="sub">vault ${vault} · ${network} · refreshed <span id="t">now</span></div>
<table><thead><tr><th>when</th><th>what</th><th>cost</th><th>status</th><th></th></tr></thead>
<tbody>${rows}</tbody></table>
<div class="foot">Approving signs a Stellar transaction with your key. The vault needs two signatures, so this device alone cannot release funds.</div>
<script>
 const Q=${JSON.stringify(qs)};
 async function act(kind,id){await fetch('/'+kind+'/'+id+Q,{method:'POST'});load()}
 async function load(){const r=await fetch('/list'+Q);const d=await r.json();
   document.querySelector('tbody').innerHTML=d.map(row).join('')||'<tr><td colspan="5" class="empty">nothing waiting</td></tr>';
   document.getElementById('t').textContent=new Date().toLocaleTimeString()}
 function row(x){const st='<span class="st '+x.status+'">'+x.status+'</span>'+(x.tx?'<div class="tx">'+x.tx+'</div>':'')+(x.reason?'<div class="tx">'+x.reason+'</div>':'');
  const btns=x.status==='pending'?'<button class="yes" onclick="act(\'approve\',\''+x.id+'\')">Approve</button><button class="no" onclick="act(\'deny\',\''+x.id+'\')">Deny</button>':'';
  const ph=x.status==='awaiting_phone'?'<div class="tx">awaiting your phone</div>':'';
  return '<tr><td>'+new Date(x.at).toLocaleTimeString()+'</td><td><div class="uri">'+x.uri+'</div><div class="body">'+(x.body||'')+'</div></td><td class="amt">'+x.price+'</td><td>'+st+ph+'</td><td style="min-width:130px">'+btns+'</td></tr>'}
 setInterval(load,3000);
</script></body></html>`;
}

function render(r: DeskRecord, qs = "") {
  // qs is the portal key query string ("?k=..."). The approver link has to carry
  // it, because the desk answers 403 for anything without it.
  const link = `phone/?id=${encodeURIComponent(r.id)}${qs.replace("?", "&")}`;
  const btns = r.status === "pending"
    ? `<button class="yes" onclick="act('approve','${r.id}')">Approve</button>
       <button class="no" onclick="act('deny','${r.id}')">Deny</button>`
    : "";
  // Split mode: the desk has no approver key, so approving hands the payment to
  // a phone. Show the human exactly what the phone will be asked to sign.
  // Split mode: the desk has no approver key, so approving hands the payment to
  // a phone. Show the human exactly what the phone will be asked to sign, and
  // give the approver app a link so nobody pastes base64 on a small screen.
  const phone = r.status === "awaiting_phone" && r.challenge
    ? `<div class="tx">awaiting your phone · ${r.challenge.summary.amount} ${r.challenge.summary.token} to ${r.challenge.summary.payee.slice(0, 12)}…</div>
       <div class="tx"><a class="phlink" href="${link}">open on your phone to sign</a></div>
       <details class="tx"><summary>approval payload for the phone</summary><pre class="qr">${r.qr}</pre></details>`
    : "";
  const meta = [phone, r.tx && `<div class="tx">${r.tx}</div>`, r.reason && `<div class="tx">${r.reason}</div>`].filter(Boolean).join("");
  return `<tr>
  <td>${new Date(r.at).toLocaleTimeString()}</td>
  <td><div class="uri">${r.uri}</div><div class="body">${r.body || ""}</div></td>
  <td class="amt">${r.price}</td>
  <td><span class="st ${r.status}">${r.status}</span>${meta}</td>
  <td style="min-width:130px">${btns}</td></tr>`;
}

export function servePortal(req: IncomingMessage, res: ServerResponse, html: string) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}
