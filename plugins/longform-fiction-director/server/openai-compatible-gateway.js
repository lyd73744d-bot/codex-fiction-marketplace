"use strict";

const crypto = require("node:crypto");
const { GatewayClientError } = require("./gateway-client");
const { SessionStoreError, createSessionStore, publicUser } = require("./session-store");

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function completionContent(payload) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.delta?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").join("");
  return "";
}

async function collectOpenAiStream(response, onDelta) {
  const contentType = response.headers?.get?.("content-type") || "";
  if (!/text\/event-stream/iu.test(contentType)) {
    let text;
    try { text = await response.text(); } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new GatewayClientError("RESPONSE_INVALID");
    let payload;
    try { payload = JSON.parse(text); } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    const content = completionContent(payload);
    if (!content.trim()) throw new GatewayClientError("RESPONSE_INVALID");
    if (typeof onDelta === "function") await onDelta(content);
    return { content, usage: payload?.usage || null };
  }

  const reader = response.body?.getReader?.();
  if (!reader) throw new GatewayClientError("RESPONSE_INVALID");
  const decoder = new TextDecoder();
  let receivedBytes = 0;
  let buffer = "";
  let content = "";
  let usage = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value?.byteLength || 0;
    if (receivedBytes > MAX_RESPONSE_BYTES) throw new GatewayClientError("RESPONSE_INVALID");
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\r?\n\r?\n/);
    buffer = chunks.pop() || "";
    for (const chunk of chunks) {
      const lines = chunk.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }
        if (payload?.usage) usage = payload.usage;
        const delta = completionContent(payload);
        if (!delta) continue;
        content += delta;
        if (typeof onDelta === "function") await onDelta(delta);
      }
    }
  }
  if (!content.trim()) throw new GatewayClientError("RESPONSE_INVALID");
  return { content, usage };
}

