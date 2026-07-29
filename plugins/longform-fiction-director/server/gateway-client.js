"use strict";

const crypto = require("node:crypto");
const os = require("node:os");
const { SessionStoreError, createSessionStore, publicUser } = require("./session-store");

const DEFAULT_GATEWAY = "https://api.nanshanyougui.xyz";
const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SENSITIVE_KEY_PATTERN = /(?:api|key|secret|token|password|credential|cookie)/u;
const ERROR_MESSAGES = Object.freeze({
  AUTH_REQUIRED: "Please log in first.",
  AUTH_FAILED: "Username or password is incorrect.",
  INVALID_REQUEST: "Request is invalid.",
  RESPONSE_INVALID: "Gateway response is invalid.",
  EMPTY_MODEL_OUTPUT: "Model returned no usable text.",
  SERVER_OFFLINE: "Gateway is offline.",
  UPSTREAM_TIMEOUT: "Model response timed out.",
  SERVER_ERROR: "Gateway request failed.",
  CONFLICT: "Request conflicts with an existing record.",
  INSUFFICIENT_BALANCE: "Insufficient balance.",
  REGISTRATION_FAILED: "Registration is unavailable."
});

class GatewayClientError extends Error {
  constructor(code, message = ERROR_MESSAGES[code] || ERROR_MESSAGES.SERVER_ERROR, status = null, publicMessage = null) {
    super(message);
    this.name = "GatewayClientError";
    this.code = code;
    this.status = status;
    if (typeof publicMessage === "string" && publicMessage) this.publicMessage = publicMessage;
  }
}

function isTimeoutError(error) {
  let current = error;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.cause) {
    const name = String(current.name || "");
    const code = String(current.code || "");
    const message = String(current.message || "");
    if (name === "TimeoutError" || name === "AbortError" || code === "ETIMEDOUT" || /timed?\s*out|timeout|deadline|超时/iu.test(message)) return true;
  }
  return false;
}

function toGatewayNetworkError(error, fallbackCode = "SERVER_OFFLINE") {
  if (error instanceof GatewayClientError) return error;
  if (isTimeoutError(error)) {
    return new GatewayClientError("UPSTREAM_TIMEOUT", ERROR_MESSAGES.UPSTREAM_TIMEOUT, null, "模型响应超时，本次没有完成。");
  }
  return new GatewayClientError(fallbackCode, ERROR_MESSAGES[fallbackCode] || ERROR_MESSAGES.SERVER_ERROR);
}

