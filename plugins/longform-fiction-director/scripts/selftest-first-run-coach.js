"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { getFirstRunCoach } = require("../server/first-run-coach-service");
const { listMethodCatalog } = require("../server/method-catalog");
const { getWorkflowSnapshot } = require("../server/workflow-snapshot-service");
const { recommendModels } = require("../server/model-router");
const { ensureSoftLedgers } = require("../server/guided-stage-service");
const { updateBrainstormBoard } = require("../server/brainstorm-service");

async function main() {
  const globalCoach = await getFirstRunCoach("");
  assert.equal(globalCoach.ok, true);
  assert.equal(globalCoach.role, "auxiliary-editor-coach");
  assert.ok(globalCoach.nextStep);
  assert.ok(Array.isArray(globalCoach.steps));
  assert.ok(globalCoach.login.shopUrl.includes("http"));

  const methods = listMethodCatalog();
  assert.ok(methods.items.length >= 8);
  assert.ok(methods.items.every((m) => m.exists));

  const rec = recommendModels({ task: "humanize", availableModels: [{ id: "claude-sonnet-5" }, { id: "gpt-5.6-luna" }] });
  assert.ok(rec.coachAdvice);
  assert.ok(rec.transport.mode.includes("stream"));

  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-first-"));
  await ensureSoftLedgers(proj);
  await updateBrainstormBoard(proj, { hook: "先活下来", desire: "改命", obstacle: "军报" });
  const snap = await getWorkflowSnapshot(proj);
  assert.equal(snap.ok, true);
  assert.ok(snap.firstRunCoach);
  assert.equal(snap.scope, "project");

  console.log("first-run-coach+methods: PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
