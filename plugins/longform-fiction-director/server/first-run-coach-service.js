"use strict";

const fs = require("node:fs");
const path = require("node:path");
const onboarding = require("./onboarding-state");
const { assessPipeline } = require("./pipeline-coach-service");
const { getGuidedStatus } = require("./guided-stage-service");
const { getGoldenThreeStatus } = require("./golden-three-service");
const { readContinuousMode } = require("./continuous-mode");
const { getProductGuide } = require("./product-guide");
const { listMethodCatalog } = require("./method-catalog");

/**
 * First-run / anytime coach: one snapshot telling author what to do next.
 * Always auxiliary: asks questions, never auto-settles or auto-continuous.
 */
async function getFirstRunCoach(projectDir = "", { loggedIn = null } = {}) {
  const state = await onboarding.readState();
  const guide = getProductGuide();
  const methods = listMethodCatalog();
  let pipeline = null;
  let guided = null;
  let golden = null;
  let continuous = null;
  if (projectDir) {
    try { pipeline = await assessPipeline(projectDir); } catch {}
    try { guided = await getGuidedStatus(projectDir); } catch {}
    try { golden = await getGoldenThreeStatus(projectDir); } catch {}
    try { continuous = await readContinuousMode(projectDir); } catch {}
  }

  const login = {
    pendingFirstLogin: !!state.pendingFirstLogin,
    firstLoginCompletedAt: state.firstLoginCompletedAt || null,
    lastLoginOkAt: state.lastLoginOkAt || null,
    lastSessionDropAt: state.lastSessionDropAt || null,
    shopUrl: state.shopUrl || guide.shopUrl || "https://catfk.com/shop/ZVZNANU8",
    loggedInHint: loggedIn,
    rules: [
      "首次安装必须弹登录窗（含积分小店）",
      "登录成功后不乱弹",
      "只有掉线/失效才再提醒",
      "不登录也能本地引导写；多模型效果需登录充值"
    ]
  };

  const steps = [
    {
      id: "install_login",
      title: "安装并登录网关",
      done: !!state.firstLoginCompletedAt || loggedIn === true,
      tools: ["fiction_open_gateway_login", "fiction_account_status", "fiction_list_models"],
      ask: ["账号密码准备好了吗？", "要不要先去小店看看积分？"],
      note: "登录窗含小店。不充值也能写，但强模型优化会差很多。"
    },
    {
      id: "brainstorm",
      title: "脑洞",
      done: !!(pipeline && pipeline.checks.find((c) => c.id === "brainstorm")?.ok),
      tools: ["fiction_get_brainstorm_coach", "fiction_update_brainstorm"],
      ask: ["一句话钩子是什么？", "主角此刻最想要什么？", "最大阻力是什么？"]
    },
    {
      id: "sample",
      title: "样书学习",
      done: !!(pipeline && pipeline.checks.find((c) => c.id === "sample_learn")?.ok),
      tools: ["fiction_import_sample_book", "fiction_learn_sample_techniques", "fiction_deep_learn_sample"],
      ask: ["样书文件夹拖进来了吗？", "更想学节奏、对话还是信息投放？"],
      note: "只学可迁移手法，不抄原句/角色/连续事件。"
    },
    {
      id: "voice",
      title: "文风锚点",
      done: !!(pipeline && pipeline.checks.find((c) => c.id === "voice")?.ok),
      tools: ["fiction_upsert_voice_anchor", "fiction_compare_style"],
      ask: ["叙述要冷硬还是热血？", "最讨厌哪种 AI 腔？"]
    },
    {
      id: "outline",
      title: "大纲",
      done: !!(pipeline && pipeline.checks.find((c) => c.id === "outline")?.ok),
      tools: ["fiction_create_outline"],
      ask: ["核心矛盾一句话？", "前三章如何绑定-加深-验证？"]
    },
    {
      id: "research",
      title: "联网核验 + 事实库",
      done: !!(pipeline && pipeline.checks.find((c) => c.id === "research_filled")?.ok && pipeline.checks.find((c) => c.id === "fact_library")?.ok),
      tools: ["fiction_plan_research", "fiction_append_research_findings", "fiction_upsert_facts"],
      ask: ["有真实历史/职业/地理吗？", "谁写错会穿帮？"],
      note: "必须真联网回填来源，不能空文档开写。"
    },
    {
      id: "characters",
      title: "人物卡",
      done: !!(pipeline && pipeline.checks.find((c) => c.id === "characters")?.ok),
      tools: ["fiction_create_character_card", "fiction_list_character_cards"],
      ask: ["本段出场谁？", "每人不会做的事写了吗？"]
    },
    {
      id: "brief",
      title: "细纲控制卡",
      done: !!(pipeline && pipeline.checks.find((c) => c.id === "chapter_brief")?.ok),
      tools: ["fiction_create_chapter_brief", "fiction_chapter_coach"],
      ask: ["本章唯一主冲突？", "代价与章尾钩从哪条因果长出？"]
    },
    {
      id: "draft",
      title: "正文初稿候选 txt",
      done: false,
      tools: ["fiction_build_draft_packet", "fiction_recommend_models", "fiction_generate_to_file", "fiction_write_local_candidate"],
      ask: ["目标字数？", "登录用网关模型，还是先本地候选？"],
      note: "流式优先，失败重试+模型回退，完整落 Codex候选 txt + .body.txt。"
    },
    {
      id: "optimize",
      title: "多模型优化 / 去AI味",
      done: false,
      tools: ["fiction_compare_style", "fiction_optimize_with_models", "fiction_list_deslop_methods"],
      ask: ["先去AI味、找硬伤，还是润色？", "焦点用 dialogue/narration/pacing/...？"]
    },
    {
      id: "confirm",
      title: "作者确认入台账",
      done: false,
      tools: ["fiction_upsert_soft_chapter_ledger", "fiction_confirm_chapter_ledgers"],
      ask: ["这版可以进正式正文吗？"],
      note: "只有作者明确确认才 settle。"
    }
  ];

  const next = steps.find((s) => !s.done) || steps[steps.length - 1];
  const continuousNote = continuous?.enabled
    ? "连续模式已开启（作者曾明确授权）。"
    : golden?.readyAll
      ? "黄金三章已齐。若作者明确说“可以连续/授权连续”，才可开启隐藏连续能力；默认仍引导。"
      : "黄金三章未齐：继续逐章打磨。不要推销一键长篇。";

  return {
    ok: true,
    role: "auxiliary-editor-coach",
    product: guide.productName || "写小说真的太简单了",
    login,
    nextStep: next,
    steps,
    guidedStage: guided?.stage || null,
    pipelineNext: pipeline?.nextAction || null,
    goldenThreeReady: golden?.readyAll === true,
    continuousEnabled: continuous?.enabled === true,
    continuousNote,
    methods: methods.items,
    modelAdvice: "先 fiction_recommend_models（mode=quick|deep）；脑洞便宜快模型，正文稳模型+回退链，去AI味 style，审稿 review，定稿才 deep。",
    coach: [
      "我是责编引导，不是一键工厂。",
      "下一步：" + next.title,
      "先问：" + (next.ask && next.ask[0] ? next.ask[0] : "作者现在卡在哪？"),
      "工具：" + (next.tools || []).join(", "),
      continuousNote
    ].join("\n")
  };
}

module.exports = { getFirstRunCoach };
