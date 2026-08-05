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

function chapterDir(projectDir) {
  return path.join(projectDir, "正文");
}

function chapterFileBase(chapterNo, title) {
  const no = String(chapterNo || "").trim();
  const padded = /^\d+$/.test(no) ? no.padStart(3, "0") : safeSegment(no, "000");
  const name = String(title || "").trim();
  return name ? "第" + padded + "章_" + safeSegment(name, "正文") : "第" + padded + "章";
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

async function renameWithRetry(sourcePath, targetPath, {
  rename = fsp.rename,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  retries = 5
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(sourcePath, targetPath);
      return;
    } catch (error) {
      const retryable = ["EPERM", "EACCES", "EBUSY"].includes(String(error?.code || ""));
      if (!retryable || attempt >= retries) throw error;
      await wait(25 * (2 ** attempt));
    }
  }
}

async function writeTextAtomic(filePath, content) {
  const tempPath = filePath + ".tmp-" + process.pid + "-" + Math.random().toString(16).slice(2);
  try {
    await fsp.writeFile(tempPath, content, "utf8");
    await renameWithRetry(tempPath, filePath);
  } finally {
    await fsp.unlink(tempPath).catch(() => {});
  }
}

function publicProgressError(error) {
  return {
    code: String(error?.code || error?.name || "GENERATION_FAILED").slice(0, 80),
    message: String(error?.publicMessage || error?.message || "generation failed").slice(0, 240)
  };
}

async function collectExistingWritingFiles(projectDir, limit = 8) {
  const roots = [
    { dir: path.join(projectDir, "正文"), source: "正文" },
    { dir: candidateDir(projectDir), source: "候选" }
  ];
  const items = [];
  async function walk(dir, source, depth = 0) {
    if (depth > 3) return;
    let entries = [];
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, source, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/\.(?:txt|md)$/iu.test(entry.name) || /\.in-progress\./u.test(entry.name)) continue;
      if (source === "候选" && !/\.body\.(?:txt|md)$/iu.test(entry.name)) continue;
      try {
        const stat = await fsp.stat(full);
        items.push({ path: full, source, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {}
    }
  }
  for (const root of roots) await walk(root.dir, root.source);
  return items.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, Math.max(1, limit));
}

function repeatedParagraphCount(text) {
  const seen = new Set();
  let repeats = 0;
  for (const paragraph of String(text || "").split(/\n\s*\n/u)) {
    const normalized = paragraph.replace(/\s+/gu, "").trim();
    if (normalized.length < 30) continue;
    if (seen.has(normalized)) repeats += 1;
    else seen.add(normalized);
  }
  return repeats;
}

const LEDGER_SPECS = Object.freeze([
  { key: "characters", label: "人物台账", files: ["02_人物台账.md"] },
  { key: "timeline", label: "时间线", files: ["04_时间线.md"] },
  { key: "foreshadowing", label: "伏笔管理", files: ["05_伏笔管理.md"] },
  { key: "facts", label: "事实库", files: ["08_事实库_防OOC.md", "12_事实库_防OOC.md"] }
]);

const TEMPLATE_GUIDANCE = [
  /^重要人物都记录在这里/u,
  /^时间不需要精确到日期/u,
  /^伏笔不是待办剧情/u,
  /^这里只记录/u,
  /^只记录已核验/u
];

function markdownRows(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) continue;
    const cells = trimmed.slice(1, -1).split("|").map((cell) => cell.trim());
    if (!cells.some(Boolean)) continue;
    if (cells.every((cell) => !cell || /^:?-{3,}:?$/u.test(cell))) continue;
    const joined = cells.join(" ");
    if (["名字", "时间/相对顺序", "线索"].includes(cells[0] || "")) continue;
    if (/已出现\s*\/\s*推进中\s*\/\s*已回收\s*\/\s*作废/u.test(joined)
      && cells.filter(Boolean).length === 1) continue;
    rows.push(cells);
  }
  return rows;
}

