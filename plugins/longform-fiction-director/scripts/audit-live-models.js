"use strict";

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createRuntime } = require("../server/mcp-server");
const { accountMode } = require("../server/billing-guard");

function publicError(error) {
  return {
    code: String(error?.code || error?.name || "UNKNOWN").slice(0, 80),
    status: Number.isInteger(error?.status) ? error.status : null,
    message: String(error?.publicMessage || error?.message || "").slice(0, 300)
  };
}

function normalizeRequested(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
}

async function runSingleModel(modelId) {
  const runtime = createRuntime();
  try {
    const response = await runtime.gateway.callModels({
      prompt: "只返回 OK，不要解释，不要 Markdown。",
      system: "这是模型可用性检查。只输出 OK。",
      modelIds: [modelId],
      taskLabel: "live-model-audit",
      maxTokens: 256
    });
    const output = response?.outputs?.[0] || {};
    const content = String(response?.content || output.content || "").trim();
    process.stdout.write(`${JSON.stringify({
      modelId,
      ok: content.length > 0,
      chars: content.length,
      transport: output.transport || null,
      finishReason: output.finishReason || null,
      preview: content.slice(0, 80),
      error: content.length > 0 ? null : { code: "EMPTY_MODEL_OUTPUT", message: "Model returned no content." }
    })}\n`);
    process.exitCode = content.length > 0 ? 0 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ modelId, ok: false, chars: 0, transport: null, finishReason: null, preview: "", error: publicError(error) })}\n`);
    process.exitCode = 2;
  } finally {
    await runtime.close().catch(() => {});
  }
}

function runSingleModelWithTimeout(modelId, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [__filename, "--single", modelId], {
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({
        modelId,
        ok: false,
        chars: 0,
        transport: null,
        finishReason: null,
        preview: "",
        error: { code: "MODEL_TIMEOUT", message: `Model did not return within ${timeoutMs} ms.` }
      });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ modelId, ok: false, chars: 0, transport: null, finishReason: null, preview: "", error: publicError(error) }));
    child.on("close", (code) => {
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      let parsed = null;
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { parsed = JSON.parse(lines[index]); break; } catch {}
      }
      if (parsed && typeof parsed === "object") return finish(parsed);
      finish({
        modelId,
        ok: false,
        chars: 0,
        transport: null,
        finishReason: null,
        preview: "",
        error: { code: `MODEL_PROCESS_${code ?? "UNKNOWN"}`, message: stderr.trim().slice(0, 300) || "Model audit process returned no result." }
      });
    });
  });
}

async function main() {
  if (process.env.FICTION_LIVE_MODEL_CONFIRMED !== "1") {
    throw Object.assign(
      new Error("Set FICTION_LIVE_MODEL_CONFIRMED=1 only after approving live model calls."),
      { code: "AUTHOR_CONFIRMATION_REQUIRED" }
    );
  }

  const runtime = createRuntime();
  try {
    const before = await runtime.gateway.accountStatus();
    if (!before?.loggedIn || before.active === false) {
      throw Object.assign(new Error("Gateway login is required."), { code: "AUTH_REQUIRED" });
    }
    const billing = accountMode(before);
    if (billing.mode !== "unlimited" && process.env.FICTION_LIVE_ALLOW_METERED !== "1") {
      throw Object.assign(
        new Error("The current account is metered. Set FICTION_LIVE_ALLOW_METERED=1 to approve paid audit calls."),
        { code: "METERED_AUDIT_REQUIRES_APPROVAL" }
      );
    }

    const catalogPayload = await runtime.gateway.listModels();
    const catalog = (Array.isArray(catalogPayload) ? catalogPayload : catalogPayload?.models || [])
      .filter((model) => model && typeof model.id === "string" && model.id.trim());
    const requested = normalizeRequested(process.argv.slice(2));
    const availableIds = new Set(catalog.map((model) => model.id));
    const modelIds = (requested.length ? requested.filter((id) => availableIds.has(id)) : catalog.map((model) => model.id));
    if (!modelIds.length) throw new Error("No requested models are present in the live catalog.");

    const results = [];
    const timeoutMs = Number.isSafeInteger(Number(process.env.FICTION_MODEL_AUDIT_TIMEOUT_MS))
      ? Math.max(30_000, Math.min(300_000, Number(process.env.FICTION_MODEL_AUDIT_TIMEOUT_MS)))
      : 120_000;
    for (const modelId of modelIds) {
      const startedAt = new Date().toISOString();
      const started = Date.now();
      results.push({
        ...(await runSingleModelWithTimeout(modelId, timeoutMs)),
        startedAt,
        durationMs: Date.now() - started
      });
      console.log(JSON.stringify({ modelId, ok: results.at(-1).ok, durationMs: results.at(-1).durationMs }));
    }

    const after = await runtime.gateway.accountStatus().catch(() => null);
    const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
    const reportPath = path.resolve(
      process.env.FICTION_MODEL_AUDIT_OUTPUT || path.join(os.tmpdir(), `longform-fiction-model-audit-${stamp}.json`)
    );
    const report = {
      generatedAt: new Date().toISOString(),
      account: { username: before.user?.username || null, mode: billing.mode, plan: billing.plan || null },
      catalogCount: catalog.length,
      catalogModels: catalog.map((model) => ({ id: model.id, credits: model.credits ?? null })),
      requestedModels: modelIds,
      passed: results.filter((item) => item.ok).length,
      failed: results.filter((item) => !item.ok).length,
      balanceBefore: billing.balance,
      balanceAfter: accountMode(after).balance,
      results
    };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({
      ok: report.failed === 0,
      catalogCount: report.catalogCount,
      tested: modelIds.length,
      passed: report.passed,
      failed: report.failed,
      reportPath,
      accountMode: billing.mode
    }, null, 2));
    if (report.failed) process.exitCode = 2;
  } finally {
    await runtime.close().catch(() => {});
  }
}

const singleModelId = process.argv[2] === "--single" ? String(process.argv[3] || "").trim() : "";
(singleModelId ? runSingleModel(singleModelId) : main()).catch((error) => {
  console.error(JSON.stringify({ ok: false, error: publicError(error) }, null, 2));
  process.exitCode = 1;
});
