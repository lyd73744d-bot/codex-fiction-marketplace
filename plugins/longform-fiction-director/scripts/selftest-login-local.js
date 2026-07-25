"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { createRuntime } = require("../server/mcp-server");
const { writeArtifact } = require("../server/artifact-pipeline");

async function main() {
  const runtime = createRuntime();
  const names = runtime.tools.list().map((t) => t.name);
  for (const n of ["fiction_open_gateway_login", "fiction_account_status", "fiction_write_local_candidate", "fiction_ensure_gateway"]) {
    assert.ok(names.includes(n), "missing " + n);
  }
  const acct = await runtime.tools.call("fiction_account_status", {});
  const acctPayload = JSON.parse(acct.content[0].text);
  assert.equal(typeof acctPayload.loggedIn, "boolean");

  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-local-"));
  const local = await runtime.tools.call("fiction_write_local_candidate", {
    projectDir: proj,
    title: "本地候选",
    chapterNo: "1",
    content: "他说：“先守住。”\n门开了。"
  });
  const localPayload = JSON.parse(local.content[0].text);
  assert.equal(localPayload.ok, true);
  assert.ok(localPayload.artifact.plainPath);

  // open login should not throw
  const login = await runtime.tools.call("fiction_open_gateway_login", {});
  const loginPayload = JSON.parse(login.content[0].text);
  assert.ok("popupOpened" in loginPayload || "loginUrl" in loginPayload || "message" in loginPayload);

  console.log("login+local candidate selftest: PASS");
  console.log(JSON.stringify({
    loggedIn: acctPayload.loggedIn,
    localPlain: !!localPayload.artifact.plainPath,
    loginReason: loginPayload.reason || null,
    popupOpened: loginPayload.popupOpened,
    toolCount: names.length
  }, null, 2));
  // login page servers are unref'd; force exit so verify-all doesn't hang/crash on stray requests
  setTimeout(() => process.exit(0), 50);
}

main().catch((e) => { console.error(e); process.exit(1); });
