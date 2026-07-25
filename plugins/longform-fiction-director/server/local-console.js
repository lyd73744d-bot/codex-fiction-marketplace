"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { listInkOsCapabilities } = require("./inkos-capability-catalog");
const SESSION_COOKIE = "fiction_director_session";
const MAX_BODY_BYTES = 1_048_576;
const MAX_PUBLIC_DEPTH = 16;
const MAX_PUBLIC_NODES = 2048;
const MAX_PUBLIC_CHARACTERS = 160_000;
const SENSITIVE_KEY_PARTS = ["key", "token", "password", "secret", "authorization", "rechargecode", "credential", "cookie", "session", "bearer"];
function parseCookies(header) { const cookies = Object.create(null); for (const part of String(header || "").split(";")) { const index = part.indexOf("="); if (index < 1) continue; cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim()); } return cookies; }
function sensitivePublicKey(key) { const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, ""); return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part)); }
function publicValue(value, state = { characters: 0, nodes: 0, seen: new WeakSet() }, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") { const remaining = Math.max(0, MAX_PUBLIC_CHARACTERS - state.characters); const bounded = value.slice(0, remaining); state.characters += bounded.length; return bounded.length < value.length ? `${bounded}[truncated]` : bounded; }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (!value || typeof value !== "object") return null;
  if (depth >= MAX_PUBLIC_DEPTH || state.nodes >= MAX_PUBLIC_NODES || state.characters >= MAX_PUBLIC_CHARACTERS) return "[truncated]";
  if (state.seen.has(value)) return "[circular]";
  state.seen.add(value); state.nodes += 1;
  if (Array.isArray(value)) return value.slice(0, MAX_PUBLIC_NODES).map((item) => publicValue(item, state, depth + 1));
  const copy = {};
  for (const [key, item] of Object.entries(value)) if (!sensitivePublicKey(key)) copy[key] = publicValue(item, state, depth + 1);
  return copy;
}
async function readJson(req) { const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY_BYTES) throw Object.assign(new Error("Request body is too large."), { statusCode: 413, code: "BODY_TOO_LARGE" }); chunks.push(chunk); } if (!size) return {}; try { const input = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error(); return input; } catch (cause) { throw Object.assign(new Error("A JSON object is required."), { statusCode: 400, code: "INVALID_JSON", cause }); } }
function json(res, statusCode, body, headers = {}) { res.writeHead(statusCode, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8", ...headers }); res.end(JSON.stringify(publicValue(body))); }
function createOfflineGateway() { const unavailable = async () => { throw Object.assign(new Error("The model gateway is not configured."), { code: "GATEWAY_REQUIRED" }); }; return { connectionStatus: async () => ({ online: false }), accountStatus: async () => ({ loggedIn: false }), register: unavailable, login: unavailable, logout: async () => ({ ok: true }), listModels: unavailable, redeemRechargeCode: unavailable }; }
function publicRechargeResult(result) { return { ok: result?.ok !== false, balance: result?.balance, credited: result?.credited, currency: result?.currency, expiresAt: result?.expiresAt }; }
function normalizePaymentPortalUrl(value) {
  if (value === undefined || value === null || value === "") return null;
  let parsed;
  try { parsed = new URL(String(value)); } catch { throw Object.assign(new Error("Payment portal URL is invalid."), { code: "PAYMENT_PORTAL_INVALID" }); }
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(parsed.hostname);
  if ((parsed.protocol !== "https:" && !(loopback && parsed.protocol === "http:")) || parsed.username || parsed.password || parsed.hash) {
    throw Object.assign(new Error("Payment portal URL must be HTTPS without embedded credentials."), { code: "PAYMENT_PORTAL_INVALID" });
  }
  return parsed.toString();
}

function createLocalConsole({ director, gateway = createOfflineGateway(), ainovel = null, host = "127.0.0.1", port = 0, webRoot = path.join(__dirname, "..", "web"), paymentPortalUrl } = {}) {
  if (!director || typeof director.listProjects !== "function" || typeof director.run !== "function" || !director.taskStore) throw new TypeError("director with project and task services is required");
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) throw new Error("local console must bind to loopback");
  const sessions = new Map(); const resolvedWebRoot = path.resolve(webRoot); const resolvedPaymentPortalUrl = normalizePaymentPortalUrl(paymentPortalUrl); let server = null; let origin = null;
  function issueSession(username) { const token = crypto.randomBytes(32).toString("base64url"); sessions.set(token, { username, expiresAt: Date.now() + 15 * 60 * 1000 }); return token; }
  async function accountFor(req) { const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]; const session = sessions.get(token); if (!session || session.expiresAt <= Date.now()) { sessions.delete(token); throw Object.assign(new Error("Please log in."), { statusCode: 401, code: "UNAUTHORIZED" }); } const account = await gateway.accountStatus(); if (!account?.loggedIn || account?.active === false || account?.user?.active === false) { sessions.delete(token); throw Object.assign(new Error("Please log in again."), { statusCode: 401, code: "UNAUTHORIZED" }); } return { token, session, account }; }
  async function createCliSession() { const account = await gateway.accountStatus(); if (!account?.loggedIn || account?.active === false || account?.user?.active === false) throw Object.assign(new Error("Please log in before using the CLI."), { statusCode: 401, code: "AUTH_REQUIRED" }); const username = String(account.user?.username || "cli"); return { cookie: `${SESSION_COOKIE}=${issueSession(username)}` }; }
  function sameOrigin(req) { return Boolean(origin && req.headers.origin === origin); }
  async function mutationAccount(req) { if (!sameOrigin(req)) throw Object.assign(new Error("Request origin is forbidden."), { statusCode: 403, code: "ORIGIN_FORBIDDEN" }); return accountFor(req); }
  async function serveFile(res, pathname) { const requested = pathname === "/" ? "index.html" : pathname.slice(1); const filePath = path.resolve(resolvedWebRoot, requested); const relative = path.relative(resolvedWebRoot, filePath); if (relative.startsWith("..") || path.isAbsolute(relative)) return false; try { const contents = await fs.readFile(filePath); const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" }; res.writeHead(200, { "cache-control": "no-store", "content-type": types[path.extname(filePath)] || "application/octet-stream" }); res.end(contents); return true; } catch (cause) { if (cause.code === "ENOENT") return false; throw cause; } }
  function failure(res, cause) { json(res, cause?.statusCode || 500, { error: { code: cause?.code || "LOCAL_CONSOLE_ERROR", message: cause?.message || "Local console failed." } }); }
  async function handle(req, res) {
    const url = new URL(req.url || "/", origin || "http://127.0.0.1");
    try {
      if (url.pathname === "/api/local/state" && req.method === "GET") { const connection = await gateway.connectionStatus().catch(() => ({ online: false })); try { const verified = await accountFor(req); return json(res, 200, { loggedIn: true, user: verified.account.user || { username: verified.session.username }, account: verified.account, connection, paymentPortalUrl: resolvedPaymentPortalUrl }); } catch { return json(res, 200, { loggedIn: false, connection, paymentPortalUrl: resolvedPaymentPortalUrl }); } }
      if (url.pathname === "/api/local/register" && req.method === "POST") { if (!sameOrigin(req)) throw Object.assign(new Error("Request origin is forbidden."), { statusCode: 403, code: "ORIGIN_FORBIDDEN" }); if (typeof gateway.register !== "function") throw Object.assign(new Error("Registration is unavailable."), { statusCode: 501, code: "REGISTRATION_UNAVAILABLE" }); const input = await readJson(req); const registration = await gateway.register({ username: input.username, password: input.password, inviteCode: input.inviteCode }); const account = await gateway.accountStatus(); if (!account?.loggedIn || account?.active === false || account?.user?.active === false) throw Object.assign(new Error("Registered account is unavailable."), { statusCode: 401, code: "AUTH_FAILED" }); const username = String(account.user?.username || registration?.user?.username || input.username || "").trim(); const token = issueSession(username); return json(res, 200, { ok: true, user: account.user || { username }, account }, { "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/` }); }
      if (url.pathname === "/api/local/login" && req.method === "POST") { if (!sameOrigin(req)) throw Object.assign(new Error("Request origin is forbidden."), { statusCode: 403, code: "ORIGIN_FORBIDDEN" }); const input = await readJson(req); const login = await gateway.login({ username: input.username, password: input.password }); const account = await gateway.accountStatus(); if (!account?.loggedIn || account?.active === false || account?.user?.active === false) throw Object.assign(new Error("Account is unavailable."), { statusCode: 401, code: "AUTH_FAILED" }); const username = String(account.user?.username || login?.user?.username || input.username || "").trim(); const token = issueSession(username); return json(res, 200, { ok: true, user: account.user || { username }, account }, { "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/` }); }
      if (url.pathname === "/api/local/logout" && req.method === "POST") { const verified = await mutationAccount(req); sessions.delete(verified.token); await gateway.logout().catch(() => {}); return json(res, 200, { ok: true }, { "set-cookie": `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` }); }
      if (url.pathname === "/api/local/capabilities" && req.method === "GET") { return json(res, 200, { capabilities: listInkOsCapabilities() }); }
      if (url.pathname === "/api/local/projects" && req.method === "GET") { await accountFor(req); return json(res, 200, { projects: await director.listProjects() }); }
      if (url.pathname === "/api/local/projects" && req.method === "POST") { await mutationAccount(req); const input = await readJson(req); return json(res, 200, { project: await director.createProject({ title: input.title, direction: input.direction }) }); }
      const importMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/import-auxiliary$/u); if (importMatch && req.method === "POST") { await mutationAccount(req); const input = await readJson(req); return json(res, 200, { result: await director.importAuxiliary({ projectId: decodeURIComponent(importMatch[1]), sourcePath: input.sourcePath }) }); }
      const ledgerMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/ledger$/u); if (ledgerMatch && req.method === "GET") { await accountFor(req); return json(res, 200, { ledger: await director.readLedger(decodeURIComponent(ledgerMatch[1])) }); }
      const sourcesMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/sources$/u); if (sourcesMatch && req.method === "GET") { await accountFor(req); return json(res, 200, { sources: await director.listSources(decodeURIComponent(sourcesMatch[1])) }); }
      const ainovelMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)\/ainovel(?:\/(start|pause|resume))?$/u); if (ainovelMatch) {
        if (!ainovel) throw Object.assign(new Error("ainovel-cli is unavailable."), { statusCode: 503, code: "AINOVEL_UNAVAILABLE" });
        const projectId = decodeURIComponent(ainovelMatch[1]);
        const action = ainovelMatch[2];
        if (!action && req.method === "GET") { await accountFor(req); return json(res, 200, { engine: await ainovel.status(projectId) }); }
        if (action && req.method === "POST") {
          await mutationAccount(req);
          const input = await readJson(req);
          if (action === "start") return json(res, 200, { engine: await ainovel.start({ projectId, prompt: input.prompt, modelIds: input.modelIds }) });
          if (action === "pause") return json(res, 200, { engine: await ainovel.pause(projectId) });
          return json(res, 200, { engine: await ainovel.resume({ projectId, modelIds: input.modelIds }) });
        }
      }
      const projectMatch = url.pathname.match(/^\/api\/local\/projects\/([^/]+)$/u); if (projectMatch && req.method === "GET") { await accountFor(req); return json(res, 200, { state: await director.projectState(decodeURIComponent(projectMatch[1])) }); }
      if (url.pathname === "/api/local/tasks" && req.method === "GET") { await accountFor(req); return json(res, 200, { tasks: await director.taskStore.list({ projectId: url.searchParams.get("projectId") || undefined }) }); }
      if (url.pathname === "/api/local/tasks" && req.method === "POST") { await mutationAccount(req); const input = await readJson(req); return json(res, 200, { task: await director.run(input) }); }
      const taskAction = url.pathname.match(/^\/api\/local\/tasks\/([^/]+)\/(pause|resume)$/u); if (taskAction && req.method === "POST") { await mutationAccount(req); await readJson(req); return json(res, 200, { task: await director.taskStore[taskAction[2]](decodeURIComponent(taskAction[1])) }); }
      const taskMatch = url.pathname.match(/^\/api\/local\/tasks\/([^/]+)$/u); if (taskMatch && req.method === "GET") { await accountFor(req); return json(res, 200, { task: await director.taskStore.read(decodeURIComponent(taskMatch[1])) }); }
      if (url.pathname === "/api/local/models" && req.method === "GET") { await accountFor(req); return json(res, 200, await gateway.listModels()); }
      if (url.pathname === "/api/local/models/call" && req.method === "POST") {
        await mutationAccount(req);
        if (typeof gateway.callModels !== "function") throw Object.assign(new Error("Model consultation is unavailable."), { statusCode: 501, code: "MODEL_CALL_UNAVAILABLE" });
        const input = await readJson(req);
        return json(res, 200, await gateway.callModels({ prompt: input.prompt, modelIds: input.modelIds, taskLabel: input.taskLabel || "browser-consultation" }));
      }
      if (url.pathname === "/api/local/recharge/redeem" && req.method === "POST") { await mutationAccount(req); const input = await readJson(req); const redeem = gateway.redeemRechargeCode || gateway.redeemRecharge; if (typeof redeem !== "function") throw Object.assign(new Error("Recharge redemption is unavailable."), { statusCode: 501, code: "RECHARGE_UNAVAILABLE" }); return json(res, 200, { result: publicRechargeResult(await redeem.call(gateway, { code: input.code })) }); }
      if (req.method === "GET" && await serveFile(res, url.pathname)) return;
      return json(res, 404, { error: { code: "NOT_FOUND", message: "Not found." } });
    } catch (cause) { failure(res, cause); }
  }
  return Object.freeze({ async start() { if (server) return { url: origin }; server = http.createServer((req, res) => { handle(req, res).catch((cause) => failure(res, cause)); }); await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); }); const address = server.address(); const publicHost = host === "::1" ? "[::1]" : host; origin = `http://${publicHost}:${address.port}`; return { url: origin }; }, async stop() { if (!server) return; const active = server; server = null; origin = null; await new Promise((resolve, reject) => active.close((cause) => cause ? reject(cause) : resolve())); }, handle, createCliSession });
}
module.exports = { SESSION_COOKIE, createLocalConsole };
