"use strict";

const crypto = require("node:crypto");
const { createGatewayClient } = require("./gateway-client");
const { createProjectStore } = require("./project-store");
const { createProjectLedger } = require("./project-ledger");
const { createHumanizerRuleLibrary } = require("./humanizer-rule-library");
const { resolveHumanizerRules, matchHumanizerRules } = require("./humanizer-rule-resolver");

const HUMANIZER_MCP_TOOLS = Object.freeze([
  { name: "zizhuji_login", description: "登录已有字字珠玑账号；密码只用于登录，不会写入工具结果。", inputSchema: { type: "object", required: ["username", "password"], properties: { username: { type: "string" }, password: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_account_status", description: "读取当前账号状态、到期状态和积分信息。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "zizhuji_connection_status", description: "检查网关连接，不执行创作。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "zizhuji_list_models", description: "列出网关当前允许使用的模型目录。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "zizhuji_call_models", description: "按已验证模型目录调用模型，返回结果但不自动写入项目。", inputSchema: { type: "object", required: ["prompt", "modelIds"], properties: { prompt: { type: "string" }, system: { type: "string" }, modelIds: { type: "array", minItems: 1, items: { type: "string" } }, taskLabel: { type: "string" }, projectPath: { type: "string" }, contextRelativePaths: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
  { name: "zizhuji_register_project", description: "明确登记一个本机小说项目目录；登记前必须登录。", inputSchema: { type: "object", required: ["projectPath"], properties: { projectPath: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_list_projects", description: "列出已登记项目的 ID 和名称，不返回本机绝对路径。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "zizhuji_open_project", description: "打开已登记项目并读取项目元数据。", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_read_context", description: "一次读取已登记项目中的多个 Markdown/TXT 上下文文件。", inputSchema: { type: "object", required: ["projectId", "relativePaths"], properties: { projectId: { type: "string" }, relativePaths: { type: "array", minItems: 1, maxItems: 12, items: { type: "string" } } }, additionalProperties: false } },
  { name: "zizhuji_read_artifact", description: "读取已明确登记的小说项目中的 Markdown/TXT 文本。", inputSchema: { type: "object", required: ["projectPath", "relativePath"], properties: { projectPath: { type: "string" }, relativePath: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_write_artifact", description: "把检查后的文本写回已登记项目，自动保留版本快照。", inputSchema: { type: "object", required: ["projectPath", "relativePath", "content"], properties: { projectPath: { type: "string" }, relativePath: { type: "string" }, content: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_read_ledger", description: "读取项目唯一的创作台账及并发版本，不返回本机路径。", inputSchema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_save_ledger", description: "校验并保存完整创作台账；必须提交读取时获得的 ifMatch。", inputSchema: { type: "object", required: ["projectId", "ifMatch", "state"], properties: { projectId: { type: "string" }, ifMatch: { type: "string" }, state: { type: "object" } }, additionalProperties: false } },
  { name: "zizhuji_settle_chapter", description: "把结构化章节事实安全结算进创作台账；默认只接受紧接的下一章。", inputSchema: { type: "object", required: ["projectId", "ifMatch", "delta"], properties: { projectId: { type: "string" }, ifMatch: { type: "string" }, delta: { type: "object" }, repair: { type: "boolean" } }, additionalProperties: false } },
  { name: "zizhuji_commit_chapter", description: "在同一个项目事务中保存正文并结算创作台账；任一步失败都恢复到提交前。", inputSchema: { type: "object", required: ["projectId", "ifMatch", "relativePath", "content", "delta"], properties: { projectId: { type: "string" }, ifMatch: { type: "string" }, relativePath: { type: "string" }, content: { type: "string" }, delta: { type: "object" }, repair: { type: "boolean" } }, additionalProperties: false } },
  { name: "zizhuji_list_workflows", description: "列出当前账号可用的受控写作工作流。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "zizhuji_run_workflow", description: "运行一个受控写作工作流；模型与线路由服务器决定。", inputSchema: { type: "object", required: ["workflowId", "mode", "input"], properties: { workflowId: { type: "string" }, mode: { type: "string", enum: ["quick", "deep"] }, input: { type: "object" }, idempotencyKey: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_get_run", description: "查询已有工作流运行状态，不重复发起或扣分。", inputSchema: { type: "object", required: ["runId"], properties: { runId: { type: "string" } }, additionalProperties: false } },
  { name: "zizhuji_list_humanizer_rule_status", description: "读取规则 ID、版本、哈希、来源和启用状态，不返回社区展示原文。", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "zizhuji_save_humanizer_rule_draft", description: "保存私有去 AI 味规则草稿，不公开、不启用。", inputSchema: { type: "object", required: ["idempotencyKey", "draft"], properties: { idempotencyKey: { type: "string" }, draft: { type: "object" } }, additionalProperties: false } },
  { name: "zizhuji_check_ai_style", description: "读取指定章节并返回证据型去 AI 味 findings；社区说明文字不进入结果。", inputSchema: { type: "object", required: ["projectPath", "relativePath"], properties: { projectPath: { type: "string" }, relativePath: { type: "string" } }, additionalProperties: false } }
]);
const PUBLIC_MCP_TOOL_NAMES = new Set([
  "zizhuji_login",
  "zizhuji_account_status",
  "zizhuji_connection_status"
]);
const MCP_TOOL_NAMES = new Set(HUMANIZER_MCP_TOOLS.map((tool) => tool.name));

function textResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value };
}

function assertArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid tool arguments");
  for (const key of Reflect.ownKeys(args)) {
    const descriptor = Object.getOwnPropertyDescriptor(args, key);
    if (typeof key !== "string" || !descriptor || !("value" in descriptor)) throw new Error("Invalid tool arguments");
  }
  return args;
}

function assertKeys(args, allowed) {
  for (const key of Object.keys(args)) if (!allowed.has(key)) throw new Error("Invalid tool arguments");
}

function assertString(value, label, max = 200_000) {
  if (typeof value !== "string" || !value || value.length > max) throw new Error(`${label} is invalid`);
  return value;
}

function projectPathArgs(args) {
  assertKeys(args, new Set(["projectPath", "relativePath"]));
  return {
    projectPath: assertString(args.projectPath, "projectPath", 4_096),
    relativePath: assertString(args.relativePath, "relativePath", 512)
  };
}

function publicRuleStatus(library, effective) {
  const collections = Array.isArray(library?.collections) ? library.collections.map((item) => ({
    collectionId: item.collectionId,
    postId: item.postId,
    revision: item.revision,
    contentHash: item.contentHash,
    categoryId: item.categoryId,
    activation: item.activation,
    etag: item.etag,
    status: item.status
  })) : [];
  const rules = Array.isArray(effective?.rules) ? effective.rules.map((item) => ({
    ruleId: item.ruleId,
    postId: item.postId,
    revision: item.revision,
    contentHash: item.contentHash,
    categoryId: item.categoryId,
    status: item.status
  })) : [];
  return { library: { etag: library?.etag || null, collections }, effective: { version: effective?.version || 1, etag: effective?.etag || null, expiresAt: effective?.expiresAt || null, rules } };
}

function publicProject(project) {
  return { id: project?.id, name: project?.name };
}

function createHumanizerMcpHandler(options = {}) {
  const gateway = options.gateway || createGatewayClient(options.gatewayOptions);
  const projectStore = options.projectStore || createProjectStore(options.projectStoreOptions);
  const projectLedger = options.projectLedger || createProjectLedger({ projectStore });
  const ruleLibrary = options.ruleLibrary || createHumanizerRuleLibrary({ projectStore });
  const actions = options.actions || {};

  async function openProject(projectPath) {
    const registered = await projectStore.registerProject(assertString(projectPath, "projectPath", 4_096));
    return { registered, project: await projectStore.openProject(registered.id) };
  }

  const readArtifact = options.readArtifact || (async (args) => {
    const paths = projectPathArgs(args);
    const { registered, project } = await openProject(paths.projectPath);
    return { ok: true, projectId: registered.id, relativePath: paths.relativePath, text: await project.readText(paths.relativePath) };
  });
  const writeArtifact = options.writeArtifact || (async (args) => {
    assertKeys(args, new Set(["projectPath", "relativePath", "content"]));
    const paths = { projectPath: assertString(args.projectPath, "projectPath", 4_096), relativePath: assertString(args.relativePath, "relativePath", 512) };
    const content = typeof args.content === "string" ? args.content : (() => { throw new Error("content is invalid"); })();
    const { registered, project } = await openProject(paths.projectPath);
    const result = await project.writeText(paths.relativePath, content, { transactionId: `mcp-${crypto.randomUUID()}` });
    return { ok: true, projectId: registered.id, relativePath: result.relativePath, backedUp: Boolean(result.snapshotPath) };
  });
  const checkStyle = options.checkStyle || (async (args) => {
    const paths = projectPathArgs(args);
    const { registered, project } = await openProject(paths.projectPath);
    const text = await project.readText(paths.relativePath);
    const projectState = await ruleLibrary.read({ projectId: registered.id });
    const accountManifest = await gateway.getHumanizerEffectiveManifest();
    const resolved = resolveHumanizerRules({ builtinRules: [], accountManifest, projectState });
    return matchHumanizerRules({ text, resolvedRules: resolved });
  });

  async function requireAccount() {
    const status = await gateway.accountStatus();
    if (!status?.loggedIn) {
      const error = new Error("请先登录");
      error.code = "LOGIN_REQUIRED";
      throw error;
    }
    if (status.active === false || status.user?.active === false) {
      throw Object.assign(new Error("账号已停用或到期"), { code: "ACCOUNT_INACTIVE" });
    }
    if (status.user?.capabilities?.mcp === false) {
      throw Object.assign(new Error("账号未开通 MCP 权限"), { code: "MCP_NOT_ALLOWED" });
    }
    return status;
  }

  async function visibleTools() {
    try {
      await requireAccount();
      return HUMANIZER_MCP_TOOLS;
    } catch {
      return HUMANIZER_MCP_TOOLS.filter((tool) => PUBLIC_MCP_TOOL_NAMES.has(tool.name));
    }
  }

  async function callTool(name, rawArgs) {
    const args = assertArgs(rawArgs || {});
    if (MCP_TOOL_NAMES.has(name) && !PUBLIC_MCP_TOOL_NAMES.has(name)) await requireAccount();
    switch (name) {
      case "zizhuji_login":
        assertKeys(args, new Set(["username", "password"]));
        return gateway.login({ username: assertString(args.username, "username", 128), password: assertString(args.password, "password", 1_024) });
      case "zizhuji_account_status":
        assertKeys(args, new Set()); return gateway.accountStatus();
      case "zizhuji_connection_status":
        assertKeys(args, new Set()); return gateway.connectionStatus();
      case "zizhuji_list_models":
        assertKeys(args, new Set()); return gateway.listModels();
      case "zizhuji_call_models":
        assertKeys(args, new Set(["prompt", "system", "modelIds", "taskLabel", "projectPath", "contextRelativePaths"]));
        assertString(args.prompt, "prompt", 200_000);
        if (!Array.isArray(args.modelIds) || !args.modelIds.length || args.modelIds.some((id) => typeof id !== "string" || !id || id.length > 128)) throw new Error("modelIds is invalid");
        if (args.system !== undefined) assertString(args.system, "system", 100_000);
        return gateway.callModels(args);
      case "zizhuji_register_project": {
        assertKeys(args, new Set(["projectPath"]));
        await requireAccount();
        const project = await projectStore.registerProject(assertString(args.projectPath, "projectPath", 4_096));
        return { ok: true, project: publicProject(project) };
      }
      case "zizhuji_list_projects":
        assertKeys(args, new Set());
        await requireAccount();
        return { ok: true, projects: (await projectStore.listProjects()).map(publicProject) };
      case "zizhuji_open_project": {
        assertKeys(args, new Set(["projectId"]));
        await requireAccount();
        const project = await projectStore.openProject(assertString(args.projectId, "projectId", 160));
        return { ok: true, project: publicProject(project) };
      }
      case "zizhuji_read_context": {
        assertKeys(args, new Set(["projectId", "relativePaths"]));
        await requireAccount();
        const project = await projectStore.openProject(assertString(args.projectId, "projectId", 160));
        if (!Array.isArray(args.relativePaths) || args.relativePaths.length < 1 || args.relativePaths.length > 12) throw new Error("relativePaths is invalid");
        const artifacts = [];
        for (const relativePath of args.relativePaths) {
          const safePath = assertString(relativePath, "relativePath", 512);
          artifacts.push({ relativePath: safePath, text: await project.readText(safePath) });
        }
        return { ok: true, project: publicProject(project), artifacts };
      }
      case "zizhuji_read_artifact":
        return readArtifact(args);
      case "zizhuji_write_artifact":
        return writeArtifact(args);
      case "zizhuji_read_ledger":
        assertKeys(args, new Set(["projectId"]));
        return projectLedger.read({ projectId: assertString(args.projectId, "projectId", 160) });
      case "zizhuji_save_ledger":
        assertKeys(args, new Set(["projectId", "ifMatch", "state"]));
        if (!args.state || typeof args.state !== "object" || Array.isArray(args.state)) throw new Error("state is invalid");
        return projectLedger.save({
          projectId: assertString(args.projectId, "projectId", 160),
          ifMatch: assertString(args.ifMatch, "ifMatch", 256),
          state: args.state
        });
      case "zizhuji_settle_chapter":
        assertKeys(args, new Set(["projectId", "ifMatch", "delta", "repair"]));
        if (!args.delta || typeof args.delta !== "object" || Array.isArray(args.delta)) throw new Error("delta is invalid");
        if (args.repair !== undefined && typeof args.repair !== "boolean") throw new Error("repair is invalid");
        return projectLedger.settle({
          projectId: assertString(args.projectId, "projectId", 160),
          ifMatch: assertString(args.ifMatch, "ifMatch", 256),
          delta: args.delta,
          repair: args.repair === true
        });
      case "zizhuji_commit_chapter":
        assertKeys(args, new Set(["projectId", "ifMatch", "relativePath", "content", "delta", "repair"]));
        if (!args.delta || typeof args.delta !== "object" || Array.isArray(args.delta)) throw new Error("delta is invalid");
        if (args.repair !== undefined && typeof args.repair !== "boolean") throw new Error("repair is invalid");
        return projectLedger.commitChapter({
          projectId: assertString(args.projectId, "projectId", 160),
          ifMatch: assertString(args.ifMatch, "ifMatch", 256),
          relativePath: assertString(args.relativePath, "relativePath", 512),
          content: typeof args.content === "string" ? args.content : (() => { throw new Error("content is invalid"); })(),
          delta: args.delta,
          repair: args.repair === true
        });
      case "zizhuji_list_workflows":
        assertKeys(args, new Set());
        return gateway.listWorkflows();
      case "zizhuji_run_workflow":
        assertKeys(args, new Set(["workflowId", "mode", "input", "idempotencyKey"]));
        return gateway.runWorkflow(args);
      case "zizhuji_get_run":
        assertKeys(args, new Set(["runId"]));
        return gateway.getRun(args);
      case "zizhuji_list_humanizer_rule_status":
        assertKeys(args, new Set());
        return publicRuleStatus(await gateway.getHumanizerLibrary(), await gateway.getHumanizerEffectiveManifest());
      case "zizhuji_save_humanizer_rule_draft":
        assertKeys(args, new Set(["idempotencyKey", "draft"]));
        assertString(args.idempotencyKey, "idempotencyKey", 128);
        if (!args.draft || typeof args.draft !== "object" || Array.isArray(args.draft)) throw new Error("draft is invalid");
        return gateway.saveHumanizerRuleDraft({ idempotencyKey: args.idempotencyKey, draft: args.draft });
      case "zizhuji_check_ai_style":
        return checkStyle(args);
      default:
        const notFound = new Error("Tool not found");
        notFound.code = -32601;
        throw notFound;
    }
  }

  return async function handle(message) {
    const id = message?.id;
    try {
      if (message?.method === "initialize") {
        return { jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "zizhuji-writing-v3", version: "3.0.0-alpha.1" } } };
      }
      if (message?.method === "tools/list") return { jsonrpc: "2.0", id, result: { tools: await visibleTools() } };
      if (message?.method?.startsWith("notifications/")) return null;
      if (message?.method !== "tools/call") throw Object.assign(new Error("Method not found"), { code: -32601 });
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return { jsonrpc: "2.0", id, result: textResult(result) };
    } catch (error) {
      const code = Number.isInteger(error?.code) ? error.code : -32000;
      const messageText = code === -32601 ? "Tool not found" : (typeof error?.message === "string" ? error.message : "Request failed");
      return { jsonrpc: "2.0", id, error: { code, message: messageText } };
    }
  };
}

module.exports = { HUMANIZER_MCP_TOOLS, createHumanizerMcpHandler };
