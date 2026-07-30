"use strict";

const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");
const os = require("node:os");
const { Readable } = require("node:stream");

const ALIDNS_HOST = "dns.alidns.com";
const ALIDNS_IP = "223.5.5.5";
const cache = new Map();

function isClashFakeIpv4(value = "") {
  const parts = String(value || "").split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 198 && (parts[1] === 18 || parts[1] === 19);
}

function isUsableIpv4(value = "") {
  if (net.isIP(String(value || "")) !== 4 || isClashFakeIpv4(value)) return false;
  const [a, b] = String(value).split(".").map(Number);
  return a !== 0 && a !== 127 && !(a === 169 && b === 254) && a < 224;
}

function addressScore(address = "") {
  const [a, b] = String(address).split(".").map(Number);
  if (a === 192 && b === 168) return 30;
  if (a === 10) return 20;
  if (a === 172 && b >= 16 && b <= 31) return 10;
  return 0;
}

function selectPhysicalIpv4(interfaces = os.networkInterfaces()) {
  const override = String(process.env.FICTION_DIRECTOR_LOCAL_ADDRESS || "").trim();
  if (override) {
    if (!isUsableIpv4(override)) throw new Error("FICTION_DIRECTOR_LOCAL_ADDRESS is invalid");
    return override;
  }
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces || {})) {
    for (const item of entries || []) {
      const family = typeof item.family === "string" ? item.family : Number(item.family) === 4 ? "IPv4" : "";
      if (family !== "IPv4" || item.internal || !isUsableIpv4(item.address)) continue;
      candidates.push({ address: item.address, name, score: addressScore(item.address) });
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  if (!candidates.length) throw new Error("No physical IPv4 address was found");
  return candidates[0].address;
}

function resolveViaAliDns(hostname, options = {}) {
  const cached = cache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.address);
  const resolverIp = String(options.resolverIp || process.env.FICTION_DIRECTOR_DOH_IP || ALIDNS_IP).trim();
  if (!isUsableIpv4(resolverIp)) return Promise.reject(new Error("DoH resolver IP is invalid"));

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: resolverIp,
      port: 443,
      servername: ALIDNS_HOST,
      localAddress: options.localAddress || selectPhysicalIpv4(),
      path: `/resolve?name=${encodeURIComponent(hostname)}&type=A`,
      method: "GET",
      headers: { host: ALIDNS_HOST, accept: "application/dns-json", "accept-encoding": "identity" },
      signal: AbortSignal.timeout(8_000)
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
        if (body.length > 64 * 1024) request.destroy(new Error("DoH response too large"));
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error(`DoH request failed (${response.statusCode})`));
        let payload;
        try { payload = JSON.parse(body); } catch { return reject(new Error("DoH response is invalid")); }
        const answer = Array.isArray(payload.Answer)
          ? payload.Answer.find((item) => Number(item?.type) === 1 && isUsableIpv4(item?.data))
          : null;
        if (!answer) return reject(new Error("DoH returned no usable IPv4 address"));
        const ttlMs = Math.max(60_000, Math.min(Number(answer.TTL || 300) * 1000, 10 * 60_000));
        cache.set(hostname, { address: answer.data, expiresAt: Date.now() + ttlMs });
        resolve(answer.data);
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function directHttpsFetch(input, init = {}, route = {}) {
  const url = new URL(String(input));
  if (url.protocol !== "https:" || !isUsableIpv4(route.address)) {
    return Promise.reject(new Error("Direct HTTPS route is invalid"));
  }
  const headers = new Headers(init.headers || {});
  headers.set("host", url.host);
  if (!headers.has("accept-encoding")) headers.set("accept-encoding", "identity");

  return new Promise((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname: route.address,
      port: Number(url.port || 443),
      servername: url.hostname,
      localAddress: route.localAddress || selectPhysicalIpv4(),
      path: `${url.pathname}${url.search}`,
      method: init.method || "GET",
      headers: Object.fromEntries(headers.entries()),
      signal: init.signal
    }, (response) => {
      const responseHeaders = new Headers();
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(name, item));
        else if (value != null) responseHeaders.set(name, String(value));
      }
      const status = response.statusCode || 500;
      const noBody = [101, 204, 205, 304].includes(status);
      resolve(new Response(noBody ? null : Readable.toWeb(response), {
        status,
        statusText: response.statusMessage || "",
        headers: responseHeaders
      }));
    });
    request.on("error", reject);
    if (init.body != null) request.write(init.body);
    request.end();
  });
}

function createFakeIpAwareFetch(options = {}) {
  const baseFetch = options.baseFetch || globalThis.fetch;
  const lookup = options.lookup || dns.lookup;
  const resolveAddress = options.resolveAddress || resolveViaAliDns;
  const directFetch = options.directFetch || directHttpsFetch;
  if (typeof baseFetch !== "function") throw new TypeError("base fetch is required");

  return async function fakeIpAwareFetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.protocol !== "https:" || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)) {
      return baseFetch(input, init);
    }
    let addresses;
    try { addresses = await lookup(url.hostname, { all: true }); }
    catch { addresses = []; }
    if (!addresses.some((item) => isClashFakeIpv4(item?.address))) return baseFetch(input, init);

    const localAddress = options.localAddress || selectPhysicalIpv4(options.interfaces);
    const address = String(options.gatewayIp || process.env.FICTION_DIRECTOR_GATEWAY_IP || "").trim()
      || await resolveAddress(url.hostname, { localAddress });
    if (!isUsableIpv4(address)) throw new Error("Resolved gateway address is invalid");
    return directFetch(input, init, { address, localAddress });
  };
}

module.exports = {
  createFakeIpAwareFetch,
  directHttpsFetch,
  isClashFakeIpv4,
  isUsableIpv4,
  resolveViaAliDns,
  selectPhysicalIpv4
};
