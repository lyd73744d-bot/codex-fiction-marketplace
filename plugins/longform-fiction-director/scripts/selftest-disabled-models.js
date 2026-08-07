"use strict";

const assert = require("node:assert");
const { createHybridGateway } = require("../server/hybrid-gateway");
const { recommendModels } = require("../server/model-router");
const { loadPrimaryGatewayConfig } = require("../server/gateway-config");

async function main() {
  let calls = 0;
  const gateway = createHybridGateway({
    primary: {
      allowedModels: ["claude-opus-4-6", "deepseek-v4-pro", "kimi-k3"],
      async listModels() { return { models: [{ id: "claude-opus-4-6" }, { id: "deepseek-v4-pro" }, { id: "kimi-k3" }] }; },
      async callModels() { calls += 1; return { content: "unexpected" }; }
    },
    secondary: {
      allowedModels: ["kimi-k3", "gemini-3.5-flash", "seed-2.1-pro"],
      async listModels() { return { models: [{ id: "kimi-k3" }, { id: "gemini-3.5-flash" }, { id: "seed-2.1-pro" }] }; },
      async callModels() { calls += 1; return { content: "unexpected" }; }
    },
    allowedModels: ["claude-opus-4-6", "deepseek-v4-pro", "kimi-k3", "gemini-3.5-flash", "seed-2.1-pro"]
  });

  const catalog = await gateway.listModels();
  assert.deepStrictEqual(catalog.models.map((item) => item.id).sort(), ["claude-opus-4-6", "deepseek-v4-pro"]);
  assert.ok(!catalog.allowedModels.includes("seed-2.1-pro"));
  await assert.rejects(
    () => gateway.callModels({ prompt: "test", modelIds: ["seed-2.1-pro"] }),
    (error) => error && error.code === "MODEL_DISABLED"
  );
  await assert.rejects(
    () => gateway.callModels({ prompt: "test", modelIds: ["kimi-k3"] }),
    (error) => error && error.code === "MODEL_DISABLED"
  );
  assert.strictEqual(calls, 0, "disabled model must not reach an upstream gateway");

  const recommendation = recommendModels({
    task: "draft",
    availableModels: [{ id: "kimi-k3" }, { id: "gemini-3.5-flash" }, { id: "deepseek-v4-pro" }, { id: "seed-2.1-pro" }]
  });
  assert.ok(!JSON.stringify(recommendation).includes("seed-2.1-pro"), "router recommended a disabled model");
  assert.ok(JSON.stringify(recommendation).includes("deepseek-v4-pro"), "retained DeepSeek model was filtered out");

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
