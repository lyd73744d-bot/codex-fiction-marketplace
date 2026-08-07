"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fiction-guided-onboarding-"));
process.env.LOCALAPPDATA = path.join(tempRoot, "localappdata");

const onboarding = require("../server/onboarding-state");
const { createGatewayGuard } = require("../server/gateway-guard");
const { createGatewayMcpTools } = require("../server/gateway-mcp-tools");
const { createLocalCoreTools } = require("../server/local-core-tools");
const { MODEL_CAPABILITY_PROFILES } = require("../server/model-router");

function capabilityOf(modelId) {
  const profile = MODEL_CAPABILITY_PROFILES[String(modelId || "").toLowerCase()];
  return profile ? profile.longForm : "unverified";
}

function decode(reply) {
  return JSON.parse(reply.content[0].text);
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function main() {
  const pluginRoot = path.resolve(__dirname, "..");
  const catalog = JSON.parse(fs.readFileSync(path.join(pluginRoot, "model-catalog-live.json"), "utf8"));
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"));
  const skill = fs.readFileSync(path.join(pluginRoot, "skills", "longform-fiction-director", "SKILL.md"), "utf8");
  const modelIds = catalog.models.map((item) => item.id);

  assert.strictEqual(modelIds.length, 11, "shipped catalog must match the 11 retained live models");
  assert.strictEqual(catalog.preferredModel, "claude-sonnet-5");
  for (const id of ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-5", "gemini-3.1-pro-preview", "doubao-seed-2-1-turbo", "glm-5.2", "minimax-m3", "deepseek-v4-flash", "deepseek-v4-pro", "kimi-k2.6"]) {
    assert.ok(modelIds.includes(id), `retained route is missing: ${id}`);
  }
  for (const id of ["seed-2.1-pro", "seed-2.1-turbo", "gpt-image-2", "qwen3.7-max", "grok-4.5", "ark-code-latest", "doubao-seed-2-0-lite", "kimi-k2.7-code", "minimax-m2.7"]) {
    assert.ok(!modelIds.includes(id), `removed route leaked into catalog: ${id}`);
  }
  assert.ok(!modelIds.includes("claude-opus-4-7"), "unverified opus route leaked into catalog");
  assert.ok(manifest.interface.defaultPrompt.some((line) => line.includes("直接问我是开新书还是接着写旧书")));
  assert.ok(manifest.interface.defaultPrompt.some((line) => line.includes("每次调用其他模型前都问我是否使用")));
  assert.ok(manifest.interface.defaultPrompt.some((line) => /DeepSeek|deepseek/iu.test(line)), "default prompt must explain direct DeepSeek use");
  assert.ok(skill.includes("你是准备开一本新书，还是接着写已有小说？"));
  assert.ok(skill.includes("是否使用这个模型？"));
  assert.ok(/DeepSeek|deepseek/iu.test(skill), "skill must explain direct DeepSeek use");

  let loggedIn = false;
  let popupCalls = 0;
  let modelCalls = 0;
  const gateway = {
    async accountStatus() {
      return loggedIn
        ? { ok: true, loggedIn: true, active: true, balance: 1000, user: { username: "guided-test", active: true, plan: "count", balance: 1000, quota: 1000, used: 0 } }
        : { ok: true, loggedIn: false, active: false, user: null };
    },
    async listModels() {
      return { ok: true, models: catalog.models };
    },
    async callModels(input) {
      modelCalls += 1;
      return {
        content: "雨停以后，驿卒才把湿透的公文送进来。卢象升没有立刻拆，只问来人从哪条路过的。来人说到一半，忽然看向帐外。那边有人咳了一声，后半句话便没了。",
        model: input.modelIds[0],
        finishReason: "stop",
        transport: "guided-test"
      };
    }
  };
  const guard = createGatewayGuard({
    gateway,
    paymentPortalUrl: "https://example.invalid/shop",
    async openLoginPage() {
      popupCalls += 1;
      return { url: "http://127.0.0.1:65534/login", message: "test login" };
    }
  });
  const tools = createGatewayMcpTools({ gateway, gatewayGuard: guard });

  await onboarding.markPackageInstalled();
  let state = await onboarding.readState();
  assert.strictEqual(state.pendingFirstLogin, false, "installation scheduled a login popup");
  assert.strictEqual(popupCalls, 0, "installation opened login");

  const firstActivation = await guard.ensureAccess({
    reason: "initialize",
    allowPopup: true,
    explicitUserChoice: true,
    openBrowser: false
  });
  assert.strictEqual(firstActivation.activationPageOpened, true, "first activation did not open the gateway page");
  assert.strictEqual(firstActivation.popupOpened, true, "first activation did not expose the binding page");
  assert.ok((await onboarding.readState()).firstActivationGatewayOpenedAt, "first activation was not persisted");

  loggedIn = true;
  await onboarding.writeState(onboarding.emptyState());
  popupCalls = 0;
  const loggedInActivation = await guard.ensureAccess({
    reason: "initialize",
    allowPopup: true,
    explicitUserChoice: true,
    openBrowser: false
  });
  assert.strictEqual(loggedInActivation.loggedIn, true, "logged-in first activation lost the session");
  assert.strictEqual(loggedInActivation.activationPageOpened, true, "logged-in first activation did not open the gateway page");
  assert.strictEqual(popupCalls, 1, "logged-in first activation opened more than one page");

  loggedIn = false;
  await onboarding.writeState(onboarding.emptyState());
  popupCalls = 0;
  await onboarding.markPackageInstalled();
  state = await onboarding.readState();

  const silentStatus = decode(await tools.call("fiction_ensure_gateway", {}));
  assert.strictEqual(silentStatus.popupOpened, false, "silent status check opened login");
  assert.strictEqual(popupCalls, 0);

  const recommendation = decode(await tools.call("fiction_recommend_models", { task: "draft", mode: "deep", maxPerRole: 1 }));
  assert.ok(recommendation.primaryModelId, "writing guidance did not recommend a model");
  assert.ok(modelIds.includes(recommendation.primaryModelId), "guidance recommended a removed model");
  assert.ok(!JSON.stringify(recommendation).includes("grok-4.5"), "slow backup model must not be recommended automatically");
  assert.ok(recommendation.billing, "writing guidance did not expose billing");
  assert.strictEqual(recommendation.billing.status, "unauthenticated", "unbound guidance must identify the login requirement");
  assert.ok(recommendation.directUse?.modelIds.includes("deepseek-v4-flash"), "guidance did not expose direct DeepSeek use");
  assert.strictEqual(popupCalls, 0, "model recommendation opened login");
  assert.strictEqual(modelCalls, 0, "model recommendation generated prose");

  const deepLong = decode(await tools.call("fiction_recommend_models", {
    task: "draft", mode: "deep", targetChars: 5000, maxPerRole: 1
  }));
  assert.strictEqual(deepLong.primaryModelId, "claude-opus-4-6", "deep long-form routing ignored verified prose quality");
  assert.strictEqual(deepLong.transport.streamRetries, 1, "router advertised hidden retries");
  assert.strictEqual(deepLong.transport.nonStreamFallback, false, "router advertised a second transport submission");

  const quickLong = decode(await tools.call("fiction_recommend_models", {
    task: "draft", mode: "quick", targetChars: 5000, maxPerRole: 1
  }));
  assert.strictEqual(quickLong.primaryModelId, "claude-opus-4-6", "long-form routing did not select the verified long-form model");
  assert.ok(!quickLong.alternativeModelIds.includes("glm-5.2") && !quickLong.alternativeModelIds.includes("minimax-m3"), "unverified long-form models were automatically recommended");
  const defaultLong = decode(await tools.call("fiction_recommend_models", {
    task: "draft", mode: "quick", targetChars: 5000
  }));
  assert.deepStrictEqual(defaultLong.modelIds, [defaultLong.primaryModelId], "long-form call must submit exactly one model");
  for (const id of defaultLong.alternativeModelIds) {
    assert.strictEqual(capabilityOf(id), "verified", "unverified long-form alternative was recommended: " + id);
  }
  assert.ok(!JSON.stringify(quickLong).includes("gpt-image-2"), "image model leaked into writing recommendations");

  const manualKimi = decode(await tools.call("fiction_recommend_models", {
    task: "draft",
    mode: "quick",
    maxPerRole: 1,
    authorPrefer: ["kimi-k2.6"]
  }));
  assert.strictEqual(manualKimi.primaryModelId, "kimi-k2.6", "explicit retained model selection was not preserved");
  const manualDeepSeek = decode(await tools.call("fiction_recommend_models", {
    task: "review",
    mode: "quick",
    maxPerRole: 1,
    authorPrefer: ["deepseek-v4-pro"]
  }));
  assert.strictEqual(manualDeepSeek.primaryModelId, "deepseek-v4-pro", "direct DeepSeek selection was not preserved");

  const projectDir = path.join(tempRoot, "guided-novel");
  const localTools = createLocalCoreTools();
  decode(await localTools.call("fiction_project", { action: "create", projectDir, title: "首次引导测试" }));
  const outline = fs.readFileSync(path.join(projectDir, "辅助文档", "01_全书大纲.md"), "utf8");
  assert.ok(!/^\|.+\|$/m.test(outline), "new-book guidance created a form-style outline");

  await expectCode(tools.call("fiction_generate_to_file", {
    projectDir,
    prompt: "写一个历史小说候选片段",
    modelIds: [recommendation.primaryModelId],
    authorConfirmed: false
  }), "AUTHOR_CONFIRMATION_REQUIRED");
  assert.strictEqual(popupCalls, 0, "rejected model call opened login");
  assert.strictEqual(modelCalls, 0, "rejected model call reached the model");

  const firstUse = await guard.ensureAccess({
    reason: "approved_first_model_use",
    allowPopup: true,
    explicitUserChoice: true,
    openBrowser: false
  });
  assert.strictEqual(firstUse.popupOpened, true, "approved first use did not offer login");
  assert.strictEqual(popupCalls, 1);
  assert.strictEqual(modelCalls, 0, "login step generated prose before authentication");

  loggedIn = true;
  await tools.call("fiction_ensure_gateway", { bindModels: true });
  const boundRecommendation = decode(await tools.call("fiction_recommend_models", { task: "draft", mode: "quick" }));
  assert.ok(Number.isFinite(boundRecommendation.billing.estimatedCredits), "bound guidance did not expose a model rate");
  assert.strictEqual(boundRecommendation.billing.balanceBefore, 1000, "bound guidance did not expose the current balance");
  const generated = decode(await tools.call("fiction_generate_to_file", {
    projectDir,
    prompt: "写一个历史小说正文片段。人物没有把话说全，叙述也不替他解释。",
    modelIds: [recommendation.primaryModelId],
    authorConfirmed: true,
    chapterNo: "1",
    title: "引导测试",
    applyHardGates: false
  }));
  assert.strictEqual(modelCalls, 1, "approved model call did not run exactly once");
  assert.ok(fs.existsSync(generated.artifact.plainPath), "approved chapter was not saved");
  assert.ok(generated.artifact.plainPath.includes("正文"), "approved generation did not write to 正文");
  assert.strictEqual(generated.artifact.target, "chapter", "approved generation did not default to chapter");
  assert.ok(fs.existsSync(generated.artifact.memoryRecord.path), "model writing history was not recorded");

  await expectCode(tools.call("fiction_optimize_with_models", {
    projectDir,
    draftText: fs.readFileSync(generated.artifact.plainPath, "utf8"),
    modelIds: [recommendation.primaryModelId],
    authorConfirmed: false
  }), "AUTHOR_CONFIRMATION_REQUIRED");
  assert.strictEqual(modelCalls, 1, "previous consent leaked into a later optimization call");

  state = await onboarding.readState();
  assert.strictEqual(state.modelGatewayBound, true, "gateway binding was not remembered");
  console.log("PASS selftest-guided-onboarding: cold start, natural project, per-call consent, login timing and direct chapter persistence OK");
}

main()
  .finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error("FAIL", error && (error.stack || error.message || error));
    process.exit(1);
  });
