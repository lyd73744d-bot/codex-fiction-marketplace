"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TERMINAL_STATES = new Set(["completed", "failed", "interrupted"]);

function defaultStateDir() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(root, "Zizhuji", "longform-fiction-director", "generation-jobs");
}

function safeError(error) {
  return {
    code: String(error?.code || error?.name || "BACKGROUND_JOB_FAILED").slice(0, 80),
    message: String(error?.publicMessage || error?.message || "后台任务失败").slice(0, 300)
  };
}

function publicJob(job) {
  if (!job) return null;
  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    metadata: job.metadata,
    progress: job.progress,
    ...(job.recovered === true ? { recovered: true } : {}),
    ...(job.status === "completed" ? { result: job.result } : {}),
    ...(["failed", "interrupted"].includes(job.status) ? { error: job.error } : {})
  };
}

function createGenerationJobManager({ maxJobs = 40, stateDir = defaultStateDir(), persist = true } = {}) {
  const jobs = new Map();
  let durable = persist !== false;
  let durableStateDir = stateDir;
  if (durable) {
    try {
      fs.mkdirSync(durableStateDir, { recursive: true });
    } catch {
      durableStateDir = path.join(os.tmpdir(), "Zizhuji", "longform-fiction-director", "generation-jobs");
      try { fs.mkdirSync(durableStateDir, { recursive: true }); } catch { durable = false; }
    }
  }

  function statePath(jobId) {
    const id = String(jobId || "");
    if (!/^fiction-[A-Za-z0-9-]{8,80}$/u.test(id)) return null;
    return path.join(durableStateDir, id + ".json");
  }

  function persistJob(job) {
    if (!durable) return;
    const target = statePath(job?.jobId);
    if (!target) return;
    const temp = target + ".tmp-" + process.pid + "-" + crypto.randomUUID().slice(0, 8);
    try {
      fs.writeFileSync(temp, JSON.stringify(publicJob(job), null, 2) + "\n", "utf8");
      fs.rmSync(target, { force: true });
      fs.renameSync(temp, target);
    } catch {
      try { fs.rmSync(temp, { force: true }); } catch {}
    }
  }

  function readPersisted(jobId) {
    if (!durable) return null;
    const target = statePath(jobId);
    if (!target) return null;
    try {
      const value = JSON.parse(fs.readFileSync(target, "utf8"));
      if (!value || value.jobId !== jobId) return null;
      if (["queued", "running"].includes(value.status)) {
        value.status = "interrupted";
        value.completedAt = value.completedAt || new Date().toISOString();
        value.error = {
          code: "MCP_RESTARTED",
          message: "MCP 已重启；后台请求不能继续跟踪，但磁盘中的进度报告和正文检查点仍可恢复。"
        };
        value.recovered = true;
        persistJob(value);
      } else {
        value.recovered = true;
      }
      return value;
    } catch {
      return null;
    }
  }

  function trimMemory() {
    if (jobs.size <= maxJobs) return;
    for (const [jobId, job] of jobs) {
      if (!TERMINAL_STATES.has(job.status)) continue;
      jobs.delete(jobId);
      if (jobs.size <= maxJobs) break;
    }
  }

  function trimPersisted() {
    if (!durable) return;
    try {
      const files = fs.readdirSync(durableStateDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && /^fiction-.*\.json$/u.test(entry.name))
        .map((entry) => {
          const full = path.join(durableStateDir, entry.name);
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        })
        .sort((left, right) => right.mtimeMs - left.mtimeMs);
      for (const item of files.slice(Math.max(maxJobs, 10))) fs.rmSync(item.full, { force: true });
    } catch {}
  }

  function start({ type = "generation", metadata = {}, run } = {}) {
    if (typeof run !== "function") throw new TypeError("background job run function required");
    trimMemory();
    trimPersisted();
    const jobId = "fiction-" + Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8);
    const job = {
      jobId,
      type: String(type || "generation").slice(0, 40),
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      metadata: { ...(metadata || {}) },
      progress: null,
      result: null,
      error: null,
      recovered: false
    };
    jobs.set(jobId, job);
    persistJob(job);

    job.promise = Promise.resolve().then(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      persistJob(job);
      try {
        job.result = await run({
          updateProgress(next) {
            if (!next || typeof next !== "object" || Array.isArray(next)) return;
            job.progress = { ...next };
            persistJob(job);
          }
        });
        job.status = "completed";
      } catch (error) {
        job.error = safeError(error);
        job.status = "failed";
      } finally {
        job.completedAt = new Date().toISOString();
        persistJob(job);
        trimMemory();
        trimPersisted();
      }
      return publicJob(job);
    });

    return publicJob(job);
  }

  function get(jobId) {
    const id = String(jobId || "");
    return publicJob(jobs.get(id)) || publicJob(readPersisted(id));
  }

  return Object.freeze({ start, get, stateDir: durable ? durableStateDir : null });
}

module.exports = { createGenerationJobManager, defaultStateDir };
