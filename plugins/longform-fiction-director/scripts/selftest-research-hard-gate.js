"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { assessPipeline, looksHistorical } = require("../server/pipeline-coach-service");
const { appendResearchFindings } = require("../server/research-fill-service");
const { createCharacterCard } = require("../server/research-doc-service");

async function withTemp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-hist-"));
  try { return await fn(dir); }
  finally { try { await fsp.rm(dir, { recursive: true, force: true }); } catch {} }
}

async function main() {
  assert.equal(looksHistorical("都市甜宠日常"), false);
  assert.equal(looksHistorical("明朝总兵卢象升"), true);

  await withTemp(async (projectDir) => {
    await fsp.mkdir(path.join(projectDir, "辅助文档"), { recursive: true });
    await fsp.mkdir(path.join(projectDir, "细纲"), { recursive: true });
    await fsp.writeFile(path.join(projectDir, "辅助文档", "09_脑洞板.md"), "# 脑洞\n\n## 一句话钩子\n明朝总兵卢象升穿越后的压力选择。\n", "utf8");
    await fsp.writeFile(path.join(projectDir, "辅助文档", "01_全书大纲.md"), "# 大纲\n历史军事压力升级。\n", "utf8");
    await fsp.writeFile(path.join(projectDir, "细纲", "01_当前章细纲.md"), "# 控制卡\n第1章绑定兑现。\n目标与代价写清楚。\n", "utf8");

    let gate = await assessPipeline(projectDir);
    assert.equal(gate.historicalLikely, true);
    assert.equal(gate.canDraft, false);
    assert.ok(gate.hardBlockers.some((b) => b.id === "research_filled" || b.id === "fact_library" || b.id === "characters"));

    await appendResearchFindings({
      projectDir,
      topic: "卢象升",
      sources: ["https://example.com/luxiangsheng"],
      facts: ["卢象升为明末名将，官至兵部尚书"],
      forbidden: ["不可写成现代职业军官"],
      fictionBounds: ["私人对话可虚构"]
    });
    await createCharacterCard({ projectDir, name: "卢象升", kind: "historical", summary: "明末名将" });

    gate = await assessPipeline(projectDir);
    assert.equal(gate.canDraft, true, JSON.stringify(gate.hardBlockers));
  });

  // pure fiction remains soft on research
  await withTemp(async (projectDir) => {
    await fsp.mkdir(path.join(projectDir, "辅助文档"), { recursive: true });
    await fsp.mkdir(path.join(projectDir, "细纲"), { recursive: true });
    await fsp.writeFile(path.join(projectDir, "辅助文档", "09_脑洞板.md"), "# 脑洞\n\n## 一句话钩子\n都市职场反杀。\n", "utf8");
    await fsp.writeFile(path.join(projectDir, "细纲", "01_当前章细纲.md"), "# 控制卡\n第1章绑定。\n具体行动与代价。\n", "utf8");
    const gate = await assessPipeline(projectDir);
    assert.equal(gate.historicalLikely, false);
    assert.equal(gate.canDraft, true);
    assert.ok(gate.softMissing.some((b) => b.id === "research_filled" || b.id === "sample_import" || b.id === "outline"));
  });

  console.log("research-hard-gate: PASS");
}
main().catch((e) => { console.error(e); process.exit(1); });
