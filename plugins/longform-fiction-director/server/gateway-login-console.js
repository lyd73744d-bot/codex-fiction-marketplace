"use strict";

const http = require("node:http");
const { accountMode } = require("./billing-guard");
const { filterDisabledModels, isDisabledModel } = require("./disabled-models");

const MAX_BODY_BYTES = 16 * 1024;

const MODEL_DISPLAY_NAMES = Object.freeze({
  "claude-opus-4-6": "Claude Opus 4.6 · 长文",
  "claude-opus-4-8": "Claude Opus 4.8 · 长文",
  "claude-opus-5": "Claude Opus 5 · 长文",
  "claude-sonnet-5": "Claude Sonnet 5 · 均衡",
  "kimi-k2.6": "Kimi K2.6 · 中文",
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro · 推理",
  "doubao-seed-2-1-turbo": "豆包 Seed 2.1 Turbo · 中文",
  "glm-5.2": "GLM 5.2 · 中文",
  "minimax-m3": "MiniMax M3 · 中文",
  "deepseek-v4-flash": "DeepSeek V4 Flash · 快速",
  "deepseek-v4-pro": "DeepSeek V4 Pro · 推理"
});

function modelDisplayName(id, fallback = "") {
  return MODEL_DISPLAY_NAMES[String(id || "")] || String(fallback || id || "未知模型");
}

function gatewayErrorMessage(error, fallback = "网关暂时无法完成请求。") {
  const code = String(error?.code || "").toUpperCase();
  const messages = {
    AUTH_REQUIRED: "还没有绑定账号，请登录或注册后再继续。",
    AUTH_FAILED: "账号或密码不正确，请检查后重试。",
    INVALID_REQUEST: "提交内容不符合要求，请检查账号、密码或兑换码。",
    INSUFFICIENT_BALANCE: "积分余额不足，本次调用已停止；请先充值或兑换积分。",
    BILLING_UNAVAILABLE: "实时费率或余额暂时无法确认，为避免隐藏扣费，本次调用已停止。",
    REGISTRATION_FAILED: "注册失败，请检查账号是否已存在或联系网关管理员。",
    SERVER_OFFLINE: "本机暂时连不上网关，请检查网络后刷新。",
    UPSTREAM_TIMEOUT: "模型响应超时，已收到的内容会保留，请稍后重试。",
    RATE_LIMITED: "模型线路正在限流，本次没有自动重试。",
    SERVER_ERROR: "网关服务返回错误，请稍后刷新再试。",
    RESPONSE_INVALID: "网关返回的数据无法识别，请刷新页面再试。"
  };
  const message = error?.publicMessage || messages[code] || fallback;
  return code && !messages[code] && /^[A-Z0-9_:-]{2,80}$/u.test(code)
    ? `${message}（${code}）`
    : message;
}

