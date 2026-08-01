"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { createGatewayClient } = require("../server/gateway-client");

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function fileSafe(value) {
  return String(value || "model").replace(/[^A-Za-z0-9._-]+/gu, "-").slice(0, 80);
}

function publicError(error) {
  return {
    code: String(error?.code || error?.name || "UNKNOWN").slice(0, 80),
    status: Number.isInteger(error?.status) ? error.status : null,
    publicMessage: typeof error?.publicMessage === "string" ? error.publicMessage.slice(0, 300) : null,
    request: error?.request || null,
    network: error?.networkDiagnostics || null
  };
}

async function main() {
  if (process.env.FICTION_STRESS_CONFIRMED !== "1") {
    throw Object.assign(new Error("Set FICTION_STRESS_CONFIRMED=1 only after the author approves this paid stress test."), { code: "AUTHOR_CONFIRMATION_REQUIRED" });
  }

  const runs = boundedInteger(process.env.FICTION_STRESS_RUNS, 12, 2, 24);
  const concurrency = boundedInteger(process.env.FICTION_STRESS_CONCURRENCY, 3, 1, 6);
  const maxTokens = boundedInteger(process.env.FICTION_STRESS_MAX_TOKENS, 8192, 2048, 65536);
  const requested = (process.env.FICTION_STRESS_MODELS || "glm-5.2,gemini-3.1-pro-preview")
    .split(",").map((item) => item.trim()).filter(Boolean);
  if (!requested.length) throw new Error("FICTION_STRESS_MODELS contains no model ids");

  const gateway = createGatewayClient();
  const before = await gateway.accountStatus();
  if (!before?.loggedIn) throw Object.assign(new Error("Gateway login is required."), { code: "AUTH_REQUIRED" });
  const catalog = await gateway.listModels();
  const available = new Set((catalog.models || []).map((item) => item?.id).filter(Boolean));
  const models = [...new Set(requested)].filter((id) => available.has(id));
  if (!models.length) throw new Error(`None of the requested stress models are available: ${requested.join(", ")}`);

  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputDir = path.resolve(process.env.FICTION_STRESS_OUTPUT || path.join(process.cwd(), ".local", "stress", stamp));
  await fs.mkdir(outputDir, { recursive: true });

  const tasks = Array.from({ length: runs }, (_, index) => ({ index: index + 1, model: models[index % models.length] }));
  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (cursor < tasks.length) {
      const task = tasks[cursor];
      cursor += 1;
      const startedAt = new Date();
      const started = Date.now();
      try {
        const response = await gateway.callModels({
          prompt: `这是网络压力测试第 ${task.index} 次。请写一段 180 至 260 字的明末军营小说片段：一个小校在雨夜送来被压了三天的军报，主将只问两句话便发现还有人在帐外偷听。人物不要解释自己的动机，结尾写 [END-${task.index}]。`,
          system: "只返回小说正文，不解释测试，不列提纲。",
          modelIds: [task.model],
          taskLabel: `stress-${task.index}`,
          streamRetries: 2,
          maxTokens
        });
        const content = String(response.content || "");
        const output = response.outputs?.[0] || {};
        const finishReason = String(output.finishReason || "").toLowerCase();
        const transport = String(output.transport || "");
        const endMarker = content.includes(`[END-${task.index}]`);
        const issues = [];
        if (content.replace(/\s+/gu, "").length < 120) issues.push("too_short");
        if (finishReason === "length") issues.push("token_limit");
        if (transport.startsWith("partial_")) issues.push("partial_transport");
        if (!endMarker) issues.push("missing_end_marker");
        const textPath = path.join(outputDir, `${String(task.index).padStart(2, "0")}-${fileSafe(task.model)}.txt`);
        await fs.writeFile(textPath, content, "utf8");
        results[task.index - 1] = {
          index: task.index,
          model: task.model,
          ok: issues.length === 0,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - started,
          chars: content.length,
          transport: transport || null,
          finishReason: output.finishReason || null,
          endMarker,
          issues,
          outputFile: path.basename(textPath)
        };
      } catch (error) {
        results[task.index - 1] = {
          index: task.index,
          model: task.model,
          ok: false,
          startedAt: startedAt.toISOString(),
          durationMs: Date.now() - started,
          chars: 0,
          error: publicError(error)
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  const after = await gateway.accountStatus().catch(() => null);
  const byModel = {};
  for (const model of models) {
    const subset = results.filter((item) => item.model === model);
    const successes = subset.filter((item) => item.ok);
    byModel[model] = {
      runs: subset.length,
      successes: successes.length,
      failures: subset.length - successes.length,
      averageDurationMs: successes.length ? Math.round(successes.reduce((sum, item) => sum + item.durationMs, 0) / successes.length) : null,
      averageChars: successes.length ? Math.round(successes.reduce((sum, item) => sum + item.chars, 0) / successes.length) : null
    };
  }
  const balanceBefore = Number(before.balance ?? before.user?.balance);
  const balanceAfter = Number(after?.balance ?? after?.user?.balance);
  const report = {
    generatedAt: new Date().toISOString(),
    runs,
    concurrency,
    maxTokens,
    models,
    successes: results.filter((item) => item.ok).length,
    failures: results.filter((item) => !item.ok).length,
    balanceBefore: Number.isFinite(balanceBefore) ? balanceBefore : null,
    balanceAfter: Number.isFinite(balanceAfter) ? balanceAfter : null,
    creditsUsed: Number.isFinite(balanceBefore) && Number.isFinite(balanceAfter) ? balanceBefore - balanceAfter : null,
    byModel,
    results
  };
  const reportPath = path.join(outputDir, "stress-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ ...report, results: undefined, outputDir, reportPath }, null, 2));
  if (report.failures) process.exitCode = 2;
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, error: publicError(error) }, null, 2));
  process.exit(1);
});
