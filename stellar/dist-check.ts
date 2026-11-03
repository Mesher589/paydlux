// The published CLI must run from dist/, not just from tsx.
//
// tsx resolves extensionless relative imports ("./tunnel"); Node's ESM loader does
// not. A file that typechecks and runs under tsx can still be a broken package:
// 0.1.19 shipped with three such imports in cli.ts and the CLI died on startup
// with ERR_MODULE_NOT_FOUND for every user. This check runs the built output the
// way a user does, so the class of bug cannot come back.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;

function run(args: string[]): string {
  return execFileSync(process.execPath, [join(DIST, "cli.js"), ...args], {
    encoding: "utf8",
    timeout: 30_000,
  });
}

let fails = 0;
const ok = (label: string, cond: boolean, detail = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${cond ? "" : ` — ${detail}`}`);
  if (!cond) fails++;
};

if (!existsSync(join(DIST, "cli.js"))) {
  console.log("FAIL  dist/cli.js missing — run `npm run build` first");
  process.exit(1);
}

// 1. Every emitted relative import must carry an extension, or Node cannot load it.
const offenders: string[] = [];
for (const f of readdirSync(DIST).filter((f) => f.endsWith(".js"))) {
  const src = readFileSync(join(DIST, f), "utf8");
  for (const m of src.matchAll(/from "(\.[^"]*)"/g)) {
    if (!/\.(js|json)$/.test(m[1])) offenders.push(`${f} -> ${m[1]}`);
  }
}
ok("no extensionless relative imports in dist/", offenders.length === 0, offenders.join(", "));

// 2. The CLI must actually start. This is the check that 0.1.19 would have failed.
let started = true, startErr = "";
try {
  run(["--help"]);
} catch (e: any) {
  started = false;
  startErr = String(e.stderr || e.message).split("\n").slice(0, 3).join(" | ");
}
ok("dist/cli.js --help runs", started, startErr);

// 3. Subcommands a user reaches for must be wired, not silently missing.
let help = "";
try {
  help = run(["--help"]);
} catch {}
for (const cmd of ["donate", "setup", "sell"]) {
  ok(`subcommand '${cmd}' listed`, help.includes(cmd));
}

// 4. donate must know about USDC, the thing this release is about.
let donateHelp = "";
try {
  donateHelp = run(["donate", "--help"]);
} catch (e: any) {
  donateHelp = String(e.stdout || "") + String(e.stderr || "");
}
ok("donate --help mentions --usdc", donateHelp.includes("--usdc"), donateHelp.slice(0, 120));

console.log(fails === 0 ? "\nALL CHECKS PASSED" : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
