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

/**
 * Where cloudflared actually is. A GUI-launched or login-shell PATH often lacks
 * /opt/homebrew/bin, and spawn() then dies with "spawn cloudflared ENOENT" — an
 * unhandled ChildProcess error that takes the whole story down with a stack
 * trace. Resolve the absolute path instead of trusting PATH.
 */
const CANDIDATES = [
  "/opt/homebrew/bin/cloudflared",          // Apple Silicon Homebrew
  "/usr/local/bin/cloudflared",             // Intel Homebrew
  "/usr/bin/cloudflared",
  join(homedir(), ".local/bin/cloudflared"),
];

export function cloudflaredPath(): string | null {
  // PATH first, so an explicit choice (or a version manager) wins.
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const p = join(dir, "cloudflared");
    if (existsSync(p)) return p;
  }
  for (const p of CANDIDATES) if (existsSync(p)) return p;
  return null;
}

export const TUNNEL_NAME = "paydlux-desk";
export const PUBLIC_HOST = "desk.paydlux.com";

/** Why this machine cannot run the named tunnel, or null if it can. */
export function tunnelProblem(): string | null {
  if (!cloudflaredPath()) {
    return "cloudflared is not installed, or not on PATH. " +
      "Install with: brew install cloudflared";
  }
  const dir = join(homedir(), ".cloudflared");
  if (!existsSync(join(dir, "cert.pem"))) {
    return "no Cloudflare login on this machine. Run: cloudflared tunnel login";
  }
  if (!existsSync(join(dir, "config.yml"))) {
    return "no ~/.cloudflared/config.yml — the tunnel needs ingress to 127.0.0.1";
  }
  if (!readdirSync(dir).some((f) => /^[0-9a-f-]{36}\.json$/.test(f))) {
    return "no tunnel credentials in ~/.cloudflared/. Run: cloudflared tunnel create " + TUNNEL_NAME;
  }
  return null;
}

/** True if this machine can run the named tunnel. */
export function tunnelReady(): boolean { return tunnelProblem() === null; }

/**
 * Start the named tunnel and make sure it dies with us. An orphaned cloudflared
 * is a public approval desk with nobody watching it, so every exit path kills
 * the child.
 */
export interface Tunnel {
  proc: ChildProcess;
  /** Why cloudflared failed to start or run, if it did. */
  lastError(): string | null;
}

export function runTunnel(): Tunnel {
  const bin = cloudflaredPath();
  if (!bin) throw new Error("cloudflared not found — brew install cloudflared");
  const cf = spawn(bin, ["tunnel", "run", TUNNEL_NAME],
    { stdio: ["ignore", "pipe", "pipe"] });
  // Without this handler a spawn failure is an UNHANDLED 'error' event that
  // crashes the process with a stack trace, after the story already funded
  // accounts and printed a portal link. Capture it and report it plainly.
  let failure: string | null = null;
  cf.on("error", (e) => { failure = e.message; });
  cf.stderr?.on("data", (b: Buffer) => {
    const line = b.toString().trim();
    // cloudflared logs config errors to stderr; keep the last useful one.
    if (line && /error|ERR|not found|invalid/i.test(line)) failure = line.slice(0, 300);
  });
  const close = () => { if (!cf.killed) cf.kill("SIGTERM"); };
  process.on("exit", close);
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { close(); process.exit(0); });
  }
  return { proc: cf, lastError: () => failure };
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
