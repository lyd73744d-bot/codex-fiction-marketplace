"use strict";

const http = require("node:http");

const MAX_BODY_BYTES = 16 * 1024;

function json(res, status, value) {
  if (!res || res.writableEnded) return;
  const body = JSON.stringify(value);
  if (res.headersSent) {
    try { res.end(body); } catch {}
    return;
  }
  res.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8"
  });
  res.end(body);
}

function publicModel(model) {
  if (!model || typeof model !== "object") return null;
  const id = typeof model.id === "string" ? model.id : "";
  if (!id) return null;
  const isImage = /image|dall-e/i.test(id);
  const creditsRaw = Number(model.credits ?? model.creditCost ?? model.creditsPerCall);
  const credits = Number.isFinite(creditsRaw) && creditsRaw > 0 ? Math.floor(creditsRaw) : null;
  // 有积分即可调用：不再分强弱隐藏
  return {
    id,
    label: String(model.label || model.name || id),
    forWriting: !isImage,
    featured: credits != null,
    strong: credits != null,
    credits,
    isCover: isImage,
    hiddenByDefault: false
  };
}

function orderModels(models) {
  const list = Array.isArray(models) ? models.slice() : [];
  const rank = (model) => {
    const id = String(model.id || "").toLowerCase();
    if (id === "claude-opus-4-6") return 1;
    if (id === "claude-sonnet-5") return 2;
    if (id === "kimi-k3") return 3;
    if (id === "gemini-3.1-pro-preview") return 4;
    if (id === "gemini-3.5-flash") return 5;
    if (id === "doubao-seed-2-1-turbo") return 6;
    if (id === "glm-5.2") return 7;
    if (id === "minimax-m3") return 8;
    if (id === "deepseek-v4-flash") return 9;
    if (id === "deepseek-v4-pro") return 10;
    if (id === "kimi-k2.6") return 11;
    if (model.isCover) return 50;
    return 100;
  };
  return list.sort((left, right) => {
    const diff = rank(left) - rank(right);
    if (diff !== 0) return diff;
    return String(left.id).localeCompare(String(right.id));
  });
}

