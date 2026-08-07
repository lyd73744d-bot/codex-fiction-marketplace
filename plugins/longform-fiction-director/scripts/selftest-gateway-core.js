"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

async function main() {
  const { handle, createRuntime, resolveGateway, safeMcpError } = require("../server/mcp-server");
  const pkg = require("../package.json");
  const onboarding = require("../server/onboarding-state");
  const { createGenerationJobManager } = require("../server/generation-job-manager");
  const { createBillingGateway } = require("../server/billing-guard");
  assert.match(safeMcpError({ code: "RATE_LIMITED" }), /限流/u, "rate limits need a distinct user-facing error");

  let meteredBalance = 30;
  let billingCalls = 0;
  const meteredGateway = {
    async accountStatus() {
      return {
        loggedIn: true,
        active: true,
        balance: meteredBalance,
        user: { username: "billing-test", plan: "count", balance: meteredBalance, quota: 30, used: 30 - meteredBalance }
      };
    },
    async listModels() { return { models: [{ id: "claude-sonnet-5", credits: 10 }] }; },
    async callModels(input) {
      billingCalls += 1;
      meteredBalance -= 10;
      return { content: "已扣费测试正文。", model: input.modelIds[0], transport: "billing-test" };
    }
  };
  const billedMetered = createBillingGateway(meteredGateway);
  const charged = await billedMetered.callModels({ prompt: "test", modelIds: ["claude-sonnet-5"] });
  assert.strictEqual(charged.billing.estimatedCredits, 10, "billing guard lost the live model rate");
  assert.strictEqual(charged.billing.balanceBefore, 30, "billing guard lost the pre-call balance");
  assert.strictEqual(charged.billing.balanceAfter, 20, "billing guard did not read the post-call balance");
  assert.strictEqual(charged.billing.chargeStatus, "charged", "billing guard did not verify a charge");
  meteredBalance = 5;
  await assert.rejects(
    billedMetered.callModels({ prompt: "blocked", modelIds: ["claude-sonnet-5"] }),
    (error) => error.code === "INSUFFICIENT_BALANCE" && error.billing?.balanceBefore === 5
  );
  assert.strictEqual(billingCalls, 1, "insufficient balance still reached the model");
  const unlimitedGateway = createBillingGateway({
    async accountStatus() { return { loggedIn: true, active: true, balance: -1, user: { username: "host", plan: "unlimited", accountType: "hosted_permanent", balance: -1, quota: 1000050, used: 3, callsLeft: -1 } }; },
    async listModels() { return { models: [{ id: "claude-sonnet-5", credits: 10 }] }; },
    async callModels(input) { return { content: "不限额测试正文。", model: input.modelIds[0] }; }
  });
  const unmetered = await unlimitedGateway.callModels({ prompt: "test", modelIds: ["claude-sonnet-5"] });
  assert.strictEqual(unmetered.billing.chargeStatus, "unmetered", "unlimited account was reported as metered");

  const jobStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "zizhuji-job-state-"));
  let releaseJob;
  let finishJob;
  const jobFinished = new Promise((resolve) => { finishJob = resolve; });
  try {
    const manager = createGenerationJobManager({ stateDir: jobStateDir });
    const started = manager.start({
      type: "generation",
      metadata: { projectDir: "C:\\novel" },
      async run({ updateProgress }) {
        updateProgress({ state: "streaming", checkpointPath: "C:\\novel\\审稿记录\\draft.in-progress.body.txt", chars: 320 });
        await new Promise((resolve) => { releaseJob = resolve; });
        finishJob();
        return { ok: true, artifact: { plainPath: "C:\\novel\\正文\\第001章_测试.txt" } };
      }
    });
    await new Promise((resolve) => setImmediate(resolve));
    const recovered = createGenerationJobManager({ stateDir: jobStateDir }).get(started.jobId);
    assert.strictEqual(recovered.status, "interrupted", "restarted manager did not expose an interrupted durable job");
    assert.strictEqual(recovered.recovered, true, "durable job was not marked recovered");
    assert.strictEqual(recovered.progress.chars, 320, "durable job lost its saved progress");
    assert.match(recovered.error.message, /检查点/u, "recovered job did not explain checkpoint recovery");
    releaseJob();
    await jobFinished;
    await new Promise((resolve) => setImmediate(resolve));
    const completed = createGenerationJobManager({ stateDir: jobStateDir }).get(started.jobId);
    assert.strictEqual(completed.status, "completed", "completed durable job was not readable after manager restart");
  } finally {
    if (typeof releaseJob === "function") releaseJob();
    fs.rmSync(jobStateDir, { recursive: true, force: true });
  }

  const onboardingDir = fs.mkdtempSync(path.join(os.tmpdir(), "zizhuji-onboarding-"));
  const onboardingPath = path.join(onboardingDir, "state.json");
  try {
    const fresh = await onboarding.markPackageInstalled(onboardingPath);
    assert.strictEqual(fresh.pendingFirstLogin, false, "install must not require gateway login");
    const normalDecision = onboarding.decidePopup(fresh, { loggedIn: false });
    assert.strictEqual(normalDecision.open, false, "passive status check must not open login");
    assert.strictEqual(normalDecision.reason, "gateway_binding_required");
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
    const { createGatewayGuard, openExternal } = require("../server/gateway-guard");
    const attemptedBrowsers = [];
    const openedWithFallback = openExternal("http://127.0.0.1:43210/", {
      platform: "win32",
      spawnImpl(command) {
        attemptedBrowsers.push(command);
        if (command === "explorer.exe") throw new Error("explorer unavailable in test");
        return { unref() {} };
      }
    });
    assert.strictEqual(openedWithFallback, true, "browser fallback did not launch after the first command failed");
    assert.deepStrictEqual(attemptedBrowsers, ["explorer.exe", "cmd"], "Windows browser launch order is not deterministic");
    let loggedIn = false;
    let popupOpenCount = 0;
    const browserHandoffs = [];
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
      },
      openExternalImpl: (url) => {
        browserHandoffs.push(url);
        return true;
      }
    });

    const initialized = await guard.ensureAccess({
      reason: "initialize",
      allowPopup: true,
      explicitUserChoice: true,
      openBrowser: true
    });
    assert.strictEqual(initialized.activationPageOpened, true, "first initialize must open the gateway page");
    assert.strictEqual(initialized.popupOpened, true, "first initialize did not expose the gateway page");
    assert.strictEqual(initialized.browserOpened, true, "first initialize did not hand the binding page to the system browser");
    assert.deepStrictEqual(browserHandoffs, ["http://127.0.0.1:43210/"], "first initialize did not force exactly one browser handoff");
    assert.ok((await onboarding.readState(popupStatePath)).firstActivationGatewayOpenedAt, "first activation was not persisted");
    assert.strictEqual(popupOpenCount, 1, "first initialize must open exactly one page");

    const status = await guard.accountSnapshot();
    assert.strictEqual(status.loggedIn, false);
    assert.strictEqual(popupOpenCount, 1, "status check reopened a login page");

    await onboarding.writeState({
      ...(await onboarding.readState(popupStatePath)),
      lastPopupAt: null,
      lastPopupReason: null
    }, popupStatePath);

    const firstApprovedCall = await guard.ensureAccess({
      reason: "generate_to_file",
      allowPopup: true,
      explicitUserChoice: true,
      openBrowser: false
    });
    assert.strictEqual(firstApprovedCall.reason, "first_model_use");
    assert.strictEqual(firstApprovedCall.popupOpened, true);
    assert.strictEqual(popupOpenCount, 2, "first approved call must open exactly once after activation");

    const repeatedCall = await guard.ensureAccess({
      reason: "generate_to_file",
      allowPopup: true,
      explicitUserChoice: true,
      openBrowser: false
    });
    assert.strictEqual(repeatedCall.reason, "first_model_use_cooldown");
    assert.strictEqual(repeatedCall.popupOpened, false);
    assert.strictEqual(popupOpenCount, 2, "cooldown call reopened the login page");

    loggedIn = true;
    const afterLogin = await guard.ensureAccess({
      reason: "generate_to_file",
      allowPopup: true,
      explicitUserChoice: true,
      openBrowser: false
    });
    assert.strictEqual(afterLogin.loggedIn, true);
    assert.strictEqual(popupOpenCount, 2, "logged-in call reopened the login page");

    loggedIn = false;
    const droppedInitialize = await guard.ensureAccess({
      reason: "initialize",
      allowPopup: false,
      explicitUserChoice: false,
      openBrowser: false
    });
    assert.strictEqual(droppedInitialize.reason, "session_dropped_silent");
    assert.strictEqual(droppedInitialize.popupOpened, false);
    assert.strictEqual(popupOpenCount, 2, "session drop during initialize opened a page");
    await guard.accountSnapshot();
    assert.strictEqual(popupOpenCount, 2, "session-drop status check opened a page");
  } finally {
    if (previousStatePath == null) delete process.env.FICTION_DIRECTOR_ONBOARDING_STATE;
    else process.env.FICTION_DIRECTOR_ONBOARDING_STATE = previousStatePath;
    fs.rmSync(popupDir, { recursive: true, force: true });
  }

  let lastGatewayCallInput = null;
  const fakeGateway = {
    baseUrl: "https://example.test",
    async login() { return { ok: true, loggedIn: true }; },
    async accountStatus() { return { ok: true, loggedIn: true, active: true, balance: 42, user: { username: "tester", balance: 42 } }; },
    async connectionStatus() { return { ok: true, online: true }; },
    async listModels() { return { ok: true, models: [{ id: "claude-opus-5", credits: 20 }, { id: "claude-sonnet-5", credits: 10 }, { id: "deepseek-v4-pro", credits: 10 }, { id: "kimi-k3", credits: 30 }, { id: "gemini-3.5-flash", credits: 5 }] }; },
    async callModels(input) {
      lastGatewayCallInput = { ...input };
      if (input.taskLabel === "background-test") {
        if (typeof input.onDelta === "function") {
          await input.onDelta("后台流式正文已经返回一段。\n\n");
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
      const model = input.modelIds[0];
      const content = "测试正文。" + "他推开门，屋里的灯还亮着，桌上的茶已经凉了。".repeat(30);
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
  assert.strictEqual(gatewayGuardArguments[0].allowPopup, true, "initialize must open the first binding page");
  assert.strictEqual(gatewayGuardArguments[0].explicitUserChoice, true, "initialize must record binding authorization");
  assert.strictEqual(gatewayGuardArguments[0].openBrowser, true, "initialize must open the binding page in a browser");

  const list = await handle({ jsonrpc: "2.0", id: 2, method: "tools/list" }, runtime);
  const names = list.result.tools.map((t) => t.name);
  const definitions = new Map(list.result.tools.map((tool) => [tool.name, tool]));
  const expected = [
    "fiction_ensure_gateway", "fiction_open_gateway_login", "fiction_account_status",
    "fiction_list_models", "fiction_recommend_models", "fiction_list_model_tasks",
    "fiction_generate_to_file", "fiction_continue_artifact", "fiction_generation_status", "fiction_write_artifact", "fiction_write_local_candidate",
    "fiction_read_artifact", "fiction_list_artifacts",
    "fiction_optimize_with_models", "fiction_compare_style", "fiction_smoke_live_gateway"
  ];
  const expectedLocal = [
    "fiction_project", "fiction_sample_book", "fiction_research",
    "fiction_facts", "fiction_voice_anchor"
  ];
  const expectedRankings = [
    "fiction_rank_sources", "fiction_scan_rankings", "fiction_compare_rank_snapshots"
  ];
  const expectedDownloads = ["fiction_download_book"];
  assert.strictEqual(names.length, expected.length + expectedLocal.length + expectedRankings.length + expectedDownloads.length, "tool count " + names.length);
  for (const name of expected) assert.ok(names.includes(name), "missing tool " + name);
  for (const name of expectedLocal) assert.ok(names.includes(name), "missing local core tool " + name);
  for (const name of expectedRankings) assert.ok(names.includes(name), "missing ranking tool " + name);
  for (const name of expectedDownloads) assert.ok(names.includes(name), "missing download tool " + name);
  assert.deepStrictEqual(definitions.get("fiction_download_book").inputSchema.required, ["projectDir", "authorized"]);
  assert.deepStrictEqual(definitions.get("fiction_generate_to_file").inputSchema.required, ["projectDir", "prompt", "modelIds", "authorConfirmed"]);
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.modelIds.type, "array");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.fallbackChain.type, "boolean");
  assert.strictEqual(definitions.get("fiction_recommend_models").inputSchema.properties.targetChars.type, "number");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.projectContext.type, "string");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.authorConfirmed.type, "boolean");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.background.type, "boolean");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.minChars.type, "number");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.prompt.maxLength, 1000000, "draft prompt capacity is too small");
  assert.strictEqual(definitions.get("fiction_generate_to_file").inputSchema.properties.projectContext.maxLength, 1000000, "project context capacity is too small");
  assert.strictEqual(definitions.get("fiction_optimize_with_models").inputSchema.properties.draftText.maxLength, 1000000, "optimization input capacity is too small");
  assert.strictEqual(definitions.get("fiction_write_artifact").inputSchema.properties.content.maxLength, 1000000, "artifact write capacity is too small");
  assert.deepStrictEqual(definitions.get("fiction_continue_artifact").inputSchema.required, ["projectDir", "sourcePath", "modelIds", "authorConfirmed"]);
  assert.strictEqual(definitions.get("fiction_continue_artifact").inputSchema.properties.background.type, "boolean");
  assert.deepStrictEqual(definitions.get("fiction_generation_status").inputSchema.required, ["jobId"]);
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
  const listedModels = await callTool("fiction_list_models", {});
  assert.strictEqual(listedModels.models.length, 3);
  assert.ok(listedModels.directUse.modelIds.includes("deepseek-v4-pro"), "model list did not advertise direct DeepSeek use");
  const guardCallsBeforeRecommendation = gatewayGuardCalls;
  const recommendation = await callTool("fiction_recommend_models", { task: "draft", mode: "quick" });
  assert.strictEqual(gatewayGuardCalls, guardCallsBeforeRecommendation, "recommendation must not trigger login guard");
  assert.ok(Array.isArray(recommendation.modelIds) && recommendation.modelIds.length > 0, "recommendation modelIds missing");
  assert.strictEqual(recommendation.modelIds.length, 1, "router must return exactly one selected model");
  assert.strictEqual(recommendation.fallbackChain, false, "router must not enable automatic model fallback");
  assert.ok(Array.isArray(recommendation.alternativeModelIds), "router must keep alternatives separate from the selected model");
  assert.ok(recommendation.billing, "recommendation must expose billing information");
  assert.ok(Number.isFinite(recommendation.billing.estimatedCredits) && recommendation.billing.estimatedCredits > 0, "recommendation did not expose the selected model rate");
  assert.strictEqual(recommendation.billing.balanceBefore, 42, "recommendation did not expose the current balance");
  assert.ok(String(recommendation.billing.message || "").includes("预计消耗"), "recommendation billing message missing the estimate");
  assert.ok(String(recommendation.coachAdvice || "").includes("等待作者当次确认"), "recommendation must require per-call confirmation");
  const deepseekRecommendation = await callTool("fiction_recommend_models", {
    task: "review",
    mode: "quick",
    authorPrefer: ["deepseek-v4-pro"]
  });
  assert.strictEqual(deepseekRecommendation.primaryModelId, "deepseek-v4-pro", "direct DeepSeek selection was not preserved");
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

    const gen = await callTool("fiction_generate_to_file", {
      projectDir,
      prompt: "写一段测试",
      projectContext: [
        "卢象升不知道后世历史，系统不给敌情透视。",
        "前500字内同时出现至少三项压力。",
        "第1章完成文化选择，第2章列阵。",
        "每400至700字必须出现一次压力变化。"
      ].join("\n"),
      modelIds: ["claude-opus-5"],
      authorConfirmed: true,
      chapterNo: "1",
      title: "测试章",
      minChars: 1200,
      applyHardGates: false
    });
    assert.strictEqual(gen.ok, true);
    assert.strictEqual(gen.transport, "stream_attempt_1", "artifact lost the model transport detail");
    assert.ok(lastGatewayCallInput.system.includes("事实是硬边界，写法是自由区"), "draft request misses fixed natural-prose policy");
    assert.ok(lastGatewayCallInput.system.includes("不能按提示词栏目逐项亮相"), "draft request still permits checklist prose");
    assert.ok(lastGatewayCallInput.system.includes("不要为了所谓人味刻意制造误判或残缺"), "draft request replaces checklist prose with forced imperfection");
    assert.ok(lastGatewayCallInput.prompt.includes("卢象升不知道后世历史"), "draft request dropped a factual project boundary");
    assert.ok(lastGatewayCallInput.prompt.includes("写一段测试"), "draft request dropped the current author request");
    assert.ok(!lastGatewayCallInput.prompt.includes("前500字"), "draft request leaked a fixed opening quota");
    assert.ok(!lastGatewayCallInput.prompt.includes("第1章完成"), "draft request leaked fixed chapter slots");
    assert.ok(!lastGatewayCallInput.prompt.includes("每400至700字"), "draft request leaked a fixed pacing interval");
    assert.ok(lastGatewayCallInput.prompt.includes("完整正文不得少于 1200 个中文字符"), "minChars was checked after generation but not sent to the model");
    assert.ok(lastGatewayCallInput.prompt.includes("沿现有因果") && lastGatewayCallInput.prompt.includes("不得靠复述"), "long-form prompt permits padding");
    assert.strictEqual(lastGatewayCallInput.maxTokens, 32000, "draft default output budget is too small");
    const generateGuardCall = gatewayGuardArguments.find((item) => item.reason === "generate_to_file");
    assert.strictEqual(generateGuardCall?.allowPopup, true, "approved generation must allow first-use login");
    assert.strictEqual(generateGuardCall?.explicitUserChoice, true, "approved generation must record explicit choice");
    assert.ok(fs.existsSync(gen.artifact.path), "artifact txt missing");
    assert.ok(gen.artifact.relativePath.includes("正文"), "chapter generation must write directly to 正文");
    assert.strictEqual(gen.artifact.path, gen.artifact.plainPath, "chapter generation should keep a single current file");
    assert.strictEqual(gen.artifact.target, "chapter", "chapter generation target mismatch");
    const generatedArtifact = fs.readFileSync(gen.artifact.path, "utf8");
    assert.ok(generatedArtifact.includes("测试正文"), "chapter file did not contain model prose");
    assert.ok(!generatedArtifact.includes("# artifact"), "chapter file must be plain prose, not an artifact wrapper");
    assert.strictEqual(gen.artifact.recordedForMemory, true, "external model output must be recorded for memory");
    assert.ok(fs.existsSync(gen.artifact.memoryRecord.path), "model writing record missing");
    const firstModelRecord = fs.readFileSync(gen.artifact.memoryRecord.path, "utf8");
    assert.ok(firstModelRecord.includes("claude-opus-5"), "model id missing from writing record");
    assert.ok(firstModelRecord.includes(gen.artifact.plainRelativePath.replace(/\\/g, "/")), "chapter path missing from writing record");
    assert.ok(firstModelRecord.includes("已写入正文"), "chapter ledger status missing from writing record");

    const read = await callTool("fiction_read_artifact", { path: gen.artifact.path });
    assert.ok(read.content.includes("测试正文"), "read content mismatch");

    const regen = await callTool("fiction_generate_to_file", {
      projectDir,
      prompt: "重写同一章",
      modelIds: ["claude-opus-5"],
      authorConfirmed: true,
      chapterNo: "1",
      title: "测试章",
      applyHardGates: false
    });
    assert.strictEqual(regen.artifact.path, gen.artifact.path, "regeneration must overwrite the same chapter file");

    const background = await callTool("fiction_generate_to_file", {
      projectDir,
      prompt: "后台写一段测试",
      modelIds: ["claude-opus-5"],
      authorConfirmed: true,
      background: true,
      chapterNo: "2",
      title: "后台章",
      taskLabel: "background-test",
      applyHardGates: false
    });
    assert.strictEqual(background.background, true, "background generation did not return immediately");
    assert.ok(background.jobId, "background generation job id missing");
    assert.ok(Array.isArray(background.waitingWork) && background.waitingWork.length > 0, "background waiting work missing");
    let backgroundStatus = await callTool("fiction_generation_status", { jobId: background.jobId });
    for (let attempt = 0; attempt < 20 && !["completed", "failed"].includes(backgroundStatus.status); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      backgroundStatus = await callTool("fiction_generation_status", { jobId: background.jobId });
    }
    assert.strictEqual(backgroundStatus.status, "completed", "background generation did not complete");
    assert.ok(fs.existsSync(backgroundStatus.result.artifact.path), "background artifact txt missing");
    assert.ok(backgroundStatus.progress && backgroundStatus.progress.state === "completed", "background generation progress was not exposed");
    assert.ok(backgroundStatus.progress.chars > 0, "background article inspection did not report chars");

    const modelRecordBeforeLocal = fs.readFileSync(gen.artifact.memoryRecord.path, "utf8");
    const local = await callTool("fiction_write_local_candidate", { projectDir, content: "本地正文。", title: "本地", chapterNo: "3" });
    assert.strictEqual(local.ok, true);
    assert.strictEqual(local.artifact.recordedForMemory, false, "local draft must not impersonate external-model history");
    assert.strictEqual(local.artifact.target, "chapter", "local chapter write should default to chapter");
    assert.strictEqual(fs.readFileSync(gen.artifact.memoryRecord.path, "utf8"), modelRecordBeforeLocal, "local draft changed external-model history");

    const importedExternal = await callTool("fiction_write_artifact", {
      projectDir,
      content: "从作者已有模型取得的临时内容。",
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
    assert.ok(Array.isArray(listed.items), "artifact list result invalid");
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
  const previousGatewayUrl = process.env.FICTION_DIRECTOR_GATEWAY_URL;
  process.env.FICTION_DIRECTOR_GATEWAY_URL = "https://stale-model-source.invalid";
  try {
    const resolvedGateway = resolveGateway({ gatewayMode: "openai", gatewayApiKey: "sk-ignored-test-key" });
    assert.strictEqual(resolvedGateway.baseUrl, "https://api.nanshanyougui.xyz", "stale API-key settings must not replace the ZiZiZhuJi account gateway");
  } finally {
    if (previousGatewayUrl === undefined) delete process.env.FICTION_DIRECTOR_GATEWAY_URL;
    else process.env.FICTION_DIRECTOR_GATEWAY_URL = previousGatewayUrl;
  }
  const loginConsole = createGatewayLoginConsole({ gateway: fakeGateway, keepAlive: true });
  const localPage = await loginConsole.start();
  try {
    const html = await (await fetch(localPage.url)).text();
    assert.ok(html.includes("刷新连接状态"), "simple connection refresh missing");
    assert.ok(html.includes('id="username"') && html.includes('id="password"'), "account/password login fields missing");
    assert.ok(html.includes('id="authSurface"') && html.includes('id="authSurface" class="auth-surface" hidden'), "auth surface must stay hidden until account status is known");
    assert.ok(html.includes("正在读取账号和模型状态…"), "login page must expose a neutral loading state");
    assert.ok(html.includes('id="modelListView"'), "dynamic backend model list missing");
    assert.ok(!html.includes("API 密钥") && !html.includes("第一模型源"), "obsolete API-key gateway UI remains");
    const dashboard = await (await fetch(new URL("/api/status", localPage.url))).json();
    assert.ok(Array.isArray(dashboard.models), "login page model catalog missing: " + JSON.stringify(dashboard));
    assert.deepStrictEqual(dashboard.models.map((item) => item.id), ["claude-sonnet-5", "deepseek-v4-pro", "claude-opus-5"], "login page did not expose the live backend model catalog");
    assert.ok(!dashboard.models.some((item) => ["kimi-k3", "gemini-3.5-flash"].includes(item.id)), "disabled live routes leaked into the login page");
    for (const removedUi of ["modelFilter", "showAllModels", "probeBtn", "完整模型列表"]) {
      assert.ok(!html.includes(removedUi), "obsolete user UI remains: " + removedUi);
    }
  } finally {
    await loginConsole.stop();
  }

  const degradedConsole = createGatewayLoginConsole({
    gateway: {
      async accountStatus() { return { loggedIn: true, active: true, balance: 100, user: { username: "degraded-test", plan: "count", balance: 100 } }; },
      async login() { return { ok: true, loggedIn: true }; },
      async listModels() { const error = new Error("upstream unavailable"); error.code = "SERVER_ERROR"; throw error; }
    },
    keepAlive: true
  });
  const degradedPage = await degradedConsole.start();
  try {
    const degradedStatus = await (await fetch(new URL("/api/status", degradedPage.url))).json();
    assert.strictEqual(degradedStatus.loggedIn, true, "catalog failure incorrectly turned a logged-in dashboard into a login page");
    assert.strictEqual(degradedStatus.online, false, "catalog failure was not surfaced as offline");
    assert.strictEqual(degradedStatus.errorCode, "SERVER_ERROR", "catalog failure lost its error code");
  } finally {
    await degradedConsole.stop();
  }

  console.log("PASS selftest-gateway-core: " + expected.length + " gateway + " + expectedLocal.length + " local + " + expectedRankings.length + " ranking + " + expectedDownloads.length + " download tools OK, version " + pkg.version);
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  if (error && error.data) console.error(JSON.stringify(error.data));
  process.exit(1);
});
