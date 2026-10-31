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
import { createInterface } from "node:readline";
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

// Access tokens last an hour. Fetching one per command got us rate-limited
// ("too many requests continuously") within a minute, so cache it on disk and
// only refresh when it is within 2 minutes of expiry.
const TOKEN_FILE = join(SECRET_DIR, "zoho-access-token.json");
async function accessToken() {
  if (existsSync(TOKEN_FILE)) {
    try {
      const c = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
      if (c.expiresAt - Date.now() > 120_000) return c.accessToken;
    } catch { /* fall through and refresh */ }
  }
  const j = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: need("zoho-refresh-token.key"),
      client_id: need("zoho-client-id.key"),
      client_secret: need("zoho-client-secret.key"),
    }),
  }).then((r) => r.json());
  if (!j.access_token) throw new Error(`token refresh failed: ${JSON.stringify(j).slice(0, 200)}`);
  mkdirSync(SECRET_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(TOKEN_FILE, JSON.stringify({
    accessToken: j.access_token,
    expiresAt: Date.now() + (Number(j.expires_in || 3600) * 1000),
  }));
  chmodSync(TOKEN_FILE, 0o600);
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
  // Zoho wraps responses as {status:{code,description},data:[...]}. A non-200
  // code inside a 200 HTTP response is still an error, so check both.
  const code = typeof j.status === "object" ? j.status?.code : j.status;
  const failed = !r.ok || (code !== undefined && Number(code) !== 200 && Number(code) !== 201);
  if (failed) {
    throw new Error(`${r.status} ${path}: ${text.slice(0, 400)}`);
  }
  return j.data ?? j;
}

// Zoho's view endpoint HTML-escapes address and subject fields.
function decodeHtml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

// Zoho's message list endpoint is /messages/view (not /messages) and it wants
// no folderId for this account. Verified against the live API.
async function messagesView(id, start, limit) {
  const data = await api(`/accounts/${id}/messages/view?start=${start}&limit=${limit}`);
  return Array.isArray(data) ? data : (data?.messages || []);
}

async function accountId() {
  const cached = secret("zoho-account-id.key");
  if (cached) return cached;
  const data = await api("/accounts");
  const list = Array.isArray(data) ? data : [data];
  const chosen = list.find((a) => a.isDefaultAccount) || list[0];
  const id = String(chosen.accountId);
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
    // The code is single-use, but it still should not sit in shell history or
    // in this conversation. On macOS: copy the code in Zoho, then
    //   pbpaste > ~/.hermes/secrets/zoho-code.txt
    // and run `exchange`. The file is blanked as soon as it is consumed.
    const codeFile = join(SECRET_DIR, "zoho-code.txt");
    let code = rest[0];
    if (!code && existsSync(codeFile)) {
      code = readFileSync(codeFile, "utf8").split("\n")[0].trim();
    }
    if (!code && process.stdin.isTTY) {
      code = await new Promise((resolve) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        rl.question("paste the Zoho code, then press Enter: ", (a) => {
          rl.close();
          resolve(a.trim());
        });
      });
    }
    if (!code) {
      throw new Error(
        "no code found. copy the code in Zoho, then run:\n" +
        `  pbpaste > ${codeFile}\n  node tools/mail.mjs exchange`,
      );
    }
    if (existsSync(codeFile)) writeFileSync(codeFile, "");
    const j = await fetch(`${ACCOUNTS_HOST}/oauth/v2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
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
      const addrs = (a.emailAddress || []).map(
        (e) => `${e.mailId}${e.isAlias ? " (alias)" : ""}`).join(", ");
      console.log(`${a.accountId}  ${addrs}  default=${a.isDefaultAccount} mx=${a.mxStatus}`);
    }
    return;
  }

  const id = await accountId();

  if (cmd === "inbox") {
    const n = Number(rest[0] || 15);
    // No folderId: Zoho's numeric folder ids are account-specific and the
    // folder-list endpoint needs a scope the mail scopes don't grant. Omitting
    // folderId returns the account's messages, newest first.
    const list = await messagesView(id, 0, n);
    if (!list.length) { console.log("(inbox empty)"); return; }
    for (const m of list) {
      const when = m.sentDateInGMT ? new Date(Number(m.sentDateInGMT)).toISOString().slice(0, 16) : "";
      console.log(`${m.messageId}  ${when}  ${m.fromAddress || m.sender || "?"}\n    ${decodeHtml(m.subject || "(no subject)")}`);
    }
    console.log(`\n${list.length} message(s). read one: node tools/mail.mjs read <id>`);
    return;
  }

  if (cmd === "read") {
    // The free EU plan has no single-message GET (404 INVALID_METHOD), so pull
    // the recent window and pick the match out of it.
    const list = await messagesView(id, 0, 200);
    const m = list.find((x) => String(x.messageId) === String(rest[0]));
    if (!m) { console.log("not found in the most recent 200 messages"); return; }
    console.log(`from:    ${m.fromAddress || m.sender || "?"}`);
    console.log(`to:      ${decodeHtml(m.toAddress || "")}`);
    console.log(`date:    ${m.sentDateInGMT ? new Date(Number(m.sentDateInGMT)).toISOString() : ""}`);
    console.log(`subject: ${decodeHtml(m.subject || "")}`);
    console.log(`\n${decodeHtml(m.summary || "(no preview)")}`);
    console.log(`\n(full body needs Zoho Mail Lite: the free plan's API returns a preview only)`);
    return;
  }

  if (cmd === "search") {
    const q = rest.join(" ").toLowerCase();
    if (!q) throw new Error("usage: search <text>");
    const list = await messagesView(id, 0, 200);
    const hits = list.filter((m) =>
      `${m.subject} ${m.summary} ${m.fromAddress} ${m.sender}`.toLowerCase().includes(q));
    for (const m of hits) {
      console.log(`${m.messageId}  ${decodeHtml(m.subject || "")}  <-  ${m.fromAddress || m.sender}`);
    }
    if (!hits.length) console.log("(no matches in the most recent 200 messages)");
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
