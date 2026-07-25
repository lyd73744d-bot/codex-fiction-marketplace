"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const STAGES = [
  {
    id: "boot",
    label: "开场摸底",
    ask: ["新开还是续写？", "现在最卡的是脑洞、样书、大纲还是某一章？", "有没有必须先守住的作者红线？"],
    tools: ["fiction_bootstrap_project", "fiction_get_guided_status", "fiction_assess_pipeline"],
    advice: "先摸清目标，不急着生成。一次只推进一个主问题。"
  },
  {
    id: "gateway",
    label: "网关连接",
    ask: ["需要检查/登录模型网关吗？", "要不要先看小店积分说明？"],
    tools: ["fiction_open_gateway_login", "fiction_ensure_gateway", "fiction_account_status", "fiction_list_models", "fiction_recommend_models"],
    advice: "首次安装必须登录；已登录就安静继续；掉线才再提醒。"
  },
  {
    id: "brainstorm",
    label: "脑洞",
    ask: ["一句话钩子是什么？", "主角此刻最想保住/得到什么？", "最大阻力是人、规则还是时间？"],
    tools: ["fiction_get_brainstorm_coach", "fiction_update_brainstorm"],
    advice: "脑洞板只记火花与待确认问题。给 2-3 个方向，别直接开长文。"
  },
  {
    id: "sample_book",
    label: "样书学习",
    ask: ["样书文件夹拖进来了吗？", "这次更想学节奏、对话、信息投放还是章尾？"],
    tools: ["fiction_import_sample_book", "fiction_learn_sample_techniques", "fiction_deep_learn_sample"],
    advice: "只学可迁移手法。禁止抄原句/角色/设定/完整桥段。"
  },
  {
    id: "voice",
    label: "文风锚点",
    ask: ["叙述要冷硬、热血还是克制？", "句长更偏短促还是绵长？", "最讨厌哪种AI腔？"],
    tools: ["fiction_upsert_voice_anchor", "fiction_compare_style"],
    advice: "文风要写成能检查的习惯，不写空形容词。"
  },
  {
    id: "outline",
    label: "大纲",
    ask: ["核心矛盾一句话？", "前十章如何连续兑现？", "前三十章压力怎么升级？"],
    tools: ["fiction_create_outline"],
    advice: "大纲按压力升级写，不要目录填空。可借鉴样书节奏，但要自己发挥。"
  },
  {
    id: "research",
    label: "联网核验",
    ask: ["有真实历史/职业/制度/地理吗？", "谁一旦写错会穿帮？", "哪些点允许虚构？"],
    tools: ["fiction_plan_research", "fiction_create_research_doc", "fiction_append_research_findings", "fiction_upsert_facts", "fiction_create_character_card"],
    advice: "真实内容必须联网回填来源。空核验文档不算完成。"
  },
  {
    id: "characters",
    label: "人物卡",
    ask: ["本段出场谁？", "谁最容易OOC？", "每人不会做的事写了吗？"],
    tools: ["fiction_create_character_card", "fiction_list_character_cards"],
    advice: "重要人物一人一卡：欲望、边界、说话方式。真实人物先核验。"
  },
  {
    id: "chapter_brief",
    label: "细纲控制卡",
    ask: ["本章唯一主冲突是什么？", "人物会付出什么代价？", "章尾钩子从哪条因果长出来？"],
    tools: ["fiction_create_chapter_brief"],
    advice: "控制卡只写冲突、选择、代价、钩子。作者点头后再写正文候选。"
  },
  {
    id: "draft",
    label: "正文初稿",
    ask: ["目标字数？", "用哪个模型写初稿？", "确认先落候选txt？"],
    tools: ["fiction_build_draft_packet", "fiction_recommend_models", "fiction_generate_to_file", "fiction_write_local_candidate", "fiction_read_artifact"],
    advice: "先 build_draft_packet 组提示词；登录后 generate_to_file（流式+回退链）；未登录 write_local_candidate。确认前不入正式正文。"
  },
  {
    id: "optimize",
    label: "多模型优化",
    ask: ["先去AI味、找硬伤，还是润色？", "单模型还是按顺序串多模型？"],
    tools: ["fiction_optimize_with_models", "fiction_compare_style", "fiction_read_artifact"],
    advice: "每次完整结果都另存候选。可按 deslop/humanizer 方法改，不自动定稿。"
  },
  {
    id: "confirm",
    label: "确认入台账",
    ask: ["这版可以进正式正文吗？", "要同步哪些人物/时间线/伏笔变化？"],
    tools: ["fiction_confirm_chapter_ledgers", "fiction_ensure_book_workspace"],
    advice: "只有作者明确确认后，才把事实写入台账与正式正文。"
  }
];

