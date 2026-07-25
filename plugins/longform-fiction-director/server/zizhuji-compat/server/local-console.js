"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createLocalSessionStore } = require("./local-session");
const { createProjectStore } = require("./project-store");
const { createProjectLedger } = require("./project-ledger");
const { createHumanizerRuleLibrary } = require("./humanizer-rule-library");

const SESSION_COOKIE = "zzj_local_session";
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const SETTLEMENT_OUTPUT_CONSTRAINTS = [
  "zizhuji-ledger-delta-v1：只输出一个 JSON 对象，不要 Markdown、解释或整份台账。",
  "必填：chapter(正整数)、summary。可填：title、current、characters、hooks、changes。",
  "current 仅可含 location、goal、conflict、constraints。",
  "characters 每项仅可含 id、name、role、appeared、current、knowledgeAdd、relationships、timeline；",
  "人物 current 仅含 location/status；relationships 每项含 targetId 或 targetName 及 relation；timeline 每项含 event/change。",
  "hooks 每项仅含 id、title、status(open/progressing/deferred/resolved)、payoff、notes。",
  "只记录正文已经发生或明确确认的事实，不猜测，不覆盖未涉及字段。"
].join("\n");

function json(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(body);
}

function parseCookie(header) {
  const result = Object.create(null);
  for (const item of String(header || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim());
  }
  return result;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks, size).toString("utf8");
  if (!text) return Object.create(null);
  let value;
  try { value = JSON.parse(text); } catch { throw Object.assign(new Error("invalid JSON"), { statusCode: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("invalid JSON object"), { statusCode: 400 });
  return value;
}

function createLocalConsole(options = {}) {
  const gateway = options.gateway;
  if (!gateway || typeof gateway.login !== "function" || typeof gateway.connectionStatus !== "function") {
    throw new TypeError("gateway with login and connectionStatus is required");
  }
  const webRoot = path.resolve(options.webRoot || path.join(__dirname, "../web"));
  const assetsRoot = path.resolve(options.assetsRoot || path.join(__dirname, "../assets"));
  const host = options.host || "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") throw new Error("local console must bind to loopback");
  const sessionStore = options.sessionStore || createLocalSessionStore();
  const projectStore = options.projectStore || createProjectStore(options.projectStoreOptions);
  const projectLedger = options.projectLedger || createProjectLedger({ projectStore });
  const ruleLibrary = options.ruleLibrary || createHumanizerRuleLibrary({ projectStore });
  const workflowSettlements = new Map();
  let server = null;

  async function prepareProjectWorkflow(workflowId, input) {
    if (!input.projectId || !["facts.observe", "state.settle"].includes(workflowId)) {
      return { workflowInput: input.input, ledger: null };
    }
    if (typeof input.projectId !== "string") throw Object.assign(new Error("项目编号无效"), { code: "INVALID_PROJECT" });
    const ledger = await projectLedger.read({ projectId: input.projectId });
    const workflowInput = input.input;
    if (!workflowInput || typeof workflowInput !== "object" || Array.isArray(workflowInput)) {
      throw Object.assign(new Error("工作流输入无效"), { code: "INVALID_WORKFLOW_INPUT" });
    }
    const context = Array.isArray(workflowInput.context) ? [...workflowInput.context] : [];
    context.push({ name: "项目资料/创作台账.json", content: JSON.stringify(ledger.state) });
    const workflowOptions = workflowInput.options && typeof workflowInput.options === "object" && !Array.isArray(workflowInput.options)
      ? { ...workflowInput.options }
      : {};
    if (workflowId === "state.settle") {
      const existing = typeof workflowOptions.constraints === "string" ? workflowOptions.constraints.trim() : "";
      workflowOptions.constraints = [existing.slice(0, 500), SETTLEMENT_OUTPUT_CONSTRAINTS].filter(Boolean).join("\n");
    }
    return { workflowInput: { ...workflowInput, context, options: workflowOptions }, ledger };
  }

  async function finishTrackedSettlement(run, tracked) {
    if (tracked.result) return { ...run, settlement: tracked.result };
    if (!tracked.promise) {
      tracked.promise = projectLedger.settle({
        projectId: tracked.projectId,
        ifMatch: tracked.ifMatch,
        output: run.output,
        repair: tracked.repair
      }).then((saved) => {
        tracked.result = {
          status: "saved",
          chapter: saved.state.book.currentChapter,
          revision: saved.state.revision,
          etag: saved.etag
        };
        return tracked.result;
      }).catch((error) => {
        tracked.result = {
          status: "failed",
          error: { code: error.code || "SETTLEMENT_FAILED", message: error.message || "章节结算失败" }
        };
        return tracked.result;
      });
    }
    const settlement = await tracked.promise;
    if (settlement.status === "failed") {
      return { ...run, status: "failed", error: settlement.error, settlement };
    }
    return { ...run, settlement };
  }

  function requestOrigin(req) {
    const value = req.headers.origin;
    if (value) return value;
    const hostHeader = req.headers.host;
    return hostHeader ? `http://${hostHeader}` : null;
  }

  function sameOrigin(req) {
    const origin = requestOrigin(req);
    const hostHeader = req.headers.host;
    return origin === `http://${hostHeader}`;
  }

  function currentSession(req) {
    return sessionStore.read(parseCookie(req.headers.cookie)[SESSION_COOKIE]);
  }

  function requireSession(req, res) {
    const session = currentSession(req);
    if (!session) {
      json(res, 401, { error: { code: "UNAUTHORIZED", message: "请先登录" } });
      return null;
    }
    return session;
  }

  function requireMutation(req, res) {
    if (!sameOrigin(req)) {
      json(res, 403, { error: { code: "ORIGIN_FORBIDDEN", message: "本地来源校验失败" } });
      return null;
    }
    return requireSession(req, res);
  }

  function publicProject(project) {
    return { id: project?.id, name: project?.name };
  }

  function apiFailure(res, error, fallbackMessage = "请求失败") {
    const code = typeof error?.code === "string" ? error.code : "REQUEST_FAILED";
    const status = error?.statusCode
      || (/UNAUTHORIZED|LOGIN_REQUIRED|SESSION_EXPIRED/u.test(code) ? 401
        : code === "NOT_FOUND" ? 404
          : /ETAG|PROJECT_CHANGED/u.test(code) ? 409
            : /INVALID|NOT_EXECUTABLE/u.test(code) ? 400
              : 502);
    json(res, status, { error: { code, message: error?.message || fallbackMessage } });
  }

  function collectionIdFrom(pathname, suffix = "") {
    const pattern = suffix === "/activation"
      ? /^\/api\/local\/humanizer\/collections\/([^/]+)\/activation$/u
      : /^\/api\/local\/humanizer\/collections\/([^/]+)$/u;
    const match = pathname.match(pattern);
    if (!match) return null;
    try { return decodeURIComponent(match[1]); } catch { return null; }
  }

  async function projectRuleState(projectId) {
    if (!projectId) return null;
    return ruleLibrary.read({ projectId });
  }

  async function saveProjectActivation({ collection, projectId, enabled }) {
    if (!collection || typeof collection !== "object") throw Object.assign(new Error("收藏不存在"), { code: "NOT_FOUND" });
    if (enabled && !collection.detector) throw Object.assign(new Error("学习条目不能启用"), { code: "NOT_EXECUTABLE" });
    const current = await ruleLibrary.read({ projectId });
    const projectRules = current.projectRules.filter((item) => item.ruleId !== collection.postId);
    const disabledRuleIds = current.disabledRuleIds.filter((ruleId) => ruleId !== collection.postId);
    if (enabled) {
      projectRules.push({
        ruleId: collection.postId,
        revision: collection.revision,
        contentHash: collection.contentHash,
        categoryId: collection.categoryId,
        detector: collection.detector,
        enabled: true,
        status: collection.status || "published"
      });
    } else {
      disabledRuleIds.push(collection.postId);
    }
    return ruleLibrary.save({ projectId, ifMatch: current.etag, projectRules, disabledRuleIds });
  }

  async function ruleStatus(projectId) {
    const [library, effective, project] = await Promise.all([
      typeof gateway.getHumanizerLibrary === "function" ? gateway.getHumanizerLibrary() : { collections: [] },
      typeof gateway.getHumanizerEffectiveManifest === "function" ? gateway.getHumanizerEffectiveManifest() : { version: 1, rules: [] },
      projectRuleState(projectId)
    ]);
    return {
      library: { etag: library?.etag || null, collections: Array.isArray(library?.collections) ? library.collections : [] },
      effective: { version: effective?.version || 1, etag: effective?.etag || null, expiresAt: effective?.expiresAt || null, rules: Array.isArray(effective?.rules) ? effective.rules : [] },
      project
    };
  }

  function packagedFile(pathname) {
    let decoded;
    try { decoded = decodeURIComponent(pathname); } catch { return null; }
    if (decoded.includes("\\") || decoded.includes("\0") || decoded.split("/").includes("..")) return null;
    let root;
    let relative;
    if (decoded.startsWith("/assets/")) {
      root = assetsRoot;
      relative = decoded.slice("/assets/".length);
    } else if (decoded.startsWith("/components/")) {
      root = path.join(webRoot, "components");
      relative = decoded.slice("/components/".length);
    } else if (/^\/[A-Za-z0-9._-]+\.(?:css|js|html)$/.test(decoded)) {
      root = webRoot;
      relative = decoded.slice(1);
    } else {
      return null;
    }
    if (!relative || relative.includes("/") || !/^[A-Za-z0-9._-]+$/.test(relative)) return null;
    const extension = path.extname(relative).toLowerCase();
    const contentType = {
      ".css": "text/css; charset=utf-8",
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp"
    }[extension];
    if (!contentType) return null;
    return { path: path.join(root, relative), contentType };
  }

  async function servePackagedFile(req, res, pathname) {
    if (req.method !== "GET") return false;
    const file = packagedFile(pathname);
    if (!file) return false;
    try {
      const content = await fs.promises.readFile(file.path);
      res.writeHead(200, {
        "content-type": file.contentType,
        "cache-control": file.contentType.startsWith("image/") ? "public, max-age=86400" : "no-store",
        "x-content-type-options": "nosniff"
      });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not Found");
    }
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "cache-control": "no-store" });
      res.end();
      return;
    }
    if (url.pathname === "/api/local/state" && req.method === "GET") {
      const session = currentSession(req);
      const connection = await gateway.connectionStatus();
      if (!session) {
        json(res, 200, { loggedIn: false, canReadProjects: false, canUseHumanizer: false, connection });
        return;
      }
      const account = typeof gateway.accountStatus === "function" ? await gateway.accountStatus() : { ok: true, loggedIn: true };
      json(res, 200, { loggedIn: true, canReadProjects: true, canUseHumanizer: true, user: account.user || { username: session.username }, account, connection });
      return;
    }
    if (url.pathname === "/api/local/login" && req.method === "POST") {
      if (!sameOrigin(req)) { json(res, 403, { error: { code: "ORIGIN_FORBIDDEN", message: "本地来源校验失败" } }); return; }
      try {
        const input = await readJson(req);
        const result = await gateway.login({ username: input.username, password: input.password });
        const user = result?.user || {};
        const username = typeof user.username === "string" ? user.username : String(input.username || "");
        const issued = sessionStore.issue({ subject: username, username });
        json(res, 200, { ok: true, user: { username }, expiresAt: issued.expiresAt }, {
          "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(issued.token)}; HttpOnly; SameSite=Lax; Path=/`
        });
      } catch (error) {
        json(res, error.statusCode || 401, { error: { code: error.code || "AUTH_FAILED", message: error.message || "登录失败" } });
      }
      return;
    }
    if (url.pathname === "/api/local/register" && req.method === "POST") {
      if (!sameOrigin(req)) { json(res, 403, { error: { code: "ORIGIN_FORBIDDEN", message: "Local origin verification failed." } }); return; }
      try {
        if (typeof gateway.register !== "function") throw Object.assign(new Error("Registration is unavailable."), { code: "REGISTRATION_UNAVAILABLE" });
        const input = await readJson(req);
        const result = await gateway.register({ username: input.username, password: input.password, inviteCode: input.inviteCode });
        const user = result?.user || {};
        const username = typeof user.username === "string" ? user.username : String(input.username || "");
        const issued = sessionStore.issue({ subject: username, username });
        json(res, 200, { ok: true, user: { username }, expiresAt: issued.expiresAt }, {
          "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(issued.token)}; HttpOnly; SameSite=Lax; Path=/`
        });
      } catch (error) {
        json(res, error.statusCode || 400, { error: { code: error.code || "REGISTRATION_FAILED", message: error.message || "Registration failed." } });
      }
      return;
    }
    if (url.pathname === "/api/local/logout" && req.method === "POST") {
      if (!sameOrigin(req)) { json(res, 403, { error: { code: "ORIGIN_FORBIDDEN", message: "本地来源校验失败" } }); return; }
      sessionStore.revoke(parseCookie(req.headers.cookie)[SESSION_COOKIE]);
      json(res, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/` });
      return;
    }
    if (url.pathname === "/api/local/rule-status" && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try { json(res, 200, await ruleStatus(url.searchParams.get("projectId"))); } catch (error) { apiFailure(res, error, "规则库暂时不可用"); }
      return;
    }
    if (url.pathname === "/api/local/models" && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try { json(res, 200, await gateway.listModels()); } catch (error) { apiFailure(res, error, "模型列表暂时不可用"); }
      return;
    }
    if (url.pathname === "/api/local/models/call" && req.method === "POST") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        json(res, 200, await gateway.callModels({
          prompt: input.prompt,
          system: input.system,
          modelIds: input.modelIds,
          taskLabel: input.taskLabel
        }));
      } catch (error) { apiFailure(res, error, "模型处理失败"); }
      return;
    }
    if (url.pathname === "/api/local/workflows" && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try { json(res, 200, await gateway.listWorkflows()); } catch (error) { apiFailure(res, error, "工作流列表暂时不可用"); }
      return;
    }
    const workflowRunMatch = url.pathname.match(/^\/api\/local\/workflows\/([^/]+)\/runs$/u);
    if (workflowRunMatch && req.method === "POST") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        const workflowId = decodeURIComponent(workflowRunMatch[1]);
        const prepared = await prepareProjectWorkflow(workflowId, input);
        const run = await gateway.runWorkflow({
          workflowId,
          idempotencyKey: input.idempotencyKey,
          mode: input.mode,
          input: prepared.workflowInput
        });
        if (workflowId === "state.settle" && prepared.ledger) {
          workflowSettlements.set(run.runId, {
            projectId: input.projectId,
            ifMatch: prepared.ledger.etag,
            repair: input.repair === true,
            promise: null,
            result: null
          });
        }
        json(res, 200, run);
      } catch (error) { apiFailure(res, error, "工作流启动失败"); }
      return;
    }
    const runMatch = url.pathname.match(/^\/api\/local\/runs\/([^/]+)$/u);
    if (runMatch && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try {
        const runId = decodeURIComponent(runMatch[1]);
        let run = await gateway.getRun({ runId });
        const tracked = workflowSettlements.get(runId);
        if (tracked && run.status === "completed") run = await finishTrackedSettlement(run, tracked);
        json(res, 200, run);
      } catch (error) { apiFailure(res, error, "任务状态暂时不可用"); }
      return;
    }
    if (url.pathname === "/api/local/projects" && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try { json(res, 200, { projects: (await projectStore.listProjects()).map(publicProject) }); } catch (error) { apiFailure(res, error, "项目列表暂时不可用"); }
      return;
    }
    if (url.pathname === "/api/local/projects/select" && req.method === "POST") {
      if (!requireMutation(req, res)) return;
      try {
        if (typeof options.selectProjectDirectory !== "function") throw Object.assign(new Error("当前环境不能选择文件夹"), { code: "NOT_AVAILABLE" });
        const selectedPath = await options.selectProjectDirectory();
        if (!selectedPath) { json(res, 200, { cancelled: true }); return; }
        json(res, 200, { cancelled: false, project: publicProject(await projectStore.registerProject(selectedPath)) });
      } catch (error) { apiFailure(res, error, "项目打开失败"); }
      return;
    }
    const projectSettlementMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/ledger\/settlements$/u);
    if (projectSettlementMatch && req.method === "POST") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        json(res, 200, await projectLedger.settle({
          projectId: decodeURIComponent(projectSettlementMatch[1]),
          ifMatch: input.ifMatch,
          output: input.output,
          delta: input.delta,
          repair: input.repair === true
        }));
      } catch (error) { apiFailure(res, error, "章节结算失败"); }
      return;
    }
    const projectLedgerMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/ledger$/u);
    if (projectLedgerMatch && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try { json(res, 200, await projectLedger.read({ projectId: decodeURIComponent(projectLedgerMatch[1]) })); } catch (error) { apiFailure(res, error, "创作台账读取失败"); }
      return;
    }
    if (projectLedgerMatch && req.method === "PUT") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        json(res, 200, await projectLedger.save({ projectId: decodeURIComponent(projectLedgerMatch[1]), ifMatch: input.ifMatch, state: input.state }));
      } catch (error) { apiFailure(res, error, "创作台账保存失败"); }
      return;
    }
    const projectArtifactsMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/artifacts$/u);
    if (projectArtifactsMatch && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try {
        const project = await projectStore.openProject(decodeURIComponent(projectArtifactsMatch[1]));
        json(res, 200, { artifacts: await project.listArtifacts() });
      } catch (error) { apiFailure(res, error, "项目文件列表暂时不可用"); }
      return;
    }
    const projectArtifactMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/artifact$/u);
    if (projectArtifactMatch && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try {
        const relativePath = url.searchParams.get("path");
        const project = await projectStore.openProject(decodeURIComponent(projectArtifactMatch[1]));
        json(res, 200, { artifact: { relativePath }, content: await project.readText(relativePath) });
      } catch (error) { apiFailure(res, error, "项目文件读取失败"); }
      return;
    }
    if (projectArtifactMatch && req.method === "PUT") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        const project = await projectStore.openProject(decodeURIComponent(projectArtifactMatch[1]));
        const result = await project.writeText(input.relativePath, input.content, {
          transactionId: `web-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`
        });
        json(res, 200, { artifact: { relativePath: result.relativePath, bytes: result.bytes, transactionId: result.transactionId, versioned: Boolean(result.snapshotPath) } });
      } catch (error) { apiFailure(res, error, "项目文件保存失败"); }
      return;
    }
    if (url.pathname.startsWith("/api/local/projects/") && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try {
        const projectId = decodeURIComponent(url.pathname.slice("/api/local/projects/".length));
        json(res, 200, { project: publicProject(await projectStore.openProject(projectId)) });
      } catch (error) { apiFailure(res, error, "项目不可用"); }
      return;
    }
    if (url.pathname === "/api/local/humanizer/square" && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try {
        const rawLimit = url.searchParams.get("limit");
        const input = { limit: rawLimit === null ? 20 : Number(rawLimit) };
        const cursor = url.searchParams.get("cursor");
        if (cursor) input.cursor = cursor;
        json(res, 200, await gateway.listHumanizerPosts(input));
      } catch (error) { apiFailure(res, error, "规则广场暂时不可用"); }
      return;
    }
    if (url.pathname.startsWith("/api/local/humanizer/square/") && req.method === "GET") {
      if (!requireSession(req, res)) return;
      try {
        const postId = decodeURIComponent(url.pathname.slice("/api/local/humanizer/square/".length));
        json(res, 200, await gateway.getHumanizerPost({ postId }));
      } catch (error) { apiFailure(res, error, "规则详情暂时不可用"); }
      return;
    }
    if (url.pathname === "/api/local/humanizer/drafts" && req.method === "POST") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        json(res, 200, await gateway.saveHumanizerRuleDraft({ idempotencyKey: input.idempotencyKey, draft: input.draft }));
      } catch (error) { apiFailure(res, error, "草稿保存失败"); }
      return;
    }
    if (url.pathname === "/api/local/humanizer/collections" && req.method === "POST") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        json(res, 200, await gateway.collectHumanizerRevision({ postId: input.postId, revision: input.revision, idempotencyKey: input.idempotencyKey }));
      } catch (error) { apiFailure(res, error, "收藏失败"); }
      return;
    }
    const activationCollectionId = collectionIdFrom(url.pathname, "/activation");
    if (activationCollectionId && req.method === "PUT") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        if (input.scope === "account") {
          json(res, 200, await gateway.setHumanizerActivation({ collectionId: activationCollectionId, ifMatch: input.ifMatch, enabled: input.enabled }));
        } else if (input.scope === "project" && typeof input.projectId === "string" && input.projectId) {
          const library = await gateway.getHumanizerLibrary();
          const collection = (library?.collections || []).find((item) => item.collectionId === activationCollectionId);
          if (!collection || collection.etag !== input.ifMatch) throw Object.assign(new Error("收藏状态已经变化，请刷新"), { code: collection ? "ETAG_MISMATCH" : "NOT_FOUND" });
          const state = await saveProjectActivation({ collection, projectId: input.projectId, enabled: input.enabled === true });
          json(res, 200, { scope: "project", enabled: input.enabled === true, projectId: input.projectId, etag: state.etag });
        } else {
          throw Object.assign(new Error("请选择启用范围"), { code: "INVALID_ACTIVATION" });
        }
      } catch (error) { apiFailure(res, error, "启用状态保存失败"); }
      return;
    }
    const deleteCollectionId = collectionIdFrom(url.pathname);
    if (deleteCollectionId && req.method === "DELETE") {
      if (!requireMutation(req, res)) return;
      try {
        const input = await readJson(req);
        const library = await gateway.getHumanizerLibrary();
        const collection = (library?.collections || []).find((item) => item.collectionId === deleteCollectionId);
        if (!collection || collection.etag !== input.ifMatch) throw Object.assign(new Error("收藏状态已经变化，请刷新"), { code: collection ? "ETAG_MISMATCH" : "NOT_FOUND" });
        let ifMatch = collection.etag;
        if (collection.activation?.scope === "account") {
          const disabled = await gateway.setHumanizerActivation({ collectionId: deleteCollectionId, ifMatch, enabled: false });
          ifMatch = disabled.etag;
        }
        if (typeof input.projectId === "string" && input.projectId) {
          const current = await ruleLibrary.read({ projectId: input.projectId });
          await ruleLibrary.save({
            projectId: input.projectId,
            ifMatch: current.etag,
            projectRules: current.projectRules.filter((item) => item.ruleId !== collection.postId),
            disabledRuleIds: current.disabledRuleIds.filter((ruleId) => ruleId !== collection.postId)
          });
        }
        json(res, 200, await gateway.uncollectHumanizerRule({ collectionId: deleteCollectionId, ifMatch }));
      } catch (error) { apiFailure(res, error, "取消收藏失败"); }
      return;
    }
    if (url.pathname.startsWith("/api/")) { json(res, 404, { error: { code: "NOT_FOUND", message: "接口不存在" } }); return; }
    if (await servePackagedFile(req, res, url.pathname)) return;
    if (req.method !== "GET" || !["/", "/index.html"].includes(url.pathname)) { res.writeHead(404); res.end("Not Found"); return; }
    try {
      const html = await fs.promises.readFile(path.join(webRoot, "index.html"), "utf8");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } catch { res.writeHead(500); res.end("Workbench unavailable"); }
  }

  async function stop() {
    if (!server) return;
    const current = server;
    server = null;
    await new Promise((resolve) => current.close(() => resolve()));
  }

  return {
    async createCliSession() {
      const account = typeof gateway.accountStatus === "function"
        ? await gateway.accountStatus()
        : { loggedIn: false };
      if (!account?.loggedIn || account.active === false || account.user?.active === false) {
        throw Object.assign(new Error("Please log in before using the CLI."), { statusCode: 401, code: "AUTH_REQUIRED" });
      }
      const username = String(account.user?.username || "cli");
      const issued = sessionStore.issue({ subject: username, username });
      return { cookie: `${SESSION_COOKIE}=${encodeURIComponent(issued.token)}` };
    },
    start() {
      if (server) {
        const current = server.address();
        return Promise.resolve({ host: current.address, port: current.port });
      }
      server = http.createServer((req, res) => { handle(req, res).catch(() => json(res, 500, { error: { code: "SERVER_ERROR", message: "本地服务异常" } })); });
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port: options.port || 0 }, () => {
          server.removeListener("error", reject);
          const current = server.address();
          resolve({ host: current.address, port: current.port });
        });
      });
    },
    close: stop,
    stop,
    sessionStore
  };
}

module.exports = { SESSION_COOKIE, createLocalConsole };
