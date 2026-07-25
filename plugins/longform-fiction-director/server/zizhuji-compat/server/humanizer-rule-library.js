"use strict";

const crypto = require("node:crypto");

const STATE_VERSION = 1;
const RULE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const CATEGORY_PATTERN = /^(?:community\.[a-f0-9]{16}|builtin\.[A-Za-z0-9._-]{1,96}|project\.[A-Za-z0-9._-]{1,96})$/;
const ETAG_PATTERN = /^hl_[A-Za-z0-9_-]{43}$/;
const DETECTOR_KINDS = new Set(["literal_any", "literal_sequence", "density"]);
const DETECTOR_AREAS = new Set(["all", "dialogue", "narration"]);

class HumanizerRuleLibraryError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "HumanizerRuleLibraryError";
    this.code = code;
  }
}

function fail(message, code = "INVALID_RULE_STATE") {
  throw new HumanizerRuleLibraryError(code, message);
}

function plain(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function onlyKeys(value, allowed) {
  if (!plain(value)) fail("record must be a plain object");
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string" || !allowed.has(key)) fail("record contains an unsupported field");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail("record contains an accessor");
  }
}

function validateDetector(input) {
  onlyKeys(input, new Set(["kind", "terms", "minHits", "area"]));
  if (!DETECTOR_KINDS.has(input.kind) || !DETECTOR_AREAS.has(input.area)) fail("detector type is unsupported");
  if (!Array.isArray(input.terms) || input.terms.length < 1 || input.terms.length > 12) fail("detector terms are invalid");
  const terms = input.terms.map((term) => {
    if (typeof term !== "string" || !term || [...term].length > 40 || /[\u0000-\u001f\u007f]/u.test(term)) fail("detector term is invalid");
    return term;
  });
  if (new Set(terms).size !== terms.length) fail("detector terms must be unique");
  if (!Number.isSafeInteger(input.minHits) || input.minHits < 1 || input.minHits > 11) fail("detector threshold is invalid");
  if (input.kind !== "density" && input.minHits !== 1) fail("literal detectors use a threshold of one");
  return { kind: input.kind, terms, minHits: input.minHits, area: input.area };
}

function validateRule(input) {
  onlyKeys(input, new Set(["ruleId", "revision", "contentHash", "categoryId", "detector", "enabled", "status"]));
  if (typeof input.ruleId !== "string" || !RULE_ID_PATTERN.test(input.ruleId)) fail("rule id is invalid");
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail("rule revision is invalid");
  if (typeof input.contentHash !== "string" || !HASH_PATTERN.test(input.contentHash)) fail("rule content hash is invalid");
  if (typeof input.categoryId !== "string" || !CATEGORY_PATTERN.test(input.categoryId)) fail("rule category is invalid");
  if (typeof input.enabled !== "boolean") fail("rule enabled state is invalid");
  if (input.status !== undefined && !["published", "withdrawn", "hidden"].includes(input.status)) fail("rule status is invalid");
  return {
    ruleId: input.ruleId,
    revision: input.revision,
    contentHash: input.contentHash,
    categoryId: input.categoryId,
    detector: validateDetector(input.detector),
    enabled: input.enabled,
    status: input.status || "published"
  };
}

function makeEtag(value) {
  const digest = crypto.createHash("sha256").update(value, "utf8").digest("base64url");
  return `hl_${digest}`;
}

function emptyState(projectId) {
  return {
    version: STATE_VERSION,
    etag: makeEtag(`empty:${projectId}`),
    projectRules: [],
    disabledRuleIds: [],
    updatedAt: null
  };
}

function validateState(input, projectId) {
  onlyKeys(input, new Set(["version", "etag", "projectRules", "disabledRuleIds", "updatedAt"]));
  if (input.version !== STATE_VERSION || typeof input.etag !== "string" || !ETAG_PATTERN.test(input.etag)) fail("state header is invalid");
  if (!Array.isArray(input.projectRules) || input.projectRules.length > 256) fail("project rule list is invalid");
  if (!Array.isArray(input.disabledRuleIds) || input.disabledRuleIds.length > 512) fail("disabled rule list is invalid");
  const projectRules = input.projectRules.map(validateRule);
  const disabledRuleIds = input.disabledRuleIds.map((ruleId) => {
    if (typeof ruleId !== "string" || !RULE_ID_PATTERN.test(ruleId)) fail("disabled rule id is invalid");
    return ruleId;
  });
  if (new Set(projectRules.map((item) => item.ruleId)).size !== projectRules.length) fail("project rule ids must be unique");
  if (new Set(disabledRuleIds).size !== disabledRuleIds.length) fail("disabled rule ids must be unique");
  if (!(input.updatedAt === null || (typeof input.updatedAt === "string" && Number.isFinite(Date.parse(input.updatedAt))))) fail("updated time is invalid");
  return { version: STATE_VERSION, etag: input.etag, projectRules, disabledRuleIds, updatedAt: input.updatedAt, projectId };
}

function createHumanizerRuleLibrary(options = {}) {
  const { projectStore } = options;
  const currentTime = typeof options.now === "function" ? options.now : Date.now;
  if (!projectStore || typeof projectStore.openProject !== "function") throw new TypeError("projectStore is required");

  async function read(input = {}) {
    if (!plain(input) || typeof input.projectId !== "string") fail("project id is invalid");
    const project = await projectStore.openProject(input.projectId);
    const serialized = await project.internal.readHumanizerRuleState();
    if (serialized === null) return emptyState(input.projectId);
    try {
      return validateState(JSON.parse(serialized), input.projectId);
    } catch (error) {
      if (error instanceof HumanizerRuleLibraryError) throw error;
      fail("stored sidecar could not be verified");
    }
  }

  async function save(input = {}) {
    onlyKeys(input, new Set(["projectId", "ifMatch", "projectRules", "disabledRuleIds"]));
    if (typeof input.projectId !== "string" || typeof input.ifMatch !== "string") fail("save request is invalid");
    const current = await read({ projectId: input.projectId });
    if (current.etag !== input.ifMatch) fail("ETAG_MISMATCH", "ETAG_MISMATCH");
    const now = new Date(Number(currentTime())).toISOString();
    const provisional = validateState({
      version: STATE_VERSION,
      etag: makeEtag(crypto.randomUUID()),
      projectRules: input.projectRules,
      disabledRuleIds: input.disabledRuleIds,
      updatedAt: now
    }, input.projectId);
    const state = {
      version: provisional.version,
      etag: provisional.etag,
      projectRules: provisional.projectRules,
      disabledRuleIds: provisional.disabledRuleIds,
      updatedAt: provisional.updatedAt
    };
    const project = await projectStore.openProject(input.projectId);
    await project.internal.writeHumanizerRuleState(`${JSON.stringify(state, null, 2)}\n`);
    return { ...state, projectId: input.projectId };
  }

  return Object.freeze({ read, save });
}

module.exports = {
  HumanizerRuleLibraryError,
  createHumanizerRuleLibrary,
  validateDetector
};

