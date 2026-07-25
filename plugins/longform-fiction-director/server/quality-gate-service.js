"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildWorkflowGuide } = require("./local-writing-workflow");

const MAX_DOCUMENT_BYTES = 160 * 1024;
const MAX_AUXILIARY_DOCUMENTS = 16;
const MAX_AUXILIARY_BYTES = 1024 * 1024;
const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const REFERENCE_SAMPLE_CHARACTERS = 12_000;
const MAX_PROSE_CHARACTERS = 120_000;
const STAGE_PREPARATION_TTL_MS = 20 * 60 * 1000;
const WRITING_STAGES = new Set(["brainstorm", "outline", "draft", "humanize"]);
const PREPARABLE_STAGES = new Set([...WRITING_STAGES, "review", "revise"]);
const WORKFLOW_PHASES = new Set(["brainstorm", "outline", "draft", "humanize", "review", "revise", "confirm"]);

class QualityGateError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QualityGateError";
    this.code = code;
  }
}

function requiredString(value, name, max = 4_096) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new QualityGateError("INVALID_ARGUMENT", `${name} is required.`);
  return value.trim();
}

function isGptModel(model) {
  return /\bgpt(?:[-_.:]|$)/iu.test(String(model?.id || "")) || /\bgpt(?:\s|$)/iu.test(String(model?.label || ""));
}
function isAllowedGptWritingModel(model) {
  const id = String(model?.id || model || "").toLowerCase();
  return /^gpt-5\.6-(sol|terra|luna)$/.test(id);
}
function isCoverModel(model) {
  const id = String(model?.id || model || "").toLowerCase();
  return id === "gpt-image-2" || /^gpt-image-/.test(id);
}
function isWritingBlockedGpt(model) {
  if (!isGptModel(model) && !isGptModel({ id: String(model || "") })) return false;
  if (isAllowedGptWritingModel(model) || isAllowedGptWritingModel({ id: String(model || "") })) return false;
  return true;
}

function safeFinding(code, message, severity = "blocker") {
  return { code, message: String(message).slice(0, 500), severity };
}

function boundedText(filePath) {
  return fs.readFile(filePath, "utf8").then((text) => {
    if (Buffer.byteLength(text, "utf8") > MAX_DOCUMENT_BYTES) throw new QualityGateError("BOUND_DOCUMENT_TOO_LARGE", "Bound document is too large.");
    return text;
  });
}

function referenceSample(text) {
  if (Buffer.byteLength(text, "utf8") <= MAX_DOCUMENT_BYTES) return text;
  const middleStart = Math.max(0, Math.floor(text.length / 2) - Math.floor(REFERENCE_SAMPLE_CHARACTERS / 2));
  const endingStart = Math.max(0, text.length - REFERENCE_SAMPLE_CHARACTERS);
  return [
    "【授权参考书仅供文风比对，以下为开篇、中段、结尾代表性抽样】",
    "【开篇】\n" + text.slice(0, REFERENCE_SAMPLE_CHARACTERS),
    "【中段】\n" + text.slice(middleStart, middleStart + REFERENCE_SAMPLE_CHARACTERS),
    "【结尾】\n" + text.slice(endingStart)
  ].join("\n\n");
}

function boundedReferenceText(filePath) {
  return fs.readFile(filePath, "utf8").then((text) => {
    if (Buffer.byteLength(text, "utf8") > MAX_REFERENCE_BYTES) throw new QualityGateError("BOUND_REFERENCE_TOO_LARGE", "Authorized reference book is too large.");
    return referenceSample(text);
  });
}

function resolvedBoundPath(projectPath, relativePath, name) {
  const projectRoot = path.resolve(requiredString(projectPath, "projectPath"));
  const relative = requiredString(relativePath, name, 512);
  if (path.isAbsolute(relative)) throw new QualityGateError("INVALID_ARGUMENT", `${name} must be inside projectPath.`);
  const resolved = path.resolve(projectRoot, relative);
  if (resolved !== projectRoot && !resolved.startsWith(`${projectRoot}${path.sep}`)) throw new QualityGateError("INVALID_ARGUMENT", `${name} must be inside projectPath.`);
  return { projectRoot, relativePath: relative.split(path.sep).join("/"), absolutePath: resolved };
}

