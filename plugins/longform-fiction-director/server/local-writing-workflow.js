"use strict";

/**
 * Local writing workflow:
 * - default: step by step (editor-coach voice)
 * - optional: continuous run after author authorization
 * - progress: chapter artifact status + short encouraging author brief
 * - never auto-settle without author confirmation
 */
const LOCAL_LADDER = Object.freeze([
  {
    id: "bind",
    label: "绑定资料",
    goal: "先把本子、人物和文风锚点齐好，我们再安心开工。你不需要一次做完美。",
    authorSays: ["先列出要绑定的文件", "绑定当前项目资料", "帮我看看还缺什么资料"]
  },
  {
    id: "brainstorm",
    label: "脑洞",
    goal: "先轻松发散，把可能性摊开；默认本地聊，不急着定死章数。",
    authorSays: ["开脑洞", "卡住了换角度", "这一段我想再发散一下"]
  },
  {
    id: "outline",
    label: "细纲",
    goal: "把你已认可的方向收成可写节拍与章节控制卡。先搭骨架，正文稍后再落。",
    authorSays: ["写这章细纲", "先查细纲缺口", "连续跑到候选正文"]
  },
  {
    id: "draft",
    label: "候选正文",
    goal: "按已确认控制卡写出候选稿先给你看。确认前绝不偷偷入台账，你永远有否决权。",
    authorSays: ["按细纲写正文", "重写这一段候选", "连续跑完本章质检"]
  },
  {
    id: "humanize",
    label: "去 AI 味",
    goal: "可选润色：先定轻/中/重，再改表达。剧情、设定、人物选择我们不动。",
    authorSays: ["去 AI 味", "润色候选正文", "这一版有点硬，帮我柔一下"]
  },
  {
    id: "review",
    label: "质检",
    goal: "你主动开启时，我再做终检（设定+钩子/爽点）。未通过我们一起改，绝不假装已交付。",
    authorSays: ["过质检", "检查这段", "看看能不能过"]
  },
  {
    id: "confirm",
    label: "确认入台账",
    goal: "你点头后，我才写入正式正文，并陪你做结算摘要。这一步永远听你的。",
    authorSays: ["确认这版", "写入正文并更新进度", "这版我认了，结算吧"]
  }
]);

const CHAPTER_STATUSES = Object.freeze({
  empty: { id: "empty", label: "未开工", nextPhase: "brainstorm" },
  outlined: { id: "outlined", label: "细纲已有", nextPhase: "draft" },
  draft_candidate: { id: "draft_candidate", label: "候选正文待看", nextPhase: "humanize" },
  humanized: { id: "humanized", label: "已去AI味待质检/确认", nextPhase: "review" },
  review_pass: { id: "review_pass", label: "质检通过待确认", nextPhase: "confirm" },
  review_blocked: { id: "review_blocked", label: "质检未过", nextPhase: "revise" },
  confirmed: { id: "confirmed", label: "已确认入台账", nextPhase: "outline" }
});

const SETTLEMENT_CHECKLIST = Object.freeze([
  "本章结果（发生了什么、谁承受）",
  "人物/物件状态变化",
  "伏笔新增或推进",
  "时间线位置",
  "下一章钩子",
  "只更新真实变化，不复制整本台账"
]);

