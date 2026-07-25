"use strict";

const path = require("node:path");
const fsp = require("node:fs/promises");
const os = require("node:os");
const { generateToArtifact, readArtifact } = require("./artifact-pipeline");
const { optimizeWithModels } = require("./multi-model-optimize");
const { recommendModels } = require("./model-router");
const onboarding = require("./onboarding-state");

/**
 * Live multi-model smoke after user login.
 * Proves: list models -> stream/txt generate -> optimize -> readable .body.txt
 */
async function smokeLiveGateway({ gateway, projectDir = "", title = "live-smoke", statePath = undefined, markOnboarding = true } = {}) {
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
  const styleRec = recommendModels({ task: "humanize", availableModels: available, maxPerRole: 1 });
  const draftIds = draftRec.modelIds.slice(0, 1);
  const styleIds = styleRec.modelIds.slice(0, 1);
  if (!draftIds.length) {
    return { ok: false, stage: "recommend", message: "没有可推荐的正文模型。" };
  }

  const root = projectDir && String(projectDir).trim()
    ? path.resolve(projectDir)
    : await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-live-smoke-"));
  await fsp.mkdir(path.join(root, "辅助文档"), { recursive: true });
  await fsp.mkdir(path.join(root, "Codex候选"), { recursive: true });
  await fsp.mkdir(path.join(root, "细纲"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "细纲", "01_当前章细纲.md"),
    "# 冒烟控制卡\n\n冲突：门口有人压军报。\n钩子：第二份军报到了。\n",
    "utf8"
  );

  let generated;
  try {
    generated = await generateToArtifact({
      gateway,
      projectDir: root,
      kind: "live_smoke_draft",
      title,
      chapterNo: "0",
      modelIds: draftIds,
      system: "你是中文网文主笔。只输出标题行和短正文，不要自检。",
      prompt: [
        "写一段不超过 400 字的开场。",
        "第一行：标题：冒烟开场",
        "第二行起正文。",
        "场景：雨夜辕门，主角追问谁压了军报。",
        "不要解释腔，不要“这意味着”。"
      ].join("\n"),
      taskLabel: "live-smoke",
      fallbackChain: true,
      applyHardGates: true,
      minChars: 40
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

  let optimized = null;
  if (styleIds.length) {
    try {
      optimized = await optimizeWithModels({
        gateway,
        projectDir: root,
        draftText: bodyRead.content,
        title,
        chapterNo: "0",
        modelIds: styleIds,
        mode: "humanize",
        focus: "dialogue",
        instruction: "去解释腔，保留冲突。",
        autoRecommend: false
      });
    } catch (error) {
      optimized = {
        ok: false,
        message: "优化失败（草稿已成功）：" + String(error && (error.message || error))
      };
    }
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
    styleModelIds: styleIds,
    draft: {
      artifact: generated.artifact,
      transport: generated.transport,
      attempt: generated.attempt,
      degraded: generated.degraded,
      preview: String(bodyRead.content).slice(0, 280),
      modelReadable: true
    },
    optimize: optimized,
    coach: "实网冒烟通过：模型列表 → 流式/回退写 txt → 可读 .body → 可选优化。作者确认前仍不入正式正文。"
  };
}

module.exports = { smokeLiveGateway };