function resolvedArtifactPath(projectPath, relativePath) {
  const target = resolvedBoundPath(projectPath, relativePath, "artifactPath");
  if (!/\.(?:md|txt)$/iu.test(target.relativePath)) throw new QualityGateError("INVALID_ARGUMENT", "artifactPath must end in .md or .txt.");
  return target;
}

function streamingPath(target) {
  const parsed = path.parse(target.absolutePath);
  return path.join(parsed.dir, `${parsed.name}.streaming${parsed.ext}`);
}

function resolvedAuxiliaryPaths(input) {
  const primary = resolvedBoundPath(input.projectPath, input.auxiliaryPath, "auxiliaryPath");
  const supplied = input.auxiliaryPaths === undefined ? [primary.relativePath] : input.auxiliaryPaths;
  if (!Array.isArray(supplied) || supplied.length === 0 || supplied.length > MAX_AUXILIARY_DOCUMENTS) {
    throw new QualityGateError("INVALID_ARGUMENT", `auxiliaryPaths must contain 1 to ${MAX_AUXILIARY_DOCUMENTS} project-relative documents.`);
  }
  const unique = new Set([primary.relativePath]);
  for (const item of supplied) unique.add(resolvedBoundPath(primary.projectRoot, item, "auxiliaryPaths").relativePath);
  if (unique.size > MAX_AUXILIARY_DOCUMENTS) throw new QualityGateError("INVALID_ARGUMENT", `auxiliaryPaths must contain 1 to ${MAX_AUXILIARY_DOCUMENTS} project-relative documents.`);
  return [...unique].map((relativePath) => resolvedBoundPath(primary.projectRoot, relativePath, "auxiliaryPaths"));
}

async function boundedAuxiliaryText(paths) {
  const documents = await Promise.all(paths.map(async (document) => ({
    relativePath: document.relativePath,
    text: await boundedText(document.absolutePath)
  })));
  const bytes = documents.reduce((total, document) => total + Buffer.byteLength(document.text, "utf8"), 0);
  if (bytes > MAX_AUXILIARY_BYTES) throw new QualityGateError("BOUND_AUXILIARY_TOO_LARGE", "Combined bound auxiliary documents are too large.");
  return documents.map((document) => `## 辅助文档：${document.relativePath}\n${document.text}`).join("\n\n");
}

function hardTerms(auxiliaryText) {
  const values = new Set();
  const matcher = /(?:不得|禁止|不写|硬禁)[^。\n]{0,160}?[“"‘']([^”"’']{1,80})[”"’']/gu;
  for (const match of auxiliaryText.matchAll(matcher)) values.add(match[1].trim());
  return [...values].filter(Boolean).slice(0, 64);
}

function localFindings(prose, auxiliaryText) {
  const findings = [];
  for (const term of hardTerms(auxiliaryText)) {
    if (prose.includes(term)) findings.push(safeFinding("BOUND_HARD_RULE", `命中绑定辅助文档中的硬规则：${term}`));
  }
  const patterns = [
    [/空气仿佛凝固|时间仿佛静止/gu, "AI_TEMPLATE_ATMOSPHERE", "出现模板化氛围句。"],
    [/好戏才刚刚开始|命运的齿轮|风暴即将到来/gu, "AI_TEMPLATE_DECLARATION", "出现预制宣言或空泛章尾。"],
    [/(?:下一秒|下一刻|紧接着|与此同时)/gu, "AI_TRANSITION_DENSITY", "出现机械转场词，需要核对是否承担真实时间关系。"]
  ];
  for (const [pattern, code, message] of patterns) if (pattern.test(prose)) findings.push(safeFinding(code, message, code === "AI_TRANSITION_DENSITY" ? "warning" : "blocker"));
  return findings;
}

function extractJson(text) {
  const input = String(text || "").trim();
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/iu)?.[1]?.trim();
  const candidate = fenced || input.match(/\{[\s\S]*\}/u)?.[0];
  if (!candidate) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

function normalizeVerdict(value) {
  const verdict = String(value || "").trim().toLowerCase();
  if (["pass", "passed", "通过"].includes(verdict)) return "pass";
  if (["blocked", "block", "fail", "failed", "不通过", "退回"].includes(verdict)) return "blocked";
  return null;
}

