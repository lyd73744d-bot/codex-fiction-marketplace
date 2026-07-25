"use strict";

const crypto = require("node:crypto");
const {
  SessionStoreError,
  createSessionStore,
  sanitizePublicUser
} = require("./session-store");

const DEFAULT_GATEWAY = "https://api.nanshanyougui.xyz";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_STRUCTURE_DEPTH = 16;
const MAX_STRUCTURE_NODES = 1_024;
const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const RUN_ID_PATTERN = /^wr_[A-Za-z0-9_-]{8,128}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HUMANIZER_POST_ID_PATTERN = /^hp_[A-Za-z0-9_-]{43}$/;
const HUMANIZER_COLLECTION_ID_PATTERN = /^hc_[A-Za-z0-9_-]{43}$/;
const HUMANIZER_REVISION_PATTERN = /^[1-9][0-9]*$/;
const HUMANIZER_ETAG_PATTERN = /^he_[A-Za-z0-9_-]{43}$/;
const PRINTABLE_IDEMPOTENCY_PATTERN = /^[\x21-\x7e]{1,128}$/;
const ROUTING_KEYS = new Set([
  "model",
  "models",
  "modelid",
  "modelids",
  "engine",
  "provider",
  "route",
  "routes",
  "routingoverride",
  "baseurl",
  "apiurl",
  "apikey",
  "systemprompt",
  "systemroute",
  "systemrouteoverride",
  "routeoverride",
  "fallback"
]);
const DANGEROUS_KEYS = new Set(["proto", "prototype", "constructor"]);
const SERIALIZATION_HOOK_KEYS = new Set(["tojson"]);
const SENSITIVE_OUTPUT_KEYS = new Set([
  "accesstoken",
  "refreshtoken",
  "password",
  "authorization",
  "apikey",
  "baseurl",
  "model",
  "modelid",
  "engine",
  "provider",
  "route",
  "systemprompt"
]);

const ERROR_MESSAGES = Object.freeze({
  ACCOUNT_EXPIRED: "账号已过期",
  ACCOUNT_INACTIVE: "账号不可用",
  AUTH_FAILED: "用户名或密码不正确",
  AUTH_REQUIRED: "请先登录",
  CONFLICT: "请求与已有记录冲突",
  INSECURE_GATEWAY: "网关必须使用 HTTPS",
  INSUFFICIENT_BALANCE: "积分不足",
  INVALID_IDEMPOTENCY_KEY: "请求标识无效",
  INVALID_RECORD: "请求数据结构不安全",
  INVALID_REQUEST: "请求参数无效",
  LOGIN_REQUIRED: "请重新登录",
  MCP_NOT_ALLOWED: "当前账号未开通托管能力",
  NOT_FOUND: "请求的内容不存在",
  RATE_LIMITED: "请求过于频繁，请稍后再试",
  RESPONSE_INVALID: "服务器返回了无效数据",
  ROUTING_FIELD_FORBIDDEN: "请求中不能指定模型或线路",
  SERVER_ERROR: "服务器处理失败",
  SERVER_OFFLINE: "服务器暂时无法连接",
  UNTRUSTED_GATEWAY: "网关地址不受信任"
});

class GatewayClientError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] || ERROR_MESSAGES.SERVER_ERROR, status = null) {
    super(message);
    this.name = "GatewayClientError";
    this.code = code;
    this.status = status;
  }
}

class HttpResponseError extends Error {
  constructor(status, payload) {
    super(`HTTP ${status}`);
    this.name = "HttpResponseError";
    this.status = status;
    this.payload = payload;
  }
}

function canonicalKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function ownData(record, key) {
  if (!record || typeof record !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function assertPlainRecord(record, label) {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    throw new GatewayClientError("INVALID_RECORD", `${label}必须是普通对象`);
  }
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new GatewayClientError("INVALID_RECORD");
  }
}