function createOpenAiCompatibleGateway(options = {}) {
  const baseUrl = String(options.baseUrl || "").replace(/\/+$/u, "");
  if (!/^https?:\/\//u.test(baseUrl)) throw new TypeError("baseUrl is required");
  const fetcher = options.fetch || globalThis.fetch;
  if (typeof fetcher !== "function") throw new TypeError("fetch implementation is required");
  const sessionStore = options.sessionStore || createSessionStore(options.sessionOptions);
  const label = options.label || "OpenAI-compatible";
  const defaultApiKey = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  const gptApiKey = typeof options.gptApiKey === "string" ? options.gptApiKey.trim() : "";
  const nexaApiKey = typeof options.nexaApiKey === "string" ? options.nexaApiKey.trim() : "";
  const nexaBaseUrl = String(options.nexaBaseUrl || "https://api.nexagw.org").replace(/\/+$/u, "");
  const nexaModels = new Set(Array.isArray(options.nexaModels) && options.nexaModels.length
    ? options.nexaModels.map((item) => String(item || "").trim()).filter(Boolean)
    : ["glm-5.2", "deepseek-v4-flash", "minimax-m3"]);
  const geminiApiKey = typeof options.geminiApiKey === "string" ? options.geminiApiKey.trim() : "";
  const geminiBaseUrl = String(options.geminiBaseUrl || "https://byteclaude.io").replace(/\/+$/u, "");
  const geminiModels = new Set(Array.isArray(options.geminiModels) && options.geminiModels.length
    ? options.geminiModels.map((item) => String(item || "").trim()).filter(Boolean)
    : ["gemini-3.1-pro-preview","gemini-3.5-flash"]);
  const preferredModel = typeof options.preferredModel === "string" ? options.preferredModel.trim() : "";
  const allowedModels = Array.isArray(options.allowedModels)
    ? [...new Set(options.allowedModels.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
  const creditsPerCall = Number.isFinite(Number(options.creditsPerCall)) ? Number(options.creditsPerCall) : 10;
  const displayBalance = Number.isFinite(Number(options.balance)) ? Number(options.balance) : -1;
  const displayCallsLeft = displayBalance < 0 ? -1 : 999;
  const modelCredits = options.modelCredits && typeof options.modelCredits === "object" && !Array.isArray(options.modelCredits)
    ? options.modelCredits
    : {"claude-opus-4-8":10,"claude-opus-4-6":10,"claude-sonnet-5":5,"gpt-5.6-sol":10,"gpt-5.6-terra":5,"gpt-5.6-luna":2,"gpt-image-2":50,"glm-5.2":5,"deepseek-v4-flash":1,"minimax-m3":1,"gemini-3.1-pro-preview":10,"gemini-3.5-flash":2,"kimi-k2.6":10,"seed-2.1-pro":10};
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : 120_000;
  const streamTimeoutMs = Number.isSafeInteger(options.streamTimeoutMs) && options.streamTimeoutMs > 0 ? options.streamTimeoutMs : 20 * 60_000;

  function isNexaModel(modelId) {
    const id = String(modelId || "").trim();
    return nexaModels.has(id) || nexaModels.has(id.toLowerCase());
  }

  function isGeminiModel(modelId) {
    const id = String(modelId || "").trim();
    if (geminiModels.has(id) || geminiModels.has(id.toLowerCase())) return true;
    return /^gemini-/i.test(id);
  }

  function poolForModel(modelId) {
    const id = String(modelId || "");
    if (isGeminiModel(id)) return "gemini";
    if (isNexaModel(id)) return "nexa";
    if (/^gpt-/i.test(id) || /gpt-image/i.test(id)) return "gpt";
    return "claude";
  }

  function endpointForModel(modelId) {
    if (isGeminiModel(modelId)) return geminiBaseUrl || baseUrl;
    if (isNexaModel(modelId)) return nexaBaseUrl || baseUrl;
    return baseUrl;
  }

  function keyForModel(modelId) {
    const id = String(modelId || "").toLowerCase();
    if (isGeminiModel(modelId)) return geminiApiKey || defaultApiKey;
    if (isNexaModel(modelId)) return nexaApiKey || defaultApiKey;
    if (/^gpt-/i.test(id) || /gpt-image/i.test(id)) return gptApiKey || defaultApiKey;
    return defaultApiKey;
  }

  async function readApiKey(modelId) {
    const byModel = keyForModel(modelId);
    if (byModel) return byModel;
    if (defaultApiKey) return defaultApiKey;
    try {
      const session = await sessionStore.read();
      if (session?.accessToken) return session.accessToken;
    } catch (error) {
      if (!(error instanceof SessionStoreError)) throw error;
    }
    return "";
  }

  async function requireApiKey(modelId) {
    const key = await readApiKey(modelId);
    if (!key) throw new GatewayClientError("AUTH_REQUIRED");
    return key;
  }

  async function networkRequest(pathname, init = {}) {
    const origin = String(init.origin || baseUrl).replace(/\/+$/u, "");
    let response;
    try {
      response = await fetcher(`${origin}${pathname}`, {
        method: init.method || "GET",
        headers: init.headers || {},
        body: init.body,
        redirect: "error",
        signal: AbortSignal.timeout(init.timeoutMs || timeoutMs)
      });
    } catch {
      throw new GatewayClientError("SERVER_OFFLINE");
    }
    let text = "";
    try { text = await response.text(); } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new GatewayClientError("RESPONSE_INVALID");
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch {
      if (!response.ok) throw new GatewayClientError("SERVER_ERROR");
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new GatewayClientError("AUTH_FAILED");
      if (response.status === 402) throw new GatewayClientError("INSUFFICIENT_BALANCE");
      throw new GatewayClientError("SERVER_ERROR", undefined, response.status);
    }
    return payload;
  }

  async function login(input = {}) {
    const apiKey = String(input.apiKey || input.password || input.token || "").trim();
    if (!apiKey || apiKey.length < 8) throw new GatewayClientError("INVALID_REQUEST");
    // validate key against /v1/models
    const payload = await networkRequest("/v1/models", {
      headers: { authorization: `Bearer ${apiKey}` }
    });
    const raw = Array.isArray(payload.data) ? payload.data : payload.models;
    if (!Array.isArray(raw)) throw new GatewayClientError("RESPONSE_INVALID");
    const username = String(input.username || "api-key").trim() || "api-key";
    await sessionStore.save({
      accessToken: apiKey,
      refreshToken: `openai-${crypto.randomUUID()}`,
      user: {
        username,
        plan: "openai-compatible",
        balance: displayBalance,
        callsLeft: displayCallsLeft,
        accountType: "api_key",
        active: true
      },
      version: crypto.randomUUID()
    });
    return { ok: true, user: { username, plan: "openai-compatible", balance: displayBalance, creditsPerCall, callsLeft: displayCallsLeft } };
  }

  async function logout() {
    await sessionStore.clear();
    return { ok: true, loggedIn: false };
  }

  async function accountStatus() {
    const key = await readApiKey();
    if (!key) return { ok: true, loggedIn: false, active: false, user: null };
    try {
      const payload = await networkRequest("/v1/models", {
        headers: { authorization: `Bearer ${key}` }
      });
      const raw = Array.isArray(payload.data) ? payload.data : payload.models;
      const count = Array.isArray(raw) ? raw.length : 0;
      let username = "api-key";
      try {
        const session = await sessionStore.read();
        username = session?.user?.username || username;
      } catch {}
      return {
        ok: true,
        loggedIn: true,
        active: true,
        balance: displayBalance,
        user: {
          username,
          plan: "openai-compatible",
          balance: displayBalance,
          callsLeft: displayCallsLeft,
          creditsPerCall,
          accountType: "api_key",
          quota: count,
          used: 0
        }
      };
    } catch (error) {
      if (error instanceof GatewayClientError && (error.code === "AUTH_FAILED" || error.code === "AUTH_REQUIRED")) {
        return { ok: true, loggedIn: false, active: false, user: null };
      }
      throw error;
    }
  }

  async function connectionStatus() {
    try {
      const response = await fetcher(`${baseUrl}/health`, { method: "GET", redirect: "error", signal: AbortSignal.timeout(8_000) });
      if (response.ok) return { ok: true, online: true };
    } catch {}
    try {
      await networkRequest("/v1/models", { headers: { authorization: `Bearer ${await requireApiKey()}` } });
      return { ok: true, online: true };
    } catch (error) {
      return { ok: false, online: false, error: { code: error.code || "SERVER_OFFLINE", message: error.message } };
    }
  }

  async function listModels() {
    const pools = [];
    if (defaultApiKey) pools.push({ key: defaultApiKey, origin: baseUrl, pool: "claude" });
    if (gptApiKey) pools.push({ key: gptApiKey, origin: baseUrl, pool: "gpt" });
    if (nexaApiKey) pools.push({ key: nexaApiKey, origin: nexaBaseUrl || baseUrl, pool: "nexa" });
    if (geminiApiKey) pools.push({ key: geminiApiKey, origin: geminiBaseUrl || baseUrl, pool: "gemini" });
    if (!pools.length) throw new GatewayClientError("AUTH_REQUIRED");
    const merged = new Map();
    for (const pool of pools) {
      let payload;
      try {
        payload = await networkRequest("/v1/models", {
          origin: pool.origin,
          headers: { authorization: `Bearer ${pool.key}` }
        });
      } catch {
        continue;
      }
      const raw = Array.isArray(payload.data) ? payload.data : payload.models;
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        const id = item?.id || item?.name;
        if (typeof id !== "string" || !id) continue;
        const credits = Number(modelCredits[id]);
        merged.set(id, {
          id,
          label: item?.owned_by || item?.label || id,
          credits: Number.isFinite(credits) && credits > 0 ? credits : (creditsPerCall || 2),
          pool: isGeminiModel(id) ? "gemini" : (isNexaModel(id) ? "nexa" : (/^gpt-/i.test(id) || /gpt-image/i.test(id) ? "gpt" : pool.pool))
        });
      }
    }
    // Ensure configured Nexa models still appear even if catalog is partial.
    for (const id of nexaModels) {
      if (merged.has(id)) continue;
      if (allowedModels.length && !allowedModels.includes(id)) continue;
      if (!nexaApiKey) continue;
      const credits = Number(modelCredits[id]);
      merged.set(id, {
        id,
        label: id,
        credits: Number.isFinite(credits) && credits > 0 ? credits : 1,
        pool: "nexa"
      });
    }
    for (const id of geminiModels) {
      if (merged.has(id)) continue;
      if (allowedModels.length && !allowedModels.includes(id)) continue;
      if (!geminiApiKey) continue;
      const credits = Number(modelCredits[id]);
      merged.set(id, {
        id,
        label: id,
        credits: Number.isFinite(credits) && credits > 0 ? credits : 1,
        pool: "gemini"
      });
    }
    let models = [...merged.values()];
    if (allowedModels.length) {
      const allow = new Set(allowedModels);
      models = models.filter((item) => allow.has(item.id));
    }
    if (preferredModel) {
      models.sort((left, right) => Number(right.id === preferredModel) - Number(left.id === preferredModel));
    }
    return { ok: true, models, preferredModel: preferredModel || null, allowedModels, modelCredits };
  }

  async function generateImage(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new GatewayClientError("INVALID_REQUEST");
    const model = String(input.model || "gpt-image-2").trim() || "gpt-image-2";
    const prompt = String(input.prompt || "").trim();
    if (!prompt || prompt.length > 4000) throw new GatewayClientError("INVALID_REQUEST");
    const size = String(input.size || "1024x1024");
    if (!/^(1024x1024|1536x1024|1024x1536|auto)$/u.test(size)) throw new GatewayClientError("INVALID_REQUEST");
    const key = await requireApiKey(model);
    let response;
    try {
      response = await fetcher(`${baseUrl}/v1/images/generations`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          prompt,
          size,
          n: 1
        }),
        redirect: "error",
        signal: AbortSignal.timeout(streamTimeoutMs)
      });
    } catch {
      throw new GatewayClientError("SERVER_OFFLINE");
    }
    let text = "";
    try { text = await response.text(); } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { throw new GatewayClientError("RESPONSE_INVALID"); }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new GatewayClientError("AUTH_FAILED");
      if (response.status === 402) throw new GatewayClientError("INSUFFICIENT_BALANCE");
      throw new GatewayClientError("SERVER_ERROR", undefined, response.status);
    }
    const first = Array.isArray(payload.data) ? payload.data[0] : null;
    if (!first || (typeof first.b64_json !== "string" && typeof first.url !== "string")) {
      throw new GatewayClientError("RESPONSE_INVALID");
    }
    return {
      ok: true,
      model,
      credits: Number(modelCredits[model]) || 50,
      b64: typeof first.b64_json === "string" ? first.b64_json : null,
      url: typeof first.url === "string" ? first.url : null,
      created: payload.created || null
    };
  }

