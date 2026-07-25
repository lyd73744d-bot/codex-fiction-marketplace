"use strict";

const loginShell = document.getElementById("login-shell");
const workbench = document.getElementById("workbench");
const loginForm = document.getElementById("login-form");
const loginMessage = document.getElementById("login-message");
const serverStatus = document.getElementById("server-status");
const accountStatus = document.getElementById("account-status");
let ruleState = window.ZizhujiHumanizerRuleCenter.createInitialRuleCenterState();
let projects = [];
let currentProjectId = null;
let modelCatalog = [];
let workflowCatalog = [];
let commandState = window.ZizhujiCommandState.createCommandState();
let artifacts = [];
let currentArtifactPath = null;
let savedArtifactContent = "";
let artifactSaveTimer = null;
let artifactSaveQueue = Promise.resolve();
let ledgerState = null;

async function localJson(pathname, options = {}) {
  const response = await fetch(pathname, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) }
  });
  const payload = await response.json();
  if (!response.ok) throw Object.assign(new Error(payload?.error?.message || "请求失败"), { code: payload?.error?.code, status: response.status });
  return payload;
}

function showLogin(message) {
  loginShell.hidden = false;
  workbench.hidden = true;
  loginMessage.textContent = message || "请输入官网账号";
}

function showWorkbench(state) {
  loginShell.hidden = true;
  workbench.hidden = false;
  serverStatus.textContent = `服务器：${state.connection?.online ? "已连接" : "离线"}`;
  accountStatus.textContent = `账号：${state.user?.username || "已登录"}`;
}

function updateProjectStatus(project) {
  currentProjectId = project?.id || null;
  const label = project?.name || "未选择";
  document.getElementById("project-status").textContent = `项目：${label}`;
  document.querySelectorAll("#project-selector, #project-page-selector").forEach((select) => { select.value = currentProjectId || ""; });
}

function populateProjects() {
  document.querySelectorAll("#project-selector, #project-page-selector").forEach((select) => {
    select.innerHTML = `<option value="">尚未打开项目</option>${projects.map((project) => `<option value="${String(project.id).replace(/&/g, "&amp;").replace(/"/g, "&quot;")}">${String(project.name || project.id).replace(/[&<>"']/g, (value) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[value]))}</option>`).join("")}`;
    select.value = currentProjectId || "";
  });
}

async function loadProjects() {
  const result = await localJson("/api/local/projects");
  projects = Array.isArray(result.projects) ? result.projects : [];
  populateProjects();
  if (!currentProjectId && projects[0]) await selectProject(projects[0].id);
}

function clearArtifactWorkspace(message = "打开项目后显示 Markdown、TXT、JSON 和 YAML 文件") {
  artifacts = [];
  currentArtifactPath = null;
  savedArtifactContent = "";
  const list = document.getElementById("project-artifact-list");
  const editor = document.getElementById("artifact-editor");
  list.replaceChildren();
  const empty = document.createElement("p");
  empty.className = "empty-line";
  empty.textContent = message;
  list.append(empty);
  editor.value = "";
  editor.disabled = true;
  document.getElementById("artifact-title").textContent = "尚未选择文件";
  document.getElementById("artifact-save-status").textContent = "就绪";
}

function clearLedger() {
  ledgerState = null;
  document.getElementById("ledger-book-title").textContent = "尚未载入";
  document.getElementById("ledger-current-focus").textContent = "选择项目后读取当前目标、冲突与约束。";
  document.getElementById("ledger-status").textContent = "未载入";
  document.getElementById("continuity-status").textContent = "未载入";
  for (const id of ["continuity-character-count", "continuity-timeline-count", "continuity-hook-count", "continuity-chapter-count"]) document.getElementById(id).textContent = "--";
  const list = document.getElementById("ledger-character-list");
  list.innerHTML = '<p class="empty-line">人物会按剧情重要度自动分级</p>';
}

