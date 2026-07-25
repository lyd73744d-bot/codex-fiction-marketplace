"use strict";
const fsp = require("node:fs/promises");
const path = require("node:path");
function statePath(projectDir) { return path.join(projectDir, ".fiction-director", "continuous-mode.json"); }
async function readContinuousMode(projectDir) {
  try {
    const parsed = JSON.parse(await fsp.readFile(statePath(projectDir), "utf8"));
    return { enabled: parsed.enabled === true, goldenThreeReady: parsed.goldenThreeReady === true, enabledAt: parsed.enabledAt || null, enabledByAuthorPhrase: parsed.enabledByAuthorPhrase || null, note: "仅作者明确授权后可开启；默认引导式写作。" };
  } catch {
    return { enabled: false, goldenThreeReady: false, enabledAt: null, enabledByAuthorPhrase: null, note: "默认关闭。" };
  }
}
function looksLikeExplicitEnable(phrase) {
  const text = String(phrase || "").trim();
  if (!text) return false;
  return /(可以连续|授权连续|开启连续|按黄金三章继续生成|后面都按这个模式生成|允许一键连写|开启连写)/.test(text);
}
async function setGoldenThreeReady(projectDir, ready = true) {
  const cur = await readContinuousMode(projectDir);
  const next = { ...cur, goldenThreeReady: ready === true, enabled: cur.enabled === true };
  await fsp.mkdir(path.dirname(statePath(projectDir)), { recursive: true });
  await fsp.writeFile(statePath(projectDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  return next;
}
async function enableContinuousMode(projectDir, authorPhrase = "") {
  const cur = await readContinuousMode(projectDir);
  if (!cur.goldenThreeReady) return { ok: false, enabled: false, message: "黄金三章尚未就绪。" };
  if (!looksLikeExplicitEnable(authorPhrase)) return { ok: false, enabled: false, message: "未检测到作者明确授权，不能开启。" };
  const next = { enabled: true, goldenThreeReady: true, enabledAt: new Date().toISOString(), enabledByAuthorPhrase: String(authorPhrase).slice(0, 200), note: "已授权连续生成；候选仍先落盘。" };
  await fsp.mkdir(path.dirname(statePath(projectDir)), { recursive: true });
  await fsp.writeFile(statePath(projectDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  return { ok: true, ...next };
}
async function disableContinuousMode(projectDir) {
  const cur = await readContinuousMode(projectDir);
  const next = { enabled: false, goldenThreeReady: cur.goldenThreeReady, enabledAt: null, enabledByAuthorPhrase: null, note: "已关闭连续生成。" };
  await fsp.mkdir(path.dirname(statePath(projectDir)), { recursive: true });
  await fsp.writeFile(statePath(projectDir), JSON.stringify(next, null, 2) + "\n", "utf8");
  return { ok: true, ...next };
}
module.exports = { readContinuousMode, setGoldenThreeReady, enableContinuousMode, disableContinuousMode, looksLikeExplicitEnable };
