"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const properLockfile = require("proper-lockfile");

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_RETRY_MS = 50;
const DEFAULT_LOCK_STALE_MS = 30_000;
const MAX_LOCK_TIMEOUT_MS = 30_000;
const MAX_LOCK_RETRY_MS = 1_000;
const MAX_LOCK_STALE_MS = 120_000;
const MAX_LOCK_RETRIES = 1_000;

const PUBLIC_USER_STRING_FIELDS = Object.freeze([
  "username",
  "plan",
  "expiresAt",
  "accountType",
  "deviceBinding",
  "lastLoginAt",
  "lastUseAt",
  "note",
  "inviteCode",
  "reason"
]);
const PUBLIC_USER_NUMBER_FIELDS = Object.freeze([
  "quota",
  "used",
  "balance",
  "creditsPerCall",
  "callsLeft",
  "maxConcurrentHostingJobs",
  "invitedCount",
  "inviteReward"
]);
const PUBLIC_USER_BOOLEAN_FIELDS = Object.freeze([
  "active",
  "disabled",
  "canHost"
]);

class SessionStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionStoreError";
    this.code = code;
  }
}

function defaultSessionPath() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA
      || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, "Zizhuji", "v3", "session.json");
  }
  return path.join(os.homedir(), ".zizhuji", "v3", "session.json");
}

function ownData(record, key) {
  if (!record || typeof record !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function sanitizePublicUser(user) {
  if (!user || typeof user !== "object" || Array.isArray(user)) return null;
  const result = {};
  for (const key of PUBLIC_USER_STRING_FIELDS) {
    const value = ownData(user, key);
    if (typeof value === "string") result[key] = value.slice(0, 4_096);
  }
  for (const key of PUBLIC_USER_NUMBER_FIELDS) {
    const value = ownData(user, key);
    if (typeof value === "number" && Number.isFinite(value)) result[key] = value;
  }
  for (const key of PUBLIC_USER_BOOLEAN_FIELDS) {
    const value = ownData(user, key);
    if (typeof value === "boolean") result[key] = value;
  }
  const capabilities = ownData(user, "capabilities");
  const mcp = ownData(capabilities, "mcp");
  if (typeof mcp === "boolean") result.capabilities = { mcp };
  return result;
}

function normalizeSession(session, options = {}) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    throw new SessionStoreError("INVALID_SESSION", "本地登录状态无效");
  }
  const accessToken = ownData(session, "accessToken");
  const refreshToken = ownData(session, "refreshToken");
  if (typeof accessToken !== "string" || !accessToken || accessToken.length > 16_384) {
    throw new SessionStoreError("INVALID_SESSION", "本地登录状态无效");
  }
  if (typeof refreshToken !== "string" || !refreshToken || refreshToken.length > 16_384) {
    throw new SessionStoreError("INVALID_SESSION", "本地登录状态无效");
  }
  const user = sanitizePublicUser(ownData(session, "user"));
  if (!user || typeof user.username !== "string" || !user.username) {
    throw new SessionStoreError("INVALID_SESSION", "本地登录状态无效");
  }
  const savedAt = ownData(session, "savedAt");
  const requestedVersion = ownData(session, "version");
  const normalizedSavedAt = typeof savedAt === "string" ? savedAt : new Date().toISOString();
  let version;
  if (
    typeof requestedVersion === "string"
    && requestedVersion.length > 0
    && requestedVersion.length <= 128
  ) {
    version = requestedVersion;
  } else if (options.deriveLegacyVersion === true) {
    const digest = crypto.createHash("sha256").update(
      [accessToken, refreshToken, normalizedSavedAt].join("\0"),
      "utf8"
    ).digest("hex");
    version = `legacy_${digest}`;
  } else {
    version = crypto.randomUUID();
  }
  return {
    accessToken,
    refreshToken,
    user,
    savedAt: normalizedSavedAt,
    version
  };
}

async function atomicWrite(targetPath, content) {
  const directory = path.dirname(targetPath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await fs.promises.writeFile(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600
    });
    await fs.promises.rename(temporaryPath, targetPath);
    if (process.platform !== "win32") await fs.promises.chmod(targetPath, 0o600);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function boundedPositiveInteger(value, fallback, name, maximum) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new TypeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return resolved;
}