function createPureJsonCopy(root) {
  const seen = new WeakSet();
  let nodes = 0;

  function clone(value, depth) {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new GatewayClientError("INVALID_RECORD");
      return value;
    }
    if (typeof value !== "object") throw new GatewayClientError("INVALID_RECORD");
    if (depth > MAX_STRUCTURE_DEPTH) throw new GatewayClientError("INVALID_REQUEST");
    if (seen.has(value)) throw new GatewayClientError("INVALID_RECORD");
    seen.add(value);

    if (Array.isArray(value)) {
      const arrayPrototype = Object.getPrototypeOf(value);
      if (arrayPrototype !== Array.prototype && arrayPrototype !== null) {
        throw new GatewayClientError("INVALID_RECORD");
      }
      if (value.length > MAX_STRUCTURE_NODES) throw new GatewayClientError("INVALID_REQUEST");
      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (
          typeof key !== "string"
          || !/^(?:0|[1-9][0-9]*)$/.test(key)
          || Number(key) >= value.length
        ) {
          throw new GatewayClientError("INVALID_RECORD");
        }
      }
      const copy = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new GatewayClientError("INVALID_RECORD");
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !("value" in descriptor)) throw new GatewayClientError("INVALID_RECORD");
        nodes += 1;
        if (nodes > MAX_STRUCTURE_NODES) throw new GatewayClientError("INVALID_REQUEST");
        copy.push(clone(descriptor.value, depth + 1));
      }
      Object.setPrototypeOf(copy, null);
      return copy;
    }

    assertPlainRecord(value, "请求数据");
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
      nodes += 1;
      if (nodes > MAX_STRUCTURE_NODES) throw new GatewayClientError("INVALID_REQUEST");
      if (typeof key !== "string") throw new GatewayClientError("INVALID_RECORD");
      const normalizedKey = canonicalKey(key);
      if (
        DANGEROUS_KEYS.has(normalizedKey)
        || SERIALIZATION_HOOK_KEYS.has(normalizedKey)
      ) {
        throw new GatewayClientError("INVALID_RECORD");
      }
      if (ROUTING_KEYS.has(normalizedKey)) {
        throw new GatewayClientError("ROUTING_FIELD_FORBIDDEN");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) throw new GatewayClientError("INVALID_RECORD");
      copy[key] = clone(descriptor.value, depth + 1);
    }
    return copy;
  }
  return clone(root, 0);
}

function safeJsonStringify(value) {
  return JSON.stringify(createPureJsonCopy(value));
}

function sanitizePublicValue(value, depth = 0) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (depth > MAX_STRUCTURE_DEPTH || !value || typeof value !== "object") return null;
  if (Array.isArray(value)) return value.map((item) => sanitizePublicValue(item, depth + 1));
  const result = {};
  for (const key of Object.keys(value)) {
    const normalizedKey = canonicalKey(key);
    if (DANGEROUS_KEYS.has(normalizedKey) || SENSITIVE_OUTPUT_KEYS.has(normalizedKey)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) continue;
    result[key] = sanitizePublicValue(descriptor.value, depth + 1);
  }
  return result;
}

function normalizeBaseUrl(rawBaseUrl, allowInsecureLoopback) {
  let parsed;
  try {
    parsed = new URL(String(rawBaseUrl || DEFAULT_GATEWAY));
  } catch {
    throw new GatewayClientError("INSECURE_GATEWAY");
  }
  const loopbackV4 = ["127", "0", "0", "1"].join(".");
  const loopback = parsed.hostname === "localhost"
    || parsed.hostname === loopbackV4
    || parsed.hostname === "[::1]"
    || parsed.hostname === "::1";
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new GatewayClientError("INSECURE_GATEWAY");
  }
  if (parsed.pathname !== "/") throw new GatewayClientError("INSECURE_GATEWAY");
  const production = parsed.protocol === "https:" && parsed.origin === DEFAULT_GATEWAY;
  const testLoopback = allowInsecureLoopback === true
    && loopback
    && (parsed.protocol === "http:" || parsed.protocol === "https:");
  if (!production && !testLoopback) {
    const code = parsed.protocol === "https:" ? "UNTRUSTED_GATEWAY" : "INSECURE_GATEWAY";
    throw new GatewayClientError(code);
  }
  return parsed.origin;
}

