"use strict";

const readline = require("node:readline");
const { createGatewayClient, DEFAULT_GATEWAY } = require("./gateway-client");
const { createGatewayLoginConsole } = require("./gateway-login-console");
const { createGatewayGuard } = require("./gateway-guard");
const { createGatewayMcpTools } = require("./gateway-mcp-tools");
const { createLocalCoreTools } = require("./local-core-tools");
const { createRankingMcpTools } = require("./ranking-mcp-tools");
const { createDownloadMcpTools } = require("./download-mcp-tools");
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
    RATE_LIMITED: "模型线路暂时限流；未收到正文时已有限重试一次，请稍后再试。",
    EMPTY_MODEL_OUTPUT: "模型返回为空，请换模型或重试。",
    HARD_GATE_FAILED: "候选未通过硬门禁，请检查 blockers 后重写。"
    , AUTHOR_CONFIRMATION_REQUIRED: "本次模型调用尚未获得作者确认。请先询问作者是否使用这个模型。",
    JOB_NOT_FOUND: "后台任务不存在，可能来自已重启的插件进程。请先查看 Codex候选 是否已有结果。"
    , SOURCE_UNAVAILABLE: "公开榜单当前无法读取，请稍后再试或用内置浏览器核验。"
    , SOURCE_TIMEOUT: "公开榜单读取超时，请稍后再试。"
    , SOURCE_FORMAT_CHANGED: "公开榜单页面结构已经变化，扫描器没有伪造结果；需要更新适配。"
    , SOURCE_RESPONSE_TOO_LARGE: "公开榜单响应异常过大，已停止读取。"
    , SOURCE_NOT_AUTHORIZED: "下载前需要你明确确认：你拥有该书、作品属于公版，或你已获得下载许可。"
    , DOWNLOAD_BINARY_MISSING: "内置番茄下载器缺失，请重新安装完整插件。"
    , DOWNLOAD_BINARY_INVALID: "内置番茄下载器文件无效，请重新安装完整插件。"
    , DOWNLOAD_START_TIMEOUT: "内置番茄下载器启动超时。"
    , DOWNLOAD_START_FAILED: "内置番茄下载器启动失败。"
    , BOOK_NOT_FOUND: "没有找到这本书，请核对书名或改用番茄 bookId。"
    , BOOK_SELECTION_REQUIRED: "书名搜索结果不唯一，请改用番茄 bookId。"
    , PROVIDER_REQUEST_FAILED: "本机番茄下载服务请求失败。"
    , PROVIDER_HTTP_ERROR: "本机番茄下载服务返回错误。"
    , PROVIDER_JOB_FAILED: "番茄下载任务失败。"
    , PROVIDER_JOB_TIMEOUT: "番茄下载任务等待超时。"
    , DOWNLOAD_RESULT_INVALID: "番茄下载结果路径无效，已停止导入。"
  };
  if (cause?.code === "SERVER_ERROR" && SAFE_GATEWAY_DIAGNOSTICS.has(cause?.publicMessage)) return cause.publicMessage;
  return messages[cause?.code] || "Tool call failed.";
}
function resolveGateway(options = {}) {
  if (options.gateway) return options.gateway;
  const sessionOptions = options.sessionOptions || options.gatewayOptions?.sessionOptions;
  const gatewayUrl = options.gatewayUrl || DEFAULT_GATEWAY;
  return createGatewayClient({
    ...(options.gatewayOptions || {}),
    baseUrl: gatewayUrl,
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
    const rankingTools = options.rankingTools || createRankingMcpTools(options.rankingOptions || {});
    const downloadTools = options.downloadTools || createDownloadMcpTools(options.downloadOptions || {});
    return Object.freeze({
      list: () => [...gatewayTools.list(), ...localTools.list(), ...rankingTools.list(), ...downloadTools.list()],
      call: (name, input) => {
        if (localTools.has(name)) return localTools.call(name, input);
        if (rankingTools.has(name)) return rankingTools.call(name, input);
        if (downloadTools.has(name)) return downloadTools.call(name, input);
        return gatewayTools.call(name, input);
      },
      close: () => downloadTools.close()
    });
  })();
  return {
    gateway,
    gatewayGuard,
    openLoginPage,
    paymentPortalUrl,
    getLoginConsole: () => loginConsole,
    tools,
    close: async () => {
      if (typeof tools.close === "function") await tools.close();
      if (loginConsole && typeof loginConsole.stop === "function") await loginConsole.stop();
    }
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
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      try {
        const reply = await handle(JSON.parse(line), runtime);
        if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
      } catch {
        process.stdout.write(`${JSON.stringify(error(null, -32700, "Invalid JSON"))}\n`);
      }
    }
  } finally {
    await runtime.close();
  }
}
if (require.main === module) runStdio().catch(() => { process.exitCode = 1; });
module.exports = { DEFAULT_PAYMENT_PORTAL_URL, createRuntime, resolveGateway, handle, runStdio, safeMcpError, safeMcpDiagnostics };
