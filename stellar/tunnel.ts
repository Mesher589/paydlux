// The named Cloudflare tunnel: real TLS on a domain you control.
//
// A trycloudflare.com URL (story.ts --public) is fine for a demo clip and wrong
// for anything else: the hostname is random and disposable, there is no HSTS,
// and nothing tells the human they reached *your* desk. A named tunnel gives
// https://desk.paydlux.com — same free tier, but the human's browser can verify
// where it is, and the desk can pin the Host header so the local port cannot be
// driven directly.
//
// One-time setup, already done on this machine:
//   cloudflared tunnel login
//   cloudflared tunnel create paydlux-desk
//   cloudflared tunnel route dns paydlux-desk desk.paydlux.com
//
// The tunnel's credentials live in ~/.cloudflared/<tunnel-id>.json. They are NOT
// in this repo and must never be. Anyone holding that file can serve your
// hostname. Losing it means deleting the tunnel and making a new one.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const TUNNEL_NAME = "paydlux-desk";
export const PUBLIC_HOST = "desk.paydlux.com";

/** True if this machine can run the named tunnel. */
export function tunnelReady(): boolean {
  const dir = join(homedir(), ".cloudflared");
  if (!existsSync(join(dir, "cert.pem"))) return false;
  if (!existsSync(join(dir, "config.yml"))) return false;
  return readdirSync(dir).some((f) => /^[0-9a-f-]{36}\.json$/.test(f));
}

/**
 * Start the named tunnel and make sure it dies with us. An orphaned cloudflared
 * is a public approval desk with nobody watching it, so every exit path kills
 * the child.
 */
export function runTunnel(): ChildProcess {
  const cf = spawn("cloudflared", ["tunnel", "run", TUNNEL_NAME],
    { stdio: ["ignore", "pipe", "pipe"] });
  const close = () => { if (!cf.killed) cf.kill("SIGTERM"); };
  process.on("exit", close);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { close(); process.exit(0); });
  }
  return cf;
}

/** Is the tunnel actually serving TLS yet? Probes the real URL. */
export async function tunnelLive(host = PUBLIC_HOST, tries = 12): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`https://${host}/healthz`);
      if (res.ok || res.status === 403) return true;   // 403 = desk answered, TLS works
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}
