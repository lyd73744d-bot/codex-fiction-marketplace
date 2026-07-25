"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

class SessionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

function defaultSessionPath() {
  const root = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(root, "Zizhuji", "longform-fiction-director", "session.json");
}

function publicUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const result = {};
  const allowed = new Set([
    "username", "plan", "expiresAt", "accountType", "deviceBinding", "lastLoginAt", "lastUseAt",
    "quota", "used", "balance", "creditsPerCall", "callsLeft", "active", "disabled", "canHost",
    "capabilities"
  ]);
  for (const [key, value] of Object.entries(user)) {
    if (!allowed.has(key)) continue;
    if (["string", "number", "boolean"].includes(typeof value)) result[key] = value;
    if (key === "capabilities" && value && typeof value === "object" && typeof value.mcp === "boolean") result.capabilities = { mcp: value.mcp };
  }
  return result;
}

function normalizeSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) throw new SessionStoreError("INVALID_SESSION", "Invalid local session.");
  if (typeof session.accessToken !== "string" || !session.accessToken || session.accessToken.length > 16_384) throw new SessionStoreError("INVALID_SESSION", "Invalid access token.");
  if (typeof session.refreshToken !== "string" || !session.refreshToken || session.refreshToken.length > 16_384) throw new SessionStoreError("INVALID_SESSION", "Invalid refresh token.");
  const user = publicUser(session.user);
  if (!user || typeof user.username !== "string" || !user.username) throw new SessionStoreError("INVALID_SESSION", "Invalid session user.");
  return { accessToken: session.accessToken, refreshToken: session.refreshToken, user, version: typeof session.version === "string" ? session.version : crypto.randomUUID(), savedAt: new Date().toISOString() };
}

const queues = new Map();
async function withQueue(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  queues.set(key, current);
  await previous;
  try { return await operation(); } finally { release(); if (queues.get(key) === current) queues.delete(key); }
}

async function atomicWrite(filePath, content) {
  const directory = path.dirname(filePath);
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function createSessionStore(options = {}) {
  const sessionPath = path.resolve(options.sessionPath || defaultSessionPath());
  async function readUnlocked() {
    try {
      const parsed = JSON.parse(await fs.readFile(sessionPath, "utf8"));
      return normalizeSession(parsed);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError("INVALID_SESSION", "Invalid local session.");
    }
  }
  async function saveUnlocked(session) {
    const normalized = normalizeSession(session);
    await atomicWrite(sessionPath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }
  async function clearUnlocked() { await fs.rm(sessionPath, { force: true }); }
  async function read() { return withQueue(sessionPath, readUnlocked); }
  async function save(session) { return withQueue(sessionPath, () => saveUnlocked(session)); }
  async function clear() { return withQueue(sessionPath, clearUnlocked); }
  async function transaction(operation) {
    if (typeof operation !== "function") throw new TypeError("session transaction requires a callback");
    return withQueue(sessionPath, async () => operation({ read: readUnlocked, save: saveUnlocked, clear: clearUnlocked }));
  }
  return Object.freeze({ read, save, clear, transaction, sessionPath });
}

module.exports = { SessionStoreError, createSessionStore, defaultSessionPath, publicUser };
