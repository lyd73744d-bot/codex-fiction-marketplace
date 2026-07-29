"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const { handle, createRuntime } = require("../server/mcp-server");
  const pkg = require("../package.json");
  const onboarding = require("../server/onboarding-state");

  const onboardingDir = fs.mkdtempSync(path.join(os.tmpdir(), "zizhuji-onboarding-"));
  const onboardingPath = path.join(onboardingDir, "state.json");
  try {
    const fresh = await onboarding.markPackageInstalled(onboardingPath);
    assert.strictEqual(fresh.pendingFirstLogin, false, "install must not require gateway login");
    const normalDecision = onboarding.decidePopup(fresh, { loggedIn: false });
    assert.strictEqual(normalDecision.open, false, "fresh install must not open login");
    assert.strictEqual(normalDecision.reason, "gateway_optional");
    const firstModelDecision = onboarding.decidePopup(fresh, {
      loggedIn: false,
      allowPopup: true,
      explicitUserChoice: true
    });
    assert.strictEqual(firstModelDecision.open, true, "first approved model call must open login");
    assert.strictEqual(firstModelDecision.reason, "first_model_use");
    const manualDecision = onboarding.decidePopup(fresh, { loggedIn: false, force: true });
    assert.strictEqual(manualDecision.open, true, "explicit gateway request must still open login");
    assert.strictEqual(manualDecision.reason, "forced");
    const bound = await onboarding.markModelGatewayBinding(true, onboardingPath);
    assert.strictEqual(bound.modelGatewayBound, true, "model gateway binding must persist");
    assert.ok(bound.modelGatewayBoundAt, "model gateway binding timestamp missing");
    assert.strictEqual((await onboarding.readState(onboardingPath)).modelGatewayBound, true);
    const unbound = await onboarding.markModelGatewayBinding(false, onboardingPath);
    assert.strictEqual(unbound.modelGatewayBound, false, "model gateway unbind must persist");
  } finally {
    fs.rmSync(onboardingDir, { recursive: true, force: true });
  }

  const popupDir = fs.mkdtempSync(path.join(os.tmpdir(), "zizhuji-popup-"));
  const popupStatePath = path.join(popupDir, "state.json");
  const previousStatePath = process.env.FICTION_DIRECTOR_ONBOARDING_STATE;
  process.env.FICTION_DIRECTOR_ONBOARDING_STATE = popupStatePath;
  try {
    const { createGatewayGuard } = require("../server/gateway-guard");
    let loggedIn = false;
    let popupOpenCount = 0;
    const guard = createGatewayGuard({
      gateway: {
        async accountStatus() {
          return loggedIn
            ? { loggedIn: true, active: true, user: { username: "popup-test", active: true } }
            : { loggedIn: false, active: true };
        }
      },
      openLoginPage: async () => {
        popupOpenCount += 1;
        return { url: "http://127.0.0.1:43210/" };
      }
    });

    const initialized = await guard.ensureAccess({
      reason: "initialize",
      allowPopup: false,
      explicitUserChoice: false,
      openBrowser: false
    });
    assert.strictEqual(initialized.popupOpened, false, "initialize must stay silent");
    assert.strictEqual(popupOpenCount, 0, "initialize opened a login page");

    const status = await guard.accountSnapshot();
    assert.strictEqual(status.loggedIn, false);
    assert.strictEqual(popupOpenCount, 0, "status check opened a login page");

    const firstApprovedCall = await guard.ensureAccess({
      reason: "generate_to_file",
      allowPopup: true,
      explicitUserChoice: true,
      openBrowser: false
    });
    assert.strictEqual(firstApprovedCall.reason, "first_model_use");
    assert.strictEqual(firstApprovedCall.popupOpened, true);
    assert.strictEqual(popupOpenCount, 1, "first approved call must open exactly once");

    const repeatedCall = await guard.ensureAccess({
      reason: "generate_to_file",
      allowPopup: true,
      explicitUserChoice: true,
      openBrowser: false
    });
    assert.strictEqual(repeatedCall.reason, "first_model_use_cooldown");
    assert.strictEqual(repeatedCall.popupOpened, false);
    assert.strictEqual(popupOpenCount, 1, "cooldown call reopened the login page");

    loggedIn = true;
    const afterLogin = await guard.ensureAccess({
      reason: "generate_to_file",
      allowPopup: true,
      explicitUserChoice: true,
      openBrowser: false
    });
    assert.strictEqual(afterLogin.loggedIn, true);
    assert.strictEqual(popupOpenCount, 1, "logged-in call reopened the login page");

    loggedIn = false;
    const droppedInitialize = await guard.ensureAccess({
      reason: "initialize",
      allowPopup: false,
      explicitUserChoice: false,
      openBrowser: false
    });
    assert.strictEqual(droppedInitialize.reason, "session_dropped_silent");
    assert.strictEqual(droppedInitialize.popupOpened, false);
    assert.strictEqual(popupOpenCount, 1, "session drop during initialize opened a page");
    await guard.accountSnapshot();
    assert.strictEqual(popupOpenCount, 1, "session-drop status check opened a page");
  } finally {
    if (previousStatePath == null) delete process.env.FICTION_DIRECTOR_ONBOARDING_STATE;
    else process.env.FICTION_DIRECTOR_ONBOARDING_STATE = previousStatePath;
    fs.rmSync(popupDir, { recursive: true, force: true });
  }

  const fakeGateway = {
    baseUrl: "https://example.test",
    async login() { return { ok: true, loggedIn: true }; },
    async accountStatus() { return { ok: true, loggedIn: true, active: true, balance: 42, user: { username: "tester", balance: 42 } }; },
    async connectionStatus() { return { ok: true, online: true }; },
    async listModels() { return { ok: true, models: [{ id: "claude-opus-5", credits: 20 }, { id: "claude-sonnet-5", credits: 10 }] }; },
    async callModels(input) {
      const model = input.modelIds[0];
      const content = "测试候选正文。" + "他推开门，屋里的灯还亮着，桌上的茶已经凉了。".repeat(30);
      return { ok: true, modelIds: [model], outputs: [{ model, content, usage: null, transport: "stream_attempt_1" }], content };
    }
  };
  let gatewayGuardCalls = 0;
  const gatewayGuardArguments = [];
  const fakeGuard = {
    async ensureAccess(input = {}) {
      gatewayGuardCalls += 1;
      gatewayGuardArguments.push({ ...input });
      return { ok: true, loggedIn: true, popupOpened: false, reason: "already_logged_in", message: "ok" };
    },
    async accountSnapshot() { return { loggedIn: true, online: true, raw: { user: { username: "tester" }, balance: 42 } }; }
  };
  const runtime = createRuntime({
    gateway: fakeGateway,
    gatewayGuard: fakeGuard,
    openLoginPage: async () => ({ url: "http://127.0.0.1:0/", message: "test" })
  });

  // notifications must be ignored, not answered with "Method not found"
  assert.strictEqual(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, runtime), null);

  // initialize reports the package.json version (single source of truth)
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, runtime);
  assert.strictEqual(init.result.serverInfo.version, pkg.version);
  assert.strictEqual(gatewayGuardArguments[0].reason, "initialize");
  assert.strictEqual(gatewayGuardArguments[0].allowPopup, false, "initialize must disable popup permission");

  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, runtime);
  const names = list.result.tools.map((t) => t.name);
  const definitions = new Map(list.result.tools.map((tool) => [tool.name, tool]));
  const expected = [
    "fiction_ensure_gateway", "fiction_open_gateway_login", "fiction_account_status",
    "fiction_list_models", "fiction_recommend_models", "fiction_list_model_tasks",
    "fiction_generate_to_file", "fiction_write_artifact", "fiction_write_local_candidate",
    "fiction_read_artifact", "fiction_list_artifacts",
    "fiction_optimize_with_models", "fiction_compare_style", "fiction_smoke_live_gateway"
  ];
  assert.strictEqual(names.length, expected.length, "tool count " + names.length);
  for (const name of expected) assert.ok(names.includes(name), "missing tool " + name);
  assert.deepStrictEqual(definitions.get("fiction_generate_to_file").inputSchema.required, ["projectDir", "prompt", "modelIds", "authorConfirmed"]);
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.modelIds.type, "array");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.fallbackChain.type, "boolean");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.authorConfirmed.type, "boolean");
  assert.ok(!definitions.get("fiction_optimize_with_models").inputSchema.properties.modelId, "optimize must not expose singular modelId");
  assert.strictEqual(definitions.get("fiction_optimize_with_models").inputSchema.properties.modelIds.type, "array");
  assert.ok(definitions.get("fiction_optimize_with_models").inputSchema.required.includes("authorConfirmed"));
  assert.deepStrictEqual(definitions.get("fiction_smoke_live_gateway").inputSchema.required, ["authorConfirmed"]);
  assert.strictEqual(definitions.get("fiction_ensure_gateway").inputSchema.properties.bindModels.type, "boolean");
  assert.strictEqual(definitions.get("fiction_ensure_gateway").inputSchema.properties.unbindModels.type, "boolean");

  async function callTool(name, args) {
    const reply = await handle({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name, arguments: args } }, runtime);
    if (reply.error) { const err = new Error(name + ": " + reply.error.message); err.data = reply.error.data; throw err; }
    return JSON.parse(reply.result.content[0].text);
  }

  assert.strictEqual((await callTool("fiction_account_status", {})).loggedIn, true);
  assert.strictEqual((await callTool("fiction_ensure_gateway", {})).loggedIn, true);
  assert.strictEqual((await callTool("fiction_list_models", {})).models.length, 2);
  const guardCallsBeforeRecommendation = gatewayGuardCalls;
  const recommendation = await callTool("fiction_recommend_models", { task: "draft", mode: "quick" });
  assert.strictEqual(gatewayGuardCalls, guardCallsBeforeRecommendation, "recommendation must not trigger login guard");
  assert.ok(Array.isArray(recommendation.modelIds) && recommendation.modelIds.length > 0, "recommendation modelIds missing");
  assert.deepStrictEqual(recommendation.fallbackChain, recommendation.modelIds, "recommendation chain must match modelIds");
  assert.ok(!JSON.stringify(recommendation).includes('"credits"'), "recommendation must not expose model credits");
  assert.ok(!String(recommendation.coachAdvice || "").includes("积分"), "recommendation advice must not mention credits");
  assert.ok(String(recommendation.coachAdvice || "").includes("等待作者当次确认"), "recommendation must require per-call confirmation");
  const brainstormRecommendation = await callTool("fiction_recommend_models", { task: "brainstorm", mode: "quick" });
  assert.strictEqual(gatewayGuardCalls, guardCallsBeforeRecommendation, "brainstorm recommendation must not trigger login guard");
  assert.strictEqual(brainstormRecommendation.task, "brainstorm");
  assert.ok(brainstormRecommendation.modelIds.length > 0, "brainstorm recommendation missing external model");
  assert.ok((await callTool("fiction_list_model_tasks", {})).tasks);

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "zizhuji-selftest-"));
  try {
    const denied = await handle({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "fiction_generate_to_file", arguments: { projectDir, prompt: "unconfirmed", modelIds: ["claude-opus-5"] } } }, runtime);
    assert.strictEqual(denied.error?.data?.code, "AUTHOR_CONFIRMATION_REQUIRED", "unconfirmed model call must be blocked");

    const deniedOptimize = await handle({ jsonrpc: "2.0", id: 81, method: "tools/call", params: { name: "fiction_optimize_with_models", arguments: { projectDir, draftText: "unconfirmed" } } }, runtime);
    assert.strictEqual(deniedOptimize.error?.data?.code, "AUTHOR_CONFIRMATION_REQUIRED", "unconfirmed optimize call must be blocked");

    const deniedSmoke = await handle({ jsonrpc: "2.0", id: 82, method: "tools/call", params: { name: "fiction_smoke_live_gateway", arguments: {} } }, runtime);
    assert.strictEqual(deniedSmoke.error?.data?.code, "AUTHOR_CONFIRMATION_REQUIRED", "unconfirmed live smoke must be blocked");

    const gen = await callTool("fiction_generate_to_file", { projectDir, prompt: "写一段测试", modelIds: ["claude-opus-5"], authorConfirmed: true, applyHardGates: false });
    assert.strictEqual(gen.ok, true);
    const generateGuardCall = gatewayGuardArguments.find((item) => item.reason === "generate_to_file");
    assert.strictEqual(generateGuardCall?.allowPopup, true, "approved generation must allow first-use login");
    assert.strictEqual(generateGuardCall?.explicitUserChoice, true, "approved generation must record explicit choice");
    assert.ok(fs.existsSync(gen.artifact.path), "artifact txt missing");
    assert.ok(fs.existsSync(gen.artifact.plainPath), "artifact .body.txt missing");
    assert.strictEqual(gen.artifact.recordedForMemory, true, "external model output must be recorded for memory");
    assert.ok(fs.existsSync(gen.artifact.memoryRecord.path), "model writing record missing");
    const firstModelRecord = fs.readFileSync(gen.artifact.memoryRecord.path, "utf8");
    assert.ok(firstModelRecord.includes("claude-opus-5"), "model id missing from writing record");
    assert.ok(firstModelRecord.includes(gen.artifact.plainRelativePath.replace(/\\/g, "/")), "plain candidate path missing from writing record");
    assert.ok(firstModelRecord.includes("不得作为正文事实"), "candidate/canon boundary missing from writing record");

    const read = await callTool("fiction_read_artifact", { path: gen.artifact.path });
    assert.ok(read.content.includes("测试候选正文"), "read content mismatch");

    const local = await callTool("fiction_write_local_candidate", { projectDir, content: "本地候选正文。", title: "本地" });
    assert.strictEqual(local.ok, true);
    assert.strictEqual(local.artifact.recordedForMemory, false, "local candidate must not impersonate external-model history");
    assert.strictEqual(fs.readFileSync(gen.artifact.memoryRecord.path, "utf8"), firstModelRecord, "local candidate changed external-model history");

    const importedExternal = await callTool("fiction_write_artifact", {
      projectDir,
      content: "从作者已有模型取得的候选内容。",
      kind: "brainstorm",
      title: "外部脑洞",
      modelId: "author-external-model"
    });
    assert.strictEqual(importedExternal.recordedForMemory, true, "imported external model output was not recorded");
    const updatedModelRecord = fs.readFileSync(importedExternal.memoryRecord.path, "utf8");
    assert.ok(updatedModelRecord.includes("author-external-model"), "imported external model id missing from record");
    assert.ok(updatedModelRecord.length > firstModelRecord.length, "model writing record was not appended");

    const auxiliaryDir = path.join(projectDir, "辅助文档");
    fs.mkdirSync(auxiliaryDir, { recursive: true });
    fs.writeFileSync(path.join(auxiliaryDir, "06_风格与写作要求.md"), "# 文风要求\n短句克制，人物声音清楚。\n", "utf8");
    fs.writeFileSync(path.join(auxiliaryDir, "08_事实库_防OOC.md"), "# 事实库\n当前为纯虚构测试。\n", "utf8");
    const sampleDir = path.join(projectDir, "样书", "测试样书");
    fs.mkdirSync(sampleDir, { recursive: true });
    fs.writeFileSync(path.join(sampleDir, "00_手法学习笔记.md"), "# 手法学习笔记\n冲突尽早落地，对话承担信息差。\n", "utf8");
    const style = await callTool("fiction_compare_style", { projectDir, draftText: "他说完推开门。屋里的灯还亮着。", title: "路径检查" });
    assert.ok(!style.missing.includes("缺少 辅助文档/06_风格与写作要求.md"), "canonical style file was not read");
    assert.ok(!style.missing.includes("缺少样书手法笔记"), "sample-book notes were not read");

    const listed = await callTool("fiction_list_artifacts", { projectDir });
    assert.ok(listed.items.length >= 2, "artifact list too short");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  const bad = await handle({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "fiction_nope" } }, runtime);
  assert.ok(bad.error, "unknown tool must error");

  const pluginRoot = path.resolve(__dirname, "..");
  const markdown = [];
  for (const top of ["skills", "assets"]) {
    const base = path.join(pluginRoot, top);
    for (const relative of fs.readdirSync(base, { recursive: true })) {
      if (relative.endsWith(".md")) markdown.push(fs.readFileSync(path.join(base, relative), "utf8"));
    }
  }
  const allDocs = markdown.join("\n");
  assert.ok(!/fiction_run\b/.test(allDocs), "removed fiction_run is still documented");
  assert.ok(!/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(allDocs), "control character found in markdown");
  assert.ok(!/`modelId`/.test(allDocs), "singular modelId remains in user/skill documentation");
  for (const forbidden of ["首次安装强制", "首次安装必弹", "安装时必须弹", "先检查登录"]) {
    assert.ok(!allDocs.includes(forbidden), "forced-login wording remains: " + forbidden);
  }
  assert.ok(allDocs.includes("是否使用这个模型"), "every external model call must ask for confirmation");
  assert.ok(allDocs.includes("每次调用"), "per-call confirmation rule missing");

  const { createGatewayLoginConsole } = require("../server/gateway-login-console");
  const loginConsole = createGatewayLoginConsole({ gateway: fakeGateway, keepAlive: true });
  const localPage = await loginConsole.start();
  try {
    const html = await (await fetch(localPage.url)).text();
    assert.ok(html.includes("刷新连接状态"), "simple connection refresh missing");
    for (const removedUi of ["modelFilter", "showAllModels", "probeBtn", "完整模型列表"]) {
      assert.ok(!html.includes(removedUi), "obsolete user UI remains: " + removedUi);
    }
  } finally {
    await loginConsole.stop();
  }

  console.log("PASS selftest-gateway-core: " + expected.length + " tools OK, version " + pkg.version);
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  if (error && error.data) console.error(JSON.stringify(error.data));
  process.exit(1);
});
