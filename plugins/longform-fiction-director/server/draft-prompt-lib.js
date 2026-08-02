"use strict";

const POLICY_VERSION = "natural-prose-v7";
const PROSE_KINDS = new Set([
  "draft", "chapter", "chapter_draft", "continuous_draft", "fiction", "prose", "rewrite", "revise"
]);
const PLANNING_KINDS = new Set([
  "brainstorm", "idea", "premise", "outline", "synopsis", "character", "character_design",
  "chapter_outline", "chapter_plan", "brief", "title", "blurb"
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
  // Planning names such as chapter_outline also contain "chapter". Resolve the
  // explicit planning family first so an outline never inherits prose-only rules.
  if (planningFocus(kind, taskLabel)) return false;
  const values = [normalize(kind), normalize(taskLabel)].filter(Boolean);
  return values.some((value) => PROSE_KINDS.has(value) || /(?:^|_)(?:draft|chapter|fiction|prose|rewrite|revise)(?:_|$)/u.test(value));
}

function planningFocus(kind = "", taskLabel = "") {
  const value = [normalize(kind), normalize(taskLabel)].filter(Boolean).join("_");
  if (!value) return "";
  if (/(?:细纲|章纲|chapter_outline|chapter_plan|brief)/u.test(value)) return "chapter-outline";
  if (/(?:人物|角色|character)/u.test(value)) return "character";
  if (/(?:书名|简介|title|blurb|synopsis)/u.test(value)) return "packaging";
  if (/(?:大纲|outline)/u.test(value)) return "outline";
  if (/(?:脑洞|构思|创意|brainstorm|idea|premise)/u.test(value)) return "brainstorm";
  return PLANNING_KINDS.has(normalize(kind)) ? "planning" : "";
}

function buildPlanningSystem({ system = "", kind = "", taskLabel = "" } = {}) {
  const authorSystem = String(system || "").trim();
  const focus = planningFocus(kind, taskLabel);
  if (!focus) return { system: authorSystem, applied: false, policyVersion: "caller-only" };

  const common = [
    "# 插件固定的故事策划边界",
    "课程方法只帮助判断当前故事，不是待填模板。不要输出场景卡、固定字数、固定阶段、情绪公式或逐章验收表，除非作者本次明确要求某种格式。",
    "从人物所求、关系、知识、现实条件和选择后果里发展故事。技巧只在解决真实问题时使用，不为展示技巧强加事故、反转、悬念或身体反应。",
    "作者本次明确写出的事实、视角、人物、时间、地点、因果和限制都是硬边界，不得为了写得顺口而改换来源、归属或发生方式；接不上的地方可以保留人物的不知、迟疑和误解，不要另造一个更方便的版本。",
    "动笔前在心里确认本次已经给定的硬事实；写完后再核对一次年份、人物归属、信息来源和能力边界。这个核对不写出来，也不能被故事性取代。",
    "本次提供的事实和项目上下文，构成本次可以落成确定事实的范围。尤其是历史题材，未给出的地点、人数、军队名称、人物、日期、战况和器物，不得凭模型记忆补全；可以写相对位置、相对数量、称谓或人物当下的不知。",
    "保留作者最想写的部分；不确定的远期办法、姓名、数量、日期和史实保持未知。输出用自然语言，允许回改和留白。"
  ];
  const focusLines = {
    brainstorm: "构思应给出真正不同的人物处境与长线可能，说明各自会加强什么、削弱什么；不要只换题材名、能力名和反派名。",
    outline: "全书大纲要从开头讲到结局，写清主要人物如何介入、关键选择怎样改变关系或局势、阶段结果为何引出下一阶段；不能写成升级目录、系统功能巡展或逐章任务书。",
    character: "人物从长期在乎、眼前要办、惯常做法、知识与能力边界和具体关系来理解；性格由选择表现，不强迫每人具备同样数量的标签、弱点和反差。",
    "chapter-outline": "章节细纲用自然段讲清承接、人物选择、他人回应、实际结果与暂未说透的信息；不规定正文第一句、固定场景数、披露顺序和章尾形式。",
    packaging: "书名与简介应准确传达这本书已经成立的阅读承诺，不许诺正文没有的体验，也不套固定热词结构。",
    planning: "只完成作者当前策划任务，不强迫补齐无关栏目或把整套方法重新走一遍。"
  };
  return {
    system: [authorSystem, [...common, focusLines[focus]].join("\n")].filter(Boolean).join("\n\n"),
    applied: true,
    policyVersion: "story-planning-v1"
  };
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
    return buildPlanningSystem({ system: authorSystem, kind, taskLabel });
  }

  const policy = [
    "# 插件固定的自然写作制度",
    "事实是硬边界，写法是自由区。作者本次要求和已经确认的人物、处境、知情范围与因果优先。",
    "作者明确给出的事实、视角、人物、时间、地点、因果和限制不得挪给别人、换成别的来源或改写成另一种发生方式。写到不明之处时保留人物的无知、迟疑和误解，不要自行补造一个更顺口的版本。",
    "动笔前在心里确认本次已经给定的硬事实；写完后再核对一次年份、人物归属、信息来源和能力边界。这个核对不写出来，也不能被故事性取代。",
    "本次提供的事实和项目上下文，构成本次可以落成确定事实的范围。尤其是历史题材，未给出的地点、人数、军队名称、人物、日期、战况和器物，不得凭模型记忆补全；可以写相对位置、相对数量、称谓或人物当下的不知。",
    "没有明确给出的姓名、精确数量、地形、日期、存量、器物来源和人物身份，不要自行补全；让人物按眼前证据作相对判断，暂时不知道也可以。",
    "项目材料只帮助记住故事，不是正文施工顺序。旧章位、字数、频率、栏目和验收安排，除非作者本次重新指定，否则不执行。",
    "章节方向只说明人物、关系或局势将发生的实质变化，不是‘先做A、再做B、最后发现C’的动作顺序。除非作者本次明确指定顺序，提示中的多个动作只作可能性，不得逐项完成后立刻收尾。",
    "开头先让读者进入这个人物正在经历的具体生活。危险、异常、关系、日常、选择或余波都可以成为入口；不要为了抓人强行新增事故，也不要复刻其他题材的功能顺序。",
    "贴着人物此刻真正注意和处理的事情写，让动作、对话与后果带出必要信息；场景暂时用不到的设定可以不出现，没办完的事也可以留下。上一章的停处只承接到人物真正接住为止，不把过渡动作、误会、点验或沟通本身拖成整章。",
    "事情从人物各自想得到、保住、逃开或弄明白的东西里发生。阻碍来自已经成立的利益、关系、规则、资源、误解或人物局限，不为追求刺激强行增加事故；人物可以做成、做错、拖延、放弃或暂时没有结论。",
    "细节、对白、心理和背景只有在改变当前判断、关系、选择、后果或读者理解时才展开。关键处可以写细，转场和概述可以简洁；不按固定快慢、固定情绪曲线或固定章尾形式写，也不为画面感逐项补齐五感。",
    "对白是人物在争取、试探、拒绝、遮掩、求证或改变决定。人物可以直说，也可以绕开，取决于身份、关系和现场；不要让所有人都欲言又止，也不要为了避开‘说’字给每句对白配置动作。",
    "人物按自己的身份、知识和处境判断。一个意思只留一次：动作或对话已经让读者明白，就省去紧随其后的解释、动机翻译和主题结论；内心只保留会改变下一步行动的部分。也不要为了所谓人味刻意制造误判或残缺。",
    "情绪落在人物真正在乎的对象、关系和选择上。可以直写，也可以由动作、感受或沉默显出；不要批量使用握拳、心跳、喉结、眼神变化和环境比喻替代情绪词。",
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
  planningFocus,
  buildPlanningSystem,
  buildDraftSystem,
  sanitizeProjectContext,
  prepareDraftPrompt
};
