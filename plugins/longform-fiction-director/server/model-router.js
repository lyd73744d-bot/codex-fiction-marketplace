"use strict";

const { isDisabledModel } = require("./disabled-models");

/**
 * Lead-editor model router (责编建议，不是强制调度器).
 * Absorbs zizhuji quick/deep writing modes as soft advice only.
 */

const TASK_ROLES = {
  brainstorm: ["explore", "structure"],
  market_scan: ["explore"],
  outline: ["structure", "explore"],
  chapter_brief: ["structure"],
  draft: ["draft"],
  continuous_draft: ["draft", "continuity"],
  humanize: ["style"],
  deslop: ["style"],
  review: ["review", "adversary", "continuity"],
  quality_gate: ["review", "continuity"],
  revise: ["draft", "style"],
  finalize: ["finalize", "review"],
  settle: ["continuity"],
  deconstruct: ["structure", "explore"],
  specialist: ["draft"]
};

const ROLE_HINTS = {
  explore: {
    label: "探索/脑洞",
    prefer: ["seed-2.1-turbo", "minimax-m3", "qwen3.7-max", "gemini-3.5-flash", "glm-5.2"],
    avoidHeavy: true,
    why: "要快、要多方向，不值得上最贵模型"
  },
  structure: {
    label: "结构/大纲/细纲",
    prefer: ["glm-5.2", "claude-sonnet-5", "seed-2.1-pro", "gemini-3.1-pro-preview"],
    why: "要因果与节奏，中档推理足够"
  },
  draft: {
    label: "正文主写",
    prefer: ["claude-sonnet-5", "seed-2.1-pro", "claude-opus-4-6", "glm-5.2", "minimax-m3"],
    why: "主写要稳、文风可控；默认中档，作者点名再用旗舰"
  },
  continuity: {
    label: "连续性/台账",
    prefer: ["glm-5.2", "claude-sonnet-5", "gemini-3.1-pro-preview"],
    why: "核对人物/时间线/伏笔，重准确不重花活"
  },
  style: {
    label: "去AI味/润色",
    prefer: ["claude-sonnet-5", "seed-2.1-pro", "glm-5.2", "claude-opus-4-6"],
    why: "改味不改剧情，中档写手模型更合适"
  },
  adversary: {
    label: "反方/找硬伤",
    prefer: ["claude-opus-4-6", "glm-5.2", "gemini-3.1-pro-preview", "qwen3.7-max"],
    why: "专门挑弃读点与逻辑崩，可短上下文上旗舰"
  },
  review: {
    label: "质检审核",
    prefer: ["claude-sonnet-5", "glm-5.2", "gemini-3.1-pro-preview"],
    why: "结构化审稿；证据不足再换旗舰复审"
  },
  finalize: {
    label: "定稿成稿",
    prefer: ["claude-opus-4-6", "claude-sonnet-5", "glm-5.2", "gemini-3.1-pro-preview"],
    why: "作者确认前最后一轮，才考虑高积分模型"
  }
};

// Fused from zizhuji workflow-model-policy: soft presets only
const WRITING_MODE_PRESETS = {
  chapterWrite: {
    quick: ["claude-sonnet-5", "seed-2.1-turbo", "glm-5.2", "minimax-m3"],
    deep: ["claude-opus-4-6", "claude-sonnet-5", "seed-2.1-pro", "glm-5.2"]
  },
  chapterOptimize: {
    quick: ["claude-sonnet-5", "seed-2.1-turbo", "glm-5.2"],
    deep: ["claude-opus-4-6", "claude-sonnet-5", "seed-2.1-pro", "glm-5.2"]
  }
};

const MANUAL_ONLY_MODELS = new Set(["grok-4.5"]);
const NON_WRITING_MODELS = new Set(["gpt-image-2"]);

