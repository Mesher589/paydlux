// The whole loop over real HTTP, with the phone as a SEPARATE PROCESS.
//
//   desk (this process, no approver key)
//     -> writes the approval payload to a file
//   tools/phone-sign.ts (child process, holds the approver key)
//     -> prints the signed transaction
//   desk posts it to /signed/<id> and submits
//
//   npx tsx stellar/e2e-phone.ts
import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarVault } from "./vault.ts";
import { ApprovalDesk, newPortalKey } from "./desk.ts";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { c ? (pass++, console.log("  \u2705", m)) : (fail++, console.log("  \u274c", m)); };
const step = (n: string) => console.log(`\n\u2014 ${n}`);

const main = async () => {
  const issuer = Keypair.random(), principal = Keypair.random();
  const approver = Keypair.random(), agent = Keypair.random(), seller = Keypair.random();
  for (const k of [issuer, principal, approver, seller]) await StellarVault.fundTestnet(k);
  const vault = await StellarVault.create({
    network: "testnet", issuer, principal, approver, agent, tokenCode: "AGPAY",
  });
  await vault.deposit("20", issuer);
  await vault.trustToken(seller.publicKey(), "1000", seller);

  const portalKey = newPortalKey();
  const port = 4211;
  const desk = new ApprovalDesk({
    vault, payee: seller.publicKey(),
    principal: principal.secret(),
    split: true, port, portalKey, decideWithinSeconds: 3600,
  });
  await desk.listen();

  step("1. the agent asks to buy; the desk parks it");
  const id = desk.enqueue("GET https://api.example.com/quotes", "4.50", "30s of market data", "payload");
  const res = await fetch(`http://127.0.0.1:${port}/approve/${id}?k=${portalKey}`, { method: "POST" });
  const asked = await res.json();
  ok(asked.status === "awaiting_phone", `POST /approve -> ${asked.status}`);

  step("2. the payload travels to the phone (here: a file, in reality: a QR scan)");
  const file = join(tmpdir(), `paydlux-${id}.txt`);
  writeFileSync(file, asked.qr);
  ok(asked.qr.startsWith("paydlux:1"), `payload written (${asked.qr.length} chars)`);

  step("3. a separate process signs it, holding the key the desk never sees");
  const out = execFileSync("npx", ["tsx", "tools/phone-sign.ts", "--qr-file", file], {
    cwd: process.cwd(),
    env: { ...process.env, PAYDLUX_APPROVER_SEED: approver.secret() },
    encoding: "utf8",
  });
  const answer = JSON.parse(out.trim().split("\n").filter(Boolean).pop()!);
  ok(!!answer.signedXdr, `phone returned ${answer.signedXdr.length} chars of signed XDR`);
  unlinkSync(file);

  step("4. the desk submits what the phone signed");
  const res2 = await fetch(`http://127.0.0.1:${port}/signed/${id}?k=${portalKey}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ signedXdr: answer.signedXdr }),
  });
  const done = await res2.json();
  ok(done.status === "settled", `POST /signed -> ${done.status}`);
  ok(await vault.balance(seller.publicKey()) === "4.5000000", "seller holds 4.5000000");

  step("5. the portal without the key still cannot approve");
  const noKey = await fetch(`http://127.0.0.1:${port}/approve/${id}`, { method: "POST" });
  ok(noKey.status === 403, `keyless POST /approve -> ${noKey.status}`);

  await desk.close();
  console.log(`\n${fail === 0 ? "ALL CHECKS PASSED" : "FAILURES: " + fail} \u2014 desk and phone are separate machines in this run.`);
  console.log(`pass ${pass}  fail ${fail}`);
  console.log("explorer: https://stellar.expert/explorer/testnet/account/" + vault.address);
};

main().catch((e) => { console.error("crashed:", e?.message ?? e); process.exit(1); });