async function callModels(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new GatewayClientError("INVALID_REQUEST");
    const allowed = new Set(["prompt", "system", "modelIds", "taskLabel", "onDelta", "streamRetries"]);
    if (Object.keys(input).some((key) => !allowed.has(key))) throw new GatewayClientError("INVALID_REQUEST");
    if (typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 200_000) throw new GatewayClientError("INVALID_REQUEST");
    if (!Array.isArray(input.modelIds) || input.modelIds.length < 1 || input.modelIds.length > 8) throw new GatewayClientError("INVALID_REQUEST");
    if (input.modelIds.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) {
      throw new GatewayClientError("INVALID_REQUEST");
    }
    const available = new Set((await listModels()).models.map((item) => item.id));
    // key resolved per model below
    if (input.modelIds.some((id) => !available.has(id))) throw new GatewayClientError("INVALID_REQUEST");

    const outputs = [];
    let content = "";
    for (const model of [...new Set(input.modelIds)]) {
      const messages = [];
      if (input.system) messages.push({ role: "system", content: input.system });
      messages.push({ role: "user", content: input.prompt });
      if (content) {
        messages.push({ role: "assistant", content });
        messages.push({ role: "user", content: "Review the previous version and return a complete improved version." });
      }

      const maxStreamAttempts = Number.isSafeInteger(input.streamRetries) ? Math.max(1, Math.min(input.streamRetries, 5)) : 3;
      let next = "";
      let usage = null;
      let transport = "none";
      let lastError = null;

      async function postOnce(stream) {
        const key = await requireApiKey(model);
        const response = await fetcher(endpointForModel(model) + "/v1/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer " + key,
            "content-type": "application/json"
          },
          body: JSON.stringify({
            model,
            messages,
            temperature: 0.7,
            max_tokens: 12_000,
            stream: !!stream
          }),
          redirect: "error",
          signal: AbortSignal.timeout(streamTimeoutMs)
        });
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) throw new GatewayClientError("AUTH_FAILED");
          if (response.status === 402) throw new GatewayClientError("INSUFFICIENT_BALANCE");
          throw new GatewayClientError("SERVER_ERROR", undefined, response.status);
        }
        if (stream) {
          const payload = await collectOpenAiStream(response, input.onDelta);
          return { content: payload.content, usage: payload.usage || null };
        }
        const payload = await response.json();
        const contentText = completionContent(payload) || String(payload?.choices?.[0]?.message?.content || "");
        return { content: contentText, usage: payload?.usage || null };
      }

      for (let attempt = 1; attempt <= maxStreamAttempts; attempt += 1) {
        try {
          const payload = await postOnce(true);
          next = payload.content;
          usage = payload.usage;
          if (typeof next === "string" && next.trim()) {
            transport = "stream_attempt_" + attempt;
            break;
          }
          lastError = new Error("empty stream content");
        } catch (error) {
          lastError = error;
        }
      }

      if (!(typeof next === "string" && next.trim())) {
        try {
          const payload = await postOnce(false);
          next = payload.content;
          usage = payload.usage;
          if (typeof next === "string" && next.trim()) transport = "non_stream_fallback";
        } catch (error) {
          lastError = error;
        }
      }

      if (typeof next !== "string" || !next.trim()) {
        throw lastError || new GatewayClientError("RESPONSE_INVALID");
      }
      content = next.trim();
      outputs.push({ model, content, usage: usage || null, transport });
    }
    return { ok: true, modelIds: [...new Set(input.modelIds)], outputs, content };
  }

  return Object.freeze({
    kind: "openai-compatible",
    label,
    baseUrl,
    preferredModel: preferredModel || null,
    allowedModels,
    modelCredits,
    creditsPerCall,
    balance: displayBalance,
    gptApiKey: gptApiKey || null,
    nexaApiKey: nexaApiKey || null,
    nexaBaseUrl: nexaBaseUrl || null,
    geminiApiKey: geminiApiKey || null,
    geminiBaseUrl: geminiBaseUrl || null,
    accountStatus,
    callModels,
    connectionStatus,
    listModels,
    generateImage,
    login,
    logout
  });
}

module.exports = { createOpenAiCompatibleGateway };
