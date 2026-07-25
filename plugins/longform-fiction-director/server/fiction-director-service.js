"use strict";
const { bootstrapProject } = require("./project-bootstrap");

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const { createAuxiliaryImporter } = require("./auxiliary-importer");
const { getInkOsCapability } = require("./inkos-capability-catalog");
const { buildInkOsPromptContext } = require("./inkos-prompt-runtime");
const { createTaskStore } = require("./task-store");
const { createProjectStore } = require("./zizhuji-compat/server/project-store");
const { scaffoldBookFolder } = require("./workflow-scaffold");
const { ensureBookWorkspace } = require("./ledger-organizer");

const MAX_LEDGER_FILES = 128;
const MAX_LEDGER_FILE_BYTES = 64 * 1024;
const MAX_LEDGER_TOTAL_BYTES = 256 * 1024;
const MAX_PROJECT_STATE_FILE_BYTES = 64 * 1024;
const MAX_PROJECT_STATE_TOTAL_BYTES = 128 * 1024;
const MAX_SOURCE_ENTRIES = 256;
const MAX_SOURCE_METADATA_BYTES = 32 * 1024;
const MAX_SOURCE_METADATA_TOTAL_BYTES = 512 * 1024;

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function settlementFingerprint(projectId, instruction, options) {
  const confirmedProse = typeof options.confirmedProse === "string" ? options.confirmedProse.trim() : "";
  const accepted = options.authorAccepted === true
    || options.explicitAuthorAcceptance === true
    || options.authorAcceptance === true;
  const acceptedProse = accepted && typeof options.prose === "string" ? options.prose.trim() : "";
  const prose = confirmedProse || acceptedProse;
  if (!prose) return null;
  return crypto.createHash("sha256")
    .update(JSON.stringify([projectId, instruction, prose]))
    .digest("hex");
}

function taskArtifactPaths(output) {
  const paths = new Set();
  function collect(value, depth = 0) {
    if (depth > 4 || paths.size >= 8 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (value.startsWith(".fiction-director/") && value.length <= 512) paths.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 16)) collect(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value).slice(0, 32)) collect(item, depth + 1);
    }
  }
  collect(output);
  return [...paths];
}

function projectTaskSummary(task) {
  const error = task?.error && typeof task.error === "object"
    ? { code: String(task.error.code || "TASK_FAILED").slice(0, 80), message: String(task.error.message || "").slice(0, 500) }
    : null;
  return {
    id: String(task?.id || ""),
    kind: String(task?.kind || "unknown"),
    status: String(task?.status || "unknown"),
    instruction: String(task?.instruction || "").slice(0, 500),
    createdAt: task?.createdAt || null,
    updatedAt: task?.updatedAt || null,
    artifactPaths: taskArtifactPaths(task?.output),
    error
  };
}