function createSessionStore(options = {}) {
  const sessionPath = path.resolve(options.sessionPath || defaultSessionPath());
  const lockTimeoutMs = boundedPositiveInteger(
    options.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    "lockTimeoutMs",
    MAX_LOCK_TIMEOUT_MS
  );
  const lockRetryMs = boundedPositiveInteger(
    options.lockRetryMs,
    DEFAULT_LOCK_RETRY_MS,
    "lockRetryMs",
    MAX_LOCK_RETRY_MS
  );
  if (lockRetryMs > lockTimeoutMs) {
    throw new TypeError("lockRetryMs must not exceed lockTimeoutMs");
  }
  const lockStaleMs = boundedPositiveInteger(
    options.lockStaleMs,
    DEFAULT_LOCK_STALE_MS,
    "lockStaleMs",
    MAX_LOCK_STALE_MS
  );
  if (lockStaleMs < 2_000) throw new TypeError("lockStaleMs must be at least 2000");
  const requestedUpdateMs = boundedPositiveInteger(
    options.lockUpdateMs,
    Math.floor(lockStaleMs / 2),
    "lockUpdateMs",
    Math.min(30_000, Math.floor(lockStaleMs / 2))
  );
  const lockPath = `${sessionPath}.lock`;
  const lockOptions = Object.freeze({
    lockfilePath: lockPath,
    realpath: false,
    stale: lockStaleMs,
    update: requestedUpdateMs,
    retries: Object.freeze({
      factor: 1,
      maxTimeout: lockRetryMs,
      minTimeout: lockRetryMs,
      randomize: false,
      retries: Math.min(MAX_LOCK_RETRIES, Math.floor(lockTimeoutMs / lockRetryMs))
    })
  });

  async function readUnlocked() {
    let text;
    try {
      text = await fs.promises.readFile(sessionPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw new SessionStoreError("SESSION_READ_FAILED", "无法读取本地登录状态");
    }
    try {
      return normalizeSession(JSON.parse(text), { deriveLegacyVersion: true });
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError("INVALID_SESSION", "本地登录状态无效");
    }
  }

  async function saveUnlocked(session) {
    const normalized = normalizeSession(session);
    await atomicWrite(sessionPath, `${JSON.stringify(normalized, null, 2)}\n`);
    return normalized;
  }

  async function clearUnlocked() {
    await fs.promises.rm(sessionPath, { force: true });
  }

  async function transaction(operation) {
    if (typeof operation !== "function") throw new TypeError("session transaction requires a callback");
    await fs.promises.mkdir(path.dirname(sessionPath), { recursive: true, mode: 0o700 });
    let release;
    try {
      release = await properLockfile.lock(sessionPath, lockOptions);
    } catch (error) {
      const code = error.code === "ELOCKED" ? "SESSION_LOCK_TIMEOUT" : "SESSION_LOCK_FAILED";
      throw new SessionStoreError(code, "无法锁定本地登录状态");
    }
    try {
      return await operation(Object.freeze({
        clear: clearUnlocked,
        read: readUnlocked,
        save: saveUnlocked
      }));
    } finally {
      try {
        await release();
      } catch (error) {
        throw new SessionStoreError("SESSION_UNLOCK_FAILED", "无法释放本地登录状态锁");
      }
    }
  }

  async function read() {
    return readUnlocked();
  }

  async function save(session) {
    try {
      return await transaction((locked) => locked.save(session));
    } catch (error) {
      if (error instanceof SessionStoreError) throw error;
      throw new SessionStoreError("SESSION_WRITE_FAILED", "无法保存本地登录状态");
    }
  }

  async function clear() {
    try {
      await transaction((locked) => locked.clear());
    } catch {
      throw new SessionStoreError("SESSION_CLEAR_FAILED", "无法清除本地登录状态");
    }
  }

  return Object.freeze({ clear, read, save, sessionPath, transaction });
}

module.exports = {
  SessionStoreError,
  MAX_LOCK_RETRIES,
  MAX_LOCK_RETRY_MS,
  MAX_LOCK_STALE_MS,
  MAX_LOCK_TIMEOUT_MS,
  createSessionStore,
  defaultSessionPath,
  sanitizePublicUser
};
