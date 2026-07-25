"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { listSampleBooks } = require("./sample-book-service");
const { buildFrontChapterBatches, renderBreakdownProgressMarkdown, DEFAULT_FRONT_CHAPTER_LIMIT } = require("./sample-breakdown-plan");
const { writeArtifact } = require("./artifact-pipeline");
const { buildDefaultWritingSkill, sanitizeCurrentBookWritingSkill } = require("./writing-skill-lib");

async function listChapterFiles(sampleDir) {
  const files = [];
  const stack = [sampleDir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of await fsp.readdir(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && /\.(txt|md|markdown)$/i.test(ent.name) && !ent.name.startsWith("_") && !ent.name.startsWith("00_")) files.push(full);
    }
  }
  files.sort((a, b) => a.localeCompare(b, "zh"));
  return files;
}

function localTechniqueHints(text) {
  const body = String(text || "").replace(/\r\n?/g, "\n");
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const chars = body.replace(/\s+/g, "").length;
  const dialogue = lines.filter((l) => /[“"「]|说|道|问|喝道|冷声/.test(l)).length;
  const shortParas = lines.filter((l) => l.length > 0 && l.length <= 18).length;
  const longParas = lines.filter((l) => l.length >= 80).length;
  const questions = (body.match(/[？?]/g) || []).length;
  const sensory = (body.match(/看见|听见|闻到|刺痛|发冷|发热|血腥|尘土|雨声|脚步/g) || []).length;
  const abstract = (body.match(/仿佛|似乎|不禁|心中一动|意味深长|毫无疑问|总而言之/g) || []).length;
  const conflict = (body.match(/拒绝|逼|压|威胁|反驳|对峙|谈判|翻脸|撕破/g) || []).length;
  const timeJump = (body.match(/翌日|次日|三天后|半晌|片刻|与此同时|与此同时/g) || []).length;
  const ratio = dialogue / Math.max(lines.length, 1);
  const hints = [];
  if (ratio > 0.35) hints.push("对话密度高：冲突优先落在对白与打断上，少写旁白总结");
  if (ratio < 0.12 && chars > 1000) hints.push("叙述偏重：信息多在旁白，学其信息投放节奏，别学成说明书");
  if (shortParas / Math.max(lines.length, 1) > 0.28) hints.push("短段多：适合高压场景用短句推进，别句句排比");
  if (longParas / Math.max(lines.length, 1) > 0.25) hints.push("长段多：注意拆信息，避免一整段既解释又抒情");
  if (/(忽然|猛地|瞬间|下一秒)/.test(body)) hints.push("转折偏快：学“动作换档”，别学无因果惊吓");
  if (/(他想|她想|心道|暗自)/.test(body)) hints.push("有心理旁白：只保留能改变选择的念头，删解释腔");
  if (questions >= 3) hints.push("问句较多：可用追问加压，避免角色互相当讲解员");
  if (sensory >= 4 && sensory > abstract) hints.push("感官细节够：用具体感官替情绪标签");
  if (abstract >= 5) hints.push("抽象判断句偏多：改写时压掉总结腔");
  if (conflict >= 3) hints.push("对抗词密：场面靠施压-反应推进，可迁移到本书冲突设计");
  if (timeJump >= 2) hints.push("时间跳切明显：学“省略过程、保留结果压力”");
  if (lines.length && lines[lines.length - 1].length < 40) hints.push("段/章尾偏短：适合钩子，但必须从已有因果长出");
  if (!hints.length) hints.push("节奏中性：先拆“施压→反应→代价→钩子”四拍再提炼");
  return {
    chars,
    lines: lines.length,
    dialogue,
    shortParas,
    longParas,
    questions,
    sensory,
    abstract,
    conflict,
    hints
  };
}

async function learnSampleTechniques({ projectDir, sampleName = "", maxChapters = DEFAULT_FRONT_CHAPTER_LIMIT } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const listed = await listSampleBooks(projectDir);
  if (!listed.items.length) return { ok: false, message: "还没有样书。请先拖入样书文件夹并 import。" };
  const item = sampleName ? listed.items.find((x) => x.name === sampleName) || listed.items[0] : listed.items[0];
  const files = await listChapterFiles(item.dir);
  const selected = files.slice(0, Math.max(1, Math.min(Number(maxChapters) || 30, 30)));
  const chapters = [];
  for (const file of selected) {
    const text = await fsp.readFile(file, "utf8");
    const stats = localTechniqueHints(text.slice(0, 20000));
    chapters.push({ file: path.basename(file), relativePath: path.relative(projectDir, file), ...stats });
  }
  const batches = buildFrontChapterBatches(chapters, { chapterLimit: selected.length });
  const progress = renderBreakdownProgressMarkdown({
    bookName: item.name,
    engineName: "local-heuristic",
    totalBatches: Math.max(batches.length, 1),
    completedBatches: batches.map((b, i) => ({ first: i * 10 + 1, last: i * 10 + b.length, note: "本地粗拆完成" })),
    status: "本地粗拆完成，等待作者确认后再深挖"
  });
  const aggregateHints = [...new Set(chapters.flatMap((c) => c.hints))].slice(0, 8);
  const notesPath = path.join(item.dir, "00_手法学习笔记.md");
  const notes = [
    "# 样书手法学习笔记", "",
    "> 只学节奏、信息投放、冲突推进、章尾处理。禁止照抄原句/角色/设定/完整桥段。", "",
    "## 样书", item.name, "",
    "## 已读范围", "- 文件数：" + chapters.length, "- 总字数约：" + chapters.reduce((s, c) => s + c.chars, 0), "",
    "## 可迁移到本书的写法（本地粗提，可再改）",
    ...aggregateHints.map((h, i) => (i + 1) + ". " + h), "",
    "## 明确不要带入", "- 原书角色名、专有设定、完整事件顺序、原句", "",
    "## 分章观察",
    ...chapters.slice(0, 12).map((c) => "- " + c.file + "｜字数" + c.chars + "｜对话行" + c.dialogue + "｜" + c.hints.join("；")), "",
    progress
  ].join("\n");
  await fsp.writeFile(notesPath, notes, "utf8");
  const skillDir = path.join(projectDir, "辅助文档");
  await fsp.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "10_本书写作Skill.md");
  const skillBody = buildDefaultWritingSkill({ currentBook: "参考样书《" + item.name + "》的可迁移节奏，不抄原句。本地粗提：" + aggregateHints.join("；"), authorRules: "" });
  await fsp.writeFile(skillPath, sanitizeCurrentBookWritingSkill(skillBody) || skillBody, "utf8");
  const report = await writeArtifact({ projectDir, kind: "sample_learn", title: item.name, content: notes, ext: "md", modelId: "local-sample-learn" });
  return { ok: true, sample: item.name, chaptersRead: chapters.length, notesPath, writingSkillPath: skillPath, artifact: report, transferable: aggregateHints, coach: "样书手法已粗提。只学章节功能与因果节奏，不复制专名/台词/连续事件。先确认 3-8 条可迁移规则，再进文风与大纲。" };
}

async function ensureProjectWritingSkill(projectDir, { currentBook = "", authorRules = "" } = {}) {
  const skillDir = path.join(projectDir, "辅助文档");
  await fsp.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "10_本书写作Skill.md");
  if (!fs.existsSync(skillPath)) {
    const body = buildDefaultWritingSkill({ currentBook, authorRules });
    await fsp.writeFile(skillPath, body, "utf8");
    return { ok: true, created: true, path: skillPath, content: body };
  }
  return { ok: true, created: false, path: skillPath, content: await fsp.readFile(skillPath, "utf8") };
}

