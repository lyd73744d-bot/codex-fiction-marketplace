"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function main() {
  const pluginRoot = path.resolve(__dirname, "..");
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const entry = config?.mcpServers?.["longform-fiction-director"];
  assert.ok(entry, "MCP entry is missing");
  assert.strictEqual(entry.command.toLowerCase(), "cmd.exe", "Windows MCP launcher must not depend on node being in PATH");
  assert.ok(entry.args.some((item) => /start-mcp\.cmd/iu.test(item)), "MCP launcher script is not configured");

  if (process.platform !== "win32") {
    console.log("selftest-mcp-launcher: static checks passed (non-Windows)");
    return;
  }

  const result = await new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, {
      cwd: pluginRoot,
      env: { ...process.env, FICTION_DIRECTOR_NODE: process.execPath },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP launcher timed out. stderr=${stderr.slice(0, 500)}`));
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`);
  });

  assert.strictEqual(result.code, 0, `MCP launcher failed: ${result.stderr.slice(0, 500)}`);
  const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
  assert.strictEqual(lines.length, 1, `MCP stdout must contain only JSON-RPC output: ${result.stdout.slice(0, 500)}`);
  const response = JSON.parse(lines[0]);
  const tools = response?.result?.tools;
  assert.ok(Array.isArray(tools) && tools.length >= 20, "MCP launcher did not expose the plugin tools");
  assert.ok(tools.some((tool) => tool?.name === "fiction_generate_to_file"), "generation tool is missing");
  assert.ok(tools.some((tool) => tool?.name === "fiction_download_book"), "download tool is missing");
  console.log(`selftest-mcp-launcher: ok (${tools.length} tools)`);
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exit(1);
});
