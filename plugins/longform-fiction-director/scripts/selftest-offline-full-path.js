"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { ensureSoftLedgers, advanceGuidedStage, getGuidedStatus } = require("../server/guided-stage-service");
const { updateBrainstormBoard } = require("../server/brainstorm-service");
const { importSampleBook } = require("../server/sample-book-service");
const { learnSampleTechniques } = require("../server/sample-learn-service");
const { upsertVoiceAnchor } = require("../server/voice-anchor-service");
const { createOutlineScaffold } = require("../server/outline-service");
const { planResearch } = require("../server/research-plan-service");
const { appendResearchFindings } = require("../server/research-fill-service");
const { createCharacterCard } = require("../server/research-doc-service");
const { createChapterBrief } = require("../server/chapter-brief-service");
const { buildDraftPacket } = require("../server/draft-coach-service");
const { writeArtifact } = require("../server/artifact-pipeline");
const { compareStyle } = require("../server/style-compare-service");
const { upsertSoftChapterLedger, checkChapterContinuity } = require("../server/soft-chapter-ledger");
const { assessPipeline } = require("../server/pipeline-coach-service");
const { getChapterCoach } = require("../server/golden-three-service");
const { looksLikeExplicitEnable } = require("../server/continuous-mode");

async function main() {
  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-e2e-"));
  await ensureSoftLedgers(proj);

  await updateBrainstormBoard(proj, {
    hook: "穿越到崇祯朝，先保住卢象升",
    desire: "活下去并改写军报延误",
    obstacle: "朝堂猜忌与前线失联",
    hookWhy: "第一次兑现必须是可感的军情改写",
    questions: "卢象升史实边界？虚构权限？"
  });

  const sampleSrc = path.join(proj, "_sample_src");
  await fsp.mkdir(sampleSrc, { recursive: true });
  await fsp.writeFile(path.join(sampleSrc, "c01.txt"), "他只说：退无可退。\n门被推开。\n账本落在桌上。\n", "utf8");
  await fsp.writeFile(path.join(sampleSrc, "c02.txt"), "雨还在下。\n他问：谁改过军报？\n无人应答。\n", "utf8");
  await importSampleBook({ projectDir: proj, sourcePath: sampleSrc, title: "样书A" });
  await learnSampleTechniques({ projectDir: proj });

  await upsertVoiceAnchor(proj, {
    narration: "冷硬短句，少解释",
    dialogue: "打断多，信息差",
    pacing: "高压段短句",
    forbid: "空气凝固 / 倒吸凉气"
  });

  const outline = await createOutlineScaffold({ projectDir: proj, overwrite: true });
  assert.equal(outline.ok, true);
  assert.match(await fsp.readFile(outline.path, "utf8"), /黄金三章/);

  const plan = await planResearch({ projectDir: proj, topic: "卢象升", genre: "历史军事", names: ["卢象升"], createDoc: true });
  assert.equal(plan.ok, true);
  const filled = await appendResearchFindings({
    projectDir: proj,
    topic: "卢象升",
    sources: ["https://example.com/luxiangsheng"],
    facts: ["明末将领，崇祯年间活跃"],
    forbidden: ["不可写成清朝人物"]
  });
  assert.equal(filled.filled, true);

  await createCharacterCard({ projectDir: proj, name: "卢象升", kind: "historical", summary: "前线主将" });
  await createChapterBrief({
    projectDir: proj,
    chapterNo: "1",
    title: "军报",
    conflict: "军报延误必须当面顶住",
    beats: "入场-对质-代价",
    hook: "第二份军报到门口"
  });

  const packet = await buildDraftPacket({ projectDir: proj, chapterNo: "1", title: "军报", engineName: "压力选择型" });
  assert.equal(packet.ok, true);
  assert.ok(packet.system.includes("正文主笔"));
  assert.ok(packet.prompt.includes("事实库"));
  assert.equal(packet.stage.stage, "绑定");

  const local = await writeArtifact({
    projectDir: proj,
    kind: "local_draft",
    title: "军报",
    chapterNo: "1",
    content: "标题：军报\n\n雨拍在辕门上。他把湿透的军报按在桌上，只问一句：谁压了这份？\n\n门外脚步乱了一拍。\n",
    modelId: "local-or-codex"
  });
  assert.ok(local.plainPath);

  const style = await compareStyle({ projectDir: proj, draftPath: local.path, title: "军报" });
  assert.equal(style.ok, true);

  await upsertSoftChapterLedger(proj, {
    chapterNo: "1",
    title: "军报",
    summary: "主角顶住延误军报",
    changes: "上级开始忌惮",
    hook: "第二份军报",
    candidatePath: local.relativePath
  });
  const cont = await checkChapterContinuity(proj, "1");
  assert.equal(cont.readyEnough, true);

  const pipe = await assessPipeline(proj);
  assert.equal(pipe.canDraft, true);
  assert.equal(pipe.checks.find((c) => c.id === "research_filled").ok, true);
  assert.equal(pipe.checks.find((c) => c.id === "fact_library").ok, true);

  // continuous remains hidden unless explicit phrase
  assert.equal(looksLikeExplicitEnable("继续写吧"), false);
  assert.equal(looksLikeExplicitEnable("可以连续，按黄金三章继续生成"), true);

  const guided = await getGuidedStatus(proj);
  assert.ok(guided.stage);

  // advance a couple stages to ensure not stuck
  await advanceGuidedStage(proj, { toStage: "sample_book", note: "e2e" });
  const g2 = await getGuidedStatus(proj);
  assert.equal(g2.stage.id, "sample_book");

  const coach = getChapterCoach("1");
  assert.equal(coach.stage, "绑定");

  console.log("offline full guided path: PASS");
  console.log(JSON.stringify({
    project: proj,
    canDraft: pipe.canDraft,
    nextAction: pipe.nextAction,
    packetMissing: packet.missing,
    styleRisk: style.stats.aiHints,
    continuousPhraseOk: true
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