function page({ sourceLabel = "字字珠玑多模型网关", paymentPortalUrl = "https://catfk.com/shop/ZVZNANU8" } = {}) {
  const formHtml = `
    <form id="login">
      <label for="username">账号</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit" id="loginBtn">登录并连接模型</button>
    </form>
    <div class="shop-box">
      <div class="shop-title">积分小店</div>
      <div class="shop-desc">登录后按后台实时模型清单调用。积分可在小店购买或兑换。</div>
      <a class="shop-link" href="${String(paymentPortalUrl || "https://catfk.com/shop/ZVZNANU8")}" target="_blank" rel="noreferrer">打开积分小店</a><div style="margin-top:8px"><a class="shop-link" href="https://api.nanshanyougui.xyz/shop" target="_blank" rel="noreferrer">注册 / 登录 / 兑换积分</a></div>
    </div>`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>字字珠玑网关登录 · 写小说真的太简单了</title>
<style>
  :root { color-scheme: light; }
  body { max-width: 520px; margin: 6vh auto; font: 15px/1.5 system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; padding: 20px; color: #17202a; background: #f6f8fb; }
  .card { background: #fff; border: 1px solid #dbe3ee; border-radius: 14px; padding: 20px; box-shadow: 0 8px 24px rgba(23,32,42,.06); }
  h1 { margin: 0 0 6px; font-size: 22px; }
  .sub { margin: 0 0 8px; color: #5b6b7c; font-size: 13px; }
  .source { display:inline-block; margin: 0 0 14px; padding: 4px 10px; border-radius: 999px; background: #eef6ff; color: #1d4ed8; font-size: 12px; font-weight: 600; }
  label { display:block; margin: 10px 0 6px; font-size: 13px; color: #334155; }
  input { width: 100%; box-sizing: border-box; padding: 10px 12px; border: 1px solid #c9d4e3; border-radius: 10px; font: inherit; }
  button { width: 100%; margin-top: 14px; padding: 11px 14px; border: 0; border-radius: 10px; background: #2563eb; color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button.secondary { background: #e2e8f0; color: #0f172a; }
  button:disabled { opacity: .65; cursor: wait; }
  #status { margin: 0 0 12px; min-height: 1.4em; }
  #status.ok { color: #0f7b3a; }
  #status.bad { color: #b42318; }
  .panel { display: none; }
  .panel.show { display: block; }
  .kv { display: grid; grid-template-columns: 72px 1fr; gap: 6px 10px; margin: 0 0 12px; font-size: 13px; }
  .kv b { color: #64748b; font-weight: 600; }
  .hint { margin: 8px 0 0; color: #64748b; font-size: 12px; }
.model-block { margin-top: 14px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
.model-block > b { display: block; margin-bottom: 6px; color: #64748b; font-size: 13px; }
.model-list { display: grid; gap: 6px; }
.model-row { display: flex; justify-content: space-between; gap: 12px; font-size: 13px; }
.model-row span:first-child { min-width: 0; overflow-wrap: anywhere; }
.model-cost { flex: 0 0 auto; color: #64748b; }
.shop-box{margin-top:14px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc}
.shop-title{font-weight:600;margin-bottom:6px}
.shop-desc{font-size:13px;color:#475569;margin-bottom:8px;line-height:1.5}
.shop-link{color:#2563eb}
</style>
</head>
<body>
  <div class="card">
    <h1>字字珠玑网关登录</h1>
    <p class="sub">首次连接后只显示账号、积分和连接状态；掉线时再提醒。</p>
    <div class="source" id="sourceView">${escapeHtml(sourceLabel)}</div>
    <p id="status">正在检查模型连接…</p>
    ${formHtml}
    <div id="panel" class="panel">
      <div class="kv">
        <b>模型源</b><span id="sourcePanel">${escapeHtml(sourceLabel)}</span>
        <b>账号</b><span id="usernameView">-</span>
        <b>套餐</b><span id="planView">-</span>
        <b>积分</b><span id="balanceView">-</span>
        <b>用量</b><span id="usageView">-</span>
        <b>连接</b><span id="connView">-</span>
        <b>模型数</b><span id="modelCountView">-</span>
      </div>
      <button type="button" class="secondary" id="refreshBtn">刷新连接状态</button>
      <div class="model-block">
        <b>后台可用模型</b>
        <div class="model-list" id="modelListView"></div>
      </div>
    </div>
  </div>
<script>
const statusEl = document.getElementById("status");
const form = document.getElementById("login");
const panel = document.getElementById("panel");
const loginBtn = document.getElementById("loginBtn");
const refreshBtn = document.getElementById("refreshBtn");

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok === true ? "ok" : ok === false ? "bad" : "";
}

function renderDashboard(data) {
  const loggedIn = data.loggedIn === true;
  if (form) form.hidden = loggedIn;
  panel.classList.toggle("show", loggedIn);
  if (data.sourceLabel) {
    const sourceView = document.getElementById("sourceView");
    const sourcePanel = document.getElementById("sourcePanel");
    if (sourceView) sourceView.textContent = data.sourceLabel;
    if (sourcePanel) sourcePanel.textContent = data.sourceLabel;
  }
  if (!loggedIn) {
    document.getElementById("modelListView").replaceChildren();
    setStatus(data.message || "请连接模型。", false);
    return;
  }
  document.getElementById("usernameView").textContent = data.username || data.user?.username || "-";
  document.getElementById("balanceView").textContent = formatBalance(data);
  const planView = document.getElementById("planView");
  if (planView) planView.textContent = data.plan || data.user?.plan || "-";
  const usageView = document.getElementById("usageView");
  if (usageView) {
    const used = data.used ?? data.user?.used;
    const quota = data.quota ?? data.user?.quota;
    usageView.textContent = (used != null && quota != null) ? (used + " / " + quota) : (data.credits?.summary || "-");
  }
  document.getElementById("connView").textContent = data.online === true ? "在线" : data.online === false ? "离线" : "未知";
  document.getElementById("modelCountView").textContent = String(Array.isArray(data.models) ? data.models.length : 0);
  const modelListView = document.getElementById("modelListView");
  modelListView.replaceChildren();
  for (const model of (Array.isArray(data.models) ? data.models : [])) {
    const row = document.createElement("div");
    row.className = "model-row";
    const name = document.createElement("span");
    name.textContent = model.label || model.id || "未知模型";
    const cost = document.createElement("span");
    cost.className = "model-cost";
    cost.textContent = model.credits == null ? "" : (model.credits + " 积分");
    row.append(name, cost);
    modelListView.append(row);
  }
  setStatus(data.message || "模型已连接。", true);
}

function formatBalance(data) {
  if (data.credits?.label) return data.credits.label;
  const balance = data.balance ?? data.user?.balance;
  if (balance == null) return "-";
  if (Number(balance) < 0) return "不限（套餐账户）";
  return String(balance) + " 积分";
}

async function loadStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const data = await response.json();
  renderDashboard(data);
  return data;
}

if (form) form.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginBtn.disabled = true;
  setStatus("正在登录并连接模型…");
  try {
    const formData = new FormData(form);
    const body = { username: formData.get("username"), password: formData.get("password") };
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    renderDashboard(data);
    if (data.loggedIn) await loadStatus();
  } catch {
    setStatus("连接失败：本地页面或模型服务不可用。", false);
  } finally {
    loginBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  try { await loadStatus(); } finally { refreshBtn.disabled = false; }
});

loadStatus().catch(() => setStatus("无法读取模型连接状态。", false));
</script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readLogin(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk, "utf8");
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("Request is too large."), { statusCode: 413 }));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try {
        const value = JSON.parse(body || "{}");
        if (
          typeof value?.username !== "string"
          || typeof value?.password !== "string"
          || !value.username.trim()
          || !value.password
        ) {
          throw new Error("Invalid login.");
        }
        resolve({ username: value.username.trim(), password: value.password });
      } catch {
        reject(Object.assign(new Error("Invalid login."), { statusCode: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function formatCredits(user = {}, balance, models = []) {
  const plan = String(user.plan || "").toLowerCase();
  const accountType = String(user.accountType || "");
  const value = balance ?? user.balance;
  const quota = user.quota;
  const used = user.used;
  const callsLeft = user.callsLeft;
  const creditsPerCall = user.creditsPerCall;
  const modelCredits = user.modelCredits && typeof user.modelCredits === "object" ? user.modelCredits : null;
  const priceLines = [];
  if (modelCredits) {
    for (const [id, cost] of Object.entries(modelCredits)) priceLines.push(id + "：" + cost + " 积分");
  } else if (Array.isArray(models) && models.length) {
    for (const model of models) {
      if (model && model.id && model.credits != null) priceLines.push(model.id + "：" + model.credits + " 积分");
    }
  }
  const unlimited = plan.includes("unlimited")
    || accountType.includes("permanent")
    || Number(value) < 0
    || Number(callsLeft) < 0;

  if (unlimited) {
    const usage = Number.isFinite(Number(used)) && Number.isFinite(Number(quota))
      ? `可用模型 ${quota}，会话内已用 ${used}`
      : "积分由平价站服务端统计";
    return {
      label: "不限（套餐账户）",
      summary: `套餐不限积分；${usage}`,
      detail: [
        `套餐：${user.plan || "unlimited"}`,
        Number.isFinite(Number(quota)) ? `总额度：${quota}` : null,
        Number.isFinite(Number(used)) ? `已用：${used}` : null,
        Number.isFinite(Number(creditsPerCall)) ? `默认每次约：${creditsPerCall}` : null,
        priceLines.length ? ("模型定价：\n" + priceLines.join("\n")) : null,
        "说明：balance=-1 / callsLeft=-1 表示不限，不是欠费。"
      ].filter(Boolean).join("\n")
    };
  }

  if (value == null) {
    return { label: "未知", summary: "积分未知", detail: "服务端未返回积分字段。" };
  }

  return {
    label: `${value} 积分`,
    summary: `积分 ${value}`,
    detail: [
      Number.isFinite(Number(callsLeft)) ? `剩余次数：${callsLeft}` : null,
      Number.isFinite(Number(creditsPerCall)) ? `默认每次约：${creditsPerCall}` : null,
      priceLines.length ? ("模型定价：\n" + priceLines.join("\n")) : null
    ].filter(Boolean).join("\n")
  };
}

function formatBalanceText(user, balance) {
  return formatCredits(user, balance).summary;
}

function createGatewayLoginConsole({ gateway, host = "127.0.0.1", port = 0, keepAlive = false, sourceLabel, paymentPortalUrl = process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || "https://catfk.com/shop/ZVZNANU8", onLoginSuccess } = {}) {
  const resolvedPaymentPortalUrl = String(paymentPortalUrl || "https://catfk.com/shop/ZVZNANU8");
  if (!gateway || typeof gateway.accountStatus !== "function" || typeof gateway.login !== "function") {
    throw new TypeError("gateway login support is required");
  }
  if (host !== "127.0.0.1") throw new Error("gateway login console must bind to loopback");
  let server = null;
  let origin = null;
  const resolvedAuthMode = "password";
  const resolvedSourceLabel = sourceLabel
    || gateway?.label
    || "字字珠玑多模型网关";

  async function modelsSnapshot() {
    if (typeof gateway.listModels !== "function") return [];
    try {
      const catalog = await gateway.listModels();
      const raw = Array.isArray(catalog) ? catalog : catalog?.models;
      if (!Array.isArray(raw)) return [];
      return raw.map(publicModel).filter(Boolean);
    } catch {
      return [];
    }
  }

  async function runProbe() {
    const started = Date.now();
    const lines = [];
    let ok = true;

    try {
      const account = await gateway.accountStatus();
      if (account?.loggedIn === true && account?.active !== false) {
        lines.push("账号会话：有效");
        const credits = formatCredits(account.user || {}, account.balance ?? account.user?.balance, []);
        lines.push(`积分：${credits.label}`);
        if (credits.detail) lines.push(credits.detail);
      } else {
        ok = false;
        lines.push("账号会话：无效");
      }
    } catch (error) {
      ok = false;
      lines.push(`账号会话：失败（${error?.code || error?.message || "error"}）`);
    }

    try {
      const models = await modelsSnapshot();
      const writable = models.filter((item) => item.forWriting);
      if (models.length === 0) {
        ok = false;
        lines.push("模型列表：为空");
      } else {
        const ordered = orderModels(models);
        const strong = ordered.filter((item) => item.strong);
        lines.push(`模型列表：${models.length} 个（可写作 ${writable.length}，封面 ${models.filter((item) => item.isCover).length}）`);
        lines.push(`可用模型：${ordered.slice(0, 12).map((item) => item.id + "(" + (item.credits || "?") + ")").join("，") || "无"}`);
      }
    } catch (error) {
      ok = false;
      lines.push(`模型列表：失败（${error?.code || error?.message || "error"}）`);
    }

    lines.push(`耗时：${Date.now() - started} ms`);
    return {
      ok,
      detail: lines.join("\n"),
      checkedAt: new Date().toISOString()
    };
  }

  async function dashboard({ probe = false } = {}) {
    let account;
    try {
      account = await gateway.accountStatus();
    } catch {
      return {
        loggedIn: false,
        online: false,
        authMode: resolvedAuthMode,
        sourceLabel: resolvedSourceLabel,
        message: "模型服务暂时不可用，请稍后重试。",
        models: [],
        probe: null
      };
    }

    const loggedIn = account?.loggedIn === true && account?.active !== false;
    if (!loggedIn) {
      return {
        loggedIn: false,
        online: null,
        authMode: resolvedAuthMode,
        sourceLabel: resolvedSourceLabel,
        message: "请使用字字珠玑账号密码登录。",
        models: [],
        probe: null
      };
    }

    const models = await modelsSnapshot();
    const writable = models.filter((item) => item.forWriting);
    const ordered = orderModels(models);
    const balance = account.balance ?? account.user?.balance ?? null;
    const username = account.user?.username || account.username || null;
    const user = Object.assign({}, account.user || {}, {
      modelCredits: (account.user && account.user.modelCredits) || gateway.modelCredits || null
    });
    const credits = formatCredits(user, balance, ordered);
    const result = {
      loggedIn: true,
      online: true,
      authMode: resolvedAuthMode,
      sourceLabel: resolvedSourceLabel,
      username,
      balance,
      plan: user.plan || null,
      quota: user.quota,
      used: user.used,
      callsLeft: user.callsLeft,
      creditsPerCall: user.creditsPerCall,
      accountType: user.accountType || null,
      credits,
      user: {
        username: user.username,
        balance: user.balance,
        plan: user.plan,
        quota: user.quota,
        used: user.used,
        callsLeft: user.callsLeft,
        creditsPerCall: user.creditsPerCall,
        accountType: user.accountType,
        modelCredits: user.modelCredits || gateway.modelCredits || null
      },
      modelCredits: user.modelCredits || gateway.modelCredits || null,
      modelCount: ordered.length,
      models: ordered.slice(0, 120),
      strongModels: ordered.filter((item) => item.strong).slice(0, 40),
      hiddenWeakCount: ordered.filter((item) => item.hiddenByDefault).length,
      message: `模型已连接。${credits.summary}，可用模型 ${ordered.length} 个（有积分即可调用）。`,
      probe: null
    };
    if (probe) result.probe = await runProbe();
    return result;
  }

  async function handle(req, res) {
    const requestUrl = new URL(req.url || "/", origin || "http://127.0.0.1");
    try {
      if (requestUrl.pathname === "/" && req.method === "GET") {
        const html = page({ sourceLabel: resolvedSourceLabel, paymentPortalUrl: resolvedPaymentPortalUrl });
        if (res.writableEnded) return;
        if (!res.headersSent) {
          res.writeHead(200, {
            "cache-control": "no-store",
            "content-type": "text/html; charset=utf-8"
          });
        }
        res.end(html);
        return;
      }
      if (requestUrl.pathname === "/api/status" && req.method === "GET") {
        const probe = requestUrl.searchParams.get("probe") === "1";
        return json(res, 200, await dashboard({ probe }));
      }
      if (requestUrl.pathname === "/api/probe" && req.method === "POST") {
        const data = await dashboard({ probe: true });
        return json(res, data.loggedIn ? 200 : 401, data);
      }
      if (requestUrl.pathname === "/api/login" && req.method === "POST") {
        if (req.headers.origin !== origin) {
          return json(res, 403, { loggedIn: false, message: "登录请求来源无效。" });
        }
        const login = await readLogin(req);
        await gateway.login(login);
        const current = await dashboard({ probe: true });
        if (current.loggedIn) {
          try {
            const onboarding = require("./onboarding-state");
            await onboarding.markLoginOk();
          } catch {}
          if (typeof onLoginSuccess === "function") {
            try { await onLoginSuccess(current); } catch {}
          }
        }
        return json(
          res,
          current.loggedIn ? 200 : 401,
          {
            ...current,
            shopUrl: resolvedPaymentPortalUrl,
            message: current.loggedIn
              ? ((current.message || "登录成功。") + " 之后不会再乱弹登录窗，掉线才会提醒。")
              : "登录失败，请检查账号密码。"
          }
        );
      }
      return json(res, 404, { message: "未找到接口。" });
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      return json(res, 500, { loggedIn: false, message: "模型连接页面暂时不可用。" });
    }
  }

  return Object.freeze({
    async start() {
      if (server) return { url: origin };
      server = http.createServer((req, res) => {
        Promise.resolve(handle(req, res)).catch(() => {
          if (res.writableEnded) return;
          try {
            json(res, 500, { loggedIn: false, message: "模型连接页面暂时不可用。" });
          } catch {}
        });
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      origin = `http://127.0.0.1:${server.address().port}`;
      if (!keepAlive && typeof server.unref === "function") server.unref();
      return { url: origin };
    },
    async stop() {
      if (!server) return;
      const active = server;
      server = null;
      origin = null;
      await new Promise((resolve, reject) => active.close((error) => (error ? reject(error) : resolve())));
    }
  });
}

module.exports = { createGatewayLoginConsole };
