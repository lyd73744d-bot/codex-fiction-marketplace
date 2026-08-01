"use strict";

const fsp = require("node:fs/promises");
const fs = require("node:fs");
const path = require("node:path");
const { generateToArtifact, writeArtifact } = require("./artifact-pipeline");
const { recommendModels } = require("./model-router");
const { buildOptimizeSystem, buildOptimizePrompt, FOCUS_HINTS } = require("./humanizer-prompt-lib");
const { inspectChapter } = require("./writing-hard-gates");
const { authorFeedbackBlock } = require("./author-feedback-lib");

async function readIf(p, max = 4000) {
  try {
    const t = await fsp.readFile(p, "utf8");
    return t.length > max ? t.slice(0, max) : t;
  } catch {
    return "";
  }
}

async function collectOptimizeContext(projectDir) {
  const aux = path.join(projectDir, "辅助文档");
  const voice = await readIf(path.join(aux, "08_文风锚点.md"), 12_000);
  const brief = await readIf(path.join(projectDir, "细纲", "01_当前章细纲.md"), 20_000);
  const facts = await readIf(path.join(aux, "12_事实库_防OOC.md"), 30_000);
  let cards = "";
  const charDir = path.join(aux, "人物卡");
  if (fs.existsSync(charDir)) {
    const names = (await fsp.readdir(charDir)).filter((n) => n.endsWith(".md") && n !== "README.md").slice(0, 8);
    for (const name of names) {
      cards += "\n\n## " + name + "\n" + await readIf(path.join(charDir, name), 5000);
    }
  }
  return { voice, brief, cards, facts };
}

async function optimizeWithModels({
  gateway,
  projectDir,
  draftText,
  title = "",
  chapterNo = "",
  modelIds = [],
  mode = "humanize",
  focus = "full",
  instruction = "",
  autoRecommend = true,
  recommendMode = "quick",
  maxTokens = 32000,
  onProgress
} = {}) {
  if (!gateway || typeof gateway.callModels !== "function") throw new Error("gateway.callModels required");
  if (!projectDir) throw new Error("projectDir required");
  if (!draftText || !String(draftText).trim()) throw new Error("draftText required");

  const normalizedFocus = FOCUS_HINTS[focus] ? focus : "full";
  let ids = Array.isArray(modelIds) ? modelIds.filter(Boolean) : [];
  if (!ids.length && autoRecommend) {
    let available = [];
    try {
      const listed = await gateway.listModels();
      available = Array.isArray(listed?.models) ? listed.models : [];
    } catch {}
    const task = mode === "review" ? "review" : mode === "finalize" ? "finalize" : "humanize";
    ids = recommendModels({
      task,
      availableModels: available,
      mode: recommendMode || "quick"
    }).modelIds.slice(0, 3);
  }
  if (!ids.length) throw new Error("modelIds required");

  const context = await collectOptimizeContext(projectDir);
  const system = buildOptimizeSystem({ mode, focus: normalizedFocus });
  const runs = [];
  let current = String(draftText).trim();
  const sourceChars = inspectChapter(current).chars;

  for (const modelId of ids) {
    const prompt = buildOptimizePrompt({
      mode,
      focus: normalizedFocus,
      instruction: [instruction, authorFeedbackBlock(instruction)].filter(Boolean).join("\n\n"),
      draftText: current,
      context
    });
    const result = await generateToArtifact({
      gateway,
      projectDir,
      kind: "optimize_" + mode + "_" + normalizedFocus,
      title,
      chapterNo,
      modelIds: [modelId],
      system,
      prompt,
      taskLabel: "optimize-" + mode,
      streamRetries: 2,
      outerAttempts: 1,
      minChars: mode === "review" ? 0 : Math.floor(sourceChars * 0.8),
      maxTokens,
      onProgress: typeof onProgress === "function"
        ? (progress) => onProgress({
            ...progress,
            optimizeModelId: modelId,
            optimizeStep: runs.length + 1,
            optimizeSteps: ids.length
          })
        : undefined
    });
    if (mode !== "review" && result?.artifact?.plainPath) {
      current = await fsp.readFile(result.artifact.plainPath, "utf8");
    }
    const gate = inspectChapter(result?.preview || current);
    runs.push({
      modelId,
      artifact: result.artifact,
      plainPath: result.artifact?.plainPath || null,
      plainRelativePath: result.artifact?.plainRelativePath || null,
      preview: result.preview,
      transport: result.transport || null,
      hardGate: { ok: gate.ok, chars: gate.chars, issues: gate.issues }
    });
  }

  const summary = [
    "# 多模型优化摘要",
    "",
    "- 模式：" + mode,
    "- 焦点：" + normalizedFocus + "（" + (FOCUS_HINTS[normalizedFocus] || "") + "）",
    "- 模型顺序：" + ids.join(" -> "),
    "- 结果文件：",
    ...runs.map((r, i) =>
      (i + 1) + ". " + r.modelId +
      " => " + (r.artifact?.relativePath || "") +
      (r.plainRelativePath ? " | plain: " + r.plainRelativePath : "") +
      (r.transport ? " | transport: " + r.transport : "")
    ),
    "",
    "每次完整生成后都写入 Codex候选 txt；.body 纯正文可再喂模型。",
    "作者确认前不入正式正文/台账。",
    "责编建议：先看 plain 文件，再决定是否继续 focus=dialogue/narration/pacing 等微方法。",
    ""
  ].join("\n");

  const summaryArtifact = await writeArtifact({
    projectDir,
    kind: "optimize_summary",
    title: title || mode,
    content: summary,
    ext: "md",
    modelId: ids.join("+"),
    meta: { recordModelOutput: false, note: "本地生成的优化路径摘要；各模型正文已分别记录" }
  });

  return {
    ok: true,
    mode,
    focus: normalizedFocus,
    modelIds: ids,
    runs,
    finalText: current,
    finalPlainPath: runs.length ? (runs[runs.length - 1].plainPath || null) : null,
    summaryArtifact,
    coach: "多模型优化已完成并落盘。请先读 plain 正文，确认前不要入台账。可用 fiction_list_deslop_methods 继续定点打磨。"
  };
}

module.exports = { optimizeWithModels, collectOptimizeContext };
