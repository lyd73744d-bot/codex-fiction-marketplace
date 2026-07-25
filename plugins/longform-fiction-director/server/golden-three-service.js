"use strict";
const fsp = require("node:fs/promises");
const path = require("node:path");
const continuous = require("./continuous-mode");
const { coachForChapter, ENGINE_NAMES, ORIGINALITY_BOUNDARY } = require("./golden-three-coach");
function statePath(projectDir) { return path.join(projectDir, ".fiction-director", "golden-three.json"); }
function empty() { return { chapters: { "1": { ready: false, note: "", path: "" }, "2": { ready: false, note: "", path: "" }, "3": { ready: false, note: "", path: "" } }, readyAll: false, updatedAt: null }; }
async function readGoldenThree(projectDir) { try { return { ...empty(), ...JSON.parse(await fsp.readFile(statePath(projectDir), "utf8")) }; } catch { return empty(); } }
async function writeGoldenThree(projectDir, state) {
  const next = { ...empty(), ...state, updatedAt: new Date().toISOString() };
  const ch = next.chapters || empty().chapters;
  next.chapters = ch;
  next.readyAll = !!(ch["1"]?.ready && ch["2"]?.ready && ch["3"]?.ready);
  await fsp.mkdir(path.dirname(statePath(projectDir)), { recursive: true });
  await fsp.writeFile(statePath(projectDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  await continuous.setGoldenThreeReady(projectDir, next.readyAll);
  return next;
}
async function markGoldenChapter(projectDir, chapterNo, { ready = true, note = "", path: filePath = "" } = {}) {
  const no = String(chapterNo || "");
  if (!["1", "2", "3"].includes(no)) throw new Error("chapterNo must be 1/2/3");
  const state = await readGoldenThree(projectDir);
  state.chapters = state.chapters || empty().chapters;
  state.chapters[no] = { ready: ready === true, note: String(note || "").slice(0, 500), path: String(filePath || "") };
  return writeGoldenThree(projectDir, state);
}
async function getGoldenThreeStatus(projectDir) {
  const state = await readGoldenThree(projectDir);
  const cont = await continuous.readContinuousMode(projectDir);
  const stageCoach = {
    1: coachForChapter(1),
    2: coachForChapter(2),
    3: coachForChapter(3),
    later: coachForChapter(4)
  };
  return {
    ok: true,
    ...state,
    continuousEnabled: cont.enabled === true,
    engines: ENGINE_NAMES,
    originalityBoundary: ORIGINALITY_BOUNDARY,
    stageCoach,
    coach: state.readyAll
      ? "前三章已就绪。后续仍默认引导写作；连续模式需作者明确授权，不主动推销。"
      : "黄金三章未齐：1绑定 / 2加深 / 3验证。逐章打磨，先问清楚再生成。"
  };
}
function getChapterCoach(chapterNo, options = {}) {
  return coachForChapter(chapterNo, options);
}
module.exports = { readGoldenThree, markGoldenChapter, getGoldenThreeStatus, getChapterCoach };