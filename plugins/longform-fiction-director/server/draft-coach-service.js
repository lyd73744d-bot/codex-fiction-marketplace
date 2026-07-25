"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { coachForChapter, ORIGINALITY_BOUNDARY } = require("./golden-three-coach");
const { authorFeedbackBlock } = require("./author-feedback-lib");
const { recommendModels } = require("./model-router");
const { writeArtifact } = require("./artifact-pipeline");

async function readIf(p, max = 4000) {
  try {
    const t = await fsp.readFile(p, "utf8");
    return t.length > max ? t.slice(0, max) + "\n…(截断)" : t;
  } catch {
    return "";
  }
}

async function collectDraftContext(projectDir) {
  const aux = path.join(projectDir, "辅助文档");
  const brief = await readIf(path.join(projectDir, "细纲", "01_当前章细纲.md"), 2500);
  const voice = await readIf(path.join(aux, "08_文风锚点.md"), 1500);
  const skill = await readIf(path.join(aux, "10_本书写作Skill.md"), 1800);
  const facts = await readIf(path.join(aux, "12_事实库_防OOC.md"), 2000);
  const outline = await readIf(path.join(aux, "01_全书大纲.md"), 1800);
  const softLedger = await readIf(path.join(aux, "13_章节软台账.md"), 1500);
  let sampleNotes = "";
  const sampleRoot = path.join(projectDir, "样书");
  if (fs.existsSync(sampleRoot)) {
    for (const name of await fsp.readdir(sampleRoot)) {
      const n = path.join(sampleRoot, name, "00_手法学习笔记.md");
      if (fs.existsSync(n)) {
        sampleNotes = await readIf(n, 1600);
        break;
      }
    }
  }
  let cards = "";
  const charDir = path.join(aux, "人物卡");
  if (fs.existsSync(charDir)) {
    const names = (await fsp.readdir(charDir)).filter((n) => n.endsWith(".md") && n !== "README.md" && !n.startsWith("_")).slice(0, 4);
    for (const name of names) {
      cards += "\n\n## " + name + "\n" + await readIf(path.join(charDir, name), 700);
    }
  }
  return { brief, voice, skill, facts, outline, softLedger, sampleNotes, cards };
}

function buildDraftSystem({ minChars = 1800, maxChars = 3200 } = {}) {
  return [
    "你是中文商业网文正文主笔，也是责编搭档。只写具体行动、场景、对话和后果。",
    "不写教程、分析、提纲、自检、字数计算。",
    "每章一个中心事件；主角必须主动行动；阻力必须影响选择；收益或损失必须落地。",
    "首章前 300 字进入明确冲突；后续章前 150 字承接旧钩并启动新动作。",
    "章末留下具体行动、威胁、证据、人物到场或不可回避的选择。",
    "自然短段落，但不要机械切碎。减少解释总结、同义反复、模板表情和空泛预告。",
    "发布字符建议 " + minChars + "-" + maxChars + "。",
    ORIGINALITY_BOUNDARY
  ].join("\n");
}

function buildDraftPrompt({
  chapterNo = "1",
  title = "",
  instruction = "",
  minChars = 1800,
  maxChars = 3200,
  engineName = "",
  context = {}
} = {}) {
  const stage = coachForChapter(chapterNo, { engineName });
  return [
    "# 本章",
    "第" + chapterNo + "章" + (title ? " · " + title : ""),
    "",
    "# 黄金三章/续航教练",
    stage.coach || "",
    "",
    authorFeedbackBlock(instruction),
    "",
    "# 当前章细纲/控制卡",
    context.brief || "（空：先写控制卡）",
    "",
    "# 文风锚点",
    context.voice || "（空）",
    "",
    "# 事实库（防OOC，不得扩写未给出事实）",
    context.facts || "（空）",
    "",
    "# 人物卡摘录",
    context.cards || "（空）",
    "",
    "# 大纲摘录",
    context.outline || "（空）",
    "",
    "# 样书可迁移手法（禁止抄原句/专名/连续事件）",
    context.sampleNotes || "（空）",
    "",
    "# 本书写作Skill",
    context.skill || "（空）",
    "",
    "# 输出要求",
    "第一行：标题：不超过15字的小标题",
    "第二行起：完整正文。只输出标题和正文。",
    "发布字符建议 " + minChars + "-" + maxChars + "。",
    "不得输出思考、说明、自检或修改清单。"
  ].join("\n");
}

/**
 * Build a ready-to-send draft packet for fiction_generate_to_file.
 * Does not call the gateway. Local/unpaid path can still use system+prompt with fiction_write_local_candidate after author/Codex writes.
 */
async function buildDraftPacket({
  projectDir,
  chapterNo = "1",
  title = "",
  instruction = "",
  minChars = 1800,
  maxChars = 3200,
  engineName = "",
  availableModels = [],
  saveArtifact = true
} = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const context = await collectDraftContext(projectDir);
  const system = buildDraftSystem({ minChars, maxChars });
  const prompt = buildDraftPrompt({
    chapterNo,
    title,
    instruction,
    minChars,
    maxChars,
    engineName,
    context
  });
  const missing = [];
  if (!context.brief.trim()) missing.push("细纲控制卡");
  if (!context.voice.trim()) missing.push("文风锚点");
  if (!context.facts.trim() || !/-\s+\S+/.test(context.facts)) missing.push("事实库硬事实");
  if (!context.cards.trim()) missing.push("人物卡");

  let modelAdvice = null;
  try {
    modelAdvice = recommendModels({
      task: "draft",
      mode: "quick",
      availableModels: Array.isArray(availableModels) ? availableModels : [],
      maxPerRole: 2
    });
  } catch {
    modelAdvice = { modelIds: [], note: "无可用模型列表时，登录后用 fiction_recommend_models" };
  }

  let artifact = null;
  if (saveArtifact) {
    artifact = await writeArtifact({
      projectDir,
      kind: "draft_packet",
      title: title || ("ch" + chapterNo),
      chapterNo: String(chapterNo),
      content: ["# 写前草稿包", "", "## system", system, "", "## prompt", prompt, ""].join("\n"),
      ext: "md",
      modelId: "draft-coach",
      meta: { missing, modelIds: modelAdvice.modelIds || [] }
    });
  }

  return {
    ok: true,
    chapterNo: String(chapterNo),
    system,
    prompt,
    missing,
    modelAdvice,
    stage: coachForChapter(chapterNo, { engineName }),
    artifact,
    next:
      missing.length
        ? "材料还不齐：" + missing.join("、") + "。先补齐再 generate_to_file；也可本地先写 fiction_write_local_candidate。"
        : "可调用 fiction_generate_to_file（流式优先，完整落盘 txt；多模型可走回退链）。未登录则用本地候选。",
    coach: "我是引导责编，不替你一键定稿。生成后先 compare_style / optimize，作者确认再入台账。"
  };
}

module.exports = {
  collectDraftContext,
  buildDraftSystem,
  buildDraftPrompt,
  buildDraftPacket
};
