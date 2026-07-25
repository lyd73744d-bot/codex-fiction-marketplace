"use strict";

function compact(value) {
  return String(value || "").trim();
}

/**
 * Try models in order until one returns valid content.
 * Used for draft generation reliability: stream/txt must come out.
 */
async function runModelFallback(options = {}) {
  if (!Array.isArray(options.modelIds) || !options.modelIds.length) {
    throw new Error("缺少模型回退顺序");
  }
  if (typeof options.callModel !== "function") {
    throw new Error("缺少模型调用器");
  }

  const modelIds = [...new Set(options.modelIds.map(compact).filter(Boolean))];
  const attempts = [];

  for (let index = 0; index < modelIds.length; index += 1) {
    const modelId = modelIds[index];
    const startedAt = Date.now();
    if (typeof options.onAttempt === "function") {
      options.onAttempt({ modelId, index, total: modelIds.length, status: "started" });
    }
    try {
      const content = compact(await options.callModel({ modelId, index, total: modelIds.length }));
      if (!content) {
        throw Object.assign(new Error(modelId + " 没有返回可用内容"), { code: "EMPTY_MODEL_OUTPUT" });
      }
      if (typeof options.validate === "function") {
        const ok = await options.validate(content, { modelId, index });
        if (!ok) {
          throw Object.assign(new Error(modelId + " 返回内容未通过完整性检查"), { code: "INVALID_MODEL_OUTPUT" });
        }
      }
      const attempt = { modelId, status: "completed", durationMs: Date.now() - startedAt };
      attempts.push(attempt);
      if (typeof options.onAttempt === "function") {
        options.onAttempt({ ...attempt, index, total: modelIds.length });
      }
      return {
        content,
        acceptedModelId: modelId,
        degraded: index > 0,
        attempts
      };
    } catch (error) {
      const attempt = {
        modelId,
        status: "failed",
        durationMs: Date.now() - startedAt,
        errorCode: compact(error && (error.code || error.name) || "MODEL_FAILED"),
        errorMessage: compact(error && (error.message || error))
      };
      attempts.push(attempt);
      if (typeof options.onAttempt === "function") {
        options.onAttempt({ ...attempt, index, total: modelIds.length });
      }
    }
  }

  const error = new Error("所有模型均未返回可用内容：" + attempts.map((item) => item.modelId).join(" → "));
  error.code = "MODEL_FALLBACK_EXHAUSTED";
  error.attempts = attempts;
  throw error;
}

module.exports = { runModelFallback };
