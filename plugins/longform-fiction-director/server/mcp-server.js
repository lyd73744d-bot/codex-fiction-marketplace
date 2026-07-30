"use strict";

const readline = require("node:readline");
const { createGatewayClient } = require("./gateway-client");
const { loadPrimaryGatewayConfig } = require("./gateway-config");
const { createOpenAiCompatibleGateway } = require("./openai-compatible-gateway");
const { createHybridGateway } = require("./hybrid-gateway");
const { createGatewayLoginConsole } = require("./gateway-login-console");
const { createGatewayGuard } = require("./gateway-guard");
const { createGatewayMcpTools } = require("./gateway-mcp-tools");
const { createLocalCoreTools } = require("./local-core-tools");
const onboardingState = require("./onboarding-state");
const packageInfo = require("../package.json");

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
function safeMcpDiagnostics(cause) {
  const attempts = Array.isArray(cause?.fallbackAttempts) ? cause.fallbackAttempts.slice(-12).map((item) => ({ modelId: item?.modelId || null, errorCode: item?.errorCode || null, errorMessage: String(item?.errorMessage || "").slice(0, 300) })) : [];
  return { code: cause?.code || cause?.name || "TOOL_FAILED", status: Number.isInteger(cause?.status) ? cause.status : null, requestId: cause?.requestId || null, transport: cause?.transport || null, attempts, recoverable: attempts.length > 0 };
}
function safeMcpError(cause) {
  if (cause?.code === "AUTH_REQUIRED" && cause?.access?.popupOpened) {
    return "登录页已按本次授权打开一次。请完成登录后重试本次模型调用，不要再次打开登录页。";
  }
  if (cause?.code === "AUTH_REQUIRED" && /cooldown/i.test(String(cause?.access?.reason || ""))) {
    return "登录页刚刚已经打开，请完成登录后重试本次模型调用；不会重复弹窗。";
  }
  const messages = {
    AUTH_REQUIRED: "请先登录网关（fiction_open_gateway_login）。不登录也可用 fiction_write_local_candidate 写本地候选。",
    AUTH_FAILED: "账号或密码不正确。",
    INVALID_ARGUMENT: "Tool arguments are invalid.",
    TOOL_NOT_FOUND: "Tool not found.",
    INSUFFICIENT_BALANCE: "Insufficient balance.",
    GATEWAY_REQUIRED: "Model gateway is unavailable.",
    GATEWAY_UNAVAILABLE: "Model gateway is unavailable.",
    SERVER_OFFLINE: "网关不在线或无法访问。",
    UPSTREAM_TIMEOUT: "模型生成超时，本次没有完成。请稍后重试或换一个模型。",
    EMPTY_MODEL_OUTPUT: "模型返回为空，请换模型或重试。",
    HARD_GATE_FAILED: "候选未通过硬门禁，请检查 blockers 后重写。"
    , AUTHOR_CONFIRMATION_REQUIRED: "本次模型调用尚未获得作者确认。请先询问作者是否使用这个模型。",
    JOB_NOT_FOUND: "后台任务不存在，可能来自已重启的插件进程。请先查看 Codex候选 是否已有结果。"
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
      allowedModels: primary.allowedModels,
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
      allowedModels: primary.allowedModels,
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
function createRuntime(options = {}) {
  const gateway = resolveGateway(options);
  const paymentPortalUrl = options.paymentPortalUrl || process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || DEFAULT_PAYMENT_PORTAL_URL;
  let loginConsole = null;
  const openLoginPage = options.openLoginPage || (async () => {
    if (!loginConsole) loginConsole = createGatewayLoginConsole({ gateway, keepAlive: true, paymentPortalUrl });
    const page = await loginConsole.start();
    return { url: page.url, message: "已按用户请求打开可选的字字珠玑网关登录页。普通写作无需注册。" };
  });
  const gatewayGuard = options.gatewayGuard || createGatewayGuard({ gateway, openLoginPage, paymentPortalUrl });
  const tools = options.tools || (() => {
    const gatewayTools = createGatewayMcpTools({ gateway, gatewayGuard, openLoginPage });
    const localTools = options.localTools || createLocalCoreTools(options.localCoreOptions || {});
    return Object.freeze({
      list: () => [...gatewayTools.list(), ...localTools.list()],
      call: (name, input) => localTools.has(name)
        ? localTools.call(name, input)
        : gatewayTools.call(name, input)
    });
  })();
  return {
    gateway,
    gatewayGuard,
    openLoginPage,
    paymentPortalUrl,
    getLoginConsole: () => loginConsole,
    tools
  };
}
async function handle(message, dependencies = {}) {
  if (!message || typeof message !== "object") return error(null, -32600, "Invalid request");
  if (typeof message.method === "string" && message.method.startsWith("notifications/")) return null;
  if (message.method === "initialize") {
    let access = null;
    try {
      const runtime = dependencies.gatewayGuard ? dependencies : createRuntime(dependencies);
      if (runtime.gatewayGuard && typeof runtime.gatewayGuard.ensureAccess === "function") {
        access = await runtime.gatewayGuard.ensureAccess({
          reason: "initialize",
          allowPopup: false,
          explicitUserChoice: false
        });
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
        version: packageInfo.version,
        productRole: "lead-editor-with-local-core-and-model-gateway",
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
  try { tools = dependencies.tools || createRuntime(dependencies).tools; }
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
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const reply = await handle(JSON.parse(line), runtime);
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    } catch {
      process.stdout.write(`${JSON.stringify(error(null, -32700, "Invalid JSON"))}\n`);
    }
  }
}
if (require.main === module) runStdio().catch(() => { process.exitCode = 1; });
module.exports = { DEFAULT_PAYMENT_PORTAL_URL, createRuntime, resolveGateway, handle, runStdio, safeMcpError, safeMcpDiagnostics };
