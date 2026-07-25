"use strict";

const path = require("node:path");

async function main() {
  process.chdir(path.resolve(__dirname, ".."));
  const { createRuntime } = require("../server/mcp-server");
  const { smokeLiveGateway } = require("../server/live-gateway-smoke");
  const runtime = createRuntime();
  const projectDir = process.argv[2] || "";
  const result = await smokeLiveGateway({ gateway: runtime.gateway, projectDir });
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
  // stop keep-alive servers if any
  setTimeout(() => process.exit(process.exitCode || 0), 500).unref();
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