const MODEL_CAPABILITY_PROFILES = Object.freeze({
  "claude-opus-4-6": { longForm: "verified", note: "长文质量稳定，适合深度正文与定稿" },
  "gemini-3.1-pro-preview": { longForm: "manual-review", note: "实测会补造历史事实并扩张既有能力；历史长文只作作者点名后的候选，并人工复核" },
  "glm-5.2": { longForm: "manual-review", note: "二级线路长文实测出现人物名漂移与篇幅失控；历史正文只在作者点名后作为候选，并人工复核" },
  "gemini-3.5-flash": { longForm: "short-form", note: "返回较快，适合探索和短任务；不自动推荐为历史长篇细纲或正文主写" },
  "claude-sonnet-5": { longForm: "variable", note: "文风可用，但实测篇幅有时提前收束" },
  "minimax-m3": { longForm: "unverified", note: "二级线路长文实测超时；不自动推荐为长篇正文" },
  "qwen3.7-max": { longForm: "variable", note: "适合中短正文或结构任务" },
  "seed-2.1-pro": { longForm: "unverified", note: "当前线路尚未完成长文实测" },
  "seed-2.1-turbo": { longForm: "unverified", note: "当前线路仅完成短请求验证" },
  "grok-4.5": { longForm: "manual-only", note: "慢速备用，只在作者点名时使用" },
  "gpt-image-2": { longForm: "not-applicable", note: "封面图片模型，不参与文字推荐" }
});

const LONG_FORM_PRESETS = Object.freeze({
  deep: ["claude-opus-4-6"],
  quick: ["claude-opus-4-6"]
});

function normalizeTask(task) {
  const raw = String(task || "draft").trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases = {
    "脑洞": "brainstorm",
    "大纲": "outline",
    "细纲": "chapter_brief",
    "控制卡": "chapter_brief",
    "chapter_control_card": "chapter_brief",
    "正文": "draft",
    "候选": "draft",
    "去ai味": "humanize",
    "润色": "humanize",
    "优化": "humanize",
    "质检": "review",
    "审稿": "review",
    "定稿": "finalize",
    "入台账": "settle",
    "拆书": "deconstruct",
    "连续": "continuous_draft"
  };
  return aliases[raw] || raw;
}

function normalizeMode(mode) {
  const m = String(mode || "quick").trim().toLowerCase();
  if (m === "deep" || m === "深度" || m === "旗舰" || m === "高配") return "deep";
  return "quick";
}

function modelCapability(modelId) {
  return MODEL_CAPABILITY_PROFILES[String(modelId || "").toLowerCase()] || {
    longForm: "unverified",
    note: "尚无本地长文实测记录"
  };
}

function scoreModel(modelId, role, creditsMap = {}, mode = "quick", targetChars = 0) {
  const id = String(modelId || "");
  const prefer = ROLE_HINTS[role]?.prefer || [];
  let score = 0;
  const lower = id.toLowerCase();
  prefer.forEach((p, index) => {
    if (lower.includes(String(p).toLowerCase()) || String(p).toLowerCase().includes(lower)) {
      score += 100 - index * 8;
    }
  });
  if (ROLE_HINTS[role]?.avoidHeavy) {
    if (/opus|sol|o1|o3|ultra|pro-preview|4\.6|4-6|4-8/.test(lower)) score -= 40;
    if (/flash|mini|haiku|air|turbo/.test(lower)) score += 20;
  }
  if (mode === "deep") {
    if (/opus|pro|sonnet/.test(lower)) score += 18;
  } else {
    if (/flash|mini|haiku|turbo/.test(lower)) score += 12;
    if (/opus/.test(lower)) score -= 15;
  }
  const credits = Number(creditsMap[id]);
  if (Number.isFinite(credits)) {
    // cheaper models slightly preferred when scores close
    score += Math.max(0, 12 - Math.min(credits, 12));
  }
  if (Number(targetChars) >= 4000) {
    const capability = modelCapability(id).longForm;
    if (capability === "verified") score += 140;
    if (capability === "short-form") score -= 80;
    if (capability === "variable") score -= 25;
    if (capability === "manual-review") score -= 85;
    if (capability === "unverified") score -= 55;
  }
  return score;
}

