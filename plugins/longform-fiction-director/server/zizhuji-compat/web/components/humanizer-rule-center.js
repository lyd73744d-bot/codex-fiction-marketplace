"use strict";

const RULE_CENTER_TABS = Object.freeze(["builtin", "mine", "project", "square"]);
const TAB_LABELS = Object.freeze({ builtin: "内置库", mine: "我的库", project: "项目库", square: "广场" });

function cloneList(value) {
  return Array.isArray(value) ? value.map((item) => ({ ...item })) : [];
}

function createInitialRuleCenterState(options = {}) {
  return {
    phase: "idle",
    activeTab: "builtin",
    projectId: typeof options.projectId === "string" ? options.projectId : null,
    builtin: [],
    mine: [],
    project: [],
    square: [],
    selectedRuleId: null,
    error: null,
    effectiveCount: 0
  };
}

function effectiveCount(project) {
  return cloneList(project).filter((item) => item.enabled === true).length;
}

function reduceRuleCenter(state, event) {
  const current = state || createInitialRuleCenterState();
  if (!event || typeof event.type !== "string") return current;
  switch (event.type) {
    case "LOAD_START":
      return { ...current, phase: "loading", error: null };
    case "LOAD_SUCCESS": {
      const payload = event.payload || {};
      const project = cloneList(payload.project);
      return {
        ...current,
        phase: "ready",
        error: null,
        builtin: cloneList(payload.builtin),
        mine: cloneList(payload.mine),
        project,
        square: cloneList(payload.square),
        effectiveCount: effectiveCount(project)
      };
    }
    case "SELECT_TAB":
      return RULE_CENTER_TABS.includes(event.tab) ? { ...current, activeTab: event.tab } : current;
    case "COLLECT_SUCCESS": {
      const item = event.item && typeof event.item === "object" ? { ...event.item, collected: true, enabled: false, globalEnabled: false, projectEnabled: false } : null;
      if (!item) return current;
      const mine = [...current.mine.filter((entry) => entry.ruleId !== item.ruleId), item];
      return { ...current, mine };
    }
    case "ACTIVATE_SUCCESS": {
      const ruleId = event.ruleId;
      const scope = event.scope || "project";
      const mine = current.mine.map((item) => {
        if (item.ruleId !== ruleId) return item;
        return scope === "account"
          ? { ...item, globalEnabled: event.enabled === true, enabled: event.enabled === true }
          : { ...item, projectEnabled: event.enabled === true };
      });
      const project = scope === "project"
        ? (event.enabled === true
          ? [...current.project.filter((item) => item.ruleId !== ruleId), ...mine.filter((item) => item.ruleId === ruleId).map((item) => ({ ...item, enabled: true }))]
          : current.project.filter((item) => item.ruleId !== ruleId))
        : current.project;
      return { ...current, project, mine, effectiveCount: effectiveCount(project) };
    }
    case "PROJECT_CHANGED":
      return { ...current, phase: "loading", projectId: typeof event.projectId === "string" ? event.projectId : null, project: [], effectiveCount: 0, selectedRuleId: null, error: null };
    case "NETWORK_ERROR":
      return { ...current, phase: "network-error", error: event.message || "网络暂时不可用" };
    case "ACCOUNT_EXPIRED":
      return { ...current, phase: "account-expired", error: "登录已过期" };
    default:
      return current;
  }
}

function statusLabel(item, tab) {
  if (tab === "project" && item.enabled === true) return "当前项目启用";
  if (item.projectEnabled === true) return "当前项目启用";
  if (item.globalEnabled === true) return "所有项目启用";
  if (item.collected === true && item.enabled !== true) return "已收藏，未启用";
  if (item.status === "pending") return "待审核";
  if (item.status === "withdrawn" || item.status === "security_revoked") return "已撤回";
  if (item.newRevision === true) return "有新版本";
  if (item.learningOnly === true) return "学习条目";
  return "可学习";
}

function ruleView(item, tab) {
  const collected = item.collected === true;
  const executable = item.learningOnly !== true && !!item.detector;
  return {
    ...item,
    statusLabel: statusLabel(item, tab),
    actions: {
      collect: tab === "square" && !collected && item.status !== "pending" && item.status !== "withdrawn",
      activateProject: tab === "mine" && collected && executable && item.projectEnabled !== true,
      deactivateProject: (tab === "project" || tab === "mine") && item.projectEnabled === true,
      activateAccount: tab === "mine" && collected && executable && item.globalEnabled !== true,
      deactivateAccount: tab === "mine" && collected && item.globalEnabled === true,
      uncollect: tab === "mine" && collected
    }
  };
}

function ruleCenterViewModel(state) {
  const current = state || createInitialRuleCenterState();
  const items = cloneList(current[current.activeTab]).map((item) => ruleView(item, current.activeTab));
  return {
    status: current.phase,
    activeTab: current.activeTab,
    projectId: current.projectId,
    tabs: RULE_CENTER_TABS.map((id) => ({ id, label: TAB_LABELS[id] })),
    items,
    builtin: cloneList(current.builtin).map((item) => ruleView(item, "builtin")),
    mine: cloneList(current.mine).map((item) => ruleView(item, "mine")),
    project: cloneList(current.project).map((item) => ruleView(item, "project")),
    square: cloneList(current.square).map((item) => ruleView(item, "square")),
    effectiveCount: current.effectiveCount,
    empty: current.phase === "ready" && items.length === 0,
    error: current.error
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[character]));
}

