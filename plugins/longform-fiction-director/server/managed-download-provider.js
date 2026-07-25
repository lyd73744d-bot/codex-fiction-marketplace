"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createDownloadProvider } = require("./download-provider");

function managedError(code, message) { return Object.assign(new Error(message), { code }); }

async function ensureConfig(dataDir) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const configPath = path.join(dataDir, "config.yml");
  let config = await fs.readFile(configPath, "utf8").catch((error) => error.code === "ENOENT" ? "" : Promise.reject(error));
  const values = {
    old_cli: "false",
    max_workers: "1",
    request_timeout: "15",
    max_retries: "3",
    novel_format: "txt",
    bulk_files: "false",
    auto_clear_dump: "false",
    ask_format_after_download: "false",
    allow_overwrite_files: "true",
    save_path: `'${String(dataDir).replaceAll("'", "''")}'`
  };
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}: ${value}`;
    const pattern = new RegExp(`^${key}:.*$`, "m");
    config = pattern.test(config) ? config.replace(pattern, line) : `${config.replace(/\s*$/u, "")}\n${line}\n`;
  }
  await fs.writeFile(configPath, config.replace(/^\s+/u, ""), { encoding: "utf8", mode: 0o600 });
  return configPath;
}

function createManagedDownloadProvider(options = {}) {
  const binaryPath = path.resolve(options.binaryPath || path.join(__dirname, "..", "bin", "tomato-novel-downloader.exe"));
  const dataDir = path.resolve(options.dataDir || path.join(process.env.LOCALAPPDATA || process.env.APPDATA || process.cwd(), "Zizhuji", "tomato-downloader"));
  const spawnImpl = options.spawnImpl || spawn;
  const providerFactory = options.providerFactory || createDownloadProvider;
  const startupTimeoutMs = Number.isSafeInteger(options.startupTimeoutMs) && options.startupTimeoutMs > 0 ? options.startupTimeoutMs : 30_000;
  let child = null;
  let provider = null;
  let starting = null;

  async function start() {
    if (provider && child && !child.killed) return provider;
    if (starting) return starting;
    starting = (async () => {
      const binary = await fs.lstat(binaryPath).catch((error) => { throw managedError("DOWNLOAD_BINARY_MISSING", `Bundled downloader is unavailable: ${error.code || "missing"}`); });
      if (!binary.isFile() || binary.isSymbolicLink()) throw managedError("DOWNLOAD_BINARY_INVALID", "Bundled downloader is not a regular file.");
      await ensureConfig(dataDir);
      const processHandle = spawnImpl(binaryPath, ["--server", "--data-dir", dataDir], {
        cwd: path.dirname(binaryPath), windowsHide: true, stdio: ["ignore", "pipe", "pipe"]
      });
      child = processHandle;
      const baseUrl = await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
        const timer = setTimeout(() => finish(reject, managedError("DOWNLOAD_START_TIMEOUT", "Bundled downloader did not start in time.")), startupTimeoutMs);
        const inspect = (chunk) => {
          const match = String(chunk || "").match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d{2,5})/iu);
          if (match) finish(resolve, `http://127.0.0.1:${match[1]}`);
        };
        processHandle.stdout?.on("data", inspect);
        processHandle.stderr?.on("data", inspect);
        processHandle.once("error", (error) => finish(reject, managedError("DOWNLOAD_START_FAILED", error.message)));
        processHandle.once("exit", (code) => {
          child = null; provider = null;
          finish(reject, managedError("DOWNLOAD_START_FAILED", `Bundled downloader exited with code ${code}.`));
        });
      });
      provider = providerFactory({ baseUrl, dataDir });
      return provider;
    })();
    try { return await starting; }
    finally { starting = null; }
  }

  async function download(input = {}) {
    if (input.authorized !== true) throw managedError("SOURCE_NOT_AUTHORIZED", "The author must confirm authorization before downloading a book.");
    return (await start()).download(input);
  }

  async function stop() {
    provider = null;
    if (!child || child.killed) return;
    const active = child;
    child = null;
    active.kill();
  }

  return Object.freeze({ binaryPath, dataDir, download, start, stop });
}

module.exports = { createManagedDownloadProvider, ensureConfig };
