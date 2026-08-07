"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { generateToArtifact, readArtifact } = require("./artifact-pipeline");
const { recommendModels } = require("./model-router");
const { buildDraftSystem, prepareDraftPrompt } = require("./draft-prompt-lib");
const onboarding = require("./onboarding-state");

/**
 * Live multi-model smoke after user login.
 * Proves: list models -> one approved stream/txt generation -> readable .body.txt.
 * Optimization is deliberately separate because it requires a new author confirmation.
 */
async function smokeLiveGateway({ gateway, projectDir = "", title = "live-smoke", modelIds = [], statePath = undefined, markOnboarding = true } = {}) {
  if (!gateway || typeof gateway.accountStatus !== "function") {
    throw new Error("gateway required");
  }

  let account;
  try {
    account = await gateway.accountStatus();
  } catch (error) {
    return {
      ok: false,
      needLogin: true,
      stage: "accountStatus",
      message: "无法读取账号状态，请先 fiction_open_gateway_login。",
      error: String(error && (error.message || error))
    };
  }

  if (!account || account.loggedIn !== true) {
    return {
      ok: false,
      needLogin: true,
      stage: "login",
      message: "尚未登录网关。请打开登录窗完成登录（可在小店充值）。登录成功后重试本冒烟。",
      shopUrl: (await onboarding.readState(statePath || onboarding.defaultStatePath())).shopUrl
    };
  }

  if (markOnboarding) {
    await onboarding.markLoginOk(statePath || onboarding.defaultStatePath());
  }

  let modelsPayload;
  try {
    modelsPayload = await gateway.listModels();
  } catch (error) {
    return {
      ok: false,
      needLogin: /AUTH/i.test(String(error && error.code || error.message || "")),
      stage: "listModels",
      message: "listModels 失败：" + String(error && (error.message || error))
    };
  }

  const available = Array.isArray(modelsPayload.models) ? modelsPayload.models : [];
  if (!available.length) {
    return { ok: false, stage: "listModels", message: "账号下没有可用模型。" };
  }

  const draftRec = recommendModels({ task: "draft", availableModels: available, maxPerRole: 1 });
  const availableIds = new Set(available.map((item) => item && item.id).filter(Boolean));
  const requestedIds = Array.isArray(modelIds)
    ? [...new Set(modelIds.map((item) => String(item || "").trim()).filter((id) => availableIds.has(id)))]
    : [];
  const draftIds = (requestedIds.length ? requestedIds : draftRec.modelIds).slice(0, 1);
  if (!draftIds.length) {
    return { ok: false, stage: "recommend", message: "没有可推荐的正文模型。" };
  }

  const root = projectDir && String(projectDir).trim()
    ? path.resolve(projectDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-live-smoke-"));
  await fsp.mkdir(path.join(root, "辅助文档"), { recursive: true });
  await fsp.mkdir(path.join(root, "正文"), { recursive: true });
  await fsp.mkdir(path.join(root, "细纲"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "细纲", "01_当前章细纲.md"),
    "# 冒烟章节笔记\n\n人物正在整理一份尚未送出的军报，门外有人等他决定。\n",
    "utf8"
  );

  let generated;
  try {
    const draftSystem = buildDraftSystem({ kind: "draft", taskLabel: "live-smoke" });
    const preparedPrompt = prepareDraftPrompt({
      prompt: "写一小段完整的历史小说正文。雨夜辕门，主角拿着一份被人压了三天的军报，追问守门校尉。对方只答了一半，主角从他的停顿和动作里察觉还有人在场。不要替人物把动机和结论说完。",
      chapterNo: "1",
      title: "实网冒烟"
    });
    generated = await generateToArtifact({
      gateway,
      projectDir: root,
      kind: "live_smoke_draft",
      title: title || "实网冒烟",
      chapterNo: "1",
      modelIds: draftIds,
      system: draftSystem.system,
      prompt: preparedPrompt.prompt,
      taskLabel: "live-smoke",
      fallbackChain: false,
      applyHardGates: true,
      minChars: 40,
      requestPolicyVersion: draftSystem.policyVersion,
      contextSanitization: preparedPrompt.contextSanitization
    });
  } catch (error) {
    return {
      ok: false,
      stage: "generate_to_file",
      modelIds: draftIds,
      message: "生成失败：" + String(error && (error.message || error)),
      projectDir: root
    };
  }

  const bodyRead = await readArtifact(generated.artifact.path);
  if (!bodyRead.content || bodyRead.content.replace(/\s+/g, "").length < 20) {
    return { ok: false, stage: "read_body", message: "生成 txt 不可读或过短", artifact: generated.artifact };
  }

  return {
    ok: true,
    stage: "done",
    projectDir: root,
    account: {
      username: account.user?.username || null,
      balance: account.balance ?? account.user?.balance ?? null
    },
    modelsAvailable: available.length,
      draftModelIds: draftIds,
      draft: {
        artifact: generated.artifact,
        transport: generated.transport,
        billing: generated.billing || null,
        attempt: generated.attempt,
      degraded: generated.degraded,
      preview: String(bodyRead.content).slice(0, 280),
      modelReadable: true
    },
    optimize: null,
    nextStep: "如需优化，重新推荐模型并询问作者后，再调用 fiction_optimize_with_models。",
    coach: "实网冒烟通过：模型列表 → 一次已授权生成 → 正文直写与写作记录。"
  };
}

module.exports = { smokeLiveGateway };
