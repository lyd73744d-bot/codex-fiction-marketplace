"use strict";
const assert = require("node:assert/strict");
const { smokeLiveGateway } = require("../server/live-gateway-smoke");

async function main() {
  const gateway = {
    async accountStatus() { return { loggedIn: false, user: null }; },
    async listModels() { throw new Error("should not list"); },
    async callModels() { throw new Error("should not call"); }
  };
  const r = await smokeLiveGateway({ gateway, markOnboarding: false });
  assert.equal(r.ok, false);
  assert.equal(r.needLogin, true);

  const gateway2 = {
    async accountStatus() { return { loggedIn: true, user: { username: "t" }, balance: 1 }; },
    async listModels() { return { models: [{ id: "gpt-5.6-luna" }, { id: "claude-sonnet-5" }] }; },
    async callModels({ modelIds }) {
      return {
        transport: "stream_attempt_1",
        outputs: [{ model: modelIds[0], content: "标题：冒烟开场\n\n雨砸在辕门上。他把军报按住：谁压的？门外脚步乱了。", transport: "stream_attempt_1" }]
      };
    }
  };
  const ok = await smokeLiveGateway({ gateway: gateway2, title: "unit", markOnboarding: false });
  assert.equal(ok.ok, true);
  assert.ok(ok.draft.artifact.plainPath);
  assert.equal(ok.draft.modelReadable, true);
  console.log("live-gateway-smoke selftest: PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
