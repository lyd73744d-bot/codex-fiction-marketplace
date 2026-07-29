"use strict";

const path = require("node:path");
const onboarding = require("../server/onboarding-state");

async function main() {
  const pluginRoot = path.resolve(__dirname, "..");
  process.chdir(pluginRoot);

  const state = await onboarding.markPackageInstalled();
  console.log("[onboarding] installation recorded");
  console.log("[onboarding] state =", onboarding.defaultStatePath());
  console.log("[onboarding] 网关为可选增强：安装和普通写作不会打开登录页。");
  console.log("[onboarding] Codex 可直接完成引导、研究、工程、控制卡和验收；正文默认交给作者当次同意的写作模型。");
  console.log("[onboarding] 每次调用其他模型前都询问；当次选择使用才调用，首次使用永久保存网关绑定。");
  console.log("[onboarding] gateway pending =", !!state.pendingFirstLogin);
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exitCode = 1;
});
