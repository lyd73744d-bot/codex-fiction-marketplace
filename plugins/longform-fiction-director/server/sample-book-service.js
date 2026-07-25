"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function safeName(value, fallback = "sample") {
  const raw = String(value || fallback).trim() || fallback;
  return raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 80) || fallback;
}

async function ensureDir(dir) { await fsp.mkdir(dir, { recursive: true }); return dir; }
function sampleRoot(projectDir) { return path.join(projectDir, "样书"); }

async function importSampleBook({ projectDir, sourcePath, title = "" } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (!sourcePath) throw new Error("sourcePath required");
  const src = path.resolve(sourcePath);
  if (!fs.existsSync(src)) throw new Error("sourcePath not found: " + src);
  const st = await fsp.stat(src);
  const root = await ensureDir(sampleRoot(projectDir));
  const base = safeName(title || path.basename(src, path.extname(src)), "sample-book");
  const destDir = await ensureDir(path.join(root, base));
  const copied = [];
  async function copyFile(from, toDir) {
    await ensureDir(toDir);
    const to = path.join(toDir, path.basename(from));
    await fsp.copyFile(from, to);
    copied.push(path.relative(projectDir, to));
  }
  if (st.isFile()) {
    await copyFile(src, destDir);
  } else if (st.isDirectory()) {
    const stack = [src];
    while (stack.length) {
      const cur = stack.pop();
      for (const ent of await fsp.readdir(cur, { withFileTypes: true })) {
        const full = path.join(cur, ent.name);
        if (ent.isDirectory()) {
          if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
          stack.push(full);
        } else if (ent.isFile() && /\.(txt|md|markdown|text)$/i.test(ent.name)) {
          const rel = path.relative(src, path.dirname(full));
          await copyFile(full, path.join(destDir, rel));
        }
      }
    }
  } else {
    throw new Error("sourcePath must be file or directory");
  }
  const manifest = { title: base, sourcePath: src, importedAt: new Date().toISOString(), files: copied, note: "样书只学手法，不抄原句/角色/设定/桥段。" };
  await fsp.writeFile(path.join(destDir, "_sample_manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const learnPath = path.join(destDir, "00_手法学习笔记.md");
  if (!fs.existsSync(learnPath)) {
    await fsp.writeFile(learnPath, "# 样书手法学习笔记\n\n> 只学节奏与冲突推进，不抄原句。\n\n## 这本书强在哪\n- \n\n## 可迁移到本书的 3-8 条写法\n1. \n\n## 明确不要带入\n- 原书角色名、专有设定、完整事件顺序\n", "utf8");
  }
  return { ok: true, sampleDir: destDir, relativeDir: path.relative(projectDir, destDir), manifest, coach: "样书已入库。先拆 3-8 条可迁移手法，再开脑洞/大纲。" };
}

async function listSampleBooks(projectDir) {
  const root = sampleRoot(projectDir);
  if (!fs.existsSync(root)) return { ok: true, items: [] };
  const items = [];
  for (const ent of await fsp.readdir(root, { withFileTypes: true })) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(root, ent.name);
    let manifest = null;
    try { manifest = JSON.parse(await fsp.readFile(path.join(dir, "_sample_manifest.json"), "utf8")); } catch {}
    items.push({ name: ent.name, dir, relativeDir: path.relative(projectDir, dir), files: manifest?.files?.length || 0, importedAt: manifest?.importedAt || null });
  }
  return { ok: true, items };
}

async function readSampleNotes(projectDir, sampleName = "") {
  const listed = await listSampleBooks(projectDir);
  if (!listed.items.length) return { ok: false, message: "还没有样书。请先把样书文件夹拖进来。" };
  const dir = sampleName ? path.join(sampleRoot(projectDir), safeName(sampleName)) : listed.items[0].dir;
  const notes = path.join(dir, "00_手法学习笔记.md");
  if (!fs.existsSync(notes)) return { ok: false, message: "缺少手法学习笔记" };
  return { ok: true, path: notes, content: await fsp.readFile(notes, "utf8") };
}

module.exports = { importSampleBook, listSampleBooks, readSampleNotes, sampleRoot };
