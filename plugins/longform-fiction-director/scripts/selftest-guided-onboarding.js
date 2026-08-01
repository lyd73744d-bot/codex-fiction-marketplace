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

  assert.strictEqual(modelIds.length, 9, "shipped catalog must match the 9 retained live models");
  assert.strictEqual(catalog.preferredModel, "claude-opus-4-6");
  assert.ok(modelIds.includes("glm-5.2"), "verified GLM route is missing from the shipped catalog");
  assert.ok(modelIds.includes("minimax-m3"), "verified MiniMax route is missing from the shipped catalog");
  assert.ok(modelIds.includes("kimi-k3"), "verified Kimi K3 route is missing from the shipped catalog");
  assert.ok(modelIds.includes("gemini-3.5-flash"), "verified Gemini Flash route is missing from the shipped catalog");
  assert.ok(!modelIds.includes("deepseek-v4-pro") && !modelIds.includes("seed-2.1-pro") && !modelIds.includes("grok-4.5"));
  assert.ok(!modelIds.includes("claude-opus-5") && !modelIds.includes("claude-opus-4-8"));
  assert.ok(manifest.interface.defaultPrompt.some((line) => line.includes("直接问我是开新书还是接着写旧书")));
  assert.ok(manifest.interface.defaultPrompt.some((line) => line.includes("每次调用其他模型前都问我是否使用")));
  assert.ok(skill.includes("你是准备开一本新书，还是接着写已有小说？"));
  assert.ok(skill.includes("是否使用这个模型？"));

  let loggedIn = false;
  let popupCalls = 0;
  let modelCalls = 0;
  const gateway = {
    async accountStatus() {
      return loggedIn
        ? { ok: true, loggedIn: true, active: true, user: { username: "guided-test", active: true } }
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

  const silentStatus = decode(await tools.call("fiction_ensure_gateway", {}));
  assert.strictEqual(silentStatus.popupOpened, false, "silent status check opened login");
  assert.strictEqual(popupCalls, 0);

  const recommendation = decode(await tools.call("fiction_recommend_models", { task: "draft", mode: "deep", maxPerRole: 1 }));
  assert.ok(recommendation.primaryModelId, "writing guidance did not recommend a model");
  assert.ok(modelIds.includes(recommendation.primaryModelId), "guidance recommended a removed model");
  assert.ok(!JSON.stringify(recommendation).includes('"credits"'), "writing guidance exposed credits");
  assert.strictEqual(popupCalls, 0, "model recommendation opened login");
  assert.strictEqual(modelCalls, 0, "model recommendation generated prose");

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
  const generated = decode(await tools.call("fiction_generate_to_file", {
    projectDir,
    prompt: "写一个历史小说候选片段。人物没有把话说全，叙述也不替他解释。",
    modelIds: [recommendation.primaryModelId],
    authorConfirmed: true,
    applyHardGates: false
  }));
  assert.strictEqual(modelCalls, 1, "approved model call did not run exactly once");
  assert.ok(fs.existsSync(generated.artifact.plainPath), "approved candidate was not saved");
  assert.ok(generated.artifact.plainPath.includes("Codex候选"), "candidate bypassed the review folder");
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
  console.log("PASS selftest-guided-onboarding: cold start, natural project, per-call consent, login timing and candidate persistence OK");
}

main()
  .finally(() => fs.rmSync(tempRoot, { recursive: true, force: true }))
  .catch((error) => {
    console.error("FAIL", error && (error.stack || error.message || error));
    process.exit(1);
  });
