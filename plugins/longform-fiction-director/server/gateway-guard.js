"use strict";

const { spawn } = require("node:child_process");
const onboarding = require("./onboarding-state");
const { saveLoginUrl } = require("./login-url-store");

function openExternal(url) {
  try {
    const target = String(url || "").trim();
    if (!target) return false;
    // Windows: start empty title then URL
    spawn("cmd", ["/c", "start", "", target], {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }).unref();
    return true;
  } catch {
    return false;
  }
}

function createGatewayGuard({ gateway, openLoginPage, paymentPortalUrl } = {}) {
  if (!gateway) throw new TypeError("gateway required");
  if (typeof openLoginPage !== "function") throw new TypeError("openLoginPage required");

  const inflight = new Map();

  async function accountSnapshot() {
    try {
      if (typeof gateway.accountStatus !== "function") {
        return { loggedIn: false, online: false, raw: null };
      }
      const raw = await gateway.accountStatus();
      const loggedIn = !!(
        raw &&
        (raw.loggedIn === true || raw.user) &&
        raw.active !== false &&
        raw.user?.active !== false
      );
      return { loggedIn, online: true, raw };
    } catch {
      return { loggedIn: false, online: false, raw: null };
    }
  }

  async function ensureAccess({
    force = false,
    reason = "tool_call",
    openBrowser = true,
    allowPopup = false,
    explicitUserChoice = false
  } = {}) {
    const requestKey = JSON.stringify({ force, openBrowser, allowPopup, explicitUserChoice });
    if (inflight.has(requestKey)) return inflight.get(requestKey);
    const pending = (async () => {
      await onboarding.markInstalled();
      const snap = await accountSnapshot();
      let state = await onboarding.readState();
      const shopUrl = state.shopUrl || paymentPortalUrl || "https://catfk.com/shop/ZVZNANU8";

      // Success path: never popup
      if (snap.loggedIn) {
        state = await onboarding.markLoginOk();
        return {
          ok: true,
          loggedIn: true,
          popupOpened: false,
          browserOpened: false,
          reason: "already_logged_in",
          message: "网关已登录，不再弹窗。",
          shopUrl,
          account: snap.raw,
          onboarding: {
            firstLoginCompletedAt: state.firstLoginCompletedAt,
            lastLoginOkAt: state.lastLoginOkAt,
            pendingFirstLogin: false
          }
        };
      }

      // Had successful login before, now not logged in => session drop
      if (state.firstLoginCompletedAt && !snap.loggedIn) {
        await onboarding.markSessionDrop();
        state = await onboarding.readState();
        // keep reason path via decidePopup => session_dropped
      }

      const decision = force
        ? {
            open: true,
            reason: reason || "forced",
            message: "按请求打开登录窗（含积分小店）。"
          }
        : onboarding.decidePopup(state, {
            loggedIn: false,
            allowPopup,
            explicitUserChoice
          });

      if (!decision.open) {
        return {
          ok: false,
          loggedIn: false,
          popupOpened: false,
          browserOpened: false,
          reason: decision.reason,
          message: decision.message,
          shopUrl,
          onboarding: {
            firstLoginCompletedAt: state.firstLoginCompletedAt,
            lastLoginOkAt: state.lastLoginOkAt,
            pendingFirstLogin: !!state.pendingFirstLogin,
            lastPopupAt: state.lastPopupAt,
            lastPopupReason: state.lastPopupReason
          }
        };
      }

      const page = await openLoginPage();
      state = await onboarding.markPopup(decision.reason);
      const loginUrl = page?.url || null;
      if (loginUrl) {
        try { await saveLoginUrl({ loginUrl, shopUrl, reason: decision.reason }); } catch {}
      }
      const browserOpened = openBrowser && loginUrl ? openExternal(loginUrl) : false;

      return {
        ok: false,
        loggedIn: false,
        popupOpened: true,
        browserOpened,
        reason: decision.reason,
        message:
          decision.message +
          (browserOpened
            ? " 已打开浏览器登录窗；登录成功后不会再乱弹，掉线才会再提醒。"
            : " 请打开返回的 loginUrl 完成登录。"),
        loginUrl,
        shopUrl,
        onboarding: {
          firstLoginCompletedAt: state.firstLoginCompletedAt,
          pendingFirstLogin: !!state.pendingFirstLogin,
          lastPopupReason: decision.reason
        }
      };
    })();
    inflight.set(requestKey, pending);

    try {
      return await pending;
    } finally {
      inflight.delete(requestKey);
    }
  }

  return Object.freeze({ ensureAccess, accountSnapshot, openExternal });
}

module.exports = { createGatewayGuard, openExternal };