function stableHttpError(error, context = "request") {
  const status = error.status;
  const serverCode = ownData(ownData(error.payload, "error"), "code");
  if (context === "credential" && (status === 401 || status === 403)) {
    return new GatewayClientError("AUTH_FAILED", ERROR_MESSAGES.AUTH_FAILED, status);
  }
  if (status === 401) return new GatewayClientError("LOGIN_REQUIRED", ERROR_MESSAGES.LOGIN_REQUIRED, status);
  if (status === 402 || serverCode === "INSUFFICIENT_BALANCE") {
    return new GatewayClientError("INSUFFICIENT_BALANCE", ERROR_MESSAGES.INSUFFICIENT_BALANCE, status);
  }
  if (serverCode === "MCP_NOT_ALLOWED") {
    return new GatewayClientError("MCP_NOT_ALLOWED", ERROR_MESSAGES.MCP_NOT_ALLOWED, status);
  }
  if (serverCode === "ACCOUNT_EXPIRED") {
    return new GatewayClientError("ACCOUNT_EXPIRED", ERROR_MESSAGES.ACCOUNT_EXPIRED, status);
  }
  if (serverCode === "ACCOUNT_INACTIVE") {
    return new GatewayClientError("ACCOUNT_INACTIVE", ERROR_MESSAGES.ACCOUNT_INACTIVE, status);
  }
  if (serverCode === "ETAG_MISMATCH" || serverCode === "IDEMPOTENCY_CONFLICT") {
    return new GatewayClientError("CONFLICT", ERROR_MESSAGES.CONFLICT, status);
  }
  if (serverCode === "INVALID_IDEMPOTENCY_KEY") {
    return new GatewayClientError("INVALID_IDEMPOTENCY_KEY", ERROR_MESSAGES.INVALID_IDEMPOTENCY_KEY, status);
  }
  if (serverCode === "COMMUNITY_RULES_UNVERIFIED") {
    return new GatewayClientError("SERVER_OFFLINE", ERROR_MESSAGES.SERVER_OFFLINE, status);
  }
  if (status === 404) return new GatewayClientError("NOT_FOUND", ERROR_MESSAGES.NOT_FOUND, status);
  if (status === 409) return new GatewayClientError("CONFLICT", ERROR_MESSAGES.CONFLICT, status);
  if (status === 429) return new GatewayClientError("RATE_LIMITED", ERROR_MESSAGES.RATE_LIMITED, status);
  if (status >= 500) return new GatewayClientError("SERVER_ERROR", ERROR_MESSAGES.SERVER_ERROR, status);
  return new GatewayClientError("INVALID_REQUEST", ERROR_MESSAGES.INVALID_REQUEST, status);
}

function validateCredentials(input) {
  assertPlainRecord(input, "登录信息");
  const username = ownData(input, "username");
  const password = ownData(input, "password");
  if (typeof username !== "string" || !username.trim() || username.length > 128) {
    throw new GatewayClientError("INVALID_REQUEST");
  }
  if (typeof password !== "string" || !password || password.length > 1_024) {
    throw new GatewayClientError("INVALID_REQUEST");
  }
  return { username: username.trim(), password };
}

function validateSessionResponse(payload, priorSession = null) {
  const accessToken = ownData(payload, "accessToken");
  const refreshToken = ownData(payload, "refreshToken") || priorSession?.refreshToken;
  const user = sanitizePublicUser(ownData(payload, "user") || priorSession?.user);
  if (
    typeof accessToken !== "string"
    || !accessToken
    || typeof refreshToken !== "string"
    || !refreshToken
    || !user?.username
  ) {
    throw new GatewayClientError("RESPONSE_INVALID");
  }
  return { accessToken, refreshToken, user, savedAt: new Date().toISOString() };
}

function createGatewayClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl || DEFAULT_GATEWAY, options.allowInsecureLoopback);
  const request = options.fetch || globalThis.fetch;
  const sessionStore = options.sessionStore || createSessionStore(options.sessionOptions);
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : 120_000;
  if (typeof request !== "function") throw new TypeError("fetch implementation is required");
  if (!sessionStore || typeof sessionStore.read !== "function") {
    throw new TypeError("sessionStore is required");
  }

  async function networkRequest(pathname, init = {}) {
    let response;
    try {
      response = await request(`${baseUrl}${pathname}`, {
        method: init.method || "GET",
        headers: init.headers || {},
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs || timeoutMs)
      });
    } catch (error) {
      if (error instanceof GatewayClientError || error instanceof HttpResponseError) throw error;
      throw new GatewayClientError("SERVER_OFFLINE");
    }
    let text;
    try {
      text = await response.text();
    } catch {
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        throw new GatewayClientError("RESPONSE_INVALID");
      }
    }
    if (!response.ok) throw new HttpResponseError(response.status, payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    return payload;
  }

  async function saveSession(session) {
    try {
      return await sessionStore.save(session);
    } catch (error) {
      if (error instanceof GatewayClientError) throw error;
      throw new GatewayClientError("SERVER_ERROR", "无法保存登录状态");
    }
  }

  function sameSession(left, right) {
    return Boolean(left && right)
      && left.accessToken === right.accessToken
      && left.version === right.version;
  }

  function isLegacySession(session) {
    return typeof session?.version === "string" && session.version.startsWith("legacy_");
  }

  async function stabilizeLegacySession(session) {
    if (!isLegacySession(session)) return session;
    try {
      return await sessionStore.transaction(async (locked) => {
        const current = await locked.read();
        if (!isLegacySession(current)) return current;
        return locked.save({ ...current, version: crypto.randomUUID() });
      });
    } catch {
      throw new GatewayClientError("SERVER_ERROR");
    }
  }

  async function clearForRelogin(expectedSession = null) {
    try {
      await sessionStore.transaction(async (locked) => {
        const current = await locked.read();
        if (!expectedSession || sameSession(current, expectedSession)) await locked.clear();
      });
    } catch {}
    throw new GatewayClientError("LOGIN_REQUIRED");
  }

  async function readSession() {
    try {
      return await stabilizeLegacySession(await sessionStore.read());
    } catch (error) {
      if (!(error instanceof SessionStoreError)) throw error;
      if (error.code !== "INVALID_SESSION") throw new GatewayClientError("SERVER_ERROR");
      try {
        return await sessionStore.transaction(async (locked) => {
          try {
            return await locked.read();
          } catch (lockedError) {
            if (
              !(lockedError instanceof SessionStoreError)
              || lockedError.code !== "INVALID_SESSION"
            ) {
              throw lockedError;
            }
            await locked.clear();
            return null;
          }
        });
      } catch {
        throw new GatewayClientError("SERVER_ERROR");
      }
    }
  }

  async function requireSession({ checkMcp = true } = {}) {
    const session = await readSession();
    if (!session?.accessToken) throw new GatewayClientError("AUTH_REQUIRED");
    if (checkMcp && session.user?.capabilities?.mcp === false) {
      throw new GatewayClientError("MCP_NOT_ALLOWED");
    }
    return session;
  }

  async function refreshAfterUnauthorized(staleSession) {
    let relogin = false;
    try {
      const refreshed = await sessionStore.transaction(async (locked) => {
        const current = await locked.read();
        if (!current?.accessToken) {
          relogin = true;
          return null;
        }
        if (!sameSession(current, staleSession)) return current;
        if (!current.refreshToken) {
          await locked.clear();
          relogin = true;
          return null;
        }
        try {
          const payload = await networkRequest("/api/auth/refresh", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: safeJsonStringify({ refreshToken: current.refreshToken })
          });
          return locked.save(validateSessionResponse(payload, current));
        } catch {
          const latest = await locked.read();
          if (sameSession(latest, current)) {
            await locked.clear();
            relogin = true;
            return null;
          }
          return latest;
        }
      });
      if (refreshed?.accessToken) return refreshed;
    } catch (error) {
      if (!(error instanceof SessionStoreError)) throw error;
      throw new GatewayClientError("SERVER_ERROR", "登录状态正忙，请稍后重试");
    }
    if (relogin) throw new GatewayClientError("LOGIN_REQUIRED");
    throw new GatewayClientError("LOGIN_REQUIRED");
  }

  async function authenticatedRequestWithSession(pathname, init = {}, authOptions = {}) {
    let session = await requireSession(authOptions);
    const perform = (accessToken) => networkRequest(pathname, {
      ...init,
      headers: {
        ...(init.headers || {}),
        authorization: `Bearer ${accessToken}`
      }
    });
    try {
      return { payload: await perform(session.accessToken), session };
    } catch (error) {
      if (!(error instanceof HttpResponseError) || error.status !== 401) {
        if (error instanceof HttpResponseError) throw stableHttpError(error);
        throw error;
      }
    }
    session = await refreshAfterUnauthorized(session);
    try {
      return { payload: await perform(session.accessToken), session };
    } catch (error) {
      if (error instanceof HttpResponseError && error.status === 401) {
        return clearForRelogin(session);
      }
      if (error instanceof HttpResponseError) throw stableHttpError(error);
      throw error;
    }
  }

  async function authenticatedRequest(pathname, init = {}, authOptions = {}) {
    return (await authenticatedRequestWithSession(pathname, init, authOptions)).payload;
  }

  async function authenticate(pathname, input) {
    const credentials = validateCredentials(input);
    let payload;
    try {
      payload = await networkRequest(pathname, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: safeJsonStringify(credentials)
      });
    } catch (error) {
      if (error instanceof HttpResponseError) throw stableHttpError(error, "credential");
      throw error;
    }
    const session = await saveSession(validateSessionResponse(payload));
    return { ok: true, user: session.user };
  }

  async function register(input) {
    return authenticate("/api/auth/register", input);
  }

  async function login(input) {
    return authenticate("/api/auth/login", input);
  }

  async function accountStatus() {
    const current = await readSession();
    if (!current) return { ok: true, loggedIn: false, user: null };
    const requestResult = await authenticatedRequestWithSession("/api/balance", {}, { checkMcp: false });
    const payload = requestResult.payload;
    const requestSession = requestResult.session;
    const user = sanitizePublicUser(ownData(payload, "user") || requestSession?.user);
    if (!user?.username) throw new GatewayClientError("RESPONSE_INVALID");
    return sessionStore.transaction(async (locked) => {
      const latest = await locked.read();
      if (!latest) return { ok: true, loggedIn: false, user: null };
      if (!sameSession(latest, requestSession)) {
        return {
          ok: true,
          loggedIn: true,
          active: latest.user?.active !== false,
          user: latest.user
        };
      }
      const saved = await locked.save({
        ...latest,
        user,
        version: latest.version,
        savedAt: new Date().toISOString()
      });
      return {
        ok: true,
        loggedIn: true,
        active: ownData(payload, "active") !== false,
        user: saved.user
      };
    });
  }

  async function connectionStatus() {
    try {
      await networkRequest("/healthz");
      return { ok: true, online: true };
    } catch (error) {
      if (error instanceof HttpResponseError) return { ok: true, online: true };
      return {
        ok: false,
        online: false,
        error: { code: "SERVER_OFFLINE", message: ERROR_MESSAGES.SERVER_OFFLINE }
      };
    }
  }

  async function listWorkflows() {
    const payload = await authenticatedRequest("/api/workflows");
    const workflows = ownData(payload, "data");
    if (!Array.isArray(workflows)) throw new GatewayClientError("RESPONSE_INVALID");
    const policyVersion = ownData(payload, "policyVersion");
    return {
      ok: true,
      policyVersion: typeof policyVersion === "string" ? policyVersion : null,
      workflows: sanitizePublicValue(workflows)
    };
  }

  async function runWorkflow(input) {
    await requireSession();
    const safeRequest = createPureJsonCopy(input);
    assertPlainRecord(safeRequest, "工作流请求");
    const allowed = new Set(["workflowId", "idempotencyKey", "mode", "input"]);
    for (const key of Object.keys(safeRequest)) {
      if (!allowed.has(key)) throw new GatewayClientError("INVALID_REQUEST");
    }
    const workflowId = ownData(safeRequest, "workflowId");
    const mode = ownData(safeRequest, "mode");
    const workflowInput = ownData(safeRequest, "input");
    const requestedIdempotencyKey = ownData(safeRequest, "idempotencyKey");
    const idempotencyKey = requestedIdempotencyKey === undefined
      ? crypto.randomUUID()
      : requestedIdempotencyKey;
    if (typeof workflowId !== "string" || !WORKFLOW_ID_PATTERN.test(workflowId)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    if (mode !== "quick" && mode !== "deep") throw new GatewayClientError("INVALID_REQUEST");
    assertPlainRecord(workflowInput, "工作流输入");
    if (typeof idempotencyKey !== "string" || !UUID_PATTERN.test(idempotencyKey)) {
      throw new GatewayClientError("INVALID_IDEMPOTENCY_KEY");
    }
    const payload = await authenticatedRequest(
      `/api/workflows/${encodeURIComponent(workflowId)}/runs`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey
        },
        body: safeJsonStringify(Object.assign(Object.create(null), { mode, input: workflowInput }))
      }
    );
    const data = ownData(payload, "data");
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    return sanitizePublicValue(data);
  }

  async function getRun(input) {
    await requireSession();
    assertPlainRecord(input, "运行查询");
    const runId = ownData(input, "runId");
    if (typeof runId !== "string" || !RUN_ID_PATTERN.test(runId)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    const payload = await authenticatedRequest(`/api/workflow-runs/${encodeURIComponent(runId)}`);
    const data = ownData(payload, "data");
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    return sanitizePublicValue(data);
  }

  async function listModels() {
    const payload = await authenticatedRequest("/api/models");
    const raw = ownData(payload, "data") ?? ownData(payload, "models");
    if (!Array.isArray(raw)) throw new GatewayClientError("RESPONSE_INVALID");
    const models = raw.map((item) => {
      if (!item || typeof item !== "object" || typeof ownData(item, "id") !== "string" || !ownData(item, "id")) {
        throw new GatewayClientError("RESPONSE_INVALID");
      }
      return sanitizePublicValue(item);
    });
    return { ok: true, models };
  }

  async function callModels(input) {
    assertPlainRecord(input, "model request");
    const allowed = new Set(["prompt", "system", "modelIds", "taskLabel"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new GatewayClientError("INVALID_REQUEST");
    const prompt = ownData(input, "prompt");
    const modelIds = ownData(input, "modelIds");
    const system = ownData(input, "system");
    const taskLabel = ownData(input, "taskLabel");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.length > 200_000) throw new GatewayClientError("INVALID_REQUEST");
    if (!Array.isArray(modelIds) || modelIds.length < 1 || modelIds.length > 8) throw new GatewayClientError("INVALID_REQUEST");
    const ids = [...new Set(modelIds)];
    if (ids.length !== modelIds.length || ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    if (system !== undefined && (typeof system !== "string" || system.length > 100_000)) throw new GatewayClientError("INVALID_REQUEST");
    if (taskLabel !== undefined && (typeof taskLabel !== "string" || taskLabel.length > 64)) throw new GatewayClientError("INVALID_REQUEST");
    const catalog = await listModels();
    const available = new Set(catalog.models.map((item) => ownData(item, "id")));
    if (ids.some((id) => !available.has(id))) throw new GatewayClientError("INVALID_REQUEST");

    let content = "";
    const outputs = [];
    for (const model of ids) {
      const messages = [];
      if (system) messages.push({ role: "system", content: system });
      messages.push({ role: "user", content: prompt });
      if (content) {
        messages.push({ role: "assistant", content }, { role: "user", content: "检查上一版并输出完整改进稿，保留已确认事实，不只列建议。" });
      }
      const payload = await authenticatedRequest("/e/catalog/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", "x-workflow-operation": String(taskLabel || "codex").slice(0, 32) },
        body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: 12000, stream: false })
      });
      const choices = ownData(payload, "choices");
      const message = Array.isArray(choices) ? ownData(choices[0], "message") : null;
      const nextContent = typeof ownData(message, "content") === "string" ? ownData(message, "content").trim() : "";
      if (!nextContent) throw new GatewayClientError("RESPONSE_INVALID");
      content = nextContent;
      outputs.push({ model, content, usage: sanitizePublicValue(ownData(payload, "usage") || null) });
    }
    return { ok: true, modelIds: ids, outputs, content };
  }

  function squareInput(input, label) {
    const value = input === undefined ? Object.create(null) : createPureJsonCopy(input);
    assertPlainRecord(value, label);
    return value;
  }

  function squareKeys(value, allowed) {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) throw new GatewayClientError("INVALID_REQUEST");
    }
  }

  function squareData(payload) {
    const data = ownData(payload, "data");
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    return sanitizePublicValue(data);
  }

  function squarePostId(value) {
    if (typeof value !== "string" || !HUMANIZER_POST_ID_PATTERN.test(value)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    return value;
  }

  function squareCollectionId(value) {
    if (typeof value !== "string" || !HUMANIZER_COLLECTION_ID_PATTERN.test(value)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    return value;
  }

  function squareRevision(value) {
    if (!(typeof value === "number" && Number.isSafeInteger(value) && value > 0)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    return String(value);
  }

  function squareEtag(value) {
    if (typeof value !== "string" || !HUMANIZER_ETAG_PATTERN.test(value)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    return value;
  }

  function squareIdempotency(value) {
    if (typeof value !== "string" || !PRINTABLE_IDEMPOTENCY_PATTERN.test(value)) {
      throw new GatewayClientError("INVALID_IDEMPOTENCY_KEY");
    }
    return value;
  }

  function squareDraft(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    return createPureJsonCopy(value);
  }

  async function listHumanizerPosts(input) {
    const value = squareInput(input, "humanizer square options");
    squareKeys(value, new Set(["limit", "cursor"]));
    const limit = ownData(value, "limit");
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1 || limit > 50)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    const cursor = ownData(value, "cursor");
    if (cursor !== undefined && cursor !== null) squarePostId(cursor);
    const query = [];
    if (limit !== undefined) query.push(`limit=${encodeURIComponent(String(limit))}`);
    if (cursor !== undefined && cursor !== null) query.push(`cursor=${encodeURIComponent(cursor)}`);
    const payload = await authenticatedRequest(`/api/v3/rule-square/posts${query.length ? `?${query.join("&")}` : ""}`);
    return squareData(payload);
  }

  async function getHumanizerPost(input) {
    const value = squareInput(input, "humanizer post request");
    squareKeys(value, new Set(["postId"]));
    const payload = await authenticatedRequest(`/api/v3/rule-square/posts/${encodeURIComponent(squarePostId(ownData(value, "postId")))}`);
    return squareData(payload);
  }

  async function saveHumanizerRuleDraft(input) {
    const value = squareInput(input, "humanizer draft request");
    squareKeys(value, new Set(["idempotencyKey", "draft"]));
    const payload = await authenticatedRequest("/api/v3/rule-library/drafts", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": squareIdempotency(ownData(value, "idempotencyKey")) },
      body: safeJsonStringify({ draft: squareDraft(ownData(value, "draft")) })
    });
    return squareData(payload);
  }

  async function updateHumanizerRuleDraft(input) {
    const value = squareInput(input, "humanizer draft update");
    squareKeys(value, new Set(["postId", "ifMatch", "draft"]));
    const payload = await authenticatedRequest(`/api/v3/rule-library/drafts/${encodeURIComponent(squarePostId(ownData(value, "postId")))}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": squareEtag(ownData(value, "ifMatch")) },
      body: safeJsonStringify({ draft: squareDraft(ownData(value, "draft")) })
    });
    return squareData(payload);
  }

  async function submitHumanizerRuleDraft(input) {
    const value = squareInput(input, "humanizer draft submission");
    squareKeys(value, new Set(["postId", "ifMatch", "idempotencyKey"]));
    const payload = await authenticatedRequest(`/api/v3/rule-library/drafts/${encodeURIComponent(squarePostId(ownData(value, "postId")))}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": squareEtag(ownData(value, "ifMatch")), "idempotency-key": squareIdempotency(ownData(value, "idempotencyKey")) },
      body: "{}"
    });
    return squareData(payload);
  }

  async function withdrawHumanizerRevision(input) {
    const value = squareInput(input, "humanizer revision withdrawal");
    squareKeys(value, new Set(["postId", "revision", "ifMatch", "idempotencyKey"]));
    const postId = squarePostId(ownData(value, "postId"));
    const revision = squareRevision(ownData(value, "revision"));
    const payload = await authenticatedRequest(`/api/v3/rule-square/posts/${encodeURIComponent(postId)}/revisions/${revision}/withdraw`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": squareEtag(ownData(value, "ifMatch")), "idempotency-key": squareIdempotency(ownData(value, "idempotencyKey")) },
      body: "{}"
    });
    return squareData(payload);
  }

  async function reportHumanizerPost(input) {
    const value = squareInput(input, "humanizer report");
    squareKeys(value, new Set(["postId", "reason", "idempotencyKey"]));
    const reason = ownData(value, "reason");
    if (typeof reason !== "string" || !reason.trim() || reason.length > 400) throw new GatewayClientError("INVALID_REQUEST");
    const payload = await authenticatedRequest(`/api/v3/rule-square/posts/${encodeURIComponent(squarePostId(ownData(value, "postId")))}/report`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": squareIdempotency(ownData(value, "idempotencyKey")) },
      body: safeJsonStringify({ reason })
    });
    return squareData(payload);
  }

  async function getHumanizerLibrary() {
    return squareData(await authenticatedRequest("/api/v3/rule-library"));
  }

  async function collectHumanizerRevision(input) {
    const value = squareInput(input, "humanizer collection");
    squareKeys(value, new Set(["postId", "revision", "idempotencyKey"]));
    const payload = await authenticatedRequest("/api/v3/rule-library/collections", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": squareIdempotency(ownData(value, "idempotencyKey")) },
      body: safeJsonStringify({ postId: squarePostId(ownData(value, "postId")), revision: ownData(value, "revision") })
    });
    return squareData(payload);
  }

  async function uncollectHumanizerRule(input) {
    const value = squareInput(input, "humanizer collection removal");
    squareKeys(value, new Set(["collectionId", "ifMatch"]));
    const payload = await authenticatedRequest(`/api/v3/rule-library/collections/${encodeURIComponent(squareCollectionId(ownData(value, "collectionId")))}`, {
      method: "DELETE",
      headers: { "content-type": "application/json", "if-match": squareEtag(ownData(value, "ifMatch")) },
      body: "{}"
    });
    return squareData(payload);
  }

  async function setHumanizerActivation(input) {
    const value = squareInput(input, "humanizer activation");
    squareKeys(value, new Set(["collectionId", "ifMatch", "enabled"]));
    if (typeof ownData(value, "enabled") !== "boolean") throw new GatewayClientError("INVALID_REQUEST");
    const payload = await authenticatedRequest(`/api/v3/rule-library/collections/${encodeURIComponent(squareCollectionId(ownData(value, "collectionId")))}/activation`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": squareEtag(ownData(value, "ifMatch")) },
      body: safeJsonStringify({ enabled: ownData(value, "enabled") })
    });
    return squareData(payload);
  }

  async function getHumanizerEffectiveManifest() {
    return squareData(await authenticatedRequest("/api/v3/rule-library/effective-manifest"));
  }

  return Object.freeze({
    accountStatus,
    baseUrl,
    connectionStatus,
    getRun,
    getHumanizerEffectiveManifest,
    getHumanizerLibrary,
    getHumanizerPost,
    listModels,
    listWorkflows,
    listHumanizerPosts,
    login,
    register,
    collectHumanizerRevision,
    callModels,
    reportHumanizerPost,
    runWorkflow
    ,saveHumanizerRuleDraft
    ,setHumanizerActivation
    ,submitHumanizerRuleDraft
    ,uncollectHumanizerRule
    ,updateHumanizerRuleDraft
    ,withdrawHumanizerRevision
  });
}

module.exports = {
  DEFAULT_GATEWAY,
  ERROR_MESSAGES,
  GatewayClientError,
  createGatewayClient
};
