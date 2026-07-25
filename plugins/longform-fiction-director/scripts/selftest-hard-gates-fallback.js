"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { inspectChapter, isAcceptableCandidate } = require("../server/writing-hard-gates");
const { runModelFallback } = require("../server/model-fallback-runner");
const { coachForChapter } = require("../server/golden-three-coach");
const { generateToArtifact } = require("../server/artifact-pipeline");

async function main() {
  // hard gates
  const good = inspectChapter("夜色压得很低。他把刀收回鞘里，只说：走。门外雨声忽然密了一拍。");
  assert.equal(good.ok, true);
  const leak = isAcceptableCandidate("检查说明：本章合格。\n\n夜色压得很低。");
  assert.equal(leak.ok, false);
  assert.ok(leak.blockers.some((b) => b.rule === "non-chapter-output" || b.rule === "visible-process-leak"));
  const empty = isAcceptableCandidate("   ");
  assert.equal(empty.ok, false);

  // fallback runner
  const fb = await runModelFallback({
    modelIds: ["bad", "good"],
    callModel: async ({ modelId }) => {
      if (modelId === "bad") throw new Error("fail");
      return "他抬眼，把账本合上。外面锣声近了。";
    }
  });
  assert.equal(fb.acceptedModelId, "good");
  assert.equal(fb.degraded, true);

  // chapter coach
  const c1 = coachForChapter(1);
  assert.equal(c1.stage, "绑定");
  const c4 = coachForChapter(4);
  assert.equal(c4.stage, "续航");

  // generateToArtifact with mock gateway + fallback
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-fb-"));
  const gateway = {
    async callModels({ modelIds }) {
      const model = modelIds[0];
      if (model === "m1") {
        return { outputs: [{ model, content: "检查说明：不行", transport: "stream_attempt_1" }] };
      }
      return {
        outputs: [{
          model,
          content: "巷口的油灯跳了一下。他把铜钱按在桌上，声音很平：今晚不赊。店小二没敢接话。",
          transport: "stream_attempt_1"
        }]
      };
    }
  };
  const result = await generateToArtifact({
    gateway,
    projectDir: dir,
    prompt: "写一段开场",
    modelIds: ["m1", "m2"],
    kind: "draft_test",
    fallbackChain: true,
    applyHardGates: true
  });
  assert.equal(result.ok, true);
  assert.equal(result.modelId, "m2");
  assert.equal(result.degraded, true);
  assert.ok(result.artifact.plainPath);
  const body = await fsp.readFile(result.artifact.plainPath, "utf8");
  assert.ok(body.includes("铜钱"));
  assert.ok(!body.includes("检查说明"));

  console.log("hard-gates+fallback+coach: PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