function canonicalKey(key) { return String(key).replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function sanitizePublicValue(value, depth = 0) {
  if (value === null || ["string", "number", "boolean"].includes(typeof value)) return value;
  if (!value || typeof value !== "object" || depth > 16) return null;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitizePublicValue(item, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = canonicalKey(key);
    if (SENSITIVE_KEY_PATTERN.test(normalizedKey) || normalizedKey === "baseurl") continue;
    result[key] = sanitizePublicValue(item, depth + 1);
  }
  return result;
}

function normalizeBaseUrl(raw, allowInsecureLoopback) {
  let parsed;
  try { parsed = new URL(String(raw || DEFAULT_GATEWAY)); } catch { throw new GatewayClientError("INVALID_REQUEST"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") throw new GatewayClientError("INVALID_REQUEST");
  if (parsed.protocol === "https:" && parsed.hostname === new URL(DEFAULT_GATEWAY).hostname) return parsed.origin;
  if (allowInsecureLoopback && loopback && ["http:", "https:"].includes(parsed.protocol)) return parsed.origin;
  throw new GatewayClientError("INVALID_REQUEST");
}

function safeObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new GatewayClientError("INVALID_REQUEST");
  return input;
}

function defaultMachineCode() {
  const seed = [os.hostname(), os.userInfo?.().username || "", os.homedir(), "longform-fiction-director"].join("|");
  const hash = crypto.createHash("sha256").update(seed).digest("hex").toUpperCase();
  return `ZZ-${hash.slice(0, 4)}-${hash.slice(4, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}`;
}

function validMachineCode(value) {
  const normalized = String(value || "").trim().toUpperCase();
  if (!/^[A-Z0-9-]{8,64}$/u.test(normalized)) throw new GatewayClientError("INVALID_REQUEST");
  return normalized;
}

function upstreamPublicMessage(payload) {
  const source = String(payload?.message || payload?.error?.message || payload?.error?.code || "");
  if (/(?:api[\s_-]*key|authori[sz]ation|unauthori[sz]ed|authentication|invalid[\s_-]*(?:key|token)|\b401\b)/iu.test(source)) return "网关上游鉴权失败。";
  if (/(?:model.*(?:not[\s_-]*found|unavailable|does[\s_-]*not[\s_-]*exist)|invalid[\s_-]*model|\b404\b)/iu.test(source)) return "网关上游模型或路由不可用。";
  if (/(?:rate|too[\s_-]*many|overload|busy|\b429\b)/iu.test(source)) return "网关上游繁忙或触发限流。";
  if (/(?:timeout|timed[\s_-]*out|deadline|超时)/iu.test(source)) return "网关上游请求超时。";
  return "网关上游请求失败。";
}

function responseError(status, payload) {
  const serverCode = payload && payload.error && payload.error.code;
  if (status === 401) return new GatewayClientError("AUTH_REQUIRED", ERROR_MESSAGES.AUTH_REQUIRED, status);
  if (status === 403) return new GatewayClientError("AUTH_FAILED", ERROR_MESSAGES.AUTH_FAILED, status);
  if (status === 402 || serverCode === "INSUFFICIENT_BALANCE") return new GatewayClientError("INSUFFICIENT_BALANCE", ERROR_MESSAGES.INSUFFICIENT_BALANCE, status);
  if (status === 409) return new GatewayClientError("CONFLICT", ERROR_MESSAGES.CONFLICT, status);
  if (status >= 500) {
    const publicMessage = upstreamPublicMessage(payload);
    if (publicMessage === "网关上游请求超时。") return new GatewayClientError("UPSTREAM_TIMEOUT", ERROR_MESSAGES.UPSTREAM_TIMEOUT, status, publicMessage);
    return new GatewayClientError("SERVER_ERROR", ERROR_MESSAGES.SERVER_ERROR, status, publicMessage);
  }
  return new GatewayClientError("INVALID_REQUEST", ERROR_MESSAGES.INVALID_REQUEST, status);
}

function stringContent(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => {
    if (typeof part === "string") return part;
    if (typeof part?.text === "string") return part.text;
    if (typeof part?.content === "string") return part.content;
    return "";
  }).join("");
  return "";
}
function completionParts(payload) {
  const choice = payload?.choices?.[0] || {};
  const message = choice.message || choice.delta || {};
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const responseText = output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => stringContent(part?.text ?? part?.content ?? (part?.type === "output_text" ? part?.text : ""))).join("");
  return {
    content: stringContent(message.content ?? payload?.output_text ?? responseText),
    reasoning: stringContent(message.reasoning_content ?? message.reasoning ?? message.reasoning_text ?? payload?.reasoning_content ?? payload?.reasoning),
    usage: payload?.usage || null,
    finishReason: choice.finish_reason ?? payload?.finish_reason ?? payload?.status ?? null
  };
}
function completionContent(payload) { return completionParts(payload).content; }
function incompleteStreamError(message, details = {}) {
  const error = new GatewayClientError("RESPONSE_INCOMPLETE", message || "Model stream ended before completion.");
  Object.assign(error, details);
  return error;
}
async function collectOpenAiStream(response, onDelta, { maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES } = {}) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (!/text\/event-stream/iu.test(contentType)) {
    let text;
    try { text = await response.text(); } catch (error) { throw toGatewayNetworkError(error, "RESPONSE_INVALID"); }
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) throw new GatewayClientError("RESPONSE_TOO_LARGE");
    let payload;
    try { payload = JSON.parse(text); } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    const parts = completionParts(payload);
    if (!parts.content.trim()) throw new GatewayClientError("RESPONSE_INVALID");
    if (typeof onDelta === "function") await onDelta(parts.content);
    return { ...parts, complete: true, transport: "non_sse_response" };
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new GatewayClientError("RESPONSE_INVALID");
  const decoder = new TextDecoder();
  let receivedBytes = 0, buffer = "", content = "", reasoning = "", usage = null, done = false, finishReason = null;
  async function consumeEvent(block) {
    const data = block.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n").trim();
    if (!data) return;
    if (data === "[DONE]") { done = true; return; }
    let payload;
    try { payload = JSON.parse(data); } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    const parts = completionParts(payload);
    content += parts.content;
    reasoning += parts.reasoning;
    if (parts.usage && typeof parts.usage === "object") usage = parts.usage;
    if (parts.finishReason && parts.finishReason !== "in_progress") finishReason = parts.finishReason;
    if (parts.content && typeof onDelta === "function") await onDelta(parts.content);
  }
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      receivedBytes += chunk.value.byteLength;
      if (receivedBytes > maxResponseBytes) { await reader.cancel().catch(() => {}); throw incompleteStreamError("Model response exceeded safe stream limit.", { partialContent: content, partialReasoning: reasoning, receivedBytes, maxResponseBytes }); }
      buffer += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) { await consumeEvent(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2); if (done) break; }
    }
    if (!done && buffer.trim()) await consumeEvent(buffer + decoder.decode());
  } catch (cause) {
    if (cause && typeof cause === "object") Object.assign(cause, { partialContent: cause.partialContent ?? content, partialReasoning: cause.partialReasoning ?? reasoning, receivedBytes, maxResponseBytes });
    throw cause;
  }
  if (!content.trim()) throw new GatewayClientError("RESPONSE_INVALID");
  if (!done && !finishReason) throw incompleteStreamError("Model stream closed without [DONE] or finish reason.", { partialContent: content, partialReasoning: reasoning, receivedBytes, maxResponseBytes });
  return { content, reasoning, usage, finishReason, complete: true, receivedBytes, transport: "sse" };
}

