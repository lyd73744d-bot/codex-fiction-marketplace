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
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
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

function extractModelPayload(result, fallbackModelId = "") {
  let content = "";
  let modelId = fallbackModelId || "";
  let transport = "unknown";
  if (typeof result === "string") {
    content = result;
    transport = "string";
  } else if (result && typeof result === "object") {
    transport = String(result.transport || result.mode || "gateway");
    if (typeof result.content === "string") content = result.content;
    else if (typeof result.text === "string") content = result.text;
    else if (Array.isArray(result.outputs) && result.outputs.length) {
      const last = result.outputs[result.outputs.length - 1];
      content = String(last?.content || last?.text || "");
      modelId = last?.model || last?.modelId || modelId;
      transport = String(last?.transport || result.transport || transport);
    } else if (Array.isArray(result.choices) && result.choices[0]?.message?.content) {
      content = String(result.choices[0].message.content);
    } else {
      content = "";
    }
    if (result.modelId) modelId = String(result.modelId);
    if (result.model) modelId = String(result.model);
  }
  content = String(content || "").replace(/\r\n?/g, "\n").trim();
  return { content, modelId, transport };
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
  ].filter(Boolean).join("\n");
  const body = content.replace(/\r\n?/g, "\n").trim() + "\n";
  await fsp.writeFile(filePath, header + body, "utf8");
  const plainPath = path.join(dir, parts.join("_") + ".body." + fileExt);
  await fsp.writeFile(plainPath, body, "utf8");
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
  streamRetries = 1,
  outerAttempts = 1,
  fallbackChain = true,
  minChars = 0,
  applyHardGates = true,
  maxTokens
} = {}) {
  if (!gateway || typeof gateway.callModels !== "function") throw new Error("gateway.callModels required");
  if (!projectDir) throw new Error("projectDir required");
  if (!prompt || !String(prompt).trim()) throw new Error("prompt required");
  const ids = Array.isArray(modelIds) ? modelIds.filter(Boolean) : [];
  if (!ids.length) throw new Error("modelIds required");

  let lastError = null;
  let lastTransport = "none";
  let lastGate = null;
  let fallbackAttempts = [];
  const attempts = 1;
  const retries = Math.max(1, Math.min(Number(streamRetries) || 1, 2));
  const useFallback = fallbackChain !== false && ids.length > 1;

  async function callOne(modelId) {
    const result = await gateway.callModels({
      prompt: String(prompt),
      system: system ? String(system) : undefined,
      modelIds: [modelId],
      taskLabel: String(taskLabel || kind || "fiction").slice(0, 64),
      streamRetries: retries,
      ...(maxTokens == null ? {} : { maxTokens: Number(maxTokens) })
    });
    const extracted = extractModelPayload(result, modelId);
    lastTransport = extracted.transport;
    if (!extracted.content || extracted.content.replace(/\s+/g, "").length < 8) {
      throw Object.assign(new Error("empty_or_too_short_model_output"), { code: "EMPTY_MODEL_OUTPUT" });
    }
    if (applyHardGates) {
      const check = isAcceptableCandidate(extracted.content, { minChars: Number(minChars) || 0 });
      lastGate = check.gate;
      if (!check.ok) {
        const err = new Error("hard_gate_failed:" + check.blockers.map((b) => b.rule).join(","));
        err.code = "HARD_GATE_FAILED";
        err.blockers = check.blockers;
        err.gate = check.gate;
        throw err;
      }
    } else {
      lastGate = inspectChapter(extracted.content, { minChars: Number(minChars) || 0 });
    }
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
          streamFirst: true,
          outerAttempt: attempt,
          streamRetries: retries,
          fallbackChain: useFallback,
          degraded,
          hardGateOk: !lastGate || lastGate.ok !== false,
          hardGateIssues: lastGate && Array.isArray(lastGate.issues) ? lastGate.issues : [],
          fallbackAttempts: fallbackAttempts.slice(-12),
          note: "完整候选 txt；.body 纯正文可再喂模型"
        }
      });

      const previewLimit = Math.max(120, Math.min(Number(previewChars) || 800, 4000));
      return {
        ok: true,
        artifact: saved,
        modelId,
        transport: lastTransport,
        attempt,
        outerAttempt: attempt,
        degraded,
        hardGate: lastGate,
        fallbackAttempts,
        preview: content.slice(0, previewLimit),
        coach: "候选已完整落盘。可读 " + saved.relativePath + " 与纯正文 " + saved.plainRelativePath +
          (saved.memoryRecord ? "；写作记录已更新 " + saved.memoryRecord.relativePath + "。" : "；写作记录未更新，请保留当前候选路径。") +
          "作者确认前不入正式正文/台账。"
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
  extractModelPayload
};
