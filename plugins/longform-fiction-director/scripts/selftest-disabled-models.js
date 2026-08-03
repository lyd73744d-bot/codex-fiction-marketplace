"use strict";

const assert = require("node:assert");
const { createHybridGateway } = require("../server/hybrid-gateway");
const { recommendModels } = require("../server/model-router");
const { loadPrimaryGatewayConfig } = require("../server/gateway-config");

async function main() {
  let calls = 0;
  const gateway = createHybridGateway({
    primary: {
      allowedModels: ["claude-opus-4-6", "kimi-k3"],
      async listModels() { return { models: [{ id: "claude-opus-4-6" }, { id: "kimi-k3" }] }; },
      async callModels() { calls += 1; return { content: "unexpected" }; }
    },
    secondary: {
      allowedModels: ["kimi-k3", "seed-2.1-pro"],
      async listModels() { return { models: [{ id: "kimi-k3" }, { id: "seed-2.1-pro" }] }; },
      async callModels() { calls += 1; return { content: "unexpected" }; }
    },
    allowedModels: ["claude-opus-4-6", "kimi-k3", "seed-2.1-pro"]
  });

  const catalog = await gateway.listModels();
  assert.deepStrictEqual(catalog.models.map((item) => item.id).sort(), ["claude-opus-4-6", "kimi-k3"]);
  assert.ok(!catalog.allowedModels.includes("seed-2.1-pro"));
  await assert.rejects(
    () => gateway.callModels({ prompt: "test", modelIds: ["seed-2.1-pro"] }),
    (error) => error && error.code === "MODEL_DISABLED"
  );
  assert.strictEqual(calls, 0, "disabled model must not reach an upstream gateway");

  const recommendation = recommendModels({
    task: "draft",
    availableModels: [{ id: "kimi-k3" }, { id: "seed-2.1-pro" }]
  });
  assert.ok(!JSON.stringify(recommendation).includes("seed-2.1-pro"), "router recommended a disabled model");
  assert.ok(JSON.stringify(recommendation).includes("kimi-k3"), "retained Kimi K3 was filtered out");

  const config = loadPrimaryGatewayConfig({
    mode: "openai",
    baseUrl: "https://example.invalid",
    apiKey: "test-key-123",
    preferredModel: "seed-2.1-pro",
    allowedModels: ["seed-2.1-pro", "claude-opus-4-6"]
  });
  assert.strictEqual(config.preferredModel, "claude-sonnet-5");
  assert.deepStrictEqual(config.allowedModels, ["claude-opus-4-6"]);
  console.log("disabled model regression tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
