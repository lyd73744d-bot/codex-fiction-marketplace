"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeArtifact } = require("./artifact-pipeline");
const { coachForChapter, ENGINE_NAMES } = require("./golden-three-coach");
async function readIf(p) { try { return await fsp.readFile(p, "utf8"); } catch { return ""; } }
async function collectOutlineContext(projectDir) {
  const aux = path.join(projectDir, "辅助文档");
  const brainstorm = await readIf(path.join(aux, "09_脑洞板.md"));
  const voice = await readIf(path.join(aux, "08_文风锚点.md"));
  const skill = await readIf(path.join(aux, "10_本书写作Skill.md"));
  const outlineExisting = await readIf(path.join(aux, "01_全书大纲.md"));
  let sampleNotes = "";
  const sampleRoot = path.join(projectDir, "样书");
  if (fs.existsSync(sampleRoot)) {
    for (const name of await fsp.readdir(sampleRoot)) {
      const n = path.join(sampleRoot, name, "00_手法学习笔记.md");
      if (fs.existsSync(n)) { sampleNotes = await readIf(n); break; }
    }
  }
  return { brainstorm, voice, skill, sampleNotes, outlineExisting };
}
function extractBrainstormField(board, heading) {
  const re = new RegExp("## " + heading + "\\n([\\s\\S]*?)(?=\\n## |$)");
  const m = String(board || "").match(re);
  if (!m) return "";
  const body = m[1].split(/\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("##") && l !== "-").join("\n").trim();
  if (!body || /待补|待定|待确认/.test(body)) return "";
  return body;
}
function buildOutlineDraft(ctx, answers = {}) {
  const fromBrain = {
    hook: extractBrainstormField(ctx.brainstorm, "一句话钩子"),
    heroWant: extractBrainstormField(ctx.brainstorm, "主角此刻最想要什么"),
    coreConflict: extractBrainstormField(ctx.brainstorm, "最大阻力")
  };
  return [
    "# 全书大纲（引导稿）", "",
    "> 这是可改的骨架，不是填空模板。按压力升级写，别写成目录。", "",
    "## 一句话钩子", (answers.hook || fromBrain.hook || "（待补）"), "",
    "## 核心矛盾", (answers.coreConflict || fromBrain.coreConflict || "（待补）"), "",
    "## 主角要什么 / 世界不让他怎样", (answers.heroWant || fromBrain.heroWant || "（待补）"), "",
    "## 黄金三章骨架（绑定→加深→验证）",
    "- 第1章（" + coachForChapter(1).stage + "）：" + coachForChapter(1).goal,
    "- 第2章（" + coachForChapter(2).stage + "）：" + coachForChapter(2).goal,
    "- 第3章（" + coachForChapter(3).stage + "）：" + coachForChapter(3).goal,
    "- 可选发动机：" + ENGINE_NAMES.join(" / "),
    answers.goldenThree || "（把上面三章写成你的具体兑现，不要空口号）", "",
    "## 前 30 章压力怎么升级", answers.pressurePlan || "（待补：4-10 / 11-20 / 21-30 各用什么新压力）", "",
    "## 从样书借来的节奏（可迁移，不抄）",
    (ctx.sampleNotes || "（还没有样书笔记，可先学样书）").split("\n").slice(0, 40).join("\n"), "",
    "## 中段会翻的牌", answers.midTwist || "- ", "",
    "## 先不写的东西", answers.notNow || "- ", "",
    "## 待作者确认", "- 主线是否够狠？", "- 前 10 章有没有连续兑现？", "- 哪些真实设定还要联网？", ""
  ].join("\n");
}
async function createOutlineScaffold({ projectDir, answers = {}, overwrite = false } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const ctx = await collectOutlineContext(projectDir);
  const missing = [];
  if (!ctx.brainstorm.trim()) missing.push("脑洞板还空，建议先 brainstorm");
  if (!ctx.sampleNotes.trim()) missing.push("还没有样书手法笔记，可先 import + learn");
  const draft = buildOutlineDraft(ctx, answers);
  const file = path.join(projectDir, "辅助文档", "01_全书大纲.md");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file) || overwrite || !ctx.outlineExisting.trim() || ctx.outlineExisting.includes("用压力升级写") || ctx.outlineExisting.includes("引导稿")) {
    await fsp.writeFile(file, draft, "utf8");
  }
  const art = await writeArtifact({ projectDir, kind: "outline", title: "全书大纲引导稿", content: draft, ext: "md", modelId: "outline-scaffold" });
  return { ok: true, path: file, artifact: art, missing, coach: missing.length ? ("大纲骨架已出，材料不齐：" + missing.join("；")) : "大纲骨架已出。先改到你点头，再进核验/人物卡。" };
}
module.exports = { createOutlineScaffold, collectOutlineContext, buildOutlineDraft };