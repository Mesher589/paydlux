// The public showcase: a page where a stranger watches a real 402 payment
// happen end to end, and can tip the seller if they want to.
//
// Why a separate server instead of more routes on the seller's gateway:
// the gateway is the thing 41 mandate checks and every suite protect. Mounting
// the public in front of it means the gateway code does not change at all —
// this server decides what the internet may touch and delegates the rest.
//
// What a visitor's browser actually does (all of it visible in the page):
//   1. GET /demo/data            -> 402 + x-payment terms. Nothing paid.
//   2. POST /demo/enroll         -> the seller vouches for a throwaway agent
//                                   key the browser made, for a short while.
//   3. GET /demo/data + intent   -> 202. A human now decides on their phone.
//   4. poll /pay/status          -> awaiting_phone, then settled with a tx hash.
//   5. GET /demo/data + intent   -> 200, the payload, and the ledger hash.
//
// The visitor never holds a seller key and never signs a payment. The only
// thing their machine signs is the *request*. The money still needs the
// seller's phone and still counts against the seller's daily budget.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Gateway } from "./gateway.ts";
import { PAY_HEADER } from "./gateway.ts";

export const DEMO_HOST = "demo.paydlux.com";
export const DEMO_ROUTE = "/demo/data";

/** How long an enrolled agent key stays valid, and how many may be live. */
const KEY_TTL_MS = 30 * 60 * 1000;
const MAX_KEYS = 100;
const MAX_KEYS_PER_IP = 5;

/**
 * A short-lived trust decision: "this public key may place payment requests
 * against my gateway until T". It is not a payment authority — a request still
 * needs a human and still hits the spending mandate. Without it a browser
 * cannot produce a valid intent at all, and shipping a fixed agent key inside
 * public JavaScript would put a private key on every visitor's disk.
 */
export class AgentKeyStore {
  private keys = new Map<string, { until: number; ip: string }>();

  constructor(private max = MAX_KEYS, private ttl = KEY_TTL_MS) {}

  private prune(now = Date.now()) {
    for (const [k, v] of this.keys) if (v.until <= now) this.keys.delete(k);
  }

  /** Register a key. Returns null when the request is refused, with a reason. */
  enroll(pub: string, ip: string): { until: number } | null {
    this.prune();
    if (!/^G[A-Z2-7]{55}$/.test(pub ?? "")) return null;
    let mine = 0;
    for (const v of this.keys.values()) if (v.ip === ip) mine++;
    if (mine >= MAX_KEYS_PER_IP) return null;
    if (this.keys.size >= this.max) return null;
    const until = Date.now() + this.ttl;
    this.keys.set(pub, { until, ip });
    return { until };
  }

  /** Public keys the gateway should accept right now. Feed this to agentKeys. */
  live(): string[] {
    this.prune();
    return [...this.keys.keys()];
  }

  get size() { this.prune(); return this.keys.size; }
}

export interface DemoConfig {
  host?: string;
  port: number;
  price: string;
  network: string;
  vault: string;
  explorer: string;
  token: string;
  /** The gateway that owns the routes, the desk and the mandate. */
  gateway: Gateway;
  /**
   * Where a visitor goes to pay for real. Defaults to the public donation door.
   * The showcase is deliberately free — a stranger should not have to fund a
   * wallet to see the loop — but "free forever, no door" is how demos end at
   * zero revenue. One link, one sentence, no popup.
   */
  donateHost?: string;
  /** Called whenever a key is enrolled, so the gateway's accepted set follows. */
  onKeys?: (pubs: string[]) => void;
}

/** The approver app's StrKey/XDR module, read from disk so it stays one file. */
function readXdrJs(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of [["..", "phone-app", "xdr.js"], ["phone-app", "xdr.js"]]) {
    const p = join(here, ...rel);
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  return null;
}

function clientIp(req: IncomingMessage): string {
  // Cloudflare terminates TLS and forwards the real visitor address here.
  const cf = String(req.headers["cf-connecting-ip"] ?? "").split(",")[0].trim();
  if (cf) return cf;
  const xf = String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim();
  return xf || req.socket.remoteAddress || "unknown";
}

/**
 * The payload the seller ships once money has landed. It is deliberately
 * boring and deliberately verifiable: the tx hash is the point, and the
 * visitor can open it on stellar.expert without trusting us.
 */
function demoPayload(cfg: DemoConfig) {
  return JSON.stringify({
    served: new Date().toISOString(),
    note: "served because a human approved this payment and the ledger accepted it",
    vault: cfg.vault,
    network: cfg.network,
    proof: cfg.explorer,
  }, null, 2);
}

