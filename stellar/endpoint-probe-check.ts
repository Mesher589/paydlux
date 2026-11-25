// endpoint-probe-check.ts — the guard rails for check.paydlux.com's core.
// Every stubbed test asserts the stub actually ran (sentinel) or did NOT run (refusals).
// Run: npx tsx stellar/endpoint-probe-check.ts
import { probeEndpoint, parsePayHeader, isPrivateIp, type Transport } from "./endpoint-probe.js";

let pass = 0, fail = 0;
const ok = (cond: boolean, name: string, detail = "") => {
  if (cond) { pass++; console.log("  ok  " + name); }
  else { fail++; console.log("  FAIL " + name + (detail ? " — " + detail : "")); }
};

const paydluxTerms = JSON.stringify({
  scheme: "stellar-exact", network: "stellar:public", maxAmountRequired: "1",
  payTo: "GVAULTTEST0000000000000000000000000000000000000000000000000",
  token: { code: "XLM", issuer: null }, mode: "buyer-escrow", version: "1",
});
const x402Terms = JSON.stringify({
  x402Version: 1,
  accepted: [{ scheme: "x402-stellar", network: "stellar:testnet", maxAmountRequired: "0.01",
    payTo: "GPAYEE0000000000000000000000000000000000000000000000000000",
    asset: { code: "USDC", issuer: "GISSUER000000000000000000000000000000000000000000000000000" } }],
});

const stubTransport = (status: number, headers: Record<string, string>, text = "") => {
  const t: Transport & { calls: number } = Object.assign(async () => { t.calls++; return { status, headers, text }; }, { calls: 0 });
  return t;
};

const main = async () => {
  console.log("IP refusals (must never connect):");
  for (const [url, why] of [
    ["http://127.0.0.1:8080/x", "loopback"],
    ["http://169.254.169.254/latest/meta-data/", "cloud metadata"],
    ["http://10.0.0.5/", "RFC1918"],
    ["http://[::1]/", "IPv6 loopback"],
  ] as const) {
    const t = stubTransport(402, {});
    const r = await probeEndpoint(url, { transport: t });
    ok(r.verdict === "REFUSED" && r.security.privateTargetRefused && t.calls === 0, `refused before connect: ${why}`);
  }
  {
    const t = stubTransport(402, {});
    const r = await probeEndpoint("https://anything.example", { resolve: async () => ["192.168.1.1"], transport: t });
    ok(r.verdict === "REFUSED" && t.calls === 0, "refused: hostname resolves private");
  }
  {
    const t = stubTransport(402, {});
    const r = await probeEndpoint("file:///etc/passwd", { transport: t });
    ok(r.verdict === "REFUSED" && t.calls === 0, "refused: non-http scheme");
  }

  console.log("stubbed network behaviour (stub must run):");
  {
    const t = stubTransport(200, {});
    const r = await probeEndpoint("https://example.com", { resolve: async () => ["93.184.216.34"], transport: t });
    ok(r.verdict === "NOT_PAYABLE" && "reason" in r && r.reason.includes("200") && t.calls === 1, "200 → not payable, stub ran");
  }
  {
    const t = stubTransport(301, { location: "http://127.0.0.1/" });
    const r = await probeEndpoint("https://example.com", { resolve: async () => ["93.184.216.34"], transport: t });
    ok(r.verdict === "REFUSED" && r.reason.includes("redirect"), "301 → refused, not followed");
  }
  {
    const t = stubTransport(402, { "x-payment": paydluxTerms });
    const r = await probeEndpoint("https://door.example", { resolve: async () => ["93.184.216.34"], transport: t });
    ok(r.verdict === "PAYABLE" && r.terms.payTo === "GVAULTTEST0000000000000000000000000000000000000000000000000"
      && r.terms.assetCode === "XLM" && r.terms.assetIssuer === null && r.terms.headerName === "x-payment", "paydlux door shape → PAYABLE, native asset parses with issuer null");
  }
  {
    const t = stubTransport(402, { "x-payment": x402Terms });
    const r = await probeEndpoint("https://door.example", { resolve: async () => ["93.184.216.34"], transport: t });
    ok(r.verdict === "PAYABLE" && r.terms.assetCode === "USDC" && r.terms.assetIssuer === "GISSUER000000000000000000000000000000000000000000000000000"
      && r.terms.maxAmountParts === "0.01", "x402 accepted[] shape → PAYABLE, issuer captured");
  }
  {
    const t = stubTransport(402, { "x-payment": "{not json" });
    const r = await probeEndpoint("https://door.example", { resolve: async () => ["93.184.216.34"], transport: t });
    ok(r.verdict === "NOT_PAYABLE" && r.reason.includes("refuse"), "unparseable 402 terms → refuses to vouch");
  }
  {
    const p = parsePayHeader(JSON.stringify({ payTo: "GX", scheme: "s" }));
    ok(p === null, "missing amount+asset → half-parsed counts as unparsed");
  }
  ok(isPrivateIp("100.64.0.1") && isPrivateIp("172.16.0.1") && !isPrivateIp("172.32.0.1"), "CGNAT/172.16 boundaries");

  console.log("LIVE: the first endpoint check.paydlux.com certifies is our own door");
  {
    const r = await probeEndpoint("https://donate.paydlux.com/donate");
    const live = r.verdict === "PAYABLE";
    ok(live, "donate.paydlux.com answers PAYABLE over the real internet", JSON.stringify(r).slice(0, 200));
    if (live) {
      ok(r.terms.payTo === "GCJGF6DYZXC3MAYXWFFSJNVGSQYNYERRFPQKC4X24WNWHPQKZNUYVWUB", "live terms pay to the real mainnet vault");
      ok(r.terms.network === "stellar:public" && r.terms.assetCode === "XLM" && r.terms.assetIssuer === null, "live terms: stellar:public, native XLM, no issuer");
      console.log("    live terms:", JSON.stringify(r.terms));
    }
  }

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail) process.exit(1);
};
main().catch((e) => { console.error("crashed", e); process.exit(1); });