const PHASE_GUIDE = Object.freeze({
  brainstorm: {
    usesGateway: false,
    do: "我是你的责编，这一步我们先轻松开脑洞：本地聊方向、反例与可能性。涉及历史、兵器或战役时，我先帮你查公开资料。你点名模型时，再把脑洞交给模型。",
    checklist: [
      "先听你卡在哪，不急着定章数——慢一点没关系",
      "公开资料只记可迁移限制，不堆百科",
      "输出可能性与选项，不擅自写成细纲"
    ],
    next: [
      { id: "outline", label: "方向定下后，我们一起做细纲" },
      { id: "continuous_to_draft", label: "若你授权：连续跑 细纲→正文候选" },
      { id: "brainstorm", label: "还想再发散？我们换个角度继续想" },
      { id: "rank_research", label: "需要时，我帮你对标公开榜单预期" }
    ]
  },
  outline: {
    usesGateway: true,
    do: "好，方向有了。我帮你把已认可材料收成可写细纲：冲突、信息差、节拍、章末钩子。骨架先站稳，正文我们下一步再上。",
    checklist: [
      "只写你已确认的事实，缺的标待确认",
      "每节标明压力来源，方便后面下笔",
      "缺信息就问你，绝不瞎猜补全"
    ],
    next: [
      { id: "draft", label: "细纲够用了？我们写候选正文" },
      { id: "continuous_to_review", label: "若你授权：连续跑完本章（正文→可选去AI味→质检）" },
      { id: "gap_check", label: "先查缺口再写，稳一点" },
      { id: "brainstorm", label: "卡住了就回脑洞，完全正常" }
    ]
  },
  draft: {
    usesGateway: true,
    do: "按已确认控制卡生成候选正文，先给你看。候选稿不是终稿——你随时能改、能否决、能重来。我不会自动写入正式正文。",
    checklist: [
      "严格服从绑定辅助文档",
      "候选稿先给你过目，再谈下一步",
      "不擅自开质检，等你点头"
    ],
    next: [
      { id: "humanize", label: "需要时，我帮你去 AI 味" },
      { id: "review", label: "需要时，我们做质检" },
      { id: "continuous_polish", label: "若你授权：连续跑 去AI味→质检" },
      { id: "confirm", label: "你满意的话，可以直接确认" }
    ]
  },
  humanize: {
    usesGateway: true,
    do: "这一步只处理表达和机械感。剧情、设定、人物选择、事件顺序、章末钩子——这些是你的，我不动。我们先定轻/中/重，再动手。",
    checklist: [
      "对照文风锚点，保留你的声音",
      "事实与钩子原样保留",
      "改完仍是候选稿，等你拍板"
    ],
    next: [
      { id: "review", label: "需要时，我们再复查一遍" },
      { id: "confirm", label: "你满意就可直接确认" }
    ]
  },
  review: {
    usesGateway: true,
    do: "我来帮你做责编终检：设定、连续性、钩子/爽点与表达。会给你清楚的问题清单和是否通过。未通过也别慌，我们定点改就好。",
    checklist: [
      "重读全部绑定资料，不漏硬规则",
      "硬规则未过就标 blocked，绝不粉饰",
      "未通过不得说成已交付"
    ],
    next: [
      { id: "revise", label: "有问题？我们定点轻改" },
      { id: "confirm", label: "通过后，由你确认入台账" }
    ]
  },
  revise: {
    usesGateway: true,
    do: "按已发现的问题定点轻改，不重写故事。改完若要交付，我们再过一遍质检。你仍然握有最终确认权。",
    checklist: [
      "只改命中问题，不扩大手术面",
      "改完若要交付须重新 review",
      "仍须你确认后才入台账"
    ],
    next: [
      { id: "review", label: "改完我们再复查" },
      { id: "confirm", label: "你满意可直接确认" }
    ]
  },
  confirm: {
    usesGateway: false,
    do: "你确认后，我才写入正式正文，并输出结算摘要更新台账。这一步是你的主权时刻——点头才落章。",
    checklist: SETTLEMENT_CHECKLIST.slice(),
    next: [
      { id: "outline", label: "准备好了？我们开始下一章细纲" },
      { id: "continuous_to_review", label: "若你授权：连续跑下一章" }
    ]
  }
});

const GENRE_RECIPES = Object.freeze([
  {
    id: "historical_military",
    label: "历史军事",
    summary: "后勤、情报、士气、制度摩擦优先；战场先写约束再写爆发。你写得越具体，读者越信。",
    focus: ["情报误差", "补给与天气", "将领性格冲突", "战后代价"]
  },
  {
    id: "xuanhuan_cultivation",
    label: "玄幻修仙",
    summary: "境界、资源、因果与脸面要可记账；突破必须付代价。爽点来自挣来的，不是白送的。",
    focus: ["资源争夺", "功法风险", "势力站队", "境界瓶颈"]
  },
  {
    id: "urban_reality",
    label: "都市现实",
    summary: "职场/人情/金钱/面子的具体摩擦推进，落到可执行选择。生活感就是说服力。",
    focus: ["利益交换", "信息差", "关系代价", "公共场合压力"]
  },
  {
    id: "suspense",
    label: "悬疑推理",
    summary: "线索与时间线可回查；揭晓前保留可验证伏笔。读者爱的是公平的悬念。",
    focus: ["异常物证", "时间线裂缝", "误导与代价", "未解钩子"]
  },
  {
    id: "system_flow",
    label: "系统流",
    summary: "任务、奖惩、冷却与副作用规则化；系统是压力源不是许愿机。规则越硬，爽点越稳。",
    focus: ["任务约束", "奖励副作用", "规则漏洞博弈", "升级代价"]
  },
  {
    id: "romance_emotion",
    label: "情感向",
    summary: "关系推进靠具体选择与代价，不靠空喊喜欢。一个小动作，胜过十句告白。",
    focus: ["误会产生条件", "公开场合压力", "不可逆一步", "余韵物件"]
  }
]);

