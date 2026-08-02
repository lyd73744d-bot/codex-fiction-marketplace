"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { isDisabledModel } = require("./disabled-models");

const DEFAULT_MODEL_CREDITS = Object.freeze({
  "claude-sonnet-5": 10,
  "claude-opus-4-6": 20,
  "seed-2.1-pro": 20,
  "seed-2.1-turbo": 10,
  "gemini-3.1-pro-preview": 10,
  "glm-5.2": 10,
  "minimax-m3": 5,
  "gemini-3.5-flash": 5,
  "qwen3.7-max": 5,
  "grok-4.5": 5,
  "gpt-image-2": 50
});
const DEFAULT_MODELS = Object.freeze(Object.keys(DEFAULT_MODEL_CREDITS));

function defaultConfigPath() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(root, "Zizhuji", "longform-fiction-director", "primary-gateway.json");
}

function normalizeOpenAiBaseUrl(raw) {
  const parsed = new URL(String(raw || "").trim());
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("gateway baseUrl protocol is invalid");
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("gateway baseUrl must not include credentials or query");
  // allow root or trailing slash only
  if (parsed.pathname && parsed.pathname !== "/") throw new Error("gateway baseUrl must be origin only");
  return parsed.origin;
}

function normalizeModelCredits(value, allowedModels = []) {
  const out = {};
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const defaults = DEFAULT_MODEL_CREDITS;
  const ids = Array.isArray(allowedModels) && allowedModels.length
    ? allowedModels
    : Object.keys(Object.assign({}, defaults, source));
  for (const id of ids) {
    if (isDisabledModel(id)) continue;
    const raw = source[id] ?? defaults[id] ?? 2;
    const n = Number(raw);
    out[id] = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 9999) : (defaults[id] || 2);
  }
  return out;
}

function normalizeModelList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => String(item || "").trim())
    .filter((item) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item) && !isDisabledModel(item)))].slice(0, 32);
}

