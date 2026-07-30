"use strict";

const POLICY_VERSION = "natural-prose-v5";
const PROSE_KINDS = new Set([
  "draft", "chapter", "chapter_draft", "continuous_draft", "fiction", "prose", "rewrite", "revise"
]);

const LEGACY_CONTEXT_RULES = [
  {
    id: "fixed-word-window",
    pattern: /(?:前\s*\d+\s*字|每\s*\d+\s*(?:至|到|[-–—])\s*\d+\s*字|(?:常规|普通|大战|章节?)\S{0,8}\d+\s*(?:至|到|[-–—])\s*\d+\s*字)/u
  },
  {
    id: "fixed-chapter-slot",
    pattern: /(?:前\s*[一二三四五六七八九十百两\d]+\s*章|每\s*[一二三四五六七八九十百两\d]+\s*章|第\s*\d+\s*(?:至|到|[-–—])\s*\d+\s*章|第\s*\d+\s*章.{0,24}(?:必须|安排|计划|预定|负责|职能|完成|出现|展示|兑现|回收|推进|变化|钩子))/u
  },
  {
    id: "recurring-chapter-checklist",
    pattern: /(?:每章|本章|章尾|开头|前三章|黄金三章).{0,30}(?:必须|至少|只准|只用|只埋|完成|包含|出现|兑现|回收|推进|变化|钩子)/u
  },
  {
    id: "fixed-scene-or-beat",
    pattern: /(?:第\s*[一二三四五六七八九十百两\d]+\s*(?:个)?场景|固定场景|场景表|节拍表|控制卡|施工单|验收表|逐项验收|逐项展示)/u
  },
  {
    id: "fixed-frequency",
    pattern: /(?:每\s*\d+\s*(?:至|到|[-–—])\s*\d+\s*字|每隔\s*\d+\s*字|每章至少|每场.{0,12}至少|连续\s*[一二三四五六七八九十百两\d]+\s*章)/u
  }
];

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function shouldApplyDraftPolicy(kind = "draft", taskLabel = "") {
  const values = [normalize(kind), normalize(taskLabel)].filter(Boolean);
  return values.some((value) => PROSE_KINDS.has(value) || /(?:^|_)(?:draft|chapter|fiction|prose|rewrite|revise)(?:_|$)/u.test(value));
}

function sanitizeProjectContext(value = "") {
  const source = String(value || "").replace(/\r\n?/g, "\n");
  if (!source.trim()) {
    return { text: "", removedCount: 0, rules: [], removedSamples: [] };
  }

  const kept = [];
  const removed = [];
  for (const line of source.split("\n")) {
    const parts = line.split(/(?<=[。！？；;])/u);
    const keptParts = [];
    for (const part of parts) {
      const hit = LEGACY_CONTEXT_RULES.find((rule) => rule.pattern.test(part));
      if (hit) {
        removed.push({ rule: hit.id, line: part.trim().slice(0, 180) });
        continue;
      }
      keptParts.push(part);
    }
    kept.push(keptParts.join(""));
  }

  return {
    text: kept.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    removedCount: removed.length,
    rules: [...new Set(removed.map((item) => item.rule))],
    removedSamples: removed.slice(0, 12)
  };
}

function normalizeMinimumChars(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return Math.min(Math.floor(numeric), 200000);
}

function buildMinimumLengthGuidance(minChars) {
  if (!minChars) return "";
  return [
    "# 本次篇幅要求",
    `完整正文不得少于 ${minChars} 个中文字符。这个数字只表示全章最低完成量，不用于切分场景、安排节拍或规定停处。`,
    "不要完成提示中提到的几个动作就提前收尾。若眼前这一件事自然写完仍不足，沿现有因果进入人物下一步真正会采取的行动、取舍及其后果；不得靠复述、旁白解释、逐项操作，或擅自补造姓名、数量、地形、日期和存量凑篇幅。"
  ].join("\n");
}

function prepareDraftPrompt({ prompt = "", projectContext = "", minChars = 0 } = {}) {
  const task = String(prompt || "").trim();
  const context = sanitizeProjectContext(projectContext);
  const minimumChars = normalizeMinimumChars(minChars);
  const currentRequest = [task, buildMinimumLengthGuidance(minimumChars)].filter(Boolean).join("\n\n");
  if (!context.text) {
    return {
      prompt: currentRequest,
      minimumChars,
      contextSanitization: {
        applied: Boolean(String(projectContext || "").trim()),
        removedCount: context.removedCount,
        rules: context.rules
      }
    };
  }

  return {
    prompt: [
      "# 已净化的项目背景",
      "以下内容只提供人物、事实与当下处境，不代表正文顺序，也不得恢复被清除的旧章数、字数、次数或验收命令。",
      context.text,
      "# 作者本次要求",
      currentRequest
    ].join("\n\n"),
    minimumChars,
    contextSanitization: {
      applied: true,
      removedCount: context.removedCount,
      rules: context.rules
    }
  };
}

function buildDraftSystem({ system = "", kind = "draft", taskLabel = "" } = {}) {
  const authorSystem = String(system || "").trim();
  if (!shouldApplyDraftPolicy(kind, taskLabel)) {
    return { system: authorSystem, applied: false, policyVersion: "caller-only" };
  }

  const policy = [
    "# 插件固定的自然写作制度",
    "事实是硬边界，写法是自由区。作者本次要求和已经确认的人物、处境、知情范围与因果优先。",
    "没有明确给出的姓名、精确数量、地形、日期、存量、器物来源和人物身份，不要自行补全；让人物按眼前证据作相对判断，暂时不知道也可以。",
    "项目材料只帮助记住故事，不是正文施工顺序。旧章位、字数、频率、栏目和验收安排，除非作者本次重新指定，否则不执行。",
    "章节方向只说明人物、关系或局势将发生的实质变化，不是‘先做A、再做B、最后发现C’的动作顺序。除非作者本次明确指定顺序，提示中的多个动作只作可能性，不得逐项完成后立刻收尾。",
    "贴着人物此刻真正注意和处理的事情写，让动作、对话与后果带出必要信息；场景暂时用不到的设定可以不出现，没办完的事也可以留下。上一章的停处只承接到人物真正接住为止，不把过渡动作、误会、点验或沟通本身拖成整章。",
    "人物按自己的身份、知识和处境判断。一个意思只留一次：动作或对话已经让读者明白，就省去紧随其后的解释、动机翻译和主题结论；内心只保留会改变下一步行动的部分。也不要为了所谓人味刻意制造误判或残缺。",
    "篇幅来自事情继续发生：人物采取新的行动、作出新的取舍，并遇到可见的结果。不要靠复述前文、重复观察、逐项操作、解释读者已经明白的意思或虚构精确细节凑长文。",
    "系统、兵种、语言、物资、能力和阵营不能按提示词栏目逐项亮相。开头、取舍、转场和停处由这一次故事的因果决定。",
    "只输出小说正文，不出现任务分析、栏目名、写作术语或执行说明。"
  ].join("\n");

  return {
    system: [authorSystem, policy].filter(Boolean).join("\n\n"),
    applied: true,
    policyVersion: POLICY_VERSION
  };
}

module.exports = {
  POLICY_VERSION,
  shouldApplyDraftPolicy,
  buildDraftSystem,
  sanitizeProjectContext,
  prepareDraftPrompt
};