function publicBinding(binding) {
  return {
    id: binding.id,
    projectPath: binding.projectPath,
    auxiliaryPath: binding.auxiliaryPath,
    auxiliaryPaths: Array.isArray(binding.auxiliaryPaths) ? binding.auxiliaryPaths : [binding.auxiliaryPath],
    referencePath: binding.referencePath,
    styleAnchorPath: binding.styleAnchorPath,
    createdAt: binding.createdAt
  };
}

function createQualityGateService({ gateway, bindingsPath = path.join(os.homedir(), ".fiction-quality-gate", "bindings.json") } = {}) {
  if (!gateway || typeof gateway.accountStatus !== "function" || typeof gateway.listModels !== "function" || typeof gateway.callModels !== "function") throw new TypeError("gateway is required");
  const storePath = path.resolve(bindingsPath);

  async function accountStatus() {
    let status;
    try {
      status = await gateway.accountStatus();
    } catch (error) {
      throw new QualityGateError(error?.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "GATEWAY_UNAVAILABLE", "Gateway account status is unavailable.");
    }
    return {
      loggedIn: status?.loggedIn === true,
      active: status?.active === true,
      balance: status?.balance,
      user: status?.user
        ? {
            username: status.user.username,
            plan: status.user.plan,
            quota: status.user.quota,
            used: status.user.used,
            balance: status.user.balance,
            callsLeft: status.user.callsLeft,
            accountType: status.user.accountType
          }
        : null
    };
  }

  async function requireLoggedInAccount() {
    const status = await accountStatus();
    if (!status.loggedIn) throw new QualityGateError("AUTH_REQUIRED", "A logged-in gateway account is required.");
    return status;
  }

  async function readStore() {
    try {
      const parsed = JSON.parse(await fs.readFile(storePath, "utf8"));
      return Array.isArray(parsed?.bindings) ? {
        version: 2,
        bindings: parsed.bindings,
        preparations: Array.isArray(parsed.preparations) ? parsed.preparations : []
      } : { version: 2, bindings: [], preparations: [] };
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 2, bindings: [], preparations: [] };
      throw new QualityGateError("BINDINGS_UNAVAILABLE", "Quality bindings cannot be read.");
    }
  }

  async function saveStore(store) {
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    const temporary = `${storePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, storePath);
  }

  async function bind(input = {}) {
    if (input.referenceAuthorized !== true) throw new QualityGateError("REFERENCE_AUTHORIZATION_REQUIRED", "Authorized reference confirmation is required.");
    const auxiliaryPaths = resolvedAuxiliaryPaths(input);
    const auxiliary = auxiliaryPaths[0];
    const reference = resolvedBoundPath(auxiliary.projectRoot, input.referencePath, "referencePath");
    const style = resolvedBoundPath(auxiliary.projectRoot, input.styleAnchorPath, "styleAnchorPath");
    await Promise.all([boundedAuxiliaryText(auxiliaryPaths), boundedReferenceText(reference.absolutePath), boundedText(style.absolutePath)]);
    const store = await readStore();
    const binding = {
      id: crypto.randomUUID(),
      projectPath: auxiliary.projectRoot,
      auxiliaryPath: auxiliary.relativePath,
      auxiliaryPaths: auxiliaryPaths.map((item) => item.relativePath),
      referencePath: reference.relativePath,
      styleAnchorPath: style.relativePath,
      createdAt: new Date().toISOString()
    };
    store.bindings = [binding, ...store.bindings.filter((item) => item.projectPath !== binding.projectPath)];
    await saveStore(store);
    return publicBinding(binding);
  }

  async function listBindings() {
    return (await readStore()).bindings.map(publicBinding);
  }

  async function listModels() {
    await requireLoggedInAccount();
    const catalog = await gateway.listModels();
    const models = Array.isArray(catalog) ? catalog : catalog?.models;
    if (!Array.isArray(models)) throw new QualityGateError("GATEWAY_UNAVAILABLE", "Gateway model catalogue is unavailable.");
    return models.filter((model) => model && typeof model.id === "string" && !isWritingBlockedGpt(model) && !isCoverModel(model));
  }

  async function loadBinding(bindingId) {
    const id = requiredString(bindingId, "bindingId", 128);
    const binding = (await readStore()).bindings.find((item) => item.id === id);
    if (!binding) throw new QualityGateError("BINDING_NOT_FOUND", "Quality binding was not found.");
    const auxiliary = resolvedBoundPath(binding.projectPath, binding.auxiliaryPath, "auxiliaryPath");
    const auxiliaryPaths = (Array.isArray(binding.auxiliaryPaths) && binding.auxiliaryPaths.length ? binding.auxiliaryPaths : [binding.auxiliaryPath])
      .map((item) => resolvedBoundPath(binding.projectPath, item, "auxiliaryPaths"));
    const reference = resolvedBoundPath(binding.projectPath, binding.referencePath, "referencePath");
    const style = resolvedBoundPath(binding.projectPath, binding.styleAnchorPath, "styleAnchorPath");
    const [auxiliaryText, referenceText, styleText] = await Promise.all([boundedAuxiliaryText(auxiliaryPaths), boundedReferenceText(reference.absolutePath), boundedText(style.absolutePath)]);
    return { binding, auxiliaryText, referenceText, styleText };
  }

  async function prepareStage(input = {}) {
    const stage = requiredString(input.stage, "stage", 32);
    if (!PREPARABLE_STAGES.has(stage)) throw new QualityGateError("INVALID_ARGUMENT", "stage is invalid.");
    const context = await loadBinding(input.bindingId);
    const models = await listModels();
    const now = Date.now();
    const store = await readStore();
    const preparation = {
      id: crypto.randomUUID(),
      bindingId: context.binding.id,
      stage,
      modelIds: models.map((model) => model.id),
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + STAGE_PREPARATION_TTL_MS).toISOString()
    };
    store.preparations = [preparation, ...store.preparations.filter((item) => Date.parse(item?.expiresAt) > now && !item?.usedAt)].slice(0, 128);
    await saveStore(store);
    return { id: preparation.id, bindingId: preparation.bindingId, stage, models, expiresAt: preparation.expiresAt };
  }

  function recommendedModel(stage, models) {
    const model = models.find((item) => item.id === "claude-opus-4-8")
      || models.find((item) => item.id === "claude-opus-4-6")
      || models.find((item) => item.id === "gpt-5.6-sol")
      || models.find((item) => item.id === "claude-sonnet-5")
      || models.find((item) => item.id === "gemini-3.1-pro-preview")
      || models.find((item) => item.id === "kimi-k2.6")
      || models.find((item) => item.id === "seed-2.1-pro")
      || models.find((item) => item.id === "glm-5.2")
      || models.find((item) => item.id === "gpt-5.6-terra")
      || models.find((item) => item.id === "gpt-5.6-luna")
      || models.find((item) => item.id === "gemini-3.5-flash")
      || models.find((item) => item.id === "deepseek-v4-flash")
      || models.find((item) => item.id === "minimax-m3")
      || models.find((item) => /grok-4\.5/i.test(String(item.id || "")))
      || models.find((item) => item.id === "seed-2.1-pro")
      || models[0];
    const reasons = {
      brainstorm: "优先用于开放发散、资料对照或作者明确指定的模型脑洞。",
      outline: "优先保证细纲与既有设定、人物和时间线一致。",
      draft: "优先保证正文候选的长篇连贯性、人物声音与场景推进。",
      humanize: "优先保证只处理 AI 腔和表达，不改动剧情事实。",
      review: "优先保证终检能逐项核对设定、文风和 AI 腔。",
      revise: "优先保证按质检结论定点轻改，不重写故事。"
    };
    return { id: model.id, label: model.label || model.id, reason: reasons[stage] };
  }

  async function workflowGuide(input = {}) {
    const phase = input.phase === undefined ? "brainstorm" : requiredString(input.phase, "phase", 32);
    if (!WORKFLOW_PHASES.has(phase)) throw new QualityGateError("INVALID_ARGUMENT", "phase is invalid.");
    const context = await loadBinding(input.bindingId);
    const genreId = input.genreId === undefined || input.genreId === null || input.genreId === ""
      ? undefined
      : requiredString(input.genreId, "genreId", 64);
    try {
      let model;
      try {
        const account = await accountStatus();
        model = {
          connected: account.loggedIn === true,
          loggedIn: account.loggedIn === true,
          username: account.user?.username,
          plan: account.user?.plan,
          balance: account.balance ?? account.user?.balance
        };
      } catch {
        model = { connected: false, loggedIn: false };
      }
      return buildWorkflowGuide({
        bindingId: context.binding.id,
        phase,
        genreId,
        continuousPreset: input.continuousPreset,
        chapterCount: input.chapterCount,
        includeHumanize: input.includeHumanize,
        includeReview: input.includeReview,
        fromPhase: input.fromPhase,
        progress: input.progress,
        model
      });
    } catch (error) {
      if (error?.code === "INVALID_ARGUMENT") throw new QualityGateError("INVALID_ARGUMENT", error.message);
      throw error;
    }
  }

  async function guideStage(input = {}) {
    const prepared = await prepareStage(input);
    const recommendation = recommendedModel(prepared.stage, prepared.models);
    return {
      status: "awaiting_model_confirmation",
      bindingId: prepared.bindingId,
      stage: prepared.stage,
      preparationId: prepared.id,
      expiresAt: prepared.expiresAt,
      models: prepared.models,
      recommendedModel: recommendation,
      chat: {
        prompt: `阶段已准备：${prepared.stage}。推荐 ${recommendation.label}，${recommendation.reason}请选择模型并直接回复模型名确认，或说“按流程自动执行”。`,
        automaticInstruction: "若作者已经明确授权按流程自动执行或连续跑，Codex 可按 continuous 计划推进多个阶段；每一付费阶段仍须重新准备并展示结果；确认入台账前必须停下来给作者看，并在确认时输出结算摘要。"
      }
    };
  }

  async function consumePreparation({ preparationId, bindingId, stage, modelId }) {
    if (typeof preparationId !== "string" || !preparationId.trim()) {
      throw new QualityGateError("STAGE_CONFIRMATION_REQUIRED", "A fresh author-confirmed stage preparation is required.");
    }
    const store = await readStore();
    const preparation = store.preparations.find((item) => item?.id === preparationId.trim());
    if (!preparation) throw new QualityGateError("STAGE_CONFIRMATION_NOT_FOUND", "Stage preparation was not found.");
    if (preparation.usedAt) throw new QualityGateError("STAGE_CONFIRMATION_USED", "Stage preparation has already been used.");
    if (!Number.isFinite(Date.parse(preparation.expiresAt)) || Date.parse(preparation.expiresAt) <= Date.now()) {
      throw new QualityGateError("STAGE_CONFIRMATION_EXPIRED", "Stage preparation has expired; confirm the model again.");
    }
    if (preparation.bindingId !== bindingId || preparation.stage !== stage || !preparation.modelIds.includes(modelId)) {
      throw new QualityGateError("STAGE_CONFIRMATION_MISMATCH", "Stage preparation does not match this binding, stage, or model.");
    }
    preparation.usedAt = new Date().toISOString();
    await saveStore(store);
  }

  function reviewPrompt({ prose, auxiliaryText, referenceText, styleText, mode }) {
    return [
      "你是中文网文最终质检编辑。只评审，不编造事实，不复制参考书表达。",
      "必须依据绑定辅助文档检查设定、人物、时间线、硬禁；依据授权参考书只比较可迁移的文风特征；依据文风锚点检查节奏和表达。",
      "AI 腔必须按具体句子和原因指出，不能只给泛泛评分。硬规则、设定、人物、时间线、明显 AI 腔任一未过都返回 blocked。",
      "仅输出一个 JSON 对象：{\"verdict\":\"pass|blocked\",\"findings\":[{\"code\":\"...\",\"message\":\"...\",\"severity\":\"blocker|warning\"}],\"revisedText\":\"...\"}。",
      mode === "revise" ? "revisedText 只能轻改命中问题，不改变剧情、设定、人物选择、事件顺序或章末钩子。" : "revisedText 必须为空字符串。",
      "\n## 绑定辅助文档\n" + auxiliaryText,
      "\n## 授权参考书（仅作风格分析）\n" + referenceText,
      "\n## 文风锚点\n" + styleText,
      "\n## 待质检正文\n" + prose
    ].join("\n");
  }

  function writerPrompt({ stage, instruction, auxiliaryText, referenceText, styleText }) {
    const stageInstructions = {
      brainstorm: "围绕作者的问题发散材料、可能性和反例。按问题需要组织内容；不要自行把回答收束成章节计划。不得复制参考书的具体情节、名字或句子。",
      outline: "把用户已确认的方向整理为可写的章节/段落计划，所有事实必须服从绑定辅助文档。",
      draft: "直接输出候选正文，不写解释、提纲、模型说明或检查表。",
      humanize: "只轻改用户给出的候选正文中明确的 AI 腔与别扭表达，不改变剧情、设定、人物选择、事件顺序和钩子。只输出候选正文。"
    };
    return [
      "你是受控中文网文写作助手。用户的辅助文档优先于任何默认写法；参考书仅用于学习可迁移的节奏、压力、对白功能和读者预期，严禁复制其具体表达、名字、设定或桥段。",
      "当前阶段：" + stage,
      stageInstructions[stage],
      "输出内容是候选稿，必须等待最终质量门通过和作者确认后才能进入正式正文。",
      "\n## 绑定辅助文档\n" + auxiliaryText,
      "\n## 授权参考书（仅作风格分析）\n" + referenceText,
      "\n## 文风锚点\n" + styleText,
      "\n## 用户任务\n" + instruction
    ].join("\n");
  }

  async function writeWithModel(input = {}) {
    const stage = requiredString(input.stage, "stage", 32);
    if (!WRITING_STAGES.has(stage)) throw new QualityGateError("INVALID_ARGUMENT", "stage is invalid.");
    const modelId = requiredString(input.modelId, "modelId", 128);
    const instruction = requiredString(input.instruction, "instruction", MAX_PROSE_CHARACTERS);
    const context = await loadBinding(input.bindingId);
    const models = await listModels();
    if (!models.some((model) => model.id === modelId)) throw new QualityGateError("MODEL_NOT_AVAILABLE", "Selected non-GPT model is not available from the gateway.");
    await consumePreparation({ preparationId: input.preparationId, bindingId: context.binding.id, stage, modelId });
    const artifactTarget = input.artifactPath === undefined ? null : resolvedArtifactPath(context.binding.projectPath, input.artifactPath);
    const pendingArtifactPath = artifactTarget ? streamingPath(artifactTarget) : null;
    if (pendingArtifactPath) {
      await fs.mkdir(path.dirname(pendingArtifactPath), { recursive: true });
      await fs.writeFile(pendingArtifactPath, "", { encoding: "utf8" });
    }
    const response = await gateway.callModels({
      modelIds: [modelId],
      prompt: writerPrompt({ stage, instruction, auxiliaryText: context.auxiliaryText, referenceText: context.referenceText, styleText: context.styleText }),
      taskLabel: "fiction-model-writing",
      ...(pendingArtifactPath ? { onDelta: (chunk) => fs.appendFile(pendingArtifactPath, chunk, "utf8") } : {})
    });
    const candidate = String(response?.content || response?.outputs?.[response.outputs.length - 1]?.content || "").trim();
    if (!candidate) throw new QualityGateError("GATEWAY_RESPONSE_INVALID", "Gateway returned no candidate text.");
    if (artifactTarget) await fs.rename(pendingArtifactPath, artifactTarget.absolutePath);
    return {
      bindingId: context.binding.id,
      modelId,
      stage,
      candidate,
      ...(artifactTarget ? { artifact: { path: artifactTarget.relativePath, status: "saved" } } : {})
    };
  }

  async function review(input = {}) {
    const prose = requiredString(input.prose, "prose", MAX_PROSE_CHARACTERS);
    const modelId = requiredString(input.modelId, "modelId", 128);
    const mode = input.mode === undefined ? "review" : input.mode;
    if (mode !== "review" && mode !== "revise") throw new QualityGateError("INVALID_ARGUMENT", "mode must be review or revise.");
    const context = await loadBinding(input.bindingId);
    const findings = localFindings(prose, context.auxiliaryText);
    if (isWritingBlockedGpt({ id: modelId })) throw new QualityGateError("GPT_MODEL_FORBIDDEN", "This GPT model is not allowed for writing.");

    let gatewayVerdict = "blocked";
    let revisedText = "";
    try {
      const models = await listModels();
      if (!models.some((model) => model.id === modelId)) throw new QualityGateError("MODEL_NOT_AVAILABLE", "Selected non-GPT model is not available from the gateway.");
      await consumePreparation({ preparationId: input.preparationId, bindingId: context.binding.id, stage: mode === "revise" ? "revise" : "review", modelId });
      const response = await gateway.callModels({
        modelIds: [modelId],
        prompt: reviewPrompt({ prose, auxiliaryText: context.auxiliaryText, referenceText: context.referenceText, styleText: context.styleText, mode }),
        taskLabel: "fiction-quality-gate"
      });
      const content = response?.content || response?.outputs?.[response.outputs.length - 1]?.content;
      const parsed = extractJson(content);
      const verdict = normalizeVerdict(parsed?.verdict);
      if (!verdict || !Array.isArray(parsed?.findings) || (mode === "revise" && typeof parsed.revisedText !== "string")) {
        findings.push(safeFinding("GATEWAY_VERDICT_INVALID", "网关质检没有返回有效的结构化结论。"));
      } else {
        gatewayVerdict = verdict;
        for (const item of parsed.findings.slice(0, 64)) {
          if (item && typeof item === "object") findings.push(safeFinding(item.code || "GATEWAY_FINDING", item.message || "网关发现质量问题。", item.severity === "warning" ? "warning" : "blocker"));
        }
        if (mode === "revise") revisedText = parsed.revisedText;
      }
    } catch (error) {
      if (error?.code === "GATEWAY_VERDICT_INVALID") findings.push(safeFinding(error.code, error.message));
      else findings.push(safeFinding(error?.code || "GATEWAY_REVIEW_FAILED", "网关最终复核失败，正文不得交付。"));
    }
    const blocked = gatewayVerdict !== "pass" || findings.some((finding) => finding.severity === "blocker");
    return {
      status: blocked ? "blocked" : "pass",
      bindingId: context.binding.id,
      modelId,
      findings,
      ...(mode === "revise" && revisedText ? { revisedText } : {})
    };
  }

  async function generateCover(input = {}) {
    await requireLoggedInAccount();
    if (!gateway || typeof gateway.generateImage !== "function") {
      throw new QualityGateError("GATEWAY_UNAVAILABLE", "Cover generation is unavailable from the gateway.");
    }
    const modelId = String(input.modelId || "gpt-image-2").trim() || "gpt-image-2";
    if (!isCoverModel({ id: modelId })) {
      throw new QualityGateError("INVALID_ARGUMENT", "modelId must be a cover image model such as gpt-image-2.");
    }
    const title = String(input.title || "").trim().slice(0, 80);
    const genre = String(input.genre || "").trim().slice(0, 40);
    const style = String(input.style || "cinematic novel cover, high detail, no watermark, no text artifacts").trim().slice(0, 200);
    const prompt = String(input.prompt || "").trim() || [
      "Chinese web-novel book cover illustration",
      title ? ("title mood: " + title) : null,
      genre ? ("genre: " + genre) : null,
      style,
      "vertical poster composition, dramatic lighting, premium commercial cover"
    ].filter(Boolean).join(", ");
    const image = await gateway.generateImage({
      model: modelId,
      prompt,
      size: String(input.size || "1024x1536")
    });
    let savedPath = null;
    if (image.b64 && input.savePath) {
      const abs = path.resolve(String(input.savePath));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, Buffer.from(image.b64, "base64"));
      savedPath = abs;
    }
    return {
      ok: true,
      modelId,
      credits: image.credits || 50,
      purpose: "novel-cover",
      prompt,
      savedPath,
      hasB64: !!image.b64,
      url: image.url || null,
      created: image.created || null
    };
  }

  return { gateway, accountStatus, bind, listBindings, listModels, prepareStage, workflowGuide, guideStage, review, writeWithModel, generateCover };
}

module.exports = { QualityGateError, createQualityGateService, isGptModel };
