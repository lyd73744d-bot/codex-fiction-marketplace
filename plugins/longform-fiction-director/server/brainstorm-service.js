"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
function boardPath(projectDir) { return path.join(projectDir, "辅助文档", "09_脑洞板.md"); }
async function ensureBrainstormBoard(projectDir) {
  const file = boardPath(projectDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    const body = [
      "# 脑洞板", "",
      "> 先问清楚再展开。这里不是大纲，是可追问的火花。", "",
      "## 一句话钩子", "",
      "## 主角此刻最想要什么", "",
      "## 最大阻力", "",
      "## 为什么读者不划走", "",
      "## 先不写的支线", "",
      "## 待确认问题", "- ", ""
    ].join("\n");
    await fsp.writeFile(file, body, "utf8");
    return { ok: true, created: true, path: file, content: body };
  }
  return { ok: true, created: false, path: file, content: await fsp.readFile(file, "utf8") };
}
async function updateBrainstormBoard(projectDir, fields = {}) {
  await ensureBrainstormBoard(projectDir);
  const file = boardPath(projectDir);
  let body = await fsp.readFile(file, "utf8");
  const map = {
    hook: "一句话钩子",
    desire: "主角此刻最想要什么",
    obstacle: "最大阻力",
    hookWhy: "为什么读者不划走",
    later: "先不写的支线",
    questions: "待确认问题"
  };
  for (const [key, heading] of Object.entries(map)) {
    if (fields[key] == null || fields[key] === "") continue;
    const re = new RegExp("(## " + heading + "\\n)([\\s\\S]*?)(?=\\n## |$)");
    if (re.test(body)) body = body.replace(re, "$1\n" + String(fields[key]).trim() + "\n\n");
  }
  await fsp.writeFile(file, body, "utf8");
  return { ok: true, path: file, content: body, coach: "脑洞已更新。仍只给方向，不直接开长文。" };
}
function sectionBody(boardText, heading) {
  const re = new RegExp("## " + heading + "\\n([\\s\\S]*?)(?=\\n## |$)");
  const m = String(boardText || "").match(re);
  if (!m) return "";
  return m[1].split(/\n/).filter((line) => line.trim() && !line.trim().startsWith("##")).join("\n").trim();
}
function filled(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/待补|待定|TBD|TODO|^（待|^\(待/i.test(t)) return false;
  if (t === "-" || t === "- " ) return false;
  return t.length >= 2;
}
function nextBrainstormQuestions(boardText = "") {
  const missing = [];
  if (!filled(sectionBody(boardText, "一句话钩子"))) missing.push("用一句话说说这本书最抓人的点？别写类型标签，写具体冲突。");
  if (!filled(sectionBody(boardText, "主角此刻最想要什么"))) missing.push("主角现在最想得到或保住什么？最好是这周内就急的。");
  if (!filled(sectionBody(boardText, "最大阻力"))) missing.push("拦着他的，是人、规则、身体极限，还是时间？");
  if (!filled(sectionBody(boardText, "为什么读者不划走"))) missing.push("读者为什么现在不划走？是悬念、情绪，还是想看他怎么翻盘？");
  if (!missing.length) {
    missing.push("这三个里你最想先展开哪一个：开场爆点、中段压力升级、还是人物关系拧劲？");
    missing.push("有没有你明确不想写的套路？先记进「先不写的支线」。");
  }
  return missing.slice(0, 3);
}
async function getBrainstormCoach(projectDir) {
  const board = await ensureBrainstormBoard(projectDir);
  const asks = nextBrainstormQuestions(board.content);
  return {
    ok: true,
    path: board.path,
    askNow: asks,
    filled: {
      hook: filled(sectionBody(board.content, "一句话钩子")),
      desire: filled(sectionBody(board.content, "主角此刻最想要什么")),
      obstacle: filled(sectionBody(board.content, "最大阻力"))
    },
    coach: "一次只问 1-3 个问题。作者答完再往前，不替他拍板世界观。"
  };
}
module.exports = { ensureBrainstormBoard, updateBrainstormBoard, getBrainstormCoach, nextBrainstormQuestions };
