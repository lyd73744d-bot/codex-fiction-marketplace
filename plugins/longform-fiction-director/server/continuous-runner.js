"use strict";
const { readContinuousMode } = require("./continuous-mode");
const { getGoldenThreeStatus } = require("./golden-three-service");
const { createChapterBrief } = require("./chapter-brief-service");
const { assessPipeline } = require("./pipeline-coach-service");
async function planNextContinuousChapter(projectDir, { chapterNo = "", title = "", conflict = "", hook = "" } = {}) {
  const mode = await readContinuousMode(projectDir);
  const golden = await getGoldenThreeStatus(projectDir);
  if (!mode.enabled) return { ok: false, enabled: false, message: "当前为引导模式。" };
  if (!golden.readyAll) return { ok: false, enabled: true, message: "黄金三章未齐，不能连续。" };
  const pipe = await assessPipeline(projectDir);
  const no = String(chapterNo || "4");
  const brief = await createChapterBrief({ projectDir, chapterNo: no, title: title || ("第" + no + "章"), conflict: conflict || "延续已验证的压力升级，推进主线下一难关。", hook: hook || "章尾留下新的不可退选择。", beats: "1. 承接上章代价\n2. 主动行动\n3. 反噬升级\n4. 付出代价的小进展\n5. 钩子" });
  return { ok: true, enabled: true, chapterNo: no, brief, pipeline: pipe, next: "控制卡已生成。用 fiction_generate_to_file 写候选 txt，再 optimize。" };
}
module.exports = { planNextContinuousChapter };