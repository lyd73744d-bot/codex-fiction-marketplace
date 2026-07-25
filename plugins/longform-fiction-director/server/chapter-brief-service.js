"use strict";
const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeArtifact } = require("./artifact-pipeline");

async function createChapterBrief({
  projectDir,
  chapterNo = "1",
  title = "",
  conflict = "",
  beats = "",
  hook = "",
  pov = "",
  mustInclude = "",
  mustAvoid = "",
  cost = "",
  openState = ""
} = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const no = String(chapterNo || "1");
  const body = [
    "# 第" + no + "章 控制卡", "",
    "> 只写冲突、选择、代价、钩子。不写完整正文。", "",
    "## 标题", title || "（待定）", "",
    "## 视角", pov || "（默认主角）", "",
    "## 开场状态", openState || "（承接上章后，人在哪、压力是什么）", "",
    "## 本章唯一主冲突", conflict || "（谁要什么，谁/什么拦着，为什么现在必须动）", "",
    "## 关键选择", beats || "- 人物会做的主动选择：\n- 对方/世界如何反压：\n- 结果比开场更好还是更糟：", "",
    "## 本章代价", cost || "（时间、关系、资源、身份、秘密暴露……）", "",
    "## 章尾钩子", hook || "（必须从本章因果长出来，不要无来由惊吓）", "",
    "## 必须写到", mustInclude || "- ", "",
    "## 绝不能写崩", mustAvoid || "- OOC\n- 无来由开挂\n- 与核验/人物卡打架", "",
    "## 写前 30 秒检查",
    "- 人物卡读了吗？",
    "- 需要联网核验吗？",
    "- 与大纲/上章是否衔接？",
    "- 文风锚点还记得吗？",
    ""
  ].join("\n");
  const dir = path.join(projectDir, "细纲");
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, "第" + String(no).padStart(3, "0") + "章_控制卡.md");
  await fsp.writeFile(file, body, "utf8");
  await fsp.writeFile(path.join(dir, "01_当前章细纲.md"), body, "utf8");
  const art = await writeArtifact({
    projectDir,
    kind: "chapter_brief",
    title: "第" + no + "章",
    content: body,
    ext: "md",
    modelId: "chapter-brief"
  });
  return { ok: true, path: file, artifact: art, coach: "控制卡先给你确认。点头后再写候选正文 txt。" };
}
module.exports = { createChapterBrief };
