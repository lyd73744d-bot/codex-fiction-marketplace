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

function isGptModel(model) {
  return /\bgpt(?:[-_.:]|$)/iu.test(String(model?.id || ""))
    || /\bgpt(?:\s|$)/iu.test(String(model?.label || model?.name || ""));
}

function publicModel(model) {
  if (!model || typeof model !== "object") return null;
  const id = typeof model.id === "string" ? model.id : "";
  if (!id) return null;
  const isImage = /^gpt-image-/i.test(id) || /image|dall-e/i.test(id);
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

/** Keep only models that are strong enough for longform writing by default. */
function isStrongModel(id) {
  const value = String(id || "").toLowerCase();
  if (!value) return false;
  // explicit allowlist first (before weak filters like flash/mini)
  if (/claude-opus-4(?:[-.]?)6(?:-thinking)?$/.test(value)) return true;
  if (value === "gemini-3.1-pro-preview") return true;
  if (value === "gemini-3.5-flash") return true;
  if (value === "glm-5.2") return true;
  if (/^gpt-5(?:\.6)?-(terra|luna)$/.test(value)) return true;
  if (value === "gpt-5" || value === "gpt-5-5" || value === "gpt-5-3" || value === "gpt-5-mini") return true;
  if (value === "seed-2.1-pro" || value === "seed-2.1-turbo") return true;
  if (value === "kimi-k2.6") return true;
  if (value === "qwen3.7-max") return true;
  if (value === "gpt-image-2") return true;
  if (isGptModel({ id: value })) return false;
  if (isWeakModel(value)) return false;
  return false;
}

function isWeakModel(id) {
  const value = String(id || "").toLowerCase();
  return /haiku|flash|mini|nano|turbo|preview|vl-flash|fable|nemotron|llama|mistral|next-80b|sonnet-4(?![-.]?[56])|sonnet-4-thinking|hy3$/.test(value);
}

function orderModels(models) {
  const list = Array.isArray(models) ? models.slice() : [];
  const rank = (model) => {
    const id = String(model.id || "").toLowerCase();
    if (/claude-opus-4(?:[-.]?)6(?:-thinking)?$/.test(id)) return 1;
    if (id === "gemini-3.1-pro-preview") return 2;
    if (id === "gpt-5.6-terra") return 3;
    if (id === "gpt-5-5" || id === "gpt-5") return 4;
    if (id === "kimi-k2.6") return 5;
    if (id === "seed-2.1-pro") return 6;
    if (id === "glm-5.2") return 7;
    if (id === "gpt-5-3") return 8;
    if (id === "gemini-3.5-flash") return 9;
    if (id === "seed-2.1-turbo") return 10;
    if (id === "gpt-5.6-luna") return 11;
    if (id === "gpt-5-mini") return 12;
    if (id === "qwen3.7-max") return 13;
    if (id === "gpt-image-2") return 14;
    if (model.isCover) return 50;
    return 100;
  };
  return list.sort((left, right) => {
    const diff = rank(left) - rank(right);
    if (diff !== 0) return diff;
    return String(left.id).localeCompare(String(right.id));
  });
}

function page({ authMode = "password", sourceLabel = "默认模型源", paymentPortalUrl = "https://catfk.com/shop/ZVZNANU8" } = {}) {
  const isApiKey = authMode === "api_key";
  const formHtml = isApiKey
    ? `
    <form id="login">
      <label for="apiKey">API 密钥</label>
      <input id="apiKey" name="apiKey" type="password" autocomplete="off" required placeholder="sk-...">
      <p class="hint">密钥写入第一模型源（平价站），不是本地假登录。</p>
      <button type="submit" id="loginBtn">登录并连接模型</button>
    </form>`
    : `
    <form id="login">
      <label for="username">账号</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit" id="loginBtn">登录并连接模型</button>
    </form>
    <div class="shop-box">
      <div class="shop-title">积分小店</div>
      <div class="shop-desc">登录后可调用多模型。小店可买积分；不充值也能用，但效果会差很多。店铺链接后续可替换。</div>
      <a class="shop-link" href="${String(paymentPortalUrl || "https://catfk.com/shop/ZVZNANU8")}" target="_blank" rel="noreferrer">打开小店</a>
    </div>`
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
  .models { max-height: 240px; overflow: auto; border: 1px solid #e2e8f0; border-radius: 10px; background: #fafcff; }
  .models li { list-style: none; margin: 0; padding: 8px 10px; border-bottom: 1px solid #eef2f7; font-size: 13px; }
  .models li:last-child { border-bottom: 0; }
  .tag { display: inline-block; margin-left: 6px; padding: 1px 6px; border-radius: 999px; background: #e8f6ee; color: #0f7b3a; font-size: 11px; }
  .tag.muted { background: #f1f5f9; color: #64748b; }
  .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  .hint { margin: 8px 0 0; color: #64748b; font-size: 12px; }
  #probe { white-space: pre-wrap; font-size: 13px; background: #f8fafc; border-radius: 10px; padding: 10px; border: 1px solid #e2e8f0; min-height: 48px; }
.shop-box{margin-top:14px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc}
.shop-title{font-weight:600;margin-bottom:6px}
.shop-desc{font-size:13px;color:#475569;margin-bottom:8px;line-height:1.5}
.shop-link{color:#2563eb}
</style>
</head>
<body>
  <div class="card">
    <h1>字字珠玑网关登录</h1>
    <p class="sub">首次安装必弹一次；登录成功后不乱弹，掉线才再提醒。可打开小店充值积分。</p>
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
        <b>测活</b><span id="probeView">未测</span>
        <b>模型数</b><span id="modelCountView">-</span>
      </div>
      <div class="actions">
        <button type="button" class="secondary" id="refreshBtn">刷新状态</button>
        <button type="button" id="probeBtn">测活</button>
      </div>
      <p style="margin:14px 0 6px;font-size:13px;color:#5b6b7c;">已配置模型全部显示；有积分即可调用。</p>
      <input id="modelFilter" type="search" placeholder="搜索模型，例如 grok、deepseek、seed" style="margin:0 0 8px;padding:10px 12px;border:1px solid #c9d4e3;border-radius:10px;width:100%;box-sizing:border-box;font:inherit;">
      <label style="display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:13px;color:#334155;"><input id="showAllModels" type="checkbox" style="width:auto;margin:0;">显示全部模型</label>
      <ul id="models" class="models"></ul>
      <p id="modelHiddenNote" style="margin:6px 0 0;font-size:12px;color:#5b6b7c;"></p>
      <pre id="probe"></pre>
    </div>
  </div>
<script>
const AUTH_MODE = ${JSON.stringify(isApiKey ? "api_key" : "password")};
const statusEl = document.getElementById("status");
const form = document.getElementById("login");
const panel = document.getElementById("panel");
const modelsEl = document.getElementById("models");
const probeEl = document.getElementById("probe");
const loginBtn = document.getElementById("loginBtn");
const refreshBtn = document.getElementById("refreshBtn");
const probeBtn = document.getElementById("probeBtn");

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
  document.getElementById("probeView").textContent = data.probe?.ok ? "通过" : data.probe ? "未通过" : "未测";
  document.getElementById("probeView").className = data.probe?.ok ? "ok" : data.probe ? "bad" : "";
  window.__allModels = Array.isArray(data.models) ? data.models : [];
  document.getElementById("modelCountView").textContent = String(window.__allModels.length);
  renderModelList();
  if (data.probe?.detail) probeEl.textContent = data.probe.detail;
  setStatus(data.message || "模型已连接。", true);
}

function formatBalance(data) {
  if (data.credits?.label) return data.credits.label;
  const balance = data.balance ?? data.user?.balance;
  if (balance == null) return "-";
  if (Number(balance) < 0) return "不限（套餐账户）";
  return String(balance) + " 积分";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderModelList() {
  const filter = String(document.getElementById("modelFilter")?.value || "").trim().toLowerCase();
  const showAll = document.getElementById("showAllModels")?.checked === true;
  const all = Array.isArray(window.__allModels) ? window.__allModels : [];
  const visible = all.filter((model) => {
    if (!showAll && model.hiddenByDefault && Number(model.credits) <= 0) return false;
    if (!filter) return true;
    return String(model.id || "").toLowerCase().includes(filter)
      || String(model.label || "").toLowerCase().includes(filter);
  });
  modelsEl.innerHTML = visible.map((model) => {
    const tags = [];
    if (Number(model.credits) > 0) tags.push('<span class="tag">' + model.credits + '积分</span>');
    if (model.credits != null) tags.push('<span class="tag muted">' + model.credits + '积分</span>');
    if (model.isCover) tags.push('<span class="tag muted">封面</span>');
    if (model.isCover) tags.push('<span class="tag muted">封面</span>');
    return "<li><code>" + escapeHtml(model.id) + "</code>" + tags.join("") + "</li>";
  }).join("");
  const hidden = all.filter((model) => model.hiddenByDefault).length;
  const note = document.getElementById("modelHiddenNote");
  if (note) {
    note.textContent = showAll
      ? ("共 " + all.length + " 个模型")
      : ("已隐藏弱模型 " + hidden + " 个；当前显示 " + visible.length + " 个");
  }
  document.getElementById("modelCountView").textContent = String(visible.length) + (showAll ? "" : (" / " + all.length));
}

document.getElementById("modelFilter")?.addEventListener("input", renderModelList);
document.getElementById("showAllModels")?.addEventListener("change", renderModelList);

async function loadStatus(withProbe) {
  const url = withProbe ? "/api/status?probe=1" : "/api/status";
  const response = await fetch(url, { cache: "no-store" });
  const data = await response.json();
  renderDashboard(data);
  return data;
}

if (form) form.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginBtn.disabled = true;
  setStatus(AUTH_MODE === "api_key" ? "正在把密钥写入模型源并连接…" : "正在登录并连接模型…");
  try {
    const formData = new FormData(form);
    const body = AUTH_MODE === "api_key"
      ? { apiKey: formData.get("apiKey"), username: "平价站" }
      : { username: formData.get("username"), password: formData.get("password") };
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    renderDashboard(data);
    if (data.loggedIn) await loadStatus(true);
  } catch {
    setStatus("连接失败：本地页面或模型服务不可用。", false);
  } finally {
    loginBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  try { await loadStatus(false); } finally { refreshBtn.disabled = false; }
});

probeBtn.addEventListener("click", async () => {
  probeBtn.disabled = true;
  setStatus("正在测活…");
  try { await loadStatus(true); } finally { probeBtn.disabled = false; }
});

loadStatus(false).then((data) => {
  if (data && data.loggedIn) return loadStatus(true);
}).catch(() => setStatus("无法读取模型连接状态。", false));
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
        const apiKey = typeof value?.apiKey === "string" ? value.apiKey.trim() : "";
        if (apiKey) {
          if (apiKey.length < 8 || apiKey.length > 512) throw new Error("Invalid login.");
          const username = typeof value?.username === "string" && value.username.trim()
            ? value.username.trim()
            : "api-key";
          resolve({ username, apiKey, password: apiKey });
          return;
        }
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
    const isApiKeyAccount = accountType === "api_key" || plan.includes("openai");
    return {
      label: "不限（套餐账户）",
      summary: isApiKeyAccount ? `套餐账户（不限次数）；${usage}` : `套餐不限积分；${usage}`,
      detail: [
        `套餐：${user.plan || (isApiKeyAccount ? "openai-compatible" : "unlimited")}`,
        Number.isFinite(Number(quota)) ? (isApiKeyAccount ? `可见模型：${quota}` : `总额度：${quota}`) : null,
        Number.isFinite(Number(used)) ? `已用：${used}` : null,
        Number.isFinite(Number(creditsPerCall)) ? `默认每次约：${creditsPerCall}` : null,
        priceLines.length ? ("模型定价：\n" + priceLines.join("\n")) : null,
        isApiKeyAccount
          ? "说明：OpenAI 兼容密钥模式以服务端实际扣费为准；本地 balance=-1 表示未返回数字积分。"
          : "说明：balance=-1 / callsLeft=-1 表示不限，不是欠费。"
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

function createGatewayLoginConsole({ gateway, host = "127.0.0.1", port = 0, keepAlive = false, sourceLabel, authMode, paymentPortalUrl = process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || "https://catfk.com/shop/ZVZNANU8", onLoginSuccess } = {}) {
  const resolvedPaymentPortalUrl = String(paymentPortalUrl || "https://catfk.com/shop/ZVZNANU8");
  if (!gateway || typeof gateway.accountStatus !== "function" || typeof gateway.login !== "function") {
    throw new TypeError("gateway login support is required");
  }
  if (host !== "127.0.0.1") throw new Error("gateway login console must bind to loopback");
  let server = null;
  let origin = null;
  const resolvedAuthMode = authMode
    || (gateway?.kind === "openai-compatible" || gateway?.kind === "hybrid" ? "api_key" : "password");
  const resolvedSourceLabel = sourceLabel
    || gateway?.label
    || (resolvedAuthMode === "api_key" ? "平价站第一模型源" : "默认模型源");
  async function persistPrimaryKey(login) {
    if (resolvedAuthMode !== "api_key") return;
    const apiKey = String(login.apiKey || login.password || "").trim();
    if (!apiKey) return;
    try {
      const { savePrimaryGatewayConfig } = require("./gateway-config");
      await savePrimaryGatewayConfig({
        mode: "openai",
        label: resolvedSourceLabel,
        baseUrl: gateway.baseUrl,
        apiKey
      });
    } catch {
      // keep login usable even if config write fails
    }
  }

  async function connection() {
    if (typeof gateway.connectionStatus !== "function") return { online: null };
    try {
      const status = await gateway.connectionStatus();
      return { online: status?.online === true, connection: status };
    } catch {
      return { online: false };
    }
  }

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
    const conn = await connection();
    if (conn.online === true) lines.push("服务连通：通过");
    else if (conn.online === false) {
      ok = false;
      lines.push("服务连通：失败");
    } else {
      lines.push("服务连通：未检测");
    }

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
    const conn = await connection();
    let account;
    try {
      account = await gateway.accountStatus();
    } catch {
      return {
        loggedIn: false,
        online: conn.online,
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
        online: conn.online,
        authMode: resolvedAuthMode,
        sourceLabel: resolvedSourceLabel,
        message: resolvedAuthMode === "api_key" ? "请输入 API 密钥连接平价站第一模型源。" : "请登录以连接模型。",
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
      online: conn.online,
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
        const html = page({ authMode: resolvedAuthMode, sourceLabel: resolvedSourceLabel, paymentPortalUrl: resolvedPaymentPortalUrl });
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
        await persistPrimaryKey(login);
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
              : (resolvedAuthMode === "api_key" ? "连接失败，请检查 API 密钥。" : "登录失败，请检查账号密码。")
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
