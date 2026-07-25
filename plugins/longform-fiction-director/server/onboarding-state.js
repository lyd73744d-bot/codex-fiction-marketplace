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
    pendingFirstLogin: true,
    shopUrl: DEFAULT_SHOP,
    notes: "install must popup once; after shown do not casual re-popup; after login never casual popup; only re-prompt on session drop; cooldown blocks drop spam"
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
    else if (merged.pendingFirstLogin == null) merged.pendingFirstLogin = true;
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
 * Called by installer / first boot.
 * Preserves successful login history on reinstall/update so we do NOT spam popup again.
 * Only forces first-login pending when user has never completed login.
 */
async function markInstalled(statePath = defaultStatePath()) {
  const now = new Date().toISOString();
  const state = await readState(statePath);
  const neverLoggedIn = !state.firstLoginCompletedAt;
  return writeState({
    ...state,
    installedAt: state.installedAt || now,
    lastInstalledAt: now,
    installCount: Math.max(1, Number(state.installCount || 0) + (state.installedAt ? 0 : 1)),
    pendingFirstLogin: neverLoggedIn,
    shopUrl: state.shopUrl || DEFAULT_SHOP
  }, statePath);
}

/**
 * Fresh package install marker from install.cmd.
 * Does NOT wipe firstLoginCompletedAt / lastLoginOkAt.
 * If never logged in: pendingFirstLogin=true (must popup).
 * If already logged in before: keep success flags (no casual popup).
 * Clears lastPopupAt only when never logged in so install can force-open once again.
 */
async function markPackageInstalled(statePath = defaultStatePath()) {
  const now = new Date().toISOString();
  const state = await readState(statePath);
  const neverLoggedIn = !state.firstLoginCompletedAt;
  return writeState({
    ...state,
    installedAt: state.installedAt || now,
    lastInstalledAt: now,
    installCount: Number(state.installCount || 0) + 1,
    pendingFirstLogin: neverLoggedIn,
    // clear popup cooldown only when first login still pending, so install can force open once
    lastPopupAt: neverLoggedIn ? null : state.lastPopupAt,
    lastPopupReason: neverLoggedIn ? null : state.lastPopupReason,
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

/**
 * Decide whether to open login popup.
 * Product rules (owner):
 * 1) First install / never completed login => MUST open once automatically
 * 2) After that install popup has been shown => do NOT auto re-open casually
 *    (user can still force via fiction_open_gateway_login / install script)
 * 3) After successful login => NEVER casually open
 * 4) Only re-open when session dropped / login invalid (with cooldown anti-spam)
 * 5) force=true always opens (manual / install keeper)
 */
function decidePopup(state, { loggedIn, cooldownMs = 120_000, force = false } = {}) {
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

  // Manual force is handled by gateway-guard; keep escape hatch for tests/tools/install
  if (force) {
    return {
      open: true,
      reason: "forced",
      message: "按请求打开登录窗（含积分小店）。"
    };
  }

  const neverLoggedIn = !state.firstLoginCompletedAt || state.pendingFirstLogin === true;

  // First install / never completed login:
  // MUST popup once. After shown once, stop auto-popping until reinstall clears lastPopupAt
  // or user explicitly force-opens. This prevents casual re-popup after install.
  if (neverLoggedIn) {
    if (hasShownPopup) {
      return {
        open: false,
        reason: "first_install_already_shown",
        message: "安装登录窗已弹出过，不会再随便弹。请先在浏览器完成登录；需要时用 fiction_open_gateway_login。登录成功后不乱弹，只有掉线才会再提醒。"
      };
    }
    return {
      open: true,
      reason: "first_install",
      message: "安装后首次使用：请先登录字字珠玑网关账号（可在小店充值积分）。登录成功后不会再乱弹；只有掉线才会再提醒。"
    };
  }

  // Already completed first login before: only remind on session drop / invalid login
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
  decidePopup
};
