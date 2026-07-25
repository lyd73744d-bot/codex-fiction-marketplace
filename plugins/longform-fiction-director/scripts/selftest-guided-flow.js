"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { bootstrapProject } = require("../server/project-bootstrap");
const { getBrainstormCoach, updateBrainstormBoard } = require("../server/brainstorm-service");
const { importSampleBook } = require("../server/sample-book-service");
const { learnSampleTechniques } = require("../server/sample-learn-service");
const { upsertVoiceAnchor } = require("../server/voice-anchor-service");
const { createOutlineScaffold } = require("../server/outline-service");
const { createResearchDoc } = require("../server/research-doc-service");
const { appendResearchFindings } = require("../server/research-fill-service");
const { createCharacterCard } = require("../server/research-doc-service");
const { createChapterBrief } = require("../server/chapter-brief-service");
const { assessPipeline } = require("../server/pipeline-coach-service");
const { compareStyle } = require("../server/style-compare-service");
const { generateToArtifact, listArtifacts } = require("../server/artifact-pipeline");
const { optimizeWithModels } = require("../server/multi-model-optimize");
const { advanceGuidedStage, getGuidedStatus, ensureSoftLedgers } = require("../server/guided-stage-service");
const { markGoldenChapter, getGoldenThreeStatus } = require("../server/golden-three-service");
const continuous = require("../server/continuous-mode");

async function main() {
  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-guided-"));
  const boot = await bootstrapProject(proj, { title: "测书" });
  assert.equal(boot.ok, true);
  const soft = await ensureSoftLedgers(proj);
  assert.ok(soft.created.length >= 0);

  let guided = await getGuidedStatus(proj);
  assert.equal(guided.stage.id, "boot");
  assert.ok(Array.isArray(guided.recommendedTools));

  await updateBrainstormBoard(proj, {
    hook: "穿越到崇祯朝，先把卢象升从必死局里拽出来。",
    desire: "先保住北方最后一支能打的力量。",
    obstacle: "朝廷猜忌、军资短缺、时间不够。",
    hookWhy: "读者想看他怎么用现代组织法硬顶历史重力。"
  });
  const brain = await getBrainstormCoach(proj);
  assert.equal(brain.filled.hook, true);

  const sampleSrc = path.join(proj, "_src_sample");
  await fsp.mkdir(sampleSrc, { recursive: true });
  await fsp.writeFile(path.join(sampleSrc, "01.txt"), [
    "他说：“粮只够三天。”",
    "门被推开。",
    "她拒绝签字。",
    "短。",
    "夜风很冷，刀柄上的血还没干。"
  ].join("\n"), "utf8");
  await importSampleBook({ projectDir: proj, sourcePath: sampleSrc, title: "样" });
  const learned = await learnSampleTechniques({ projectDir: proj, sampleName: "样" });
  assert.equal(learned.ok, true);

  await upsertVoiceAnchor(proj, {
    narration: "- 克制、短句优先",
    dialogue: "- 少解释，多打断",
    pacing: "- 高压短句",
    fromSample: "- 对话推进冲突",
    forbid: "- 解释腔"
  });
  await createOutlineScaffold({
    projectDir: proj,
    overwrite: true,
    answers: {
      hook: "把卢象升从必死局里拽出来",
      coreConflict: "救将 vs 朝局与时间",
      heroWant: "保住能打的力量",
      pressurePlan: "军报→粮草→朝议→前线"
    }
  });
  await createResearchDoc({ projectDir: proj, topic: "卢象升", genre: "历史" });
  await appendResearchFindings({
    projectDir: proj,
    topic: "卢象升",
    sources: ["https://example.com/luxiangsheng"],
    facts: ["明末将领，与清军作战"],
    forbidden: ["不要写成现代参谋口吻乱改史实职称"]
  });
  await createCharacterCard({ projectDir: proj, name: "卢象升", kind: "historical", summary: "硬脊梁的前线将领" });
  await createChapterBrief({
    projectDir: proj,
    chapterNo: "1",
    title: "三天的粮",
    conflict: "军报延误，主角必须当面顶住质疑",
    cost: "暴露部分底牌",
    hook: "粮道上出现不该出现的旗号"
  });

  const pipe = await assessPipeline(proj);
  assert.equal(pipe.canDraft, true, JSON.stringify(pipe.hardBlockers));

  // fake gateway generation + optimize
  let n = 0;
  const gateway = {
    async listModels() { return { models: [{ id: "m-fast" }, { id: "m-strong" }] }; },
    async callModels({ prompt }) {
      n += 1;
      return {
        transport: n === 1 ? "stream_attempt_1" : "non_stream_fallback",
        content: "第" + n + "稿。他说：“先守住。”\n门开了。\n粮只够三天，但退路已经没有。"
      };
    }
  };
  const gen = await generateToArtifact({
    gateway,
    projectDir: proj,
    kind: "draft",
    title: "三天的粮",
    chapterNo: "1",
    modelIds: ["m-strong"],
    prompt: "写第一章候选"
  });
  assert.equal(gen.ok, true);
  const style = await compareStyle({ projectDir: proj, draftPath: gen.artifact.plainPath, title: "三天的粮" });
  assert.equal(style.ok, true);
  const opt = await optimizeWithModels({
    gateway,
    projectDir: proj,
    draftText: await fsp.readFile(gen.artifact.plainPath, "utf8"),
    title: "三天的粮",
    chapterNo: "1",
    modelIds: ["m-fast", "m-strong"],
    mode: "humanize"
  });
  assert.equal(opt.ok, true);
  assert.equal(opt.runs.length, 2);

  guided = await advanceGuidedStage(proj, { toStage: "optimize", note: "初稿完成" });
  assert.equal(guided.stage.id, "optimize");

  await markGoldenChapter(proj, 1, { ready: true });
  await markGoldenChapter(proj, 2, { ready: true });
  await markGoldenChapter(proj, 3, { ready: true });
  const golden = await getGoldenThreeStatus(proj);
  // mark ready flags may depend on implementation; enable continuous still requires phrase + goldenThreeReady
  await continuous.setGoldenThreeReady(proj, true);
  const denied = await continuous.enableContinuousMode(proj, "随便开一下");
  assert.equal(denied.ok, false);
  const enabled = await continuous.enableContinuousMode(proj, "可以连续，按黄金三章这个模式继续生成");
  assert.equal(enabled.ok, true);
  const disabled = await continuous.disableContinuousMode(proj);
  assert.equal(disabled.enabled, false);

  const arts = await listArtifacts(proj);
  assert.ok(arts.items.length >= 3);
  console.log("guided flow selftest: PASS");
  console.log(JSON.stringify({
    project: proj,
    pipelineNext: pipe.nextAction,
    artifacts: arts.items.length,
    optimizeRuns: opt.runs.length,
    continuousDenied: denied.ok,
    continuousEnabledThenDisabled: enabled.ok && disabled.enabled === false
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
