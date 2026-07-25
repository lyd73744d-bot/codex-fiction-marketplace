"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { upsertFacts } = require("./fact-library-service");

function researchDir(projectDir) {
  return path.join(projectDir, "辅助文档", "联网核验");
}

function safeName(value) {
  return String(value || "topic").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 60);
}

async function appendResearchFindings({
  projectDir,
  topic,
  sources = [],
  facts = [],
  forbidden = [],
  notes = "",
  fictionBounds = []
} = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (!topic) throw new Error("topic required");
  const dir = researchDir(projectDir);
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, safeName(topic) + ".md");
  let current = "";
  try { current = await fsp.readFile(file, "utf8"); } catch {
    current = "# 联网核验：" + topic + "\n\n";
  }
  const stamp = new Date().toISOString();
  const block = [
    "",
    "## 回填记录 · " + stamp,
    "",
    "### 来源",
    ...(Array.isArray(sources) && sources.length ? sources.map((s) => "- " + String(s)) : ["- （未提供链接则不能当作已确认）"]),
    "",
    "### 已确认事实",
    ...(Array.isArray(facts) && facts.length ? facts.map((f) => "- " + String(f)) : ["- （空）"]),
    "",
    "### 禁止写错",
    ...(Array.isArray(forbidden) && forbidden.length ? forbidden.map((f) => "- " + String(f)) : ["- （空）"]),
    "",
    notes ? ("### 备注\n" + String(notes) + "\n") : "",
    ""
  ].join("\n");
  await fsp.writeFile(file, current.trimEnd() + "\n" + block, "utf8");

  const factResult = await upsertFacts(projectDir, {
    facts,
    forbidden,
    fictionBounds,
    sources: Array.isArray(sources) ? sources : [],
    note: "来自联网核验：" + topic
  });

  const hasSource = Array.isArray(sources) && sources.some((s) => String(s).trim());
  const hasFact = Array.isArray(facts) && facts.some((f) => String(f).trim());
  return {
    ok: true,
    path: file,
    relativePath: path.relative(projectDir, file),
    factLibrary: factResult,
    filled: !!(hasSource && hasFact),
    coach: hasSource && hasFact
      ? "核验已回填，并同步事实库。可继续人物卡/细纲。"
      : "回填不完整：至少要有来源 + 已确认事实，才算防 OOC 完成。"
  };
}

module.exports = { appendResearchFindings };
