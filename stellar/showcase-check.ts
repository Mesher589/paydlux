// Checks for the public showcase. Run with: npx tsx stellar/showcase-check.ts
//
// The showcase is the first Paydlux surface a stranger touches, so these
// assert the *boundaries* rather than the happy path: what a visitor may ask
// for, how long a vouched key lives, and what happens when the Host header is
// wrong.
import { AgentKeyStore, startDemo, DEMO_ROUTE, DEMO_HOST } from "./showcase";
import { Gateway } from "./gateway";
import { PolicyEngine } from "./policy";
import { Keypair } from "@stellar/stellar-sdk";
import { readFileSync } from "node:fs";
import { request } from "node:http";

let pass = 0, fail = 0;
function ok(cond: unknown, what: string) {
  if (cond) { pass++; console.log("  \x1b[32m✅\x1b[0m " + what); }
  else { fail++; console.log("  \x1b[31m❌\x1b[0m " + what); }
}

async function main() {
  console.log("\n\x1b[1mshowcase: the public surface\x1b[0m\n");

  // ---- 1. the key store is a bounded trust decision ------------------------
  const store = new AgentKeyStore(3, 60_000);
  const k1 = Keypair.random().publicKey(), k2 = Keypair.random().publicKey();
  ok(store.enroll(k1, "9.9.9.1"), "a well-formed account id is accepted");
  ok(store.enroll(k2, "9.9.9.2"), "a second address is accepted");
  ok(store.enroll("not-a-key", "9.9.9.3") === null, "a malformed account id is refused");
  ok(store.enroll("", "9.9.9.3") === null, "an empty key is refused");
  // Same address cannot mint its way past the cap.
  let sameIp = 0;
  for (let i = 0; i < 10; i++) if (store.enroll(Keypair.random().publicKey(), "9.9.9.9")) sameIp++;
  ok(sameIp <= 5, `one address gets at most 5 keys (got ${sameIp})`);
  ok(store.size <= 3 + 5, `the store stays capped (${store.size})`);
  ok(store.live().includes(k1), "live() reports the accepted key");

  // A key must expire. A permanent vouch is a key on the internet forever.
  const short = new AgentKeyStore(10, 30);
  const temp = Keypair.random().publicKey();
  short.enroll(temp, "9.9.9.5");
  ok(short.live().includes(temp), "a fresh key is live");
  await new Promise((r) => setTimeout(r, 60));
  ok(!short.live().includes(temp), "the vouch expires on its own");

  // ---- 2. the address the browser produces is a real Stellar account id ----
  // The first live try produced a 57-character id: the version byte was counted
  // twice and the CRC16 checksum was missing. Keypair.fromPublicKey is what
  // rejects it, so that is the check.
  const xdrSrc = readFileSync(new URL("../phone-app/xdr.js", import.meta.url), "utf8");
  ok(/encodeAccountEd25519/.test(xdrSrc), "the showcase reuses the approver app's encoder");
  const probe = Keypair.random();
  const raw = Keypair.fromPublicKey(probe.publicKey()).rawPublicKey();
  const roundTrip = (() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = readFileSync(new URL("../phone-app/xdr.js", import.meta.url), "utf8");
    const g: any = {};
    new Function("globalThis", mod).call(g, g);
    return g.PaydluxXdr.encodeAccountEd25519(raw);
  })();
  ok(roundTrip === probe.publicKey(), "encoder round-trips a real key (56 chars, checksummed)");
  let sdkOk = false;
  try { Keypair.fromPublicKey(roundTrip); sdkOk = true; } catch { /* the check below reports it */ }
  ok(sdkOk, "the SDK accepts the encoded id");

  // ---- 3. the server refuses the wrong Host and the wrong path -------------
  const vault = Keypair.random().publicKey();
  const gw = new Gateway({
    vault: { address: vault, network: "testnet", token: { getCode: () => "AGPAY", getIssuer: () => vault } } as any,
    network: "testnet", payee: Keypair.random().publicKey(), deskPort: 0,
    principal: Keypair.random().secret(), split: true, portalKey: "x",
    agentKeys: [], routes: [{ uri: DEMO_ROUTE, price: "4.50", mode: "approval", holdSeconds: 3600 }],
    policy: new PolicyEngine({ maxPerPayment: 10, dailyBudget: 50 }),
  });
  const port = 4199;
  let handed: string[] = [];
  const srv = await startDemo({
    port, price: "4.50", network: "testnet", vault, token: "AGPAY",
    explorer: "https://stellar.expert", gateway: gw, route: DEMO_ROUTE,
    onKeys: (pubs) => { handed = pubs; gw.agentKeys = pubs; },
  });
  // node:http, not fetch: fetch refuses to set Host (it is a forbidden header
  // name), so a fetch-based probe silently sends the loopback host and every
  // Host-pinning assertion below would "pass" for the wrong reason.
  const at = (path: string, host: string) => new Promise<{ status: number; body: string; headers: Record<string, string> }>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET", headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c: Buffer) => (body += c.toString()));
      res.on("end", () => resolve({
        status: res.statusCode ?? 0, body,
        headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])),
      }));
    });
    req.end();
  });

  ok((await at("/", "evil.example")).status === 403, "a request with the wrong Host is refused");
  ok((await at("/", DEMO_HOST)).status === 200, "the page answers on its own hostname");
  ok((await at("/market/data", DEMO_HOST)).status === 404, "a seller's private route is not reachable through the showcase");
  ok((await at("/queue", DEMO_HOST)).status === 404, "the approval queue is not reachable through the showcase");
  ok((await at("/phone/", DEMO_HOST)).status === 404, "the approver app is not reachable through the showcase");
  const terms = await at(DEMO_ROUTE, DEMO_HOST);
  ok(terms.status === 402, "the demo route still demands payment");
  ok(/maxAmountRequired/.test(terms.headers["x-payment"] ?? ""), "the 402 carries the payment terms");
  const pageRes = await at("/", DEMO_HOST);
  ok(!/<script>[^<]/.test(pageRes.body), "no inline script, so script-src 'self' holds");
  ok(/script-src 'self'/.test(pageRes.headers["content-security-policy"] ?? ""),
    "the page pins script-src to its own origin");
  ok(/testnet/i.test(pageRes.body), "the page says plainly which network this is");
  ok(/A human decides — and it isn't you/.test(pageRes.body),
    "step 4 says plainly that the seller's phone signs, not the visitor");

  // ---- 3b. "has this ever actually happened?" -----------------------------
  // A visitor on their own laptop cannot finish step 4 — only the seller's
  // phone can sign it — so the page offers the last payment THIS route settled.
  // It must answer, and it must leak nothing but a hash the ledger already
  // makes public.
  const none = await at("/demo/last", DEMO_HOST);
  ok(none.status === 200 && /"none":\s*true/.test(none.body), "/demo/last is empty before anything settles");
  gw.desk.enqueue("/market/private", "9.00", "secret body", "secret content", "k-priv");
  gw.desk.list().forEach((r) => { r.status = "settled"; r.tx = "PRIVATEHASH"; });
  ok(!/PRIVATEHASH/.test((await at("/demo/last", DEMO_HOST)).body),
    "/demo/last never shows a settled payment from a route other than the showcase's");
  gw.desk.enqueue(DEMO_ROUTE, "4.50", "b", "c", "k-demo");
  gw.desk.list().forEach((r) => { if (r.uri === DEMO_ROUTE) { r.status = "settled"; r.tx = "DEMOHASH123"; } });
  const last = await at("/demo/last", DEMO_HOST);
  ok(/DEMOHASH123/.test(last.body), "/demo/last hands over the settled demo payment");
  ok(!/secret|PRIVATEHASH/.test(last.body), "/demo/last leaks no body, buyer or other-route hash");
  // ---- 4. an expired vouch stops being accepted ---------------------------
  // Syncing only when a key is enrolled left expired keys live inside the
  // gateway until an unrelated visitor showed up. The expiry clock has to
  // actually govern what the gateway accepts.
  const live = Keypair.random().publicKey();
  const store2 = new AgentKeyStore(10, 40);
  store2.enroll(live, "9.9.9.20");
  gw.agentKeys = store2.live();
  ok(gw.agentKeys.includes(live), "a fresh vouch reaches the gateway");
  await new Promise((r2) => setTimeout(r2, 80));
  await at(DEMO_ROUTE, DEMO_HOST);            // any proxied request re-syncs
  ok(!gw.agentKeys.includes(live), "an expired vouch is dropped from the gateway on the next request");
  ok(handed.length === 0, "nothing is left accepted after expiry");
  srv.close();

  console.log(`\n${fail ? "\x1b[31m" : "\x1b[32m"}${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
}
main();
