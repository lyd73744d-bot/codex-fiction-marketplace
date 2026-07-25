"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeArtifact } = require("./artifact-pipeline");
async function upsertVoiceAnchor(projectDir, fields = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const file = path.join(projectDir, "辅助文档", "08_文风锚点.md");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const body = ["# 文风锚点", "", "> 写成能检查的习惯，不要空形容词。每次写完候选都对照这里。", "", "## 叙述口气", fields.narration || "- ", "", "## 对话习惯", fields.dialogue || "- ", "", "## 节奏", fields.pacing || "- 段长：\n- 动作/心理比例：", "", "## 从样书借来的（可迁移）", fields.fromSample || "- ", "", "## 禁止的腔", fields.forbid || "- 解释腔\n- 总结腔\n- 万能网文套话", "", "## 作者补充", fields.author || "", ""].join("\n");
  await fsp.writeFile(file, body, "utf8");
  const stylePath = path.join(projectDir, "辅助文档", "06_风格与写作要求.md");
  if (!fs.existsSync(stylePath) || (await fsp.readFile(stylePath, "utf8")).length < 80) {
    await fsp.writeFile(stylePath, body.replace("文风锚点", "风格与写作要求"), "utf8");
  }
  const art = await writeArtifact({ projectDir, kind: "voice_anchor", title: "文风锚点", content: body, ext: "md", modelId: "voice-anchor" });
  return { ok: true, path: file, artifact: art, coach: "文风锚点已更新。写完用 fiction_compare_style 对照。" };
}
module.exports = { upsertVoiceAnchor };