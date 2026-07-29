"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeArtifact } = require("./artifact-pipeline");

async function readIfExists(file) {
  try { return await fsp.readFile(file, "utf8"); } catch { return ""; }
}
async function readFirst(files) {
  for (const file of files) {
    const content = await readIfExists(file);
    if (content.trim()) return content;
  }
  return "";
}
function clip(text, n = 6000) {
  const s = String(text || "").replace(/\r\n?/g, "\n").trim();
  return s.length > n ? s.slice(0, n) + "\n…(截断)" : s;
}
function roughStats(text) {
  const body = String(text || "").replace(/\r\n?/g, "\n").trim();
  const lines = body.split(/\n+/).filter(Boolean);
  const chars = body.replace(/\s+/g, "").length;
  const dialogueLines = lines.filter((l) => /[“"「]|说|道|问|喝道|笑道/.test(l)).length;
  const avgLine = lines.length ? Math.round(chars / lines.length) : 0;
  const shortLines = lines.filter((l) => l.length > 0 && l.length <= 16).length;
  const longLines = lines.filter((l) => l.length >= 70).length;
  const aiHints = [];
  const fixes = [];
  if (/(与此同时|就在这时|不禁|缓缓|微微一笑|目光深邃|嘴角微微上扬|空气仿佛凝固|所有人都倒吸|一场风暴即将|真正的较量才刚刚开始)/.test(body)) {
    aiHints.push("套话风险");
    fixes.push("删掉套话，改成具体动作或停顿");
  }
  if (/(首先|其次|总之|由此可见|这意味着|不难看出)/.test(body)) {
    aiHints.push("解释腔/议论文腔");
    fixes.push("用 deslop-explain：删结论句，改成选择与代价");
  }
  if (dialogueLines === 0 && chars > 800) {
    aiHints.push("对话偏少");
    fixes.push("关键冲突尽量落到对白与打断");
  }
  if (dialogueLines / Math.max(lines.length, 1) > 0.55) {
    aiHints.push("对话过密");
    fixes.push("补一点动作与环境压力，避免对白空转");
  }
  if (longLines / Math.max(lines.length, 1) > 0.3) {
    aiHints.push("长句偏多");
    fixes.push("高压段拆短句，一段只推一个动作");
  }
  if (shortLines / Math.max(lines.length, 1) > 0.4 && chars > 600) {
    aiHints.push("短句连珠");
    fixes.push("保留关键短句，删空响短句");
  }
  if (!aiHints.length) aiHints.push("未检出明显套话，仍建议人工通读");
  if (!fixes.length) fixes.push("对照文风锚点改最假的 3 处", "对照样书信息投放节奏", "必要时再跑 humanizer/deslop");
  return { chars, lines: lines.length, dialogueLines, avgLine, shortLines, longLines, aiHints, fixes };
}
async function collectStyleContext(projectDir) {
  const styleDoc = await readFirst([
    path.join(projectDir, "辅助文档", "06_风格与写作要求.md"),
    path.join(projectDir, "辅助文档", "08_文风锚点.md"),
    path.join(projectDir, "08_文风锚点.md")
  ]);
  const voice = styleDoc;
  const skill = await readFirst([
    path.join(projectDir, "辅助文档", "10_本书写作Skill.md"),
    path.join(projectDir, "10_本书写作Skill.md")
  ]);
  const facts = await readFirst([
    path.join(projectDir, "辅助文档", "08_事实库_防OOC.md"),
    path.join(projectDir, "辅助文档", "12_事实库_防OOC.md"),
    path.join(projectDir, "12_事实库_防OOC.md")
  ]);
  let sampleNotes = "";
  const sampleRoot = path.join(projectDir, "样书");
  if (fs.existsSync(sampleRoot)) {
    for (const name of await fsp.readdir(sampleRoot)) {
      const notes = path.join(sampleRoot, name, "00_手法学习笔记.md");
      if (fs.existsSync(notes)) {
        sampleNotes += "\n\n# 样书 " + name + "\n" + await readIfExists(notes);
        break;
      }
    }
  }
  return { voice, styleDoc, skill, sampleNotes, facts };
}
async function compareStyle({ projectDir, draftText = "", draftPath = "", title = "" } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  let draft = draftText;
  if (!draft && draftPath) draft = await fsp.readFile(draftPath, "utf8");
  if (!draft || !String(draft).trim()) throw new Error("draftText or draftPath required");
  const sep = draft.indexOf("\n---\n");
  if (sep >= 0) draft = draft.slice(sep + 5);
  const ctx = await collectStyleContext(projectDir);
  const stats = roughStats(draft);
  const missing = [];
  if (!ctx.voice.trim()) missing.push("缺少 辅助文档/06_风格与写作要求.md");
  if (!ctx.sampleNotes.trim()) missing.push("缺少样书手法笔记");
  const report = [
    "# 文风对比报告", "",
    "## 候选概况",
    "- 标题：" + (title || "未命名"),
    "- 字数：" + stats.chars,
    "- 行数：" + stats.lines,
    "- 疑似对话行：" + stats.dialogueLines,
    "- 平均行字：" + stats.avgLine,
    "- 短行/长行：" + stats.shortLines + "/" + stats.longLines,
    "- 风险：" + stats.aiHints.join("；"),
    "",
    "## 对照材料",
    missing.length ? missing.map((m) => "- " + m).join("\n") : "- 文风锚点/样书笔记可用",
    "",
    "## 文风锚点（摘录）", clip(ctx.voice || "（空）", 1600), "",
    "## 旧项目写法补充（如有）", clip(ctx.skill || "（无）", 1200), "",
    "## 样书手法（摘录）", clip(ctx.sampleNotes || "（空）", 1600), "",
    "## 可执行修改（先改这些）",
    ...stats.fixes.map((f, i) => (i + 1) + ". " + f),
    "",
    "## 事实库提醒",
    clip(ctx.facts || "（空：历史/真实人物风险高）", 1000),
    "",
    "## deslop 路由建议",
    "- 对话假：deslop-dialogue",
    "- 解释腔：deslop-explain",
    "- 节奏：deslop-pacing",
    "- 综合：humanizer-zh 或 fiction_optimize_with_models",
    "",
    "## 候选摘录", clip(draft, 2500), ""
  ].join("\n");
  const saved = await writeArtifact({
    projectDir,
    kind: "style_compare",
    title: title || "文风对比",
    content: report,
    ext: "md",
    modelId: "local-compare"
  });
  return {
    ok: true,
    stats,
    missing,
    artifact: saved,
    coach: "对比报告已落盘。先按可执行修改改 3 处，再谈定稿。",
    reportPreview: report.slice(0, 1200)
  };
}
module.exports = { compareStyle, collectStyleContext, roughStats };
