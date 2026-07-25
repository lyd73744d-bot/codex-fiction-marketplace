const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const properLockfile = require("proper-lockfile");

const REGISTRY_VERSION = 1;
const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
const DEFAULT_LOCK_STALE_MS = 30_000;
const DEFAULT_LOCK_RETRY_MS = 20;
const ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml"
]);
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_DANGEROUS_CHARS_PATTERN = /[<>:"/\\|?*\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_NAME_PATTERN = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;
const HUMANIZER_RULE_STATE_PARTS = [".zzj", "v3", "humanizer-rules.json"];

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function samePath(left, right) {
  const normalize = (value) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function stableProjectId(realRoot) {
  const identity = process.platform === "win32" ? realRoot.toLowerCase() : realRoot;
  return `project_${crypto.createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

function assertWindowsSafeComponent(component, label) {
  if (
    WINDOWS_DANGEROUS_CHARS_PATTERN.test(component)
    || component.endsWith(".")
    || component.endsWith(" ")
    || WINDOWS_RESERVED_NAME_PATTERN.test(component)
  ) {
    throw new Error(`${label} contains a Windows-dangerous path component: ${component}`);
  }
}

function normalizeArtifactPath(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0 || relativePath.includes("\0")) {
    throw new Error("artifact relative path must be a non-empty string");
  }
  if (
    path.isAbsolute(relativePath)
    || path.win32.isAbsolute(relativePath)
    || path.posix.isAbsolute(relativePath.replace(/\\/g, "/"))
  ) {
    throw new Error("artifact relative path must not be absolute");
  }

  const segments = relativePath.replace(/\\/g, "/").split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("artifact relative path contains traversal or empty segments");
  }
  const internalSegment = segments[0].toLowerCase() === ".zzj";
  if (internalSegment) {
    throw new Error("reserved .zzj directory is not available through public artifact paths");
  }
  for (const segment of segments) {
    assertWindowsSafeComponent(segment, "artifact path");
  }
  const portablePath = segments.join("/");
  if (!ALLOWED_EXTENSIONS.has(path.posix.extname(portablePath).toLowerCase())) {
    throw new Error("artifact must use a supported text artifact extension");
  }
  return {
    portablePath,
    platformPath: path.join(...segments)
  };
}

function validateTransactionId(transactionId) {
  if (typeof transactionId !== "string" || transactionId.length === 0) {
    throw new Error("transaction id must be one safe path segment");
  }
  assertWindowsSafeComponent(transactionId, "transaction id");
  if (
    transactionId === "."
    || transactionId === ".."
    || !TRANSACTION_ID_PATTERN.test(transactionId)
  ) {
    throw new Error("transaction id must be one safe path segment");
  }
  return transactionId;
}

function publicProject(record) {
  return Object.freeze({ id: record.id, name: record.name, root: record.root });
}

function validateRegistry(payload) {
  if (
    payload === null
    || typeof payload !== "object"
    || payload.version !== REGISTRY_VERSION
    || !Array.isArray(payload.projects)
  ) {
    throw new Error("project registry is invalid");
  }
  for (const project of payload.projects) {
    if (
      project === null
      || typeof project !== "object"
      || typeof project.id !== "string"
      || typeof project.name !== "string"
      || typeof project.root !== "string"
      || stableProjectId(project.root) !== project.id
    ) {
      throw new Error("project registry contains an invalid project record");
    }
  }
  return payload;
}

// Trust boundary: the project author must not adversarially swap path components
// during a syscall. Node on Windows has no portable openat/no-follow directory handle,
// so every component is revalidated immediately before each filesystem side effect.
async function assertNoLinkComponents(realRoot, candidatePath, label) {
  if (!isPathInside(realRoot, candidatePath)) {
    throw new Error(`${label} escapes the registered project`);
  }
  const relative = path.relative(realRoot, candidatePath);
  if (!relative) return;

  let currentPath = realRoot;
  for (const segment of relative.split(path.sep)) {
    currentPath = path.join(currentPath, segment);
    let status;
    try {
      status = await fs.promises.lstat(currentPath);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (status.isSymbolicLink()) {
      throw new Error(
        `${label} contains a symbolic link, junction, or reparse point; linked real paths are forbidden`
      );
    }
  }
}

async function realpathInside(realRoot, candidatePath, label) {
  await assertNoLinkComponents(realRoot, candidatePath, label);
  const candidateRealPath = await fs.promises.realpath(candidatePath);
  if (!isPathInside(realRoot, candidateRealPath)) {
    throw new Error(`${label} escapes the registered project real path`);
  }
  return candidateRealPath;
}

async function nearestExistingRealpath(candidatePath) {
  let current = candidatePath;
  while (true) {
    try {
      return await fs.promises.realpath(current);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertWritableDestination(realRoot, targetPath, label) {
  if (!isPathInside(realRoot, targetPath)) {
    throw new Error(`${label} escapes the registered project`);
  }
  await assertNoLinkComponents(realRoot, targetPath, label);

  try {
    const status = await fs.promises.lstat(targetPath);
    const realTargetPath = await realpathInside(realRoot, targetPath, label);
    if (status.isDirectory()) {
      throw new Error(`${label} must be a file`);
    }
    return { exists: true, realTargetPath };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const realAncestor = await nearestExistingRealpath(path.dirname(targetPath));
  if (!isPathInside(realRoot, realAncestor)) {
    throw new Error(`${label} escapes the registered project real path`);
  }
  return { exists: false, realTargetPath: targetPath };
}

async function ensureSafeParent(
  realRoot,
  targetPath,
  label,
  validateSideEffect = async () => {}
) {
  const parentPath = path.dirname(targetPath);
  await assertNoLinkComponents(realRoot, parentPath, label);
  await validateSideEffect(parentPath);
  await fs.promises.mkdir(parentPath, { recursive: true });
  await validateSideEffect(parentPath);
  await assertNoLinkComponents(realRoot, parentPath, label);
  await realpathInside(realRoot, parentPath, label);
}

async function atomicWrite(targetPath, content, validateSideEffect = async () => {}) {
  const temporaryPath = path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    await validateSideEffect(temporaryPath);
    await fs.promises.writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await validateSideEffect(temporaryPath);
    await validateSideEffect(targetPath);
    await fs.promises.rename(temporaryPath, targetPath);
  } finally {
    try {
      await validateSideEffect(temporaryPath);
      await fs.promises.rm(temporaryPath, { force: true });
    } catch {}
  }
}

async function atomicSnapshot(sourcePath, snapshotPath, validateSideEffect) {
  const temporaryPath = path.join(
    path.dirname(snapshotPath),
    `.${path.basename(snapshotPath)}.${process.pid}.${crypto.randomUUID()}.tmp`
  );
  try {
    await validateSideEffect(sourcePath);
    await validateSideEffect(temporaryPath);
    await fs.promises.copyFile(sourcePath, temporaryPath, fs.constants.COPYFILE_EXCL);
    await validateSideEffect(temporaryPath);
    await validateSideEffect(snapshotPath);
    try {
      await fs.promises.link(temporaryPath, snapshotPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error("snapshot already exists for this transaction and artifact", {
          cause: error
        });
      }
      throw error;
    }
  } finally {
    try {
      await validateSideEffect(temporaryPath);
      await fs.promises.rm(temporaryPath, { force: true });
    } catch {}
  }
}

function positiveIntegerOption(value, fallback, name) {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return resolved;
}

function sameLockIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.birthtimeMs === right.birthtimeMs;
}

function createOwnershipGuardedFs(lockPath) {
  const guardedFs = Object.create(fs);
  let acquired = false;
  let ownedIdentity = null;

  guardedFs.mkdir = (candidatePath, callback) => {
    fs.mkdir(candidatePath, (error) => {
      if (!error && samePath(candidatePath, lockPath)) acquired = true;
      callback(error);
    });
  };
  guardedFs.stat = (candidatePath, callback) => {
    fs.stat(candidatePath, (error, status) => {
      if (!error && acquired && !ownedIdentity && samePath(candidatePath, lockPath)) {
        ownedIdentity = status;
      }
      callback(error, status);
    });
  };

  function verifyOwnership(candidatePath, callback, sideEffect) {
    if (!ownedIdentity || !samePath(candidatePath, lockPath)) return sideEffect();
    fs.lstat(candidatePath, (error, status) => {
      if (error) return callback(error);
      if (status.isSymbolicLink() || !sameLockIdentity(ownedIdentity, status)) {
        return callback(Object.assign(new Error("lock ownership changed"), {
          code: "ECOMPROMISED"
        }));
      }
      sideEffect();
    });
  }

  guardedFs.utimes = (candidatePath, atime, mtime, callback) => {
    verifyOwnership(candidatePath, callback, () => fs.utimes(candidatePath, atime, mtime, callback));
  };
  guardedFs.rmdir = (candidatePath, callback) => {
    verifyOwnership(candidatePath, callback, () => fs.rmdir(candidatePath, callback));
  };
  guardedFs.rmdirSync = (candidatePath) => {
    if (ownedIdentity && samePath(candidatePath, lockPath)) {
      const status = fs.lstatSync(candidatePath);
      if (status.isSymbolicLink() || !sameLockIdentity(ownedIdentity, status)) return;
    }
    fs.rmdirSync(candidatePath);
  };
  return guardedFs;
}

async function withProperLock(targetPath, lockPath, options, validateSideEffect, operation) {
  await validateSideEffect(lockPath);
  let compromisedError = null;
  const validateOwnedSideEffect = async (candidatePath) => {
    if (compromisedError) throw compromisedError;
    await validateSideEffect(candidatePath);
    if (compromisedError) throw compromisedError;
  };
  const guardedFs = createOwnershipGuardedFs(lockPath);
  let release;
  try {
    release = await properLockfile.lock(targetPath, {
      fs: guardedFs,
      lockfilePath: lockPath,
      onCompromised(error) {
        compromisedError = error;
      },
      realpath: false,
      retries: options.retries,
      stale: options.staleMs,
      update: options.updateMs
    });
  } catch (error) {
    if (error.code === "ELOCKED") {
      throw new Error(`timed out waiting for lock: ${lockPath}`, { cause: error });
    }
    throw error;
  }

  let result;
  let operationError;
  try {
    await validateOwnedSideEffect(lockPath);
    result = await operation(validateOwnedSideEffect);
  } catch (error) {
    operationError = error;
  }

  let releaseError;
  try {
    await release();
  } catch (error) {
    releaseError = error;
  }
  if (compromisedError) throw compromisedError;
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}

function createProjectStore(options = {}) {
  const registryPath = path.resolve(
    options.registryPath || path.join(os.homedir(), ".zizhuji", "projects-v3.json")
  );
  const maxFileBytes = options.maxFileBytes === undefined
    ? DEFAULT_MAX_FILE_BYTES
    : options.maxFileBytes;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes <= 0) {
    throw new TypeError("maxFileBytes must be a positive safe integer");
  }
  const lockTimeoutMs = positiveIntegerOption(
    options.lockTimeoutMs,
    DEFAULT_LOCK_TIMEOUT_MS,
    "lockTimeoutMs"
  );
  const lockRetryMs = positiveIntegerOption(
    options.lockRetryMs,
    DEFAULT_LOCK_RETRY_MS,
    "lockRetryMs"
  );
  const lockStaleMs = Math.max(
    5_000,
    positiveIntegerOption(options.lockStaleMs, DEFAULT_LOCK_STALE_MS, "lockStaleMs")
  );
  const requestedUpdateMs = positiveIntegerOption(
    options.lockUpdateMs,
    Math.floor(lockStaleMs / 2),
    "lockUpdateMs"
  );
  const lockOptions = Object.freeze({
    staleMs: lockStaleMs,
    updateMs: Math.max(1_000, Math.min(requestedUpdateMs, Math.floor(lockStaleMs / 2))),
    retries: Object.freeze({
      factor: 1,
      maxTimeout: lockRetryMs,
      minTimeout: lockRetryMs,
      randomize: false,
      retries: Math.floor(lockTimeoutMs / lockRetryMs)
    })
  });

  async function readRegistry() {
    try {
      return validateRegistry(JSON.parse(await fs.promises.readFile(registryPath, "utf8")));
    } catch (error) {
      if (error.code === "ENOENT") return { version: REGISTRY_VERSION, projects: [] };
      throw error;
    }
  }

  async function saveRegistry(registry, validateSideEffect) {
    await validateSideEffect(path.dirname(registryPath));
    await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
    await validateSideEffect(path.dirname(registryPath));
    await atomicWrite(
      registryPath,
      `${JSON.stringify(registry, null, 2)}\n`,
      validateSideEffect
    );
  }

  async function validateRegistryLock(lockPath) {
    try {
      const status = await fs.promises.lstat(lockPath);
      if (status.isSymbolicLink()) throw new Error("registry lock must not be a symbolic link");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  async function withRegistryLock(operation) {
    await fs.promises.mkdir(path.dirname(registryPath), { recursive: true });
    return withProperLock(
      registryPath,
      `${registryPath}.lock`,
      lockOptions,
      validateRegistryLock,
      operation
    );
  }

  async function withProjectLock(realRoot, operation) {
    const lockDirectory = path.join(realRoot, ".zzj", "v3-locks");
    const lockTarget = path.join(lockDirectory, "project-store");
    const lockPath = `${lockTarget}.lock`;
    await assertNoLinkComponents(realRoot, lockDirectory, "project lock path");
    await fs.promises.mkdir(lockDirectory, { recursive: true });
    await assertNoLinkComponents(realRoot, lockDirectory, "project lock path");
    const validateLockSideEffect = (candidatePath) => (
      assertNoLinkComponents(realRoot, candidatePath, "project lock path")
    );
    return withProperLock(
      lockTarget,
      lockPath,
      lockOptions,
      validateLockSideEffect,
      operation
    );
  }

  async function registerProject(projectRoot) {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw new TypeError("project root must be a non-empty path");
    }
    const realRoot = await fs.promises.realpath(path.resolve(projectRoot));
    const status = await fs.promises.stat(realRoot);
    if (!status.isDirectory()) throw new Error("project root must be a directory");
    const id = stableProjectId(realRoot);

    return withRegistryLock(async (validateRegistrySideEffect) => {
      const registry = await readRegistry();
      const existing = registry.projects.find((project) => (
        project.id === id || samePath(project.root, realRoot)
      ));
      if (existing) return publicProject(existing);

      const record = { id, name: path.basename(realRoot), root: realRoot };
      const nextRegistry = {
        version: REGISTRY_VERSION,
        projects: [...registry.projects, record]
      };
      await saveRegistry(nextRegistry, validateRegistrySideEffect);
      return publicProject(record);
    });
  }

  async function listProjects() {
    const registry = await readRegistry();
    return registry.projects
      .map(publicProject)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async function openProject(projectId) {
    const registry = await readRegistry();
    const record = registry.projects.find((project) => project.id === projectId);
    if (!record) throw new Error(`registered project not found: ${projectId}`);

    let currentRealRoot;
    try {
      currentRealRoot = await fs.promises.realpath(record.root);
    } catch (error) {
      throw new Error(`registered project is unavailable: ${projectId}`, { cause: error });
    }
    if (!samePath(currentRealRoot, record.root)) {
      throw new Error(`registered project root changed its real path: ${projectId}`);
    }

    async function readText(relativePath) {
      const normalized = normalizeArtifactPath(relativePath);
      const targetPath = path.resolve(currentRealRoot, normalized.platformPath);
      if (!isPathInside(currentRealRoot, targetPath)) {
        throw new Error("artifact path escapes the registered project");
      }
      const realTargetPath = await realpathInside(currentRealRoot, targetPath, "artifact path");
      const status = await fs.promises.stat(realTargetPath);
      if (!status.isFile()) throw new Error("artifact path must refer to a file");
      if (status.size > maxFileBytes) throw new Error("artifact exceeds the file-size cap");
      const content = await fs.promises.readFile(realTargetPath);
      if (content.length > maxFileBytes) throw new Error("artifact exceeds the file-size cap");
      return content.toString("utf8");
    }

    async function listArtifacts() {
      const artifacts = [];
      const excludedDirectories = new Set([".zzj", ".git", "node_modules"]);
      const maxFiles = 2_000;
      const maxDepth = 12;

      async function walk(directoryPath, segments) {
        if (segments.length > maxDepth || artifacts.length >= maxFiles) return;
        await assertNoLinkComponents(currentRealRoot, directoryPath, "artifact directory");
        const entries = await fs.promises.readdir(directoryPath, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
        for (const entry of entries) {
          if (artifacts.length >= maxFiles) break;
          if (entry.isSymbolicLink()) continue;
          const nextSegments = [...segments, entry.name];
          const candidatePath = path.join(directoryPath, entry.name);
          const status = await fs.promises.lstat(candidatePath);
          if (status.isSymbolicLink()) continue;
          if (status.isDirectory()) {
            if (!excludedDirectories.has(entry.name.toLowerCase())) await walk(candidatePath, nextSegments);
            continue;
          }
          if (!status.isFile()) continue;
          const relativePath = nextSegments.join("/");
          if (!ALLOWED_EXTENSIONS.has(path.posix.extname(relativePath).toLowerCase())) continue;
          artifacts.push(Object.freeze({
            relativePath,
            name: entry.name,
            size: status.size,
            modifiedAt: status.mtime.toISOString()
          }));
        }
      }

      await walk(currentRealRoot, []);
      return artifacts.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "zh-CN"));
    }

    async function writeTexts(entries, writeOptions = {}) {
      if (!Array.isArray(entries) || entries.length === 0 || entries.length > 32) {
        throw new TypeError("artifact transaction must contain between 1 and 32 writes");
      }
      const transactionId = validateTransactionId(writeOptions.transactionId);
      const normalizedEntries = entries.map((entry) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          throw new TypeError("artifact transaction entry is invalid");
        }
        const normalized = normalizeArtifactPath(entry.relativePath);
        if (typeof entry.content !== "string") throw new TypeError("artifact content must be text");
        const bytes = Buffer.byteLength(entry.content, "utf8");
        if (bytes > maxFileBytes) throw new Error("artifact exceeds the file-size cap");
        return {
          bytes,
          content: entry.content,
          expectedContent: entry.expectedContent,
          hasExpectedContent: Object.prototype.hasOwnProperty.call(entry, "expectedContent"),
          normalized
        };
      });
      const paths = normalizedEntries.map((entry) => entry.normalized.portablePath.toLowerCase());
      if (new Set(paths).size !== paths.length) {
        throw new Error("artifact transaction contains duplicate paths");
      }

      return withProjectLock(currentRealRoot, async (validateArtifactSideEffect) => {
        const operations = [];
        for (const entry of normalizedEntries) {
          const targetPath = path.resolve(currentRealRoot, entry.normalized.platformPath);
          const destination = await assertWritableDestination(currentRealRoot, targetPath, "artifact path");
          if (entry.hasExpectedContent) {
            if (entry.expectedContent === null && destination.exists) {
              throw Object.assign(new Error("artifact changed; reload before saving"), { code: "ETAG_MISMATCH" });
            }
            if (typeof entry.expectedContent === "string") {
              if (!destination.exists || await fs.promises.readFile(targetPath, "utf8") !== entry.expectedContent) {
                throw Object.assign(new Error("artifact changed; reload before saving"), { code: "ETAG_MISMATCH" });
              }
            }
          }
          await ensureSafeParent(
            currentRealRoot,
            targetPath,
            "artifact parent",
            validateArtifactSideEffect
          );

          let snapshotPath = null;
          if (destination.exists) {
            snapshotPath = path.join(
              currentRealRoot,
              ".zzj",
              "v3-snapshots",
              transactionId,
              entry.normalized.platformPath
            );
            await assertWritableDestination(currentRealRoot, snapshotPath, "snapshot path");
            await ensureSafeParent(
              currentRealRoot,
              snapshotPath,
              "snapshot parent",
              validateArtifactSideEffect
            );
          }
          operations.push({ ...entry, destination, snapshotPath, targetPath });
        }

        for (const operation of operations) {
          if (operation.snapshotPath) {
            await atomicSnapshot(
              operation.targetPath,
              operation.snapshotPath,
              validateArtifactSideEffect
            );
          }
        }

        const applied = [];
        try {
          for (const operation of operations) {
            await atomicWrite(operation.targetPath, operation.content, validateArtifactSideEffect);
            applied.push(operation);
          }
        } catch (error) {
          let rollbackError = null;
          for (const operation of applied.reverse()) {
            try {
              if (operation.destination.exists) {
                const previous = await fs.promises.readFile(operation.snapshotPath, "utf8");
                await atomicWrite(operation.targetPath, previous, validateArtifactSideEffect);
              } else {
                await validateArtifactSideEffect(operation.targetPath);
                await fs.promises.rm(operation.targetPath, { force: true });
              }
            } catch (candidate) {
              rollbackError ||= candidate;
            }
          }
          if (rollbackError) error.rollbackError = rollbackError;
          throw error;
        }

        return Object.freeze(operations.map((operation) => Object.freeze({
          bytes: operation.bytes,
          path: operation.targetPath,
          relativePath: operation.normalized.portablePath,
          snapshotPath: operation.snapshotPath,
          transactionId
        })));
      });
    }

    async function writeText(relativePath, content, writeOptions = {}) {
      const [result] = await writeTexts([{ relativePath, content }], writeOptions);
      return result;
    }

    function humanizerRuleStatePath() {
      return path.join(currentRealRoot, ...HUMANIZER_RULE_STATE_PARTS);
    }

    async function readHumanizerRuleState() {
      const targetPath = humanizerRuleStatePath();
      try {
        await assertNoLinkComponents(currentRealRoot, targetPath, "humanizer rule state");
        const realTargetPath = await realpathInside(currentRealRoot, targetPath, "humanizer rule state");
        const status = await fs.promises.stat(realTargetPath);
        if (!status.isFile()) throw new Error("humanizer rule state must be a file");
        if (status.size > maxFileBytes) throw new Error("humanizer rule state exceeds the file-size cap");
        return await fs.promises.readFile(realTargetPath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
    }

    async function writeHumanizerRuleState(content) {
      if (typeof content !== "string") throw new TypeError("humanizer rule state must be text");
      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxFileBytes) throw new Error("humanizer rule state exceeds the file-size cap");
      return withProjectLock(currentRealRoot, async (validateSideEffect) => {
        const targetPath = humanizerRuleStatePath();
        await assertWritableDestination(currentRealRoot, targetPath, "humanizer rule state");
        await ensureSafeParent(currentRealRoot, targetPath, "humanizer rule state", validateSideEffect);
        await atomicWrite(targetPath, content, validateSideEffect);
        return Object.freeze({ bytes, path: targetPath });
      });
    }

    return Object.freeze({
      ...publicProject(record),
      internal: Object.freeze({ readHumanizerRuleState, writeHumanizerRuleState }),
      listArtifacts,
      readText,
      writeText,
      writeTexts
    });
  }

  return Object.freeze({ listProjects, openProject, registerProject });
}

module.exports = {
  ALLOWED_EXTENSIONS,
  DEFAULT_MAX_FILE_BYTES,
  createProjectStore
};
