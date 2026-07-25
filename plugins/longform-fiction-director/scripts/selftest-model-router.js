"use strict";
const assert = require("node:assert/strict");
const { recommendModels, normalizeMode } = require("../server/model-router");

function main() {
  assert.equal(normalizeMode("深度"), "deep");
  assert.equal(normalizeMode("quick"), "quick");
  const models = ["glm-5.2", "gpt-5.6-luna", "claude-sonnet-5", "claude-opus-4-6", "kimi-k2.6"];
  const quick = recommendModels({ task: "draft", availableModels: models, mode: "quick" });
  assert.equal(quick.mode, "quick");
  assert.ok(quick.modelIds.length >= 1);
  assert.ok(quick.fallbackChain.length >= 1);
  assert.ok(quick.coachAdvice.includes("流式优先"));
  // quick should not put opus first if lighter models exist
  assert.notEqual(quick.primaryModelId, "claude-opus-4-6");

  const deep = recommendModels({ task: "humanize", availableModels: models, mode: "deep" });
  assert.equal(deep.mode, "deep");
  assert.ok(deep.modelIds.includes("claude-opus-4-6") || deep.modelIds.includes("kimi-k2.6"));

  const unpaid = recommendModels({ task: "outline", availableModels: [], mode: "quick", unpaid: true });
  assert.ok(unpaid.coachAdvice.includes("未登录") || unpaid.coachAdvice.includes("本地"));

  // unavailable preset ids must not leak into chain
  const limited = recommendModels({ task: "draft", availableModels: ["glm-5.2"], mode: "deep" });
  assert.deepEqual(limited.modelIds, ["glm-5.2"]);

  console.log("model-router: PASS");
}
main();
