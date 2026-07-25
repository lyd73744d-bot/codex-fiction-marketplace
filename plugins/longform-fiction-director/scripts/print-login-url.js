"use strict";
const http = require("node:http");
const { readLoginUrl, readLock } = require("../server/login-url-store");

function probe(url) {
  return new Promise((resolve) => {
    try {
      const u = new URL(String(url || ""));
      const req = http.get({ hostname: u.hostname, port: u.port, path: "/", timeout: 1200 }, (res) => {
        res.resume();
        resolve(res.statusCode >= 200 && res.statusCode < 500);
      });
      req.on("error", () => resolve(false));
      req.on("timeout", () => { try { req.destroy(); } catch {} resolve(false); });
    } catch { resolve(false); }
  });
}

(async () => {
  const lock = readLock();
  const pub = readLoginUrl();
  const candidates = [];
  if (lock && lock.loginUrl) candidates.push({ source: "lock", ...lock });
  if (pub && pub.loginUrl) candidates.push({ source: pub.source || "file", ...pub });
  let chosen = null;
  for (const c of candidates) {
    if (await probe(c.loginUrl)) { chosen = c; break; }
  }
  const out = {
    ok: !!chosen,
    loginUrl: chosen?.loginUrl || null,
    shopUrl: chosen?.shopUrl || "https://catfk.com/shop/ZVZNANU8",
    source: chosen?.source || null,
    message: chosen
      ? "Open loginUrl in browser. After login, multi-model works; no casual popup later."
      : "No healthy login page. Run: node scripts/open-login-now.js"
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(chosen ? 0 : 2);
})();
