// The MCP server has to speak MCP to a real client, not just typecheck.
//
// A server that imports cleanly can still fail the handshake, register tools
// with schemas a client rejects, or leak the vault's secret seeds into a tool
// result that a model then summarises into a public answer. This check drives
// the server the way a client does — spawn over stdio, initialize, list tools,
// call them — against the testnet vault, and asserts the safety stance holds:
//
//   * every tool result is free of secret seeds
//   * --read-only removes the tools that touch money
//   * a key file that other users can read is refused, not read
//
// Nothing here moves money: the buying tools are only listed, never called.
//
// Run:  npx tsx stellar/mcp-check.ts
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const SERVER = join(ROOT, "stellar", "mcp.ts");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const VAULT_FILE = process.env.PAYDLUX_CHECK_VAULT ?? join(ROOT, "paydlux-vault.json");

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : ` — ${detail}`}`);
  if (!cond) fails++;
};

function connect(args: string[]): Client {
  const client = new Client({ name: "paydlux-check", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: TSX, args: [SERVER, ...args], cwd: ROOT, stderr: "ignore",
  });
  // connect() is async; callers await the returned promise via `ready`.
  (client as any).ready = client.connect(transport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const r: any = await client.callTool({ name, arguments: args });
  const raw = (r.content ?? []).map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("\n");
  let json: any = null;
  try { json = JSON.parse(raw); } catch { /* asserted below */ }
  return { raw, json, isError: !!r.isError };
}

if (!existsSync(VAULT_FILE)) {
  console.log(`FAIL  vault file missing: ${VAULT_FILE} (set PAYDLUX_CHECK_VAULT to a testnet vault)`);
  process.exit(1);
}
const VAULT_JSON = JSON.parse(readFileSync(VAULT_FILE, "utf8"));

const client = connect(["--file", VAULT_FILE]);
await (client as any).ready;

// 1. Handshake.
const info: any = (client as any).getServerVersion?.() ?? {};
ok("handshake names the paydlux server", String(info.name ?? "").includes("paydlux"), JSON.stringify(info));

// 2. Tools are listed, with descriptions a model can act on.
const tools: any = await client.listTools();
const names: string[] = tools.tools.map((t: any) => t.name);
const want = [
  "paydlux_status", "paydlux_payment_rules", "paydlux_check_payment",
  "paydlux_recent_payments", "paydlux_escrow_status", "paydlux_pending_escrows",
  "paydlux_buy", "paydlux_payment_status",
];
ok("all tools listed", want.every((n) => names.includes(n)), names.join(", "));
ok("every tool has a description", tools.tools.every((t: any) => (t.description ?? "").length > 40),
  tools.tools.filter((t: any) => !(t.description ?? "").length).map((t: any) => t.name).join(", "));
ok("input schemas are objects", tools.tools.every((t: any) => t.inputSchema?.type === "object" || !t.inputSchema));

// 2b. Prompts: not only what an agent may call, but the order it should call in.
const prompts: any = await client.listPrompts();
const pNames: string[] = prompts.prompts.map((p: any) => p.name);
ok("both prompts listed",
  ["paydlux_budget_review", "paydlux_buy_safely"].every((n) => pNames.includes(n)), pNames.join(", "));
ok("every prompt has a description", prompts.prompts.every((p: any) => (p.description ?? "").length > 40),
  prompts.prompts.filter((p: any) => !(p.description ?? "").length).map((p: any) => p.name).join(", "));
const pr: any = await client.getPrompt({ name: "paydlux_buy_safely", arguments: { url: "https://seller.example.com/api/data", amount: "1" } });
const prText = JSON.stringify(pr);
ok("buy prompt orders the safe sequence",
  /paydlux_check_payment/.test(prText) && /once/.test(prText) && /needs_approval/.test(prText), prText.slice(0, 200));
ok("buy prompt keeps the desk out of the agent's hands", /Never open the desk link yourself/.test(prText), prText.slice(0, 200));

// 3. The instructions carry the human-in-the-loop rule and the homepage.
const init: any = (client as any).getInstructions ? (client as any).getInstructions() : "";
ok("instructions point at paydlux.com", String(init).includes("paydlux.com"), String(init).slice(0, 80));

// 4. Read-only tools answer with live ledger data.
const status = await call(client, "paydlux_status");
ok("status returns JSON", !!status.json && !status.isError, status.raw.slice(0, 120));
ok("status names the vault from the file", status.json?.vault === VAULT_JSON.vault, status.json?.vault);
ok("status reports the 2-of-2 threshold", status.json?.thresholds?.low === 2, JSON.stringify(status.json?.thresholds));

const rules = await call(client, "paydlux_payment_rules");
const filePolicy = VAULT_JSON.policy ?? {};
ok("rules echo the human's ceilings",
  rules.json?.daily_budget === filePolicy.dailyBudget && rules.json?.max_per_payment === filePolicy.maxPerPayment,
  JSON.stringify({ got: [rules.json?.daily_budget, rules.json?.max_per_payment], want: [filePolicy.dailyBudget, filePolicy.maxPerPayment] }));
ok("rules count today from the ledger", typeof rules.json?.spent_today_ledger === "number", String(rules.json?.spent_today_ledger));

// 5. A payment over the ceiling is refused, and names the rule it broke.
const over = await call(client, "paydlux_check_payment", { amount: (filePolicy.maxPerPayment ?? 10) * 100 });
ok("over-ceiling payment refused", over.json?.ok === false, JSON.stringify(over.json));
ok("refusal names the rule", typeof over.json?.rule === "string" && over.json.rule.length > 3, over.json?.rule);

const small = await call(client, "paydlux_check_payment", { amount: 0.01 });
ok("small payment allowed", small.json?.ok === true, JSON.stringify(small.json));

// 6. Ledger history and escrow reads answer.
const recent = await call(client, "paydlux_recent_payments", { limit: 3 });
ok("recent payments is an array", Array.isArray(recent.json?.payments), recent.raw.slice(0, 120));
const esc = await call(client, "paydlux_pending_escrows");
ok("pending escrows answers with a count", typeof esc.json?.count === "number", esc.raw.slice(0, 120));
const missing = await call(client, "paydlux_escrow_status", { balance_id: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
ok("unknown escrow id answers instead of throwing", !missing.isError && missing.json?.escrow === null, missing.raw.slice(0, 120));

// 7. No secret seed may ever reach a model's context.
const allRaw = [status.raw, rules.raw, over.raw, small.raw, recent.raw, esc.raw, missing.raw].join("\n");
ok("no secret seed in any tool result", !/S[A-Z2-7]{55}/.test(allRaw), "a seed reached stdout");

client.close();

// 8. --read-only removes the tools that touch money.
const ro = connect(["--file", VAULT_FILE, "--read-only"]);
await (ro as any).ready;
const roNames: string[] = (await ro.listTools()).tools.map((t: any) => t.name);
ok("--read-only drops paydlux_buy", !roNames.includes("paydlux_buy"), roNames.join(", "));
ok("--read-only keeps the reading tools", roNames.includes("paydlux_payment_rules"), roNames.join(", "));
const roPrompts: string[] = (await ro.listPrompts()).prompts.map((p: any) => p.name);
ok("--read-only drops the buying prompt too", !roPrompts.includes("paydlux_buy_safely"), roPrompts.join(", "));
ok("--read-only keeps the budget review", roPrompts.includes("paydlux_budget_review"), roPrompts.join(", "));
ro.close();

// 9. A key file other users can read is refused.
const dir = mkdtempSync(join(tmpdir(), "paydlux-mcp-check-"));
const loose = join(dir, "loose.json");
copyFileSync(VAULT_FILE, loose);
chmodSync(loose, 0o644);
let refused = "";
try {
  execFileSync(TSX, [SERVER, "--file", loose], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], input: "" });
} catch (e: any) { refused = `${e.stderr ?? ""}${e.stdout ?? ""}`; }
ok("world-readable key file refused", /chmod 600/.test(refused), refused.slice(0, 160) || "server started anyway");

console.log(fails ? `\n${fails} check(s) failed` : "\nall MCP checks passed");
process.exit(fails ? 1 : 0);
