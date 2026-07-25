"use strict";

const ENGINE_NAMES = Object.freeze([
  "即时反馈型",
  "悬念揭示型",
  "压力选择型",
  "关系情绪型",
  "规则异化型",
  "博弈经营型",
  "共同体孵化型"
]);

const GOLDEN_THREE_STAGES = Object.freeze({
  1: Object.freeze({
    stage: "绑定",
    goal: "建立记忆信号和明确问题，用一次小而真实的兑现改变故事状态。",
    stateChange: "信息、关系、资源、能力、目标或身份判断至少有一项发生真实变化。",
    handoff: "回答一个小问题，再把第2章要处理的问题变得更具体、更有代价。"
  }),
  2: Object.freeze({
    stage: "加深",
    goal: "回答上一章的问题，暴露新的限制或矛盾，把核心承诺推到验证门口。",
    stateChange: "人物目标或读者判断发生一次变化，表面解释不再足够。",
    handoff: "给出真实答案或证据，并把第3章必须验证的结果明确下来。"
  }),
  3: Object.freeze({
    stage: "验证",
    goal: "让核心阅读承诺完整运转一次，用可见结果结清一笔账并打开长线故事。",
    stateChange: "资源、身份、关系、能力边界或长期目标至少有一项得到可见验证。",
    handoff: "从本次验证自然打开更大的舞台、危机、关系债或阶段门槛。"
  })
});

const LONG_TERM_STAGE = Object.freeze({
  stage: "续航",
  goal: "沿用已经证明有效的核心承诺和项目发动机，用新的压力、选择、回报与代价持续推进，不重复已经完成的能力展示。",
  stateChange: "信息、关系、资源、能力边界、目标或局面至少有一项发生真实变化。",
  handoff: "把当前结果转成下一章可执行的问题、任务、关系债、资源缺口或具体代价。"
});

const ENGINE_LOOPS = Object.freeze({
  即时反馈型: "反常行动 -> 他人误判或阻力 -> 可见反应 -> 收益或任务进度变化 -> 更高要求。",
  悬念揭示型: "可信解释 -> 新证据 -> 证明解释不完整 -> 回收一个问题 -> 留下更深矛盾。",
  压力选择型: "现实威胁 -> 两难选择 -> 主角行动 -> 代价或救回 -> 更大后果。",
  关系情绪型: "关系缺口 -> 试探或误读 -> 行动回执 -> 关系改价 -> 新关系债。",
  规则异化型: "熟悉场景 -> 反常规则 -> 具体价格或惩罚 -> 人物调整行动 -> 更深制度压力。",
  博弈经营型: "多方利益与信息差 -> 主角研判 -> 低成本落子 -> 他人重新站位 -> 权力或资源边界变化。",
  共同体孵化型: "种子资源或共同危机 -> 成员按立场行动 -> 第一次共同决策 -> 资源账与共同体边界变化。"
});

const ORIGINALITY_BOUNDARY = "只学章节功能和因果节奏，不复制样书人物、专名、台词、任务数值或连续事件顺序；作者当前要求、已保存事实和当前章细纲优先。";

function normalizeChapterNumber(value) {
  if (Number.isFinite(value)) {
    const number = Math.trunc(value);
    return number > 0 ? number : 0;
  }
  const source = String(value || "").trim();
  if (!source) return 0;
  const chapterMatch = source.match(/第\s*0*(\d+)\s*章/);
  const plainMatch = source.match(/^0*(\d+)$/);
  const number = Number((chapterMatch && chapterMatch[1]) || (plainMatch && plainMatch[1]) || 0);
  return Number.isInteger(number) && number > 0 ? number : 0;
}

function goldenThreeStage(value) {
  const chapterNumber = normalizeChapterNumber(value);
  const stage = GOLDEN_THREE_STAGES[chapterNumber];
  if (stage) return { chapterNumber, ...stage };
  return chapterNumber >= 4 ? { chapterNumber, ...LONG_TERM_STAGE } : null;
}

function coachForChapter(chapterNo, { engineName = "" } = {}) {
  const stage = goldenThreeStage(chapterNo);
  if (!stage) {
    return {
      ok: true,
      coach: "先确认本章要改变什么事实，再写。不要空转氛围。",
      originalityBoundary: ORIGINALITY_BOUNDARY
    };
  }
  const engine = ENGINE_LOOPS[engineName] || "";
  return {
    ok: true,
    chapterNumber: stage.chapterNumber,
    stage: stage.stage,
    goal: stage.goal,
    stateChange: stage.stateChange,
    handoff: stage.handoff,
    engineName: engineName || null,
    engineLoop: engine || null,
    originalityBoundary: ORIGINALITY_BOUNDARY,
    coach: [
      "第" + stage.chapterNumber + "章阶段：" + stage.stage,
      "目标：" + stage.goal,
      "必须变化：" + stage.stateChange,
      "交接：" + stage.handoff,
      engine ? ("发动机：" + engineName + " / " + engine) : "可先选发动机类型再写细纲。",
      ORIGINALITY_BOUNDARY
    ].join("\n")
  };
}

module.exports = {
  ENGINE_NAMES,
  GOLDEN_THREE_STAGES,
  LONG_TERM_STAGE,
  ENGINE_LOOPS,
  ORIGINALITY_BOUNDARY,
  normalizeChapterNumber,
  goldenThreeStage,
  coachForChapter
};
