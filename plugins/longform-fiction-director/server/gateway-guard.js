"use strict";

const { spawn } = require("node:child_process");
const onboarding = require("./onboarding-state");
const { saveLoginUrl } = require("./login-url-store");

function openExternal(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const target = String(url || "").trim();
  if (!target) return false;

  const common = { detached: true, stdio: "ignore", windowsHide: true };
  const commands = platform === "win32"
    ? [
        ["explorer.exe", [target]],
        ["cmd", ["/d", "/c", "start", "", target]]
      ]
    : platform === "darwin"
      ? [["open", [target]]]
      : [["xdg-open", [target]], ["gio", ["open", target]]];

  for (const [command, args] of commands) {
    try {
      const child = spawnImpl(command, args, common);
      if (child && typeof child.unref === "function") child.unref();
      return true;
    } catch {}
  }
  return false;
}

function browserHandoff(loginUrl, browserOpened) {
  if (!loginUrl) return "no_login_url";
  return browserOpened ? "browser_opened" : "manual_url_required";
}

function createGatewayGuard({ gateway, openLoginPage, paymentPortalUrl, openExternalImpl = openExternal } = {}) {
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
      const firstActivation = reason === "initialize" && !state.firstActivationGatewayOpenedAt;

      async function openBindingPage(openReason, loggedIn) {
        const page = await openLoginPage();
        const loginUrl = page?.url || null;
        if (loginUrl) {
          if (firstActivation && typeof onboarding.markFirstActivationGatewayOpened === "function") {
            state = await onboarding.markFirstActivationGatewayOpened();
          }
          try { await saveLoginUrl({ loginUrl, shopUrl, reason: openReason }); } catch {}
        }
        const browserOpened = openBrowser && loginUrl ? !!(await openExternalImpl(loginUrl)) : false;
        return { page, loginUrl, browserOpened, loggedIn };
      }

      // The first activation is a visible handoff, even when a previous local
      // session already exists. Later initialize calls remain quiet.
      if (firstActivation) {
        const opened = await openBindingPage("first_activation", snap.loggedIn);
        if (snap.loggedIn) {
          state = await onboarding.markLoginOk();
          return {
            ok: true,
            loggedIn: true,
            popupOpened: true,
            activationPageOpened: true,
            browserOpened: opened.browserOpened,
            browserHandoff: browserHandoff(opened.loginUrl, opened.browserOpened),
            reason: "first_activation",
            loginUrl: opened.loginUrl,
            message: opened.browserOpened
              ? "插件已激活，已在浏览器打开网关绑定页；当前账号已登录，可直接使用模型。"
              : "插件已激活，绑定页已启动；请打开返回的 loginUrl。当前账号已登录，可直接使用模型。",
            shopUrl,
            account: snap.raw,
            onboarding: {
              firstActivationGatewayOpenedAt: state.firstActivationGatewayOpenedAt,
              firstLoginCompletedAt: state.firstLoginCompletedAt,
              lastLoginOkAt: state.lastLoginOkAt,
              pendingFirstLogin: false
            }
          };
        }

        state = await onboarding.markPopup("first_activation");
        return {
          ok: false,
          loggedIn: false,
          popupOpened: true,
          activationPageOpened: true,
          browserOpened: opened.browserOpened,
          browserHandoff: browserHandoff(opened.loginUrl, opened.browserOpened),
          reason: "first_activation",
          loginUrl: opened.loginUrl,
          message: opened.browserOpened
            ? "插件已激活，已在浏览器打开网关绑定页；请先登录或注册，绑定后即可直接使用模型。"
            : "插件已激活，绑定页已启动；请打开返回的 loginUrl，登录或注册后即可直接使用模型。",
          shopUrl,
          onboarding: {
            firstActivationGatewayOpenedAt: state.firstActivationGatewayOpenedAt,
            firstLoginCompletedAt: state.firstLoginCompletedAt,
            pendingFirstLogin: true,
            lastPopupAt: state.lastPopupAt,
            lastPopupReason: state.lastPopupReason
          }
        };
      }

      // Success path: never popup
      if (snap.loggedIn) {
        state = await onboarding.markLoginOk();
        return {
          ok: true,
          loggedIn: true,
          popupOpened: false,
          browserOpened: false,
          browserHandoff: "not_needed",
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
            message: "按请求打开账号绑定页（含积分小店）。"
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
          browserHandoff: "not_opened",
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

      const opened = await openBindingPage(decision.reason, false);
      state = await onboarding.markPopup(decision.reason);
      const loginUrl = opened.loginUrl;
      const browserOpened = opened.browserOpened;

      return {
        ok: false,
        loggedIn: false,
        popupOpened: true,
        activationPageOpened: false,
        browserOpened,
        browserHandoff: browserHandoff(loginUrl, browserOpened),
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
