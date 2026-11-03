// The donation page: a stranger's agent pays us from THEIR vault.
//
// This is the other half of the seller door (stellar/receive.ts). The showcase
// on demo.paydlux.com spends the SELLER's money to show the loop. A donation
// spends the VISITOR's money, which is the whole point of the product: an
// agent that can pay, with a human holding the brake on the payer's side.
//
// Why the payer approves and the seller does not:
//   the seller's risk is "I served content and never got paid". The ledger
//   answers that with a public read, so no seller signature is needed.
//   the payer's risk is "an agent spent my money". That needs a human, and it
//   has to be *their* human, on *their* phone, against *their* mandate.
//
// Nothing here holds a buyer key. We publish terms; they sign at home; the
// ledger is the only witness we accept.
import { startReceive } from "./receive";
import type { Network } from "./receive";

export const DONATE_HOST = "donate.paydlux.com";
export const DONATE_PORT = 4024;

export type DonatePageConfig = {
  price: string;
  asset: string;
  network: Network;
  payee: string;
  vault: string;
  explorer: string;
};

/**
 * The page. No inline script and nothing visitor-controlled is interpolated, so
 * the strict CSP is real rather than decorative — the same rule the showcase
 * follows, because this port is public.
 */
export function donatePage(cfg: DonatePageConfig): string {
  const asset = cfg.asset === "XLM" ? "XLM (Stellar's own currency)" : cfg.asset;
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fund Paydlux — an agent pays, a human decides</title>
<meta name="description" content="Pay Paydlux from your own Stellar vault. Your agent asks, your phone approves, the ledger proves it. No seller key touches your money.">
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#14181a;color:#e8ecee;font:16px/1.6 Georgia,serif}
 main{max-width:760px;margin:0 auto;padding:48px 24px 80px}
 h1{font-size:34px;line-height:1.25;margin:0 0 10px}
 .sub{color:#9fb0b6;margin:0 0 34px}
 .card{background:#1b2124;border:1px solid #2b3338;border-radius:12px;padding:20px 22px;margin:0 0 18px}
 .price{font-size:30px;margin:0}
 .muted{color:#8fa0a6;font-size:14px}
 code,pre{font:13px/1.7 Menlo,monospace;background:#0f1315;border-radius:8px;padding:2px 6px;color:#cfe3ea;overflow-x:auto}
 pre{padding:14px 16px;white-space:pre-wrap;word-break:break-word}
 ol{padding-left:22px} li{margin:0 0 12px}
 a{color:#7fd1c8}
 .row{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:22px 0}
 button{background:#2f6f66;color:#fff;border:0;border-radius:9px;padding:13px 22px;font-size:16px;cursor:pointer}
 button:disabled{opacity:.5;cursor:default}
 #out{white-space:pre-wrap;word-break:break-word;font:13px/1.7 Menlo,monospace;background:#0f1315;border-radius:10px;padding:16px;margin-top:16px;display:none}
 .ok{color:#8fe3b0}.bad{color:#e8a09a}
 footer{margin-top:40px;color:#7f8f95;font-size:13px}
</style></head>
<body><main>
 <h1>An agent can pay.<br>Whether it <em>may</em> is a human decision.</h1>
 <p class="sub">This page takes a real payment drawn on <strong>your</strong> vault. We never
 hold your key, your seed, or your approval. The money moves because your phone said so.</p>

 <div class="card">
  <p class="price">${cfg.price} ${asset}</p>
  <p class="muted">one payment, one order, one memo. The memo is what ties your payment to
  the thing you asked for, so it cannot be reused for anyone else's order.</p>
 </div>

 <div class="row">
  <button id="go">Ask my agent to pay</button>
  <span class="muted">never paid with an agent before? <a href="https://demo.paydlux.com/">run the loop free on testnet first</a> — same mechanics, costs nothing</span>
 </div>
 <pre id="cmd">curl -s -X POST https://${DONATE_HOST}/donate \
     -d '{"vault":"G…your vault…"}'
# → 402 with: order, memo, payTo, maxAmountRequired
# the order is now bound to YOUR vault: a payment from anyone else's account
# is refused, so nobody can pay for your order and take the goods
# pay it from your vault with a mandate carrying that memo, then:
curl -s "https://${DONATE_HOST}/donate?order=ORDER&amp;tx=TXHASH"</pre>
 <div id="out"></div>

 <div class="card">
  <p><strong>What actually happens</strong></p>
  <ol>
   <li>Your agent asks for an order. We answer <code>402</code> with the price, our
       account, and a one-time memo. Nothing is paid yet.</li>
   <li>Your agent builds a <em>mandate</em> on your own Stellar vault: this amount, this
       payee, this memo, expiring if you never answer.</li>
   <li>Your vault needs <strong>two signatures</strong>. Your agent holds one. The other is on
       your phone, and you hold it down for a second to give it. Without that second
       signature the ledger refuses — not our server, the ledger.</li>
   <li>We read the public ledger. If the payment really landed, in full, naming this
       order, we serve the thing. If it did not, we serve nothing, and say why.</li>
  </ol>
  <p class="muted">We cannot see your seed. We cannot approve for you. You cannot pay more
  than your own mandate allows, even if the agent asks twice.</p>
 </div>

 <div class="card">
  <p><strong>Where the money goes</strong></p>
  <p class="muted">Straight into the Paydlux operating vault, which is itself a 2-of-2
  account: the founder's key and a phone key. Development spend has to be approved by a
  human on that same phone, against a daily ceiling, and every payment is public.</p>
  <p class="muted">vault <a href="${cfg.explorer}/${cfg.vault}">${cfg.vault}</a> ·
  payments land in <a href="${cfg.explorer}/${cfg.payee}">${cfg.payee}</a> ·
  network <code>${cfg.network === "public" ? "mainnet" : "testnet"}</code></p>
 </div>

 <div class="card">
  <p><strong>What it buys, and why a laptop isn't enough</strong></p>
  <p class="muted">The code is written, it runs, and it is public. What it does not have is
  the boring infrastructure real money needs:</p>
  <ul class="muted">
   <li><strong>An always-on machine.</strong> Right now the gateway, the desk and this page
       run on a founder's MacBook. Close the lid and a buyer is parked mid-payment. A
       payment system that sleeps when its author sleeps is not a payment system.</li>
   <li><strong>Settlement capital.</strong> A payment rail needs money moving through it.
       Stellar pays grants in XLM — the same asset this settles in, which is why this is a
       Stellar project and not an EVM one.</li>
   <li><strong>An installable approver app.</strong> The money-critical half of this product
       is currently a browser tab. It should be a signed app on your phone.</li>
   <li><strong>An external audit.</strong> The whole promise is that a human authorises the
       money. If the signing path has a bug, the promise is worth less than nothing, and we
       should not be the only people who looked.</li>
  </ul>
  <p class="muted">Everything else — the mandate engine, the ledger verification, the
  refusals — already exists, and every refusal this page makes is covered by a test that
  forges a payment and checks that it is rejected. That part is not the ask.</p>
 </div>

 <footer>Paydlux · HTTP 402 for agents, a thumb for humans · <a href="https://paydlux.com">paydlux.com</a></footer>
</main>
<script src="/donate.js"></script>
</body></html>`;
}

/**
 * The browser half. It does NOT sign anything — it cannot, and that is the
 * design. It fetches an order, prints the exact command your agent runs, and
 * then polls until the ledger says the money landed.
 */
export function donateScript(): string {
  return `// no signing here on purpose. The browser's job is to show you the order and
// wait. The signature happens on your phone, against your own vault.
var out = document.getElementById("out"), btn = document.getElementById("go");
function say(t, cls) { out.style.display = "block"; out.textContent += (out.textContent ? "\\n" : "") + t; if (cls) out.className = cls; }
btn.onclick = async function () {
  btn.disabled = true; out.textContent = "";
  try {
    var r = await fetch("/donate", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    var j = await r.json();
    if (!j.order) { say("no order: " + (j.error || r.status), "bad"); btn.disabled = false; return; }
    say("order " + j.order + "\\nmemo " + j.memo + "\\npay " + j.maxAmountRequired + " " + (j.token && j.token.code) + "\\nto   " + j.payTo, "");
    document.getElementById("cmd").textContent =
      "curl -s \"" + location.origin + "/donate?order=" + j.order + "&tx=TXHASH\"";
    say("\\nnow run that command, or pay from your own agent with this memo.", "");
    say("\\nwhen your agent has the tx hash, the page confirms it here:", "");\n    var h = prompt("tx hash");\n    if (!h) { say("no hash given — check yourself with the curl above", ""); return; }\n    var v = await (await fetch("/donate?order=" + j.order + "&tx=" + encodeURIComponent(h))).json();\n    if (v.data) { say("\\nPAID — ledger " + v.proof.tx + "\\nledger #" + v.proof.ledger + " at " + v.proof.paidAt, "ok"); }\n    else { say("not served: " + (v.reason || v.error), "bad"); }
  } catch (e) { say("network error: " + e.message, "bad"); }
  btn.disabled = false;
};`;
}

/**
 * Start the donation endpoint: the seller door plus a page a human can read.
 */
export function startDonate(cfg: {
  port: number; hostname: string; payee: string; network: Network;
  price: string; asset: { code: string; issuer?: string };
  vault: string; explorer?: string;
  /** Test seam: a stub ledger, so the routes can be driven without a network. */
  fetchJson?: (url: string) => Promise<{ status: number; body: any } | null>;
}) {
  const explorer = cfg.explorer ?? `https://stellar.expert/explorer/${cfg.network === "public" ? "account" : "testnet/account"}`;
  const page = donatePage({
    price: cfg.price, asset: cfg.asset.code, network: cfg.network,
    payee: cfg.payee, vault: cfg.vault, explorer,
  });
  const r = startReceive({
    port: cfg.port, hostname: cfg.hostname, payee: cfg.payee, network: cfg.network,
    price: cfg.price, asset: cfg.asset, page: () => page, script: () => donateScript(),
    fetchJson: cfg.fetchJson,
    deliver: (order) => ({
      content: {
        served: new Date().toISOString(),
        order: order.id,
        note: "served because the ledger says your own vault paid us for this order",
        thank_you: "this funds development. every payment out of the vault needs a human thumb too",
      },
      receipt: `paydlux donation ${order.id} — paid by ${order.buyer} in ${order.amount} ${order.asset.code}`,
    }),
  });
  return r;
}
