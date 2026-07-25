"use strict";

const readline = require("node:readline");
const { createGatewayClient } = require("./gateway-client");
const { createHumanizerMcpHandler } = require("./zizhuji-compat/server/humanizer-mcp-tools");

const READ_ONLY_TOOLS = new Set([
  "zizhuji_account_status", "zizhuji_connection_status", "zizhuji_list_models",
  "zizhuji_list_projects", "zizhuji_open_project", "zizhuji_read_context",
  "zizhuji_read_artifact", "zizhuji_read_ledger", "zizhuji_list_workflows",
  "zizhuji_get_run", "zizhuji_list_humanizer_rule_status", "zizhuji_check_ai_style"
]);

function safetyAnnotations(name) {
  return { readOnlyHint: READ_ONLY_TOOLS.has(name), openWorldHint: false, destructiveHint: false };
}

function createCompatHandler(options = {}) {
  const gatewayUrl = options.gatewayUrl || process.env.FICTION_DIRECTOR_GATEWAY_URL;
  const gateway = options.gateway || createGatewayClient({
    ...(options.gatewayOptions || {}),
    ...(gatewayUrl ? { baseUrl: gatewayUrl } : {}),
    allowInsecureLoopback: true,
    sessionOptions: options.sessionOptions || options.gatewayOptions?.sessionOptions
  });
  const legacy = createHumanizerMcpHandler({ ...options, gateway });
  return async function handle(message) {
    const response = await legacy(message);
    if (message?.method === "initialize" && response?.result?.serverInfo) {
      response.result.serverInfo = { name: "zizhuji-writing-compat", version: "3.0.0-alpha.2" };
    }
    if (message?.method === "tools/list" && Array.isArray(response?.result?.tools)) {
      response.result.tools = response.result.tools.map((tool) => ({ ...tool, annotations: safetyAnnotations(tool.name) }));
    }
    return response;
  };
}

async function runStdio() {
  const handle = createCompatHandler();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let response;
    try { response = await handle(JSON.parse(line)); }
    catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } }; }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (require.main === module) runStdio().catch(() => { process.exitCode = 1; });

module.exports = { createCompatHandler, runStdio };
