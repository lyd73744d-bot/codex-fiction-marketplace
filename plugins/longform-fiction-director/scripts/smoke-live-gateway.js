"use strict";

const path = require("node:path");

async function main() {
  if (process.env.FICTION_LIVE_MODEL_CONFIRMED !== "1") {
    throw Object.assign(new Error("Set FICTION_LIVE_MODEL_CONFIRMED=1 only after the author confirms this live model call."), { code: "AUTHOR_CONFIRMATION_REQUIRED" });
  }
  process.chdir(path.resolve(__dirname, ".."));
  const { createRuntime } = require("../server/mcp-server");
  const { smokeLiveGateway } = require("../server/live-gateway-smoke");
  const runtime = createRuntime();
  const projectDir = process.argv[2] || "";
  const modelId = process.argv[3] || "";
  const result = await smokeLiveGateway({ gateway: runtime.gateway, projectDir, modelIds: modelId ? [modelId] : [] });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  // stop keep-alive servers if any
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
