"use strict";

const crypto = require("node:crypto");
const http = require("node:http");

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function bridgeError(code, message, statusCode = 500) {
  return Object.assign(new Error(message), { code, statusCode });
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw bridgeError("BODY_TOO_LARGE", "Request body is too large.", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); }
  catch { throw bridgeError("INVALID_JSON", "A JSON object is required.", 400); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bridgeError("INVALID_JSON", "A JSON object is required.", 400);
  return value;
}

function json(res, statusCode, body) {
  res.writeHead(statusCode, { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function createAinovelGatewayBridge({ gateway, host = "127.0.0.1", port = 0, token } = {}) {
  if (!gateway || typeof gateway.listModels !== "function" || typeof gateway.proxyChatCompletions !== "function") {
    throw new TypeError("gateway with model listing and chat proxy support is required");
  }
  if (!new Set(["127.0.0.1", "::1", "localhost"]).has(host)) throw new Error("ainovel bridge must bind to loopback");
  const apiKey = String(token || crypto.randomBytes(32).toString("base64url"));
  let server = null;
  let baseUrl = null;

  function authorized(req) {
    const supplied = Buffer.from(String(req.headers.authorization || ""));
    const expected = Buffer.from(`Bearer ${apiKey}`);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  async function handle(req, res) {
    try {
      if (!authorized(req)) return json(res, 401, { error: { type: "authentication_error", code: "invalid_api_key", message: "Invalid local engine token." } });
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        const catalog = await gateway.listModels();
        const models = Array.isArray(catalog) ? catalog : catalog?.models || [];
        return json(res, 200, { object: "list", data: models.map((model) => ({ id: model.id, object: "model", owned_by: "zizhuji" })) });
      }
      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const upstream = await gateway.proxyChatCompletions(await readJson(req));
        if (!upstream || typeof upstream.status !== "number") throw bridgeError("UPSTREAM_INVALID", "Gateway response is invalid.");
        const headers = { "cache-control": "no-store", "content-type": upstream.headers?.get?.("content-type") || "application/json; charset=utf-8" };
        res.writeHead(upstream.status, headers);
        if (upstream.body) for await (const chunk of upstream.body) res.write(Buffer.from(chunk));
        return res.end();
      }
      return json(res, 404, { error: { type: "invalid_request_error", code: "not_found", message: "Endpoint not found." } });
    } catch (cause) {
      const statusCode = cause?.statusCode || (cause?.code === "AUTH_REQUIRED" ? 401 : cause?.code === "INSUFFICIENT_BALANCE" ? 402 : 502);
      return json(res, statusCode, { error: { type: "gateway_error", code: cause?.code || "GATEWAY_ERROR", message: cause?.message || "Gateway request failed." } });
    }
  }

  return Object.freeze({
    async start() {
      if (server) return { baseUrl, apiKey };
      server = http.createServer((req, res) => { handle(req, res).catch(() => { if (!res.headersSent) json(res, 500, { error: { code: "BRIDGE_ERROR", message: "Local bridge failed." } }); else res.destroy(); }); });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      const address = server.address();
      const publicHost = host === "::1" ? "[::1]" : host;
      baseUrl = `http://${publicHost}:${address.port}/v1`;
      return { baseUrl, apiKey };
    },
    async stop() {
      if (!server) return;
      const active = server;
      server = null;
      baseUrl = null;
      await new Promise((resolve, reject) => active.close((cause) => cause ? reject(cause) : resolve()));
    },
    handle
  });
}

module.exports = { createAinovelGatewayBridge };

