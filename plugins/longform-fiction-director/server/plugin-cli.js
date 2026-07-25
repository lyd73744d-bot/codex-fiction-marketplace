"use strict";

const { spawn } = require("node:child_process");
const { createRuntime } = require("./mcp-server");

function argumentMap(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    values[key] = argv[index + 1];
    index += 1;
  }
  return values;
}

function requiredArgument(values, name) {
  if (typeof values[name] !== "string" || !values[name].trim()) throw new Error(`--${name} is required.`);
  return values[name].trim();
}

function launchDefaultBrowser(url, { spawnImpl = spawn, platform = process.platform } = {}) {
  const target = String(url || "").trim();
  if (!/^http:\/\/127\.0\.0\.1(?::\d+)?(?:\/|$)/u.test(target)) {
    throw new Error("Only the loopback workbench URL can be opened.");
  }
  const command = platform === "win32" ? "cmd.exe" : platform === "darwin" ? "open" : "xdg-open";
  const args = platform === "win32" ? ["/c", "start", "", target] : [target];
  const child = spawnImpl(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  if (child && typeof child.unref === "function") child.unref();
  return { url: target, command };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [command = "open", ...rest] = argv;
  const runtime = (dependencies.createRuntime || createRuntime)(dependencies.runtimeOptions);
  const stdout = dependencies.stdout || process.stdout;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  if (command === "open") {
    const workbench = await runtime.openWorkbench();
    stdout.write(`${workbench.url}\n`);
    return workbench;
  }
  if (command === "browser") {
    const workbench = await runtime.openWorkbench();
    const result = (dependencies.launchBrowser || launchDefaultBrowser)(workbench.url);
    stdout.write(`${workbench.url}\n`);
    return { ...workbench, browser: result };
  }
  if (command !== "command") throw new Error("Usage: node server/plugin-cli.js open | browser | command --project <id> --instruction <text> [--kind <kind>]");
  if (typeof fetchImpl !== "function") throw new Error("A fetch implementation is required.");
  const values = argumentMap(rest);
  const projectId = requiredArgument(values, "project");
  const instruction = requiredArgument(values, "instruction");
  const kind = String(values.kind || "brainstorm").trim() || "brainstorm";
  const workbench = await runtime.openWorkbench();
  const session = await runtime.createCliSession();
  const baseUrl = String(workbench.url).replace(/\/+$/u, "");
  const response = await fetchImpl(`${baseUrl}/api/local/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: baseUrl, cookie: session.cookie },
    body: JSON.stringify({ projectId, kind, instruction })
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || "The local task API failed.");
  const taskId = body.task?.id;
  if (!taskId) throw new Error("The local task API returned no task id.");
  const result = { taskId, url: workbench.url, task: body.task };
  stdout.write(`${JSON.stringify({ taskId, url: workbench.url })}\n`);
  return result;
}

if (require.main === module) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = { argumentMap, launchDefaultBrowser, main };
