"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { getGuidedStatus } = require("./guided-stage-service");
const { listSampleBooks } = require("./sample-book-service");
const { getGoldenThreeStatus } = require("./golden-three-service");
const { readContinuousMode } = require("./continuous-mode");

function exists(p) { return fs.existsSync(p); }
async function nonEmpty(p) {
  try { return (await fsp.readFile(p, "utf8")).trim().length > 20; } catch { return false; }
}
async function readMaybe(p, max = 8000) {
  try {
    const t = await fsp.readFile(p, "utf8");
    return t.length > max ? t.slice(0, max) : t;
  } catch { return ""; }
}
function looksHistorical(text) {
  return /历史|史实|真实人物|明朝|大明|清朝|大清|唐朝|宋朝|元朝|汉朝|民国|抗战|二战|官职|内阁|尚书|巡抚|总兵|卢象升|李自成|崇祯|朝廷|科举|藩镇|都督|将军府|年号/.test(String(text || ""));
}
async function researchFilled(projectDir) {
  const dir = path.join(projectDir, "辅助文档", "联网核验");
  if (!exists(dir)) return false;
  const names = await fsp.readdir(dir);
  for (const name of names) {
    if (!/\.md$/i.test(name)) continue;
    try {
      const body = await fsp.readFile(path.join(dir, name), "utf8");
      const hasSource = /https?:\/\//i.test(body);
      const hasFacts = /已确认事实[\s\S]{0,120}-\s*\S+/.test(body) || /回填记录/.test(body);
      if (hasSource && hasFacts) return true;
    } catch {}
  }
  return false;
}
async function assessPipeline(projectDir) {
  if (!projectDir) throw new Error("projectDir required");
  const aux = path.join(projectDir, "辅助文档");
  const checks = [];
  const push = (id, ok, label, fix, level = "soft") => checks.push({ id, ok: !!ok, label, fix, level });

  const brainstorm = await readMaybe(path.join(aux, "09_脑洞板.md"));
  const outline = await readMaybe(path.join(aux, "01_全书大纲.md"));
  const voice = await readMaybe(path.join(aux, "08_文风锚点.md"));
  const style = await readMaybe(path.join(aux, "06_风格与写作要求.md"));
  const historicalLikely = looksHistorical(brainstorm + "\n" + outline + "\n" + voice + "\n" + style);

  push("brainstorm", brainstorm.trim().length > 20, "脑洞板", "fiction_get_brainstorm_coach", "hard");
  const samples = await listSampleBooks(projectDir);
  push("sample_import", samples.items.length > 0, "样书已入库", "fiction_import_sample_book", "soft");
  let sampleNotes = false;
  if (samples.items.length) sampleNotes = await nonEmpty(path.join(samples.items[0].dir, "00_手法学习笔记.md"));
  push("sample_learn", sampleNotes, "样书手法已学习", "fiction_learn_sample_techniques", "soft");
  push("voice", voice.trim().length > 20 || style.trim().length > 20, "文风锚点", "fiction_upsert_voice_anchor", "soft");
  push("outline", outline.trim().length > 20, "大纲", "fiction_create_outline", "soft");
  push("research_dir", exists(path.join(aux, "联网核验")), "联网核验目录", "fiction_create_research_doc / fiction_plan_research", "soft");

  const researchOk = await researchFilled(projectDir);
  push(
    "research_filled",
    researchOk,
    historicalLikely ? "联网核验已回填来源+事实（历史/真实题材硬门槛）" : "联网核验已回填来源/事实",
    "fiction_plan_research → 内置浏览器检索 → fiction_append_research_findings",
    historicalLikely ? "hard" : "soft"
  );

  const factFile = path.join(aux, "12_事实库_防OOC.md");
  let factOk = false;
  try {
    const factBody = await fsp.readFile(factFile, "utf8");
    factOk = /已确认硬事实[\s\S]{0,200}-\s*\S+/.test(factBody) || /https?:\/\//i.test(factBody);
  } catch {}
  push(
    "fact_library",
    factOk,
    "事实库有硬事实/来源",
    "fiction_upsert_facts / fiction_append_research_findings",
    historicalLikely ? "hard" : "soft"
  );

  const charDir = path.join(aux, "人物卡");
  let charCount = 0;
  if (exists(charDir)) charCount = (await fsp.readdir(charDir)).filter((n) => n.endsWith(".md") && n !== "README.md").length;
  push("characters", charCount > 0, "至少一张人物卡", "fiction_create_character_card", historicalLikely ? "hard" : "soft");
  push("chapter_brief", await nonEmpty(path.join(projectDir, "细纲", "01_当前章细纲.md")), "当前章控制卡", "fiction_create_chapter_brief", "hard");

  const hard = checks.filter((c) => !c.ok && c.level === "hard");
  const soft = checks.filter((c) => !c.ok && c.level !== "hard");
  const guided = await getGuidedStatus(projectDir);
  const golden = await getGoldenThreeStatus(projectDir);
  const continuous = await readContinuousMode(projectDir);

  let nextAction = "继续引导提问";
  if (!checks.find((c) => c.id === "brainstorm").ok) nextAction = "先做脑洞：fiction_get_brainstorm_coach";
  else if (!checks.find((c) => c.id === "sample_import").ok) nextAction = "请作者拖入样书：fiction_import_sample_book";
  else if (!checks.find((c) => c.id === "sample_learn").ok) nextAction = "学习样书手法：fiction_learn_sample_techniques / fiction_deep_learn_sample";
  else if (!checks.find((c) => c.id === "voice").ok) nextAction = "先定文风锚点：fiction_upsert_voice_anchor";
  else if (!checks.find((c) => c.id === "outline").ok) nextAction = "搭大纲：fiction_create_outline";
  else if (!checks.find((c) => c.id === "research_filled").ok) nextAction = "必须联网核验：fiction_plan_research → 浏览器检索 → fiction_append_research_findings";
  else if (!checks.find((c) => c.id === "fact_library").ok) nextAction = "同步事实库：fiction_upsert_facts / fiction_append_research_findings";
  else if (!checks.find((c) => c.id === "characters").ok) nextAction = "建人物卡：fiction_create_character_card";
  else if (!checks.find((c) => c.id === "chapter_brief").ok) nextAction = "写控制卡：fiction_create_chapter_brief";
  else nextAction = "可以写初稿候选：fiction_generate_to_file（流式优先，完整落盘 txt）";

  return {
    ok: true,
    canDraft: hard.length === 0,
    historicalLikely,
    hardBlockers: hard,
    softMissing: soft,
    checks,
    guidedStage: guided.stage,
    goldenThreeReady: golden.readyAll === true,
    continuousEnabled: continuous.enabled === true,
    nextAction,
    coach: hard.length
      ? ("还不能写正文。先清：" + hard.map((b) => b.label).join("、") + (historicalLikely ? "。历史/真实题材必须先联网回填。" : ""))
      : (soft.length
        ? ("可准备写初稿，建议先补：" + soft.map((b) => b.label).join("、") + "。真实/历史内容务必完成联网核验回填。")
        : "材料较齐。控制卡确认后生成候选 txt，再多模型优化/去AI味。")
  };
}
module.exports = { assessPipeline, looksHistorical, researchFilled };
