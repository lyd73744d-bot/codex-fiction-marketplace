const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const TERMINAL_STATUSES = new Set(["completed", "failed", "stopped", "settled"]);
const MAX_VALUE_DEPTH = 8;
const MAX_VALUE_KEYS = 100;
const MAX_VALUE_ITEMS = 100;
const MAX_VALUE_STRING = 64_000;
const LOCK_RETRY_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const STALE_LOCK_MS = 30_000;

function createError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Resolve paths through the longest existing ancestor so Windows 8.3 short
// names (ADMINI~1) and long names (Administrator) compare as the same place.
async function resolveLogicalPath(targetPath) {
  let current = path.resolve(targetPath);
  const missing = [];
  while (true) {
    try {
      const real = await fs.realpath(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(targetPath);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

async function plainDirectory(directoryPath, code = "PROJECT_PATH_UNSAFE") {
  const stats = await fs.lstat(directoryPath);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw createError(code, "Task paths must use plain directories.");
  }
  return fs.realpath(directoryPath);
}

function now() {
  return new Date().toISOString();
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJson(filePath, value, { validate } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  try {
    await validate?.();
    await fs.writeFile(temporaryPath, serialized, "utf8");
    await validate?.();
    await fs.rename(temporaryPath, filePath);
    await validate?.();
  } finally {
    await fs.rm(temporaryPath, { force: true }).catch(() => {});
  }
}

function boundedValue(value, seen = new WeakSet(), depth = 0) {
  if (value === null) return null;
  if (value === undefined) return null;
  if (typeof value === "string") {
    return value.length > MAX_VALUE_STRING ? `${value.slice(0, MAX_VALUE_STRING)}\n[truncated]` : value;
  }
  if (typeof value === "bigint") return String(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;
  if (depth >= MAX_VALUE_DEPTH) return "[max-depth]";
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_VALUE_ITEMS).map((item) => boundedValue(item, seen, depth + 1));
    if (value.length > MAX_VALUE_ITEMS) result.push(`[${value.length - MAX_VALUE_ITEMS} items truncated]`);
    return result;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: String(value.name || "Error"),
      message: boundedValue(String(value.message || ""), seen, depth + 1),
      code: value.code === undefined ? undefined : boundedValue(value.code, seen, depth + 1)
    };
  }
  const result = {};
  let keys;
  try {
    keys = Object.keys(value);
  } catch {
    return "[unserializable]";
  }
  for (const key of keys.slice(0, MAX_VALUE_KEYS)) {
    try {
      result[key] = boundedValue(value[key], seen, depth + 1);
    } catch {
      result[key] = "[unserializable]";
    }
  }
  if (keys.length > MAX_VALUE_KEYS) result._truncatedKeys = keys.length - MAX_VALUE_KEYS;
  return result;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function storageKey(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

async function withFileLock(lockPath, operation) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const startedAt = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockPath);
      break;
    } catch (error) {
      if (error.code === "EPERM") {
        try {
          await fs.lstat(lockPath);
        } catch (lockError) {
          if (lockError.code !== "ENOENT") throw error;
          if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
            throw createError("TASK_LOCK_TIMEOUT", "Timed out waiting for a task store lock.");
          }
          await delay(LOCK_RETRY_MS);
          continue;
        }
      } else if (error.code !== "EEXIST") throw error;
      try {
        const stats = await fs.stat(lockPath);
        if (Date.now() - stats.mtimeMs > STALE_LOCK_MS) {
          await fs.rm(lockPath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (lockError.code !== "ENOENT") throw lockError;
        continue;
      }
      if (Date.now() - startedAt >= LOCK_TIMEOUT_MS) {
        throw createError("TASK_LOCK_TIMEOUT", "Timed out waiting for a task store lock.");
      }
      await delay(LOCK_RETRY_MS);
    }
  }
  try {
    return await operation();
  } finally {
    await fs.rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}

function createTaskStore({ projectsRoot, indexRoot, resolveProjectPath } = {}) {
  if (!projectsRoot && !resolveProjectPath) {
    throw new TypeError("projectsRoot or resolveProjectPath is required");
  }

  const resolvedProjectsRoot = projectsRoot ? path.resolve(projectsRoot) : null;
  const resolvedIndexRoot = path.resolve(indexRoot || resolvedProjectsRoot || process.cwd());
  const knownTasks = new Map();

  async function indexPaths() {
    await fs.mkdir(resolvedIndexRoot, { recursive: true });
    const realIndexRoot = await plainDirectory(resolvedIndexRoot, "INDEX_PATH_UNSAFE");
    const directorPath = path.join(realIndexRoot, ".fiction-director");
    await fs.mkdir(directorPath, { recursive: true });
    const realDirectorPath = await plainDirectory(directorPath, "INDEX_PATH_UNSAFE");
    if (!isWithin(realIndexRoot, realDirectorPath)) {
      throw createError("INDEX_PATH_UNSAFE", "The task index directory escaped indexRoot.");
    }
    const storeRoot = path.join(realDirectorPath, "task-store");
    await fs.mkdir(storeRoot, { recursive: true });
    const realStoreRoot = await plainDirectory(storeRoot, "INDEX_PATH_UNSAFE");
    if (!isWithin(realDirectorPath, realStoreRoot)) {
      throw createError("INDEX_PATH_UNSAFE", "The task storage directory escaped indexRoot.");
    }
    const directories = {
      taskDataDirectory: "tasks",
      leaseDirectory: "leases",
      projectLockDirectory: "locks",
      settlementReceiptDirectory: "settlement-receipts"
    };
    const storagePaths = {};
    for (const [key, name] of Object.entries(directories)) {
      const directoryPath = path.join(realStoreRoot, name);
      await fs.mkdir(directoryPath, { recursive: true });
      const realDirectoryPath = await plainDirectory(directoryPath, "INDEX_PATH_UNSAFE");
      if (!isWithin(realStoreRoot, realDirectoryPath)) {
        throw createError("INDEX_PATH_UNSAFE", "The task storage directory escaped its root.");
      }
      storagePaths[key] = realDirectoryPath;
    }
    const taskIndexPath = path.join(realDirectorPath, "task-index.json");
    return { taskIndexPath, taskIndexLockPath: `${taskIndexPath}.lock`, ...storagePaths };
  }

  async function projectPathFor(projectId, explicitProjectPath, create = true) {
    if (!projectId || typeof projectId !== "string" || path.basename(projectId) !== projectId) {
      throw createError("PROJECT_ID_REQUIRED", "A project id is required.");
    }

    let realProjectsRoot = null;
    if (resolvedProjectsRoot) {
      if (create) await fs.mkdir(resolvedProjectsRoot, { recursive: true });
      realProjectsRoot = await plainDirectory(resolvedProjectsRoot);
    }

    const projectBase = realProjectsRoot || resolvedProjectsRoot;
    const candidate = explicitProjectPath
      || (resolveProjectPath ? await resolveProjectPath(projectId) : path.join(projectBase, projectId));
    const logicalPath = path.resolve(candidate);
    // Normalize short/long Windows paths and symlink/junction targets.
    const resolvedPath = await resolveLogicalPath(candidate);

    if (realProjectsRoot) {
      const logicalInside = isWithin(realProjectsRoot, logicalPath) || isWithin(resolvedProjectsRoot, logicalPath);
      if (!logicalInside) {
        throw createError("PROJECT_PATH_OUTSIDE_ROOT", "Project path must stay inside the configured projects root.");
      }
      // Junctions/symlinks can keep a logical child path while resolving outside.
      if (!isWithin(realProjectsRoot, resolvedPath)) {
        throw createError("PROJECT_PATH_UNSAFE", "Project path escaped the configured projects root.");
      }
    }

    if (create) await fs.mkdir(resolvedPath, { recursive: true });
    const realProjectPath = await plainDirectory(resolvedPath);
    if (realProjectsRoot && !isWithin(realProjectsRoot, realProjectPath)) {
      throw createError("PROJECT_PATH_UNSAFE", "Project path escaped the configured projects root.");
    }

    const directorPath = path.join(realProjectPath, ".fiction-director");
    if (create) await fs.mkdir(directorPath, { recursive: true });
    const realDirectorPath = await plainDirectory(directorPath);
    if (!isWithin(realProjectPath, realDirectorPath)
      || (realProjectsRoot && !isWithin(realProjectsRoot, realDirectorPath))) {
      throw createError("PROJECT_PATH_UNSAFE", "The .fiction-director directory escaped the project.");
    }

    return realProjectPath;
  }

  async function pathsFor(projectId, projectPath, create = false) {
    const realProjectPath = await projectPathFor(projectId, projectPath, create);
    const directorPath = path.join(realProjectPath, ".fiction-director");
    const realDirectorPath = await plainDirectory(directorPath);
    const historyPath = path.join(realDirectorPath, "history");
    if (create) await fs.mkdir(historyPath, { recursive: true });
    const realHistoryPath = await plainDirectory(historyPath);
    if (!isWithin(realDirectorPath, realHistoryPath)) {
      throw createError("PROJECT_PATH_UNSAFE", "The task history directory escaped the project.");
    }
    const taskDirectory = path.join(realHistoryPath, "tasks");
    if (create) await fs.mkdir(taskDirectory, { recursive: true });
    const realTaskDirectory = await plainDirectory(taskDirectory);
    if (!isWithin(realHistoryPath, realTaskDirectory)) {
      throw createError("PROJECT_PATH_UNSAFE", "The task directory escaped task history.");
    }
    return {
      projectPath: realProjectPath,
      historyPath: realHistoryPath,
      taskDirectory: realTaskDirectory,
      leasePath: path.join(realHistoryPath, "write-lease.json"),
      leaseLockPath: path.join(realHistoryPath, "write-lease.lock")
    };
  }

  async function verifyTaskPaths(projectId, projectPath, expected) {
    const current = await pathsFor(projectId, projectPath, false);
    if (current.projectPath !== expected.projectPath
      || current.historyPath !== expected.historyPath
      || current.taskDirectory !== expected.taskDirectory) {
      throw createError("PROJECT_PATH_UNSAFE", "Task paths changed while the operation was in progress.");
    }
    return current;
  }

  async function withTaskPathsLock(projectId, projectPath, create, operation) {
    const validatedProjectPath = await projectPathFor(projectId, projectPath, create);
    const storagePaths = await indexPaths();
    const projectKey = storageKey(`${projectId}\0${validatedProjectPath}`);
    const lockPath = path.join(storagePaths.projectLockDirectory, `${projectKey}.lock`);
    return withFileLock(lockPath, async () => {
      const taskPaths = await pathsFor(projectId, validatedProjectPath, create);
      const guardedPaths = {
        ...taskPaths,
        leasePath: path.join(storagePaths.leaseDirectory, `${projectKey}.json`)
      };
      const verify = () => verifyTaskPaths(projectId, guardedPaths.projectPath, guardedPaths);
      try {
        const result = await operation(guardedPaths, verify);
        await verify();
        return result;
      } catch (error) {
        try {
          await verify();
        } catch (pathError) {
          throw pathError;
        }
        throw error;
      }
    });
  }

  async function taskLocation(taskId) {
    const { taskIndexPath } = await indexPaths();
    const remembered = knownTasks.get(taskId);
    const index = remembered ? null : await readJson(taskIndexPath, { tasks: {} });
    const location = remembered || index.tasks[taskId];
    if (!location) throw createError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
    const projectPath = await projectPathFor(location.projectId, location.projectPath, false);
    const validated = { projectId: location.projectId, projectPath };
    knownTasks.set(taskId, validated);
    return validated;
  }

  async function saveTask(task, existingPaths, verify) {
    const taskPaths = existingPaths || await pathsFor(task.projectId, task.projectPath, false);
    const { taskDataDirectory } = await indexPaths();
    const taskPath = path.join(taskDataDirectory, `${task.id}.json`);
    const saved = boundedValue(task);
    saved.projectPath = taskPaths.projectPath;
    const validate = verify || (() => verifyTaskPaths(task.projectId, taskPaths.projectPath, taskPaths));
    await writeJson(taskPath, saved, { validate });
    await validate();
    return saved;
  }

  async function indexTask(task) {
    const { taskIndexPath, taskIndexLockPath } = await indexPaths();
    await withFileLock(taskIndexLockPath, async () => {
      await indexPaths();
      const index = await readJson(taskIndexPath, { tasks: {} });
      index.tasks[task.id] = { projectId: task.projectId, projectPath: task.projectPath };
      await writeJson(taskIndexPath, index);
      knownTasks.set(task.id, index.tasks[task.id]);
    });
  }

  async function hasSettledSettlement(projectId, settlementKey, taskPaths, verify) {
    if (!settlementKey) return false;
    const { taskIndexPath, taskDataDirectory } = await indexPaths();
    const index = await readJson(taskIndexPath, { tasks: {} });
    for (const [taskId, location] of Object.entries(index.tasks)) {
      if (location.projectId !== projectId || path.basename(taskId) !== taskId) continue;
      const existing = await readJson(path.join(taskDataDirectory, `${taskId}.json`), null);
      await verify();
      if ((existing?.status === "settled" || existing?.status === "completed")
        && existing.settlementKey === settlementKey) return true;
    }
    return false;
  }

  async function hasSettlementReceipt(settlementKey) {
    if (!settlementKey) return false;
    const { settlementReceiptDirectory } = await indexPaths();
    const receipt = await readJson(path.join(settlementReceiptDirectory, `${settlementKey}.receipt`), null);
    return Boolean(receipt?.settlementKey === settlementKey);
  }

  async function recordSettlement(taskId, settlementKey, result) {
    if (!settlementKey) return;
    const { settlementReceiptDirectory } = await indexPaths();
    const receiptPath = path.join(settlementReceiptDirectory, `${settlementKey}.receipt`);
    const receipt = boundedValue({
      settlementKey,
      taskId,
      result,
      committedAt: now()
    });
    try {
      await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!await hasSettlementReceipt(settlementKey)) throw error;
    }
  }

  async function withTaskLock(taskId, operation) {
    const location = await taskLocation(taskId);
    return withTaskPathsLock(location.projectId, location.projectPath, false, operation);
  }

  async function readAt(taskId, taskPaths, verify) {
    const { taskDataDirectory } = await indexPaths();
    const taskPath = path.join(taskDataDirectory, `${taskId}.json`);
    const task = await readJson(taskPath, null);
    await verify();
    if (!task) throw createError("TASK_NOT_FOUND", `Task ${taskId} was not found.`);
    return task;
  }

  async function read(taskId) {
    const location = await taskLocation(taskId);
    return withTaskPathsLock(location.projectId, location.projectPath, false,
      (taskPaths, verify) => readAt(taskId, taskPaths, verify));
  }

  async function withProjectLeaseLock(projectId, projectPath, operation) {
    return withTaskPathsLock(projectId, projectPath, false, operation);
  }

  async function releaseLeaseAt(projectId, projectPath, taskId) {
    return withProjectLeaseLock(projectId, projectPath, async ({ leasePath }, verify) => {
      const lease = await readJson(leasePath, null);
      await verify();
      if (!lease || lease.taskId !== taskId) return false;
      await fs.rm(leasePath, { force: true });
      await verify();
      return true;
    });
  }

  async function releaseLease(taskId) {
    const location = await taskLocation(taskId);
    return releaseLeaseAt(location.projectId, location.projectPath, taskId);
  }

  async function create({ projectId, projectPath, kind, instruction, write = false, source = "codex", modelIds = [], settlementKey }) {
    await indexPaths();
    const resolvedProjectPath = await projectPathFor(projectId, projectPath, true);

    const createdAt = now();
    const task = {
      id: crypto.randomUUID(),
      projectId,
      projectPath: resolvedProjectPath,
      kind: kind || "unknown",
      instruction: instruction || "",
      source,
      modelIds: Array.isArray(modelIds) ? modelIds : [],
      write: Boolean(write),
      status: "queued",
      createdAt,
      updatedAt: createdAt,
      events: [{ type: "created", at: createdAt }]
    };
    if (settlementKey) task.settlementKey = settlementKey;

    await withTaskPathsLock(projectId, resolvedProjectPath, true, async (taskPaths, verify) => {
      if (await hasSettlementReceipt(settlementKey)
        || await hasSettledSettlement(projectId, settlementKey, taskPaths, verify)) {
        throw createError("SETTLEMENT_ALREADY_COMMITTED", "This settlement has already been committed.");
      }
      if (task.write) {
        const leaseContents = `${JSON.stringify({ taskId: task.id, projectId, createdAt }, null, 2)}\n`;
        let leaseWritten = false;
        try {
          await verify();
          await fs.writeFile(
            taskPaths.leasePath,
            leaseContents,
            { encoding: "utf8", flag: "wx" }
          );
          leaseWritten = true;
          await verify();
        } catch (error) {
          if (leaseWritten) {
            try {
              if ((await fs.readFile(taskPaths.leasePath, "utf8")) === leaseContents) {
                await fs.rm(taskPaths.leasePath, { force: true });
              }
            } catch {}
          }
          if (error.code === "EEXIST") {
            throw createError("PROJECT_BUSY", "This project already has an active writing task.");
          }
          throw error;
        }
      }
    });

    try {
      const saved = await saveTask(task);
      await indexTask(task);
      return saved;
    } catch (error) {
      if (task.write) await releaseLeaseAt(projectId, resolvedProjectPath, task.id).catch(() => {});
      throw error;
    }
  }

  async function appendEvent(taskId, event) {
    return withTaskLock(taskId, async (taskPaths, verify) => {
      const task = await readAt(taskId, taskPaths, verify);
      const recordedAt = now();
      const value = event && typeof event === "object" ? event : { value: event };
      task.events.push({ ...value, at: value.at || recordedAt });
      task.updatedAt = recordedAt;
      return saveTask(task, taskPaths, verify);
    });
  }

  async function finish(taskId, status, result = {}) {
    const terminal = TERMINAL_STATUSES.has(status);
    try {
      const task = await withTaskLock(taskId, async (taskPaths, verify) => {
        const current = await readAt(taskId, taskPaths, verify);
        if (TERMINAL_STATUSES.has(current.status)) return current;

        const updatedAt = now();
        current.status = status;
        current.updatedAt = updatedAt;
        if (Object.hasOwn(result, "output")) current.output = result.output;
        if (Object.hasOwn(result, "error")) current.error = result.error;
        if (Object.hasOwn(result, "warning")) current.warning = result.warning;
        current.events.push({ type: status, at: updatedAt });
        return saveTask(current, taskPaths, verify);
      });
      if (terminal) await releaseLease(taskId);
      return task;
    } catch (error) {
      if (terminal) await releaseLease(taskId).catch(() => {});
      throw error;
    }
  }

  async function complete(taskId, result) {
    return finish(taskId, "completed", result);
  }

  async function settle(taskId, result) {
    return finish(taskId, "settled", result);
  }

  async function fail(taskId, result) {
    return finish(taskId, "failed", result);
  }

  async function stop(taskId, result) {
    return finish(taskId, "stopped", result);
  }

  async function pause(taskId) {
    return withTaskLock(taskId, async (taskPaths, verify) => {
      const task = await readAt(taskId, taskPaths, verify);
      if (TERMINAL_STATUSES.has(task.status)) return task;
      task.status = "paused";
      task.updatedAt = now();
      task.events.push({ type: "paused", at: task.updatedAt });
      return saveTask(task, taskPaths, verify);
    });
  }

  async function resume(taskId) {
    return withTaskLock(taskId, async (taskPaths, verify) => {
      const task = await readAt(taskId, taskPaths, verify);
      if (task.status !== "paused") return task;
      task.status = "queued";
      task.updatedAt = now();
      task.events.push({ type: "resumed", at: task.updatedAt });
      return saveTask(task, taskPaths, verify);
    });
  }

  async function list({ projectId } = {}) {
    const { taskIndexPath } = await indexPaths();
    const index = await readJson(taskIndexPath, { tasks: {} });
    const taskIds = Object.entries(index.tasks)
      .filter(([, location]) => !projectId || location.projectId === projectId)
      .map(([taskId]) => taskId);
    const tasks = await Promise.all(taskIds.map((taskId) => read(taskId).catch(() => null)));
    return tasks.filter(Boolean).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  return {
    create,
    read,
    list,
    appendEvent,
    complete,
    settle,
    fail,
    stop,
    pause,
    resume,
    releaseLease,
    recordSettlement
  };
}

module.exports = { createTaskStore };
