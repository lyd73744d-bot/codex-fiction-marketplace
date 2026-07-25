"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
function safeName(value, fallback = "item") {
  const raw = String(value || fallback).trim() || fallback;
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 60) || fallback;
}
async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); return dir; }
function researchDir(projectDir) { return path.join(projectDir, "辅助文档", "联网核验"); }
function characterDir(projectDir) { return path.join(projectDir, "辅助文档", "人物卡"); }

async function createResearchDoc({ projectDir, topic, genre = "", notes = "" } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (!topic) throw new Error("topic required");
  const dir = await ensureDir(researchDir(projectDir));
  const file = path.join(dir, safeName(topic) + ".md");
  const body = [
    "# 联网核验：" + topic, "",
    "> 用途：防 OOC / 史实穿帮 / 身份职责写错。空文档不算完成。", "",
    "## 题材与风险",
    "- 题材：" + (genre || "待确认"),
    "- 主要风险：身份、时间线、权责、地理、器物、称谓", "",
    "## 先问清楚再搜",
    "1. 这个对象在本书里要承担什么戏？",
    "2. 哪些点一旦写错会穿帮？",
    "3. 哪些地方允许虚构，哪些地方必须贴实？", "",
    "## 建议检索词",
    "- " + topic + " 生平 / 任职 / 时间",
    "- " + topic + " 常见误区",
    "- " + (genre || "相关") + " 制度/背景 可靠来源", "",
    "## 必须联网",
    "是。用内置浏览器打开可信来源，再回填。", "",
    "## 来源（标题 + 链接 + 日期）",
    "- （还没有就不许写关键决策）", "",
    "## 已确认事实",
    "- ", "",
    "## 禁止写错",
    "- ", "",
    "## 可虚构边界",
    "- ", "",
    "## 备注",
    notes || "",
    ""
  ].join("\n");
  await fsp.writeFile(file, body, "utf8");
  return { ok: true, path: file, relativePath: path.relative(projectDir, file), coach: "核验文档已建。请真正联网检索后用 fiction_append_research_findings 回填；没来源别写。" };
}

async function createCharacterCard({ projectDir, name, kind = "fictional", summary = "" } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (!name) throw new Error("name required");
  const dir = await ensureDir(characterDir(projectDir));
  const file = path.join(dir, safeName(name) + ".md");
  const isReal = ["real", "historical", "真实", "历史"].includes(String(kind));
  const body = [
    "# 人物卡：" + name, "",
    "## 类型",
    isReal ? "真实/历史人物（先联网核验，再写戏）" : "虚构人物", "",
    "## 一句话定位",
    summary || "（这个人在本书里是干什么的？）", "",
    "## 此刻最在乎什么",
    "- 表面目标：",
    "- 真正怕失去的：",
    "- 不能让别人知道的：", "",
    "## 关系网（只写会影响本章的）",
    "- 对主角：",
    "- 对对手/上级/家人：", "",
    "## 说话习惯",
    "- 常用节奏（短促/绕弯/压人/装傻）：",
    "- 绝不会说的话：",
    "- 一急会露出的破绽：", "",
    "## 行为边界",
    "- 压力下会做：",
    "- 再难也不会做：", "",
    isReal
      ? "## 史实核验\n- 对应核验文档：\n- 可写事实：\n- 禁止写错：\n- 虚构边界：\n"
      : "## 设定来源\n- 本书原创；与大纲/脑洞冲突时以作者最新决定为准。\n",
    "## 本章可用状态",
    "- 开场状态：",
    "- 可能的状态变化：",
    ""
  ].join("\n");
  await fsp.writeFile(file, body, "utf8");
  return { ok: true, path: file, relativePath: path.relative(projectDir, file), coach: isReal ? "真实人物卡已建：先核验再写。空卡不算完成。" : "人物卡已建：先把说话边界和不会做的事写实，再进正文。" };
}

async function listCharacterCards(projectDir) {
  const dir = characterDir(projectDir);
  if (!fs.existsSync(dir)) return { ok: true, items: [] };
  const names = await fsp.readdir(dir);
  return { ok: true, items: names.filter((n) => /\.md$/i.test(n)).map((n) => ({ name: n, path: path.join(dir, n) })) };
}
module.exports = { createResearchDoc, createCharacterCard, listCharacterCards, researchDir, characterDir };