function readConfigFile(configPath) {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Primary gateway selection.
 * mode=openai uses OpenAI-compatible /v1 endpoints with API key.
 * mode=legacy uses the existing username/password fiction gateway.
 */
function loadPrimaryGatewayConfig(options = {}) {
  const configPath = options.configPath || process.env.FICTION_DIRECTOR_GATEWAY_CONFIG || defaultConfigPath();
  const file = readConfigFile(configPath) || {};
  const envMode = String(process.env.FICTION_DIRECTOR_GATEWAY_MODE || "").trim().toLowerCase();
  const mode = String(options.mode || envMode || file.mode || "legacy").trim().toLowerCase();
  const baseUrlRaw = options.baseUrl
    || process.env.FICTION_DIRECTOR_GATEWAY_URL
    || file.baseUrl
    || "";
  const apiKey = options.apiKey
    || process.env.FICTION_DIRECTOR_GATEWAY_API_KEY
    || file.apiKey
    || "";
  const gptApiKey = options.gptApiKey
    || process.env.FICTION_DIRECTOR_GPT_API_KEY
    || file.gptApiKey
    || "";
  const nexaApiKey = options.nexaApiKey
    || process.env.FICTION_DIRECTOR_NEXA_API_KEY
    || file.nexaApiKey
    || "";
  const nexaBaseUrlRaw = options.nexaBaseUrl
    || process.env.FICTION_DIRECTOR_NEXA_BASE_URL
    || file.nexaBaseUrl
    || "https://api.nexagw.org";
  const geminiApiKey = options.geminiApiKey
    || process.env.FICTION_DIRECTOR_GEMINI_API_KEY
    || file.geminiApiKey
    || "";
  const geminiBaseUrlRaw = options.geminiBaseUrl
    || process.env.FICTION_DIRECTOR_GEMINI_BASE_URL
    || file.geminiBaseUrl
    || "https://byteclaude.io";
  const label = options.label || file.label || (mode === "openai" ? "平价站第一模型源" : "默认模型源");

  if (mode === "openai") {
    if (!baseUrlRaw || !apiKey) {
      return {
        mode: "openai",
        ready: false,
        configPath,
        label,
        reason: "OpenAI-compatible primary gateway needs baseUrl and apiKey."
      };
    }
    const configuredPreferred = String(options.preferredModel || process.env.FICTION_DIRECTOR_PREFERRED_MODEL || file.preferredModel || "claude-opus-4-6").trim();
    const preferredModel = isDisabledModel(configuredPreferred) ? "claude-opus-4-6" : configuredPreferred;
    const allowedModels = normalizeModelList(
      options.allowedModels
      || (process.env.FICTION_DIRECTOR_ALLOWED_MODELS ? String(process.env.FICTION_DIRECTOR_ALLOWED_MODELS).split(/[,\s]+/) : null)
      || file.allowedModels
      || [preferredModel || "claude-opus-4-6", "claude-sonnet-5"]
    );
    const allowed = allowedModels.length ? allowedModels : [...DEFAULT_MODELS];
    const modelCredits = normalizeModelCredits(options.modelCredits || file.modelCredits, allowed);
    const creditsPerCall = Number(options.creditsPerCall ?? process.env.FICTION_DIRECTOR_CREDITS_PER_CALL ?? file.creditsPerCall ?? modelCredits[preferredModel] ?? 10);
    const balance = Number(options.balance ?? process.env.FICTION_DIRECTOR_BALANCE ?? file.balance ?? -1);
    return {
      mode: "openai",
      ready: true,
      configPath,
      label,
      baseUrl: normalizeOpenAiBaseUrl(baseUrlRaw),
      apiKey: String(apiKey).trim(),
      gptApiKey: String(gptApiKey || "").trim(),
      nexaApiKey: String(nexaApiKey || "").trim(),
      nexaBaseUrl: (() => { try { return normalizeOpenAiBaseUrl(nexaBaseUrlRaw); } catch { return "https://api.nexagw.org"; } })(),
      geminiApiKey: String(geminiApiKey || "").trim(),
      geminiBaseUrl: (() => { try { return normalizeOpenAiBaseUrl(geminiBaseUrlRaw); } catch { return "https://byteclaude.io"; } })(),
      preferredModel: preferredModel || "claude-opus-4-6",
      allowedModels: allowed,
      modelCredits,
      creditsPerCall: Number.isFinite(creditsPerCall) ? creditsPerCall : 10,
      balance: Number.isFinite(balance) ? balance : -1,
      priority: 1
    };
  }

  return {
    mode: "legacy",
    ready: true,
    configPath,
    label,
    baseUrl: options.baseUrl || process.env.FICTION_DIRECTOR_GATEWAY_URL || file.baseUrl || undefined,
    priority: 2
  };
}

async function savePrimaryGatewayConfig(input = {}, options = {}) {
  const configPath = options.configPath || process.env.FICTION_DIRECTOR_GATEWAY_CONFIG || defaultConfigPath();
  const mode = String(input.mode || "openai").trim().toLowerCase();
  const payload = {
    mode,
    label: String(input.label || "平价站第一模型源").slice(0, 80),
    baseUrl: mode === "openai" ? normalizeOpenAiBaseUrl(input.baseUrl) : String(input.baseUrl || "").trim(),
    preferredModel: (() => {
      const value = String(input.preferredModel || "claude-opus-4-6").trim() || "claude-opus-4-6";
      return isDisabledModel(value) ? "claude-opus-4-6" : value;
    })(),
    allowedModels: normalizeModelList(input.allowedModels || DEFAULT_MODELS),
    modelCredits: normalizeModelCredits(input.modelCredits, input.allowedModels || ["claude-opus-4-6", "claude-sonnet-5"]),
    creditsPerCall: Number(input.creditsPerCall ?? 10),
    balance: Number(input.balance ?? -1),
    updatedAt: new Date().toISOString()
  };
  if (!payload.allowedModels.length) payload.allowedModels = [...DEFAULT_MODELS];
  payload.modelCredits = normalizeModelCredits(payload.modelCredits, payload.allowedModels);
  if (!Number.isFinite(payload.creditsPerCall)) payload.creditsPerCall = payload.modelCredits[payload.preferredModel] || 10;
  if (!Number.isFinite(payload.balance)) payload.balance = -1;
  if (mode === "openai") {
    const apiKey = String(input.apiKey || "").trim();
    if (!apiKey || apiKey.length < 8 || apiKey.length > 512) throw new Error("apiKey is required");
    payload.apiKey = apiKey;
    const gptApiKey = String(input.gptApiKey || "").trim();
    if (gptApiKey) {
      if (gptApiKey.length < 8 || gptApiKey.length > 512) throw new Error("gptApiKey is invalid");
      payload.gptApiKey = gptApiKey;
    }
    const nexaApiKey = String(input.nexaApiKey || "").trim();
    if (nexaApiKey) {
      if (nexaApiKey.length < 8 || nexaApiKey.length > 512) throw new Error("nexaApiKey is invalid");
      payload.nexaApiKey = nexaApiKey;
    }
    const nexaBaseUrl = String(input.nexaBaseUrl || "https://api.nexagw.org").trim();
    if (nexaBaseUrl) {
      payload.nexaBaseUrl = normalizeOpenAiBaseUrl(nexaBaseUrl);
    }
    const geminiApiKey = String(input.geminiApiKey || "").trim();
    if (geminiApiKey) {
      if (geminiApiKey.length < 8 || geminiApiKey.length > 512) throw new Error("geminiApiKey is invalid");
      payload.geminiApiKey = geminiApiKey;
    }
    const geminiBaseUrl = String(input.geminiBaseUrl || "https://byteclaude.io").trim();
    if (geminiBaseUrl) {
      payload.geminiBaseUrl = normalizeOpenAiBaseUrl(geminiBaseUrl);
    }
  }
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { configPath, mode: payload.mode, baseUrl: payload.baseUrl, label: payload.label, preferredModel: payload.preferredModel, allowedModels: payload.allowedModels, modelCredits: payload.modelCredits, creditsPerCall: payload.creditsPerCall, balance: payload.balance };
}

module.exports = {
  defaultConfigPath,
  loadPrimaryGatewayConfig,
  savePrimaryGatewayConfig,
  normalizeOpenAiBaseUrl,
  normalizeModelCredits,
  DEFAULT_MODELS,
  DEFAULT_MODEL_CREDITS
};
