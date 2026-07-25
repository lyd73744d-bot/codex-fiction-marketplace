"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const onboarding = require("../server/onboarding-state");

async function main() {
  const pluginRoot = path.resolve(__dirname, "..");
  process.chdir(pluginRoot);

  const state = await onboarding.markPackageInstalled();
  console.log("[onboarding] pendingFirstLogin =", !!state.pendingFirstLogin);
  console.log("[onboarding] firstLoginCompletedAt =", state.firstLoginCompletedAt || "(none)");
  console.log("[onboarding] state =", onboarding.defaultStatePath());
  console.log("[onboarding] 弹窗规则：首次安装必弹一次 → 弹出过后/登录成功后不乱弹 → 仅掉线再提醒");

  if (state.firstLoginCompletedAt && !state.pendingFirstLogin) {
    const sessionPath = require("../server/session-store").defaultSessionPath();
    if (fs.existsSync(sessionPath)) {
      console.log("[onboarding] 已登录过且会话仍在，本次安装不弹窗。");
      return;
    }
    console.log("[onboarding] 曾登录过但本地会话丢失，将重新打开登录窗（掉线提醒）。");
  } else {
    console.log("[onboarding] 首次安装/从未登录：必须打开登录窗一次（含积分小店）。");
  }

  const keeper = path.join(pluginRoot, "scripts", "open-login-now.js");
  const logDir = path.join(process.env.LOCALAPPDATA || "", "Zizhuji", "longform-fiction-director");
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logPath = path.join(logDir, "login-keeper.log");
  const errPath = path.join(logDir, "login-keeper.log.err");
  const outFd = fs.openSync(logPath, "a");
  const errFd = fs.openSync(errPath, "a");
  try {
    const child = spawn(process.execPath, [keeper], {
      cwd: pluginRoot,
      detached: true,
      stdio: ["ignore", outFd, errFd],
      windowsHide: false
    });
    child.unref();
    console.log("[onboarding] 已后台启动登录保活进程（最长约 20 分钟）。");
    console.log("[onboarding] 日志:", logPath);
    console.log("[onboarding] 请在浏览器完成登录；登录成功后不会再乱弹。");
    console.log("[onboarding] 也可手动运行: node scripts/open-login-now.js");
  } catch (error) {
    console.log("[onboarding] 无法后台启动登录窗：", error && (error.message || error));
    console.log("[onboarding] 启用插件后请运行: node scripts/open-login-now.js");
  } finally {
    try { fs.closeSync(outFd); } catch {}
    try { fs.closeSync(errFd); } catch {}
  }
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exitCode = 1;
});