function errorStatus(error, fallback = 500) {
  const status = Number(error?.status || error?.statusCode);
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  if (String(error?.code || "") === "AUTH_FAILED" || String(error?.code || "") === "AUTH_REQUIRED") return 401;
  if (String(error?.code || "") === "INSUFFICIENT_BALANCE") return 402;
  if (String(error?.code || "") === "INVALID_REQUEST") return 400;
  if (String(error?.code || "") === "REGISTRATION_FAILED") return 409;
  return fallback;
}

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
  if (!id || isDisabledModel(id)) return null;
  const isImage = /image|dall-e/i.test(id);
  const creditsRaw = Number(model.credits ?? model.creditCost ?? model.creditsPerCall);
  const credits = Number.isFinite(creditsRaw) && creditsRaw >= 0 ? Math.floor(creditsRaw) : null;
  // 有积分即可调用：不再分强弱隐藏
  return {
    id,
    label: modelDisplayName(id, model.label || model.name || id),
    modelId: id,
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
    if (id === "gemini-3.1-pro-preview") return 3;
    if (id === "doubao-seed-2-1-turbo") return 4;
    if (id === "glm-5.2") return 5;
    if (id === "minimax-m3") return 6;
    if (id === "deepseek-v4-flash") return 7;
    if (id === "deepseek-v4-pro") return 8;
    if (id === "kimi-k2.6") return 9;
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
    <div id="authSurface" class="auth-surface" hidden>
    <div class="mode-switch" role="tablist" aria-label="账号操作">
      <button type="button" class="mode-btn active" id="loginModeBtn" data-mode="login">登录</button>
      <button type="button" class="mode-btn" id="registerModeBtn" data-mode="register">注册</button>
    </div>
    <p class="auth-hint" id="authHint">已有字字珠玑账号？登录后立即绑定插件。</p>
    <form id="login">
      <label for="username">账号</label>
      <input id="username" name="username" autocomplete="username" required>
      <label for="password">密码</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <div id="inviteField" hidden>
        <label for="inviteCode">邀请码（可选）</label>
        <input id="inviteCode" name="inviteCode" autocomplete="off">
      </div>
      <button type="submit" id="loginBtn">登录并绑定写作插件</button>
    </form>
    <div class="shop-box">
      <div class="shop-title">先绑定，再调用模型</div>
      <div class="shop-desc">模型按次计费。每次调用前显示模型费率和余额，余额不足会拦截；调用后再读取余额，确认实际有没有扣除。</div>
      <div class="link-row"><a class="shop-link" href="${escapeHtml(paymentPortalUrl || "https://catfk.com/shop/ZVZNANU8")}" target="_blank" rel="noreferrer">打开积分小店</a><a class="shop-link" href="https://api.nanshanyougui.xyz/shop" target="_blank" rel="noreferrer">查看账号中心</a></div>
    </div>
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
  .auth-surface[hidden] { display: none; }
  .kv { display: grid; grid-template-columns: 88px 1fr; gap: 8px 10px; margin: 0 0 12px; font-size: 13px; }
  .kv b { color: #64748b; font-weight: 600; }
  .hint { margin: 8px 0 0; color: #64748b; font-size: 12px; }
.mode-switch { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 14px 0 6px; }
.mode-btn { margin: 0; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff; color: #334155; }
.mode-btn.active { border-color: #2563eb; background: #eff6ff; color: #1d4ed8; }
.auth-hint { margin: 0 0 8px; color: #475569; font-size: 13px; }
.auth-links { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 8px; font-size: 13px; }
.model-block { margin-top: 14px; border-top: 1px solid #e2e8f0; padding-top: 12px; }
.model-block > b { display: block; margin-bottom: 6px; color: #64748b; font-size: 13px; }
.model-list { display: grid; gap: 6px; }
.model-row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; padding: 5px 0; border-bottom: 1px solid #f1f5f9; font-size: 13px; }
.model-row span:first-child { min-width: 0; overflow-wrap: anywhere; }
.model-cost { flex: 0 0 auto; color: #0f7b3a; font-weight: 600; white-space: nowrap; }
.billing-banner { margin: 0 0 14px; padding: 11px 12px; border-left: 3px solid #2563eb; background: #eff6ff; color: #1e3a8a; font-size: 13px; }
.billing-banner.warn { border-left-color: #b45309; background: #fffbeb; color: #92400e; }
.retry-button { margin: 0 0 12px; }
.redeem-box{margin-top:14px;padding-top:12px;border-top:1px solid #e2e8f0}
.redeem-box form{display:flex;gap:8px;align-items:end}
.redeem-box label{flex:1;margin:0}
.redeem-box input{margin-top:6px}
.redeem-box button{width:auto;white-space:nowrap;margin:0}
.shop-box{margin-top:14px;padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f8fafc}
.shop-title{font-weight:600;margin-bottom:6px}
.shop-desc{font-size:13px;color:#475569;margin-bottom:8px;line-height:1.5}
.link-row{display:flex;flex-wrap:wrap;gap:8px 14px}
.shop-link{color:#2563eb}
@media (max-width: 560px) { body { margin: 0 auto; padding: 12px; } .card { padding: 16px; } .redeem-box form { display: block; } .redeem-box button { width: 100%; margin-top: 8px; } }
</style>
</head>
<body>
  <div class="card">
    <h1>字字珠玑网关登录</h1>
    <p class="sub">首次打开请先登录或注册。绑定成功后可查看余额、模型费率和可用模型。</p>
    <div class="source" id="sourceView">${escapeHtml(sourceLabel)}</div>
    <p id="status" role="status" aria-live="polite">正在读取账号和模型状态…</p>
    <button type="button" class="secondary retry-button" id="retryStatusBtn" hidden>重新检查连接</button>
    ${formHtml}
    <div id="panel" class="panel">
      <div class="billing-banner" id="billingBanner">计费状态：读取中</div>
      <div class="kv">
        <b>模型源</b><span id="sourcePanel">${escapeHtml(sourceLabel)}</span>
        <b>账号</b><span id="usernameView">-</span>
        <b>套餐</b><span id="planView">-</span>
        <b>积分</b><span id="balanceView">-</span>
        <b>用量</b><span id="usageView">-</span>
        <b>计费方式</b><span id="billingModeView">-</span>
        <b>连接</b><span id="connView">-</span>
        <b>模型数</b><span id="modelCountView">-</span>
      </div>
      <button type="button" class="secondary" id="refreshBtn">刷新连接状态</button>
      <button type="button" class="secondary" id="logoutBtn">退出并切换账号</button>
      <div class="redeem-box">
        <form id="redeemForm">
          <label for="redeemCode">兑换码<input id="redeemCode" name="code" autocomplete="off" placeholder="输入兑换码增加积分"></label>
          <button type="submit" class="secondary" id="redeemBtn">兑换积分</button>
        </form>
      </div>
      <div class="model-block">
        <b>后台可用模型（每次调用费率）</b>
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
const retryStatusBtn = document.getElementById("retryStatusBtn");
const logoutBtn = document.getElementById("logoutBtn");
const redeemForm = document.getElementById("redeemForm");
const redeemBtn = document.getElementById("redeemBtn");
const inviteField = document.getElementById("inviteField");
const authHint = document.getElementById("authHint");
let authMode = "login";

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.className = ok === true ? "ok" : ok === false ? "bad" : "";
}

function setRetryVisible(visible) {
  if (retryStatusBtn) retryStatusBtn.hidden = !visible;
}

function publicErrorMessage(error, fallback) {
  const message = String(error?.message || "").trim();
  return message && !/^failed to fetch$/iu.test(message) ? message : fallback;
}

function renderDashboard(data) {
  const loggedIn = data.loggedIn === true;
  const authSurface = document.getElementById("authSurface");
  if (authSurface) authSurface.hidden = loggedIn;
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
    setStatus(data.message || "请先登录或注册账号。", data.errorCode ? false : undefined);
    setRetryVisible(Boolean(data.errorCode));
    return;
  }
  setRetryVisible(false);
  document.getElementById("usernameView").textContent = data.username || data.user?.username || "-";
  document.getElementById("balanceView").textContent = formatBalance(data);
  const planView = document.getElementById("planView");
  if (planView) planView.textContent = data.plan || data.user?.plan || "-";
  const usageView = document.getElementById("usageView");
  if (usageView) {
    const used = data.used ?? data.user?.used;
    const quota = data.quota ?? data.user?.quota;
    const mode = data.billing?.mode || (Number(data.balance ?? data.user?.balance) < 0 ? "unlimited" : "metered");
    usageView.textContent = mode === "unlimited"
      ? (used != null ? ("服务端已用 " + used + "（不限额）") : "服务端统计（不限额）")
      : (used != null && quota != null ? ("已用 " + used + " / 总额 " + quota) : (data.credits?.summary || "-"));
  }
  const billingMode = data.billing?.mode || (Number(data.balance ?? data.user?.balance) < 0 ? "unlimited" : "metered");
  const billingModeView = document.getElementById("billingModeView");
  if (billingModeView) billingModeView.textContent = billingMode === "unlimited" ? "不限额，不扣有限积分" : "按模型扣积分";
  const billingBanner = document.getElementById("billingBanner");
  if (billingBanner) {
    billingBanner.classList.toggle("warn", data.billing?.status === "unavailable" || data.online === false);
    billingBanner.textContent = billingMode === "unlimited"
      ? "计费状态：不限额/托管套餐。调用时仍显示模型费率，但不会从有限积分余额扣除。"
      : "计费状态：按模型费率扣积分。调用前检查余额，调用后核对实际变化。";
  }
  document.getElementById("connView").textContent = data.online === true ? "在线" : data.online === false ? "目录读取失败" : "未知";
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
    cost.textContent = model.credits == null ? "费率未返回" : (model.credits + " 积分/次");
    row.append(name, cost);
    modelListView.append(row);
  }
  setStatus(data.message || "模型已连接。", data.online === false ? false : true);
}

function formatBalance(data) {
  const mode = data.billing?.mode || (Number(data.balance ?? data.user?.balance) < 0 ? "unlimited" : "metered");
  if (mode === "unlimited") return "不限额（不扣有限积分）";
  if (data.credits?.label) return data.credits.label;
  const balance = data.balance ?? data.user?.balance;
  if (balance == null) return "-";
  return String(balance) + " 积分";
}

async function loadStatus() {
  const response = await fetch("/api/status", { cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || ("请求失败（HTTP " + response.status + "）。"));
    error.status = response.status;
    error.data = data;
    throw error;
  }
  renderDashboard(data);
  return data;
}

function setAuthMode(nextMode) {
  authMode = nextMode === "register" ? "register" : "login";
  document.getElementById("loginModeBtn")?.classList.toggle("active", authMode === "login");
  document.getElementById("registerModeBtn")?.classList.toggle("active", authMode === "register");
  if (inviteField) inviteField.hidden = authMode !== "register";
  if (loginBtn) loginBtn.textContent = authMode === "register" ? "注册并绑定写作插件" : "登录并绑定写作插件";
  if (authHint) authHint.textContent = authMode === "register"
    ? "没有账号？注册后会自动登录并绑定插件。"
    : "已有字字珠玑账号？登录后立即绑定插件。";
}

document.getElementById("loginModeBtn")?.addEventListener("click", () => setAuthMode("login"));
document.getElementById("registerModeBtn")?.addEventListener("click", () => setAuthMode("register"));

if (form) form.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginBtn.disabled = true;
  setStatus(authMode === "register" ? "正在注册并绑定插件…" : "正在登录并绑定插件…");
  try {
    const formData = new FormData(form);
    const body = { username: formData.get("username"), password: formData.get("password") };
    if (authMode === "register") body.inviteCode = formData.get("inviteCode") || "";
    const response = await fetch(authMode === "register" ? "/api/register" : "/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const data = await response.json();
    renderDashboard(data);
    if (data.loggedIn) await loadStatus();
  } catch (error) {
    setRetryVisible(true);
    setStatus(publicErrorMessage(error, "暂时无法读取绑定状态，请重新检查连接。"), false);
  } finally {
    loginBtn.disabled = false;
  }
});

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  try { await loadStatus(); } catch (error) { setStatus(publicErrorMessage(error, "刷新失败，请重新检查连接。"), false); } finally { refreshBtn.disabled = false; }
});

retryStatusBtn?.addEventListener("click", async () => {
  retryStatusBtn.disabled = true;
  setStatus("正在重新检查连接…");
  try {
    await loadStatus();
  } catch (error) {
    setRetryVisible(true);
    setStatus(publicErrorMessage(error, "仍无法读取绑定状态，请稍后再试。"), false);
  } finally {
    retryStatusBtn.disabled = false;
  }
});

logoutBtn.addEventListener("click", async () => {
  logoutBtn.disabled = true;
  setStatus("正在退出当前账号…");
  try {
    const response = await fetch("/api/logout", { method: "POST" });
    const data = await response.json();
    renderDashboard(data);
    setAuthMode("login");
    setStatus(data.message || "已退出，请登录或注册其他账号。", undefined);
  } catch {
    setStatus("退出失败，请刷新页面重试。", false);
  } finally {
    logoutBtn.disabled = false;
  }
});

if (redeemForm) redeemForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  redeemBtn.disabled = true;
  setStatus("正在核对兑换码…");
  try {
    const formData = new FormData(redeemForm);
    const response = await fetch("/api/redeem", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: formData.get("code") })
    });
    const data = await response.json();
    renderDashboard(data);
    if (data.loggedIn) await loadStatus();
    if (data.ok) redeemForm.reset();
  } catch {
    setStatus("兑换请求失败，请刷新页面后重试。", false);
  } finally {
    redeemBtn.disabled = false;
  }
});

loadStatus().catch((error) => {
  setRetryVisible(true);
  setStatus(publicErrorMessage(error, "无法读取绑定状态，请重新检查连接。"), false);
});
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

function readJson(req) {
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
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(Object.assign(new Error("请求格式无效。"), { statusCode: 400, code: "INVALID_REQUEST" }));
      }
    });
    req.on("error", reject);
  });
}