function renderLedger() {
  if (!ledgerState) { clearLedger(); return; }
  const state = ledgerState.state;
  const characters = Array.isArray(state.characters) ? state.characters : [];
  const hooks = Array.isArray(state.hooks) ? state.hooks : [];
  const summaries = Array.isArray(state.chapterSummaries) ? state.chapterSummaries : [];
  const timelineCount = characters.reduce((count, character) => count + (Array.isArray(character.timeline) ? character.timeline.length : 0), 0);
  document.getElementById("ledger-book-title").textContent = state.book?.title || "未命名项目";
  document.getElementById("ledger-current-focus").textContent = [state.current?.goal, state.current?.conflict].filter(Boolean).join(" · ") || "当前目标和冲突尚未记录";
  document.getElementById("ledger-status").textContent = `第 ${state.book?.currentChapter || 0} 章 · 版本 ${state.revision}`;
  document.getElementById("continuity-status").textContent = "已载入";
  document.getElementById("continuity-character-count").textContent = `${characters.length} 人`;
  document.getElementById("continuity-timeline-count").textContent = `${timelineCount} 条`;
  document.getElementById("continuity-hook-count").textContent = `${hooks.filter((hook) => hook.status !== "resolved").length} 条`;
  document.getElementById("continuity-chapter-count").textContent = `${summaries.length} 章`;
  const tierLabels = { core: "核心", major: "主要", support: "配角", minor: "次要" };
  const list = document.getElementById("ledger-character-list");
  list.replaceChildren();
  if (!characters.length) {
    const empty = document.createElement("p");
    empty.className = "empty-line";
    empty.textContent = "还没有人物记录";
    list.append(empty);
    return;
  }
  for (const character of characters) {
    const item = document.createElement("div");
    item.className = "ledger-character";
    const name = document.createElement("strong");
    name.textContent = character.name;
    const meta = document.createElement("small");
    meta.textContent = `${tierLabels[character.tier] || character.tier} · ${character.role || "角色待定"}`;
    item.append(name, meta);
    list.append(item);
  }
}

async function loadLedger() {
  if (!currentProjectId) { clearLedger(); return; }
  ledgerState = await localJson(`/api/local/projects/${encodeURIComponent(currentProjectId)}/ledger`);
  renderLedger();
}

function renderArtifacts() {
  const list = document.getElementById("project-artifact-list");
  list.replaceChildren();
  if (!artifacts.length) {
    const empty = document.createElement("p");
    empty.className = "empty-line";
    empty.textContent = "这个项目还没有可编辑的文本文件";
    list.append(empty);
    return;
  }
  for (const artifact of artifacts) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `artifact-item${artifact.relativePath === currentArtifactPath ? " is-active" : ""}`;
    const name = document.createElement("span");
    name.textContent = artifact.relativePath;
    const meta = document.createElement("small");
    meta.textContent = `${Math.max(1, Math.ceil(artifact.size / 1024))} KB`;
    button.append(name, meta);
    button.addEventListener("click", () => openArtifact(artifact.relativePath).catch(showArtifactError));
    list.append(button);
  }
}

function showArtifactError(error) {
  document.getElementById("artifact-save-status").textContent = error.message;
}

async function loadArtifacts() {
  if (!currentProjectId) { clearArtifactWorkspace(); return; }
  clearArtifactWorkspace("正在读取项目文件");
  const result = await localJson(`/api/local/projects/${encodeURIComponent(currentProjectId)}/artifacts`);
  artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  renderArtifacts();
}

async function openArtifact(relativePath) {
  if (relativePath === currentArtifactPath) return;
  await saveArtifact();
  const projectId = currentProjectId;
  const result = await localJson(`/api/local/projects/${encodeURIComponent(projectId)}/artifact?path=${encodeURIComponent(relativePath)}`);
  if (projectId !== currentProjectId) return;
  currentArtifactPath = relativePath;
  savedArtifactContent = result.content;
  const editor = document.getElementById("artifact-editor");
  editor.value = result.content;
  editor.disabled = false;
  document.getElementById("artifact-title").textContent = relativePath;
  document.getElementById("artifact-save-status").textContent = "已打开";
  renderArtifacts();
}

