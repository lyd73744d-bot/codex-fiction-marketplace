"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function ledgerPath(projectDir) {
  return path.join(projectDir, "辅助文档", "13_章节软台账.md");
}

function emptyBody() {
  return [
    "# 章节软台账",
    "",
    "> 作者确认前也可先记。确认入正文后，再用正式台账整理。",
    "> 只写会影响后续写作的变化，不写空总结。",
    ""
  ].join("\n");
}

async function ensureSoftChapterLedger(projectDir) {
  const file = ledgerPath(projectDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) await fsp.writeFile(file, emptyBody() + "\n", "utf8");
  return file;
}

function cardMarkdown(input = {}) {
  const no = String(input.chapterNo || "").trim() || "?";
  const lines = [
    "## 第" + no + "章" + (input.title ? " · " + input.title : ""),
    "",
    "- 一句话剧情：" + (input.summary || "（待补）"),
    "- 时间地点：" + (input.timePlace || "（待补）"),
    "- 出场人物及其本章行为：" + (input.characters || "（待补）"),
    "- 关键事件与变化：" + (input.changes || "（待补）"),
    "- 人物状态/关系更新：" + (input.relations || "（待补）"),
    "- 本章埋下的伏笔/悬念：" + (input.foreshadow || "无"),
    "- 本章回收的伏笔：" + (input.payoff || "无"),
    "- 章尾钩：" + (input.hook || "（待补）"),
    "- 候选路径：" + (input.candidatePath || ""),
    "- 更新于：" + new Date().toISOString(),
    ""
  ];
  return lines.join("\n");
}

async function upsertSoftChapterLedger(projectDir, input = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (!input.chapterNo) throw new Error("chapterNo required");
  const file = await ensureSoftChapterLedger(projectDir);
  let md = await fsp.readFile(file, "utf8");
  const heading = "## 第" + String(input.chapterNo).trim() + "章";
  const card = cardMarkdown(input);
  const start = md.indexOf(heading);
  if (start >= 0) {
    const next = md.indexOf("\n## 第", start + heading.length);
    const end = next >= 0 ? next : md.length;
    md = md.slice(0, start) + card + md.slice(end).replace(/^\n+/, "\n");
  } else {
    md = md.trimEnd() + "\n\n" + card;
  }
  await fsp.writeFile(file, md.replace(/\n{3,}/g, "\n\n").trim() + "\n", "utf8");
  return {
    ok: true,
    path: file,
    relativePath: path.relative(projectDir, file),
    coach: "软台账已记。确认正文后再走正式入账；连续写前先看变化与钩子。"
  };
}

function tableHasChapter(text, chapterNo) {
  const target = String(Number(chapterNo) || 0);
  if (!target || target === "0") return false;
  return String(text || "").split(/\r?\n/).some((line) => {
    const match = line.match(/^\|\s*0*(\d+)\s*\|/);
    return match && String(Number(match[1])) === target;
  }) || String(text || "").includes("## 第" + target + "章");
}

async function checkChapterContinuity(projectDir, chapterNo) {
  if (!projectDir) throw new Error("projectDir required");
  const no = String(chapterNo || "").trim();
  if (!no) throw new Error("chapterNo required");
  const aux = path.join(projectDir, "辅助文档");
  const soft = fs.existsSync(ledgerPath(projectDir)) ? await fsp.readFile(ledgerPath(projectDir), "utf8") : "";
  const plot = fs.existsSync(path.join(aux, "01_全书大纲.md")) ? await fsp.readFile(path.join(aux, "01_全书大纲.md"), "utf8") : "";
  const hero = fs.existsSync(path.join(aux, "02_人物台账.md")) ? await fsp.readFile(path.join(aux, "02_人物台账.md"), "utf8") : "";
  const timeline = fs.existsSync(path.join(aux, "04_时间线.md")) ? await fsp.readFile(path.join(aux, "04_时间线.md"), "utf8") : "";
  const foreshadow = fs.existsSync(path.join(aux, "05_伏笔管理.md")) ? await fsp.readFile(path.join(aux, "05_伏笔管理.md"), "utf8") : "";
  const facts = fs.existsSync(path.join(aux, "12_事实库_防OOC.md")) ? await fsp.readFile(path.join(aux, "12_事实库_防OOC.md"), "utf8") : "";
  const issues = [];
  if (!tableHasChapter(soft, no)) issues.push({ id: "soft_ledger", message: "软台账尚无本章卡" });
  if (!tableHasChapter(timeline, no) && !/第\s*0*/.test(timeline)) {
    // timeline may be freeform; only warn if completely empty
    if (!String(timeline).trim()) issues.push({ id: "timeline", message: "时间线为空" });
  }
  if (!String(facts).includes("- ") && !String(facts).match(/已确认硬事实[\s\S]*?-\s+\S/)) {
    issues.push({ id: "facts", message: "事实库几乎为空，历史/真实人物风险高" });
  }
  const missingRelations = !tableHasChapter(hero, no) && !String(hero).includes(String(no));
  if (missingRelations) issues.push({ id: "hero", message: "人物台账未见本章更新（确认前可先写软台账）" });
  if (!String(foreshadow).trim()) issues.push({ id: "foreshadow", message: "伏笔管理为空（可后补）" });
  return {
    ok: true,
    chapterNo: no,
    issues,
    readyEnough: issues.filter((i) => i.id === "soft_ledger" || i.id === "facts").length === 0,
    coach: issues.length
      ? "连续/下一章前建议先补：" + issues.map((i) => i.message).join("；")
      : "本章连续信息够用。仍保持引导，不擅自连写。"
  };
}

module.exports = {
  upsertSoftChapterLedger,
  checkChapterContinuity,
  ensureSoftChapterLedger,
  ledgerPath
};