async function readLogin(req) {
  const value = await readJson(req);
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || typeof value.username !== "string"
    || typeof value.password !== "string"
    || !value.username.trim()
    || !value.password
  ) {
    throw Object.assign(new Error("账号和密码不能为空。"), { statusCode: 400, code: "INVALID_REQUEST" });
  }
  return {
    username: value.username.trim(),
    password: value.password,
    inviteCode: typeof value.inviteCode === "string" ? value.inviteCode.trim() : ""
  };
}

async function readRedeem(req) {
  const value = await readJson(req);
  const code = value && typeof value.code === "string" ? value.code.trim() : "";
  if (!code) throw Object.assign(new Error("请输入兑换码。"), { statusCode: 400, code: "INVALID_REQUEST" });
  return code;
}

function formatCredits(user = {}, balance, models = []) {
  const plan = String(user.plan || "").toLowerCase();
  const accountType = String(user.accountType || "");
  const billing = accountMode({ user, balance });
  const value = billing.mode === "unlimited" ? -1 : billing.balance;
  const quota = user.quota;
  const used = user.used;
  const callsLeft = user.callsLeft;
  const creditsPerCall = user.creditsPerCall;
  const modelCredits = user.modelCredits && typeof user.modelCredits === "object" ? user.modelCredits : null;
  const priceLines = [];
  if (modelCredits && Object.keys(modelCredits).length) {
    for (const [id, cost] of Object.entries(modelCredits)) priceLines.push(id + "：" + cost + " 积分");
  } else if (Array.isArray(models) && models.length) {
    for (const model of models) {
      if (model && model.id && model.credits != null) priceLines.push(modelDisplayName(model.id, model.id) + "：" + model.credits + " 积分/次");
    }
  }
  const unlimited = billing.mode === "unlimited";

  if (unlimited) {
    const usage = Number.isFinite(Number(used))
      ? `服务端已用 ${used}（不限额）`
      : "额度由服务端套餐统计";
    return {
      label: "不限额（套餐账户）",
      summary: `套餐不限额；${usage}`,
      detail: [
        `套餐：${user.plan || "unlimited"}`,
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
    if (typeof gateway.listModels !== "function") return { models: [], error: Object.assign(new Error("模型目录接口不可用。"), { code: "BILLING_UNAVAILABLE" }) };
    try {
      const catalog = await gateway.listModels();
      const raw = Array.isArray(catalog) ? catalog : catalog?.models;
      if (!Array.isArray(raw)) return { models: [], error: Object.assign(new Error("模型目录格式无效。"), { code: "RESPONSE_INVALID" }) };
      return { models: filterDisabledModels(raw).map(publicModel).filter(Boolean), error: null };
    } catch (error) {
      return { models: [], error };
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
      const modelSnapshot = await modelsSnapshot();
      const models = modelSnapshot.models;
      const writable = models.filter((item) => item.forWriting);
      if (modelSnapshot.error) {
        ok = false;
        lines.push(`模型列表：失败（${modelSnapshot.error?.code || "error"}）`);
      } else if (models.length === 0) {
        ok = false;
        lines.push("模型列表：为空");
      } else {
        const ordered = orderModels(models);
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
    } catch (error) {
      return {
        loggedIn: false,
        online: false,
        authMode: resolvedAuthMode,
        sourceLabel: resolvedSourceLabel,
        errorCode: String(error?.code || "SERVER_ERROR"),
        message: gatewayErrorMessage(error, "账号状态读取失败，请刷新后重试。"),
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
        message: "还没有绑定账号，请登录或注册后再继续。",
        models: [],
        probe: null
      };
    }

    const modelSnapshot = await modelsSnapshot();
    const models = modelSnapshot.models;
    const writable = models.filter((item) => item.forWriting);
    const ordered = orderModels(models);
    const balance = account.balance ?? account.user?.balance ?? null;
    const username = account.user?.username || account.username || null;
    const user = Object.assign({}, account.user || {}, {
      modelCredits: (account.user && account.user.modelCredits) || gateway.modelCredits || null
    });
    const credits = formatCredits(user, balance, ordered);
    const billing = accountMode({ user, balance });
    const catalogOnline = !modelSnapshot.error && ordered.length > 0;
    const catalogMessage = modelSnapshot.error
      ? "账号已登录，但模型目录读取失败：" + gatewayErrorMessage(modelSnapshot.error, "请刷新后重试。")
      : (ordered.length ? `模型已连接。${credits.summary}，可用模型 ${ordered.length} 个。` : "账号已登录，但当前没有可用模型，请刷新或联系网关管理员。");
    const result = {
      loggedIn: true,
      online: catalogOnline,
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
      billing: {
        status: modelSnapshot.error ? "unavailable" : "ready",
        mode: billing.mode,
        balance: billing.balance,
        quota: billing.quota,
        used: billing.used,
        callsLeft: billing.callsLeft
      },
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
      errorCode: modelSnapshot.error ? String(modelSnapshot.error?.code || "BILLING_UNAVAILABLE") : null,
      message: catalogMessage,
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
      if (["/api/login", "/api/register", "/api/redeem", "/api/logout"].includes(requestUrl.pathname) && req.method === "POST") {
        if (req.headers.origin !== origin) {
          return json(res, 403, { loggedIn: false, message: "登录请求来源无效。" });
        }
      }
      if (requestUrl.pathname === "/api/login" && req.method === "POST") {
        const login = await readLogin(req);
        await gateway.login(login);
        const current = await dashboard({ probe: true });
        if (current.loggedIn) {
          try { await require("./onboarding-state").markModelGatewayBinding(true); } catch {}
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
              : (current.message || "登录后仍无法读取账号状态，请刷新页面。")
          }
        );
      }
      if (requestUrl.pathname === "/api/register" && req.method === "POST") {
        if (typeof gateway.register !== "function") {
          const error = new Error("当前网关暂不支持网页注册。");
          error.code = "REGISTRATION_FAILED";
          throw error;
        }
        const registration = await gateway.register(await readLogin(req));
        const current = await dashboard({ probe: true });
        if (current.loggedIn) {
          try {
            const onboarding = require("./onboarding-state");
            await onboarding.markLoginOk();
            await onboarding.markModelGatewayBinding(true);
          } catch {}
          if (typeof onLoginSuccess === "function") {
            try { await onLoginSuccess(current); } catch {}
          }
        }
        return json(res, current.loggedIn ? 200 : 401, {
          ...current,
          registration: { ok: registration?.ok !== false },
          shopUrl: resolvedPaymentPortalUrl,
          message: current.loggedIn
            ? ((current.message || "注册并绑定成功。") + " 之后不会再乱弹登录窗，掉线才会提醒。")
            : (current.message || "注册成功，但账号状态仍未读取到，请刷新页面。")
        });
      }
      if (requestUrl.pathname === "/api/redeem" && req.method === "POST") {
        if (typeof gateway.redeemRechargeCode !== "function") {
          const error = new Error("当前网关暂不支持兑换码。");
          error.code = "BILLING_UNAVAILABLE";
          throw error;
        }
        const current = await dashboard();
        if (!current.loggedIn) {
          const error = new Error("请先登录后再兑换积分。");
          error.code = "AUTH_REQUIRED";
          throw error;
        }
        const redeemed = await gateway.redeemRechargeCode({ code: await readRedeem(req) });
        const refreshed = await dashboard({ probe: true });
        return json(res, 200, {
          ...refreshed,
          ok: redeemed?.ok !== false,
          credited: redeemed?.credited ?? null,
          redeemBalance: redeemed?.balance ?? null,
          message: redeemed?.ok === false
            ? "兑换码未生效，请核对后重试。"
            : ("兑换成功。" + (redeemed?.credited != null ? "增加 " + redeemed.credited + " 积分。" : "余额已刷新。"))
        });
      }
      if (requestUrl.pathname === "/api/logout" && req.method === "POST") {
        if (typeof gateway.logout !== "function") {
          const error = new Error("当前网关暂不支持退出账号。");
          error.code = "GATEWAY_UNAVAILABLE";
          throw error;
        }
        await gateway.logout();
        try {
          const onboarding = require("./onboarding-state");
          await onboarding.markModelGatewayBinding(false);
        } catch {}
        return json(res, 200, {
          ok: true,
          loggedIn: false,
          online: null,
          authMode: resolvedAuthMode,
          sourceLabel: resolvedSourceLabel,
          models: [],
          message: "已退出当前账号，请登录或注册其他账号。"
        });
      }
      return json(res, 404, { message: "未找到接口。" });
    } catch (error) {
      if (res.headersSent || res.writableEnded) return;
      return json(res, errorStatus(error), {
        loggedIn: false,
        ok: false,
        errorCode: String(error?.code || "SERVER_ERROR"),
        message: gatewayErrorMessage(error, "请求失败，请刷新页面后重试。")
      });
    }
  }

  return Object.freeze({
    async start() {
      if (server) return { url: origin };
      server = http.createServer((req, res) => {
        Promise.resolve(handle(req, res)).catch(() => {
          if (res.writableEnded) return;
          try {
            json(res, 500, { loggedIn: false, ok: false, errorCode: "SERVER_ERROR", message: "本地绑定页处理请求失败，请刷新页面重试。" });
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
