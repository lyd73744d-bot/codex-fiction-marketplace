"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const { buildOptimizeSystem, buildOptimizePrompt, FOCUS_HINTS } = require("../server/humanizer-prompt-lib");
const { optimizeWithModels } = require("../server/multi-model-optimize");
const { confirmChapterToLedgers, ensureBookWorkspace } = require("../server/ledger-organizer");
const { ensureSoftLedgers } = require("../server/guided-stage-service");

async function main() {
  const system = buildOptimizeSystem({ mode: "humanize", focus: "dialogue" });
  assert.match(system, /对话/);
  assert.match(system, /硬性保护/);
  assert.ok(system.length > 200);

  const prompt = buildOptimizePrompt({
    mode: "humanize",
    focus: "explain",
    instruction: "少总结",
    draftText: "这意味着他赢了。",
    context: { voice: "短句", brief: "冲突：粮", cards: "卢象升" }
  });
  assert.match(prompt, /待处理正文/);
  assert.match(prompt, /这意味着他赢了/);

  const proj = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-opt-"));
  await ensureSoftLedgers(proj);
  await ensureBookWorkspace(proj, { title: "测" });

  let calls = 0;
  const gateway = {
    async listModels() { return { models: [{ id: "m1" }, { id: "m2" }] }; },
    async callModels({ system, prompt }) {
      calls += 1;
      assert.ok(String(system || "").length > 50);
      assert.match(String(prompt || ""), /待处理正文|正文/);
      return {
        transport: "stream_attempt_1",
        content: "他说：“先守住。”\n门开了。\n这是第" + calls + "稿。"
      };
    }
  };

  const opt = await optimizeWithModels({
    gateway,
    projectDir: proj,
    draftText: "这意味着大势已定。他不禁感到高兴。",
    title: "试章",
    chapterNo: "1",
    modelIds: ["m1", "m2"],
    mode: "humanize",
    focus: "explain"
  });
  assert.equal(opt.ok, true);
  assert.equal(opt.focus, "explain");
  assert.equal(opt.runs.length, 2);
  assert.ok(opt.runs[0].artifact.plainPath);

  const confirmed = await confirmChapterToLedgers({
    projectDir: proj,
    prose: "他说：“先守住。”\n门开了。粮只够三天。",
    authorConfirmed: true,
    title: "三天的粮",
    chapterNo: "1",
    summary: "顶住质疑",
    nextHook: "粮道旗号不对",
    characterChanges: ["卢象升对主角多了一分试探"],
    timeline: ["崇祯朝，军情紧急日"],
    foreshadow: ["粮道异常旗号"]
  });
  assert.ok(confirmed);
  const soft = await fsp.readFile(path.join(proj, "辅助文档", "11_时间线与伏笔.md"), "utf8");
  assert.match(soft, /粮道异常旗号|确认回写/);
  const proseFiles = await fsp.readdir(path.join(proj, "正文"));
  assert.ok(proseFiles.length >= 1);

  console.log("optimize+humanizer+ledger selftest: PASS");
  console.log(JSON.stringify({ focuses: Object.keys(FOCUS_HINTS), optimizeCalls: calls, proseFiles }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