function markdownEntries(text) {
  const entries = markdownRows(text).map((cells) => cells.filter(Boolean).join(" | "));
  for (const line of String(text || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || /^#{1,6}\s/u.test(trimmed) || /^>/u.test(trimmed) || /^\|/u.test(trimmed)) continue;
    const bullet = trimmed.match(/^[-*+]\s+(.+)$/u);
    const value = (bullet ? bullet[1] : trimmed).trim();
    if (!value || value === "-" || TEMPLATE_GUIDANCE.some((pattern) => pattern.test(value))) continue;
    entries.push(value);
  }
  return [...new Set(entries)].slice(0, 200);
}

function cleanLedgerName(value) {
  const name = String(value || "").replace(/[*_`]/gu, "").trim();
  if (!name || name.length > 40 || /^(名字|人物|角色|时间|线索|待确认|未确认|已核验)/u.test(name)) return "";
  return name;
}

async function readLedgerSummary(projectDir, spec, recentText) {
  const auxiliaryDir = path.join(projectDir, "辅助文档");
  let selectedPath = null;
  for (const file of spec.files) {
    const candidate = path.join(auxiliaryDir, file);
    try {
      if ((await fsp.stat(candidate)).isFile()) { selectedPath = candidate; break; }
    } catch {}
  }
  if (!selectedPath) {
    return { key: spec.key, label: spec.label, status: "missing", path: null, entryCount: 0 };
  }

  try {
    const raw = await fsp.readFile(selectedPath, "utf8");
    const rows = markdownRows(raw);
    const entries = markdownEntries(raw);
    const summary = {
      key: spec.key,
      label: spec.label,
      status: entries.length ? "populated" : "empty",
      path: selectedPath,
      relativePath: projectRelative(projectDir, selectedPath),
      entryCount: entries.length
    };

    if (spec.key === "characters") {
      const headingNames = [...raw.matchAll(/^##+\s+(.+)$/gmu)].map((match) => cleanLedgerName(match[1]));
      const names = [...new Set([...rows.map((row) => cleanLedgerName(row[0])), ...headingNames].filter(Boolean))].slice(0, 80);
      summary.names = names;
      summary.mentionedInRecentWriting = names.filter((name) => recentText.includes(name));
    } else if (spec.key === "timeline") {
      const anchors = [...new Set(rows.map((row) => String(row[0] || "").trim()).filter(Boolean))].slice(0, 80);
      summary.anchors = anchors;
      summary.mentionedInRecentWriting = anchors.filter((anchor) => anchor.length >= 2 && recentText.includes(anchor));
    } else if (spec.key === "foreshadowing") {
      const active = rows.filter((row) => !/已回收|作废/u.test(row.join(" ")))
        .map((row) => String(row[0] || "").trim()).filter(Boolean).slice(0, 80);
      summary.activeEntries = active;
      summary.activeCount = active.length;
    } else if (spec.key === "facts") {
      const unresolved = entries.filter((entry) => /待核验|待确认|未知|未定|存疑|TODO|\?{2,}|？{2,}/iu.test(entry));
      summary.unresolvedCount = unresolved.length;
      summary.unresolvedEntries = unresolved.slice(0, 40);
    }
    return summary;
  } catch (error) {
    return {
      key: spec.key,
      label: spec.label,
      status: "error",
      path: selectedPath,
      relativePath: projectRelative(projectDir, selectedPath),
      entryCount: 0,
      error: publicProgressError(error)
    };
  }
}

async function inspectExistingWriting(projectDir, reportPath) {
  const files = await collectExistingWritingFiles(projectDir);
  const results = [];
  const recentTextParts = [];
  for (const item of files) {
    try {
      const raw = await fsp.readFile(item.path, "utf8");
      const text = raw.length > 1_000_000 ? raw.slice(-1_000_000) : raw;
      recentTextParts.push(text);
      const inspection = inspectChapter(text, { minChars: 0 });
      results.push({
        path: item.path,
        relativePath: projectRelative(projectDir, item.path),
        source: item.source,
        chars: inspection.chars,
        abruptEnding: hasAbruptProseEnding(text),
        repeatedParagraphs: repeatedParagraphCount(text),
        issues: inspection.issues
      });
    } catch (error) {
      results.push({
        path: item.path,
        relativePath: projectRelative(projectDir, item.path),
        source: item.source,
        error: publicProgressError(error)
      });
    }
  }
  const recentText = recentTextParts.join("\n").slice(-2_000_000);
  const ledgerItems = [];
  for (const spec of LEDGER_SPECS) ledgerItems.push(await readLedgerSummary(projectDir, spec, recentText));
  const ledgerStatus = {
    checked: ledgerItems.length,
    populated: ledgerItems.filter((item) => item.status === "populated").length,
    empty: ledgerItems.filter((item) => item.status === "empty").length,
    missing: ledgerItems.filter((item) => item.status === "missing").length,
    errors: ledgerItems.filter((item) => item.status === "error").length
  };
  const report = {
    checkedAt: new Date().toISOString(),
    projectDir,
    filesChecked: results.length,
    filesWithIssues: results.filter((item) => item.error || item.abruptEnding || item.repeatedParagraphs > 0 || item.issues?.length).length,
    results,
    ledgers: {
      ...ledgerStatus,
      items: ledgerItems
    },
    note: "等待模型返回期间的本地只读检查；台账结果只表示文件状态与文字覆盖，不据此擅自判定事实矛盾。未调用额外模型，未修改正式正文或事实台账。"
  };
  await writeTextAtomic(reportPath, JSON.stringify(report, null, 2) + "\n");
  return report;
}

async function createStreamCheckpoint({
  projectDir,
  kind,
  title,
  chapterNo,
  modelId,
  everyChars = 240,
  everyMs = 2000,
  onDelta,
  onProgress
} = {}) {
  const dir = await ensureDir(candidateDir(projectDir));
  const review = await ensureDir(reviewDir(projectDir));
  const parts = [stamp(), safeSegment(kind, "draft")];
  if (chapterNo) parts.push("ch" + safeSegment(chapterNo, "x"));
  if (title) parts.push(safeSegment(title, "untitled"));
  if (modelId) parts.push(safeSegment(modelId, "model"));
  const base = parts.join("_");
  const bodyPath = path.join(dir, base + ".in-progress.body.txt");
  const progressPath = path.join(review, base + ".progress.json");
  const waitingReviewPath = path.join(review, base + ".waiting-review.json");
  let content = "";
  let persistedChars = 0;
  let lastWriteAt = 0;
  let currentState = "waiting_first_token";
  let closed = false;
  let terminal = false;
  let lastExtra = {};
  let waitingReview = { state: "running", reportPath: waitingReviewPath };
  let waitingReviewTask = null;

  async function publish(state, extra = {}) {
    currentState = state;
    lastExtra = { ...lastExtra, ...extra };
    const inspection = inspectChapter(content, { minChars: 0 });
    const progress = {
      ...lastExtra,
      state,
      modelId: String(modelId || ""),
      kind: String(kind || "draft"),
      title: String(title || ""),
      chapterNo: String(chapterNo || ""),
      chars: inspection.chars,
      paragraphs: content ? content.split(/\n\s*\n/u).filter(Boolean).length : 0,
      sentenceComplete: content ? !hasAbruptProseEnding(content) : false,
      inspection: {
        ok: inspection.ok,
        issues: inspection.issues
      },
      checkpointPath: bodyPath,
      progressPath,
      waitingReview,
      updatedAt: new Date().toISOString(),
      ...extra
    };
    await writeTextAtomic(progressPath, JSON.stringify(progress, null, 2) + "\n");
    if (typeof onProgress === "function") {
      try { await onProgress(progress); } catch {}
    }
    return progress;
  }

  async function flush(state = "streaming", force = false, extra = {}) {
    const now = Date.now();
    if (!force && content.length - persistedChars < everyChars && now - lastWriteAt < everyMs) return null;
    if (content) await writeTextAtomic(bodyPath, content.replace(/\r\n?/g, "\n"));
    persistedChars = content.length;
    lastWriteAt = now;
    return publish(state, extra);
  }

  await publish("waiting_first_token");
  waitingReviewTask = inspectExistingWriting(projectDir, waitingReviewPath).then(async (report) => {
    waitingReview = {
      state: "completed",
      reportPath: waitingReviewPath,
      filesChecked: report.filesChecked,
      filesWithIssues: report.filesWithIssues,
      ledgersChecked: report.ledgers.checked,
      ledgerStatus: {
        populated: report.ledgers.populated,
        empty: report.ledgers.empty,
        missing: report.ledgers.missing,
        errors: report.ledgers.errors
      }
    };
    await publish(currentState).catch(() => {});
  }).catch(async (error) => {
    waitingReview = { state: "failed", reportPath: waitingReviewPath, error: publicProgressError(error) };
    await publish(currentState).catch(() => {});
  });

  return {
    bodyPath,
    progressPath,
    async onDelta(delta) {
      if (closed) return;
      const next = String(delta || "");
      if (!next) return;
      content += next;
      if (typeof onDelta === "function") {
        try { await onDelta(next); } catch {}
      }
      await flush("streaming", false);
    },
    async sync(value, state = "response_received", extra = {}) {
      if (closed) return null;
      const next = String(value || "").replace(/\r\n?/g, "\n").trim();
      if (next) content = next;
      return flush(state, true, extra);
    },
    async complete(artifact, extra = {}) {
      if (terminal) return;
      terminal = true;
      closed = true;
      await waitingReviewTask;
      await publish("completed", {
        finalPath: artifact?.path || null,
        finalPlainPath: artifact?.plainPath || null,
        ...extra
      });
      await fsp.unlink(bodyPath).catch(() => {});
    },
    async fail(error, extra = {}) {
      if (terminal) return;
      terminal = true;
      closed = true;
      await waitingReviewTask;
      await flush(content ? "partial_saved" : "failed", true, {
        error: publicProgressError(error),
        ...extra
      });
    }
  };
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

async function writeArtifact({ projectDir, kind = "draft", title = "", chapterNo = "", modelId = "", content, ext = "txt", meta = {}, target: outputTarget = "candidate" } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (typeof content !== "string" || !content.trim()) throw new Error("content required");
  const toChapter = String(outputTarget || "candidate") === "chapter";
  if (toChapter && !String(chapterNo || "").trim()) throw new Error("chapterNo required when target=chapter");
  const dir = await ensureDir(toChapter ? chapterDir(projectDir) : candidateDir(projectDir));
  // 正文按章用固定文件名，重写同一章直接覆盖；候选仍按时间戳累积。
  const parts = toChapter ? [chapterFileBase(chapterNo, title)] : [stamp(), safeSegment(kind, "draft")];
  if (!toChapter) {
    if (chapterNo) parts.push("ch" + safeSegment(chapterNo, "x"));
    if (title) parts.push(safeSegment(title, "untitled"));
    if (modelId) parts.push(safeSegment(modelId, "model"));
  }
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
    toChapter
      ? "note: 正式正文，重写同一章会直接覆盖本文件。"
      : "note: 候选稿/模型输出，作者确认前不得当作正式正文。",
    Object.keys(artifactMeta).length ? "meta: " + JSON.stringify(artifactMeta) : "",
    "---",
    ""
  ].filter(Boolean).join("\n") + "\n\n";
  const body = content.replace(/\r\n?/g, "\n").trim() + "\n";
  // 正文只存纯正文；候选保留 artifact 头和可直读的 .body 副本。
  await writeTextAtomic(filePath, toChapter ? body : header + body);
  const plainPath = toChapter ? filePath : path.join(dir, parts.join("_") + ".body." + fileExt);
  if (!toChapter) await writeTextAtomic(plainPath, body);
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

async function readArtifact(filePath, { maxChars = 1000000 } = {}) {
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
 * Stream-first generation with one upstream submission per explicit author authorization.
 * Always persists complete text to Codex候选/*.txt (+ .body.txt plain for model reread).
 */
async function generateToArtifact({
  gateway,
  projectDir,
  kind = "draft",
  outputTarget = "candidate",
  title = "",
  chapterNo = "",
  modelIds = [],
  system = "",
  prompt = "",
  taskLabel = "fiction",
  previewChars = 800,
  streamRetries = 1,
  outerAttempts = 1,
  fallbackChain = false,
  minChars = 0,
  applyHardGates = true,
  maxTokens,
  requestPolicyVersion = "caller-only",
  contextSanitization = null,
  onDelta,
  onProgress,
  checkpointEveryChars = 240,
  checkpointEveryMs = 2000
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
  let lastBelowMinChars = false;
  let reasoningBlocksRemoved = 0;
  let fallbackAttempts = [];
  let activeCheckpoint = null;
  let lastProgressPath = null;
  const attempts = 1;
  const retries = 1;
  const useFallback = fallbackChain === true && ids.length > 1;

  async function callOne(modelId) {
    const checkpoint = await createStreamCheckpoint({
      projectDir,
      kind,
      title,
      chapterNo,
      modelId,
      everyChars: Math.max(80, Number(checkpointEveryChars) || 240),
      everyMs: Math.max(500, Number(checkpointEveryMs) || 2000),
      onDelta,
      onProgress
    });
    activeCheckpoint = checkpoint;
    lastProgressPath = checkpoint.progressPath;
    let extracted;
    try {
      const result = await gateway.callModels({
        prompt: String(prompt),
        system: system ? String(system) : undefined,
        modelIds: [modelId],
        taskLabel: String(taskLabel || kind || "fiction").slice(0, 64),
        streamRetries: retries,
        onDelta: checkpoint.onDelta,
        ...(maxTokens == null ? {} : { maxTokens: Number(maxTokens) })
      });
      extracted = extractModelPayload(result, modelId);
    } catch (error) {
      const partial = String(error?.partialContent || "").replace(/\r\n?/g, "\n").trim();
      if (!partial) {
        await checkpoint.fail(error);
        throw error;
      }
      extracted = extractModelPayload({ content: partial, modelId, transport: "partial_error", finishReason: error?.finishReason || null }, modelId);
      lastPartial = true;
    }
    await checkpoint.sync(extracted.content, "response_received", {
      transport: extracted.transport,
      finishReason: extracted.finishReason || null
    });
    reasoningBlocksRemoved += Number(extracted.reasoningBlocksRemoved || 0);
    lastTransport = extracted.transport;
    lastFinishReason = extracted.finishReason;
    if (!extracted.content || !extracted.content.replace(/\s+/g, "")) {
      const error = Object.assign(new Error("empty_model_output"), { code: "EMPTY_MODEL_OUTPUT" });
      await checkpoint.fail(error);
      throw error;
    }
    if (applyHardGates) {
      const check = isAcceptableCandidate(extracted.content, { minChars: Number(minChars) || 0, requestText: String(prompt) });
      lastGate = check.gate;
    } else {
      lastGate = inspectChapter(extracted.content, { minChars: Number(minChars) || 0, requestText: String(prompt) });
    }
    lastBelowMinChars = Number(minChars) > 0 && Number(lastGate?.chars || 0) < Number(minChars);
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
        // Single model: one stream submission. A later continuation needs new author authorization.
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
        target: outputTarget,
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
          belowMinChars: lastBelowMinChars,
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

      if (activeCheckpoint) {
        await activeCheckpoint.complete(saved, {
          partial: lastPartial || /^partial_/u.test(lastTransport),
          abruptEnding: lastAbruptEnding,
          belowMinChars: lastBelowMinChars,
          finishReason: lastFinishReason || null,
          transport: lastTransport
        });
      }

      const previewLimit = Math.max(120, Math.min(Number(previewChars) || 800, 4000));
      return {
        ok: true,
        accepted: !lastBelowMinChars && !lastPartial && !(lastGate && lastGate.ok === false),
        qualityStatus: lastBelowMinChars
          ? "below_requested_length"
          : (lastPartial ? "partial_candidate" : (!(lastGate && lastGate.ok === false) ? "candidate_ready" : "review_required")),
        artifact: saved,
        modelId,
        transport: lastTransport,
        finishReason: lastFinishReason,
        attempt,
        outerAttempt: attempt,
        degraded,
        partial: lastPartial || /^partial_/u.test(lastTransport),
        abruptEnding: lastAbruptEnding,
        belowMinChars: lastBelowMinChars,
        hardGate: lastGate,
        fallbackAttempts,
        contextSanitization,
        reasoningBlocksRemoved,
        progressPath: lastProgressPath,
        preview: content.slice(0, previewLimit),
        coach: "模型输出已落盘。可读 " + saved.relativePath + " 与纯正文 " + saved.plainRelativePath +
          (saved.memoryRecord ? "；写作记录已更新 " + saved.memoryRecord.relativePath + "。" : "；写作记录未更新，请保留当前候选路径。") +
          (lastPartial || /^partial_/u.test(lastTransport)
            ? "当前只算已保存的正文段落，不算完整章；需要续写时从 .body.txt 最后一个字接下去。"
            : (lastBelowMinChars
              ? "正文已完整返回，但低于本次最低篇幅；仍是候选，若要扩成目标长度需作者明确授权同一模型续接。"
              : "作者确认前不入正式正文/台账。"))
      };
    } catch (error) {
      lastError = error;
      if (activeCheckpoint) await activeCheckpoint.fail(error);
    }
  }

  const err = lastError || new Error("generate_to_artifact_failed");
  err.transport = lastTransport;
  err.hardGate = lastGate;
  err.fallbackAttempts = fallbackAttempts;
  throw err;
}

function joinContinuationText(source, continuation) {
  const original = String(source || "").replace(/\r\n?/g, "\n").trimEnd();
  let next = String(continuation || "").replace(/\r\n?/g, "\n").trim();
  next = next.replace(/^#{1,6}\s*续写\s*\n+/u, "").replace(/^续写[:：]\s*/u, "");
  if (!original || !next) return (original || next).trim();

  const sampleSize = Math.min(160, original.length, next.length);
  if (sampleSize >= 40 && next.slice(0, sampleSize) === original.slice(0, sampleSize)) {
    return next.length >= original.length ? next : original;
  }

  const maxOverlap = Math.min(160, original.length, next.length);
  for (let size = maxOverlap; size >= 6; size -= 1) {
    if (original.slice(-size) === next.slice(0, size)) {
      next = next.slice(size).trimStart();
      break;
    }
  }
  const startsAsClause = /^[，。！？；：、”’）)\]】》」』]/u.test(next);
  return `${original}${startsAsClause ? "" : "\n\n"}${next}`.trim();
}

async function continueArtifactToFile({
  gateway,
  projectDir,
  sourcePath,
  modelIds = [],
  system = "",
  direction = "",
  title = "",
  chapterNo = "",
  minAdditionalChars = 0,
  maxTokens = 32000,
  streamRetries = 1,
  fallbackChain = false,
  onProgress
} = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (!sourcePath) throw new Error("sourcePath required");
  const projectRoot = path.resolve(projectDir);
  const sourceAbs = path.resolve(sourcePath);
  const relative = path.relative(projectRoot, sourceAbs);
  const candidateRoot = path.resolve(candidateDir(projectRoot));
  const candidateRelative = path.relative(candidateRoot, sourceAbs);
  const outsideProject = !relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative);
  const outsideCandidates = !candidateRelative || candidateRelative === ".." || candidateRelative.startsWith(".." + path.sep) || path.isAbsolute(candidateRelative);
  if (outsideProject || outsideCandidates || !/\.body\.txt$/iu.test(sourceAbs)) {
    throw new Error("sourcePath must be a candidate .body.txt inside projectDir");
  }
  const source = await readArtifact(sourceAbs);
  const prompt = [
    "下面是已经保存的不完整小说正文。只从最后一个字继续，补写新增正文；不要重写、复述或优化已有部分。",
    "开头先接完原稿最后一句。最后必须停在完整句子上。只输出新增正文，不要标题、前言、分析或说明。",
    direction ? ("作者本次续写方向：\n" + String(direction).trim()) : "",
    "# 已保存正文",
    source.content
  ].filter(Boolean).join("\n\n");

  const continuation = await generateToArtifact({
    gateway,
    projectDir,
    kind: "continuous_draft",
    title: title ? title + "_续写段" : "续写段",
    chapterNo,
    modelIds,
    system,
    prompt,
    taskLabel: "continue-saved-draft",
    streamRetries,
    fallbackChain,
    minChars: Math.max(0, Number(minAdditionalChars) || 0),
    maxTokens,
    onProgress
  });
  const continuationBody = await readArtifact(continuation.artifact.plainPath);
  const combinedText = joinContinuationText(source.content, continuationBody.content);
  const combined = await writeArtifact({
    projectDir,
    kind: "chapter_draft",
    title: title ? title + "_续接合并" : "续接合并",
    chapterNo,
    modelId: continuation.modelId,
    content: combinedText,
    ext: "txt",
    meta: {
      sourcePath: source.sourcePath || source.path,
      continuationPath: continuation.artifact.plainPath,
      continuationPartial: Boolean(continuation.partial),
      continuationAbruptEnding: Boolean(continuation.abruptEnding),
      combinedAbruptEnding: hasAbruptProseEnding(combinedText),
      note: "原稿与新增续写段机械去重合并；作者确认前不进入正式正文或事实台账"
    }
  });
  return {
    ok: true,
    sourcePath: source.sourcePath || source.path,
    continuation,
    combined,
    chars: combinedText.replace(/\s+/g, "").length,
    complete: !continuation.partial && !continuation.abruptEnding && !hasAbruptProseEnding(combinedText),
    coach: "续写段与合并稿均已保存。先读合并稿；作者确认前不进入正式正文或事实台账。"
  };
}

module.exports = {
  writeArtifact,
  readArtifact,
  listArtifacts,
  generateToArtifact,
  continueArtifactToFile,
  candidateDir,
  modelWritingRecordPath,
  extractModelPayload,
  hasAbruptProseEnding,
  joinContinuationText,
  renameWithRetry,
  inspectExistingWriting
};
