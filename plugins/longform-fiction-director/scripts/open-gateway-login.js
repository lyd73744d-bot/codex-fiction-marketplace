const path = require("path");
const fs = require("fs");
const root = process.argv[2] || path.resolve(__dirname, "..");
process.chdir(root);
const mcpMod = require(path.join(root, "server", "mcp-server.js"));
const createRuntime = mcpMod.createRuntime || mcpMod.createQualityRuntime;
const logPath = process.env.LFD_LOGIN_LOG || path.join(require("os").tmpdir(), "lfd-gateway-login.log");
const urlFile = process.env.LFD_LOGIN_URL_FILE || path.join(require("os").tmpdir(), "lfd-gateway-login-url.txt");
const pidFile = process.env.LFD_LOGIN_PID_FILE || path.join(require("os").tmpdir(), "lfd-login-pid.txt");
function log(msg) {
  const line = new Date().toISOString() + " " + msg + "\n";
  try { fs.appendFileSync(logPath, line); } catch {}
  console.log(msg);
}
process.on("uncaughtException", (error) => {
  log("UNCAUGHT " + (error.stack || error.message));
});
process.on("unhandledRejection", (error) => {
  log("UNHANDLED " + (error && (error.stack || error.message) || error));
});
(async () => {
  fs.writeFileSync(pidFile, String(process.pid));
  const runtime = createRuntime();
  const result = await runtime.tools.call("fiction_open_gateway_login", {});
  const payload = JSON.parse(result.content[0].text);
  const loginUrl = payload.loginUrl || payload.url || "";
  fs.writeFileSync(urlFile, loginUrl + "\n");
  log("LOGIN_URL " + loginUrl);
  log("PAYLOAD " + JSON.stringify({ reason: payload.reason, popupOpened: payload.popupOpened, shopUrl: payload.shopUrl }));
  log("PID " + process.pid);
  const account = JSON.parse((await runtime.tools.call("fiction_account_status", {})).content[0].text);
  log("ACCOUNT_BEFORE " + JSON.stringify(account));
  // keep process referenced
  setInterval(() => {}, 60_000);
  for (let i = 0; i < 720; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      const status = JSON.parse((await runtime.tools.call("fiction_quality_account_status", {})).content[0].text);
      log("ACCOUNT " + JSON.stringify(status));
      const page = await fetch(String(payload.url).replace(/\/$/, "") + "/api/status").then((r) => r.json());
      log("PAGE loggedIn=" + page.loggedIn + " models=" + (page.models || []).length);
    } catch (error) {
      log("POLL_ERR " + (error.message || error));
    }
  }
  log("DONE");
})().catch((error) => {
  log("FATAL " + (error.stack || error.message));
  process.exit(1);
});
