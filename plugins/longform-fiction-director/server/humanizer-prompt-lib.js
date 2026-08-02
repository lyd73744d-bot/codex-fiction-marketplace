"use strict";

const FOCUS_HINTS = {
  full: "综合去AI味：先查整章是否在逐项执行提示词，再删空句、压解释腔、避免把潜台词说满、节奏可朗读。",
  dialogue: "重点改对话：让人物在当前关系里真正做事，保留各自声口；该直说时可以直说，不把人人半句话当成人味。",
  narration: "重点改叙述：识别细纲验收流程腔和换皮结构，删总结腔/套话，不替读者翻译潜台词。",
  pacing: "重点改节奏：修复因果跳步和重复解释，不套固定拍数，保留必要停留。",
  emotion: "重点改情绪表达：落到具体关系、在意对象与选择；可直写也可间接写，不批量补身体反应。",
  info: "重点拆信息倾倒：本章立刻用到的才留在正文。",
  hook: "重点改章尾钩子：从本章因果长出，不要廉价惊吓。",
  explain: "重点去解释腔/主题总结：删“这意味着/不难看出”，不把动作和对白再解释一遍。"
};

function boundedContext(value, maxChars) {
  const text = String(value || "").replace(/\r\n?/g, "\n").trim();
  if (text.length <= maxChars) return text;
  const head = Math.floor(maxChars * 0.72);
  const tail = maxChars - head;
  return `${text.slice(0, head)}\n\n[中间内容未传入：只保留与本次改稿有关的事实]\n\n${text.slice(-tail)}`;
}

function loadMethodPack(focus = "full") {
  const cards = {
    dialogue: "让每句话仍属于说话的人和现场关系；已由上下文说明的意思不再由旁白重讲。",
    narration: "删掉只在解释读者已懂之事的句子；保留能改变判断、关系或下一步行动的叙述。",
    pacing: "补回真正缺失的因果，压缩重复解释；不要为了显得有节奏另造转场、事件或悬念。",
    emotion: "情绪落在具体对象、关系与选择上；原文没有可用细节时可以直接写，不补通用身体反应。",
    info: "保留当下判断和行动确实需要的信息，其余不在此处补课。",
    hook: "收尾只接住本章已有的结果或未完成行动，不加与本章无关的惊吓和预告。",
    explain: "动作、对话或结果已经说清的意思，不再用一句结论翻译一遍。"
  };
  return cards[focus] || "只改真正影响阅读的地方；不为证明改过而另造句式、细节或新情节。";
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
    "叙事留白：人物不必一次说完动机、情绪、关系结论和正确答案，旁白不紧跟着翻译潜台词；但人物有理由直说时允许说清。必要事实与因果仍须清楚，未明说部分必须能从动作、反应、上下文或后果中读回；不得用密集省略号、神秘碎句或人人欲言又止假装留白。",
    "表达选择：展示与讲述按重要程度分工，不把抽象情绪统一替换成握拳、心跳、喉结、眼神或天气，也不为画面感凭空补齐五感。‘说、问、道’可以正常使用，动作只在改变话意、关系或节奏时加入。",
    "对白去口号：敌意、威胁、报复、翻盘和决心必须落在当前对象、旧事、筹码、条件或下一步行动上，不写脱离人物和现场也能成立的通用狠话；没有说话必要时可以不说，不得只换近义词。",
    "结构去流程腔：先看整章是否按大纲、细纲或提示词的栏目顺序逐项展示和验收设定。若主角持续给出最优处理、其他人物只递交恰好需要的答案，或系统/兵种/语言/物资/能力依次亮相，应保留事实后重新组织场景与披露顺序；不得只换专名、同义词或套用另一种开篇公式。单独一次危机、命令、回报或正确判断不算问题。",
    "输出：除 review 模式外，只输出完整正文，不要前言后语。",
    methods ? ("参考方法（遵守，不要照抄示例句）：\n" + methods) : ""
  ].filter(Boolean).join("\n\n");
}

function buildOptimizePrompt({ mode = "humanize", focus = "full", instruction = "", draftText = "", context = {} } = {}) {
  const voice = boundedContext(context.voice, 3_000) || "（无）";
  const facts = boundedContext(context.facts, 6_000);
  const cards = boundedContext(context.cards, 6_000) || "（无）";
  const brief = boundedContext(context.brief, 5_000) || "（无）";
  return [
    "# 任务模式",
    mode,
    "# 焦点",
    focus,
    "",
    "# 作者额外要求",
    instruction || "无",
    "",
    "# 本次相关背景（只用来守住事实，不是改稿顺序）",
    "- 文风锚点：", voice,
    facts ? ("\n# 已确认事实\n" + facts + "\n") : "",
    "- 人物/核验摘录：", cards,
    "- 当前章节笔记：", brief,
    "",
    "# 待处理正文",
    String(draftText || "").trim()
  ].join("\n");
}

module.exports = {
  FOCUS_HINTS,
  loadMethodPack,
  boundedContext,
  buildOptimizeSystem,
  buildOptimizePrompt
};