function createGatewayClient(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl, options.allowInsecureLoopback);
  const fetcher = options.fetch || globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("fetch implementation is required");
  const sessionStore = options.sessionStore || createSessionStore(options.sessionOptions);
  if (!sessionStore || typeof sessionStore.read !== "function") throw new TypeError("sessionStore is required");
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
  const modelTimeoutMs = Number.isSafeInteger(options.modelTimeoutMs) && options.modelTimeoutMs > 0 ? options.modelTimeoutMs : 5 * 60_000;
  const streamTimeoutMs = Number.isSafeInteger(options.streamTimeoutMs) && options.streamTimeoutMs > 0 ? options.streamTimeoutMs : 20 * 60_000;
  const maxResponseBytes = Number.isSafeInteger(options.maxResponseBytes) && options.maxResponseBytes > 0 ? options.maxResponseBytes : DEFAULT_MAX_RESPONSE_BYTES;
  const machineCode = validMachineCode(options.machineCode || defaultMachineCode());

  async function networkRequest(pathname, init = {}) {
    let response;
    try {
      response = await fetcher(`${baseUrl}${pathname}`, { method: init.method || "GET", headers: init.headers || {}, body: init.body, redirect: "error", signal: AbortSignal.timeout(init.timeoutMs || timeoutMs) });
    } catch (error) {
      if (error instanceof GatewayClientError) throw error;
      throw toGatewayNetworkError(error, "SERVER_OFFLINE");
    }
    let text;
    try { text = await response.text(); } catch (error) { throw toGatewayNetworkError(error, "RESPONSE_INVALID"); }
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) throw new GatewayClientError("RESPONSE_INVALID");
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    if (!response.ok) throw responseError(response.status, payload);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new GatewayClientError("RESPONSE_INVALID");
    return payload;
  }

  async function readSession() {
    try { return await sessionStore.read(); } catch (error) { if (error instanceof SessionStoreError) throw new GatewayClientError("SERVER_ERROR"); throw error; }
  }
  async function saveSession(payload, prior = null) {
    const accessToken = payload.accessToken;
    const refreshToken = payload.refreshToken || prior?.refreshToken;
    const user = publicUser(payload.user || prior?.user);
    if (typeof accessToken !== "string" || !accessToken || typeof refreshToken !== "string" || !refreshToken || !user?.username) throw new GatewayClientError("RESPONSE_INVALID");
    try { return await sessionStore.save({ accessToken, refreshToken, user, version: crypto.randomUUID() }); } catch { throw new GatewayClientError("SERVER_ERROR"); }
  }
  async function requireSession() { const session = await readSession(); if (!session?.accessToken) throw new GatewayClientError("AUTH_REQUIRED"); return session; }
  async function authenticatedRequest(pathname, init = {}, retry = true) {
    let session = await requireSession();
    try {
      return await networkRequest(pathname, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${session.accessToken}` } });
    } catch (error) {
      if (!(error instanceof GatewayClientError) || error.status !== 401 || !retry || !session.refreshToken) throw error;
      try {
        const refreshed = await networkRequest("/api/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: session.refreshToken }) });
        session = await saveSession(refreshed, session);
        return await networkRequest(pathname, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${session.accessToken}` } });
      } catch { await sessionStore.clear().catch(() => {}); throw new GatewayClientError("AUTH_REQUIRED"); }
    }
  }
  async function rawNetworkRequest(pathname, init = {}) {
    try {
      return await fetcher(`${baseUrl}${pathname}`, {
        method: init.method || "GET",
        headers: init.headers || {},
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs || streamTimeoutMs)
      });
    } catch (error) {
      if (error instanceof GatewayClientError) throw error;
      throw toGatewayNetworkError(error, "SERVER_OFFLINE");
    }
  }
  async function rawFailure(response) {
    let text = "";
    try { text = await response.text(); } catch (error) { throw toGatewayNetworkError(error, "RESPONSE_INVALID"); }
    if (Buffer.byteLength(text, "utf8") > maxResponseBytes) throw new GatewayClientError("RESPONSE_INVALID");
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = {}; }
    throw responseError(response.status, payload);
  }
  async function authenticatedRawRequest(pathname, init = {}, retry = true) {
    let session = await requireSession();
    let response = await rawNetworkRequest(pathname, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${session.accessToken}` } });
    if (response.status === 401 && retry && session.refreshToken) {
      await response.body?.cancel().catch(() => {});
      try {
        const refreshed = await networkRequest("/api/auth/refresh", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: session.refreshToken }) });
        session = await saveSession(refreshed, session);
        response = await rawNetworkRequest(pathname, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${session.accessToken}` } });
      } catch { await sessionStore.clear().catch(() => {}); throw new GatewayClientError("AUTH_REQUIRED"); }
    }
    if (!response.ok) await rawFailure(response);
    return response;
  }
  async function login(input) {
    safeObject(input);
    if (typeof input.username !== "string" || !input.username.trim() || typeof input.password !== "string" || !input.password) throw new GatewayClientError("INVALID_REQUEST");
    const body = { username: input.username.trim(), password: input.password };
    if (input.machineCode !== undefined) body.machineCode = String(input.machineCode).trim();
    try { return { ok: true, user: (await saveSession(await networkRequest("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))).user }; } catch (error) { if (error.code === "AUTH_REQUIRED" || error.code === "AUTH_FAILED") throw new GatewayClientError("AUTH_FAILED"); throw error; }
  }
  async function register(input) {
    safeObject(input);
    const username = typeof input.username === "string" ? input.username.trim() : "";
    const password = typeof input.password === "string" ? input.password : "";
    if (username.length < 3 || username.length > 80 || password.length < 6 || password.length > 256) throw new GatewayClientError("INVALID_REQUEST");
    const body = { username, password, machineCode };
    if (input.inviteCode !== undefined) {
      const inviteCode = String(input.inviteCode || "").trim();
      if (inviteCode.length > 64) throw new GatewayClientError("INVALID_REQUEST");
      if (inviteCode) body.inviteCode = inviteCode;
    }
    try {
      const session = await saveSession(await networkRequest("/api/auth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
      return { ok: true, user: session.user };
    } catch (error) {
      if (error.code === "AUTH_FAILED") throw new GatewayClientError("REGISTRATION_FAILED");
      throw error;
    }
  }
  async function logout() { await sessionStore.clear(); return { ok: true, loggedIn: false }; }
  async function accountStatus() {
    const session = await readSession();
    if (!session) return { ok: true, loggedIn: false, user: null };
    const payload = await authenticatedRequest("/api/balance", {}, true);
    const user = publicUser(payload.user || session.user);
    if (!user?.username) throw new GatewayClientError("RESPONSE_INVALID");
    await sessionStore.save({ ...session, user });
    return { ok: true, loggedIn: true, active: payload.active !== false, balance: user.balance, user };
  }
  async function connectionStatus() {
    try { await networkRequest("/healthz"); return { ok: true, online: true }; } catch (error) { return { ok: false, online: false, error: { code: "SERVER_OFFLINE", message: error.message } }; }
  }
  async function listModels() {
    const payload = await authenticatedRequest("/api/models");
    const raw = Array.isArray(payload.data) ? payload.data : payload.models;
    if (!Array.isArray(raw)) throw new GatewayClientError("RESPONSE_INVALID");
    const models = raw.map((item) => {
      if (!item || typeof item.id !== "string" || !item.id) throw new GatewayClientError("RESPONSE_INVALID");
      return sanitizePublicValue(item);
    });
    return { ok: true, models };
  }
  async function callModels(input) {
    safeObject(input);
    const allowed = new Set(["prompt", "system", "modelIds", "taskLabel", "onDelta", "streamRetries", "requestId", "maxTokens"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new GatewayClientError("INVALID_REQUEST");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 200_000) throw new GatewayClientError("INVALID_REQUEST");
    if (!Array.isArray(input.modelIds) || input.modelIds.length < 1 || input.modelIds.length > 8 || input.modelIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) throw new GatewayClientError("INVALID_REQUEST");
    if (input.system !== undefined && (typeof input.system !== "string" || input.system.length > 100_000)) throw new GatewayClientError("INVALID_REQUEST");
    if (input.taskLabel !== undefined && (typeof input.taskLabel !== "string" || input.taskLabel.length > 64)) throw new GatewayClientError("INVALID_REQUEST");
    if (input.onDelta !== undefined && typeof input.onDelta !== "function") throw new GatewayClientError("INVALID_REQUEST");
    if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(input.requestId))) throw new GatewayClientError("INVALID_REQUEST");
    if (input.maxTokens !== undefined && (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 256 || input.maxTokens > 65536)) throw new GatewayClientError("INVALID_REQUEST");
    const available = new Set((await listModels()).models.map((item) => item.id));
    if (input.modelIds.some((id) => !available.has(id))) throw new GatewayClientError("INVALID_REQUEST");
    const outputs = [];
    let content = "";
    for (const model of [...new Set(input.modelIds)]) {
      const messages = [];
      if (input.system) messages.push({ role: "system", content: input.system });
      messages.push({ role: "user", content: input.prompt });
      if (content) messages.push({ role: "assistant", content }, { role: "user", content: "Review the previous version and return a complete improved version." });

      // Submit once by default. A timeout must never trigger a second long generation.
      const maxStreamAttempts = Number.isSafeInteger(input.streamRetries) ? Math.max(1, Math.min(input.streamRetries, 2)) : 1;
      const requestId = input.requestId || crypto.randomUUID();
      let next = "";
      let usage = null;
      let transport = "none";
      let lastError = null;
      let allowNonStreamFallback = false;

      for (let attempt = 1; attempt <= maxStreamAttempts; attempt += 1) {
        try {
          const response = await authenticatedRawRequest("/e/catalog/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", "x-workflow-operation": String(input.taskLabel || "fiction").slice(0, 32), "idempotency-key": requestId },
            body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: input.maxTokens || 24_000, stream: true }),
            timeoutMs: streamTimeoutMs
          });
          const payload = await collectOpenAiStream(response, input.onDelta, { maxResponseBytes });
          if (String(payload.finishReason || "").toLowerCase() === "length") throw incompleteStreamError("Model output reached its token limit.", { partialContent: payload.content, partialReasoning: payload.reasoning || "", finishReason: payload.finishReason });
          next = payload.content;
          usage = payload.usage || null;
          if (typeof next === "string" && next.trim()) {
            transport = "stream_attempt_" + attempt;
            break;
          }
          lastError = new GatewayClientError("EMPTY_MODEL_OUTPUT");
          allowNonStreamFallback = true;
        } catch (error) {
          lastError = toGatewayNetworkError(error, "SERVER_ERROR");
          if (lastError.code !== "SERVER_OFFLINE") break;
        }
      }

      if (!(typeof next === "string" && next.trim()) && allowNonStreamFallback) {
        try {
          const response = await authenticatedRawRequest("/e/catalog/chat/completions", {
            method: "POST",
            headers: { "content-type": "application/json", "x-workflow-operation": String(input.taskLabel || "fiction").slice(0, 32), "idempotency-key": requestId },
            body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: input.maxTokens || 24_000, stream: false }),
            timeoutMs: streamTimeoutMs
          });
          const text = await response.text();
          if (Buffer.byteLength(text, "utf8") > maxResponseBytes) throw new GatewayClientError("RESPONSE_TOO_LARGE");
          const payload = JSON.parse(text);
          const parts = completionParts(payload);
          if (String(parts.finishReason || "").toLowerCase() === "length") throw incompleteStreamError("Model output reached its token limit.", { partialContent: parts.content, partialReasoning: parts.reasoning || "", finishReason: parts.finishReason });
          next = parts.content;
          usage = parts.usage;
          if (typeof next === "string" && next.trim()) transport = "non_stream_fallback";
        } catch (error) {
          lastError = toGatewayNetworkError(error, "SERVER_ERROR");
        }
      }

      if (typeof next !== "string" || !next.trim()) {
        throw lastError || new GatewayClientError("RESPONSE_INVALID");
      }
      content = next.trim();
      outputs.push({ model, content, usage: sanitizePublicValue(usage), transport });
    }
    return { ok: true, modelIds: [...new Set(input.modelIds)], outputs, content };
  }
  async function listWorkflows() {
    const payload = await authenticatedRequest("/api/workflows");
    if (!Array.isArray(payload.data)) throw new GatewayClientError("RESPONSE_INVALID");
    return {
      ok: true,
      policyVersion: typeof payload.policyVersion === "string" ? payload.policyVersion : null,
      workflows: sanitizePublicValue(payload.data)
    };
  }
  async function runWorkflow(input) {
    safeObject(input);
    const allowed = new Set(["workflowId", "idempotencyKey", "mode", "input"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new GatewayClientError("INVALID_REQUEST");
    const workflowId = typeof input.workflowId === "string" ? input.workflowId.trim() : "";
    const mode = input.mode;
    const idempotencyKey = input.idempotencyKey === undefined ? crypto.randomUUID() : input.idempotencyKey;
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(workflowId)
      || (mode !== "quick" && mode !== "deep")
      || !input.input || typeof input.input !== "object" || Array.isArray(input.input)
      || typeof idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(idempotencyKey)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    const payload = await authenticatedRequest(`/api/workflows/${encodeURIComponent(workflowId)}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
      body: JSON.stringify({ mode, input: input.input })
    });
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new GatewayClientError("RESPONSE_INVALID");
    return sanitizePublicValue(payload.data);
  }
  async function getRun(input) {
    safeObject(input);
    if (Object.keys(input).length !== 1 || typeof input.runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(input.runId)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    const payload = await authenticatedRequest(`/api/workflow-runs/${encodeURIComponent(input.runId)}`);
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new GatewayClientError("RESPONSE_INVALID");
    return sanitizePublicValue(payload.data);
  }
  async function getHumanizerLibrary() {
    const payload = await authenticatedRequest("/api/v3/rule-library");
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new GatewayClientError("RESPONSE_INVALID");
    return sanitizePublicValue(payload.data);
  }
  async function getHumanizerEffectiveManifest() {
    const payload = await authenticatedRequest("/api/v3/rule-library/effective-manifest");
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new GatewayClientError("RESPONSE_INVALID");
    return sanitizePublicValue(payload.data);
  }
  async function saveHumanizerRuleDraft(input) {
    safeObject(input);
    if (Object.keys(input).some((key) => key !== "idempotencyKey" && key !== "draft")
      || typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim() || input.idempotencyKey.length > 128
      || !input.draft || typeof input.draft !== "object" || Array.isArray(input.draft)) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    const payload = await authenticatedRequest("/api/v3/rule-library/drafts", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({ draft: input.draft })
    });
    if (!payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) throw new GatewayClientError("RESPONSE_INVALID");
    return sanitizePublicValue(payload.data);
  }
  async function redeemRechargeCode(input) {
    safeObject(input);
    if (typeof input.code !== "string") throw new GatewayClientError("INVALID_REQUEST");
    const code = input.code.trim().replace(/\s+/gu, "");
    if (code.length < 6 || code.length > 128) throw new GatewayClientError("INVALID_REQUEST");
    const payload = await authenticatedRequest("/api/redeem", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }, false);
    return { ok: payload.ok !== false, balance: payload.balance, credited: payload.credited, currency: payload.currency, expiresAt: payload.expiresAt };
  }
  async function proxyChatCompletions(input) {
    safeObject(input);
    const model = typeof input.model === "string" ? input.model.trim() : "";
    if (!model || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/u.test(model)) throw new GatewayClientError("INVALID_REQUEST");
    if (!Array.isArray(input.messages) || input.messages.length > 4096) throw new GatewayClientError("INVALID_REQUEST");
    if (input.stream !== undefined && typeof input.stream !== "boolean") throw new GatewayClientError("INVALID_REQUEST");
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body, "utf8") > 4 * 1024 * 1024) throw new GatewayClientError("INVALID_REQUEST");
    const available = new Set((await listModels()).models.map((item) => item.id));
    if (!available.has(model)) throw new GatewayClientError("INVALID_REQUEST");
    return authenticatedRawRequest("/e/catalog/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "x-workflow-operation": "ainovel" },
      body,
      timeoutMs: streamTimeoutMs
    });
  }
  return Object.freeze({ accountStatus, callModels, connectionStatus, getHumanizerEffectiveManifest, getHumanizerLibrary, getRun, listModels, listWorkflows, login, logout, proxyChatCompletions, redeemRechargeCode, register, runWorkflow, saveHumanizerRuleDraft, baseUrl });
}

module.exports = { DEFAULT_GATEWAY, ERROR_MESSAGES, GatewayClientError, createGatewayClient, collectOpenAiStream, completionContent, completionParts, DEFAULT_MAX_RESPONSE_BYTES, isTimeoutError, toGatewayNetworkError };
