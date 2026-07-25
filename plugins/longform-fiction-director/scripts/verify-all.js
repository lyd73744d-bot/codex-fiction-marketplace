"use strict";
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const root = path.join(__dirname, "..");
const tests = [
  "audit-requirements.js",
  "selftest-onboarding-popup.js",
  "selftest-model-router.js",
  "selftest-hard-gates-fallback.js",
  "selftest-artifact-pipeline.js",
  "selftest-guided-flow.js",
  "selftest-optimize-humanizer.js",
  "selftest-research-init.js",
  "selftest-research-hard-gate.js",
  "selftest-fact-ledger.js",
  "selftest-offline-full-path.js",
  "selftest-first-run-coach.js",
  "selftest-live-smoke.js",
  "selftest-workflow-snapshot.js",
  "selftest-login-local.js"
];
let failed = 0;
for (const t of tests) {
  const r = spawnSync(process.execPath, [path.join(root, "scripts", t)], { cwd: root, encoding: "utf8" });
  const ok = r.status === 0;
  console.log((ok ? "PASS" : "FAIL"), t);
  if (!ok) {
    failed += 1;
    console.log(r.stdout || "");
    console.log(r.stderr || "");
  } else if (r.stdout) {
    console.log(String(r.stdout).trim().split(/\n/).slice(-1)[0]);
  }
}
const src = fs.readFileSync(path.join(root, "server/fiction-mcp-tools.js"), "utf8");
const count = [...src.matchAll(/name:\s*"(fiction_[^"]+)"/g)].length;
console.log("toolCount", count);
console.log("version", JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
if (failed) process.exit(1);
console.log("verify-all: PASS");
