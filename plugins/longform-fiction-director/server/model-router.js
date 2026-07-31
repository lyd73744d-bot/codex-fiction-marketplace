"use strict";

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
    prefer: ["gemini-3.5-flash", "glm-5.2", "qwen3.7-max", "grok-4.5"],
    avoidHeavy: true,
    why: "要快、要多方向，不值得上最贵模型"
  },
  structure: {
    label: "结构/大纲/细纲",
    prefer: ["kimi-k2.6", "claude-sonnet-5", "gemini-3.1-pro-preview", "glm-5.2", "grok-4.5"],
    why: "要因果与节奏，中档推理足够"
  },
  draft: {
    label: "正文主写",
    prefer: ["claude-sonnet-5", "kimi-k2.6", "seed-2.1-pro", "glm-5.2", "claude-opus-5", "grok-4.5"],
    why: "主写要稳、文风可控；默认中档，作者点名再用旗舰"
  },
  continuity: {
    label: "连续性/台账",
    prefer: ["claude-sonnet-5", "kimi-k2.6", "glm-5.2", "gemini-3.1-pro-preview"],
    why: "核对人物/时间线/伏笔，重准确不重花活"
  },
  style: {
    label: "去AI味/润色",
    prefer: ["claude-sonnet-5", "kimi-k2.6", "seed-2.1-pro", "claude-opus-4-8"],
    why: "改味不改剧情，中档写手模型更合适"
  },
  adversary: {
    label: "反方/找硬伤",
    prefer: ["claude-opus-5", "claude-opus-4-8", "grok-4.5", "gemini-3.1-pro-preview", "qwen3.7-max"],
    why: "专门挑弃读点与逻辑崩，可短上下文上旗舰"
  },
  review: {
    label: "质检审核",
    prefer: ["claude-sonnet-5", "kimi-k2.6", "gemini-3.1-pro-preview", "glm-5.2"],
    why: "结构化审稿；证据不足再换旗舰复审"
  },
  finalize: {
    label: "定稿成稿",
    prefer: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6", "grok-4.5", "claude-sonnet-5"],
    why: "作者确认前最后一轮，才考虑高积分模型"
  }
};

// Fused from zizhuji workflow-model-policy: soft presets only
const WRITING_MODE_PRESETS = {
  chapterWrite: {
    quick: ["glm-5.2", "claude-sonnet-5", "kimi-k2.6", "gemini-3.5-flash"],
    deep: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6", "grok-4.5", "claude-sonnet-5", "kimi-k2.6"]
  },
  chapterOptimize: {
    quick: ["glm-5.2", "claude-sonnet-5", "gemini-3.5-flash"],
    deep: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6", "grok-4.5", "kimi-k2.6", "claude-sonnet-5"]
  }
};

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

function scoreModel(modelId, role, creditsMap = {}, mode = "quick") {
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
    if (/opus|pro|kimi|sonnet/.test(lower)) score += 18;
  } else {
    if (/flash|glm|mini|haiku|turbo/.test(lower)) score += 12;
    if (/opus/.test(lower)) score -= 15;
  }
  const credits = Number(creditsMap[id]);
  if (Number.isFinite(credits)) {
    // cheaper models slightly preferred when scores close
    score += Math.max(0, 12 - Math.min(credits, 12));
  }
  return score;
}

function pickForRole(role, availableModels, creditsMap = {}, limit = 2, mode = "quick") {
  const list = (availableModels || []).map((m) => {
    if (typeof m === "string") return { id: m, label: m, credits: creditsMap[m] || null };
    return {
      id: m.id || m.model || m.name,
      label: m.label || m.name || m.id,
      credits: Number(m.credits ?? creditsMap[m.id] ?? 0) || null
    };
  }).filter((m) => m.id);

  return list
    .map((m) => ({
      id: m.id,
      label: m.label || m.id,
      credits: m.credits,
      score: scoreModel(m.id, role, creditsMap, mode)
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

function buildCoachAdvice(taskId, plans, mode, unpaidNote) {
  const lines = [
    "Codex 在总责编位调度，本次外部模型负责对应的写作 A 位；先选够用的模型，不为了面子堆旗舰。",
    "当前任务：" + taskId + "；模式：" + (mode === "deep" ? "深度/高配" : "快速/轻量") + "。",
    unpaidNote || "已生成本次模型推荐；必须等待作者当次确认后才能调用。"
  ];
  for (const plan of plans) {
    const ids = plan.models.map((m) => m.id).join(" / ") || "暂无可用模型";
    lines.push("- " + plan.label + "：优先 " + ids + "。" + plan.why);
  }
  lines.push("生成策略：正式请求不先测活；无正文的明确临时故障最多重试一次，超时或部分流不重发；作者确认多个模型时才按顺序换模型。收到的正文全部落盘（.body 纯正文可再喂模型）。");
  lines.push("结果先在「Codex候选/」给作者看，确认前不入正式正文/台账。");
  if (mode === "quick") lines.push("快速模式：探索用 flash/glm/qwen；正文用 sonnet/kimi/seed；终检再开 deep。");
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
  unpaid = false
} = {}) {
  const taskId = normalizeTask(task);
  const modeId = normalizeMode(mode);
  const roles = TASK_ROLES[taskId] || ["draft"];
  const preferred = Array.isArray(authorPrefer) ? authorPrefer.map(String) : [];
  const preset = writingPresetFor(taskId, modeId) || [];

  const plans = roles.map((role) => {
    let picks = pickForRole(role, availableModels, creditsMap, maxPerRole, modeId);
    // boost preset order if available
    if (preset.length) {
      const avail = new Set((availableModels || []).map((m) => (typeof m === "string" ? m : m.id)));
      const presetHits = preset.filter((id) => avail.has(id)).map((id) => ({
        id,
        label: id,
        credits: creditsMap[id] || null,
        score: 900,
        fromPreset: true
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
        forced: true
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
  // fallback chain for generate_to_file: only models that actually exist for this account
  const modelIds = [...new Set([
    ...plans.flatMap((p) => p.models.map((m) => m.id)),
    ...preset.filter((id) => availableIds.has(id))
  ].filter(Boolean))].slice(0, 4);

  return {
    leadEditorRouter: true,
    externalWritingModels: true,
    task: taskId,
    mode: modeId,
    writingPreset: preset,
    primaryModelId: primary,
    modelIds,
    fallbackChain: modelIds,
    plans,
    coachAdvice: buildCoachAdvice(
      taskId,
      plans,
      modeId,
      unpaid ? "当前未登录：作者当次确认使用后再完成登录；未确认则继续把这一章想清楚，或由作者明确选择临时候选。" : ""
    ),
    transport: {
      mode: "stream_first_to_txt",
      streamRetries: 2,
      outerAttempts: 1,
      nonStreamFallback: "empty_stream_only",
      multiModelFallback: true,
      note: "正式生成不先测活；无正文的明确临时故障最多重试一次，超时或部分流不重复提交。已收到文本写入 Codex候选 txt（含 .body 纯正文），再读取。"
    },
    usageTips: [
      "脑洞/探索：快模型",
      "大纲/细纲：中档结构模型",
      "正文：中档稳写 + 回退链",
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
  normalizeTask,
  normalizeMode,
  recommendModels,
  listTaskCatalog,
  pickForRole
};
