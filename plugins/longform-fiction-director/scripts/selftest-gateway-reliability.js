"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createGatewayClient } = require("../server/gateway-client");
const {
  createFakeIpAwareFetch,
  isClashFakeIpv4,
  selectPhysicalIpv4
} = require("../server/fake-ip-aware-fetch");
const { createOpenAiCompatibleGateway } = require("../server/openai-compatible-gateway");
const { generateToArtifact } = require("../server/artifact-pipeline");

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function sseResponse(content, { failAfterContent = false } = {}) {
  const encoder = new TextEncoder();
  let step = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (step === 0) {
        step += 1;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        return;
      }
      if (failAfterContent) {
        controller.error(new TypeError("upstream stream terminated"));
        return;
      }
      if (step === 1) {
        step += 1;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
        return;
      }
      controller.close();
    }
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
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
  let catalogCalls = 0;
  const client = createGatewayClient({
    baseUrl: "http://127.0.0.1:43210",
    allowInsecureLoopback: true,
    sessionStore: sessionStore(),
    generationRetryBaseDelayMs: 0,
    fetch: async (url) => {
      if (String(url).endsWith("/api/models")) {
        catalogCalls += 1;
        throw new TypeError("catalog unavailable");
      }
      if (String(url).endsWith("/e/catalog/chat/completions")) {
        generationCalls += 1;
        if (typeof failure === "function") return failure();
        return failure;
      }
      throw new Error("unexpected request: " + url);
    }
  });
  return { client, generationCalls: () => generationCalls, catalogCalls: () => catalogCalls };
}

async function expectCode(promise, code) {
  let caught = null;
  try { await promise; } catch (error) { caught = error; }
  assert.ok(caught, "expected call to fail");
  assert.strictEqual(caught.code, code);
  return caught;
}

