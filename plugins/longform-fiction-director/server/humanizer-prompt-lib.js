"use strict";

const fs = require("node:fs");
const path = require("node:path");

const FOCUS_HINTS = {
  full: "综合去AI味：先查整章是否在逐项执行提示词，再删空句、压解释腔、避免把潜台词说满、节奏可朗读。",
  dialogue: "重点改对话：信息差、人物声口与自然留白；不改剧情。",
  narration: "重点改叙述：识别细纲验收流程腔和换皮结构，删总结腔/套话，不替读者翻译潜台词。",
  pacing: "重点改节奏：修复因果跳步和重复解释，不套固定拍数，保留必要停留。",
  emotion: "重点改情绪表达：少贴标签，多动作停顿与选择。",
  info: "重点拆信息倾倒：本章立刻用到的才留在正文。",
  hook: "重点改章尾钩子：从本章因果长出，不要廉价惊吓。",
  explain: "重点去解释腔/主题总结：删“这意味着/不难看出”，不把动作和对白再解释一遍。"
};

function readMaybe(file, max = 3500) {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trim();
    return raw.length > max ? raw.slice(0, max) + "\n…(截断)" : raw;
  } catch {
    return "";
  }
}

function pluginRootFromHere() {
  return path.join(__dirname, "..");
}

function loadMethodPack(focus = "full") {
  const rootDir = pluginRootFromHere();
  const map = {
    full: ["skills/deslop-all/SKILL.md", "skills/humanizer-zh/SKILL.md"],
    dialogue: ["skills/deslop-all/SKILL.md"],
    narration: ["skills/deslop-all/SKILL.md"],
    pacing: ["skills/deslop-all/SKILL.md"],
    emotion: ["skills/deslop-all/SKILL.md"],
    info: ["skills/deslop-all/SKILL.md"],
    hook: ["skills/deslop-all/SKILL.md"],
    explain: ["skills/deslop-all/SKILL.md"]
  };
  const files = map[focus] || map.full;
  const chunks = [];
  for (const rel of files) {
    const body = readMaybe(path.join(rootDir, rel), focus === "full" ? 2800 : 1800);
    if (body) chunks.push("# " + rel + "\n" + body);
  }
  // zizhuji protect rules excerpt
  const revise = readMaybe(
    path.join(rootDir, "server/zizhuji-compat/resources/prompts/sources/humanizer-chapter-revise.md"),
    1600
  );
  if (revise) {
    chunks.push("# zizhuji-humanizer-protect\n" + revise.split("\n").filter((line) => /保护|不得|必须保留|禁止/.test(line)).slice(0, 40).join("\n"));
  }
  return chunks.join("\n\n");
}

function buildOptimizeSystem({ mode = "humanize", focus = "full" } = {}) {
  const modeLine = {
    humanize: "你在去AI味。改腔不改剧情，不新增设定，不删关键因果。只输出优化后的完整正文。",
    review: "你在找硬伤。输出问题清单与可执行修改建议，按严重度排序，不要重写全文。",
    polish: "你在润色。增强画面与对话自然度，不改剧情主干。只输出完整正文。",
    finalize: "你在做定稿级修订。保持事实与人物一致，输出完整正文。"
  }[mode] || "你在优化中文网文候选稿。";

  const focusLine = FOCUS_HINTS[focus] || FOCUS_HINTS.full;
  const methods = mode === "review" ? "" : loadMethodPack(focus);

  return [
    modeLine,
    "焦点：" + focusLine,
    "硬性保护：不改胜负/关系/知情范围/时间线/专名数值；不新增设定；不删章尾已成立钩子的因果。",
    "叙事留白：人物不一次说完动机、情绪、关系结论和正确答案，旁白不紧跟着翻译潜台词。必要事实与因果仍须清楚，未明说部分必须能从动作、反应、上下文或后果中读回；不得用密集省略号、神秘碎句或人人欲言又止假装留白。",
    "结构去流程腔：先看整章是否按大纲、细纲或提示词的栏目顺序逐项展示和验收设定。若主角持续给出最优处理、其他人物只递交恰好需要的答案，或系统/兵种/语言/物资/能力依次亮相，应保留事实后重新组织场景与披露顺序；不得只换专名、同义词或套用另一种开篇公式。单独一次危机、命令、回报或正确判断不算问题。",
    "输出：除 review 模式外，只输出完整正文，不要前言后语。",
    methods ? ("参考方法（遵守，不要照抄示例句）：\n" + methods) : ""
  ].filter(Boolean).join("\n\n");
}

function buildOptimizePrompt({ mode = "humanize", focus = "full", instruction = "", draftText = "", context = {} } = {}) {
  return [
    "# 任务模式",
    mode,
    "# 焦点",
    focus,
    "",
    "# 作者额外要求",
    instruction || "无",
    "",
    "# 项目上下文（可参考，不得扩写未给出的事实）",
    "- 文风锚点：", String(context.voice || "（无）").slice(0, 1200),
    context.facts ? ("\n# 事实库（防OOC）\n" + context.facts + "\n") : "",
    "- 人物/核验摘录：", String(context.cards || "（无）").slice(0, 1200),
    "- 可选章节笔记：", String(context.brief || "（无）").slice(0, 1000),
    "",
    "# 待处理正文",
    String(draftText || "").trim()
  ].join("\n");
}

module.exports = {
  FOCUS_HINTS,
  loadMethodPack,
  buildOptimizeSystem,
  buildOptimizePrompt
};
