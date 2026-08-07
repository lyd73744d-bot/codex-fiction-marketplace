"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { writeArtifact } = require("./artifact-pipeline");

function readSection(markdown, heading) {
  const source = String(markdown || "").replace(/\r\n?/g, "\n");
  const marker = "## " + heading;
  const start = source.indexOf(marker);
  if (start < 0) return "";
  const bodyStart = start + marker.length;
  const next = source.indexOf("\n## ", bodyStart);
  return source.slice(bodyStart, next >= 0 ? next : source.length).trim();
}

function fieldValue(fields, key, existing, heading, fallback = "") {
  if (Object.prototype.hasOwnProperty.call(fields, key)) return String(fields[key] || "").trim();
  return readSection(existing, heading) || fallback;
}

async function upsertVoiceAnchor(projectDir, fields = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const file = path.join(projectDir, "辅助文档", "08_文风锚点.md");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const existing = fs.existsSync(file) ? await fsp.readFile(file, "utf8") : "";
  const body = [
    "# 文风锚点", "",
    "> 写成能检查的习惯，不要空形容词。每次写完正文都对照这里。", "",
    "## 叙述口气", fieldValue(fields, "narration", existing, "叙述口气", "- "), "",
    "## 对话习惯", fieldValue(fields, "dialogue", existing, "对话习惯", "- "), "",
    "## 节奏", fieldValue(fields, "pacing", existing, "节奏", "- 段长：\n- 动作/心理比例："), "",
    "## 从样书借来的（可迁移）", fieldValue(fields, "fromSample", existing, "从样书借来的（可迁移）", "- "), "",
    "## 禁止的腔", fieldValue(fields, "forbid", existing, "禁止的腔", "- 解释腔\n- 总结腔\n- 万能网文套话"), "",
    "## 作者补充", fieldValue(fields, "author", existing, "作者补充"), ""
  ].join("\n");
  await fsp.writeFile(file, body, "utf8");
  const stylePath = path.join(projectDir, "辅助文档", "06_风格与写作要求.md");
  if (!fs.existsSync(stylePath) || (await fsp.readFile(stylePath, "utf8")).length < 80) {
    await fsp.writeFile(stylePath, body.replace("文风锚点", "风格与写作要求"), "utf8");
  }
  const art = await writeArtifact({ projectDir, kind: "voice_anchor", title: "文风锚点", content: body, ext: "md", modelId: "voice-anchor" });
  return { ok: true, path: file, artifact: art, coach: "文风锚点已更新。写完用 fiction_compare_style 对照。" };
}
module.exports = { upsertVoiceAnchor, readSection };