async function deepLearnSampleTechniques({ gateway, projectDir, sampleName = "", modelIds = [] } = {}) {
  if (!gateway || typeof gateway.callModels !== "function") throw new Error("gateway.callModels required");
  const local = await learnSampleTechniques({ projectDir, sampleName });
  if (!local.ok) return local;
  const notes = await fsp.readFile(local.notesPath, "utf8");
  const system = "你是网文责编。根据样书观察笔记，提炼 5-8 条可迁移写法。禁止复述原书剧情/原句/角色名。每条必须能落到动作、对话、节奏或章尾。";
  const prompt = ["# 本地粗提笔记", notes, "", "# 输出格式", "1. ...", "2. ...", "最后给：不要带入清单"].join("\n");
  const { generateToArtifact } = require("./artifact-pipeline");
  const { recommendModels } = require("./model-router");
  let ids = Array.isArray(modelIds) ? modelIds.filter(Boolean) : [];
  if (!ids.length) {
    try { const listed = await gateway.listModels(); ids = recommendModels({ task: "structure", availableModels: listed.models || [] }).modelIds.slice(0, 1); } catch {}
  }
  if (!ids.length) return { ...local, deep: null, coach: "本地粗提完成；无可用模型，稍后再深挖。" };
  const gen = await generateToArtifact({ gateway, projectDir, kind: "sample_deep_learn", title: local.sample, modelIds: ids, system, prompt, taskLabel: "sample-deep-learn" });
  if (gen?.artifact?.plainPath) {
    const deep = await fsp.readFile(gen.artifact.plainPath, "utf8");
    await fsp.writeFile(local.notesPath, notes.trimEnd() + "\n\n## 模型深挖（可迁移，待作者确认）\n\n" + deep.trim() + "\n", "utf8");
  }
  return { ...local, deep: gen, coach: "本地粗提 + 模型深挖已完成。请作者确认后再进大纲。" };
}

module.exports = { learnSampleTechniques, deepLearnSampleTechniques, ensureProjectWritingSkill, listChapterFiles, localTechniqueHints };