const CONTINUOUS_PRESETS = Object.freeze({
  to_draft: {
    id: "to_draft",
    label: "连续跑到候选正文",
    description: "从细纲连到候选正文。每步我都会展示结果给你看；绝不自动入台账。",
    stages: ["outline", "draft"],
    stopOnBlock: true,
    autoSettle: false
  },
  chapter_once: {
    id: "chapter_once",
    label: "连续跑完本章",
    description: "细纲→正文→去AI味→质检。一章生产链跑通；入台账仍要你点头。",
    stages: ["outline", "draft", "humanize", "review"],
    stopOnBlock: true,
    autoSettle: false
  },
  polish_once: {
    id: "polish_once",
    label: "连续润色质检",
    description: "已有候选正文时：去AI味→质检。润完先给你看。",
    stages: ["humanize", "review"],
    stopOnBlock: true,
    autoSettle: false
  },
  multi_chapter: {
    id: "multi_chapter",
    label: "连续多章",
    description: "按章循环 chapter_once。每章结束后我都会停一下，问你是否入台账、是否继续。",
    stages: ["outline", "draft", "humanize", "review"],
    stopOnBlock: true,
    autoSettle: false,
    requiresChapterCount: true
  }
});

function softActionsForPhase(phase) {
  const guide = PHASE_GUIDE[phase];
  if (!guide) return [];
  return guide.next.map((item) => {
    let say = item.label;
    if (item.id === "gap_check") say = "按当前细纲检查这章还缺什么，只列缺口不写正文。缺什么我们一起补。";
    if (item.id === "rank_research") say = "按当前题材做公开榜单研究，只提炼可迁移读者预期。";
    if (item.id === "confirm") say = "这版我确认了，写入正文并给出结算摘要：结果、人物状态、伏笔、下一钩。";
    if (item.id === "continuous_to_draft") say = "按流程连续跑：细纲到候选正文，每步展示结果，先不入台账。";
    if (item.id === "continuous_to_review") say = "按流程连续跑完本章：细纲、正文、去AI味、质检；确认入台账前先给我看。";
    if (item.id === "continuous_polish") say = "按流程连续跑：去AI味再质检，结果先给我看。";
    return { id: item.id, label: item.label, say };
  });
}