function saveArtifact() {
  clearTimeout(artifactSaveTimer);
  artifactSaveTimer = null;
  const projectId = currentProjectId;
  const relativePath = currentArtifactPath;
  const editor = document.getElementById("artifact-editor");
  const content = editor.value;
  if (!projectId || !relativePath || content === savedArtifactContent) return artifactSaveQueue;
  document.getElementById("artifact-save-status").textContent = "保存中";
  artifactSaveQueue = window.ZizhujiCommandState.enqueueRecoverable(artifactSaveQueue, async () => {
    const result = await localJson(`/api/local/projects/${encodeURIComponent(projectId)}/artifact`, {
      method: "PUT",
      body: JSON.stringify({ relativePath, content })
    });
    if (projectId === currentProjectId && relativePath === currentArtifactPath) {
      savedArtifactContent = content;
      if (editor.value === content) {
        document.getElementById("artifact-save-status").textContent = "已自动保存";
        document.getElementById("save-status").textContent = "已保存";
      } else {
        artifactSaveTimer = setTimeout(() => saveArtifact().catch(showArtifactError), 900);
      }
    }
    return result;
  });
  return artifactSaveQueue;
}

async function selectProjectFolder() {
  const result = await localJson("/api/local/projects/select", { method: "POST", body: "{}" });
  if (result.cancelled || !result.project) return;
  const existing = projects.findIndex((project) => project.id === result.project.id);
  if (existing >= 0) projects[existing] = result.project;
  else projects.push(result.project);
  populateProjects();
  await selectProject(result.project.id);
}

function executionKind() {
  return document.querySelector('input[name="execution-kind"]:checked')?.value || "models";
}

function selectedWorkflow() {
  return workflowCatalog.find((workflow) => workflow.id === document.getElementById("workflow-picker").value) || null;
}

function renderExecutionControls() {
  const useModels = executionKind() === "models";
  document.getElementById("model-controls").hidden = !useModels;
  document.getElementById("workflow-controls").hidden = useModels;
}

function renderModelPicker() {
  const root = document.getElementById("model-picker");
  root.replaceChildren();
  if (!modelCatalog.length) {
    const empty = document.createElement("span");
    empty.className = "control-loading";
    empty.textContent = "当前没有可用模型";
    root.append(empty);
    return;
  }
  for (const model of modelCatalog) {
    const label = document.createElement("label");
    label.className = "model-option";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.value = model.id;
    input.checked = commandState.selectedModelIds.includes(model.id);
    const content = document.createElement("span");
    const order = commandState.selectedModelIds.indexOf(model.id);
    if (order >= 0) {
      const badge = document.createElement("b");
      badge.className = "model-order";
      badge.textContent = String(order + 1);
      content.append(badge);
    }
    content.append(document.createTextNode(model.label || model.name || model.id));
    input.addEventListener("change", () => {
      commandState = window.ZizhujiCommandState.toggleModel(commandState, model.id, input.checked);
      renderModelPicker();
    });
    label.append(input, content);
    root.append(label);
  }
}

function renderWorkflowPicker() {
  const picker = document.getElementById("workflow-picker");
  const previous = picker.value;
  picker.replaceChildren();
  for (const workflow of workflowCatalog) {
    const option = document.createElement("option");
    option.value = workflow.id;
    option.textContent = workflow.label || workflow.name || workflow.id;
    picker.append(option);
  }
  if (workflowCatalog.some((workflow) => workflow.id === previous)) picker.value = previous;
  updateWorkflowModes();
}

