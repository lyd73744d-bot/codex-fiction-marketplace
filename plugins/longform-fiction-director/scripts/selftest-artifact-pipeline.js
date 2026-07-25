"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { extractModelPayload, writeArtifact, readArtifact, generateToArtifact, listArtifacts } = require("../server/artifact-pipeline");
const { assessPipeline } = require("../server/pipeline-coach-service");
const { learnSampleTechniques } = require("../server/sample-learn-service");
const { importSampleBook } = require("../server/sample-book-service");
const { appendResearchFindings } = require("../server/research-fill-service");
const { createCharacterCard } = require("../server/research-doc-service");

async function main() {
  const extracted = extractModelPayload({ transport: "stream_attempt_2", outputs: [{ model: "m1", content: "你好，这是完整正文。" }] }, "fallback");
  assert.equal(extracted.content.includes("完整正文"), true);
  assert.equal(extracted.modelId, "m1");
  assert.match(extracted.transport, /stream/);

  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-art-"));
  const saved = await writeArtifact({ projectDir: dir, kind: "draft", title: "测", content: "第一段。\n第二段。", modelId: "local" });
  assert.ok(saved.plainPath);
  const read = await readArtifact(saved.path);
  assert.equal(read.modelReadable, true);
  assert.match(read.content, /第一段/);

  let calls = 0;
  const gateway = {
    async callModels() {
      calls += 1;
      if (calls === 1) return { transport: "stream_attempt_1", content: "   " };
      return { transport: "non_stream_fallback", content: "重试后的完整章节正文，足够长了。" };
    }
  };
  const gen = await generateToArtifact({ gateway, projectDir: dir, kind: "draft", title: "重试", modelIds: ["x"], prompt: "写一章", streamRetries: 2, outerAttempts: 2 });
  assert.equal(gen.ok, true);
  assert.equal(gen.attempt, 2);
  assert.ok(gen.artifact.plainPath);

  // guided pipeline smoke (historical hard research gate)
  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-pipe-"));
  const aux = path.join(proj, "辅助文档");
  await fsp.mkdir(path.join(proj, "细纲"), { recursive: true });
  await fsp.mkdir(path.join(aux, "人物卡"), { recursive: true });
  await fsp.mkdir(path.join(aux, "联网核验"), { recursive: true });
  await fsp.writeFile(path.join(aux, "09_脑洞板.md"), "# 脑洞\n\n- 核心：穿越到崇祯朝，先保卢象升。\n", "utf8");
  await fsp.writeFile(path.join(proj, "细纲", "01_当前章细纲.md"), "# 细纲\n\n本章冲突：军报延误，主角必须当面顶住。\n", "utf8");
  const sampleSrc = path.join(proj, "_src");
  await fsp.mkdir(sampleSrc, { recursive: true });
  await fsp.writeFile(path.join(sampleSrc, "c01.txt"), "他说：“退无可退。”\n忽然门开。\n短。\n", "utf8");
  await importSampleBook({ projectDir: proj, sourcePath: sampleSrc, title: "样" });
  await learnSampleTechniques({ projectDir: proj });
  await fsp.writeFile(path.join(aux, "08_文风锚点.md"), "短句，少解释，动作优先，拒绝套话。\n", "utf8");
  await fsp.writeFile(path.join(aux, "01_全书大纲.md"), "卷一：立住人物，历史压力升级，不写空口号。\n", "utf8");
  await appendResearchFindings({
    projectDir: proj,
    topic: "卢象升",
    sources: ["https://example.com/luxiangsheng"],
    facts: ["明末将领，官至兵部尚书"],
    forbidden: ["不可写成现代军官"],
    fictionBounds: ["私人对话可虚构"]
  });
  await createCharacterCard({ projectDir: proj, name: "卢象升", kind: "historical", summary: "明末名将" });
  const pipe = await assessPipeline(proj);
  assert.equal(pipe.historicalLikely, true);
  assert.equal(pipe.canDraft, true, JSON.stringify(pipe.hardBlockers));
  assert.equal(pipe.checks.find((c) => c.id === "research_filled").ok, true);
  assert.equal(pipe.checks.find((c) => c.id === "fact_library").ok, true);

  const listed = await listArtifacts(dir);
  assert.ok(listed.items.length >= 1);
  console.log("artifact+pipeline selftest: PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
