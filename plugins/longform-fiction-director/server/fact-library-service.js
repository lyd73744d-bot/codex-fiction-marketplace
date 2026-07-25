"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function factPath(projectDir) {
  return path.join(projectDir, "辅助文档", "12_事实库_防OOC.md");
}

function emptyBody() {
  return [
    "# 事实库（防 OOC）",
    "",
    "> 只记会打脸的硬事实。空形容词不要。真实人物/制度必须挂来源。",
    "> 写正文前扫一遍；确认章节后可追加。",
    "",
    "## 已确认硬事实",
    "",
    "## 禁止写错",
    "",
    "## 可虚构边界",
    "",
    "## 待核验",
    "",
    "## 来源",
    ""
  ].join("\n");
}

async function ensureFactLibrary(projectDir) {
  if (!projectDir) throw new Error("projectDir required");
  const file = factPath(projectDir);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    await fsp.writeFile(file, emptyBody() + "\n", "utf8");
    return { ok: true, created: true, path: file, relativePath: path.relative(projectDir, file) };
  }
  return { ok: true, created: false, path: file, relativePath: path.relative(projectDir, file) };
}

async function readFactLibrary(projectDir) {
  const ensured = await ensureFactLibrary(projectDir);
  const content = await fsp.readFile(ensured.path, "utf8");
  return { ...ensured, content };
}

function appendBullets(sectionText, items) {
  const existing = new Set(
    String(sectionText || "")
      .split(/\n/)
      .map((l) => l.replace(/^\s*[-*]\s*/, "").trim())
      .filter(Boolean)
  );
  const lines = [];
  for (const item of items) {
    const t = String(item || "").trim();
    if (!t || existing.has(t)) continue;
    existing.add(t);
    lines.push("- " + t);
  }
  return lines;
}

function upsertSection(md, heading, newBullets) {
  const source = String(md || "").replace(/\r\n?/g, "\n");
  const h = "## " + heading;
  const start = source.indexOf(h);
  if (start < 0) {
    return source.trimEnd() + "\n\n" + h + "\n\n" + newBullets.join("\n") + "\n";
  }
  const next = source.indexOf("\n## ", start + h.length);
  const end = next >= 0 ? next : source.length;
  const before = source.slice(0, end).trimEnd();
  const after = source.slice(end);
  if (!newBullets.length) return source;
  return before + "\n" + newBullets.join("\n") + "\n" + after;
}

async function upsertFacts(projectDir, {
  facts = [],
  forbidden = [],
  fictionBounds = [],
  pending = [],
  sources = [],
  note = ""
} = {}) {
  const ensured = await ensureFactLibrary(projectDir);
  let md = await fsp.readFile(ensured.path, "utf8");
  const sections = {
    "已确认硬事实": facts,
    "禁止写错": forbidden,
    "可虚构边界": fictionBounds,
    "待核验": pending,
    "来源": sources
  };
  for (const [heading, items] of Object.entries(sections)) {
    const bullets = appendBullets("", items);
    // need current section content for de-dupe
    const h = "## " + heading;
    const start = md.indexOf(h);
    let sectionBody = "";
    if (start >= 0) {
      const next = md.indexOf("\n## ", start + h.length);
      sectionBody = md.slice(start + h.length, next >= 0 ? next : md.length);
    }
    const uniqueBullets = appendBullets(sectionBody, items);
    if (uniqueBullets.length) md = upsertSection(md, heading, uniqueBullets);
  }
  if (note && String(note).trim()) {
    md = md.trimEnd() + "\n\n## 备注 " + new Date().toISOString().slice(0, 10) + "\n\n" + String(note).trim() + "\n";
  }
  await fsp.writeFile(ensured.path, md.replace(/\n{3,}/g, "\n\n").trim() + "\n", "utf8");
  return {
    ok: true,
    path: ensured.path,
    relativePath: ensured.relativePath,
    coach: "事实库已更新。写正文前再扫一遍禁止写错与待核验。"
  };
}

module.exports = {
  factPath,
  ensureFactLibrary,
  readFactLibrary,
  upsertFacts
};
