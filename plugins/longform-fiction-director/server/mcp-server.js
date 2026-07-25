"use strict";

const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { createGatewayClient } = require("./gateway-client");
const { loadPrimaryGatewayConfig } = require("./gateway-config");
const { createOpenAiCompatibleGateway } = require("./openai-compatible-gateway");
const { createHybridGateway } = require("./hybrid-gateway");
const { createGatewayLoginConsole } = require("./gateway-login-console");
const { createGatewayGuard } = require("./gateway-guard");
const onboardingState = require("./onboarding-state");
const { createQualityGateService } = require("./quality-gate-service");
const { createQualityGateMcpTools } = require("./quality-gate-mcp-tools");

const DEFAULT_PAYMENT_PORTAL_URL = "https://catfk.com/shop/ZVZNANU8";
const SAFE_GATEWAY_DIAGNOSTICS = new Set([
  "网关上游鉴权失败。",
  "网关上游模型或路由不可用。",
  "网关上游繁忙或触发限流。",
  "网关上游请求超时。",
  "网关上游请求失败。"
]);

function response(id, result) { return { jsonrpc: "2.0", id, result }; }
function error(id, code, message, data) { return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } }; }
function createDeconstructionGateway(gateway) {
  return Object.freeze({
    async callModels({ taskType, instruction, modelIds } = {}) {
      return gateway.callModels({
        prompt: String(instruction || ""),
        modelIds: Array.isArray(modelIds) ? modelIds : [],
        taskLabel: String(taskType || "book-deconstruction").slice(0, 64),
        system: "Analyze only authorized source material. Do not reproduce source prose, names, proprietary settings, or plot sequences."
      });
    }
  });
}
function safeMcpDiagnostics(cause) {
  const attempts = Array.isArray(cause?.fallbackAttempts) ? cause.fallbackAttempts.slice(-12).map((item) => ({ modelId: item?.modelId || null, errorCode: item?.errorCode || null, errorMessage: String(item?.errorMessage || "").slice(0, 300) })) : [];
  const partials = Array.isArray(cause?.partials) ? cause.partials.slice(-12).map((item) => ({ path: item?.path || null, manifestPath: item?.manifestPath || null, modelId: item?.modelId || null })) : [];
  return { code: cause?.code || cause?.name || "TOOL_FAILED", status: Number.isInteger(cause?.status) ? cause.status : null, requestId: cause?.requestId || null, transport: cause?.transport || null, partial: cause?.partial || null, partials, attempts, recoverable: !!(cause?.partial || partials.length) };
}
function safeMcpError(cause) {
  const messages = {
    AUTH_REQUIRED: "请先登录网关（fiction_open_gateway_login）。不登录也可做引导与本地候选。",
    INVALID_ARGUMENT: "Tool arguments are invalid.",
    TOOL_NOT_FOUND: "Tool not found.",
    PROJECT_NOT_FOUND: "Project not found.",
    PROJECT_BUSY: "The project already has an active writing task.",
    INSUFFICIENT_BALANCE: "Insufficient balance.",
    AINOVEL_UNAVAILABLE: "ainovel-cli is unavailable.",
    AINOVEL_BINARY_MISSING: "ainovel-cli binary is missing.",
    AINOVEL_ALREADY_RUNNING: "ainovel-cli is already running for this project."
    , GPT_MODEL_FORBIDDEN: "GPT models are not allowed for this quality gate."
    , REFERENCE_AUTHORIZATION_REQUIRED: "Authorized reference confirmation is required."
    , BINDING_NOT_FOUND: "Quality binding was not found."
    , BOUND_DOCUMENT_TOO_LARGE: "A bound document is too large."
    , MODEL_NOT_AVAILABLE: "Selected non-GPT model is not available from the gateway."
  };
  if (cause?.code === "SERVER_ERROR" && SAFE_GATEWAY_DIAGNOSTICS.has(cause?.publicMessage)) return cause.publicMessage;
  return messages[cause?.code] || "Tool call failed.";
}
function resolveGateway(options = {}) {
  if (options.gateway) return options.gateway;
  const primary = loadPrimaryGatewayConfig({
    mode: options.gatewayMode,
    baseUrl: options.gatewayUrl || process.env.FICTION_DIRECTOR_GATEWAY_URL,
    apiKey: options.gatewayApiKey || process.env.FICTION_DIRECTOR_GATEWAY_API_KEY,
    label: options.gatewayLabel
  });
  const sessionOptions = options.sessionOptions || options.gatewayOptions?.sessionOptions;
  const legacy = createGatewayClient({
    ...(options.gatewayOptions || {}),
    allowInsecureLoopback: true,
    sessionOptions
  });
  if (primary.mode === "openai" && primary.ready) {
    const openai = createOpenAiCompatibleGateway({
      baseUrl: primary.baseUrl,
      apiKey: primary.apiKey,
      gptApiKey: primary.gptApiKey,
      nexaApiKey: primary.nexaApiKey,
      nexaBaseUrl: primary.nexaBaseUrl,
      geminiApiKey: primary.geminiApiKey,
      geminiBaseUrl: primary.geminiBaseUrl,
      label: primary.label || "平价站第一模型源",
      preferredModel: primary.preferredModel || "claude-opus-5",
      allowedModels: primary.allowedModels || ["claude-opus-5","claude-sonnet-5","claude-opus-4-6","claude-opus-4-6-thinking","claude-opus-4-7","claude-opus-4-8","gemini-3.1-pro-preview","gemini-3.5-flash","glm-5.2","gpt-5.6-terra","gpt-5.6-luna","gpt-5-5","gpt-5","gpt-5-3","gpt-5-mini","seed-2.1-pro","seed-2.1-turbo","kimi-k2.6","qwen3.7-max","gpt-image-2"],
      modelCredits: primary.modelCredits,
      creditsPerCall: primary.creditsPerCall ?? 10,
      balance: primary.balance ?? -1,
      sessionOptions
    });
    const useHybrid = options.hybrid !== false && process.env.FICTION_DIRECTOR_HYBRID !== "0";
    if (!useHybrid) return openai;
    return createHybridGateway({
      primary: openai,
      secondary: legacy,
      label: "平价站第一 + Claude扩展",
      preferredModel: primary.preferredModel || "claude-opus-5",
      allowedModels: primary.allowedModels || ["claude-opus-5","claude-sonnet-5","claude-opus-4-6","claude-opus-4-6-thinking","claude-opus-4-7","claude-opus-4-8","gemini-3.1-pro-preview","gemini-3.5-flash","glm-5.2","gpt-5.6-terra","gpt-5.6-luna","gpt-5-5","gpt-5","gpt-5-3","gpt-5-mini","seed-2.1-pro","seed-2.1-turbo","kimi-k2.6","qwen3.7-max","gpt-image-2"],
      modelCredits: primary.modelCredits,
      creditsPerCall: Number(primary.creditsPerCall ?? 10),
      balance: Number(primary.balance ?? -1)
    });
  }
  const gatewayUrl = options.gatewayUrl || process.env.FICTION_DIRECTOR_GATEWAY_URL || primary.baseUrl;
  return createGatewayClient({
    ...(options.gatewayOptions || {}),
    ...(gatewayUrl ? { baseUrl: gatewayUrl } : {}),
    allowInsecureLoopback: true,
    sessionOptions
  });
}
function createQualityRuntime(options = {}) {
  const gateway = resolveGateway(options);
  const service = options.qualityGateService || createQualityGateService({
    gateway,
    bindingsPath: options.bindingsPath || process.env.FICTION_QUALITY_BINDINGS_PATH
  });
  let loginConsole = null;
  const openLoginPage = options.openLoginPage || (async () => {
    if (!loginConsole) loginConsole = createGatewayLoginConsole({ gateway, keepAlive: true, paymentPortalUrl: options.paymentPortalUrl || process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || DEFAULT_PAYMENT_PORTAL_URL });
    const page = await loginConsole.start();
    return {
      url: page.url,
      message: "请在内置浏览器打开此本地页面连接模型。平价站为第一模型源；页面会显示积分、可用模型并可测活。"
    };
  });
  return { gateway, service, tools: createQualityGateMcpTools({ service, openLoginPage }) };
}
function createRuntime(options = {}) {
  const { createFictionDirector } = require("./fiction-director-service");
  const { createFictionMcpTools } = require("./fiction-mcp-tools");
  const { createLocalConsole } = require("./local-console");
  const { createMarketResearch } = require("./market-research");
  const { createDownloadProvider } = require("./download-provider");
  const { createManagedDownloadProvider } = require("./managed-download-provider");
  const { createDeconstructionService } = require("./deconstruction-service");
  const { createAinovelGatewayBridge } = require("./ainovel-gateway-bridge");
  const { createAinovelEngine } = require("./ainovel-engine");
  const projectsRoot = path.resolve(options.projectsRoot || process.env.FICTION_DIRECTOR_PROJECTS_ROOT || path.join(os.homedir(), "FictionDirectorProjects"));
  const gateway = resolveGateway(options);
  const marketResearch = options.marketResearch || createMarketResearch();
  const deconstructionService = options.deconstructionService || createDeconstructionService({
    gateway: createDeconstructionGateway(gateway)
  });
  const downloaderUrl = options.downloaderUrl || process.env.FICTION_DIRECTOR_DOWNLOAD_PROVIDER_URL;
  const downloaderDataDir = options.downloaderDataDir || process.env.FICTION_DIRECTOR_DOWNLOAD_PROVIDER_DATA_DIR;
  if ((downloaderUrl && !downloaderDataDir) || (!downloaderUrl && downloaderDataDir)) {
    throw new Error("Authorized downloader configuration requires both URL and data directory.");
  }
  const downloadProvider = options.downloadProvider
    || (downloaderUrl
      ? createDownloadProvider({ baseUrl: downloaderUrl, dataDir: downloaderDataDir })
      : createManagedDownloadProvider({
        binaryPath: options.downloaderBinaryPath || process.env.FICTION_DIRECTOR_DOWNLOAD_BINARY_PATH,
        dataDir: options.managedDownloaderDataDir || process.env.FICTION_DIRECTOR_MANAGED_DOWNLOAD_DATA_DIR
      }));
  const director = options.director || createFictionDirector({
    projectsRoot,
    gateway,
    marketResearch,
    downloadProvider,
    deconstructionService,
    ledgerTransaction: options.ledgerTransaction
  });
  let ainovelBridge = options.ainovelBridge || null;
  let ainovel = options.ainovelEngine || null;
  if (!ainovel && typeof gateway.listModels === "function" && typeof gateway.proxyChatCompletions === "function") {
    ainovelBridge = ainovelBridge || createAinovelGatewayBridge({ gateway });
    ainovel = createAinovelEngine({ director, bridge: ainovelBridge, binaryPath: options.ainovelBinaryPath || process.env.AINOVEL_CLI_PATH });
  }
  let consoleServer = options.consoleServer || null;
  const paymentPortalUrl = options.paymentPortalUrl || process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || DEFAULT_PAYMENT_PORTAL_URL;
  const openWorkbench = async () => {
    if (!consoleServer) consoleServer = createLocalConsole({ director, gateway, ainovel, host: "127.0.0.1", paymentPortalUrl });
    return consoleServer.start();
  };
  async function createCliSession() {
    await openWorkbench();
    if (typeof consoleServer.createCliSession !== "function") throw new Error("CLI session support is unavailable.");
    return consoleServer.createCliSession();
  }
  async function stopWorkbench() { if (consoleServer && typeof consoleServer.stop === "function") await consoleServer.stop(); if (downloadProvider && typeof downloadProvider.stop === "function") await downloadProvider.stop(); }
  const services = Object.freeze({ marketResearch, deconstructionService, downloadProvider, ainovel });
  const openLoginPage = options.openLoginPage || (async () => {
    const loginConsole = createGatewayLoginConsole({ gateway, keepAlive: true, paymentPortalUrl });
    const page = await loginConsole.start();
    return { url: page.url, message: "请登录字字珠玑网关。首次安装强制弹出；成功后不乱弹，掉线再提醒。" };
  });
  const gatewayGuard = options.gatewayGuard || createGatewayGuard({ gateway, openLoginPage, paymentPortalUrl });
  return { director, gateway, ainovel, services, openWorkbench, createCliSession, stopWorkbench, openLoginPage, gatewayGuard, paymentPortalUrl, getLoginConsole: () => loginConsole, tools: createFictionMcpTools({ director, gateway, ainovel, openWorkbench, gatewayGuard, openLoginPage }) };
}
async function handle(message, dependencies = {}) {
  if (!message || typeof message !== "object") return error(null, -32600, "Invalid request");
  if (message.method === "initialize") {
    let access = null;
    try {
      const runtime = dependencies.gatewayGuard ? dependencies : createRuntime(dependencies);
      if (runtime.gatewayGuard && typeof runtime.gatewayGuard.ensureAccess === "function") {
        access = await runtime.gatewayGuard.ensureAccess({ reason: "initialize" });
      } else if (typeof onboardingState?.markInstalled === "function") {
        await onboardingState.markInstalled();
      }
    } catch (_) {}
    let onboarding = null;
    try { onboarding = await onboardingState.readState(); } catch {}
    return response(message.id ?? null, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: {
        name: "longform-fiction-director",
        version: "4.1.0-fusion.20",
        productRole: "auxiliary-editor-coach",
        onboarding: onboarding ? {
          pendingFirstLogin: !!onboarding.pendingFirstLogin,
          firstLoginCompletedAt: onboarding.firstLoginCompletedAt,
          shopUrl: onboarding.shopUrl
        } : null,
        gatewayAccess: access ? {
          ok: !!access.ok,
          loggedIn: !!access.loggedIn,
          popupOpened: !!access.popupOpened,
          browserOpened: !!access.browserOpened,
          reason: access.reason || null,
          loginUrl: access.loginUrl || null,
          shopUrl: access.shopUrl || null,
          message: access.message || null
        } : null
      }
    });
  }
  let tools;
  try { tools = dependencies.tools || createQualityRuntime(dependencies).tools; }
  catch (cause) { return error(message.id ?? null, -32603, safeMcpError(cause), safeMcpDiagnostics(cause)); }
  if (message.method === "tools/list") {
    try { return response(message.id ?? null, { tools: tools.list() }); }
    catch (cause) { return error(message.id ?? null, -32603, safeMcpError(cause), safeMcpDiagnostics(cause)); }
  }
  if (message.method === "tools/call") {
    if (typeof message.params?.name !== "string") return error(message.id ?? null, -32602, "Tool name is required");
    try { return response(message.id ?? null, await tools.call(message.params.name, message.params.arguments || {})); }
    catch (cause) { return error(message.id ?? null, cause?.code === "INVALID_ARGUMENT" ? -32602 : -32000, safeMcpError(cause), safeMcpDiagnostics(cause)); }
  }
  return error(message.id ?? null, -32601, "Method not found");
}
async function runStdio() {
  const runtime = createRuntime();
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) { if (!line.trim()) continue; try { process.stdout.write(`${JSON.stringify(await handle(JSON.parse(line), runtime))}\n`); } catch { process.stdout.write(`${JSON.stringify(error(null, -32700, "Invalid JSON"))}\n`); } }
}
if (require.main === module) runStdio().catch(() => { process.exitCode = 1; });
module.exports = { DEFAULT_PAYMENT_PORTAL_URL, createQualityRuntime, createRuntime, handle, runStdio, safeMcpError, safeMcpDiagnostics };
