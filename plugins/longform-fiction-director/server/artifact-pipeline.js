"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { runModelFallback } = require("./model-fallback-runner");
const { isAcceptableCandidate, inspectChapter } = require("./writing-hard-gates");

function safeSegment(value, fallback = "item") {
  const raw = String(value || fallback).trim() || fallback;
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, "_").slice(0, 80) || fallback;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + String(d.getMilliseconds()).padStart(3, "0");
}

function candidateDir(projectDir) {
  return path.join(projectDir, "Codex候选");
}

function reviewDir(projectDir) {
  return path.join(projectDir, "审稿记录");
}

function modelWritingRecordPath(projectDir) {
  return path.join(reviewDir(projectDir), "模型写作记录.md");
}

const recordQueues = new Map();

function projectRelative(projectDir, filePath) {
  return path.relative(projectDir, filePath).split(path.sep).join("/");
}

function recordValue(value, fallback = "未填写") {
  const text = String(value || "").replace(/\r?\n/g, " ").replace(/`/g, "'").replace(/\s+/g, " ").trim();
  return (text || fallback).slice(0, 180);
}

function shouldRecordModelOutput(modelId, meta = {}) {
  if (meta.recordModelOutput === false) return false;
  if (meta.recordModelOutput === true) return true;
  const id = String(modelId || "").trim().toLowerCase();
  if (!id) return false;
  return !/^(local|codex)(?:-|$)/.test(id);
}

async function appendModelWritingRecord({
  projectDir,
  kind,
  title,
  chapterNo,
  modelId,
  createdAt,
  filePath,
  plainPath,
  chars
}) {
  await ensureDir(reviewDir(projectDir));
  const logPath = modelWritingRecordPath(projectDir);
  const entry = [
    "",
    "## " + createdAt + " · " + recordValue(kind, "model_output"),
    "",
    "- 模型：`" + recordValue(modelId, "external-model") + "`",
    "- 标题：" + recordValue(title),
    "- 章节：" + recordValue(chapterNo),
    "- 候选文件：`" + projectRelative(projectDir, filePath) + "`",
    "- 纯文本：`" + projectRelative(projectDir, plainPath) + "`",
    "- 非空字符：" + Number(chars || 0),
    "- 状态：候选，尚未由作者确认；不得作为正文事实或正式台账依据。",
    "",
    "---",
    ""
  ].join("\n");
  const header = [
    "# 模型写作记录",
    "",
    "> 本文件是外部模型输出的过程索引。继续写作时先看索引，再按需读取对应 `.body.txt`。",
    "> 未经作者确认的候选只用于恢复写作过程，不得当作人物、设定、时间线或正文事实。",
    ""
  ].join("\n");

  const previous = recordQueues.get(logPath) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    let needsHeader = true;
    try {
      const stat = await fsp.stat(logPath);
      needsHeader = !stat.isFile() || stat.size === 0;
    } catch {}
    if (needsHeader) await fsp.writeFile(logPath, header, "utf8");
    await fsp.appendFile(logPath, entry, "utf8");
    return {
      ok: true,
      path: logPath,
      relativePath: projectRelative(projectDir, logPath)
    };
  });
  recordQueues.set(logPath, current);
  try {
    return await current;
  } finally {
    if (recordQueues.get(logPath) === current) recordQueues.delete(logPath);
  }
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeTextAtomic(filePath, content) {
  const tempPath = filePath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  try {
    await fsp.writeFile(tempPath, content, "utf8");
    await fsp.rename(tempPath, filePath);
  } finally {
    await fsp.unlink(tempPath).catch(() => {});
  }
}

function extractModelPayload(result, fallbackModelId = "") {
  let content = "";
  let modelId = fallbackModelId || "";
  let transport = "unknown";
  let finishReason = null;
  if (typeof result === "string") {
    content = result;
    transport = "string";
  } else if (result && typeof result === "object") {
    transport = String(result.transport || result.mode || "gateway");
    finishReason = result.finishReason ?? result.finish_reason ?? null;
    if (typeof result.content === "string") content = result.content;
    else if (typeof result.text === "string") content = result.text;
    if (Array.isArray(result.outputs) && result.outputs.length) {
      const last = result.outputs[result.outputs.length - 1];
      if (!content) content = String(last?.content || last?.text || "");
      modelId = last?.model || last?.modelId || modelId;
      transport = String(last?.transport || result.transport || transport);
      finishReason = last?.finishReason ?? last?.finish_reason ?? finishReason;
    }
    if (!content && Array.isArray(result.choices) && result.choices[0]?.message?.content) {
      content = String(result.choices[0].message.content);
    }
    if (result.modelId) modelId = String(result.modelId);
    if (result.model) modelId = String(result.model);
  }
  content = String(content || "").replace(/\r\n?/g, "\n").trim();
  let reasoningBlocksRemoved = 0;
  content = content.replace(/<(think|thinking|analysis|reasoning)(?:\s[^>]*)?>[\s\S]*?<\/\1\s*>/giu, () => {
    reasoningBlocksRemoved += 1;
    return "";
  });
  content = content.replace(/<(think|thinking|analysis|reasoning)(?:\s[^>]*)?>[\s\S]*$/iu, () => {
    reasoningBlocksRemoved += 1;
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { content, modelId, transport, finishReason, reasoningBlocksRemoved };
}

function hasAbruptProseEnding(value = "") {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (!text) return false;
  const unwrapped = text.replace(/[\s"'”’）)\]】》」』]+$/gu, "");
  return !/[。！？!?….…—]$/u.test(unwrapped);
}

async function writeArtifact({ projectDir, kind = "draft", title = "", chapterNo = "", modelId = "", content, ext = "txt", meta = {} } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (typeof content !== "string" || !content.trim()) throw new Error("content required");
  const dir = await ensureDir(candidateDir(projectDir));
  const parts = [stamp(), safeSegment(kind, "draft")];
  if (chapterNo) parts.push("ch" + safeSegment(chapterNo, "x"));
  if (title) parts.push(safeSegment(title, "untitled"));
  if (modelId) parts.push(safeSegment(modelId, "model"));
  const fileExt = String(ext || "txt").replace(/^\./, "") || "txt";
  const filePath = path.join(dir, parts.join("_") + "." + fileExt);
  const createdAt = new Date().toISOString();
  const artifactMeta = { ...(meta || {}) };
  delete artifactMeta.recordModelOutput;
  const header = [
    "# artifact",
    "kind: " + kind,
    "title: " + (title || ""),
    "chapterNo: " + (chapterNo || ""),
    "modelId: " + (modelId || ""),
    "createdAt: " + createdAt,
    "readableByModel: plainPath 是纯正文，可直接再喂给模型",
    "note: 候选稿/模型输出，作者确认前不得当作正式正文。",
    Object.keys(artifactMeta).length ? "meta: " + JSON.stringify(artifactMeta) : "",
    "---",
    ""
  ].filter(Boolean).join("\n") + "\n\n";
  const body = content.replace(/\r\n?/g, "\n").trim() + "\n";
  await writeTextAtomic(filePath, header + body);
  const plainPath = path.join(dir, parts.join("_") + ".body." + fileExt);
  await writeTextAtomic(plainPath, body);
  const chars = body.replace(/\s+/g, "").length;
  let memoryRecord = null;
  let memoryRecordError = null;
  if (shouldRecordModelOutput(modelId, meta)) {
    try {
      memoryRecord = await appendModelWritingRecord({
        projectDir,
        kind,
        title,
        chapterNo,
        modelId: modelId || "external-model",
        createdAt,
        filePath,
        plainPath,
        chars
      });
    } catch (error) {
      memoryRecordError = String(error?.message || error || "model_record_failed");
    }
  }
  return {
    ok: true,
    path: filePath,
    plainPath,
    relativePath: path.relative(projectDir, filePath),
    plainRelativePath: path.relative(projectDir, plainPath),
    bytes: Buffer.byteLength(body, "utf8"),
    chars,
    modelReadable: true,
    recordedForMemory: Boolean(memoryRecord),
    memoryRecord,
    memoryRecordError
  };
}

async function readArtifact(filePath, { maxChars = 200000 } = {}) {
  const abs = path.resolve(String(filePath || ""));
  // Prefer .body. plain file if paired header file is given
  let target = abs;
  if (!/\.body\./i.test(abs)) {
    const plainGuess = abs.replace(/(\.[^.]+)$/i, ".body$1");
    if (fs.existsSync(plainGuess)) target = plainGuess;
  }
  const raw = await fsp.readFile(target, "utf8");
  let body = raw;
  const sep = raw.indexOf("\n---\n");
  if (sep >= 0 && !/\.body\./i.test(target)) body = raw.slice(sep + 5);
  body = body.replace(/\r\n?/g, "\n");
  if (body.length > maxChars) {
    return { ok: true, path: target, sourcePath: abs, truncated: true, content: body.slice(0, maxChars), totalChars: body.length, modelReadable: true };
  }
  return { ok: true, path: target, sourcePath: abs, truncated: false, content: body, totalChars: body.length, modelReadable: true };
}

async function listArtifacts(projectDir, { limit = 30 } = {}) {
  const dir = candidateDir(projectDir);
  if (!fs.existsSync(dir)) return { ok: true, items: [] };
  const names = await fsp.readdir(dir);
  const items = [];
  for (const name of names) {
    if (!/\.(txt|md)$/i.test(name)) continue;
    if (/\.body\./i.test(name)) continue;
    const full = path.join(dir, name);
    const st = await fsp.stat(full);
    if (!st.isFile()) continue;
    const plain = full.replace(/(\.[^.]+)$/i, ".body$1");
    items.push({
      name,
      path: full,
      plainPath: fs.existsSync(plain) ? plain : null,
      relativePath: path.relative(projectDir, full),
      bytes: st.size,
      mtime: st.mtime.toISOString(),
      modelReadable: true
    });
  }
  items.sort((a, b) => (a.mtime < b.mtime ? 1 : -1));
  return { ok: true, items: items.slice(0, Math.max(1, limit)) };
}

/**
 * Stream-first generation with gateway retries, then non-stream fallback inside gateway.
 * Always persists complete text to Codex候选/*.txt (+ .body.txt plain for model reread).
 */
async function generateToArtifact({
  gateway,
  projectDir,
  kind = "draft",
  title = "",
  chapterNo = "",
  modelIds = [],
  system = "",
  prompt = "",
  taskLabel = "fiction",
  previewChars = 800,
  streamRetries = 2,
  outerAttempts = 1,
  fallbackChain = true,
  minChars = 0,
  applyHardGates = true,
  maxTokens,
  requestPolicyVersion = "caller-only",
  contextSanitization = null
} = {}) {
  if (!gateway || typeof gateway.callModels !== "function") throw new Error("gateway.callModels required");
  if (!projectDir) throw new Error("projectDir required");
  if (!prompt || !String(prompt).trim()) throw new Error("prompt required");
  const ids = Array.isArray(modelIds) ? modelIds.filter(Boolean) : [];
  if (!ids.length) throw new Error("modelIds required");

  let lastError = null;
  let lastTransport = "none";
  let lastFinishReason = null;
  let lastGate = null;
  let lastPartial = false;
  let lastAbruptEnding = false;
  let reasoningBlocksRemoved = 0;
  let fallbackAttempts = [];
  const attempts = 1;
  const retries = Math.max(1, Math.min(Number(streamRetries) || 1, 2));
  const useFallback = fallbackChain !== false && ids.length > 1;

  async function callOne(modelId) {
    let extracted;
    try {
      const result = await gateway.callModels({
        prompt: String(prompt),
        system: system ? String(system) : undefined,
        modelIds: [modelId],
        taskLabel: String(taskLabel || kind || "fiction").slice(0, 64),
        streamRetries: retries,
        ...(maxTokens == null ? {} : { maxTokens: Number(maxTokens) })
      });
      extracted = extractModelPayload(result, modelId);
    } catch (error) {
      const partial = String(error?.partialContent || "").replace(/\r\n?/g, "\n").trim();
      if (!partial) throw error;
      extracted = extractModelPayload({ content: partial, modelId, transport: "partial_error", finishReason: error?.finishReason || null }, modelId);
      lastPartial = true;
    }
    reasoningBlocksRemoved += Number(extracted.reasoningBlocksRemoved || 0);
    lastTransport = extracted.transport;
    lastFinishReason = extracted.finishReason;
    if (!extracted.content || !extracted.content.replace(/\s+/g, "")) {
      throw Object.assign(new Error("empty_model_output"), { code: "EMPTY_MODEL_OUTPUT" });
    }
    if (applyHardGates) {
      const check = isAcceptableCandidate(extracted.content, { minChars: Number(minChars) || 0 });
      lastGate = check.gate;
    } else {
      lastGate = inspectChapter(extracted.content, { minChars: Number(minChars) || 0 });
    }
    lastAbruptEnding = Number(minChars) > 0 && hasAbruptProseEnding(extracted.content);
    if (lastAbruptEnding) lastPartial = true;
    return extracted.content;
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let content = "";
      let modelId = ids[0];
      let degraded = false;

      if (useFallback) {
        const fb = await runModelFallback({
          modelIds: ids,
          callModel: async ({ modelId: mid }) => callOne(mid),
          onAttempt: (info) => { fallbackAttempts.push(info); }
        });
        content = fb.content;
        modelId = fb.acceptedModelId;
        degraded = fb.degraded;
        fallbackAttempts = fb.attempts;
      } else {
        // single model or explicit multi-pass: still call first id with stream retries inside gateway
        content = await callOne(ids[0]);
        modelId = ids[0];
      }

      const saved = await writeArtifact({
        projectDir,
        kind,
        title,
        chapterNo,
        modelId,
        content,
        ext: "txt",
        meta: {
          transport: lastTransport,
          finishReason: lastFinishReason,
          streamFirst: true,
          outerAttempt: attempt,
          streamRetries: retries,
          fallbackChain: useFallback,
          degraded,
          partial: lastPartial || /^partial_/u.test(lastTransport),
          abruptEnding: lastAbruptEnding,
          hardGateOk: !lastGate || lastGate.ok !== false,
          hardGateIssues: lastGate && Array.isArray(lastGate.issues) ? lastGate.issues : [],
          requestPolicyVersion: String(requestPolicyVersion || "caller-only"),
          contextSanitization: contextSanitization && typeof contextSanitization === "object"
            ? contextSanitization
            : null,
          reasoningBlocksRemoved,
          fallbackAttempts: fallbackAttempts.slice(-12),
          note: "模型返回即保存为候选 txt；中途断线也保留已收到正文；.body 纯正文可再喂模型，质量检查仅提示不拦截落盘"
        }
      });

      const previewLimit = Math.max(120, Math.min(Number(previewChars) || 800, 4000));
      return {
        ok: true,
        artifact: saved,
        modelId,
        transport: lastTransport,
        finishReason: lastFinishReason,
        attempt,
        outerAttempt: attempt,
        degraded,
        partial: lastPartial || /^partial_/u.test(lastTransport),
        abruptEnding: lastAbruptEnding,
        hardGate: lastGate,
        fallbackAttempts,
        contextSanitization,
        reasoningBlocksRemoved,
        preview: content.slice(0, previewLimit),
        coach: "模型输出已落盘。可读 " + saved.relativePath + " 与纯正文 " + saved.plainRelativePath +
          (saved.memoryRecord ? "；写作记录已更新 " + saved.memoryRecord.relativePath + "。" : "；写作记录未更新，请保留当前候选路径。") +
          (lastPartial || /^partial_/u.test(lastTransport)
            ? "当前只算已保存的正文段落，不算完整章；需要续写时从 .body.txt 最后一个字接下去。"
            : "作者确认前不入正式正文/台账。")
      };
    } catch (error) {
      lastError = error;
    }
  }

  const err = lastError || new Error("generate_to_artifact_failed");
  err.transport = lastTransport;
  err.hardGate = lastGate;
  err.fallbackAttempts = fallbackAttempts;
  throw err;
}

module.exports = {
  writeArtifact,
  readArtifact,
  listArtifacts,
  generateToArtifact,
  candidateDir,
  modelWritingRecordPath,
  extractModelPayload,
  hasAbruptProseEnding
};
