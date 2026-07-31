"use strict";

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const http = require("node:http");

const WAIT_MS = Number(process.env.FICTION_LOGIN_WAIT_MS || 20 * 60 * 1000);
const POLL_MS = Number(process.env.FICTION_LOGIN_POLL_MS || 2000);
const OPEN_BROWSER = process.env.FICTION_LOGIN_OPEN_BROWSER !== "0";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function lockPath() {
  const rootDir = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(rootDir, "Zizhuji", "longform-fiction-director", "login-keeper.lock");
}


function probeLoginUrl(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    try {
      const u = new URL(String(url || ""));
      if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return resolve(false);
      const req = http.get({ hostname: u.hostname, port: u.port, path: u.pathname || "/", timeout: timeoutMs }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { try { req.destroy(); } catch {} resolve(false); });
    } catch {
      resolve(false);
    }
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


async function clearDeadLoginLock() {
  const file = lockPath();
  if (!fs.existsSync(file)) return false;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    const pid = Number(parsed.pid || 0);
    const url = parsed.loginUrl || "";
    const alive = pid && isPidAlive(pid);
    const pageOk = url ? await probeLoginUrl(url) : false;
    if (!alive || !pageOk) {
      try { fs.unlinkSync(file); } catch {}
      return true;
    }
  } catch {
    try { fs.unlinkSync(file); } catch {}
    return true;
  }
  return false;
}

function tryAcquireLock() {
  const file = lockPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
      const pid = Number(parsed.pid || 0);
      if (pid && isPidAlive(pid) && Date.now() - Number(parsed.startedAt || 0) < WAIT_MS + 60000) {
        return { ok: false, existing: parsed };
      }
    }
    const payload = {
      pid: process.pid,
      startedAt: Date.now(),
      startedAtIso: new Date().toISOString()
    };
    fs.writeFileSync(file, JSON.stringify(payload, null, 2));
    return { ok: true, file, payload };
  } catch (error) {
    return { ok: true, file, error: String((error && error.message) || error) };
  }
}

function releaseLock() {
  try {
    const file = lockPath();
    if (!fs.existsSync(file)) return;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    if (!parsed.pid || Number(parsed.pid) === process.pid) fs.unlinkSync(file);
  } catch {}
}

function writeLockMeta(extra) {
  try {
    const file = lockPath();
    let base = { pid: process.pid, startedAt: Date.now() };
    try {
      base = Object.assign(base, JSON.parse(fs.readFileSync(file, "utf8") || "{}"));
    } catch {}
    fs.writeFileSync(
      file,
      JSON.stringify(Object.assign({}, base, extra, { updatedAt: new Date().toISOString() }), null, 2)
    );
  } catch {}
}

async function main() {
  process.chdir(path.resolve(__dirname, ".."));
  await clearDeadLoginLock();
  const lock = tryAcquireLock();
  if (!lock.ok) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          alreadyRunning: true,
          existing: lock.existing,
          message: "login keeper already running; reuse existing loginUrl"
        },
        null,
        2
      )
    );
    process.exit(0);
  }
  process.on("exit", releaseLock);
  process.on("SIGINT", () => {
    releaseLock();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    releaseLock();
    process.exit(143);
  });

  const { createRuntime } = require("../server/mcp-server");
  const onboarding = require("../server/onboarding-state");
  const { saveLoginUrl, loginUrlPath } = require("../server/login-url-store");

  const runtime = createRuntime();
  const result = await runtime.gatewayGuard.ensureAccess({
    force: true,
    reason: "open_gateway_login",
    openBrowser: OPEN_BROWSER
  });
  const payload = {
    ok: result.ok,
    loggedIn: result.loggedIn,
    popupOpened: result.popupOpened,
    browserOpened: result.browserOpened,
    loginUrl: result.loginUrl || null,
    shopUrl: result.shopUrl || null,
    message: result.message,
    waitMs: WAIT_MS,
    pid: process.pid
  };
  console.log(JSON.stringify(payload, null, 2));
  if (payload.loginUrl) {
    await saveLoginUrl({ loginUrl: payload.loginUrl, shopUrl: payload.shopUrl, reason: "open_gateway_login" });
    console.log("[login] url file:", loginUrlPath());
  }
  writeLockMeta({ loginUrl: payload.loginUrl, shopUrl: payload.shopUrl });

  if (result.loggedIn) {
    console.log("[login] already logged in");
    releaseLock();
    process.exit(0);
  }
  if (!result.loginUrl) {
    console.log("[login] missing loginUrl");
    releaseLock();
    process.exit(2);
  }

  console.log("[login] waiting for browser login");
  console.log("[login] timeout minutes:", Math.round(WAIT_MS / 60000));
  console.log("[login] URL:", result.loginUrl);
  console.log("[login] shop:", result.shopUrl || "https://catfk.com/shop/ZVZNANU8");

  const started = Date.now();
  while (Date.now() - started < WAIT_MS) {
    await sleep(POLL_MS);
    try {
      const snap = await runtime.gatewayGuard.accountSnapshot();
      if (snap.loggedIn) {
        await onboarding.markLoginOk();
        console.log(
          JSON.stringify(
            {
              ok: true,
              loggedIn: true,
              username: snap.raw && snap.raw.user && snap.raw.user.username,
              balance: snap.raw && snap.raw.balance,
              message: "login ok; no casual popup later; only remind on session drop"
            },
            null,
            2
          )
        );
        releaseLock();
        process.exit(0);
      }
    } catch {}
    const left = Math.max(0, WAIT_MS - (Date.now() - started));
    if (left % 30000 < POLL_MS) {
      console.log("[login] still waiting minutes left:", Math.ceil(left / 60000), "URL:", result.loginUrl);
    }
  }

  console.log(
    JSON.stringify(
      {
        ok: false,
        loggedIn: false,
        message: "login wait timeout; rerun node scripts/open-login-now.js"
      },
      null,
      2
    )
  );
  releaseLock();
  process.exit(3);
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  try {
    releaseLock();
  } catch {}
  process.exit(1);
});
