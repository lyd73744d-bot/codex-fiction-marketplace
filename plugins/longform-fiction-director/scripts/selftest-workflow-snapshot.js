"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { getWorkflowSnapshot } = require("../server/workflow-snapshot-service");
const { bootstrapProject } = require("../server/project-bootstrap");
const { ensureMarketplace } = require("./register-personal-marketplace");

async function main() {
  const globalSnap = await getWorkflowSnapshot("");
  assert.equal(globalSnap.ok, true);
  assert.equal(globalSnap.scope, "global");

  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-snap-"));
  await bootstrapProject(proj, { title: "快照测" });
  const snap = await getWorkflowSnapshot(proj);
  assert.equal(snap.ok, true);
  assert.equal(snap.scope, "project");
  assert.ok(snap.guided.stage);
  assert.ok(snap.pipeline.nextAction);

  const market = ensureMarketplace();
  assert.ok(market.marketplacePath);
  assert.equal(market.entry.name, "longform-fiction-director");

  console.log("workflow snapshot + marketplace selftest: PASS");
  console.log(JSON.stringify({
    stage: snap.guided.stage.id,
    next: snap.pipeline.nextAction,
    marketplace: market.marketplacePath,
    pluginExists: market.pluginExists
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
