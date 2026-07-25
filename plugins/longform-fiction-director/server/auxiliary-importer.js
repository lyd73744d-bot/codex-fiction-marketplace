const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const SUPPORTED_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function classify(relativePath) {
  if (/人物|角色|主角/u.test(relativePath)) return "characters";
  if (/时间线|时序|年表/u.test(relativePath)) return "timeline";
  if (/伏笔|回收|悬念/u.test(relativePath)) return "foreshadowing";
  if (/世界观|设定|地图|规则/u.test(relativePath)) return "world";
  if (/剧情|大纲|卷纲|细纲/u.test(relativePath)) return "plot";
  return "working";
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function plainProjectDirectory(directoryPath, projectRealPath) {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw createError("UNSAFE_PROJECT_DIRECTORY", "Project import directories must be plain directories.");
  }

  const realPath = await fs.realpath(directoryPath);
  if (projectRealPath && !isWithin(projectRealPath, realPath)) {
    throw createError("UNSAFE_PROJECT_DIRECTORY", "Project import directories cannot escape the project.");
  }
  return realPath;
}

async function ensureSafeProjectDirectory(projectPath, directorySegments) {
  const resolvedProjectPath = path.resolve(projectPath);
  await fs.mkdir(resolvedProjectPath, { recursive: true });
  const projectRealPath = await plainProjectDirectory(resolvedProjectPath);
  let directoryPath = resolvedProjectPath;

  for (const segment of directorySegments) {
    directoryPath = path.join(directoryPath, segment);
    try {
      await fs.mkdir(directoryPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await plainProjectDirectory(directoryPath, projectRealPath);
  }

  return { directoryPath, projectRealPath };
}

async function safeProjectFile(projectPath, directorySegments, fileName) {
  const { directoryPath, projectRealPath } = await ensureSafeProjectDirectory(projectPath, directorySegments);
  const filePath = path.join(directoryPath, fileName);
  let stats;
  try {
    stats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return { filePath, projectRealPath };
    throw error;
  }

  const realPath = await fs.realpath(filePath);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1 || !isWithin(projectRealPath, realPath)) {
    throw createError("UNSAFE_PROJECT_DIRECTORY", "Project import files must be unlinked regular files inside the project.");
  }
  return { filePath, projectRealPath };
}

async function readProjectJson(projectPath, directorySegments, fileName, fallback) {
  const { filePath } = await safeProjectFile(projectPath, directorySegments, fileName);
  return readJson(filePath, fallback);
}

async function writeProjectFile(projectPath, directorySegments, fileName, contents) {
  const target = await safeProjectFile(projectPath, directorySegments, fileName);
  await safeProjectFile(projectPath, directorySegments, fileName);
  await fs.writeFile(target.filePath, contents, "utf8");
  await safeProjectFile(projectPath, directorySegments, fileName);
  return target.filePath;
}

async function findSupportedFiles(sourceRoot, currentPath = sourceRoot) {
  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(currentPath, entry.name);
    if (entry.isSymbolicLink()) {
      const targetPath = await fs.realpath(entryPath).catch(() => null);
      if (!targetPath || !isWithin(sourceRoot, targetPath)) {
        throw createError("SOURCE_SYMLINK_ESCAPE", "Imported material cannot escape its selected source directory.");
      }
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...await findSupportedFiles(sourceRoot, entryPath));
      continue;
    }
    if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      files.push(entryPath);
    }
  }

  return files;
}

