"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { ensureFactLibrary, upsertFacts, readFactLibrary } = require("../server/fact-library-service");
const { upsertSoftChapterLedger, checkChapterContinuity } = require("../server/soft-chapter-ledger");
const { appendResearchFindings } = require("../server/research-fill-service");
const { authorFeedbackBlock, normalizeAuthorFeedback } = require("../server/author-feedback-lib");
const { assessPipeline } = require("../server/pipeline-coach-service");

async function main() {
  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-fact-"));
  await ensureFactLibrary(proj);
  const up = await upsertFacts(proj, {
    facts: ["卢象升为明末将领"],
    forbidden: ["不可写成清朝人"],
    sources: ["https://example.com/luxiangsheng"]
  });
  assert.equal(up.ok, true);
  const read = await readFactLibrary(proj);
  assert.match(read.content, /卢象升/);
  assert.match(read.content, /example.com/);

  const fill = await appendResearchFindings({
    projectDir: proj,
    topic: "卢象升",
    sources: ["https://example.com/luxiangsheng"],
    facts: ["崇祯年间活跃于北方"],
    forbidden: ["不可穿越到错误朝代任职"]
  });
  assert.equal(fill.filled, true);
  assert.ok(fill.factLibrary);

  const led = await upsertSoftChapterLedger(proj, {
    chapterNo: "1",
    title: "军报",
    summary: "主角顶住延误军报",
    changes: "关系改价：上级开始忌惮",
    hook: "门外传来第二份军报"
  });
  assert.equal(led.ok, true);
  const cont = await checkChapterContinuity(proj, "1");
  assert.equal(cont.ok, true);
  assert.equal(cont.readyEnough, true);

  const fb = normalizeAuthorFeedback("保留证据链，不要解释腔，加强压迫");
  assert.ok(fb.preserveIntent.length || fb.avoid.length || fb.desiredEffect.length);
  assert.match(authorFeedbackBlock("不要总结腔"), /希望避免/);

  // pipeline soft checks include fact_library after research fill
  await fsp.mkdir(path.join(proj, "辅助文档"), { recursive: true });
  await fsp.writeFile(path.join(proj, "辅助文档", "09_脑洞板.md"), "# 脑洞\n\n- 核心：先保前线。\n", "utf8");
  await fsp.mkdir(path.join(proj, "细纲"), { recursive: true });
  await fsp.writeFile(path.join(proj, "细纲", "01_当前章细纲.md"), "# 细纲\n\n本章冲突：军报延误。\n", "utf8");
  const pipe = await assessPipeline(proj);
  const factCheck = pipe.checks.find((c) => c.id === "fact_library");
  assert.ok(factCheck);
  assert.equal(factCheck.ok, true);

  console.log("fact+ledger+continuity: PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
