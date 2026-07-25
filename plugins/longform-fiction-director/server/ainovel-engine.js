"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_LOG_BYTES = 32 * 1024;
const MAX_CHAPTERS = 512;

function engineError(code, message) { return Object.assign(new Error(message), { code }); }
function defaultBinaryPath() {
  if (process.env.AINOVEL_CLI_PATH) return path.resolve(process.env.AINOVEL_CLI_PATH);
  const name = process.platform === "win32" ? "ainovel-cli.exe" : "ainovel-cli";
  return path.resolve(__dirname, "..", "bin", name);
}
async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch (cause) { if (cause.code === "ENOENT") return fallback; throw cause; }
}
async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rm(filePath, { force: true });
  await fs.rename(temporary, filePath);
}
function publicState(state, chapters = [], logs = {}) {
  return {
    projectId: state.projectId,
    status: state.status,
    pid: state.pid || null,
    modelIds: Array.isArray(state.modelIds) ? state.modelIds : [],
    startedAt: state.startedAt || null,
    updatedAt: state.updatedAt || null,
    exitCode: Number.isInteger(state.exitCode) ? state.exitCode : null,
    signal: state.signal || null,
    error: state.error || null,
    chapters,
    logs
  };
}
async function tail(filePath) {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stats = await handle.stat();
      const size = Math.min(stats.size, MAX_LOG_BYTES);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, Math.max(0, stats.size - size));
      return buffer.toString("utf8");
    } finally { await handle.close(); }
  } catch (cause) { if (cause.code === "ENOENT") return ""; throw cause; }
}

