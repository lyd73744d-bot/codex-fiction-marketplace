"use strict";

const crypto = require("node:crypto");

function createLocalSessionStore(options = {}) {
  const ttlMs = Number.isSafeInteger(options.ttlMs) && options.ttlMs > 0 ? options.ttlMs : 15 * 60 * 1_000;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const sessions = new Map();

  function issue(input = {}) {
    if (!input || typeof input !== "object" || typeof input.subject !== "string" || !input.subject) {
      throw new TypeError("local session subject is required");
    }
    const expiresAt = now() + ttlMs;
    const session = Object.freeze({
      subject: input.subject,
      ...(typeof input.username === "string" && input.username ? { username: input.username } : {}),
      expiresAt
    });
    const token = crypto.randomBytes(32).toString("base64url");
    sessions.set(token, session);
    return Object.freeze({ token, ...session });
  }

  function read(token) {
    if (typeof token !== "string" || !token) return null;
    const session = sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= now()) {
      sessions.delete(token);
      return null;
    }
    return session;
  }

  function consume(token) {
    const session = read(token);
    if (session) sessions.delete(token);
    return session;
  }

  function revoke(token) {
    if (typeof token === "string") sessions.delete(token);
  }

  function clearExpired() {
    for (const [token, session] of sessions) if (session.expiresAt <= now()) sessions.delete(token);
  }

  return Object.freeze({ clearExpired, consume, issue, read, revoke });
}

module.exports = { createLocalSessionStore };
