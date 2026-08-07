"use strict";

const path = require("node:path");
const onboarding = require("../server/onboarding-state");

async function main() {
  const pluginRoot = path.resolve(__dirname, "..");
  process.chdir(pluginRoot);

  const state = await onboarding.markPackageInstalled();
  console.log("[onboarding] installation recorded");
  console.log("[onboarding] state =", onboarding.defaultStatePath());
  console.log("[onboarding] 首次初始化会打开绑定页；完成登录或注册后才能调用外部写作模型。");
  console.log("[onboarding] 本地引导、研究、工程、必要的章节构思和验收仍可继续；正文默认交给作者当次同意的写作模型。");
  console.log("[onboarding] 每次调用前展示模型费率和余额，调用后核对余额变化；绑定不等于自动授权。");
  console.log("[onboarding] gateway pending =", !!state.pendingFirstLogin);
}

main().catch((error) => {
  console.error(error && (error.stack || error.message || error));
  process.exitCode = 1;
});
