"use strict";

const { writeArtifact, readArtifact, listArtifacts, generateToArtifact, continueArtifactToFile } = require("./artifact-pipeline");
const { recommendModels, listTaskCatalog } = require("./model-router");
const { optimizeWithModels } = require("./multi-model-optimize");
const { compareStyle } = require("./style-compare-service");
const { smokeLiveGateway } = require("./live-gateway-smoke");
const { buildDraftSystem, prepareDraftPrompt } = require("./draft-prompt-lib");
const { createGenerationJobManager } = require("./generation-job-manager");
const onboarding = require("./onboarding-state");
const { createBillingGateway, readBillingSnapshot } = require("./billing-guard");
const { filterDisabledModels } = require("./disabled-models");

const MAX_OUTPUT_DEPTH = 32;
const MAX_OUTPUT_NODES = 10_000;
const SENSITIVE_KEY_PARTS = [
  "key", "token", "password", "secret", "authorization", "rechargecode",
  "credential", "cookie", "session", "bearer"
];

function normalizedKey(key) { return String(key).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}
function sanitizeOutput(value, state = { nodes: 0, seen: new WeakSet() }, depth = 0) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return null;
  if (depth >= MAX_OUTPUT_DEPTH || state.nodes >= MAX_OUTPUT_NODES) return "[truncated]";
  if (state.seen.has(value)) return "[circular]";
  state.seen.add(value);
  state.nodes += 1;
  try {
    if (Array.isArray(value)) return value.slice(0, MAX_OUTPUT_NODES).map((item) => sanitizeOutput(item, state, depth + 1));
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSensitiveKey(key)) continue;
      result[key] = sanitizeOutput(item, state, depth + 1);
    }
    return result;
  } finally {
    state.seen.delete(value);
  }
}
function toolResult(value) { return { content: [{ type: "text", text: JSON.stringify(sanitizeOutput(value), null, 2) }] }; }
function required(value, name) {
  if (typeof value !== "string" || !value.trim()) { const error = new Error(`${name} is required.`); error.code = "INVALID_ARGUMENT"; throw error; }
  return value.trim();
}
function safetyAnnotations(readOnlyHint) {
  return { readOnlyHint, openWorldHint: false, destructiveHint: false };
}
function defaultTarget(input = {}) {
  const explicit = String(input.target || "").trim();
  if (explicit) return explicit;
  return String(input.chapterNo || "").trim() ? "chapter" : "candidate";
}