/**
 * Serve the showcase in front of a running gateway.
 *
 * The Host pin is not decoration. This port is reachable from the tunnel and
 * from loopback; without the pin, anything that could reach 127.0.0.1 could
 * also ask this server to hand out agent keys. Pinning means the only path in
 * is the hostname Cloudflare routes here.
 */
export function startDemo(cfg: DemoConfig): Promise<Server> {
  const host = (cfg.host ?? DEMO_HOST).toLowerCase();
  const store = new AgentKeyStore();
  const sync = () => cfg.onKeys?.(store.live());

  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const got = String(req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (got !== host) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end(`403 — this showcase only answers on ${host}.`);
      return;
    }
    if (String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "http") {
      res.writeHead(301, { location: `https://${host}${req.url}` });
      res.end();
      return;
    }

    const p = url.pathname;

    if (p === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return; }

    // The page. No inline script: the JS is a separate file so a strict
    // script-src actually means something, and the page interpolates nothing
    // the visitor controls.
    if (p === "/" || p === "/index.html") {
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; " +
          "img-src 'self' data:; connect-src 'self'; base-uri 'none'; " +
          "form-action 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "no-store",
      });
      res.end(demoPage(cfg));
      return;
    }
    if (p === "/demo/demo.js" || p === "/demo/xdr.js") {
      // xdr.js is the SAME file the phone approver runs, and the same one 32
      // xdr-check tests cover. Hand-rolling base32/CRC16 here produced a 57
      // character account id on the first live try — the version byte was
      // counted twice and the checksum was missing, so the gateway's
      // Keypair.fromPublicKey would have rejected every visitor. Reuse the
      // tested encoder instead of writing a second one.
      const body = p.endsWith("xdr.js") ? readXdrJs() : demoScript();
      if (body === null) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }

    // Seller vouches for a throwaway agent key the browser generated.
    if (p === "/demo/enroll" && req.method === "POST") {
      let body = "";
      req.on("data", (c: Buffer) => { if (body.length < 2000) body += c.toString(); });
      await new Promise<void>((r) => req.on("end", () => r()));
      let pub = "";
      try { pub = String(JSON.parse(body)?.pub ?? ""); } catch { /* refused below */ }
      const ok = store.enroll(pub, clientIp(req));
      if (!ok) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "enrollment refused",
          hint: "too many keys from this address, or the showcase is full. Try again later." }));
        return;
      }
      sync();
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, until: ok.until, vault: cfg.vault }));
      return;
    }

    // Everything else belongs to the gateway: the paid route, /pay/status.
    // Only demo paths are exposed here, so pointing the tunnel at this port
    // cannot reach a seller's private routes by guessing a URI.
    if (!(p === DEMO_ROUTE || p === "/pay/status" || p === "/demo/terms")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found", routes: [DEMO_ROUTE] }));
      return;
    }
    if (p === "/demo/terms") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(cfg.gateway.requirements(DEMO_ROUTE), null, 2));
      return;
    }
    // Re-sync the accepted set on every proxied request. Syncing only at
    // enrollment meant an expired vouch stayed live inside the gateway until
    // some *other* visitor enrolled — the expiry clock in AgentKeyStore would
    // have governed nothing. The store is tiny, so this is a map walk.
    sync();
    await cfg.gateway.handler(() => demoPayload(cfg))(req, res);
  });

  return new Promise((resolve) => {
    // Loopback only. The public path is the named tunnel; a 0.0.0.0 bind would
    // put an ungated key-enrollment endpoint on the LAN.
    srv.listen(cfg.port, "127.0.0.1", () => resolve(srv));
  });
}

