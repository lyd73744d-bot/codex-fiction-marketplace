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
  const genericThreat = /(?:该|现在|迟早|早晚).{0,6}(?:算账|清算)|(?:这笔|那笔|一笔一笔).{0,8}(?:账|债)|(?:接下来|现在).{0,4}轮到.{0,6}(?:我|你|他|他们)|(?:真正的|真正).{0,8}(?:较量|好戏|战斗).{0,8}(?:开始|开场)|(?:付出|偿还).{0,4}代价/;
  if (/(与此同时|就在这时|不禁|缓缓|微微一笑|目光深邃|嘴角微微上扬|空气仿佛凝固|所有人都倒吸|一场风暴即将|真正的较量才刚刚开始)/.test(body)) {
    aiHints.push("套话风险");
    fixes.push("删掉套话，改成具体动作或停顿");
  }
  if (genericThreat.test(body)) {
    aiHints.push("通用狠话风险");
    fixes.push("把敌意落到当前对象、旧事、筹码或行动；没有说话必要时直接删除");
  }
  if (/(首先|其次|总之|由此可见|这意味着|不难看出)/.test(body)) {
    aiHints.push("解释腔/议论文腔");
    fixes.push("用 deslop-all 的解释腔检查：删掉重复结论，保留必要事实与因果");
  }
  if (dialogueLines === 0 && chars > 800) {
    aiHints.push("对话偏少");
    fixes.push("关键冲突尽量落到对白与打断");
  }
  if (dialogueLines / Math.max(lines.length, 1) > 0.55) {
    aiHints.push("对话过密");
    fixes.push("检查人物位置、手中物件和未完成动作，避免对白悬空");
  }
  if (longLines / Math.max(lines.length, 1) > 0.3) {
    aiHints.push("长句偏多");
    fixes.push("动作连续处适当拆句，但不要机械地一段只放一个动作");
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
    path.join(projectDir, "辅助文档", "06_风格与写作要求.md")
  ]);
  const voiceAnchor = await readFirst([
    path.join(projectDir, "辅助文档", "08_文风锚点.md"),
    path.join(projectDir, "08_文风锚点.md")
  ]);
  const voice = [styleDoc, voiceAnchor].filter((value) => value.trim()).join("\n\n");
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
  let sampleExcerpts = "";
  const sampleRoot = path.join(projectDir, "样书");
  if (fs.existsSync(sampleRoot)) {
    for (const name of await fsp.readdir(sampleRoot)) {
      const notes = path.join(sampleRoot, name, "00_手法学习笔记.md");
      if (fs.existsSync(notes)) {
        sampleNotes += "\n\n# 样书 " + name + "\n" + await readIfExists(notes);
        sampleExcerpts += await readFirst([
          path.join(sampleRoot, name, "01_剧情对话文风摘句.md"),
          path.join(sampleRoot, name, "01_措辞节奏文风摘句.md")
        ]);
        break;
      }
    }
  }
  return { voice, styleDoc, skill, sampleNotes, sampleExcerpts, facts };
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
    "## 当前正文概况",
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
    "## 剧情、对话与文风片段（只供本地对照）", clip(ctx.sampleExcerpts || "（空）", 3200), "",
    "## 与当前稿并排看",
    "- 剧情：看当前事件是否自然生出下一件事，不搬样书情节。",
    "- 对话：看人物各自想要什么、说了多少、沉默和动作是否有用，不借用原句。",
    "- 文风：看措辞、句段换气、叙述距离和说透程度，不模仿标志性表达。",
    "- 这些只是参考；觉得有用才试，作者确认后才写入本书 Skill。", "",
    "## 可执行修改（先改这些）",
    ...stats.fixes.map((f, i) => (i + 1) + ". " + f),
    "",
    "## 事实库提醒",
    clip(ctx.facts || "（空：历史/真实人物风险高）", 1000),
    "",
    "## 去 AI 味建议",
    "- 单项或综合诊断：deslop-all",
    "- 深度整章检查：humanizer-zh",
    "- 外部模型改写：fiction_optimize_with_models（每次先询问作者）",
    "",
    "## 当前正文摘录", clip(draft, 2500), ""
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