function createGatewayMcpTools({ gateway, gatewayGuard, openLoginPage, generationJobs } = {}) {
  if (!gateway) throw new TypeError("gateway is required");
  const jobs = generationJobs || createGenerationJobManager();
  const billedGateway = createBillingGateway(gateway);
  async function requireGateway(reason = "tool_call", {
    allowPopup = false,
    explicitUserChoice = false
  } = {}) {
    if (!gatewayGuard || typeof gatewayGuard.ensureAccess !== "function") return { ok: true, loggedIn: true, skipped: true };
    return gatewayGuard.ensureAccess({ reason, allowPopup, explicitUserChoice });
  }
  async function requireGatewayOrThrow(reason = "model_call", options = {}) {
    const access = await requireGateway(reason, options);
    if (access.loggedIn) return access;
    const error = new Error(access.message || "Please log in first.");
    error.code = "AUTH_REQUIRED";
    error.access = access;
    throw error;
  }
  const definitions = [
    { name: "fiction_ensure_gateway", description: "Check gateway status and persist account binding. The first plugin activation opens the binding page in the default browser, even if a local session already exists; later checks stay quiet. After binding, users can say 'use DeepSeek' or name another listed model directly. bindModels=true remembers the binding, but every model call still requires current author confirmation.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" }, bindModels: { type: "boolean" }, unbindModels: { type: "boolean" } } } },
    { name: "fiction_open_gateway_login", description: "Open the local gateway binding page. Credentials stay in the local page, not MCP. The page supports login, registration, balance, model rates and recharge-code redemption.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_account_status", description: "Read gateway login/account status without spamming login popup.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_list_models", description: "List models available to the logged-in account and its public balance status. Users may directly say 'use DeepSeek V4 Pro' or name any returned model; the plugin will show the live rate before the call.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_recommend_models", description: "Lead-editor router: recommend one external model, show its live credit rate and current balance, and list manual alternatives. The user can override the recommendation by saying 'use DeepSeek V4 Flash/Pro' or naming another returned model. The selected call must be confirmed again; models are never switched automatically.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: { task: { type: "string", maxLength: 64 }, mode: { type: "string", maxLength: 16 }, targetChars: { type: "number", minimum: 0, maximum: 200000 }, maxPerRole: { type: "number" }, authorPrefer: { type: "array", items: { type: "string" }, maxItems: 8 } } } },
    { name: "fiction_list_model_tasks", description: "List task types supported by the lead-editor model router.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_generate_to_file", description: "Call the model only after the author confirms this specific call. authorConfirmed=true is required every time. With chapterNo, the default target is chapter: write directly to 正文/第XXX章_标题.txt and overwrite that same chapter on regeneration. Use target=candidate only as a hidden compatibility mode when the author explicitly wants parallel temporary drafts.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "prompt", "modelIds", "authorConfirmed"], properties: { target: { type: "string", enum: ["candidate", "chapter"] }, projectDir: { type: "string", maxLength: 512 }, prompt: { type: "string", maxLength: 1000000 }, projectContext: { type: "string", maxLength: 1000000 }, system: { type: "string", maxLength: 200000 }, modelIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }, authorConfirmed: { type: "boolean" }, background: { type: "boolean" }, kind: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, taskLabel: { type: "string", maxLength: 64 }, previewChars: { type: "number" }, fallbackChain: { type: "boolean" }, minChars: { type: "number" }, applyHardGates: { type: "boolean" }, maxTokens: { type: "number", minimum: 256, maximum: 65536 } } } },
    { name: "fiction_continue_artifact", description: "Continue a saved incomplete generated text only after the author confirms this additional model call. This compatibility tool is for explicit continuation recovery; ordinary chapter regeneration should use fiction_generate_to_file with chapterNo so the same 正文 file is overwritten.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "sourcePath", "modelIds", "authorConfirmed"], properties: { projectDir: { type: "string", maxLength: 512 }, sourcePath: { type: "string", maxLength: 1024 }, modelIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }, authorConfirmed: { type: "boolean" }, background: { type: "boolean" }, system: { type: "string", maxLength: 200000 }, direction: { type: "string", maxLength: 100000 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, minAdditionalChars: { type: "number" }, maxTokens: { type: "number", minimum: 256, maximum: 65536 }, fallbackChain: { type: "boolean" } } } },
    { name: "fiction_generation_status", description: "Read a background generation/optimization job. While it runs, do only local continuity, fact, foreshadowing, and review preparation; do not start another paid call or edit canon.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["jobId"], properties: { jobId: { type: "string", maxLength: 96 } } } },
    { name: "fiction_write_artifact", description: "Write prose to a project file. With chapterNo, default target is 正文 and overwrites the same chapter; target=candidate is only a compatibility path for explicit temporary drafts. When modelId identifies an external model, append the Markdown writing-history entry.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "content"], properties: { target: { type: "string", enum: ["candidate", "chapter"] }, projectDir: { type: "string", maxLength: 512 }, content: { type: "string", maxLength: 1000000 }, kind: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, modelId: { type: "string", maxLength: 128 }, ext: { type: "string", maxLength: 8 } } } },
    { name: "fiction_write_local_candidate", description: "Save author/Codex-written prose without gateway. With chapterNo, default target is 正文 and overwrites the same chapter; target=candidate is only for explicit temporary drafts.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "content"], properties: { target: { type: "string", enum: ["candidate", "chapter"] }, projectDir: { type: "string", maxLength: 512 }, content: { type: "string", maxLength: 1000000 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, kind: { type: "string", maxLength: 40 } } } },
    { name: "fiction_read_artifact", description: "Read a generated txt/md file written by the plugin, including 正文 files or explicit temporary artifacts.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", maxLength: 1024 }, maxChars: { type: "number" } } } },
    { name: "fiction_list_artifacts", description: "List explicit temporary draft artifacts. The normal writing flow reads 正文/ directly and does not need this.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, limit: { type: "number" } } } },
    { name: "fiction_optimize_with_models", description: "Optimize only after the author confirms this specific call. With chapterNo, default target is chapter: save the revised text directly over the same 正文 chapter. Auto recommendation uses one main model unless the author explicitly provides several modelIds.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "draftText", "authorConfirmed"], properties: { target: { type: "string", enum: ["candidate", "chapter"] }, projectDir: { type: "string", maxLength: 512 }, draftText: { type: "string", maxLength: 1000000 }, authorConfirmed: { type: "boolean" }, background: { type: "boolean" }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, modelIds: { type: "array", items: { type: "string" }, maxItems: 8 }, mode: { type: "string", maxLength: 32 }, focus: { type: "string", maxLength: 32 }, instruction: { type: "string", maxLength: 20000 }, autoRecommend: { type: "boolean" }, maxTokens: { type: "number", minimum: 256, maximum: 65536 } } } },
    { name: "fiction_compare_style", description: "Compare draft against voice anchors and sample-book notes; write report artifact.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, draftText: { type: "string", maxLength: 1000000 }, draftPath: { type: "string", maxLength: 1024 }, title: { type: "string", maxLength: 120 } } } },
    { name: "fiction_smoke_live_gateway", description: "Run exactly one paid live generation smoke after the author confirms this specific call. It does not optimize; optimization requires a separate confirmation and fiction_optimize_with_models call.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["authorConfirmed"], properties: { authorConfirmed: { type: "boolean" }, projectDir: { type: "string", maxLength: 512 }, title: { type: "string", maxLength: 80 }, modelIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 1 } } } }
  ];
  async function call(name, input = {}) {
    switch (name) {
      case "fiction_ensure_gateway": {
        if (input.bindModels === true && input.unbindModels === true) {
          const error = new Error("bindModels and unbindModels cannot both be true");
          error.code = "INVALID_ARGUMENT";
          throw error;
        }
        if (input.unbindModels === true) await onboarding.markModelGatewayBinding(false);
        if (!gatewayGuard || typeof gatewayGuard.ensureAccess !== "function") {
          const state = await onboarding.readState();
          return toolResult({ ok: true, skipped: true, modelGatewayBound: !!state.modelGatewayBound, message: "gatewayGuard unavailable" });
        }
        const access = await gatewayGuard.ensureAccess({
          force: input.force === true,
          reason: input.force ? "forced" : "ensure_gateway",
          allowPopup: input.force === true,
          explicitUserChoice: input.force === true
        });
        if (input.bindModels === true && access.loggedIn === true) await onboarding.markModelGatewayBinding(true);
        const state = await onboarding.readState();
        return toolResult({ ...access, modelGatewayBound: !!state.modelGatewayBound });
      }
      case "fiction_open_gateway_login": {
        if (gatewayGuard && typeof gatewayGuard.ensureAccess === "function") {
          return toolResult(await gatewayGuard.ensureAccess({
            force: true,
            reason: "open_gateway_login",
            openBrowser: true,
            allowPopup: true,
            explicitUserChoice: true
          }));
        }
        if (typeof openLoginPage !== "function") {
          const error = new Error("Login page unavailable"); error.code = "TOOL_NOT_FOUND"; throw error;
        }
        const page = await openLoginPage();
        return toolResult({ ok: false, loggedIn: false, popupOpened: true, loginUrl: page?.url || null, shopUrl: process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || "https://catfk.com/shop/ZVZNANU8", message: page?.message || "请在浏览器完成登录。" });
      }
      case "fiction_account_status": {
        if (gatewayGuard && typeof gatewayGuard.accountSnapshot === "function") {
          const snap = await gatewayGuard.accountSnapshot();
          if (snap.loggedIn && typeof onboarding.markLoginOk === "function") {
            try { await onboarding.markLoginOk(); } catch {}
          }
          const state = await onboarding.readState();
          return toolResult({ ok: true, loggedIn: !!snap.loggedIn, online: !!snap.online, modelGatewayBound: !!state.modelGatewayBound, account: snap.raw || null, message: snap.loggedIn ? "网关已登录。" : "未登录。可用 fiction_open_gateway_login。" });
        }
        if (typeof gateway.accountStatus === "function") {
          try {
            const raw = await gateway.accountStatus();
            const loggedIn = !!(raw && (raw.loggedIn === true || raw.user));
            return toolResult({ ok: true, loggedIn, account: raw, message: loggedIn ? "网关已登录。" : "未登录。" });
          } catch {
            return toolResult({ ok: false, loggedIn: false, message: "无法读取账号状态。" });
          }
        }
        return toolResult({ ok: false, loggedIn: false, message: "账号状态接口不可用。" });
      }
      case "fiction_list_models": {
        await requireGatewayOrThrow("list_models");
        if (typeof gateway.listModels !== "function" || typeof gateway.accountStatus !== "function") {
          const error = new Error("Model gateway is unavailable."); error.code = "GATEWAY_REQUIRED"; throw error;
        }
        const [account, catalog] = await Promise.all([gateway.accountStatus(), gateway.listModels()]);
        const listedModels = filterDisabledModels(Array.isArray(catalog) ? catalog : catalog?.models || []);
        return toolResult({
          account,
          models: listedModels,
          directUse: {
            message: "可以直接说‘用 DeepSeek V4 Flash’或‘用 DeepSeek V4 Pro’，插件会先展示实时费率和余额，再等待本次确认。",
            modelIds: listedModels.filter((model) => /^deepseek-/iu.test(String(model?.id || ""))).map((model) => model.id)
          }
        });
      }
      case "fiction_list_model_tasks": return toolResult({ tasks: listTaskCatalog(), leadEditorRouter: true });
      case "fiction_recommend_models": {
        const mode = String(input.mode || "quick");
        let models = [];
        let unpaid = false;
        try {
          const listed = await gateway.listModels();
          models = filterDisabledModels(Array.isArray(listed?.models) ? listed.models : []);
        } catch {
          unpaid = true;
          models = [];
        }
        const creditsMap = {};
        for (const m of models) {
          if (m && m.id != null) creditsMap[m.id] = m.credits ?? m.credit ?? m.cost ?? null;
        }
        const authorPrefer = Array.isArray(input.authorPrefer)
          ? input.authorPrefer
          : (gateway.preferredModel ? [gateway.preferredModel] : []);
        const recommendation = recommendModels({
          task: String(input.task || "draft"),
          mode,
          availableModels: models,
          creditsMap,
          authorPrefer,
          maxPerRole: Number(input.maxPerRole || 2),
          targetChars: Number(input.targetChars || 0),
          unpaid: unpaid || models.length === 0
        });
        let billing;
        try {
          billing = await readBillingSnapshot(gateway, [recommendation.primaryModelId]);
        } catch (error) {
          billing = error?.billing || {
            status: "unavailable",
            modelIds: [recommendation.primaryModelId],
            message: "调用前会再次读取实时费率和余额。"
          };
        }
        return toolResult({
          ...recommendation,
          directUse: {
            message: "不满意推荐时，可以直接指定已列出的模型，例如‘用 DeepSeek V4 Pro 复核这一章’；仍会先显示费率并等待本次确认。",
            modelIds: models.filter((model) => /^deepseek-/iu.test(String(model?.id || ""))).map((model) => model.id)
          },
          billing: {
            ...billing,
            model: recommendation.primaryModelId,
            confirmationRequired: true,
            message: billing.mode === "unlimited"
              ? "当前账号为不限额/托管套餐；本次不会扣有限积分，费率仅作参考。确认后才调用。"
              : billing.estimatedCredits == null
                ? "调用前会再次读取实时费率和余额；费率或余额无法确认时会停止调用。"
                : `本次预计消耗 ${billing.estimatedCredits} 积分；当前余额 ${billing.balanceBefore} 积分，预计调用后约 ${billing.expectedBalanceAfter} 积分；确认后才调用。`
          }
        });
      }
      case "fiction_generate_to_file": {
        if (input.authorConfirmed !== true) {
          const error = new Error("Author confirmation is required for this model call.");
          error.code = "AUTHOR_CONFIRMATION_REQUIRED";
          throw error;
        }
        await requireGatewayOrThrow("generate_to_file", {
          allowPopup: true,
          explicitUserChoice: true
        });
        if (typeof gateway.callModels !== "function") {
          const error = new Error("gateway.callModels unavailable");
          error.code = "GATEWAY_UNAVAILABLE";
          throw error;
        }
        const kind = String(input.kind || "draft");
        const taskLabel = String(input.taskLabel || input.kind || "fiction");
        const draftSystem = buildDraftSystem({
          system: String(input.system || ""),
          kind,
          taskLabel
        });
        const preparedPrompt = prepareDraftPrompt({
          prompt: required(input.prompt, "prompt"),
          projectContext: String(input.projectContext || ""),
          minChars: input.minChars
        });
        const generationInput = {
            gateway: billedGateway,
          projectDir: required(input.projectDir, "projectDir"),
          prompt: preparedPrompt.prompt,
          system: draftSystem.system,
          modelIds: input.modelIds,
          kind,
          title: String(input.title || ""),
          chapterNo: String(input.chapterNo || ""),
          taskLabel,
          previewChars: Number(input.previewChars || 800),
          fallbackChain: input.fallbackChain === true,
          minChars: preparedPrompt.minimumChars,
          applyHardGates: input.applyHardGates !== false,
          maxTokens: Number(input.maxTokens || 32000),
          requestPolicyVersion: draftSystem.policyVersion,
          contextSanitization: preparedPrompt.contextSanitization,
          outputTarget: defaultTarget(input)
        };
        if (input.background === true) {
          const job = jobs.start({
            type: "generation",
            metadata: {
              projectDir: generationInput.projectDir,
              kind,
              title: generationInput.title,
              chapterNo: generationInput.chapterNo,
              policyVersion: draftSystem.policyVersion,
              contextSanitization: preparedPrompt.contextSanitization
            },
            run: ({ updateProgress }) => generateToArtifact({
              ...generationInput,
              onProgress: updateProgress
            })
          });
          return toolResult({
            ok: true,
            background: true,
            ...job,
            waitingWork: [
              "读取最近已确认正文，核对人物位置、手中物件和未完成动作",
              "核对时间线、知情范围、事实库和待回收伏笔",
              "准备流程腔与事实冲突的正文检查重点"
            ],
            waitingBoundary: "仅做本地只读准备；不额外调用模型，不修改正式正文或事实台账。"
          });
        }
        return toolResult(await generateToArtifact(generationInput));
      }
      case "fiction_continue_artifact": {
        if (input.authorConfirmed !== true) {
          const error = new Error("Author confirmation is required for this continuation call.");
          error.code = "AUTHOR_CONFIRMATION_REQUIRED";
          throw error;
        }
        await requireGatewayOrThrow("continue_artifact", {
          allowPopup: true,
          explicitUserChoice: true
        });
        const draftSystem = buildDraftSystem({
          system: String(input.system || ""),
          kind: "continuous_draft",
          taskLabel: "continue-saved-draft"
        });
        const continuationInput = {
          gateway: billedGateway,
          projectDir: required(input.projectDir, "projectDir"),
          sourcePath: required(input.sourcePath, "sourcePath"),
          modelIds: input.modelIds,
          system: draftSystem.system,
          direction: String(input.direction || ""),
          title: String(input.title || ""),
          chapterNo: String(input.chapterNo || ""),
          minAdditionalChars: Number(input.minAdditionalChars || 0),
          maxTokens: Number(input.maxTokens || 32000),
          fallbackChain: input.fallbackChain === true
        };
        if (input.background === true) {
          const job = jobs.start({
            type: "continuation",
            metadata: {
              projectDir: continuationInput.projectDir,
              sourcePath: continuationInput.sourcePath,
              title: continuationInput.title,
              chapterNo: continuationInput.chapterNo
            },
            run: ({ updateProgress }) => continueArtifactToFile({
              ...continuationInput,
              onProgress: updateProgress
            })
          });
          return toolResult({ ok: true, background: true, ...job });
        }
        return toolResult(await continueArtifactToFile(continuationInput));
      }
      case "fiction_generation_status": {
        const job = jobs.get(required(input.jobId, "jobId"));
        if (!job) {
          const error = new Error("Background job not found. It may belong to an older MCP process.");
          error.code = "JOB_NOT_FOUND";
          throw error;
        }
        return toolResult({ ok: true, background: true, ...job });
      }
      case "fiction_write_artifact": return toolResult(await writeArtifact({
        projectDir: required(input.projectDir, "projectDir"),
        content: required(input.content, "content"),
        kind: String(input.kind || "draft"),
        title: String(input.title || ""),
        chapterNo: String(input.chapterNo || ""),
        modelId: String(input.modelId || ""),
        ext: String(input.ext || "txt"),
        target: defaultTarget(input)
      }));
      case "fiction_write_local_candidate": {
        const localTarget = defaultTarget(input);
        const saved = await writeArtifact({
          projectDir: required(input.projectDir, "projectDir"),
          kind: String(input.kind || "local_draft"),
          title: String(input.title || ""),
          chapterNo: String(input.chapterNo || ""),
          modelId: "local-or-codex",
          content: required(input.content, "content"),
          ext: "txt",
          meta: { transport: "local_no_gateway", note: localTarget === "chapter"
            ? "本地/Codex 直接写入正文，未走网关多模型"
            : "本地/Codex 写入的临时稿，未走网关多模型" },
          target: localTarget
        });
        return toolResult({
          ok: true,
          artifact: saved,
          coach: localTarget === "chapter"
            ? "已直接写入正文。重写同一章会覆盖同一个文件。"
            : "临时稿已落盘。网关绑定可永久保留，但每次调用其他模型前仍会询问；当次选择使用才调用。"
        });
      }
      case "fiction_read_artifact": return toolResult(await readArtifact(required(input.path, "path"), { maxChars: Number(input.maxChars || 1000000) }));
      case "fiction_list_artifacts": return toolResult(await listArtifacts(required(input.projectDir, "projectDir"), { limit: Number(input.limit || 30) }));
      case "fiction_optimize_with_models": {
        if (input.authorConfirmed !== true) {
          const error = new Error("Author confirmation is required for this model call.");
          error.code = "AUTHOR_CONFIRMATION_REQUIRED";
          throw error;
        }
        await requireGatewayOrThrow("optimize_with_models", {
          allowPopup: true,
          explicitUserChoice: true
        });
        const optimizeInput = {
          gateway: billedGateway,
          projectDir: required(input.projectDir, "projectDir"),
          draftText: required(input.draftText, "draftText"),
          title: String(input.title || ""),
          chapterNo: String(input.chapterNo || ""),
          modelIds: input.modelIds || [],
          mode: String(input.mode || "humanize"),
          focus: String(input.focus || "full"),
          instruction: String(input.instruction || ""),
          autoRecommend: input.autoRecommend !== false,
          maxTokens: Number(input.maxTokens || 32000),
          target: defaultTarget(input)
        };
        if (input.background === true) {
          const job = jobs.start({
            type: "optimization",
            metadata: {
              projectDir: optimizeInput.projectDir,
              mode: optimizeInput.mode,
              focus: optimizeInput.focus,
              title: optimizeInput.title,
              chapterNo: optimizeInput.chapterNo
            },
            run: ({ updateProgress }) => optimizeWithModels({
              ...optimizeInput,
              onProgress: updateProgress
            })
          });
          return toolResult({
            ok: true,
            background: true,
            ...job,
            waitingWork: [
              "核对原稿中的剧情事实、人物选择和事件顺序",
              "标记流程腔、说满、重复解释和人物声口风险",
              "准备改后正文的保真验收重点"
            ],
            waitingBoundary: "仅做本地只读准备；不额外调用模型，不修改正式正文或事实台账。"
          });
        }
        return toolResult(await optimizeWithModels(optimizeInput));
      }
      case "fiction_compare_style": return toolResult(await compareStyle({ projectDir: required(input.projectDir, "projectDir"), draftText: String(input.draftText || ""), draftPath: String(input.draftPath || ""), title: String(input.title || "") }));
      case "fiction_smoke_live_gateway": {
        if (input.authorConfirmed !== true) {
          const error = new Error("Author confirmation is required for this model call.");
          error.code = "AUTHOR_CONFIRMATION_REQUIRED";
          throw error;
        }
        await requireGatewayOrThrow("smoke_live_gateway", {
          allowPopup: true,
          explicitUserChoice: true
        });
        return toolResult(await smokeLiveGateway({
          gateway: billedGateway,
          projectDir: String(input.projectDir || ""),
          title: String(input.title || "live-smoke"),
          modelIds: input.modelIds
        }));
      }
      default: { const error = new Error(`Unknown gateway tool: ${name}`); error.code = "TOOL_NOT_FOUND"; throw error; }
    }
  }
  return Object.freeze({ list: () => definitions.map((tool) => ({ ...tool })), call });
}

module.exports = { createGatewayMcpTools };