function createAinovelEngine({ director, bridge, binaryPath = defaultBinaryPath(), spawn = childProcess.spawn } = {}) {
  if (!director || typeof director.openProject !== "function") throw new TypeError("director with openProject is required");
  if (!bridge || typeof bridge.start !== "function") throw new TypeError("ainovel gateway bridge is required");
  const executable = path.resolve(binaryPath);
  const runs = new Map();

  async function pathsFor(projectId) {
    const project = await director.openProject(projectId);
    const projectPath = path.resolve(project.path);
    const directorPath = path.join(projectPath, ".fiction-director");
    const root = path.join(directorPath, "ainovel");
    const relative = path.relative(directorPath, root);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw engineError("AINOVEL_PROJECT_UNSAFE", "ainovel project path is unsafe.");
    return {
      project,
      root,
      configPath: path.join(root, ".ainovel", "config.json"),
      statePath: path.join(root, "engine-state.json"),
      stdoutPath: path.join(root, "engine.stdout.log"),
      stderrPath: path.join(root, "engine.stderr.log"),
      chaptersPath: path.join(root, "output", "novel", "chapters")
    };
  }

  async function verifyExecutable() {
    let stats;
    try { stats = await fs.lstat(executable); }
    catch (cause) { if (cause.code === "ENOENT") throw engineError("AINOVEL_BINARY_MISSING", `ainovel-cli was not found at ${executable}.`); throw cause; }
    if (stats.isSymbolicLink() || !stats.isFile()) throw engineError("AINOVEL_BINARY_UNSAFE", "ainovel-cli must be a regular file.");
  }

  async function chaptersFor(paths) {
    let entries;
    try { entries = await fs.readdir(paths.chaptersPath, { withFileTypes: true }); }
    catch (cause) { if (cause.code === "ENOENT") return []; throw cause; }
    const chapters = [];
    for (const entry of entries.slice(0, MAX_CHAPTERS)) {
      if (!entry.isFile() || entry.isSymbolicLink() || path.extname(entry.name).toLowerCase() !== ".md") continue;
      const filePath = path.join(paths.chaptersPath, entry.name);
      const stats = await fs.lstat(filePath);
      if (!stats.isFile() || stats.isSymbolicLink()) continue;
      chapters.push({ relativePath: path.posix.join("output", "novel", "chapters", entry.name), bytes: stats.size, updatedAt: stats.mtime.toISOString() });
    }
    return chapters.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN", { numeric: true }));
  }

  function configFor(connection, modelIds) {
    const models = [...new Set(modelIds)];
    return {
      provider: "zizhuji",
      model: models[0],
      providers: {
        zizhuji: {
          type: "openai",
          api: "chat",
          api_key: connection.apiKey,
          base_url: connection.baseUrl,
          stream_idle_timeout: "15m",
          models: models.map((name) => ({ name, context_window: 200000 }))
        }
      },
      roles: {
        architect: { provider: "zizhuji", model: models[0] },
        writer: { provider: "zizhuji", model: models[1] || models[0] },
        editor: { provider: "zizhuji", model: models[2] || models[1] || models[0] }
      },
      style: "default"
    };
  }

  async function inspect(projectId) {
    const paths = await pathsFor(projectId);
    const saved = await readJson(paths.statePath, { projectId, status: "idle", modelIds: [] });
    const live = runs.get(projectId);
    const state = live ? live.state : saved;
    return publicState(state, await chaptersFor(paths), { stdout: await tail(paths.stdoutPath), stderr: await tail(paths.stderrPath) });
  }

  async function launch({ projectId, prompt, modelIds, resume }) {
    if (runs.has(projectId)) throw engineError("AINOVEL_ALREADY_RUNNING", "ainovel-cli is already running for this project.");
    const normalizedModels = [...new Set((modelIds || []).map((value) => String(value || "").trim()).filter(Boolean))];
    if (!normalizedModels.length) throw engineError("AINOVEL_MODEL_REQUIRED", "Select at least one account model.");
    const normalizedPrompt = String(prompt || "").trim();
    if (!resume && !normalizedPrompt) throw engineError("AINOVEL_PROMPT_REQUIRED", "A writing direction is required to start ainovel-cli.");
    if (normalizedPrompt.length > 20_000) throw engineError("AINOVEL_PROMPT_TOO_LARGE", "The ainovel direction is too large.");
    await verifyExecutable();
    const paths = await pathsFor(projectId);
    await fs.mkdir(paths.root, { recursive: true });
    const connection = await bridge.start();
    await writeJson(paths.configPath, configFor(connection, normalizedModels));
    const args = ["--headless"];
    if (!resume) args.push("--prompt", normalizedPrompt);
    const now = new Date().toISOString();
    const state = { projectId, status: "starting", pid: null, modelIds: normalizedModels, startedAt: now, updatedAt: now, exitCode: null, signal: null, error: null };
    const child = spawn(executable, args, {
      cwd: paths.root,
      env: { ...process.env, HOME: paths.root, USERPROFILE: paths.root },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    state.pid = child.pid || null;
    state.status = "running";
    state.updatedAt = new Date().toISOString();
    const run = { child, state, requestedStatus: null };
    runs.set(projectId, run);
    await writeJson(paths.statePath, state);
    const redact = (value) => String(value).split(connection.apiKey).join("[redacted]");
    child.stdout?.on("data", (chunk) => { fs.appendFile(paths.stdoutPath, redact(chunk), "utf8").catch(() => {}); });
    child.stderr?.on("data", (chunk) => { fs.appendFile(paths.stderrPath, redact(chunk), "utf8").catch(() => {}); });
    child.once("error", (cause) => {
      state.status = "failed"; state.error = { code: "AINOVEL_SPAWN_FAILED", message: cause.message }; state.updatedAt = new Date().toISOString();
      runs.delete(projectId); writeJson(paths.statePath, state).catch(() => {});
    });
    child.once("exit", (code, signal) => {
      state.status = run.requestedStatus || (code === 0 ? "completed" : "failed");
      state.exitCode = Number.isInteger(code) ? code : null;
      state.signal = signal || null;
      state.pid = null;
      state.updatedAt = new Date().toISOString();
      runs.delete(projectId); writeJson(paths.statePath, state).catch(() => {});
    });
    return inspect(projectId);
  }

  return Object.freeze({
    start(input = {}) { return launch({ ...input, resume: false }); },
    async resume(input = {}) {
      const previous = await inspect(input.projectId);
      return launch({ ...input, modelIds: input.modelIds?.length ? input.modelIds : previous.modelIds, resume: true });
    },
    async pause(projectId) {
      const run = runs.get(projectId);
      if (!run) throw engineError("AINOVEL_NOT_RUNNING", "ainovel-cli is not running for this project.");
      run.requestedStatus = "paused";
      run.state.status = "paused";
      run.state.updatedAt = new Date().toISOString();
      const paths = await pathsFor(projectId);
      await writeJson(paths.statePath, run.state);
      if (!run.child.kill()) throw engineError("AINOVEL_PAUSE_FAILED", "ainovel-cli could not be paused.");
      return inspect(projectId);
    },
    status: inspect,
    async stopAll() {
      for (const [projectId, run] of runs) {
        run.requestedStatus = "paused";
        run.child.kill();
        runs.delete(projectId);
      }
    },
    binaryPath: executable
  });
}

module.exports = { createAinovelEngine };

