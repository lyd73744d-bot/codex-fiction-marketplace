"use strict";

const readline = require("node:readline");
const { createHumanizerMcpHandler } = require("./humanizer-mcp-tools");

async function runStdio() {
  const handle = createHumanizerMcpHandler();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let response;
    try {
      response = await handle(JSON.parse(line));
    } catch {
      response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON" } };
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

if (require.main === module) runStdio().catch(() => { process.exitCode = 1; });

module.exports = { runStdio };

