"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGatewayClient } = require("../server/gateway-client");
const { generateToArtifact } = require("../server/artifact-pipeline");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function sessionStore() {
  let value = {
    accessToken: "test-access",
    refreshToken: "test-refresh",
    user: { username: "reliability-test", active: true, balance: 100 }
  };
  return {
    async read() { return value; },
    async save(next) { value = next; return next; },
    async clear() { value = null; }
  };
}

function clientWithModelFailure(failure) {
  let generationCalls = 0;
  const client = createGatewayClient({
    baseUrl: "http://127.0.0.1:43210",
    allowInsecureLoopback: true,
    sessionStore: sessionStore(),
    fetch: async (url) => {
      if (String(url).endsWith("/api/models")) {
        return jsonResponse({ data: [{ id: "claude-opus-5", available: true }] });
      }
      if (String(url).endsWith("/e/catalog/chat/completions")) {
        generationCalls += 1;
        if (typeof failure === "function") return failure();
        return failure;
      }
      throw new Error("unexpected request: " + url);
    }
  });
  return { client, generationCalls: () => generationCalls };
}

async function expectCode(promise, code) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, "expected call to fail");
  assert.strictEqual(caught.code, code);
  return caught;
}

async function main() {
  const upstream502 = clientWithModelFailure(jsonResponse({ ok: false, message: "所有上游均失败：上游请求超时" }, 502));
  await expectCode(upstream502.client.callModels({
    prompt: "写一章长文",
    modelIds: ["claude-opus-5"],
    streamRetries: 4
  }), "UPSTREAM_TIMEOUT");
  assert.strictEqual(upstream502.generationCalls(), 1, "502 timeout resubmitted the long task");

  const localTimeout = clientWithModelFailure(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  await expectCode(localTimeout.client.callModels({
    prompt: "写一章长文",
    modelIds: ["claude-opus-5"],
    streamRetries: 4
  }), "UPSTREAM_TIMEOUT");
  assert.strictEqual(localTimeout.generationCalls(), 1, "client timeout resubmitted the long task");

  const offline = clientWithModelFailure(() => { throw new TypeError("fetch failed"); });
  await expectCode(offline.client.callModels({
    prompt: "写一章长文",
    modelIds: ["claude-opus-5"],
    streamRetries: 1
  }), "SERVER_OFFLINE");
  assert.strictEqual(offline.generationCalls(), 1, "offline request count mismatch");

  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "zizhuji-reliability-"));
  const forwarded = [];
  try {
    const result = await generateToArtifact({
      gateway: {
        async callModels(input) {
          forwarded.push(input);
          return { content: "灯亮着。门外的人没有进来，只把信压在门缝下。", model: input.modelIds[0], transport: "test" };
        }
      },
      projectDir,
      prompt: "写一段测试",
      modelIds: ["claude-opus-5"],
      maxTokens: 4096,
      streamRetries: 4,
      outerAttempts: 3,
      applyHardGates: false
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(forwarded.length, 1, "artifact pipeline duplicated a successful request");
    assert.strictEqual(forwarded[0].maxTokens, 4096, "maxTokens was not forwarded");
    assert.strictEqual(forwarded[0].streamRetries, 2, "stream retry clamp mismatch");

    let failedCalls = 0;
    const timeoutError = Object.assign(new Error("model timeout"), { code: "UPSTREAM_TIMEOUT" });
    await expectCode(generateToArtifact({
      gateway: { async callModels() { failedCalls += 1; throw timeoutError; } },
      projectDir,
      prompt: "写一章测试",
      modelIds: ["claude-opus-5"],
      streamRetries: 4,
      outerAttempts: 3,
      applyHardGates: false
    }), "UPSTREAM_TIMEOUT");
    assert.strictEqual(failedCalls, 1, "artifact pipeline repeated a timed-out request");
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }

  console.log("PASS selftest-gateway-reliability: timeout classification, single submit, maxTokens forwarding");
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  process.exit(1);
});