function ruleButtons(item) {
  const buttons = [];
  if (item.actions.collect) buttons.push(`<button type="button" data-rule-action="collect" data-post-id="${escapeHtml(item.postId || item.ruleId)}" data-revision="${escapeHtml(item.revision || 1)}">收藏</button>`);
  if (item.actions.activateProject) buttons.push(`<button type="button" data-rule-action="activate-project" data-collection-id="${escapeHtml(item.collectionId || "")}" data-if-match="${escapeHtml(item.etag || "")}">本项目启用</button>`);
  if (item.actions.deactivateProject) buttons.push(`<button type="button" data-rule-action="activate-project" data-enabled="false" data-collection-id="${escapeHtml(item.collectionId || "")}" data-if-match="${escapeHtml(item.etag || "")}">关闭本项目</button>`);
  if (item.actions.activateAccount) buttons.push(`<button type="button" data-rule-action="activate-account" data-collection-id="${escapeHtml(item.collectionId || "")}" data-if-match="${escapeHtml(item.etag || "")}">所有项目启用</button>`);
  if (item.actions.deactivateAccount) buttons.push(`<button type="button" data-rule-action="activate-account" data-enabled="false" data-collection-id="${escapeHtml(item.collectionId || "")}" data-if-match="${escapeHtml(item.etag || "")}">关闭所有项目</button>`);
  if (item.actions.uncollect) buttons.push(`<button type="button" data-rule-action="uncollect" data-collection-id="${escapeHtml(item.collectionId || "")}" data-if-match="${escapeHtml(item.etag || "")}">取消收藏</button>`);
  return buttons.length ? `<div class="rule-item__actions">${buttons.join("")}</div>` : "";
}

function draftForm() {
  return `<details class="rule-draft"><summary>保存一条私有规则草稿</summary><form data-rule-draft-form>
    <label>名称<input name="title" maxlength="60" required></label>
    <label>要识别的表达<textarea name="pattern" maxlength="240" rows="2" required></textarea></label>
    <label>问题说明<textarea name="reason" maxlength="400" rows="2" required></textarea></label>
    <label>修改方向<textarea name="rewriteGuidance" maxlength="400" rows="2" required></textarea></label>
    <label>适用范围<select name="scope"><option value="all">全部</option><option value="dialogue">对话</option><option value="narration">叙述</option><option value="chapter">章节</option></select></label>
    <label>例外<textarea name="exception" maxlength="300" rows="2"></textarea></label>
    <button type="submit">保存草稿</button><span class="rule-draft__hint">草稿不会公开，也不会自动启用</span>
  </form></details>`;
}

function renderRuleCenter(root, state, onAction = () => {}) {
  if (!root) throw new TypeError("rule center root is required");
  const view = ruleCenterViewModel(state);
  const notice = view.status === "account-expired" ? "登录已过期" : view.status === "network-error" ? "网络错误：" + view.error : view.status === "loading" ? "正在读取规则库" : "";
  root.innerHTML = `<section class="rule-center" aria-labelledby="rule-center-title">
    <header class="rule-center__header"><div><p class="eyebrow">审稿 / 去 AI 味</p><h1 id="rule-center-title">规则中心</h1><p class="rule-center__meta">当前项目：${escapeHtml(view.projectId || "未选择")} · 当前生效 ${view.effectiveCount} 条</p></div><button type="button" data-action="refresh" title="刷新规则库" aria-label="刷新规则库">↻</button></header>
    <nav class="rule-center__tabs" aria-label="规则范围">${view.tabs.map((tab) => `<button type="button" data-tab="${tab.id}" aria-selected="${tab.id === view.activeTab}">${tab.label}</button>`).join("")}</nav>
    <div class="rule-center__notice" aria-live="polite">${escapeHtml(notice)}</div>
    ${view.activeTab === "mine" ? draftForm() : ""}
    <div class="rule-center__list">${view.items.map((item) => `<article class="rule-item"><div class="rule-item__main"><h2>${escapeHtml(item.title || item.ruleId || "未命名规则")}</h2><p>${escapeHtml(item.pattern || item.categoryId || "本地证据规则")}</p></div><div class="rule-item__side"><span class="rule-item__status">${escapeHtml(item.statusLabel)}</span>${ruleButtons(item)}</div></article>`).join("")}</div>
    ${view.empty ? `<div class="rule-center__empty" role="status">没有可显示的规则</div>` : ""}
  </section>`;
  root.querySelectorAll("[data-tab]").forEach((button) => button.addEventListener("click", () => onAction({ type: "SELECT_TAB", tab: button.dataset.tab })));
  root.querySelector("[data-action=refresh]")?.addEventListener("click", () => onAction({ type: "LOAD_START" }));
  root.querySelectorAll("[data-rule-action]").forEach((button) => button.addEventListener("click", () => {
    const action = button.dataset.ruleAction;
    if (action === "collect") return onAction({ type: "COLLECT", postId: button.dataset.postId, revision: Number(button.dataset.revision) });
    if (action === "uncollect") return onAction({ type: "UNCOLLECT", collectionId: button.dataset.collectionId, ifMatch: button.dataset.ifMatch });
    return onAction({
      type: "ACTIVATE",
      scope: action === "activate-account" ? "account" : "project",
      collectionId: button.dataset.collectionId,
      ifMatch: button.dataset.ifMatch,
      enabled: button.dataset.enabled !== "false"
    });
  }));
  root.querySelector("[data-rule-draft-form]")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onAction({ type: "SAVE_DRAFT", draft: Object.fromEntries(form.entries()) });
  });
  return view;
}

const api = { RULE_CENTER_TABS, createInitialRuleCenterState, reduceRuleCenter, renderRuleCenter, ruleCenterViewModel };
if (typeof window !== "undefined") window.ZizhujiHumanizerRuleCenter = api;
if (typeof module !== "undefined" && module.exports) module.exports = api;