function pickForRole(role, availableModels, creditsMap = {}, limit = 2, mode = "quick", targetChars = 0) {
  const list = (availableModels || []).map((m) => {
    if (typeof m === "string") return { id: m, label: m, credits: creditsMap[m] || null };
    return {
      id: m.id || m.model || m.name,
      label: m.label || m.name || m.id,
      credits: Number(m.credits ?? creditsMap[m.id] ?? 0) || null
    };
  }).filter((m) => m.id
    && !MANUAL_ONLY_MODELS.has(String(m.id).toLowerCase())
    && !NON_WRITING_MODELS.has(String(m.id).toLowerCase())
    && !isDisabledModel(m.id)
    && (Number(targetChars) < 4000 || modelCapability(m.id).longForm === "verified"));

  return list
    .map((m) => ({
      id: m.id,
      label: m.label || m.id,
      credits: m.credits,
      score: scoreModel(m.id, role, creditsMap, mode, targetChars),
      capability: modelCapability(m.id)
    }))
    .sort((a, b) => b.score - a.score || String(a.id).localeCompare(String(b.id)))
    .slice(0, Math.max(1, limit));
}

function writingPresetFor(taskId, mode) {
  if (taskId === "humanize" || taskId === "deslop" || taskId === "revise") {
    return WRITING_MODE_PRESETS.chapterOptimize[mode] || WRITING_MODE_PRESETS.chapterOptimize.quick;
  }
  if (taskId === "draft" || taskId === "continuous_draft" || taskId === "finalize") {
    return WRITING_MODE_PRESETS.chapterWrite[mode] || WRITING_MODE_PRESETS.chapterWrite.quick;
  }
  return null;
}

function buildCoachAdvice(taskId, plans, mode, unpaidNote, targetChars = 0) {
  const lines = [
    "Codex 在总责编位调度，本次外部模型负责对应的写作 A 位；先选够用的模型，不为了面子堆旗舰。",
    "当前任务：" + taskId + "；模式：" + (mode === "deep" ? "深度/高配" : "快速/轻量") + "。",
    unpaidNote || "已生成本次模型推荐；必须等待作者当次确认后才能调用。"
  ];
  for (const plan of plans) {
    const ids = plan.models.map((m) => m.id).join(" / ") || "暂无可用模型";
    lines.push("- " + plan.label + "：优先 " + ids + "。" + plan.why);
  }
  if (Number(targetChars) >= 4000) lines.push("本次按长文目标排序；优先使用已有长文实测依据的模型，但篇幅仍由上游实际返回决定。");
  lines.push("生成策略：一次授权只提交一次；不先测活、不自动重试、不自动改传输方式、不跨线路换模型。收到的正文或中断前片段全部落盘（.body 纯正文可续写）。");
  lines.push("结果先在「Codex候选/」给作者看，确认前不入正式正文/台账。");
  if (mode === "quick") lines.push("快速模式：探索用 flash/qwen；正文用 sonnet/seed；终检再开 deep。");
  else lines.push("深度模式：主写用稳定模型，终检使用旗舰模型。");
  return lines.join("\n");
}