function statePath(projectDir) {
  return path.join(projectDir, ".fiction-director", "guided-stage.json");
}
function emptyState() {
  return { version: 2, stageId: "boot", history: [], answers: {}, updatedAt: null, coachMode: true };
}
async function readStageState(projectDir) {
  try { return { ...emptyState(), ...JSON.parse(await fsp.readFile(statePath(projectDir), "utf8")) }; }
  catch { return emptyState(); }
}
async function writeStageState(projectDir, state) {
  const next = { ...emptyState(), ...state, updatedAt: new Date().toISOString() };
  await fsp.mkdir(path.dirname(statePath(projectDir)), { recursive: true });
  await fsp.writeFile(statePath(projectDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}
function stageById(id) {
  return STAGES.find((s) => s.id === id) || STAGES[0];
}
function nextStageId(id) {
  const idx = STAGES.findIndex((s) => s.id === id);
  return idx < 0 || idx >= STAGES.length - 1 ? id : STAGES[idx + 1].id;
}
async function getGuidedStatus(projectDir) {
  const state = projectDir ? await readStageState(projectDir) : emptyState();
  const stage = stageById(state.stageId);
  const idx = STAGES.findIndex((s) => s.id === stage.id);
  return {
    ok: true,
    coachMode: true,
    stage: {
      id: stage.id,
      label: stage.label,
      ask: stage.ask,
      tools: stage.tools,
      advice: stage.advice
    },
    index: idx + 1,
    total: STAGES.length,
    progress: STAGES.map((s, i) => ({ id: s.id, label: s.label, done: i < idx, current: i === idx })),
    askNow: stage.ask,
    advice: stage.advice,
    recommendedTools: stage.tools,
    answers: state.answers || {},
    note: "默认引导编辑，不主动一键长篇。黄金三章后若作者明确授权才可连续。"
  };
}
async function advanceGuidedStage(projectDir, { toStage = "", note = "", answers = null } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const state = await readStageState(projectDir);
  const current = stageById(state.stageId);
  const targetId = toStage ? String(toStage) : nextStageId(current.id);
  if (!STAGES.some((s) => s.id === targetId)) throw new Error("unknown stage");
  const history = (state.history || []).concat([{
    from: current.id,
    to: targetId,
    note: String(note || "").slice(0, 500),
    at: new Date().toISOString()
  }]).slice(-50);
  const nextAnswers = { ...(state.answers || {}) };
  if (answers && typeof answers === "object") nextAnswers[current.id] = answers;
  await writeStageState(projectDir, { ...state, stageId: targetId, history, answers: nextAnswers });
  const status = await getGuidedStatus(projectDir);
  return { ...status, advancedFrom: current.id };
}
async function saveGuidedAnswers(projectDir, stageId, answers) {
  const state = await readStageState(projectDir);
  const id = stageId || state.stageId;
  await writeStageState(projectDir, { ...state, answers: { ...(state.answers || {}), [id]: answers } });
  return getGuidedStatus(projectDir);
}

async function ensureSoftLedgers(projectDir) {
  if (!projectDir) throw new Error("projectDir required");
  const aux = path.join(projectDir, "辅助文档");
  await fsp.mkdir(aux, { recursive: true });
  const files = {
    "08_文风锚点.md": [
      "# 文风锚点",
      "",
      "> 只写能检查的习惯。空形容词没用。",
      "",
      "## 叙述口气",
      "- 更像谁在讲？冷硬 / 克制 / 热血 / 俏皮？",
      "- 一句里通常几拍？",
      "",
      "## 对话习惯",
      "- 打断多还是把话说满？",
      "- 谁话多，谁话少？",
      "",
      "## 节奏",
      "- 高压时短句还是长句？",
      "- 信息早给还是晚给？",
      "",
      "## 从样书借来的（可迁移）",
      "- ",
      "",
      "## 禁止的腔",
      "- 解释腔 / 总结腔 / 万能网文套话",
      ""
    ].join("\n"),
    "09_脑洞板.md": [
      "# 脑洞板",
      "",
      "> 这里是火花，不是大纲。先问清楚再展开。",
      "",
      "## 一句话钩子",
      "",
      "## 主角此刻最想要什么",
      "",
      "## 最大阻力",
      "",
      "## 为什么读者不划走",
      "",
      "## 先不写的支线",
      "",
      "## 待确认问题",
      "- ",
      ""
    ].join("\n"),
    "11_时间线与伏笔.md": [
      "# 时间线与伏笔（软台账）",
      "",
      "> 别做成死表格。只记会影响后续写作的事实。",
      "",
      "## 已确认时间节点",
      "- ",
      "",
      "## 已埋下、尚未回收的线",
      "- 线索：",
      "  - 埋在哪：",
      "  - 预计兑现压力：",
      "",
      "## 绝对不能打脸的设定",
      "- ",
      "",
      "## 作者临时决定",
      "- ",
      ""
    ].join("\n"),
    "12_事实库_防OOC.md": [
      "# 事实库（防 OOC）",
      "",
      "> 只记会打脸的硬事实。真实人物/制度必须挂来源。",
      "",
      "## 已确认硬事实",
      "",
      "## 禁止写错",
      "",
      "## 可虚构边界",
      "",
      "## 待核验",
      "",
      "## 来源",
      ""
    ].join("\n"),
    "13_章节软台账.md": [
      "# 章节软台账",
      "",
      "> 确认前可先记。只写会影响后文的变化。",
      ""
    ].join("\n"),
    "联网核验/README.md": [
      "# 联网核验",
      "",
      "真实人物 / 制度 / 地理 / 专业流程：先检索，再回填，再写。",
      "空文档不算完成。用 fiction_create_research_doc + 浏览器 + fiction_append_research_findings。",
      ""
    ].join("\n"),
    "人物卡/_模板.md": [
      "# 人物卡：名字",
      "",
      "> 只写会影响下一场戏的东西。空形容词删掉。",
      "",
      "## 此刻最想要",
      "- ",
      "",
      "## 绝不会做的事",
      "- ",
      "",
      "## 开口习惯",
      "- 一句代表台词：",
      "- 生气时怎么说话：",
      "- 撒谎时露什么：",
      "",
      "## 与主角的现价关系",
      "- 欠谁 / 怕谁 / 利用谁：",
      "",
      "## 已确认事实（真实人物必须挂核验）",
      "- 来源：",
      "- 不能写错：",
      "",
      "## 本章可用动作",
      "- ",
      ""
    ].join("\n"),
    "人物卡/README.md": [
      "# 人物卡",
      "",
      "重要人物一人一卡。优先写：欲望、不会做的事、说话边界。",
      "真实人物必须挂联网核验。",
      ""
    ].join("\n")
  };
  const created = [];
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(aux, rel);
    await fsp.mkdir(path.dirname(full), { recursive: true });
    if (!fs.existsSync(full)) {
      await fsp.writeFile(full, body, "utf8");
      created.push(path.relative(projectDir, full));
    }
  }
  await fsp.mkdir(path.join(projectDir, "样书"), { recursive: true });
  await fsp.mkdir(path.join(projectDir, "细纲"), { recursive: true });
  await fsp.mkdir(path.join(projectDir, "Codex候选"), { recursive: true });
  await fsp.mkdir(path.join(projectDir, "正文"), { recursive: true });
  return { ok: true, created, coach: "软台账已就绪：文风/脑洞/时间线伏笔/核验/人物卡。按需填，不填空套话。" };
}

module.exports = {
  STAGES,
  getGuidedStatus,
  advanceGuidedStage,
  saveGuidedAnswers,
  ensureSoftLedgers,
  readStageState,
  writeStageState
};