function createAuxiliaryImporter() {
  async function importDirectory({ projectPath, sourcePath }) {
    if (!projectPath || !sourcePath) {
      throw createError("PROJECT_AND_SOURCE_REQUIRED", "Project path and source path are required.");
    }

    const resolvedProjectPath = path.resolve(projectPath);
    const sourceRoot = await fs.realpath(sourcePath);
    const sourceStats = await fs.stat(sourceRoot);
    if (!sourceStats.isDirectory()) {
      throw createError("SOURCE_NOT_DIRECTORY", "The selected auxiliary material must be a directory.");
    }

    const files = await findSupportedFiles(sourceRoot);
    const importDirectories = [".fiction-director", "imports"];
    const manifestPath = path.join(resolvedProjectPath, ...importDirectories, "manifest.json");
    const manifest = await readProjectJson(resolvedProjectPath, importDirectories, "manifest.json", {
      version: 1,
      sources: [],
      duplicates: []
    });
    const sourceKeys = new Set(manifest.sources.map((entry) => `${entry.sourceRoot}\u0000${entry.relativePath}`));
    const importedByHash = new Map(manifest.sources.map((entry) => [entry.sha256, entry]));
    let importedFiles = 0;

    for (const filePath of files) {
      const relativePath = path.relative(sourceRoot, filePath);
      if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw createError("SOURCE_PATH_ESCAPE", "Imported material must stay inside the selected directory.");
      }

      const sourceKey = `${sourceRoot}\u0000${relativePath}`;
      if (sourceKeys.has(sourceKey)) continue;

      const contents = await fs.readFile(filePath);
      const hash = sha256(contents);
      const original = importedByHash.get(hash);
      if (original) {
        manifest.duplicates.push({
          sourceRoot,
          relativePath,
          sha256: hash,
          duplicateOf: original.relativePath
        });
        sourceKeys.add(sourceKey);
        continue;
      }

      const extension = path.extname(filePath).toLowerCase() || ".txt";
      const importRelativePath = path.posix.join("files", `${hash}${extension}`);
      await writeProjectFile(
        resolvedProjectPath,
        [...importDirectories, "files"],
        path.basename(importRelativePath),
        contents
      );

      const entry = {
        sourceRoot,
        relativePath: relativePath.split(path.sep).join("/"),
        importRelativePath,
        sha256: hash,
        classification: classify(relativePath),
        importedAt: new Date().toISOString()
      };
      manifest.sources.push(entry);
      importedByHash.set(hash, entry);
      sourceKeys.add(sourceKey);
      importedFiles += 1;
    }

    await writeProjectFile(resolvedProjectPath, importDirectories, "manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    await writeLedgerArtifacts(resolvedProjectPath, manifest);
    return { importedFiles, sourceRoot, manifestPath, manifest };
  }

  return { importDirectory };
}

async function writeLedgerArtifacts(projectPath, manifest) {
  const directorDirectories = [".fiction-director"];
  const ledgerDirectories = [...directorDirectories, "ledger"];
  const workingEntries = manifest.sources.filter((entry) => entry.classification === "working");
  const factEntries = manifest.sources.filter((entry) => entry.classification !== "working");
  const rules = [
    "# Confirmed facts",
    "",
    "> 正文原文优先（Prose facts take priority over ledger summaries and AI guesses.）",
    "> Only author-confirmed material belongs here. The agent must not invent missing facts.",
    ""
  ];

  if (factEntries.length) {
    rules.push("## Imported evidence", "");
    for (const entry of factEntries) {
      rules.push(`- [${entry.classification}] ${entry.relativePath} (${entry.sha256.slice(0, 12)})`);
    }
    rules.push("");
  }
  await writeProjectFile(projectPath, ledgerDirectories, "facts.md", `${rules.join("\n")}\n`);

  const categoryEntries = new Map();
  for (const entry of factEntries) {
    const entries = categoryEntries.get(entry.classification) || [];
    entries.push(entry);
    categoryEntries.set(entry.classification, entries);
  }
  for (const [category, entries] of categoryEntries) {
    const body = [`# ${category}`, "", "> Imported source material. Preserve its meaning; do not treat model inference as fact.", ""];
    for (const entry of entries) {
      body.push(`- ${entry.relativePath} -> ../imports/${entry.importRelativePath}`);
    }
    await writeProjectFile(projectPath, ledgerDirectories, `${category}.md`, `${body.join("\n")}\n`);
  }

  const notes = ["# Imported working notes", "", "> 待作者确认（Awaiting author confirmation.）", "> These notes are usable for brainstorming, not as settled story facts.", ""];
  for (const entry of workingEntries) {
    notes.push(`- ${entry.relativePath} -> ../imports/${entry.importRelativePath}`);
  }
  await writeProjectFile(projectPath, [...directorDirectories, "working"], "import-notes.md", `${notes.join("\n")}\n`);
}

module.exports = { createAuxiliaryImporter };