function updateWorkflowModes() {
  const supported = new Set(selectedWorkflow()?.modes || ["quick", "deep"]);
  document.querySelectorAll('input[name="workflow-mode"]').forEach((input) => {
    input.disabled = !supported.has(input.value);
    input.parentElement.hidden = input.disabled;
  });
  const selected = document.querySelector('input[name="workflow-mode"]:checked');
  if (!selected || selected.disabled) {
    const first = document.querySelector('input[name="workflow-mode"]:not(:disabled)');
    if (first) first.checked = true;
  }
}

async function loadCommandCatalogs() {
  const message = document.getElementById("command-state");
  try {
    const [models, workflows] = await Promise.all([
      localJson("/api/local/models"),
      localJson("/api/local/workflows")
    ]);
    modelCatalog = Array.isArray(models.models) ? models.models : [];
    workflowCatalog = Array.isArray(workflows.workflows) ? workflows.workflows : [];
    if (!commandState.selectedModelIds.length && modelCatalog[0]) {
      commandState = window.ZizhujiCommandState.toggleModel(commandState, modelCatalog[0].id, true);
    }
    renderModelPicker();
    renderWorkflowPicker();
    message.textContent = `${modelCatalog.length} 个模型 · ${workflowCatalog.length} 个写作流程可用`;
  } catch (error) {
    message.textContent = error.message;
    modelCatalog = [];
    workflowCatalog = [];
    renderModelPicker();
    renderWorkflowPicker();
  }
}

function taskStatusLabel(status) {
  return ({ pending: "等待中", running: "执行中", completed: "已完成", failed: "失败", cancelled: "已取消", canceled: "已取消" })[status] || status || "未知";
}

function taskDuration(task) {
  const end = task.finishedAt || Date.now();
  if (!task.startedAt) return "";
  return `${Math.max(0, Math.round((end - task.startedAt) / 1000))} 秒`;
}

function renderTasks() {
  const list = document.getElementById("task-list");
  const detail = document.getElementById("task-result");
  const recent = document.getElementById("recent-activity");
  list.replaceChildren();
  if (!commandState.tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty-line";
    empty.textContent = "还没有执行记录";
    list.append(empty);
    detail.innerHTML = '<p class="empty-line">选择一项任务查看结果</p>';
    return;
  }
  for (const task of commandState.tasks) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `task-item${task.id === commandState.selectedTaskId ? " is-active" : ""}`;
    const title = document.createElement("strong");
    title.textContent = task.title;
    const status = document.createElement("span");
    status.className = `task-status task-status--${task.status}`;
    status.textContent = taskStatusLabel(task.status);
    const meta = document.createElement("small");
    meta.textContent = `${task.kind === "workflow" ? "写作流程" : "模型调用"} · ${taskDuration(task)}`;
    button.append(title, status, meta);
    button.addEventListener("click", () => {
      commandState = window.ZizhujiCommandState.selectTask(commandState, task.id);
      renderTasks();
    });
    list.append(button);
  }
  const task = commandState.tasks.find((item) => item.id === commandState.selectedTaskId) || commandState.tasks[0];
  detail.replaceChildren();
  const heading = document.createElement("h2");
  heading.textContent = task.title;
  const meta = document.createElement("p");
  meta.className = "empty-line";
  meta.textContent = `${taskStatusLabel(task.status)} · ${taskDuration(task)}`;
  const output = document.createElement("pre");
  output.textContent = task.result || task.error || (window.ZizhujiCommandState.isTerminalStatus(task.status) ? "没有返回正文" : "任务正在处理，请稍候");
  detail.append(heading, meta, output);
  recent.textContent = `${task.title}：${taskStatusLabel(task.status)}${taskDuration(task) ? ` · ${taskDuration(task)}` : ""}`;
  document.getElementById("codex-status").textContent = `Codex：${taskStatusLabel(task.status)}`;
}

function outputText(value) {
  if (typeof value === "string") return value;
  if (typeof value?.content === "string") return value.content;
  if (typeof value?.output?.content === "string") return value.output.content;
  return value ? JSON.stringify(value, null, 2) : "";
}

function commandUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (token) => {
    const value = Math.floor(Math.random() * 16);
    return (token === "x" ? value : (value & 3) | 8).toString(16);
  });
}

async function pollRun(runId) {
  try {
    const run = await localJson(`/api/local/runs/${encodeURIComponent(runId)}`);
    const terminal = window.ZizhujiCommandState.isTerminalStatus(run.status);
    commandState = window.ZizhujiCommandState.updateTask(commandState, {
      id: runId,
      status: run.status,
      finishedAt: terminal ? Date.now() : null,
      result: terminal && run.status === "completed" ? outputText(run) : "",
      error: terminal && run.status !== "completed" ? outputText(run.error) || "任务执行失败" : "",
      run
    });
    if (run.settlement?.status === "saved") await loadLedger();
    renderTasks();
    if (!terminal) setTimeout(() => pollRun(runId), 1500);
  } catch (error) {
    commandState = window.ZizhujiCommandState.updateTask(commandState, { id: runId, status: "failed", finishedAt: Date.now(), error: error.message });
    renderTasks();
  }
}

async function runCommand() {
  const input = document.getElementById("command-input");
  const button = document.getElementById("run-command");
  const instruction = input.value.trim();
  if (!instruction) {
    document.getElementById("command-state").textContent = "先写下本次要完成的目标";
    input.focus();
    return;
  }
  button.disabled = true;
  try {
    if (executionKind() === "models") {
      if (!commandState.selectedModelIds.length) throw new Error("至少选择一个模型");
      const id = `local-${commandUuid()}`;
      commandState = window.ZizhujiCommandState.addTask(commandState, { id, kind: "models", title: instruction.slice(0, 36), status: "running", startedAt: Date.now() });
      renderTasks();
      const result = await localJson("/api/local/models/call", {
        method: "POST",
        body: JSON.stringify({ prompt: instruction, modelIds: commandState.selectedModelIds, taskLabel: "workbench" })
      });
      commandState = window.ZizhujiCommandState.updateTask(commandState, { id, status: "completed", finishedAt: Date.now(), result: outputText(result), response: result });
      renderTasks();
    } else {
      const workflow = selectedWorkflow();
      if (!workflow) throw new Error("当前没有可用写作流程");
      const mode = document.querySelector('input[name="workflow-mode"]:checked')?.value;
      if (!mode) throw new Error("请选择快速或深度模式");
      const projectBound = ["facts.observe", "state.settle"].includes(workflow.id);
      if (projectBound && !currentProjectId) throw new Error("先打开一本小说项目");
      const workflowRequest = {
        mode,
        idempotencyKey: commandUuid(),
        input: { instruction, context: [], options: {} },
        ...(projectBound ? { projectId: currentProjectId } : {})
      };
      const run = await localJson(`/api/local/workflows/${encodeURIComponent(workflow.id)}/runs`, {
        method: "POST",
        body: JSON.stringify(workflowRequest)
      });
      commandState = window.ZizhujiCommandState.addTask(commandState, { id: run.runId, kind: "workflow", title: `${workflow.label || workflow.id}：${instruction.slice(0, 28)}`, status: run.status || "pending", startedAt: Date.now(), run });
      renderTasks();
      if (window.ZizhujiCommandState.isTerminalStatus(run.status)) {
        commandState = window.ZizhujiCommandState.updateTask(commandState, { id: run.runId, finishedAt: Date.now(), result: outputText(run) });
        if (run.settlement?.status === "saved") await loadLedger();
        renderTasks();
      } else {
        setTimeout(() => pollRun(run.runId), 800);
      }
    }
    document.getElementById("command-state").textContent = "任务已经提交，可在任务页查看进度";
  } catch (error) {
    document.getElementById("command-state").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function selectProject(projectId) {
  await saveArtifact();
  if (!projectId) {
    updateProjectStatus(null);
    clearArtifactWorkspace();
    clearLedger();
    ruleState = window.ZizhujiHumanizerRuleCenter.reduceRuleCenter(ruleState, { type: "PROJECT_CHANGED", projectId: null });
    renderRules();
    return;
  }
  const result = await localJson(`/api/local/projects/${encodeURIComponent(projectId)}`);
  updateProjectStatus(result.project);
  ruleState = window.ZizhujiHumanizerRuleCenter.reduceRuleCenter(ruleState, { type: "PROJECT_CHANGED", projectId });
  renderRules();
  await Promise.all([loadRules(), loadArtifacts(), loadLedger()]);
}

function renderRules() {
  const root = document.getElementById("rule-center-mount");
  window.ZizhujiHumanizerRuleCenter.renderRuleCenter(root, ruleState, (event) => {
    ruleState = window.ZizhujiHumanizerRuleCenter.reduceRuleCenter(ruleState, event);
    renderRules();
    if (event.type === "LOAD_START") loadRules();
    if (event.type === "SELECT_TAB" && event.tab === "square") loadRules();
    if (event.type === "COLLECT") collectRule(event).catch(showRuleError);
    if (event.type === "ACTIVATE") activateRule(event).catch(showRuleError);
    if (event.type === "UNCOLLECT") uncollectRule(event).catch(showRuleError);
    if (event.type === "SAVE_DRAFT") saveRuleDraft(event).catch(showRuleError);
  });
}

function randomKey(prefix) {
  const uuid = globalThis.crypto?.randomUUID?.();
  return `${prefix}-${uuid || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

function showRuleError(error) {
  ruleState = window.ZizhujiHumanizerRuleCenter.reduceRuleCenter(ruleState, { type: error.status === 401 ? "ACCOUNT_EXPIRED" : "NETWORK_ERROR", message: error.message });
  renderRules();
}

async function collectRule(event) {
  await localJson("/api/local/humanizer/collections", { method: "POST", body: JSON.stringify({ postId: event.postId, revision: event.revision, idempotencyKey: randomKey("collect") }) });
  await loadRules();
}

async function activateRule(event) {
  if (event.scope === "project" && !currentProjectId) throw new Error("先打开一本小说项目");
  const body = { scope: event.scope, enabled: event.enabled, ifMatch: event.ifMatch };
  if (event.scope === "project") body.projectId = currentProjectId;
  await localJson(`/api/local/humanizer/collections/${encodeURIComponent(event.collectionId)}/activation`, { method: "PUT", body: JSON.stringify(body) });
  await loadRules();
}

async function uncollectRule(event) {
  await localJson(`/api/local/humanizer/collections/${encodeURIComponent(event.collectionId)}`, { method: "DELETE", body: JSON.stringify({ ifMatch: event.ifMatch, projectId: currentProjectId }) });
  await loadRules();
}

async function saveRuleDraft(event) {
  await localJson("/api/local/humanizer/drafts", { method: "POST", body: JSON.stringify({ idempotencyKey: randomKey("draft"), draft: event.draft }) });
  document.getElementById("save-status").textContent = "草稿已保存";
}

async function loadRules() {
  ruleState = window.ZizhujiHumanizerRuleCenter.reduceRuleCenter(ruleState, { type: "LOAD_START" });
  renderRules();
  try {
    const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
    const status = await localJson(`/api/local/rule-status${query}`);
    const collections = status.library?.collections || [];
    const accountRefs = new Set((status.effective?.rules || []).map((item) => `${item.ruleId || item.postId}@${item.revision}`));
    const projectRules = status.project?.projectRules || [];
    const projectRefs = new Set(projectRules.filter((item) => item.enabled !== false).map((item) => `${item.ruleId}@${item.revision}`));
    const mine = collections.map((item) => ({ ...item, ruleId: item.ruleId || item.postId, collected: true, enabled: accountRefs.has(`${item.postId}@${item.revision}`), globalEnabled: accountRefs.has(`${item.postId}@${item.revision}`), projectEnabled: projectRefs.has(`${item.postId}@${item.revision}`) }));
    const project = projectRules.filter((item) => item.enabled !== false).map((item) => ({ ...item, ruleId: item.ruleId, collected: true, enabled: true, projectEnabled: true, ...(collections.find((collection) => collection.postId === item.ruleId && collection.revision === item.revision) || {}) }));
    let square = [];
    if (ruleState.activeTab === "square") square = (await localJson("/api/local/humanizer/square?limit=20")).items || [];
    square = square.map((item) => ({ ...item, ruleId: item.postId, collected: collections.some((collection) => collection.postId === item.postId && collection.revision === item.revision) }));
    ruleState = window.ZizhujiHumanizerRuleCenter.reduceRuleCenter(ruleState, { type: "LOAD_SUCCESS", payload: { builtin: [], mine, project, square } });
  } catch (error) {
    ruleState = window.ZizhujiHumanizerRuleCenter.reduceRuleCenter(ruleState, { type: error.status === 401 ? "ACCOUNT_EXPIRED" : "NETWORK_ERROR", message: error.message });
  }
  renderRules();
}

async function boot() {
  try {
    const state = await localJson("/api/local/state");
    if (!state.loggedIn) {
      showLogin(state.connection?.online ? "服务器已连接，请登录" : "服务器暂时无法连接");
      return;
    }
    showWorkbench(state);
    renderRules();
    await Promise.all([loadProjects(), loadCommandCatalogs()]);
  } catch { showLogin("本地工作台启动失败"); }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = new FormData(loginForm);
  loginMessage.textContent = "正在登录";
  try {
    await localJson("/api/local/login", { method: "POST", body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    await boot();
  } catch (error) { loginMessage.textContent = error.message; }
});

document.getElementById("register-button").addEventListener("click", async () => {
  const form = new FormData(loginForm);
  const username = String(form.get("register-username") || "").trim();
  const password = String(form.get("register-password") || "");
  if (username.length < 3 || password.length < 6) {
    loginMessage.textContent = "账号至少 3 位，密码至少 6 位";
    return;
  }
  loginMessage.textContent = "正在注册";
  try {
    await localJson("/api/local/register", { method: "POST", body: JSON.stringify({ username, password, inviteCode: String(form.get("invite-code") || "").trim() || undefined }) });
    await boot();
  } catch (error) { loginMessage.textContent = error.message; }
});

document.getElementById("logout-button").addEventListener("click", async () => {
  try { await localJson("/api/local/logout", { method: "POST", body: "{}" }); } catch {}
  showLogin("已退出登录");
});

document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-page]").forEach((item) => item.classList.toggle("is-active", item === button));
  document.querySelectorAll("[data-page-panel]").forEach((panel) => panel.classList.toggle("is-active", panel.dataset.pagePanel === button.dataset.page));
  if (button.dataset.page === "review") loadRules();
}));

document.querySelectorAll("#project-selector, #project-page-selector").forEach((select) => select.addEventListener("change", () => {
  selectProject(select.value).catch((error) => { updateProjectStatus(null); showRuleError(error); });
}));

document.querySelectorAll('input[name="execution-kind"]').forEach((input) => input.addEventListener("change", renderExecutionControls));
document.getElementById("workflow-picker").addEventListener("change", updateWorkflowModes);
document.getElementById("run-command").addEventListener("click", runCommand);
document.getElementById("open-project-folder").addEventListener("click", () => selectProjectFolder().catch(showArtifactError));
document.getElementById("save-artifact").addEventListener("click", () => saveArtifact().catch(showArtifactError));
document.getElementById("artifact-editor").addEventListener("input", () => {
  if (!currentArtifactPath) return;
  document.getElementById("artifact-save-status").textContent = "等待自动保存";
  clearTimeout(artifactSaveTimer);
  artifactSaveTimer = setTimeout(() => saveArtifact().catch(showArtifactError), 900);
});
renderExecutionControls();
renderTasks();
clearArtifactWorkspace();
clearLedger();

boot();
