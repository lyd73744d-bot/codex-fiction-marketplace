"use strict";

const crypto = require("node:crypto");

const TERMINAL_STATES = new Set(["completed", "failed"]);

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
    ...(job.status === "completed" ? { result: job.result } : {}),
    ...(job.status === "failed" ? { error: job.error } : {})
  };
}

function createGenerationJobManager({ maxJobs = 40 } = {}) {
  const jobs = new Map();

  function trim() {
    if (jobs.size <= maxJobs) return;
    for (const [jobId, job] of jobs) {
      if (!TERMINAL_STATES.has(job.status)) continue;
      jobs.delete(jobId);
      if (jobs.size <= maxJobs) break;
    }
  }

  function start({ type = "generation", metadata = {}, run } = {}) {
    if (typeof run !== "function") throw new TypeError("background job run function required");
    trim();
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
      error: null
    };
    jobs.set(jobId, job);

    job.promise = Promise.resolve().then(async () => {
      job.status = "running";
      job.startedAt = new Date().toISOString();
      try {
        job.result = await run({
          updateProgress(next) {
            if (!next || typeof next !== "object" || Array.isArray(next)) return;
            job.progress = { ...next };
          }
        });
        job.status = "completed";
      } catch (error) {
        job.error = safeError(error);
        job.status = "failed";
      } finally {
        job.completedAt = new Date().toISOString();
        trim();
      }
      return publicJob(job);
    });

    return publicJob(job);
  }

  function get(jobId) {
    return publicJob(jobs.get(String(jobId || "")));
  }

  return Object.freeze({ start, get });
}

module.exports = { createGenerationJobManager };