async function main() {
  assert.strictEqual(isClashFakeIpv4("198.18.0.223"), true, "Clash fake IPv4 range was not detected");
  assert.strictEqual(isClashFakeIpv4("198.19.255.254"), true, "upper Clash fake IPv4 range was not detected");
  assert.strictEqual(isClashFakeIpv4("64.83.20.231"), false, "public gateway address was mislabeled as fake");
  assert.strictEqual(selectPhysicalIpv4({
    Clash: [{ family: "IPv4", internal: false, address: "198.18.0.1" }],
    Docker: [{ family: "IPv4", internal: false, address: "172.20.0.1" }],
    WiFi: [{ family: "IPv4", internal: false, address: "192.168.1.16" }]
  }), "192.168.1.16", "physical interface selection preferred a virtual adapter");

  let baseFetchCalls = 0;
  let directFetchCalls = 0;
  const fakeAware = createFakeIpAwareFetch({
    baseFetch: async () => { baseFetchCalls += 1; return jsonResponse({ ok: true }); },
    lookup: async () => [{ address: "198.18.0.223", family: 4 }],
    resolveAddress: async () => "64.83.20.231",
    directFetch: async (_input, _init, route) => {
      directFetchCalls += 1;
      assert.strictEqual(route.address, "64.83.20.231", "resolved real gateway address was not used");
      assert.strictEqual(route.localAddress, "192.168.1.16", "physical interface was not bound");
      return jsonResponse({ ok: true });
    },
    localAddress: "192.168.1.16"
  });
  await fakeAware("https://api.nanshanyougui.xyz/healthz");
  assert.strictEqual(directFetchCalls, 1, "fake-IP gateway did not use direct HTTPS");
  assert.strictEqual(baseFetchCalls, 0, "fake-IP gateway attempted the broken system route first");

  const normalAware = createFakeIpAwareFetch({
    baseFetch: async () => { baseFetchCalls += 1; return jsonResponse({ ok: true }); },
    lookup: async () => [{ address: "64.83.20.231", family: 4 }],
    directFetch: async () => { throw new Error("normal DNS unexpectedly used direct route"); }
  });
  await normalAware("https://api.nanshanyougui.xyz/healthz");
  assert.strictEqual(baseFetchCalls, 1, "normal DNS did not keep the standard fetch path");

  const upstream502 = clientWithModelFailure(jsonResponse({ ok: false, message: "所有上游均失败：上游请求超时" }, 502));
  await expectCode(upstream502.client.callModels({
    prompt: "写一章长文",
    modelIds: ["claude-opus-5"],
    streamRetries: 4
  }), "UPSTREAM_TIMEOUT");
  assert.strictEqual(upstream502.generationCalls(), 1, "502 timeout resubmitted the long task");
  assert.strictEqual(upstream502.catalogCalls(), 0, "model catalog blocked a real generation request");

  const generic502 = clientWithModelFailure(jsonResponse({ ok: false, message: "upstream connection failed" }, 502));
  await expectCode(generic502.client.callModels({
    prompt: "写一章长文",
    modelIds: ["claude-opus-5"],
    streamRetries: 4
  }), "SERVER_ERROR");
  assert.strictEqual(generic502.generationCalls(), 1, "generic 502 replayed a potentially completed long task");

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

  const busy = clientWithModelFailure(() => jsonResponse({ ok: false, message: "upstream temporarily busy" }, 503));
  await expectCode(busy.client.callModels({
    prompt: "写一章长文",
    modelIds: ["claude-opus-5"],
    streamRetries: 4
  }), "SERVER_ERROR");
  assert.strictEqual(busy.generationCalls(), 2, "clear pre-output 503 did not receive one bounded retry");

  const partial = clientWithModelFailure(() => sseResponse("雨打在辕门上。军报只剩半页。", { failAfterContent: true }));
  const partialResult = await partial.client.callModels({
    prompt: "写一章长文",
    modelIds: ["claude-opus-5"],
    streamRetries: 2
  });
  assert.ok(partialResult.content.includes("军报只剩半页"), "partial stream prose was discarded");
  assert.match(partialResult.outputs[0].transport, /^partial_stream_attempt_/u);
  assert.strictEqual(partial.generationCalls(), 1, "partial stream was incorrectly resubmitted");

  let directCatalogCalls = 0;
  let directGenerationCalls = 0;
  const direct = createOpenAiCompatibleGateway({
    baseUrl: "http://127.0.0.1:43211",
    apiKey: "test-direct-key",
    allowedModels: ["claude-opus-5"],
    generationRetryBaseDelayMs: 0,
    sessionStore: sessionStore(),
    fetch: async (url, init) => {
      if (String(url).endsWith("/v1/models")) {
        directCatalogCalls += 1;
        throw new TypeError("catalog unavailable");
      }
      if (String(url).endsWith("/v1/chat/completions") && init?.method === "POST") {
        directGenerationCalls += 1;
        return sseResponse("门外有人，把第二封军报递了进来。");
      }
      throw new Error("unexpected direct request: " + url);
    }
  });
  const directResult = await direct.callModels({ prompt: "继续写", modelIds: ["claude-opus-5"] });
  assert.ok(directResult.content.includes("第二封军报"), "direct model generation failed");
  assert.strictEqual(directResult.outputs[0].finishReason, "stop", "direct gateway discarded upstream finish reason");
  assert.strictEqual(directCatalogCalls, 0, "direct model catalog blocked generation");
  assert.strictEqual(directGenerationCalls, 1, "direct generation request count mismatch");

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
    assert.ok(fs.readFileSync(result.artifact.path, "utf8").includes("\n---\n\n灯亮着"), "artifact header separator is not readable");

    const longChapter = "长夜未明，营门外又有人踩过积雪。\n".repeat(1200);
    const longResult = await generateToArtifact({
      gateway: {
        async callModels(input) {
          return { content: longChapter, model: input.modelIds[0], transport: "test-long" };
        }
      },
      projectDir,
      prompt: "写一章完整长文",
      modelIds: ["claude-opus-5"],
      previewChars: 120,
      applyHardGates: false
    });
    assert.strictEqual(fs.readFileSync(longResult.artifact.plainPath, "utf8"), longChapter, "long plain-text artifact was truncated or altered");
    assert.ok(fs.readFileSync(longResult.artifact.path, "utf8").endsWith(longChapter), "long headed artifact was truncated");
    assert.ok(longResult.preview.length <= 120, "preview limit leaked into full long-form storage");

    const reasoningLeak = await generateToArtifact({
      gateway: {
        async callModels(input) {
          return {
            content: "帐外有人敲了一下梆子。\n<thinking>这里应该制造一次冲突来推进剧情。</thinking>\n卢象升没有抬头。",
            model: input.modelIds[0],
            transport: "test-reasoning-leak"
          };
        }
      },
      projectDir,
      prompt: "写一段正文",
      modelIds: ["claude-sonnet-5"],
      applyHardGates: false
    });
    const cleanedReasoningLeak = fs.readFileSync(reasoningLeak.artifact.plainPath, "utf8");
    assert.ok(cleanedReasoningLeak.includes("帐外有人") && cleanedReasoningLeak.includes("卢象升没有抬头"), "reasoning cleanup dropped surrounding prose");
    assert.ok(!cleanedReasoningLeak.includes("thinking") && !cleanedReasoningLeak.includes("推进剧情"), "internal reasoning leaked into candidate prose");
    assert.strictEqual(reasoningLeak.reasoningBlocksRemoved, 1, "reasoning cleanup count mismatch");

    const lowQuality = await generateToArtifact({
      gateway: { async callModels() { return { content: "灯灭了。", model: "claude-opus-5", transport: "test" }; } },
      projectDir,
      prompt: "写一章测试",
      modelIds: ["claude-opus-5"],
      minChars: 3000,
      applyHardGates: true
    });
    assert.strictEqual(lowQuality.ok, true, "quality warning blocked artifact persistence");
    assert.strictEqual(lowQuality.hardGate.ok, false, "quality warning was not reported");
    assert.strictEqual(lowQuality.partial, false, "complete short prose was mislabeled as interrupted");
    assert.ok(fs.existsSync(lowQuality.artifact.plainPath), "low-quality nonempty prose was not saved");

    const falseComplete = await generateToArtifact({
      gateway: {
        async callModels(input) {
          return {
            content: "卢象升把表文压在砚台下，案上还有那半封没写完",
            model: input.modelIds[0],
            finishReason: "stop",
            transport: "stream_attempt_1"
          };
        }
      },
      projectDir,
      prompt: "写一章长文",
      modelIds: ["claude-opus-4-6"],
      minChars: 3000,
      applyHardGates: false
    });
    assert.strictEqual(falseComplete.ok, true, "abrupt prose was not preserved");
    assert.strictEqual(falseComplete.partial, true, "upstream stop with an unfinished sentence was mislabeled as complete");
    assert.strictEqual(falseComplete.abruptEnding, true, "abrupt ending evidence was not surfaced");
    assert.strictEqual(falseComplete.finishReason, "stop", "artifact result lost upstream finish reason");
    assert.ok(falseComplete.coach.includes("不算完整章"), "coach claimed an abrupt segment was a complete chapter");
    assert.ok(fs.readFileSync(falseComplete.artifact.path, "utf8").includes('"abruptEnding":true'), "artifact metadata lost abrupt-ending evidence");
    assert.ok(fs.readFileSync(falseComplete.artifact.path, "utf8").includes('"finishReason":"stop"'), "artifact metadata lost upstream finish reason");

    const interrupted = await generateToArtifact({
      gateway: {
        async callModels() {
          const error = Object.assign(new Error("stream interrupted"), {
            code: "SERVER_OFFLINE",
            partialContent: "主将拆开湿透的军报，只读了第一行。"
          });
          throw error;
        }
      },
      projectDir,
      prompt: "写一章测试",
      modelIds: ["claude-opus-5"],
      applyHardGates: true
    });
    assert.strictEqual(interrupted.ok, true, "pipeline discarded gateway partial prose");
    assert.ok(fs.readFileSync(interrupted.artifact.plainPath, "utf8").includes("只读了第一行"), "partial prose txt is unreadable");
    assert.strictEqual(interrupted.artifact.recordedForMemory, true, "partial prose was not indexed in writing history");

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

  console.log("PASS selftest-gateway-reliability: no health precheck, bounded retry, partial preservation, txt persistence");
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  process.exit(1);
});
