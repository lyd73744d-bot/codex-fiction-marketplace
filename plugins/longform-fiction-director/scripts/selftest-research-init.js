"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { planResearch, buildSearchQueries } = require("../server/research-plan-service");
const { getProductGuide } = require("../server/product-guide");
const { handle } = require("../server/mcp-server");
const { createGatewayGuard } = require("../server/gateway-guard");

async function main() {
  const q = buildSearchQueries({ topic: "卢象升", genre: "历史", names: ["孙传庭"], storyRole: "前线将领" });
  assert.ok(q.length >= 3);
  assert.ok(q.some((x) => x.includes("卢象升")));

  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-research-"));
  const plan = await planResearch({
    projectDir: proj,
    topic: "卢象升",
    genre: "历史军事",
    names: ["卢象升"],
    storyRole: "必须先核验的主将",
    createDoc: true
  });
  assert.equal(plan.ok, true);
  assert.ok(plan.researchDoc.path);
  assert.ok(plan.artifact.path);

  const guide = getProductGuide();
  assert.equal(guide.role.includes("辅助"), true);
  assert.ok(guide.toolsByStage.research.includes("fiction_plan_research"));

  // initialize returns gatewayAccess when guard present
  const gateway = {
    async accountStatus() { return { loggedIn: false }; },
    async login() { return {}; },
    async listModels() { return { models: [] }; },
    async callModels() { return { content: "x" }; }
  };
  let opened = 0;
  const guard = createGatewayGuard({
    gateway,
    openLoginPage: async () => { opened += 1; return { url: "http://127.0.0.1:9/login" }; },
    paymentPortalUrl: "https://catfk.com/shop/ZVZNANU8"
  });
  // use temp onboarding path via monkeypatch? ensureAccess uses default path; ok for smoke
  const res = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, {
    gatewayGuard: guard,
    tools: { list() { return []; }, async call() { return {}; } },
    gateway
  });
  assert.equal(res.result.serverInfo.name, "longform-fiction-director");
  assert.ok(res.result.serverInfo.gatewayAccess);
  assert.equal(typeof res.result.serverInfo.gatewayAccess.popupOpened, "boolean");

  console.log("research+init selftest: PASS");
  console.log(JSON.stringify({ queries: plan.queries.slice(0, 4), openedPopup: res.result.serverInfo.gatewayAccess.popupOpened, version: res.result.serverInfo.version }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
