"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

function storeDir() {
  const rootDir = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(rootDir, "Zizhuji", "longform-fiction-director");
}

function loginUrlPath() { return path.join(storeDir(), "login-url.txt"); }
function loginMetaPath() { return path.join(storeDir(), "login-url.json"); }
function lockPath() { return path.join(storeDir(), "login-keeper.lock"); }

function readLock() {
  try { return JSON.parse(fs.readFileSync(lockPath(), "utf8")); } catch { return null; }
}

function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch { return false; }
}

function readLoginUrl() {
  const lock = readLock();
  if (lock && lock.loginUrl && isPidAlive(lock.pid)) {
    return {
      loginUrl: lock.loginUrl,
      shopUrl: lock.shopUrl || "https://catfk.com/shop/ZVZNANU8",
      pid: lock.pid,
      source: "lock",
      updatedAt: lock.updatedAt || null
    };
  }
  try {
    const meta = JSON.parse(fs.readFileSync(loginMetaPath(), "utf8"));
    return { ...meta, source: "file" };
  } catch {
    return null;
  }
}

async function saveLoginUrl({ loginUrl, shopUrl, reason = "", pid = process.pid, force = false } = {}) {
  const url = String(loginUrl || "").trim();
  if (!url) return { ok: false, reason: "missing_url" };
  await fsp.mkdir(storeDir(), { recursive: true });
  const shop = String(shopUrl || process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || "https://catfk.com/shop/ZVZNANU8");
  const lock = readLock();
  if (!force && lock && lock.pid && Number(lock.pid) !== Number(pid) && isPidAlive(lock.pid) && lock.loginUrl) {
    return {
      ok: false,
      reason: "not_lock_holder",
      ownedBy: lock.pid,
      loginUrl: lock.loginUrl,
      shopUrl: lock.shopUrl || shop
    };
  }
  const text = [
    "loginUrl=" + url,
    "shopUrl=" + shop,
    "reason=" + String(reason || ""),
    "pid=" + pid,
    "updatedAt=" + new Date().toISOString(),
    "",
    "打开上面 loginUrl 完成登录。登录成功后不会再乱弹；只有掉线才会再提醒。",
    ""
  ].join("\n");
  await fsp.writeFile(loginUrlPath(), text, "utf8");
  const meta = {
    loginUrl: url,
    shopUrl: shop,
    reason: String(reason || ""),
    pid,
    updatedAt: new Date().toISOString()
  };
  await fsp.writeFile(loginMetaPath(), JSON.stringify(meta, null, 2) + "\n", "utf8");
  return { ok: true, path: loginUrlPath(), ...meta };
}

module.exports = {
  saveLoginUrl,
  readLoginUrl,
  loginUrlPath,
  loginMetaPath,
  storeDir,
  lockPath,
  readLock
};
