"use strict";

const { filterDisabledModels, isDisabledModel } = require("./disabled-models");

function uniqueModels(models) {
  const seen = new Set();
  const out = [];
  for (const model of models) {
    const id = model && typeof model.id === "string" ? model.id : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(model);
  }
  return out;
}

const LEGACY_PREFERRED = new Set(["minimax-m3", "kimi-k3"]);

function createHybridGateway({ primary, secondary, label, allowedModels = [], preferredModel = "", creditsPerCall = 10, balance = -1, modelCredits = null } = {}) {
  if (!primary || typeof primary.listModels !== "function" || typeof primary.callModels !== "function") {
    throw new TypeError("primary gateway is required");
  }
  if (!secondary || typeof secondary.listModels !== "function" || typeof secondary.callModels !== "function") {
    throw new TypeError("secondary gateway is required");
  }
  const allow = Array.isArray(allowedModels)
    ? [...new Set(allowedModels.map((item) => String(item || "").trim()).filter((item) => item && !isDisabledModel(item)))]
    : [];
  const allowSet = new Set(allow);
  const creditMap = modelCredits && typeof modelCredits === "object" && !Array.isArray(modelCredits)
    ? modelCredits
    : (primary && primary.modelCredits) || {"claude-sonnet-5":10,"claude-opus-4-6":20,"kimi-k3":30,"gemini-3.1-pro-preview":10,"gemini-3.5-flash":5,"doubao-seed-2-1-turbo":10,"glm-5.2":10,"minimax-m3":5,"deepseek-v4-flash":5,"deepseek-v4-pro":10,"kimi-k2.6":10};

  async function safeList(gateway) {
    try {
      const payload = await gateway.listModels();
      const models = Array.isArray(payload) ? payload : payload && payload.models;
      return filterDisabledModels(models);
    } catch {
      return [];
    }
  }

  async function listModels() {
    const lists = await Promise.all([safeList(primary), safeList(secondary)]);
    const primaryModels = lists[0].map((item) => Object.assign({}, item, { source: "primary", pool: item.pool || "primary" }));
    const secondaryModels = lists[1].map((item) => Object.assign({}, item, { source: "secondary", pool: item.pool || "legacy" }));
    const ordered = [];
    for (const item of primaryModels) {
      if (LEGACY_PREFERRED.has(item.id) && secondaryModels.some((s) => s.id === item.id)) continue;
      ordered.push(item);
    }
    for (const item of secondaryModels) ordered.push(item);
    let models = uniqueModels(ordered);
    if (allowSet.size) models = models.filter((item) => allowSet.has(item.id));
    models = models.map((item) => {
      const credits = Number(item.credits ?? creditMap[item.id] ?? creditsPerCall ?? 2);
      return Object.assign({}, item, { credits: Number.isFinite(credits) && credits > 0 ? credits : 2 });
    });
    if (preferredModel) {
      models.sort((left, right) => Number(right.id === preferredModel) - Number(left.id === preferredModel));
    }
    return { ok: true, models: models, preferredModel: preferredModel || null, allowedModels: allow, modelCredits: creditMap };
  }

  async function pickGateway(modelIds) {
    const ids = Array.isArray(modelIds) ? modelIds : [];
    if (ids.some((id) => LEGACY_PREFERRED.has(String(id || "")))) return secondary;
    const primaryIds = new Set(Array.isArray(primary.allowedModels) ? primary.allowedModels : []);
    if (!primaryIds.size || (ids.length && ids.every((id) => primaryIds.has(id)))) return primary;
    return secondary;
  }

  async function callModels(input) {
    if (Array.isArray(input?.modelIds) && input.modelIds.some(isDisabledModel)) {
      const error = new Error("Requested model is disabled.");
      error.code = "MODEL_DISABLED";
      throw error;
    }
    const preferred = await pickGateway(input && input.modelIds);
    return preferred.callModels(input);
  }

  async function accountStatus() {
    let primaryStatus = null;
    let secondaryStatus = null;
    try { primaryStatus = await primary.accountStatus(); } catch (e) {}
    try { secondaryStatus = await secondary.accountStatus(); } catch (e) {}
    const loggedIn = (primaryStatus && primaryStatus.loggedIn === true) || (secondaryStatus && secondaryStatus.loggedIn === true);
    if (!loggedIn) return { ok: true, loggedIn: false, active: false, user: null };
    const baseUser = Object.assign({}, (secondaryStatus && secondaryStatus.user) || {}, (primaryStatus && primaryStatus.user) || {});
    const user = Object.assign({}, baseUser, {
      plan: "unlimited",
      accountType: "api_key",
      balance: balance,
      creditsPerCall: creditsPerCall,
      modelCredits: creditMap,
      callsLeft: Number(balance) < 0 ? -1 : Math.max(1, Math.floor(Number(balance) / Math.max(Number(creditsPerCall) || 2, 1))),
      quota: (secondaryStatus && secondaryStatus.user && secondaryStatus.user.quota) || (primaryStatus && primaryStatus.user && primaryStatus.user.quota) || allow.length,
      used: (secondaryStatus && secondaryStatus.user && secondaryStatus.user.used) || (primaryStatus && primaryStatus.user && primaryStatus.user.used) || 0,
      username: (primaryStatus && primaryStatus.user && primaryStatus.user.username) || (secondaryStatus && secondaryStatus.user && secondaryStatus.user.username) || "hybrid"
    });
    return { ok: true, loggedIn: true, active: true, balance: balance, user: user };
  }

  async function connectionStatus() {
    return { ok: true, online: null, probeDisabled: true };
  }

  async function login(input) {
    if (input && (input.apiKey || (input.password && String(input.password).indexOf("sk-") === 0))) {
      return primary.login(input);
    }
    if (typeof secondary.login === "function") return secondary.login(input);
    return primary.login(input);
  }

  async function logout() {
    const tasks = [];
    if (typeof primary.logout === "function") tasks.push(primary.logout().catch(function () { return null; }));
    if (typeof secondary.logout === "function") tasks.push(secondary.logout().catch(function () { return null; }));
    await Promise.all(tasks);
    return { ok: true, loggedIn: false };
  }

  return Object.freeze({
    kind: "hybrid",
    label: label || "平价站 + 扩展模型源",
    baseUrl: primary.baseUrl,
    preferredModel: preferredModel || null,
    allowedModels: allow,
    modelCredits: creditMap,
    creditsPerCall: creditsPerCall,
    balance: balance,
    accountStatus: accountStatus,
    callModels: callModels,
    connectionStatus: connectionStatus,
    listModels: listModels,
    login: login,
    logout: logout,
    primary: primary,
    secondary: secondary
  });
}

module.exports = { createHybridGateway: createHybridGateway };
