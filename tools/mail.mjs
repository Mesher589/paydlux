#!/usr/bin/env node
/*
 * Paydlux mailbox client — Zoho Mail REST API.
 *
 * Why not IMAP: Zoho's free plan does not include IMAP/POP/ActiveSync. It does
 * include the REST API, so this talks OAuth to mail.zoho.eu instead. No paid
 * plan, no card.
 *
 * Secrets live in ~/.hermes/secrets/ (0600) and are never printed.
 *   zoho-client-id.key      the Self Client client_id
 *   zoho-client-secret.key  the Self Client client_secret
 *   zoho-refresh-token.key  the long-lived refresh token (obtained once)
 *
 * Usage:
 *   node tools/mail.mjs exchange <code>     one-time: code -> refresh token
 *   node tools/mail.mjs accounts            list mailboxes + accountId
 *   node tools/mail.mjs inbox [n]           newest n messages (default 15)
 *   node tools/mail.mjs read <messageId>    full body of one message
 *   node tools/mail.mjs search <text>       search the inbox
 *   node tools/mail.mjs draft --to x --subject y --body z
 *   node tools/mail.mjs send  --to x --subject y --body z   (needs --yes)
 */

import { readFileSync, existsSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGION = process.env.ZOHO_REGION || "eu";
const ACCOUNTS_HOST = `https://accounts.zoho.${REGION}`;
const API = `https://mail.zoho.${REGION}/api`;
const SECRET_DIR = join(homedir(), ".hermes", "secrets");

const secret = (name) => {
  const p = join(SECRET_DIR, name);
  if (!existsSync(p)) return null;
  return readFileSync(p, "utf8").trim();
};

const need = (name) => {
  const v = secret(name);
  if (!v) {
    console.error(`missing ${SECRET_DIR}/${name}`);
    console.error("see: node tools/mail.mjs help");
    process.exit(2);
  }
  return v;
};

async function accessToken() {
  const r = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: need("zoho-refresh-token.key"),
      client_id: need("zoho-client-id.key"),
      client_secret: need("zoho-client-secret.key"),
    }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(`token refresh failed: ${JSON.stringify(j)}`);
  return j.access_token;
}

async function api(path, opts = {}) {
  const tok = await accessToken();
  const r = await fetch(API + path, {
    ...opts,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Zoho-oauthtoken ${tok}`,
      ...(opts.headers || {}),
    },
  });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  if (!r.ok || (j.status && j.status !== "ok")) {
    throw new Error(`${r.status} ${path}: ${text.slice(0, 400)}`);
  }
  return j.data ?? j;
}

async function accountId() {
  const cached = secret("zoho-account-id.key");
  if (cached) return cached;
  const data = await api("/accounts");
  const list = Array.isArray(data) ? data : [data];
  const id = String(list[0].accountId);
  mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(join(SECRET_DIR, "zoho-account-id.key"), id);
  chmodSync(join(SECRET_DIR, "zoho-account-id.key"), 0o600);
  return id;
}

const flags = (argv) => {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const k = argv[i].slice(2);
      if (k === "yes") { out.yes = true; continue; }
      out[k] = argv[++i];
    }
  }
  return out;
};

const strip = (html) =>
  html.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n")
     .replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
     .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<")
     .replace(/&gt;/g, ">").replace(/\n{3,}/g, "\n\n").trim();

const HELP = `Zoho Mail over the REST API (works on the free plan; IMAP does not).

  exchange <code>            one-time: paste the code from Zoho's Self Client
  accounts                   list mailboxes on the account
  inbox [n]                  newest n messages (default 15)
  read <messageId>           full body of one message
  search <text>              search the inbox
  draft --to --subject --body
  send  --to --subject --body --yes

Secrets (0600, in ~/.hermes/secrets/): zoho-client-id.key, zoho-client-secret.key,
zoho-refresh-token.key. Create the client at https://api-console.zoho.eu
(Add Client -> Self Client) with scopes:
  ZohoMail.messages.READ,ZohoMail.messages.CREATE,ZohoMail.accounts.READ`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === "exchange") {
    const j = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: rest[0],
        client_id: need("zoho-client-id.key"),
        client_secret: need("zoho-client-secret.key"),
      }),
    }).then((r) => r.json());
    if (!j.refresh_token) throw new Error(`exchange failed: ${JSON.stringify(j)}`);
    mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(join(SECRET_DIR, "zoho-refresh-token.key"), j.refresh_token);
    chmodSync(join(SECRET_DIR, "zoho-refresh-token.key"), 0o600);
    console.log("refresh token stored. never printed, never shared.");
    return;
  }

  if (cmd === "accounts") {
    const data = await api("/accounts");
    for (const a of (Array.isArray(data) ? data : [data])) {
      console.log(`${a.accountId}  ${a.addressFrom?.join(", ") || a.name}  (default=${a.isDefault})`);
    }
    return;
  }

  const id = await accountId();

  if (cmd === "inbox") {
    const n = Number(rest[0] || 15);
    const data = await api(`/accounts/${id}/messages?folderId=Inbox&start=0&limit=${n}`);
    const list = Array.isArray(data) ? data : (data?.messages || []);
    if (!list.length) { console.log("(inbox empty)"); return; }
    for (const m of list) {
      const from = (m.fromAddress || m.from || []).map((f) => f.address || f).join(",");
      const when = m.date ? new Date(Number(m.date)).toISOString().slice(0, 16) : "";
      console.log(`${m.messageId}  ${when}  ${from}\n    ${m.subject || "(no subject)"}`);
    }
    console.log(`\n${list.length} message(s). read one: node tools/mail.mjs read <id>`);
    return;
  }

  if (cmd === "read") {
    const data = await api(`/accounts/${id}/messages/${rest[0]}`);
    const m = Array.isArray(data) ? data[0] : data;
    const body = m.content || m.html || "";
    console.log(`from:    ${(m.fromAddress || m.from || []).map((f) => f.address || f).join(",")}`);
    console.log(`to:      ${(m.toAddress || []).map((t) => t.address || t).join(",")}`);
    console.log(`date:    ${m.date ? new Date(Number(m.date)).toISOString() : ""}`);
    console.log(`subject: ${m.subject}\n`);
    console.log(body.includes("<") ? strip(body) : body);
    return;
  }

  if (cmd === "search") {
    const q = encodeURIComponent(rest.join(" "));
    const data = await api(`/accounts/${id}/messages/search?query=${q}&start=0&limit=20`);
    const list = Array.isArray(data) ? data : (data?.messages || []);
    for (const m of list) console.log(`${m.messageId}  ${m.subject}`);
    if (!list.length) console.log("(no matches)");
    return;
  }

  if (cmd === "draft" || cmd === "send") {
    const f = flags(rest);
    if (!f.to || !f.subject || !f.body) throw new Error("need --to --subject --body");
    if (cmd === "send" && !f.yes) {
      throw new Error("refusing to send without --yes. use `draft` first, or add --yes once the human has approved this exact email.");
    }
    const data = await api(`/accounts/${id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        fromAddress: `support@paydlux.com`,
        toAddress: f.to,
        subject: f.subject,
        content: f.body,
        saveAsDraft: cmd === "draft" ? "yes" : "no",
        mailFormat: "text",
      }),
    });
    console.log(cmd === "draft" ? "draft saved" : "sent", JSON.stringify(data).slice(0, 200));
    return;
  }

  console.log(HELP);
}

main().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