function normalizeContinuousOptions(input = {}) {
  const presetId = String(input.preset || input.continuousPreset || "chapter_once").trim() || "chapter_once";
  const preset = CONTINUOUS_PRESETS[presetId];
  if (!preset) {
    const error = new Error("continuous preset is invalid.");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  let chapterCount = 1;
  if (input.chapterCount !== undefined && input.chapterCount !== null && input.chapterCount !== "") {
    chapterCount = Number(input.chapterCount);
    if (!Number.isInteger(chapterCount) || chapterCount < 1 || chapterCount > 20) {
      const error = new Error("chapterCount must be an integer from 1 to 20.");
      error.code = "INVALID_ARGUMENT";
      throw error;
    }
  }
  const includeHumanize = input.includeHumanize !== false;
  const includeReview = input.includeReview !== false;
  const fromPhase = input.fromPhase ? String(input.fromPhase).trim() : null;
  return { preset, chapterCount, includeHumanize, includeReview, fromPhase };
}

function filterStages(stages, { includeHumanize, includeReview, fromPhase }) {
  let list = stages.slice();
  if (!includeHumanize) list = list.filter((stage) => stage !== "humanize");
  if (!includeReview) list = list.filter((stage) => stage !== "review" && stage !== "revise");
  if (fromPhase && list.includes(fromPhase)) {
    list = list.slice(list.indexOf(fromPhase));
  }
  return list;
}

function normalizeProgress(progress = {}) {
  return {
    chapterTitle: progress.chapterTitle ? String(progress.chapterTitle).trim() : "",
    hasOutline: progress.hasOutline === true,
    hasDraft: progress.hasDraft === true,
    hasHumanized: progress.hasHumanized === true,
    reviewStatus: String(progress.reviewStatus || "").trim().toLowerCase(),
    confirmed: progress.confirmed === true
  };
}

function deriveChapterStatus(progress = {}) {
  const p = normalizeProgress(progress);
  if (p.confirmed) return CHAPTER_STATUSES.confirmed;
  if (p.reviewStatus === "pass" || p.reviewStatus === "passed") return CHAPTER_STATUSES.review_pass;
  if (p.reviewStatus === "blocked" || p.reviewStatus === "fail" || p.reviewStatus === "failed") {
    return CHAPTER_STATUSES.review_blocked;
  }
  if (p.hasHumanized) return CHAPTER_STATUSES.humanized;
  if (p.hasDraft) return CHAPTER_STATUSES.draft_candidate;
  if (p.hasOutline) return CHAPTER_STATUSES.outlined;
  return CHAPTER_STATUSES.empty;
}

function resolvePhase(phase, progress) {
  const raw = String(phase || "").trim();
  if (raw && (PHASE_GUIDE[raw] || raw === "revise")) return raw === "revise" ? "revise" : raw;
  return deriveChapterStatus(progress).nextPhase;
}

function ladderForPhase(phase) {
  const order = LOCAL_LADDER.map((step) => step.id);
  const mapped = phase === "revise" ? "review" : phase;
  const idx = order.indexOf(mapped);
  const currentIdx = idx >= 0 ? idx : 1;
  return LOCAL_LADDER.map((step, i) => ({
    ...step,
    status: i < currentIdx ? "done_or_skippable" : i === currentIdx ? "current" : "upcoming"
  }));
}

function buildContinuousRunPlan(input = {}) {
  const { preset, chapterCount, includeHumanize, includeReview, fromPhase } = normalizeContinuousOptions(input);
  const baseStages = filterStages(preset.stages, { includeHumanize, includeReview, fromPhase });
  if (!baseStages.length) {
    const error = new Error("continuous plan has no stages after filters.");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }

  const loops = preset.id === "multi_chapter" ? chapterCount : 1;
  const steps = [];
  for (let chapterOffset = 0; chapterOffset < loops; chapterOffset += 1) {
    for (const stage of baseStages) {
      steps.push({
        order: steps.length + 1,
        chapterOffset,
        stage,
        usesGateway: stage !== "brainstorm",
        prepare: stage === "brainstorm" ? "optional_gateway_or_codex" : "fiction_guide_stage_or_prepare",
        execute: stage === "review" || stage === "revise" ? "fiction_quality_gate" : "fiction_write_with_model_or_codex",
        onBlock: preset.stopOnBlock ? "stop_and_report" : "continue",
        authorVisible: true
      });
    }
    if (preset.id === "multi_chapter" || preset.id === "chapter_once" || preset.id === "to_draft" || preset.id === "polish_once") {
      steps.push({
        order: steps.length + 1,
        chapterOffset,
        stage: "confirm_gate",
        usesGateway: false,
        prepare: "none",
        execute: "wait_author_confirm_before_settle",
        onBlock: "stop_and_report",
        authorVisible: true,
        settlementChecklist: SETTLEMENT_CHECKLIST.slice(),
        note: "入台账必须你确认；连续跑不自动 settle。确认时我陪你输出结算摘要。"
      });
    }
  }

  return {
    mode: "continuous",
    preset: {
      id: preset.id,
      label: preset.label,
      description: preset.description,
      autoSettle: false,
      stopOnBlock: preset.stopOnBlock
    },
    chapterCount: loops,
    includeHumanize,
    includeReview,
    fromPhase,
    steps,
    rules: [
      "你明确授权连续跑后，我才执行本计划。",
      "每个付费阶段仍须重新 prepare / guide_stage，并展示结果给你看。",
      "任一步 blocked 或你叫停，我立刻停。",
      "连续跑可以连写候选与质检，但不得自动写入正式正文/台账。",
      "确认入台账时必须给出结算摘要：" + SETTLEMENT_CHECKLIST.join("；") + "。",
      "多章时：每章结束后先问是否确认入台账、是否继续下一章。"
    ],
    authorCanSay: [
      "连续跑完本章",
      "连续跑到候选正文",
      "连续跑三章，每章先给我看再入台账",
      "按流程自动执行到质检",
      "确认这版并结算进度"
    ]
  };
}

function continuousOptionsForPhase(phase) {
  if (phase === "brainstorm") {
    return [
      buildContinuousRunPlan({ preset: "to_draft", fromPhase: "outline" }),
      buildContinuousRunPlan({ preset: "chapter_once", fromPhase: "outline" })
    ];
  }
  if (phase === "outline") {
    return [
      buildContinuousRunPlan({ preset: "to_draft", fromPhase: "outline" }),
      buildContinuousRunPlan({ preset: "chapter_once", fromPhase: "outline" }),
      buildContinuousRunPlan({ preset: "multi_chapter", chapterCount: 3, fromPhase: "outline" })
    ];
  }
  if (phase === "draft" || phase === "humanize") {
    return [
      buildContinuousRunPlan({ preset: "polish_once", fromPhase: "humanize" }),
      buildContinuousRunPlan({ preset: "chapter_once", fromPhase: "draft" })
    ];
  }
  if (phase === "confirm" || phase === "review") {
    return [
      buildContinuousRunPlan({ preset: "chapter_once", fromPhase: "outline" }),
      buildContinuousRunPlan({ preset: "multi_chapter", chapterCount: 3, fromPhase: "outline" })
    ];
  }
  return [buildContinuousRunPlan({ preset: "chapter_once" })];
}

function modelTipForPhase(phase, usesGateway) {
  if (!usesGateway) {
    return "这一步本地就能聊，先不花积分。";
  }
  const tips = {
    outline: "细纲建议上模型：先看推荐与积分，你点头再写。",
    draft: "正文是主战场：关键章可上强模型，过渡章可更省。",
    humanize: "去 AI 味可选；先定轻/中/重，再选模型。",
    review: "质检建议交付前做；你说“过质检”我再开。",
    revise: "定点修改可上模型，只改命中问题。"
  };
  return tips[phase] || "付费前我会展示推荐模型，等你确认。";
}

function coachLineForPhase(phase, chapterStatus) {
  const map = {
    brainstorm: "先别急着定死，我们一起把方向聊开。",
    outline: "骨架搭好，后面写起来会轻松很多。",
    draft: "候选稿先给你看，写砸了也没关系，我们还能改。",
    humanize: "润色只动表达，故事主权在你手里。",
    review: "终检是帮你把关，不是挑刺为难你。",
    revise: "定点改就好，不必推倒重来。",
    confirm: "你点头这一下，才算真正落章。很棒。"
  };
  if (chapterStatus?.id === "review_blocked") {
    return "质检没过也正常，我们对着清单一点点修。";
  }
  if (chapterStatus?.id === "review_pass") {
    return "质检通过了，就差你确认入台账这一步。";
  }
  return map[phase] || "我们一步步来，你随时可以叫停或换方向。";
}

function buildAuthorBrief({ phase, chapterStatus, progress, current, continuousOptions, model }) {
  const done = LOCAL_LADDER.findIndex((step) => step.id === (phase === "revise" ? "review" : phase));
  const filled = Math.max(0, done + 1);
  const bar = `${"■".repeat(filled)}${"□".repeat(Math.max(0, LOCAL_LADDER.length - filled))}`;
  const coach = coachLineForPhase(phase, chapterStatus);
  const nextLabel = (continuousOptions[0] && continuousOptions[0].preset.label) || (current?.next?.[0]?.label) || "按你的指令继续";
  const lines = [
    `进度 ${bar} ${filled}/${LOCAL_LADDER.length}`,
    `本章状态：${chapterStatus.label}`,
    `当前步骤：${current?.id || phase} — ${current?.do || ""}`,
    progress.chapterTitle ? `章节：${progress.chapterTitle}` : null,
    model?.connected ? `模型：已连接${model.username ? `（${model.username}）` : ""}` : "模型：未检测/未连接",
    `责编提示：${coach}`,
    `模型建议：${modelTipForPhase(phase, current?.usesGateway === true)}`,
    `建议下一步：${nextLabel}`
  ].filter(Boolean);

  return {
    headline: "写作进度",
    bar,
    coach,
    lines,
    replyTemplate: [
      "【写作进度】",
      ...lines.map((line) => `- ${line}`),
      "- 你可以这样说：一步步继续 / 连续跑完本章 / 确认这版并结算",
      "- 我是你的责编，会陪你一步步来；跑通后也可连续跑，入台账永远听你的。"
    ].join("\n")
  };
}

function buildSettlementGuide() {
  return {
    required: true,
    autoSettle: false,
    checklist: SETTLEMENT_CHECKLIST.slice(),
    coachNote: "确认入台账时，我们一起做结算摘要，只记真实变化。",
    outputFormat: [
      "结算摘要：",
      "1. 本章结果：",
      "2. 人物/物件变化：",
      "3. 伏笔：",
      "4. 时间线：",
      "5. 下一章钩子："
    ].join("\n")
  };
}

function buildWorkflowGuide({
  bindingId,
  phase,
  genreId,
  continuousPreset,
  chapterCount,
  includeHumanize,
  includeReview,
  fromPhase,
  progress,
  model
} = {}) {
  const normalizedProgress = normalizeProgress(progress || {});
  const chapterStatus = deriveChapterStatus(normalizedProgress);
  const currentPhase = resolvePhase(phase, normalizedProgress);
  const guide = PHASE_GUIDE[currentPhase];
  if (!guide) {
    const error = new Error("phase is invalid.");
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  const recipe = GENRE_RECIPES.find((item) => item.id === String(genreId || "").trim()) || null;
  const ladder = ladderForPhase(currentPhase);
  const currentStep = ladder.find((step) => step.status === "current") || ladder[1];
  const continuous = continuousPreset
    ? buildContinuousRunPlan({
      preset: continuousPreset,
      chapterCount,
      includeHumanize,
      includeReview,
      fromPhase: fromPhase || currentPhase
    })
    : null;
  const options = continuousOptionsForPhase(currentPhase);
  const modelInfo = {
    connected: model?.connected === true || model?.loggedIn === true,
    username: model?.username || model?.user?.username || null,
    plan: model?.plan || model?.user?.plan || null
  };

  const payload = {
    bindingId,
    phase: currentPhase,
    mode: continuous ? "continuous_ready" : "step_by_step",
    naming: {
      ladderMeans: "写作步骤顺序（一步步来）。不是另一套产品面板。",
      continuousMeans: "跑通后可授权连续执行多步；每步仍展示结果；入台账仍要确认并结算。",
      editorRole: "我是你的责编与写作教练：多鼓励、给短清单、默认一步步；你授权后可连续跑，但永不自动入台账。"
    },
    chapterStatus,
    progress: normalizedProgress,
    model: modelInfo,
    current: {
      id: currentPhase,
      usesGateway: guide.usesGateway,
      do: guide.do,
      checklist: guide.checklist,
      next: guide.next
    },
    steps: ladder,
    ladder,
    softActions: softActionsForPhase(currentPhase),
    localWriting: {
      principle: "默认一步步来，我陪你过每一关；你授权后可连续跑。候选稿先看，确认后再入台账并结算。",
      currentGoal: currentStep.goal,
      authorCanSay: currentStep.authorSays,
      coachTone: "鼓励、具体、短清单；先肯定进展，再给一个主推荐下一步。"
    },
    continuous,
    continuousOptions: options.map((plan) => ({
      preset: plan.preset,
      chapterCount: plan.chapterCount,
      stagePath: plan.steps.filter((step) => step.stage !== "confirm_gate").map((step) => step.stage),
      authorCanSay: plan.authorCanSay
    })),
    settlement: buildSettlementGuide(),
    genreRecipe: recipe
      ? { id: recipe.id, label: recipe.label, summary: recipe.summary, focus: recipe.focus }
      : null,
    genreRecipes: GENRE_RECIPES.map((item) => ({ id: item.id, label: item.label, summary: item.summary }))
  };

  payload.authorBrief = buildAuthorBrief({
    phase: currentPhase,
    chapterStatus,
    progress: normalizedProgress,
    current: payload.current,
    continuousOptions: payload.continuousOptions,
    model: modelInfo
  });

  return payload;
}

module.exports = {
  LOCAL_LADDER,
  PHASE_GUIDE,
  GENRE_RECIPES,
  CONTINUOUS_PRESETS,
  CHAPTER_STATUSES,
  SETTLEMENT_CHECKLIST,
  buildWorkflowGuide,
  buildContinuousRunPlan,
  deriveChapterStatus,
  ladderForPhase
};
