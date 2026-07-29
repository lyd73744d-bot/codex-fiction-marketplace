"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_SHOP = process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || "https://catfk.com/shop/ZVZNANU8";

function defaultStatePath() {
  if (process.env.FICTION_DIRECTOR_ONBOARDING_STATE) return process.env.FICTION_DIRECTOR_ONBOARDING_STATE;
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(root, "Zizhuji", "longform-fiction-director", "onboarding-state.json");
}

function emptyState() {
  return {
    version: 2,
    installedAt: null,
    lastInstalledAt: null,
    installCount: 0,
    firstLoginCompletedAt: null,
    lastLoginOkAt: null,
    lastSessionDropAt: null,
    lastPopupAt: null,
    lastPopupReason: null,
    pendingFirstLogin: false,
    modelGatewayBound: false,
    modelGatewayBoundAt: null,
    modelGatewayUnboundAt: null,
    shopUrl: DEFAULT_SHOP,
    notes: "gateway login is optional; install never opens login; only open after explicit user choice"
  };
}

async function ensureDir(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function readState(statePath = defaultStatePath()) {
  try {
    const raw = await fsp.readFile(statePath, "utf8");
    const parsed = JSON.parse(raw);
    const merged = { ...emptyState(), ...parsed, statePath };
    if (!merged.shopUrl) merged.shopUrl = DEFAULT_SHOP;
    // migrate old states: if already logged in once, pendingFirstLogin=false
    if (merged.firstLoginCompletedAt) merged.pendingFirstLogin = false;
    else if (merged.pendingFirstLogin == null) merged.pendingFirstLogin = false;
    return merged;
  } catch {
    return { ...emptyState(), statePath };
  }
}

async function writeState(next, statePath = defaultStatePath()) {
  const value = { ...emptyState(), ...next, statePath };
  if (value.firstLoginCompletedAt) value.pendingFirstLogin = false;
  await ensureDir(statePath);
  const tmp = statePath + ".tmp";
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fsp.rename(tmp, statePath);
  return value;
}

/**
 * Called by installer / first boot. Installation only records state; gateway login
 * remains optional regardless of previous login history.
 */
async function markInstalled(statePath = defaultStatePath()) {
  const now = new Date().toISOString();
  const state = await readState(statePath);
  return writeState({
    ...state,
    installedAt: state.installedAt || now,
    lastInstalledAt: now,
    installCount: Math.max(1, Number(state.installCount || 0) + (state.installedAt ? 0 : 1)),
    pendingFirstLogin: false,
    shopUrl: state.shopUrl || DEFAULT_SHOP
  }, statePath);
}

/**
 * Fresh package install marker from install.cmd.
 * Does NOT wipe firstLoginCompletedAt / lastLoginOkAt.
 * Gateway registration is optional, so package installation never schedules a popup.
 */
async function markPackageInstalled(statePath = defaultStatePath()) {
  const now = new Date().toISOString();
  const state = await readState(statePath);
  return writeState({
    ...state,
    installedAt: state.installedAt || now,
    lastInstalledAt: now,
    installCount: Number(state.installCount || 0) + 1,
    pendingFirstLogin: false,
    shopUrl: state.shopUrl || DEFAULT_SHOP
  }, statePath);
}

async function markLoginOk(statePath = defaultStatePath()) {
  const now = new Date().toISOString();
  const state = await readState(statePath);
  return writeState({
    ...state,
    installedAt: state.installedAt || now,
    firstLoginCompletedAt: state.firstLoginCompletedAt || now,
    lastLoginOkAt: now,
    pendingFirstLogin: false,
    lastSessionDropAt: null
  }, statePath);
}

async function markPopup(reason, statePath = defaultStatePath()) {
  const state = await readState(statePath);
  return writeState({
    ...state,
    lastPopupAt: new Date().toISOString(),
    lastPopupReason: String(reason || "unknown")
  }, statePath);
}

async function markSessionDrop(statePath = defaultStatePath()) {
  const state = await readState(statePath);
  // do not mark drop if never completed first login
  if (!state.firstLoginCompletedAt) return state;
  return writeState({
    ...state,
    lastSessionDropAt: new Date().toISOString()
  }, statePath);
}

async function markModelGatewayBinding(bound, statePath = defaultStatePath()) {
  const state = await readState(statePath);
  const now = new Date().toISOString();
  return writeState({
    ...state,
    modelGatewayBound: bound === true,
    modelGatewayBoundAt: bound === true ? (state.modelGatewayBoundAt || now) : null,
    modelGatewayUnboundAt: bound === true ? null : now
  }, statePath);
}

/**
 * Decide whether to open login popup.
 * Product rules (owner):
 * Gateway registration is optional. Initialization and status checks are silent.
 * A fresh-user popup is allowed only for an explicitly approved model call;
 * force=true is reserved for an explicit fiction_open_gateway_login request.
 */
function decidePopup(state, {
  loggedIn,
  cooldownMs = 120_000,
  force = false,
  allowPopup = false,
  explicitUserChoice = false
} = {}) {
  const now = Date.now();
  const lastPopup = state.lastPopupAt ? Date.parse(state.lastPopupAt) : 0;
  const inCooldown = !!(lastPopup && Number.isFinite(lastPopup) && now - lastPopup < cooldownMs);
  const hasShownPopup = !!(state.lastPopupAt && Number.isFinite(lastPopup));

  // Absolute silence while currently logged in
  if (loggedIn) {
    return {
      open: false,
      reason: "already_logged_in",
      message: "已连接网关，不再弹登录窗。"
    };
  }

  // Manual force is reserved for an explicit user request from the gateway tool.
  if (force) {
    return {
      open: true,
      reason: "forced",
      message: "按请求打开登录窗（含积分小店）。"
    };
  }

  const neverLoggedIn = !state.firstLoginCompletedAt;
  if (!allowPopup || !explicitUserChoice) {
    return {
      open: false,
      reason: neverLoggedIn ? "gateway_optional" : "session_dropped_silent",
      message: neverLoggedIn
        ? "字字珠玑网关是可选增强。只有作者同意外部模型调用后才打开登录页。"
        : "网关会话已失效；普通初始化和状态检查保持静默，等作者同意下一次外部模型调用时再登录。"
    };
  }

  if (neverLoggedIn) {
    if (inCooldown) {
      return {
        open: false,
        reason: "first_model_use_cooldown",
        message: "登录页刚刚已经打开，请先完成登录；不会重复弹窗。"
      };
    }
    return {
      open: true,
      reason: "first_model_use",
      message: "作者已同意本次外部模型调用，首次使用需要登录字字珠玑网关。"
    };
  }

  // Previous login expired: only an explicitly approved model call may reopen it.
  if (inCooldown) {
    return {
      open: false,
      reason: "session_drop_cooldown",
      message: "掉线提醒窗已打开过，请重新登录。登录成功后不会再乱弹。"
    };
  }

  return {
    open: true,
    reason: "session_dropped",
    message: "网关登录已失效/掉线，请重新登录后再调用多模型。登录成功后不会再乱弹。"
  };
}

module.exports = {
  defaultStatePath,
  emptyState,
  readState,
  writeState,
  markInstalled,
  markPackageInstalled,
  markLoginOk,
  markPopup,
  markSessionDrop,
  markModelGatewayBinding,
  decidePopup
};
