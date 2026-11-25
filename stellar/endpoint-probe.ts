// check.paydlux.com core: probe a candidate 402 endpoint SAFELY and parse its terms.
// Discipline (same as the phone signer): refuse everything we cannot fully parse; pin the
// validated IP; never follow redirects; injectable resolve+transport so tests never touch
// the real network unless a check says LIVE.
import dns from "node:dns/promises";
import net from "node:net";
import https from "node:https";
import http from "node:http";
import { URL } from "node:url";

export type Resolver = (host: string) => Promise<string[]>;
export type Transport = (o: { ip: string; host: string; path: string; https: boolean; timeoutMs: number })
  => Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string } | "timeout">;

export type ProbeSecurity = { resolvedIp: string | null; privateTargetRefused: boolean };

export type ProbeTerms = {
  headerName: string;
  payTo: string | null;
  assetCode: string | null;
  assetIssuer: string | null;
  maxAmountParts: string;
  network: string | null;
  scheme: string | null;
  unparsedKeys: string[];
};

export type ProbeResult =
  | { verdict: "PAYABLE"; security: ProbeSecurity; terms: ProbeTerms }
  | { verdict: "NOT_PAYABLE"; reason: string; security: ProbeSecurity }
  | { verdict: "REFUSED"; reason: string; security: ProbeSecurity };

export function isPrivateIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (v === 6) {
    const s = ip.toLowerCase();
    return s === "::1" || s === "::" || s.startsWith("fe8") || s.startsWith("fc") || s.startsWith("fd")
      || s.startsWith("ff") || (s.startsWith("::ffff:") && isPrivateIp(s.slice(7)));
  }
  return true;
}

const CAP = 1_048_576, TIMEOUT = 8_000;
const PAY_HEADERS = ["x-payment", "x-payment-required", "x-payment-requirements", "x-payment-tokens", "payment"];

export function parsePayHeader(raw: string): Omit<ProbeTerms, "headerName"> | null {
  let j: any;
  try { j = JSON.parse(raw); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const acc = Array.isArray(j.accepted) && j.accepted.length ? j.accepted[0] : j;   // x402 batch or single
  const asset = acc.asset ?? acc.token ?? j.asset ?? j.token;
  const known = new Set(["scheme", "schemeId", "network", "maxAmountRequired", "max_amount", "minAmount",
    "payTo", "pay_to", "asset", "token", "accepted", "resource", "mimeType", "maxTimeSeconds",
    "maxTimeoutSeconds", "version", "x402Version", "extra", "memo", "order", "mode", "note"]);
  const code = typeof asset === "object" && asset ? asset.code ?? null : typeof asset === "string" ? (asset.includes(":") ? asset.split(":")[0] : asset) : null;
  const issuer = typeof asset === "object" && asset ? asset.issuer ?? null : typeof asset === "string" && asset.includes(":") ? asset.split(":")[1] : null;
  const amt = acc.maxAmountRequired ?? acc.max_amount ?? j.maxAmountRequired ?? j.minAmount;
  if (code == null || amt == null || !(acc.payTo ?? acc.pay_to ?? j.payTo)) return null; // half-parsed → refuse to vouch
  return { payTo: String(acc.payTo ?? acc.pay_to ?? j.payTo),
    assetCode: String(code), assetIssuer: issuer == null ? null : String(issuer),
    maxAmountParts: String(amt), network: acc.network ? String(acc.network) : j.network ? String(j.network) : null,
    scheme: acc.scheme ? String(acc.scheme) : acc.schemeId ? String(acc.schemeId) : j.scheme ? String(j.scheme) : null,
    unparsedKeys: Object.keys(j).filter(k => !known.has(k)),
  };
}

const defaultTransport: Transport = (o) => new Promise((res, rej) => {
  const mod = o.https ? https : http;
  const req = mod.request({
    hostname: o.ip, port: o.https ? 443 : 80, path: o.path, method: "GET",
    servername: o.host, headers: { host: o.host, accept: "application/json" }, timeout: o.timeoutMs,
  }, (r) => {
    let buf = "", over = false;
    r.on("data", (c) => { buf += c; if (buf.length > CAP) { over = true; r.destroy(); } });
    r.on("end", () => res({ status: r.statusCode ?? 0, headers: r.headers, text: over ? "" : buf }));
  });
  req.on("timeout", () => { req.destroy(); res("timeout"); });
  req.on("error", rej);
  req.end();
});

export async function probeEndpoint(
  url: string,
  opts: { resolve?: Resolver; transport?: Transport } = {},
): Promise<ProbeResult> {
  const sec: ProbeSecurity = { resolvedIp: null, privateTargetRefused: false };
  let u: URL;
  try { u = new URL(url); } catch { return { verdict: "REFUSED", reason: "not a valid URL", security: sec }; }
  if (u.protocol !== "https:" && u.protocol !== "http:")
    return { verdict: "REFUSED", reason: "only http(s) schemes", security: sec };

  let ip: string;
  const host = u.hostname.replace(/^\[|\]$/g, ""); // WHATWG keeps brackets on IPv6 hosts
  if (net.isIP(host)) ip = host;
  else {
    let addrs: string[];
    try { addrs = await (opts.resolve ?? dns.resolve)(host); }
    catch { return { verdict: "REFUSED", reason: "DNS resolution failed", security: sec }; }
    if (!addrs.length) return { verdict: "REFUSED", reason: "no DNS records", security: sec };
    if (addrs.some(isPrivateIp))
      return { verdict: "REFUSED", reason: "hostname resolves to a private/internal address", security: { ...sec, privateTargetRefused: true } };
    ip = addrs[0];
  }
  if (isPrivateIp(ip))
    return { verdict: "REFUSED", reason: "target address is private/internal", security: { ...sec, privateTargetRefused: true } };
  sec.resolvedIp = ip;

  let body: Awaited<ReturnType<Transport>>;
  try { body = await (opts.transport ?? defaultTransport)({ ip, host: u.host, path: u.pathname + u.search, https: u.protocol === "https:", timeoutMs: TIMEOUT }); }
  catch (e) { return { verdict: "NOT_PAYABLE", reason: "connection error: " + String(e), security: sec }; }
  if (body === "timeout") return { verdict: "REFUSED", reason: "8s timeout", security: sec };

  if (body.status >= 300 && body.status < 400)
    return { verdict: "REFUSED", reason: "server sent a redirect — we do not follow redirects", security: sec };
  if (body.status !== 402)
    return { verdict: "NOT_PAYABLE", reason: `server answered ${body.status || "no response"}, not 402 Payment Required`, security: sec };

  const hdr = PAY_HEADERS.find(h => body.headers[h] !== undefined);
  if (!hdr)
    return { verdict: "NOT_PAYABLE", reason: "answered 402 but carries no payment-terms header we know", security: sec };
  const terms = parsePayHeader(String(body.headers[hdr]));
  if (!terms)
    return { verdict: "NOT_PAYABLE", reason: `answered 402 with ${hdr}, but its terms do not fully parse — we refuse to vouch for what we cannot read`, security: sec };
  return { verdict: "PAYABLE", security: sec, terms: { ...terms, headerName: hdr } };
}