function demoPage(cfg: DemoConfig) {
  const real = cfg.network === "public";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Paydlux — watch a payment happen</title>
<style>
:root{--bg:#14181a;--ink:#eceae4;--dim:#9aa39d;--gold:#e8b04b;--ok:#5fbf8b;--bad:#d9615c;--line:#2a2f2c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 22px 80px}
h1{font-size:30px;margin:0 0 6px;letter-spacing:-.01em}
.sub{color:var(--dim);margin:0 0 26px}
.warn{border:1px solid var(--line);border-left:3px solid var(--gold);background:#1a1f21;padding:12px 14px;border-radius:8px;margin:0 0 26px;font-size:14.5px}
.steps{border:1px solid var(--line);border-radius:12px;overflow:hidden}
.step{padding:16px 18px;border-bottom:1px solid var(--line)}
.step:last-child{border-bottom:0}
.step h3{margin:0 0 4px;font-size:15px;display:flex;gap:10px;align-items:center}
.step p{margin:0;color:var(--dim);font-size:14.5px}
.n{width:22px;height:22px;border-radius:50%;border:1px solid var(--line);display:inline-flex;align-items:center;justify-content:center;font-size:12px;color:var(--dim);flex:0 0 auto}
.done .n{border-color:var(--ok);color:var(--ok)}
pre{margin:10px 0 0;padding:10px 12px;background:#0f1213;border:1px solid var(--line);border-radius:8px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word;color:#cfd6d0}
button{font:inherit;padding:11px 18px;border-radius:9px;border:1px solid var(--gold);background:var(--gold);color:#1a1408;font-weight:600;cursor:pointer;margin:22px 0 0}
button[disabled]{opacity:.45;cursor:default}
.door{margin:30px 0 0;border:1px solid var(--line);border-left:3px solid var(--gold);background:#1a1f21;border-radius:10px;padding:18px 20px}
.door .q{margin:0 0 6px;font-weight:600}
.door .a{margin:0;color:var(--dim);font-size:15px}
.door .big{display:inline-block;margin:16px 0 10px;padding:12px 20px;border-radius:9px;background:var(--gold);color:#1a1408;font-weight:700;text-decoration:none}
.door .big:hover{filter:brightness(1.08)}
.door .fine{margin:0;color:var(--dim);font-size:13.5px}
.toplink{margin:0 0 20px;font-size:14px}
a{color:var(--gold)}
.foot{margin-top:34px;color:var(--dim);font-size:13.5px;border-top:1px solid var(--line);padding-top:18px}
code{font:13px ui-monospace,monospace;background:#0f1213;padding:1px 5px;border-radius:4px}
</style></head><body><main>
<h1>Watch a payment happen</h1>
<p class="sub">Paydlux is a payment rail for software agents. A program asks for
something, the server answers <code>402 Payment Required</code>, a human approves
on a phone, and the ledger settles it. You are about to drive that loop.</p>
<p class="toplink"><a href="https://${cfg.donateHost ?? "donate.paydlux.com"}/">or skip to paying for real →</a></p>

<div class="warn">${real
  ? "This is <b>mainnet</b>. A tip is real money and cannot be undone. Every payment still needs the seller's phone."
  : "This run is on the <b>Stellar testnet</b> with a practice token, so nothing here costs anything. The mechanics — 402, the human approval, the ledger proof — are the same ones used for real money."}</div>

<div class="steps">
  <div class="step" id="s1"><h3><span class="n">1</span>Ask for the data</h3>
    <p>Your browser sends a plain request. The seller refuses it and states its price.</p>
    <pre id="o1">not run</pre></div>
  <div class="step" id="s2"><h3><span class="n">2</span>Get an agent identity</h3>
    <p>A throwaway signing key is made in this browser and the seller vouches for it for 30 minutes. It can request payments. It cannot pay anything.</p>
    <pre id="o2">not run</pre></div>
  <div class="step" id="s3"><h3><span class="n">3</span>Request the payment</h3>
    <p>The browser signs the request — not the payment — and sends it. The seller parks it for a human.</p>
    <pre id="o3">not run</pre></div>
  <div class="step" id="s4"><h3><span class="n">4</span>A human decides</h3>
    <p>The seller sees the exact payment on their phone and holds for 1.2 seconds to approve. Nothing here can skip that.</p>
    <pre id="o4">not run</pre></div>
  <div class="step" id="s5"><h3><span class="n">5</span>The ledger proves it</h3>
    <p>Same request, now served. The transaction hash is public and verifiable without trusting this page.</p>
    <pre id="o5">not run</pre></div>
</div>

<button id="go">Run the loop</button>

<div class="door">
  <p class="q">That was practice. Nothing you just did cost anything.</p>
  <p class="a">Your first <em>real</em> agent payment can be a donation to us —
  same 402, same two signatures, same ledger proof, but the money is real and it
  buys the thing this project needs: an always-on machine instead of a laptop.</p>
  <a class="big" href="https://${cfg.donateHost ?? "donate.paydlux.com"}/">Pay a human-approved donation →</a>
  <p class="fine">It draws on <em>your</em> vault and your phone signs it. We never hold your key,
  and you can watch our own vault pay out on the public ledger.</p>
</div>

<p class="foot">Vault <code>${cfg.vault}</code> · token <code>${cfg.token}</code> ·
network <code>${cfg.network}</code> · <a href="${cfg.explorer}" rel="noopener">open the vault on the explorer</a><br>
Every payment is capped by the seller's own mandate: at most ${cfg.price} ${cfg.token} per request,
and the day's total is enforced before the request is ever accepted.</p>
</main><script src="/demo/xdr.js"></script><script src="/demo/demo.js"></script></body></html>`;
}

/**
 * The visitor's side. Kept in its own file so `script-src 'self'` is a real
 * restriction rather than a comment, and so the signing code is readable —
 * anyone can open this and see that it signs requests, never payments.
 */
function demoScript() {
  return `(() => {
  const ROUTE = "/demo/data";
  const el = (id) => document.getElementById(id);
  const say = (n, txt) => { el("o" + n).textContent = txt; el("s" + n).classList.add("done"); };
  const PAY = "x-payment";

  async function main() {
    const btn = el("go"); btn.disabled = true;

    // 1 — the 402 handshake. No payment, no key, just a normal GET.
    let terms;
    try {
      const r = await fetch(ROUTE, { cache: "no-store" });
      terms = JSON.parse(r.headers.get(PAY) || "null");
      say(1, "HTTP " + r.status + "\\n" + JSON.stringify(terms, null, 2));
      if (r.status !== 402) { say(1, "HTTP " + r.status + " — this showcase is not asking for payment right now"); return; }
    } catch (e) { say(1, "request failed: " + e); return; }

    // 2 — a signing key that never leaves this browser.
    let pair;
    try {
      // extractable only for the PUBLIC half's raw bytes; the private half is
      // never exported, and the key is dropped when the tab closes.
      pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    }
    catch (e) { say(2, "this browser cannot make Ed25519 keys (needs Chrome 113+, Safari 17+, Firefox 133+).\\n" + e); return; }
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    const X = window.PaydluxXdr;
    if (!X) { say(2, "the address encoder failed to load"); return; }
    const pub = X.encodeAccountEd25519(new Uint8Array(raw));
    const enr = await (await fetch("/demo/enroll", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pub }),
    })).json();
    if (!enr.ok) { say(2, "seller refused to vouch for this key: " + enr.error); return; }
    say(2, "agent key (Stellar account form)\\n" + pub + "\\nvouched until " + new Date(enr.until).toLocaleTimeString());

    // 3 — sign the REQUEST. The payload names the url, the price and the vault,
    // so this signature is worthless for anything else.
    const intent = await buildIntent(pair, terms);
    const parked = await (await fetch(ROUTE, {
      headers: { [PAY]: JSON.stringify({ intent }) }, cache: "no-store",
    })).json();
    say(3, "HTTP 202 — parked as " + (parked.handle || "?") + "\\n" + (parked.reason || ""));

    // 4 — wait for a person. The page polls the seller's own status route.
    say(4, "waiting for the seller's phone…");
    const seen = await poll(parked.statusUrl);
    say(4, "status: " + seen.status + (seen.reason ? "\\n" + seen.reason : ""));
    if (seen.status !== "settled" && seen.status !== "paid") { btn.disabled = false; return; }

    // 5 — same request, now paid. The seller ships the payload plus the hash.
    const paid = await fetch(ROUTE, { headers: { [PAY]: JSON.stringify({ intent }) }, cache: "no-store" });
    const body = await paid.json();
    say(5, "HTTP " + paid.status + "\\n" + JSON.stringify(body, null, 2)
      + (body.tx ? "\\n\\nverify it yourself:\\nhttps://stellar.expert/explorer/"
        + (terms.network || "testnet").replace("stellar:", "") + "/transaction/" + body.tx : ""));
  }

  async function buildIntent(pair, t) {
    const payload = [location.origin + ROUTE, t.maxAmountRequired, t.vault, Date.now()].join("|");
    const sig = await crypto.subtle.sign("Ed25519", pair.privateKey, new TextEncoder().encode(payload));
    return { payload, signature: btoa(String.fromCharCode(...new Uint8Array(sig))) };
  }

  async function poll(u) {
    for (let i = 0; i < 150; i++) {
      const j = await (await fetch(u, { cache: "no-store" })).json();
      if (j.status && j.status !== "pending" && j.status !== "awaiting_phone") return j;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { status: "timed out waiting for a human" };
  }

  el("go").addEventListener("click", main);
})();`;
}