function recommendModels({
  task = "draft",
  availableModels = [],
  creditsMap = {},
  maxPerRole = 2,
  authorPrefer = [],
  mode = "quick",
  unpaid = false,
  targetChars = 0
} = {}) {
  const taskId = normalizeTask(task);
  const modeId = normalizeMode(mode);
  const roles = TASK_ROLES[taskId] || ["draft"];
  const target = Math.max(0, Math.floor(Number(targetChars) || 0));
  const preferred = Array.isArray(authorPrefer)
    ? authorPrefer.map(String).filter((id) => !NON_WRITING_MODELS.has(id.toLowerCase()))
    : [];
  const preset = target >= 4000
    ? LONG_FORM_PRESETS[modeId]
    : (writingPresetFor(taskId, modeId) || []);

  const plans = roles.map((role) => {
    let picks = pickForRole(role, availableModels, creditsMap, maxPerRole, modeId, target);
    // boost preset order if available
    if (preset.length) {
      const avail = new Set((availableModels || []).map((m) => (typeof m === "string" ? m : m.id)));
      const presetHits = preset.filter((id) => avail.has(id)).map((id) => ({
        id,
        label: id,
        credits: creditsMap[id] || null,
        score: 900,
        fromPreset: true,
        capability: modelCapability(id)
      }));
      if (presetHits.length) {
        picks = [...presetHits, ...picks.filter((p) => !preset.includes(p.id))].slice(0, maxPerRole);
      }
    }
    if (preferred.length) {
      const avail = new Set((availableModels || []).map((m) => (typeof m === "string" ? m : m.id)));
      const forced = preferred.filter((id) => avail.has(id)).map((id) => ({
        id,
        label: id,
        credits: creditsMap[id] || null,
        score: 999,
        forced: true,
        capability: modelCapability(id)
      }));
      if (forced.length) {
        picks = [...forced, ...picks.filter((p) => !preferred.includes(p.id))].slice(0, maxPerRole);
      }
    }
    return {
      role,
      label: ROLE_HINTS[role]?.label || role,
      why: ROLE_HINTS[role]?.why || "",
      models: picks.map(({ credits, ...model }) => model)
    };
  });

  const primary = plans[0]?.models?.[0]?.id || null;
  const availableIds = new Set((availableModels || []).map((m) => (typeof m === "string" ? m : m.id)).filter(Boolean));
  const recommendedIds = [...new Set([
    ...plans.flatMap((p) => p.models.map((m) => m.id)),
    ...preset.filter((id) => availableIds.has(id))
  ].filter(Boolean))].slice(0, 4);
  const modelIds = primary ? [primary] : [];
  const alternativeModelIds = recommendedIds.filter((id) => id !== primary);

  return {
    leadEditorRouter: true,
    externalWritingModels: true,
    task: taskId,
    mode: modeId,
    targetChars: target,
    writingPreset: preset,
    primaryModelId: primary,
    modelIds,
    alternativeModelIds,
    fallbackChain: false,
    plans,
    coachAdvice: buildCoachAdvice(
      taskId,
      plans,
      modeId,
      unpaid ? "当前未登录：作者当次确认使用后再完成登录；未确认则继续把这一章想清楚，或由作者明确选择临时候选。" : "",
      target
    ),
    transport: {
      mode: "stream_first_to_txt",
      streamRetries: 1,
      outerAttempts: 1,
      nonStreamFallback: false,
      multiModelFallback: false,
      note: "正式生成不先测活，不自动重试、改传输方式或换线路；已收到文本写入 Codex候选 txt（含 .body 纯正文）。"
    },
    usageTips: [
      "脑洞/探索：快模型",
      "大纲/细纲：中档结构模型",
      "正文：按目标篇幅选择已有实测依据的模型",
      "去AI味：中档写手模型，可多模型顺序打磨",
      "定稿/找硬伤：才上旗舰"
    ]
  };
}

function listTaskCatalog() {
  return Object.keys(TASK_ROLES).map((task) => ({
    task,
    roles: TASK_ROLES[task],
    labels: TASK_ROLES[task].map((r) => ROLE_HINTS[r]?.label || r)
  }));
}

module.exports = {
  TASK_ROLES,
  ROLE_HINTS,
  WRITING_MODE_PRESETS,
  MODEL_CAPABILITY_PROFILES,
  LONG_FORM_PRESETS,
  normalizeTask,
  normalizeMode,
  recommendModels,
  listTaskCatalog,
  pickForRole
};
