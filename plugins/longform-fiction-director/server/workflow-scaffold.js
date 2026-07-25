"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

function pluginRootFrom(moduleUrl) {
  // server/ -> plugin root
  return path.resolve(path.dirname(moduleUrl), "..");
}

function workflowAssetsRoot(pluginRoot = pluginRootFrom(__filename)) {
  return path.join(pluginRoot, "assets", "workflow");
}

function projectTemplateRoot(pluginRoot = pluginRootFrom(__filename)) {
  return path.join(workflowAssetsRoot(pluginRoot), "project-template");
}

async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDirIfMissing(from, to, { overwrite = false } = {}) {
  if (!(await pathExists(from))) throw new Error("Built-in workflow template is missing: " + from);
  await fsp.mkdir(to, { recursive: true });
  const entries = await fsp.readdir(from, { withFileTypes: true });
  const written = [];
  for (const entry of entries) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      const nested = await copyDirIfMissing(src, dst, { overwrite });
      written.push(...nested);
      continue;
    }
    if (!overwrite && await pathExists(dst)) continue;
    await fsp.mkdir(path.dirname(dst), { recursive: true });
    await fsp.copyFile(src, dst);
    written.push(dst);
  }
  return written;
}

async function listTemplateFiles(root) {
  const out = [];
  async function walk(dir, rel = "") {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const nextRel = rel ? path.join(rel, entry.name) : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs, nextRel);
      else out.push(nextRel.replace(/\\/g, "/"));
    }
  }
  if (await pathExists(root)) await walk(root);
  return out.sort();
}

/**
 * Scaffold author-facing Chinese book folders into targetDir.
 * Does not delete existing files unless overwrite=true.
 */
async function scaffoldBookFolder(targetDir, {
  title = "",
  pluginRoot = pluginRootFrom(__filename),
  overwrite = false
} = {}) {
  const abs = path.resolve(String(targetDir || "").trim());
  if (!abs || abs === path.parse(abs).root) throw new Error("targetDir is invalid");
  const templateRoot = projectTemplateRoot(pluginRoot);
  if (!(await pathExists(templateRoot))) throw new Error("Built-in project template missing");

  await fsp.mkdir(abs, { recursive: true });
  const written = await copyDirIfMissing(templateRoot, abs, { overwrite: overwrite === true });

  // personalize status file title if present
  const statusPath = path.join(abs, "辅助文档", "00_使用说明与当前状态.md");
  if (title && await pathExists(statusPath)) {
    let text = await fsp.readFile(statusPath, "utf8");
    if (!text.includes(String(title))) {
      text = text.replace(/^#\s*.+$/m, (line) => line + "\n\n> 书名：" + String(title).trim());
      await fsp.writeFile(statusPath, text, "utf8");
    }
  }

  const files = await listTemplateFiles(abs);
  return {
    ok: true,
    path: abs,
    title: String(title || "").trim() || path.basename(abs),
    writtenCount: written.length,
    templateFiles: await listTemplateFiles(templateRoot),
    presentFiles: files,
    suggestedBind: {
      auxiliaryPath: "辅助文档/00_使用说明与当前状态.md",
      auxiliaryPaths: [
        "辅助文档/00_使用说明与当前状态.md",
        "辅助文档/01_全书大纲.md",
        "辅助文档/02_人物台账.md",
        "辅助文档/03_世界观与设定.md",
        "辅助文档/04_时间线.md",
        "辅助文档/05_伏笔管理.md",
        "辅助文档/06_风格与写作要求.md"
      ],
      styleAnchorPath: "辅助文档/06_风格与写作要求.md"
    }
  };
}

function describeBuiltinWorkflow(pluginRoot = pluginRootFrom(__filename)) {
  const root = workflowAssetsRoot(pluginRoot);
  return {
    ok: true,
    root,
    projectTemplate: path.join(root, "project-template"),
    auxiliaryBase: path.join(root, "auxiliary-base"),
    docs: path.join(root, "docs"),
    steps: [
      "绑定",
      "脑洞(本地)",
      "细纲",
      "候选正文",
      "去AI味(可选)",
      "质检(可选)",
      "确认入台账"
    ]
  };
}

module.exports = {
  workflowAssetsRoot,
  projectTemplateRoot,
  scaffoldBookFolder,
  describeBuiltinWorkflow,
  listTemplateFiles
};