function projectSlug(title) {
  const slug = String(title || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48);
  return slug || "fiction-project";
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeIfMissing(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, contents, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
}

async function readText(filePath, fallback = "") {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === ""
    || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isSamePath(left, right) {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

async function plainDirectory(directoryPath, code, message) {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw createError(code, message);
  }
  return fs.realpath(directoryPath);
}

async function readBoundedRegularFile(filePath, {
  containmentRoot,
  maxBytes,
  unsafeCode,
  tooLargeCode,
  budget,
  totalTooLargeCode,
  missingValue
}) {
  let expectedStats;
  try {
    expectedStats = await fs.lstat(filePath);
  } catch (error) {
    if (error.code === "ENOENT" && missingValue !== undefined) return missingValue;
    throw error;
  }
  const realFilePath = await fs.realpath(filePath);
  if (expectedStats.isSymbolicLink()
    || !expectedStats.isFile()
    || expectedStats.nlink !== 1
    || !isWithin(containmentRoot, realFilePath)) {
    throw createError(unsafeCode, "Project state files must be unlinked regular files inside the project.");
  }
  if (expectedStats.size > maxBytes) {
    throw createError(tooLargeCode, `Project state files cannot exceed ${maxBytes} bytes.`);
  }

  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()
      || stats.nlink !== 1
      || stats.dev !== expectedStats.dev
      || stats.ino !== expectedStats.ino) {
      throw createError(unsafeCode, "Project state files changed while being read.");
    }
    if (stats.size > maxBytes) {
      throw createError(tooLargeCode, `Project state files cannot exceed ${maxBytes} bytes.`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) {
      throw createError(tooLargeCode, `Project state files cannot exceed ${maxBytes} bytes.`);
    }
    if (budget) {
      budget.used += bytesRead;
      if (budget.used > budget.max) {
        throw createError(totalTooLargeCode, `Project state files cannot exceed ${budget.max} bytes in total.`);
      }
    }
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle?.close().catch(() => {});
  }
}

function responseText(response) {
  if (typeof response === "string") return response;
  if (!response || typeof response !== "object") return "";
  for (const key of ["content", "text", "outputText", "output_text"]) {
    if (typeof response[key] === "string") return response[key];
    if (Array.isArray(response[key])) {
      const content = response[key]
        .map((item) => typeof item === "string" ? item : item?.text || item?.content || "")
        .filter(Boolean)
        .join("\n");
      if (content) return content;
    }
  }
  if (Array.isArray(response.results)) return response.results.map(responseText).filter(Boolean).join("\n");
  return "";
}

function safeName(value, fallback) {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  return normalized || fallback;
}

function errorDetails(error) {
  return {
    code: error?.code || "TASK_FAILED",
    message: error?.message || String(error),
    name: error?.name || "Error"
  };
}

async function ensureSafeParent(containmentRoot, parentPath) {
  const resolvedRoot = path.resolve(containmentRoot);
  const resolvedParent = path.resolve(parentPath);
  if (!isWithin(resolvedRoot, resolvedParent)) {
    throw createError("OUTPUT_PATH_OUTSIDE_PROJECT", "Task output must stay inside the project.");
  }

  const rootStats = await fs.lstat(resolvedRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw createError("OUTPUT_PATH_UNSAFE", "The project output root is not a plain directory.");
  }
  const realRoot = await fs.realpath(resolvedRoot);
  let currentPath = resolvedRoot;
  const relativePath = path.relative(resolvedRoot, resolvedParent);
  for (const segment of relativePath.split(path.sep).filter(Boolean)) {
    currentPath = path.join(currentPath, segment);
    try {
      await fs.mkdir(currentPath);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stats = await fs.lstat(currentPath);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw createError("OUTPUT_PATH_UNSAFE", "Task output directories cannot contain links.");
    }
  }

  const realParent = await fs.realpath(resolvedParent);
  if (!isWithin(realRoot, realParent)) {
    throw createError("OUTPUT_PATH_UNSAFE", "Task output escaped the project through a linked directory.");
  }
}

async function atomicWrite(filePath, contents, containmentRoot) {
  const stagingRoot = path.join(path.dirname(path.resolve(containmentRoot)), ".fiction-director-output-staging");
  const resolvedPath = path.resolve(filePath);
  if (!isWithin(containmentRoot, resolvedPath)) {
    throw createError("OUTPUT_PATH_OUTSIDE_PROJECT", "Task output must stay inside the project.");
  }
  await ensureSafeParent(containmentRoot, path.dirname(resolvedPath));
  await fs.mkdir(stagingRoot, { recursive: true });
  const stagingStats = await fs.lstat(stagingRoot);
  if (stagingStats.isSymbolicLink() || !stagingStats.isDirectory()) {
    throw createError("OUTPUT_PATH_UNSAFE", "The output staging root is not a plain directory.");
  }
  const temporaryPath = path.join(await fs.realpath(stagingRoot), `${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporaryPath, String(contents), { encoding: "utf8", flag: "wx" });
    await ensureSafeParent(containmentRoot, path.dirname(resolvedPath));
    try {
      await fs.link(temporaryPath, resolvedPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw createError("OUTPUT_PATH_UNSAFE", "Task output already exists or changed during publishing.");
      }
      throw error;
    }
    await ensureSafeParent(containmentRoot, path.dirname(resolvedPath));
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
  return resolvedPath;
}

async function readBounded(filePath, maxBytes) {
  let handle;
  try {
    handle = await fs.open(filePath, "r");
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function requireDependency(dependency, code, message) {
  if (!dependency) throw createError(code, message);
  return dependency;
}

function createFictionDirector({
  projectsRoot,
  importer,
  gateway,
  marketResearch,
  downloadProvider,
  deconstructionService,
  ledgerTransaction
} = {}) {
  if (!projectsRoot) throw new TypeError("projectsRoot is required");

  const resolvedProjectsRoot = path.resolve(projectsRoot);
  const auxiliaryImporter = importer || createAuxiliaryImporter();
  const taskStore = createTaskStore({ projectsRoot: resolvedProjectsRoot });
  const committedSettlements = new Map();
  let defaultSettlementProjectStore = null;

  async function defaultLedgerTransaction({ projectPath, prose, instruction, transactionId, chapterId }) {
    defaultSettlementProjectStore ||= createProjectStore({
      registryPath: path.join(resolvedProjectsRoot, ".fiction-director", "settlement-projects.json")
    });
    const registered = await defaultSettlementProjectStore.registerProject(projectPath);
    const project = await defaultSettlementProjectStore.openProject(registered.id);
    const chapterName = safeName(chapterId, `chapter-${transactionId}`);
    const chapterRelativePath = `chapters/${chapterName}.md`;
    const ledgerRelativePath = `.fiction-director/ledger/settlements/${chapterName}.md`;
    const acceptedAt = new Date().toISOString();
    const ledgerEntry = [
      `# Accepted chapter ${chapterName}`,
      "",
      `- Accepted at: ${acceptedAt}`,
      `- Task: ${transactionId}`,
      instruction ? `- Note: ${String(instruction).slice(0, 1000)}` : "",
      "",
      "The formal prose is stored in the matching chapter file."
    ].filter(Boolean).join("\n");
    await project.writeTexts([
      { relativePath: chapterRelativePath, content: `${prose}\n`, expectedContent: null },
      { relativePath: ledgerRelativePath, content: `${ledgerEntry}\n`, expectedContent: null }
    ], { transactionId: `settle-${transactionId}`.slice(0, 128) });
    return { committed: true, chapterRelativePath, ledgerRelativePath, acceptedAt };
  }

  async function projectsRootPath(create = false) {
    if (create) await fs.mkdir(resolvedProjectsRoot, { recursive: true });
    return plainDirectory(
      resolvedProjectsRoot,
      "PROJECT_ROOT_UNSAFE",
      "The configured projects root is not a plain directory."
    );
  }

  async function loadProject(projectId, { missingAsNull = false } = {}) {
    if (typeof projectId !== "string" || !projectId || path.basename(projectId) !== projectId) {
      if (missingAsNull) return null;
      throw createError("PROJECT_NOT_FOUND", `Project ${projectId} was not found.`);
    }

    const realProjectsRoot = await projectsRootPath();
    const projectPath = path.join(realProjectsRoot, projectId);
    let realProjectPath;
    try {
      realProjectPath = await plainDirectory(
        projectPath,
        "PROJECT_PATH_UNSAFE",
        "The project directory is not a plain directory."
      );
    } catch (error) {
      if (missingAsNull && error.code === "ENOENT") return null;
      if (missingAsNull && error.code === "PROJECT_PATH_UNSAFE") return null;
      throw error;
    }
    if (!isWithin(realProjectsRoot, realProjectPath)) {
      throw createError("PROJECT_PATH_UNSAFE", "The project directory escapes the projects root.");
    }

    const directorPath = path.join(realProjectPath, ".fiction-director");
    let realDirectorPath;
    try {
      realDirectorPath = await plainDirectory(
        directorPath,
        "PROJECT_PATH_UNSAFE",
        "The .fiction-director directory is not a plain directory."
      );
    } catch (error) {
      if (missingAsNull && error.code === "ENOENT") return null;
      throw error;
    }
    if (!isWithin(realProjectPath, realDirectorPath)) {
      throw createError("PROJECT_PATH_UNSAFE", "The .fiction-director directory escapes the project.");
    }

    const metadataPath = path.join(realDirectorPath, "project.json");
    let metadata;
    try {
      metadata = JSON.parse(await readBoundedRegularFile(metadataPath, {
        containmentRoot: realDirectorPath,
        maxBytes: MAX_PROJECT_STATE_FILE_BYTES,
        unsafeCode: "PROJECT_METADATA_INVALID",
        tooLargeCode: "PROJECT_METADATA_INVALID"
      }));
    } catch (error) {
      if (missingAsNull && error.code === "ENOENT") return null;
      if (error.code === "PROJECT_METADATA_INVALID") throw error;
      throw createError("PROJECT_METADATA_INVALID", "Project metadata is invalid.");
    }

    let metadataPathReal;
    try {
      metadataPathReal = typeof metadata?.path === "string" ? await fs.realpath(metadata.path) : null;
    } catch {
      metadataPathReal = null;
    }
    if (!metadata || metadata.id !== projectId || !metadataPathReal || !isSamePath(metadataPathReal, realProjectPath)) {
      throw createError("PROJECT_METADATA_INVALID", "Project metadata does not match its directory.");
    }

    return { ...metadata, id: projectId, path: realProjectPath };
  }

  async function createProject({ title, direction = "" } = {}) {
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) throw createError("PROJECT_TITLE_REQUIRED", "A project title is required.");

    const realProjectsRoot = await projectsRootPath(true);
    const id = `${projectSlug(normalizedTitle)}-${crypto.randomUUID().slice(0, 8)}`;
    const projectPath = path.join(realProjectsRoot, id);
    const directorPath = path.join(projectPath, ".fiction-director");
    const createdAt = new Date().toISOString();
    const project = {
      id,
      title: normalizedTitle,
      direction: String(direction || "").trim(),
      path: projectPath,
      createdAt,
      updatedAt: createdAt
    };

    const directories = [
      "history/tasks",
      "imports/files",
      "ledger",
      "learning/candidates",
      "research/deconstructions",
      "sources/books",
      "working/drafts",
      "working/research"
    ];
    await Promise.all(directories.map((relativePath) => fs.mkdir(path.join(directorPath, relativePath), { recursive: true })));
    project.path = await fs.realpath(projectPath);
    await fs.writeFile(path.join(directorPath, "project.json"), `${JSON.stringify(project, null, 2)}\n`, "utf8");

    await Promise.all([
      writeIfMissing(
        path.join(directorPath, "ledger", "facts.md"),
        "# Confirmed facts\n\n> 正文原文优先。只有作者确认的选择和正式正文事实可以进入本台账。\n"
      ),
      writeIfMissing(
        path.join(directorPath, "working", "ideas.md"),
        "# Ideas\n\n> 待作者确认（Awaiting author confirmation.）\n"
      ),
      writeIfMissing(
        path.join(directorPath, "learning", "feedback.md"),
        "# Feedback evidence\n\n记录作者接受、拒绝和手改的事实，不猜测动机。\n"
      ),
      writeIfMissing(
        path.join(directorPath, "learning", "active-skill.md"),
        "# Active project rules\n\n> 候选规则通过对照评测并明确批准后才写入。\n"
      ),
      writeIfMissing(
        path.join(directorPath, "imports", "manifest.json"),
        `${JSON.stringify({ version: 1, sources: [], duplicates: [] }, null, 2)}\n`
      )
    ]);

    
    // Built-in Chinese writing workflow folders (辅助文档/细纲/正文/...)
    let bookWorkspace = null;
    try {
      bookWorkspace = await ensureBookWorkspace(projectPath, {
        title: normalizedTitle,
        pluginRoot: path.join(__dirname, ".."),
        overwrite: false
      });
    } catch (error) {
      bookWorkspace = { ok: false, error: error && error.message ? error.message : String(error) };
    }

    let guidedBootstrap = null;
    try { guidedBootstrap = await bootstrapProject(projectPath, { title: normalizedTitle }); }
    catch (error) { guidedBootstrap = { ok: false, error: error && error.message ? error.message : String(error) }; }
    return Object.assign({}, project, { bookWorkspace, guidedBootstrap });

  }

  async function listProjects() {
    let entries;
    try {
      entries = await fs.readdir(await projectsRootPath(), { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }

    const projects = await Promise.all(entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => loadProject(entry.name, { missingAsNull: true })));

    return projects.filter(Boolean).sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  }

  async function openProject(projectId) {
    let project;
    try {
      project = await loadProject(projectId);
    } catch (error) {
      if (error.code === "ENOENT") project = null;
      else throw error;
    }
    if (!project) throw createError("PROJECT_NOT_FOUND", `Project ${projectId} was not found.`);
    return project;
  }

  async function importAuxiliary({ projectId, sourcePath }) {
    const project = await openProject(projectId);
    return auxiliaryImporter.importDirectory({ projectPath: project.path, sourcePath });
  }

  async function listSources(projectId) {
    const project = await openProject(projectId);
    const directorPath = path.join(project.path, ".fiction-director");
    const booksDirectory = path.join(directorPath, "sources", "books");
    let realBooksDirectory;
    try {
      realBooksDirectory = await plainDirectory(
        booksDirectory,
        "SOURCE_LIBRARY_UNSAFE",
        "The registered book source library must be a plain directory."
      );
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    if (!isWithin(directorPath, realBooksDirectory)) {
      throw createError("SOURCE_LIBRARY_UNSAFE", "The registered book source library escapes the project.");
    }

    const budget = { used: 0, max: MAX_SOURCE_METADATA_TOTAL_BYTES };
    const sources = [];
    let entryCount = 0;
    const directory = await fs.opendir(booksDirectory);
    for await (const entry of directory) {
      entryCount += 1;
      if (entryCount > MAX_SOURCE_ENTRIES) {
        throw createError("SOURCE_ENTRY_LIMIT", `The registered source library cannot exceed ${MAX_SOURCE_ENTRIES} entries.`);
      }
      if (entry.isSymbolicLink()) {
        throw createError("SOURCE_LIBRARY_UNSAFE", "Registered source directories cannot be symbolic links.");
      }
      if (!entry.isDirectory()) continue;

      const sourceDirectory = path.join(booksDirectory, entry.name);
      const realSourceDirectory = await plainDirectory(
        sourceDirectory,
        "SOURCE_LIBRARY_UNSAFE",
        "Registered source entries must be plain directories."
      );
      if (!isWithin(realBooksDirectory, realSourceDirectory)) {
        throw createError("SOURCE_LIBRARY_UNSAFE", "A registered source directory escapes the project.");
      }

      let metadataText;
      try {
        metadataText = await readBoundedRegularFile(path.join(sourceDirectory, "source.json"), {
          containmentRoot: realSourceDirectory,
          maxBytes: MAX_SOURCE_METADATA_BYTES,
          unsafeCode: "SOURCE_METADATA_UNSAFE",
          tooLargeCode: "SOURCE_METADATA_TOO_LARGE",
          budget,
          totalTooLargeCode: "SOURCE_METADATA_TOTAL_TOO_LARGE"
        });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }

      let metadata;
      try {
        metadata = JSON.parse(metadataText);
      } catch {
        throw createError("SOURCE_METADATA_INVALID", "Registered source metadata must be valid JSON.");
      }
      const invalid = (message) => { throw createError("SOURCE_METADATA_INVALID", message); };
      const stringField = (name, maxLength, required = false) => {
        const value = metadata?.[name];
        if (value === undefined || value === null) {
          if (required) invalid(`Registered source metadata requires ${name}.`);
          return "";
        }
        if (typeof value !== "string" || value.length > maxLength || (required && !value.trim())) {
          invalid(`Registered source metadata has an invalid ${name}.`);
        }
        return value.trim();
      };
      const integerField = (name) => {
        const value = metadata?.[name];
        if (!Number.isSafeInteger(value) || value < 0) invalid(`Registered source metadata has an invalid ${name}.`);
        return value;
      };

      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || metadata.version !== 1) {
        invalid("Registered source metadata has an unsupported format.");
      }
      const sourceId = stringField("sourceId", 180, true);
      if (sourceId !== entry.name || sourceId === "." || sourceId === ".." || /[\\/]/u.test(sourceId)) {
        invalid("Registered source metadata does not match its source directory.");
      }
      const sourceRelativePath = stringField("sourceRelativePath", 512, true);
      const sourcePrefix = `.fiction-director/sources/books/${sourceId}/`;
      if (sourceRelativePath.includes("\\")
        || path.posix.isAbsolute(sourceRelativePath)
        || path.posix.normalize(sourceRelativePath) !== sourceRelativePath
        || !sourceRelativePath.startsWith(sourcePrefix)) {
        invalid("Registered source metadata contains an unsafe source path.");
      }

      const sourcePath = path.resolve(project.path, ...sourceRelativePath.split("/"));
      let expectedSourceStats;
      let realSourcePath;
      try {
        expectedSourceStats = await fs.lstat(sourcePath);
        realSourcePath = await fs.realpath(sourcePath);
      } catch {
        invalid("The registered source file is missing.");
      }
      if (expectedSourceStats.isSymbolicLink()
        || !expectedSourceStats.isFile()
        || expectedSourceStats.nlink !== 1
        || !isWithin(realSourceDirectory, realSourcePath)) {
        throw createError("SOURCE_FILE_UNSAFE", "Registered source files must be unlinked regular files inside their source directory.");
      }
      let sourceHandle;
      try {
        sourceHandle = await fs.open(sourcePath, "r");
        const currentSourceStats = await sourceHandle.stat();
        if (!currentSourceStats.isFile()
          || currentSourceStats.nlink !== 1
          || currentSourceStats.dev !== expectedSourceStats.dev
          || currentSourceStats.ino !== expectedSourceStats.ino) {
          throw createError("SOURCE_FILE_UNSAFE", "The registered source file changed while being inspected.");
        }
      } finally {
        await sourceHandle?.close().catch(() => {});
      }

      const type = stringField("type", 80, true);
      const title = stringField("title", 500, true);
      const author = stringField("author", 500);
      const focus = stringField("focus", 4000);
      const bookId = stringField("bookId", 200);
      const importedAt = stringField("importedAt", 64, true);
      if (!Number.isFinite(Date.parse(importedAt))) invalid("Registered source metadata has an invalid importedAt timestamp.");
      if (metadata.authorized !== true) invalid("Registered book sources must carry explicit authorization.");
      const sha256 = stringField("sha256", 64, true).toLowerCase();
      if (!/^[a-f0-9]{64}$/u.test(sha256)) invalid("Registered source metadata has an invalid sha256 digest.");

      sources.push({
        sourceId,
        type,
        title,
        author,
        focus,
        bookId,
        authorized: true,
        importedAt,
        chapterCount: integerField("chapterCount"),
        charCount: integerField("charCount"),
        sha256,
        sourceRelativePath
      });
    }

    return sources.sort((left, right) => (
      right.importedAt.localeCompare(left.importedAt) || left.sourceId.localeCompare(right.sourceId)
    ));
  }

  function ledgerSelection(selection) {
    if (selection === undefined) return null;
    if (!Array.isArray(selection)) {
      throw createError("LEDGER_SELECTION_INVALID", "Ledger file selection must be an array.");
    }
    return [...new Set(selection.map((value) => {
      const name = String(value || "");
      const fileName = name.toLowerCase().endsWith(".md") ? name : `${name}.md`;
      if (!name || path.basename(fileName) !== fileName || path.extname(fileName).toLowerCase() !== ".md") {
        throw createError("LEDGER_SELECTION_INVALID", "Ledger selections must be Markdown file names.");
      }
      return fileName;
    }))];
  }

  async function validatedLedgerEntries(project, selection) {
    const directorPath = path.join(project.path, ".fiction-director");
    const ledgerDirectory = path.join(directorPath, "ledger");
    const realLedgerDirectory = await plainDirectory(
      ledgerDirectory,
      "LEDGER_DIRECTORY_UNSAFE",
      "The ledger directory is not a plain directory."
    );
    if (!isWithin(directorPath, realLedgerDirectory)) {
      throw createError("LEDGER_DIRECTORY_UNSAFE", "The ledger directory escapes the project.");
    }

    const entries = [];
    let count = 0;
    const directory = await fs.opendir(ledgerDirectory);
    for await (const entry of directory) {
      count += 1;
      if (count > MAX_LEDGER_FILES) {
        throw createError("LEDGER_FILE_LIMIT", `Ledger contains more than ${MAX_LEDGER_FILES} entries.`);
      }
      if (path.extname(entry.name).toLowerCase() !== ".md") continue;
      const filePath = path.join(ledgerDirectory, entry.name);
      const fileStats = await fs.lstat(filePath);
      const realFilePath = await fs.realpath(filePath);
      if (fileStats.isSymbolicLink() || !fileStats.isFile() || fileStats.nlink !== 1 || !isWithin(realLedgerDirectory, realFilePath)) {
        throw createError("LEDGER_FILE_UNSAFE", "Ledger Markdown files must be unlinked regular files inside the ledger.");
      }
      entries.push({ name: entry.name, path: filePath, stats: fileStats });
    }

    const selected = ledgerSelection(selection);
    if (!selected) return entries;
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    return selected.map((name) => {
      const entry = byName.get(name);
      if (!entry) throw createError("LEDGER_FILE_NOT_FOUND", `Ledger file ${name} was not found.`);
      return entry;
    });
  }

  async function readLedgerEntry(entry, maxBytes) {
    let handle;
    try {
      handle = await fs.open(entry.path, "r");
      const stats = await handle.stat();
      if (!stats.isFile() || stats.nlink !== 1 || stats.dev !== entry.stats.dev || stats.ino !== entry.stats.ino) {
        throw createError("LEDGER_FILE_UNSAFE", "Ledger Markdown files changed while being read.");
      }
      if (maxBytes === undefined && stats.size > MAX_LEDGER_FILE_BYTES) {
        throw createError("LEDGER_FILE_TOO_LARGE", `Ledger files cannot exceed ${MAX_LEDGER_FILE_BYTES} bytes.`);
      }
      const limit = maxBytes === undefined ? MAX_LEDGER_FILE_BYTES : maxBytes;
      const buffer = Buffer.alloc(limit + (maxBytes === undefined ? 1 : 0));
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const read = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (read.bytesRead === 0) break;
        bytesRead += read.bytesRead;
      }
      if (maxBytes === undefined && bytesRead > MAX_LEDGER_FILE_BYTES) {
        throw createError("LEDGER_FILE_TOO_LARGE", `Ledger files cannot exceed ${MAX_LEDGER_FILE_BYTES} bytes.`);
      }
      const contents = buffer.subarray(0, bytesRead).toString("utf8");
      return { contents, bytesRead: Buffer.byteLength(contents, "utf8") };
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async function readLedger(projectId, selectedFiles) {
    const project = await openProject(projectId);
    const entries = await validatedLedgerEntries(project, selectedFiles);
    const ledger = {};
    let totalBytes = 0;
    for (const entry of entries) {
      const { contents, bytesRead } = await readLedgerEntry(entry);
      totalBytes += bytesRead;
      if (totalBytes > MAX_LEDGER_TOTAL_BYTES) {
        throw createError("LEDGER_TOTAL_TOO_LARGE", `Ledger cannot exceed ${MAX_LEDGER_TOTAL_BYTES} bytes.`);
      }
      ledger[path.basename(entry.name, ".md")] = contents;
    }
    return ledger;
  }

  async function projectState(projectId) {
    const project = await openProject(projectId);
    const directorPath = path.join(project.path, ".fiction-director");
    const budget = { used: 0, max: MAX_PROJECT_STATE_TOTAL_BYTES };
    const stateReadOptions = {
      containmentRoot: directorPath,
      maxBytes: MAX_PROJECT_STATE_FILE_BYTES,
      unsafeCode: "PROJECT_STATE_FILE_UNSAFE",
      tooLargeCode: "PROJECT_STATE_FILE_TOO_LARGE",
      budget,
      totalTooLargeCode: "PROJECT_STATE_TOTAL_TOO_LARGE"
    };
    await readBoundedRegularFile(
      path.join(directorPath, "project.json"),
      stateReadOptions
    );
    const manifestText = await readBoundedRegularFile(
      path.join(directorPath, "imports", "manifest.json"),
      { ...stateReadOptions, missingValue: null }
    );
    const manifest = manifestText === null
      ? { sources: [], duplicates: [] }
      : JSON.parse(manifestText);
    const activeSkill = await readBoundedRegularFile(
      path.join(directorPath, "learning", "active-skill.md"),
      { ...stateReadOptions, missingValue: "" }
    );
    const feedback = await readBoundedRegularFile(
      path.join(directorPath, "learning", "feedback.md"),
      { ...stateReadOptions, missingValue: "" }
    );
    const blueprint = await readBoundedRegularFile(
      path.join(directorPath, "blueprint.md"),
      { ...stateReadOptions, missingValue: "" }
    );
    const outline = await readBoundedRegularFile(
      path.join(directorPath, "working", "outline.md"),
      { ...stateReadOptions, missingValue: "" }
    );
    const recentTasks = (await taskStore.list({ projectId })).slice(0, 20).map(projectTaskSummary);
    const library = {
      importedSources: Array.isArray(manifest.sources) ? manifest.sources.length : 0,
      duplicateSources: Array.isArray(manifest.duplicates) ? manifest.duplicates.length : 0
    };
    const learning = { activeSkill, feedback };
    const writing = { blueprint, outline, recentTasks };
    if (Buffer.byteLength(JSON.stringify({ project, library, learning, writing }), "utf8") > MAX_PROJECT_STATE_TOTAL_BYTES) {
      throw createError(
        "PROJECT_STATE_TOTAL_TOO_LARGE",
        `Project state files cannot exceed ${MAX_PROJECT_STATE_TOTAL_BYTES} bytes in total.`
      );
    }

    return {
      project,
      ledger: await readLedger(projectId),
      library,
      learning,
      writing
    };
  }

  async function boundedProjectContext(project, selectedFiles) {
    const direction = String(project.direction || "").slice(0, 12_000);
    const directorPath = path.join(project.path, ".fiction-director");
    const artifactBudget = { used: 0, max: 48 * 1024 };
    const artifactReadOptions = {
      containmentRoot: directorPath,
      maxBytes: 32 * 1024,
      unsafeCode: "PROJECT_CONTEXT_FILE_UNSAFE",
      tooLargeCode: "PROJECT_CONTEXT_FILE_TOO_LARGE",
      budget: artifactBudget,
      totalTooLargeCode: "PROJECT_CONTEXT_TOTAL_TOO_LARGE",
      missingValue: ""
    };
    const [blueprint, workingOutline] = await Promise.all([
      readBoundedRegularFile(path.join(directorPath, "blueprint.md"), artifactReadOptions),
      readBoundedRegularFile(path.join(directorPath, "working", "outline.md"), artifactReadOptions)
    ]);
    const entries = await validatedLedgerEntries(project, selectedFiles);

    const pieces = [];
    let remaining = 64_000;
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (remaining <= 0) continue;
      const amount = Math.min(remaining, 16_000);
      const { contents } = await readLedgerEntry(entry, amount);
      if (!contents) continue;
      pieces.push(`${entry.name}:\n${contents}`);
      remaining -= Buffer.byteLength(contents, "utf8");
    }

    const context = [
      "项目方向（只读上下文）：",
      direction,
      ...(blueprint ? ["已确认蓝图（只读上下文）：", blueprint] : []),
      ...(workingOutline ? ["工作大纲（未确认，只读上下文）：", workingOutline] : []),
      "已确认台账（只读上下文，不能把草稿推断成事实）：",
      pieces.join("\n\n")
    ];
    return context.join("\n");
  }

  function outputPath(project, relativePath) {
    const target = path.resolve(project.path, ...relativePath.split("/"));
    if (!isWithin(project.path, target)) {
      throw createError("OUTPUT_PATH_OUTSIDE_PROJECT", "Task output must stay inside the project.");
    }
    return target;
  }

  async function callModels(taskId, taskType, modelIds, instruction, promptOptions = {}) {
    const service = requireDependency(
      gateway,
      "GATEWAY_REQUIRED",
      `${taskType} requires a gateway with callModels.`
    );
    if (typeof service.callModels !== "function") {
      throw createError("GATEWAY_INVALID", "The injected gateway must expose callModels.");
    }
    let selectedModelIds = Array.isArray(modelIds) ? modelIds.filter((id) => typeof id === "string" && id.trim()) : [];
    if (selectedModelIds.length === 0 && typeof service.listModels === "function") {
      const catalog = await service.listModels();
      const models = Array.isArray(catalog) ? catalog : catalog?.models;
      const candidates = Array.isArray(models) ? models.filter((model) => typeof model?.id === "string" && model.id) : [];
      if (candidates.length === 0) throw createError("MODEL_UNAVAILABLE", "No models are available to the logged-in account.");
      const keywords = taskType === "review" ? ["review", "audit", "reason"]
        : taskType === "outline" || taskType === "chapter-brief" ? ["reason", "plan", "think"]
          : ["write", "creative", "novel", "prose"];
      const best = [...candidates].sort((left, right) => {
        const score = (model) => keywords.reduce((total, keyword) => total + (JSON.stringify(model).toLowerCase().includes(keyword) ? 1 : 0), 0);
        return score(right) - score(left);
      })[0];
      selectedModelIds = [best.id];
    }
    const inkosContract = buildInkOsPromptContext({ taskType, specialistId: promptOptions.specialistId });
    const request = {
      prompt: String(instruction || ""),
      system: [
        "You are the fiction director. Treat supplied project context as read-only and do not settle facts unless explicitly asked.",
        inkosContract
      ].filter(Boolean).join("\n\n"),
      modelIds: selectedModelIds,
      taskLabel: taskType
    };
    await taskStore.appendEvent(taskId, {
      type: "model-call",
      taskType,
      modelIds: request.modelIds,
      instruction: request.prompt
    });
    const response = await service.callModels(request);
    const output = responseText(response);
    if (!output.trim()) {
      throw createError("MODEL_RESPONSE_EMPTY", `${taskType} received an empty model response.`);
    }
    await taskStore.appendEvent(taskId, {
      type: "model-output",
      taskType,
      output: output.slice(0, 40_000)
    });
    return output;
  }

  async function run({ projectId, kind, instruction = "", modelIds = [], source = "codex", ...options } = {}) {
    const taskKind = String(kind || "unknown");
    const project = await openProject(projectId);
    const writeKinds = new Set(["brainstorm", "outline", "chapter-brief", "draft", "settle"]);
    const settlementKey = taskKind === "settle"
      ? settlementFingerprint(projectId, instruction, options)
      : undefined;
    if (settlementKey && committedSettlements.has(settlementKey)) {
      throw createError("SETTLEMENT_ALREADY_COMMITTED", "This settlement has already been committed.");
    }
    const task = await taskStore.create({
      projectId,
      projectPath: project.path,
      kind: taskKind,
      instruction,
      write: writeKinds.has(taskKind),
      source,
      modelIds,
      settlementKey
    });

    let committedResult = null;
    try {
      await taskStore.appendEvent(task.id, { type: "started" });
      let result;

      if (taskKind === "brainstorm") {
        const output = await callModels(task.id, "brainstorm", modelIds, instruction);
        const contents = `# Ideas\n\n${output.trim()}\n\n> 待作者确认：以上内容只是候选方向，不是正式事实。\n`;
        const relativePath = `.fiction-director/working/ideas-${task.id}.md`;
        await atomicWrite(outputPath(project, relativePath), contents, project.path);
        result = { relativePath, output: output.trim() };
      } else if (taskKind === "market-scan") {
        const service = requireDependency(
          marketResearch,
          "MARKET_RESEARCH_REQUIRED",
          "market-scan requires an injected market research service."
        );
        if (typeof service.scan !== "function") {
          throw createError("MARKET_RESEARCH_INVALID", "The injected market research service must expose scan.");
        }
        await taskStore.appendEvent(task.id, { type: "market-research-call", rankUrl: options.rankUrl || null });
        result = await service.scan({ projectPath: project.path, rankUrl: options.rankUrl });
        await taskStore.appendEvent(task.id, { type: "market-research-output", output: result });
      } else if (taskKind === "outline") {
        const output = await callModels(
          task.id,
          "outline",
          modelIds,
          instruction
        );
        const relativePath = options.confirm === true
          ? ".fiction-director/blueprint.md"
          : ".fiction-director/working/outline.md";
        await atomicWrite(outputPath(project, relativePath), `${output.trim()}\n`, project.path);
        result = { relativePath, output: output.trim(), confirmed: options.confirm === true };
      } else if (taskKind === "chapter-brief") {
        const name = safeName(options.chapterId, "latest");
        const relativePath = `.fiction-director/working/chapter-briefs/${name}.md`;
        // Reject linked output directories before spending a model request.
        await ensureSafeParent(project.path, path.dirname(outputPath(project, relativePath)));
        const context = await boundedProjectContext(
          project,
          options.ledgerFiles === undefined ? options.contextLedgerFiles : options.ledgerFiles
        );
        const output = await callModels(
          task.id,
          "chapter-brief",
          modelIds,
          `${context}\n\n当前章节规划任务：\n${instruction}`
        );
        await atomicWrite(outputPath(project, relativePath), `${output.trim()}\n`, project.path);
        result = { relativePath, output: output.trim() };
      } else if (taskKind === "draft") {
        const context = await boundedProjectContext(
          project,
          options.ledgerFiles === undefined ? options.contextLedgerFiles : options.ledgerFiles
        );
        const output = await callModels(
          task.id,
          "draft",
          modelIds,
          `${context}\n\n当前任务（只按作者要求生成草稿，不结算台账）：\n${instruction}`
        );
        const name = safeName(options.draftId, "latest");
        const relativePath = `.fiction-director/working/drafts/draft-${name}.md`;
        await atomicWrite(outputPath(project, relativePath), `${output.trim()}\n`, project.path);
        result = { relativePath, output: output.trim() };
      } else if (taskKind === "review") {
        const context = await boundedProjectContext(
          project,
          options.ledgerFiles === undefined ? options.contextLedgerFiles : options.ledgerFiles
        );
        const output = await callModels(task.id, "review", modelIds, `${context}\n\n当前审稿任务：\n${instruction}`);
        const name = safeName(options.reviewId, "latest");
        const relativePath = `.fiction-director/working/reviews/review-${name}.md`;
        await atomicWrite(outputPath(project, relativePath), `${output.trim()}\n`, project.path);
        result = { relativePath, output: output.trim() };
      } else if (taskKind === "specialist") {
        const specialistId = String(options.specialistId || "").trim();
        const capability = specialistId ? getInkOsCapability(specialistId) : null;
        if (specialistId && !capability) {
          throw createError("SPECIALIST_CAPABILITY_NOT_FOUND", "The requested InkOS specialist capability was not found.");
        }
        if (capability && capability.taskKind !== "specialist") {
          throw createError("SPECIALIST_CAPABILITY_KIND_MISMATCH", "The selected capability uses a different task kind.");
        }
        const context = await boundedProjectContext(
          project,
          options.ledgerFiles === undefined ? options.contextLedgerFiles : options.ledgerFiles
        );
        const output = await callModels(
          task.id,
          "specialist",
          modelIds,
          `${context}\n\n${capability ? `InkOS专项：${capability.label}\n专项边界：${capability.promptDirective}\n` : ""}专项任务（只生成候选工件，不改正文、不结算台账）：\n${instruction}`,
          { specialistId: capability?.id }
        );
        const name = safeName(capability ? `${capability.id}-${task.id}` : task.id, task.id);
        const relativePath = `.fiction-director/working/specialist/${name}.md`;
        await atomicWrite(outputPath(project, relativePath), `${output.trim()}\n`, project.path);
        result = { relativePath, output: output.trim(), specialistId: capability?.id || null, confirmed: false };
      } else if (taskKind === "settle") {
        const confirmedProse = typeof options.confirmedProse === "string" ? options.confirmedProse.trim() : "";
        const accepted = options.authorAccepted === true
          || options.explicitAuthorAcceptance === true
          || options.authorAcceptance === true;
        const acceptedProse = accepted && typeof options.prose === "string" ? options.prose.trim() : "";
        const prose = confirmedProse || acceptedProse;
        if (!prose) {
          throw createError(
            "AUTHOR_CONFIRMATION_REQUIRED",
            "settle requires confirmedProse or prose with explicit author acceptance."
          );
        }
        const transaction = ledgerTransaction || defaultLedgerTransaction;
        const request = {
          projectId,
          projectPath: project.path,
          prose,
          instruction,
          transactionId: task.id,
          idempotencyKey: task.id
        };
        if (!ledgerTransaction) request.chapterId = options.chapterId;
        await taskStore.appendEvent(task.id, { type: "ledger-transaction", prose: prose.slice(0, 40_000) });
        if (typeof transaction === "function") result = await transaction(request);
        else if (typeof transaction.transaction === "function") result = await transaction.transaction(request);
        else if (typeof transaction.commit === "function") result = await transaction.commit(request);
        else throw createError("LEDGER_TRANSACTION_INVALID", "The injected ledger transaction is not callable.");
        const successful = result
          && typeof result === "object"
          && (result.committed === true || result.status === "committed");
        if (!successful) {
          throw createError("LEDGER_TRANSACTION_FAILED", "The ledger transaction did not report a successful commit.");
        }
        committedResult = result;
        await taskStore.recordSettlement(task.id, settlementKey, result);
        committedSettlements.set(settlementKey, { taskId: task.id, result });
        await taskStore.appendEvent(task.id, { type: "ledger-transaction-output", output: result });
      } else if (taskKind === "download") {
        const service = requireDependency(
          downloadProvider,
          "DOWNLOAD_PROVIDER_REQUIRED",
          "download requires an injected authorized download provider."
        );
        if (typeof service.download !== "function") {
          throw createError("DOWNLOAD_PROVIDER_INVALID", "The injected download provider must expose download.");
        }
        const request = {
          projectPath: project.path,
          title: options.title,
          bookId: options.bookId,
          author: options.author,
          focus: options.focus,
          authorized: options.authorized
        };
        await taskStore.appendEvent(task.id, { type: "download-call", title: request.title || request.bookId || null });
        result = await service.download(request);
        await taskStore.appendEvent(task.id, { type: "download-output", output: result });
      } else if (taskKind === "deconstruct") {
        const service = requireDependency(
          deconstructionService,
          "DECONSTRUCTION_SERVICE_REQUIRED",
          "deconstruct requires an injected deconstruction service."
        );
        if (typeof service.deconstruct !== "function") {
          throw createError("DECONSTRUCTION_SERVICE_INVALID", "The injected service must expose deconstruct.");
        }
        const sourceRelativePath = String(options.sourceRelativePath || "");
        const relativeSegments = sourceRelativePath.split("/");
        if (!sourceRelativePath.startsWith(".fiction-director/sources/")
          || relativeSegments.includes("..")
          || path.isAbsolute(sourceRelativePath)) {
          throw createError(
            "SOURCE_PATH_INVALID",
            "The deconstruction source must stay under the project's sources tree."
          );
        }
        const request = {
          projectPath: project.path,
          sourceRelativePath,
          modelIds,
          force: options.force === true
        };
        await taskStore.appendEvent(task.id, { type: "deconstruction-call", sourceRelativePath });
        result = await service.deconstruct(request);
        await taskStore.appendEvent(task.id, { type: "deconstruction-output", output: result });
      } else {
        throw createError("TASK_KIND_UNSUPPORTED", `Unsupported task kind: ${taskKind}.`);
      }

      await taskStore.appendEvent(task.id, { type: "output", output: result });
      return await taskStore.complete(task.id, { output: result });
    } catch (error) {
      if (committedResult !== null) {
        const warning = {
          code: "SETTLED_PERSISTENCE_ERROR",
          message: "The ledger commit succeeded, but task completion persistence failed.",
          cause: errorDetails(error)
        };
        try {
          return await taskStore.settle(task.id, { output: committedResult, warning });
        } catch {
          await taskStore.releaseLease(task.id).catch(() => {});
          return {
            ...task,
            status: "settled",
            output: committedResult,
            warning
          };
        }
      }
      await taskStore.appendEvent(task.id, { type: "error", error: errorDetails(error) }).catch(() => {});
      return await taskStore.fail(task.id, { error: errorDetails(error) });
    }
  }

  return {
    createProject,
    listProjects,
    openProject,
    importAuxiliary,
    listSources,
    readLedger,
    projectState,
    run,
    taskStore
  };
}

module.exports = { createFictionDirector };
