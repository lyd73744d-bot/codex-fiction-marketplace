const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROMPT_ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const MIGRATION_STATUSES = new Set(["extracted", "adapted", "verified", "active"]);
const INVENTORY_PATH = Symbol("inventoryPath");
const DEFAULT_BUILTIN_INVENTORY_PATHS = Object.freeze([
  path.resolve(__dirname, "../resources/prompts/inkos-prompt-inventory.json"),
  path.resolve(__dirname, "../resources/prompts/humanizer-zh-prompt-inventory.json")
]);

function computePromptSha256(content) {
  if (typeof content !== "string") {
    throw new TypeError("prompt checksum content must be a string");
  }
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (
    relative !== ".."
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function resolveInlineMaterial(record) {
  const hasTemplate = typeof record.template === "string";
  const hasSourceText = typeof record.sourceText === "string";
  if (hasTemplate && hasSourceText && record.template !== record.sourceText) {
    throw new Error(`${record.id || "prompt"} has conflicting inline integrity sources`);
  }
  if (hasTemplate) return record.template;
  if (hasSourceText) return record.sourceText;
  return undefined;
}

function resolveSourceArtifactMaterial(record, options = {}) {
  const hasArtifact = typeof record.sourceArtifact === "string" && record.sourceArtifact.length > 0;
  if (!hasArtifact) {
    if (record.sourceArtifactKey !== undefined || record.sourceArtifactSha256 !== undefined) {
      throw new Error(`${record.id || "prompt"} has source artifact metadata without sourceArtifact`);
    }
    return undefined;
  }

  const inventoryPath = options.inventoryPath;
  if (typeof inventoryPath !== "string" || !inventoryPath) {
    throw new Error(`${record.id || "prompt"} sourceArtifact requires inventoryPath`);
  }

  const inventoryDirectory = path.dirname(path.resolve(inventoryPath));
  const artifactPath = path.resolve(inventoryDirectory, record.sourceArtifact);
  const relative = path.relative(inventoryDirectory, artifactPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${record.id || "prompt"} sourceArtifact escapes the inventory directory`);
  }

  const realInventoryDirectory = fs.realpathSync(inventoryDirectory);
  const realArtifactPath = fs.realpathSync(artifactPath);
  if (!isPathInside(realInventoryDirectory, realArtifactPath)) {
    throw new Error(`${record.id || "prompt"} sourceArtifact escapes the inventory real path`);
  }

  const artifact = fs.readFileSync(realArtifactPath, "utf8");
  if (record.sourceArtifactKey === undefined) {
    return artifact;
  }
  if (typeof record.sourceArtifactKey !== "string" || !record.sourceArtifactKey) {
    throw new Error(`${record.id || "prompt"} has invalid sourceArtifactKey`);
  }

  let sourceMap;
  try {
    sourceMap = JSON.parse(artifact);
  } catch (error) {
    throw new Error(`${record.id || "prompt"} sourceArtifact is not valid JSON: ${error.message}`);
  }
  const material = sourceMap[record.sourceArtifactKey];
  if (typeof material !== "string") {
    throw new Error(`${record.id || "prompt"} sourceArtifactKey was not found`);
  }
  return material;
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) {
    deepFreeze(child, seen);
  }
  return Object.freeze(value);
}

function validatePromptRecord(record, options = {}) {
  if (!isPlainObject(record)) {
    throw new TypeError("prompt record must be an object");
  }

  for (const field of [
    "id",
    "category",
    "workflow",
    "stage",
    "role",
    "source",
    "sourceKind",
    "sourceFile",
    "sourceSymbol",
    "locale",
    "version",
    "sha256",
    "status"
  ]) {
    if (typeof record[field] !== "string" || !record[field]) {
      throw new Error(`${record.id || "prompt"}.${field} must be a non-empty string`);
    }
  }

  if (!PROMPT_ID_PATTERN.test(record.id)) {
    throw new Error(`invalid prompt id: ${record.id}`);
  }
  if (!SHA256_PATTERN.test(record.sha256)) {
    throw new Error(`${record.id} has invalid SHA-256`);
  }
  if (!MIGRATION_STATUSES.has(record.status)) {
    throw new Error(`${record.id} has invalid migration status: ${record.status}`);
  }
  if (!isPlainObject(record.variablesSchema) || record.variablesSchema.type !== "object") {
    throw new Error(`${record.id} has invalid variablesSchema`);
  }
  if (!isPlainObject(record.outputSchema)) {
    throw new Error(`${record.id} has invalid outputSchema`);
  }

  const inlineMaterial = resolveInlineMaterial(record);
  const artifactMaterial = resolveSourceArtifactMaterial(record, options);
  if (inlineMaterial === undefined && artifactMaterial === undefined) {
    throw new Error(`${record.id} needs template, sourceText, or sourceArtifact`);
  }

  if (artifactMaterial !== undefined) {
    if (!SHA256_PATTERN.test(record.sourceArtifactSha256 || "")) {
      throw new Error(`${record.id} has invalid source artifact SHA-256`);
    }
    const actualArtifactSha256 = computePromptSha256(artifactMaterial);
    if (actualArtifactSha256 !== record.sourceArtifactSha256) {
      throw new Error(
        `${record.id} source artifact checksum mismatch: expected ${record.sourceArtifactSha256}, received ${actualArtifactSha256}`
      );
    }
  }

  const material = inlineMaterial === undefined ? artifactMaterial : inlineMaterial;
  const actual = computePromptSha256(material);
  if (actual !== record.sha256) {
    throw new Error(`${record.id} checksum mismatch: expected ${record.sha256}, received ${actual}`);
  }
  return record;
}

function loadPromptInventory(inventoryPath) {
  const absolutePath = path.resolve(inventoryPath);
  const inventory = JSON.parse(fs.readFileSync(absolutePath, "utf8"));
  if (!isPlainObject(inventory) || inventory.schemaVersion !== 1 || !Array.isArray(inventory.prompts)) {
    throw new Error("invalid prompt inventory document");
  }

  const ids = new Set();
  const sourceSymbols = new Set();
  for (const record of inventory.prompts) {
    validatePromptRecord(record, { inventoryPath: absolutePath });
    if (
      record.sourceKind === "adapted-static"
      && resolveInlineMaterial(record) === undefined
    ) {
      record.template = resolveSourceArtifactMaterial(record, { inventoryPath: absolutePath });
    }
    if (ids.has(record.id)) {
      throw new Error(`duplicate prompt id: ${record.id}`);
    }
    ids.add(record.id);
    const sourceSymbol = `${record.sourceFile}#${record.sourceSymbol}`;
    if (sourceSymbols.has(sourceSymbol)) {
      throw new Error(`duplicate sourceFile#sourceSymbol: ${sourceSymbol}`);
    }
    sourceSymbols.add(sourceSymbol);
  }

  Object.defineProperty(inventory, INVENTORY_PATH, {
    value: absolutePath,
    enumerable: false
  });
  return inventory;
}

function normalizeLayer(layer, name) {
  if (layer === undefined || layer === null) {
    return [];
  }

  if (Array.isArray(layer) && layer.every((entry) => typeof entry === "string")) {
    const records = layer.flatMap((inventoryPath) => normalizeLayer(inventoryPath, name));
    const ids = new Set();
    for (const record of records) {
      if (ids.has(record.id)) {
        throw new Error(`duplicate prompt id in ${name} layer: ${record.id}`);
      }
      ids.add(record.id);
    }
    return records;
  }
  if (Array.isArray(layer) && layer.some((entry) => typeof entry === "string")) {
    throw new TypeError(`${name} prompt layer cannot mix inventory paths and prompt records`);
  }

  let records;
  let inventoryPath;
  if (typeof layer === "string") {
    const inventory = loadPromptInventory(layer);
    records = inventory.prompts;
    inventoryPath = inventory[INVENTORY_PATH];
  } else if (Array.isArray(layer)) {
    records = layer;
  } else if (isPlainObject(layer) && Array.isArray(layer.prompts)) {
    records = layer.prompts;
    inventoryPath = layer[INVENTORY_PATH];
  } else {
    throw new TypeError(`${name} prompt layer must be an array, inventory, or inventory path`);
  }

  const ids = new Set();
  return records.map((record) => {
    validatePromptRecord(record, { inventoryPath });
    if (ids.has(record.id)) {
      throw new Error(`duplicate prompt id in ${name} layer: ${record.id}`);
    }
    ids.add(record.id);
    return deepFreeze({ ...structuredClone(record), layer: name });
  });
}

function createPromptRegistry(options = {}) {
  const byId = new Map();
  const layerIndex = new Map();
  const layers = [
    ["builtin", normalizeLayer(options.builtin, "builtin")],
    ["user", normalizeLayer(options.user, "user")],
    ["project", normalizeLayer(options.project, "project")]
  ];

  for (const [layerName, records] of layers) {
    for (const record of records) {
      byId.set(record.id, record);
      const names = layerIndex.get(record.id) || [];
      names.unshift(layerName);
      layerIndex.set(record.id, names);
    }
  }

  return Object.freeze({
    get(id) {
      return byId.get(id);
    },
    has(id) {
      return byId.has(id);
    },
    layers(id) {
      return [...(layerIndex.get(id) || [])];
    },
    list() {
      return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
    }
  });
}

function createBuiltinPromptRegistry(options = {}) {
  return createPromptRegistry({
    builtin: options.builtin === undefined
      ? DEFAULT_BUILTIN_INVENTORY_PATHS
      : options.builtin,
    user: options.user,
    project: options.project
  });
}

module.exports = {
  computePromptSha256,
  createBuiltinPromptRegistry,
  createPromptRegistry,
  loadPromptInventory,
  validatePromptRecord
};
