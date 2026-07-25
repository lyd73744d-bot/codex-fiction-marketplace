"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const { scaffoldBookFolder, describeBuiltinWorkflow } = require("./workflow-scaffold");

function stamp() {
  return new Date().toISOString();
}

function safeChapterName(input, fallback = "chapter") {
  const raw = String(input || fallback).trim() || fallback;
  return raw
    .replace(/[\\/:*?"<>|]/gu, "-")
    .replace(/\s+/gu, " ")
    .slice(0, 80);
}

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readText(p, fallback = "") {
  try {
    return await fsp.readFile(p, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return fallback;
    throw e;
  }
}

async function writeText(p, text) {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, text, "utf8");
}

async function appendSection(filePath, heading, body) {
  const prev = await readText(filePath, "");
  const bodyText = String(body || "").trim();
  const block = "\n\n## " + heading + "\n\n" + bodyText + "\n";
  if (bodyText && prev.includes(heading) && prev.includes(bodyText.slice(0, Math.min(40, bodyText.length)))) {
    return { path: filePath, changed: false };
  }
  const next = (prev.trimEnd() + block).trim() + "\n";
  await writeText(filePath, next);
  return { path: filePath, changed: true };
}

async function ensureBookWorkspace(targetDir, { title = "", pluginRoot, overwrite = false } = {}) {
  const scaffold = await scaffoldBookFolder(targetDir, { title, pluginRoot, overwrite });
  const abs = scaffold.path;
  const orgPath = path.join(abs, "辅助文档", "00_使用说明与当前状态.md");
  let status = await readText(orgPath, "");
  if (!status.includes("台账目录说明")) {
    status = status.trimEnd() + "\n\n## 台账目录说明（插件自动维护）\n\n"
      + "- `正文/`：作者确认后的正式章节\n"
      + "- `细纲/`：当前章细纲与控制卡\n"
      + "- `Codex候选/`：模型候选稿（未确认）\n"
      + "- `审稿记录/`：质检与修改记录\n"
      + "- `辅助文档/`：人物、设定、时间线、伏笔、风格与进度\n\n"
      + "本项目由插件内置工作流生成，无需再安装外部工作流资料。\n";
    await writeText(orgPath, status.trim() + "\n");
  }

  const mapPath = path.join(abs, "项目地图.md");
  const bookTitle = title || path.basename(abs);
  if (!(await exists(mapPath)) || overwrite) {
    await writeText(
      mapPath,
      "# " + bookTitle + " · 项目地图\n\n"
        + "> 插件自动生成，随确认章节持续更新。\n\n"
        + "## 目录\n\n"
        + "| 路径 | 用途 | 谁写 |\n|---|---|---|\n"
        + "| 辅助文档/00_使用说明与当前状态.md | 进度与当前状态 | 插件+作者 |\n"
        + "| 辅助文档/02_人物台账.md | 人物变化 | 确认章节时自动追加 |\n"
        + "| 辅助文档/04_时间线.md | 时间推进 | 确认章节时自动追加 |\n"
        + "| 辅助文档/05_伏笔管理.md | 伏笔抛出/回收 | 确认章节时自动追加 |\n"
        + "| 细纲/ | 细纲与控制卡 | 写作阶段 |\n"
        + "| Codex候选/ | 未确认候选 | 模型 |\n"
        + "| 正文/ | 正式正文 | 作者确认后写入 |\n"
        + "| 审稿记录/ | 质检记录 | 质检阶段 |\n\n"
        + "## 默认流程\n\n"
        + "绑定 → 脑洞 → 细纲(控制卡) → 候选正文 → 去AI味 → 质检 → **确认入台账（自动整理）**\n"
    );
  }

  return {
    ...scaffold,
    organized: true,
    mapPath,
    layout: {
      status: "辅助文档/00_使用说明与当前状态.md",
      characters: "辅助文档/02_人物台账.md",
      world: "辅助文档/03_世界观与设定.md",
      timeline: "辅助文档/04_时间线.md",
      foreshadow: "辅助文档/05_伏笔管理.md",
      outline: "细纲/",
      candidates: "Codex候选/",
      prose: "正文/",
      reviews: "审稿记录/",
      map: "项目地图.md"
    }
  };
}

async function confirmChapterToLedgers(input = {}) {
  const projectDir = path.resolve(String(input.projectDir || "").trim());
  if (!projectDir || projectDir === path.parse(projectDir).root) {
    throw new Error("projectDir is invalid");
  }
  if (input.authorConfirmed !== true) {
    throw new Error("authorConfirmed must be true before writing ledgers");
  }
  const prose = String(input.prose || "").trim();
  if (!prose || prose.length < 20) throw new Error("prose is required");
  if (prose.length > 200000) throw new Error("prose too large");

  const chapterId = safeChapterName(input.chapterId || input.chapterNo || "第1章");
  const title = String(input.title || chapterId).trim();
  const summary = String(input.summary || "").trim();
  const nextHook = String(input.nextHook || "").trim();
  const characterChanges = Array.isArray(input.characterChanges)
    ? input.characterChanges.map(String).filter(Boolean).slice(0, 20)
    : [];
  const timeline = Array.isArray(input.timeline)
    ? input.timeline.map(String).filter(Boolean).slice(0, 20)
    : [];
  const foreshadow = Array.isArray(input.foreshadow)
    ? input.foreshadow.map(String).filter(Boolean).slice(0, 20)
    : [];

  await ensureBookWorkspace(projectDir, {
    title: input.bookTitle || path.basename(projectDir),
    pluginRoot: input.pluginRoot,
    overwrite: false
  });

  const fileBase = safeChapterName((input.chapterNo ? String(input.chapterNo) + "-" : "") + title, chapterId);
  const proseRel = path.join("正文", fileBase + ".md").replace(/\\/g, "/");
  const candidateRel = path.join("Codex候选", fileBase + ".md").replace(/\\/g, "/");
  const reviewRel = path.join("审稿记录", fileBase + "-确认.md").replace(/\\/g, "/");
  const now = stamp();

  const proseDoc = [
    "# " + title,
    "",
    "> 确认时间：" + now,
    summary ? "> 摘要：" + summary : "",
    "",
    prose,
    "",
    nextHook ? "## 章末钩子\n\n" + nextHook + "\n" : ""
  ].filter(Boolean).join("\n");
  await writeText(path.join(projectDir, proseRel), proseDoc);

  const statusRel = path.join("辅助文档", "00_使用说明与当前状态.md");
  const statusAbs = path.join(projectDir, statusRel);
  let status = await readText(statusAbs, "# 当前状态\n");
  const progressBlock = [
    "",
    "## 自动进度（插件维护）",
    "",
    "- 最近确认章节：" + title,
    "- 确认时间：" + now,
    "- 正式正文：" + proseRel,
    nextHook ? "- 下一章钩子：" + nextHook : "",
    summary ? "- 本章结果：" + summary : "",
    ""
  ].filter(Boolean).join("\n");
  if (status.includes("## 自动进度（插件维护）")) {
    status = status.replace(/## 自动进度（插件维护）[\s\S]*?(?=\n## |$)/, progressBlock.trim() + "\n\n");
  } else {
    status = status.trimEnd() + "\n" + progressBlock;
  }
  await writeText(statusAbs, status.trim() + "\n");

  const changes = [{ path: proseRel, kind: "prose" }];

  if (characterChanges.length) {
    const r = await appendSection(
      path.join(projectDir, "辅助文档", "02_人物台账.md"),
      title + " · 人物变化 · " + now.slice(0, 10),
      characterChanges.map((x) => "- " + x).join("\n")
    );
    if (r.changed) changes.push({ path: "辅助文档/02_人物台账.md", kind: "characters" });
  }
  if (timeline.length) {
    const r = await appendSection(
      path.join(projectDir, "辅助文档", "04_时间线.md"),
      title + " · 时间线 · " + now.slice(0, 10),
      timeline.map((x) => "- " + x).join("\n")
    );
    if (r.changed) changes.push({ path: "辅助文档/04_时间线.md", kind: "timeline" });
  }
  if (foreshadow.length) {
    const r = await appendSection(
      path.join(projectDir, "辅助文档", "05_伏笔管理.md"),
      title + " · 伏笔 · " + now.slice(0, 10),
      foreshadow.map((x) => "- " + x).join("\n")
    );
    if (r.changed) changes.push({ path: "辅助文档/05_伏笔管理.md", kind: "foreshadow" });
  }
  if (timeline.length || foreshadow.length) {
    const softPath = path.join(projectDir, "辅助文档", "11_时间线与伏笔.md");
    const softBody = [
      "",
      "## 确认回写 · " + title + " · " + now.slice(0, 16).replace("T", " "),
      "",
      timeline.length ? "### 时间节点\n" + timeline.map((x) => "- " + x).join("\n") : "",
      foreshadow.length ? "### 伏笔\n" + foreshadow.map((x) => "- " + x).join("\n") : "",
      ""
    ].filter(Boolean).join("\n");
    try {
      const prev = await readText(softPath, "# 时间线与伏笔（软台账）\n");
      await writeText(softPath, prev.trimEnd() + "\n" + softBody + "\n");
      changes.push({ path: "辅助文档/11_时间线与伏笔.md", kind: "soft-timeline" });
    } catch {}
  }

  await writeText(
    path.join(projectDir, reviewRel),
    [
      "# " + title + " 确认记录",
      "",
      "- 时间：" + now,
      "- 作者确认：是",
      summary ? "- 摘要：" + summary : "",
      nextHook ? "- 下一钩子：" + nextHook : "",
      "- 正式正文：" + proseRel,
      ""
    ].filter(Boolean).join("\n")
  );
  changes.push({ path: reviewRel, kind: "review" });

  if (input.saveCandidateSnapshot === true) {
    await writeText(path.join(projectDir, candidateRel), proseDoc);
    changes.push({ path: candidateRel, kind: "candidate-archive" });
  }

  return {
    ok: true,
    projectDir,
    title,
    confirmedAt: now,
    prosePath: proseRel,
    updated: changes,
    message: "已写入正式正文并整理台账。无需外部工作流。"
  };
}

async function describeOrganizedWorkflow(pluginRoot) {
  const base = describeBuiltinWorkflow(pluginRoot);
  return {
    ...base,
    noExternalWorkflowNeeded: true,
    autoLedger: true,
    tools: {
      create: "fiction_create_project",
      scaffold: "fiction_scaffold_book_folder",
      ensure: "fiction_ensure_book_workspace",
      confirm: "fiction_confirm_chapter_ledgers",
      guide: "fiction_workflow_guide"
    },
    principle: "插件内置 skill + 模板 + 台账整理；确认章节后自动更新正文与辅助台账。"
  };
}

module.exports = {
  ensureBookWorkspace,
  confirmChapterToLedgers,
  describeOrganizedWorkflow
};
