"use strict";

const crypto = require("node:crypto");
const { validateDetector } = require("./humanizer-rule-library");

const INVARIANT_GUARDS = Object.freeze({
  preserveFacts: true,
  preserveCharacterVoice: true,
  preserveTimeline: true,
  preserveFileBoundary: true,
  preserveRouting: true,
  preserveOutputSchema: true
});

class HumanizerRuleResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HumanizerRuleResolverError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new HumanizerRuleResolverError(code, message);
}

function cloneDetector(detector) {
  try {
    return validateDetector(detector);
  } catch {
    fail("INVALID_RULE_SET", "Humanizer detector could not be verified");
  }
}

function normalizeRule(input, source) {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("INVALID_RULE_SET", "Humanizer rule is invalid");
  if (typeof input.ruleId !== "string" || !input.ruleId || !Number.isSafeInteger(input.revision) || input.revision < 1) fail("INVALID_RULE_SET", "Humanizer rule identity is invalid");
  if (typeof input.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(input.contentHash)) fail("INVALID_RULE_SET", "Humanizer rule hash is invalid");
  if (typeof input.categoryId !== "string" || !input.categoryId) fail("INVALID_RULE_SET", "Humanizer rule category is invalid");
  return {
    ruleId: input.ruleId,
    revision: input.revision,
    contentHash: input.contentHash,
    categoryId: input.categoryId,
    detector: cloneDetector(input.detector),
    status: typeof input.status === "string" ? input.status : "published",
    source
  };
}

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function resolveHumanizerRules(input = {}) {
  const now = Number(input.now === undefined ? Date.now() : input.now);
  const manifest = input.accountManifest;
  if (!manifest || typeof manifest !== "object" || manifest.version !== 1
    || !Number.isFinite(Number(manifest.expiresAt)) || Number(manifest.expiresAt) <= now
    || !Array.isArray(manifest.rules)) {
    fail("COMMUNITY_RULES_UNVERIFIED", "Community rule manifest is unavailable or expired");
  }
  const projectState = input.projectState;
  if (!projectState || typeof projectState !== "object" || projectState.version !== 1
    || !Array.isArray(projectState.projectRules) || !Array.isArray(projectState.disabledRuleIds)) {
    fail("INVALID_RULE_SET", "Project rule state is invalid");
  }
  const disabled = new Set(projectState.disabledRuleIds.filter((value) => typeof value === "string"));
  const selected = new Map();
  const layers = [
    ["builtin", Array.isArray(input.builtinRules) ? input.builtinRules : []],
    ["account", manifest.rules],
    ["project", projectState.projectRules.filter((item) => item?.enabled !== false)]
  ];
  for (const [source, rules] of layers) {
    for (const rawRule of rules) {
      const rule = normalizeRule(rawRule, source);
      const reference = `${rule.ruleId}@${rule.revision}`;
      if (disabled.has(rule.ruleId) || disabled.has(reference)) continue;
      selected.set(rule.categoryId, rule);
    }
  }
  const rules = [...selected.values()].sort((left, right) => left.categoryId.localeCompare(right.categoryId));
  return Object.freeze({
    version: 1,
    ruleSetHash: stableHash(rules),
    rules: Object.freeze(rules.map(Object.freeze)),
    invariantGuards: INVARIANT_GUARDS
  });
}

function dialogueMask(text) {
  const mask = new Uint8Array(text.length);
  const closing = new Map([["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]]);
  const stack = [];
  let asciiDouble = false;
  let asciiSingle = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (closing.has(character)) {
      stack.push(closing.get(character));
      continue;
    }
    if (stack.length && character === stack[stack.length - 1]) {
      stack.pop();
      continue;
    }
    if (character === '"') { asciiDouble = !asciiDouble; continue; }
    if (character === "'") { asciiSingle = !asciiSingle; continue; }
    if (stack.length || asciiDouble || asciiSingle) mask[index] = 1;
  }
  return mask;
}

function areaMatches(mask, start, end, area) {
  if (area === "all") return true;
  let dialogue = false;
  for (let index = start; index < end; index += 1) dialogue ||= mask[index] === 1;
  return area === "dialogue" ? dialogue : !dialogue;
}

function allTermHits(text, term, mask, area) {
  const hits = [];
  let start = 0;
  while (start <= text.length - term.length) {
    const index = text.indexOf(term, start);
    if (index < 0) break;
    const end = index + term.length;
    if (areaMatches(mask, index, end, area)) hits.push({ start: index, end });
    start = index + Math.max(1, term.length);
  }
  return hits;
}

function detectorHits(text, detector, mask) {
  if (detector.kind === "literal_any") {
    return detector.terms.flatMap((term) => allTermHits(text, term, mask, detector.area));
  }
  if (detector.kind === "literal_sequence") {
    const hits = [];
    let cursor = 0;
    while (cursor < text.length) {
      let first = -1;
      let end = -1;
      let searchFrom = cursor;
      let matched = true;
      for (const term of detector.terms) {
        const index = text.indexOf(term, searchFrom);
        if (index < 0) { matched = false; break; }
        if (first < 0) first = index;
        end = index + term.length;
        searchFrom = end;
      }
      if (!matched) break;
      if (areaMatches(mask, first, end, detector.area)) hits.push({ start: first, end });
      cursor = Math.max(end, cursor + 1);
    }
    return hits;
  }
  const hits = detector.terms
    .flatMap((term) => allTermHits(text, term, mask, detector.area))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (hits.length < detector.minHits) return [];
  return [{ start: hits[0].start, end: hits[hits.length - 1].end, occurrences: hits.length }];
}

function matchHumanizerRules(input = {}) {
  const text = input.text;
  const rules = input.resolvedRules?.rules;
  if (typeof text !== "string" || !Array.isArray(rules)) fail("INVALID_RULE_SET", "Matcher input is invalid");
  const sourceHash = crypto.createHash("sha256").update(text, "utf8").digest("hex");
  const mask = dialogueMask(text);
  const merged = new Map();
  for (const rule of rules) {
    const normalized = normalizeRule(rule, rule.source || "unknown");
    for (const hit of detectorHits(text, normalized.detector, mask)) {
      const key = `${hit.start}:${hit.end}`;
      const existing = merged.get(key) || {
        quote: text.slice(hit.start, hit.end),
        startOffset: hit.start,
        endOffset: hit.end,
        categoryIds: [],
        ruleRefs: [],
        sourceHash,
        occurrences: hit.occurrences || 1
      };
      existing.categoryIds.push(normalized.categoryId);
      existing.ruleRefs.push(`${normalized.ruleId}@${normalized.revision}`);
      existing.occurrences = Math.max(existing.occurrences, hit.occurrences || 1);
      merged.set(key, existing);
    }
  }
  const findings = [...merged.values()].map((finding) => {
    finding.categoryIds = [...new Set(finding.categoryIds)].sort();
    finding.categoryId = finding.categoryIds[0];
    finding.ruleRefs = [...new Set(finding.ruleRefs)].sort();
    return finding;
  }).sort((left, right) => left.startOffset - right.startOffset || left.endOffset - right.endOffset);
  return { sourceHash, findings };
}

module.exports = {
  HumanizerRuleResolverError,
  INVARIANT_GUARDS,
  matchHumanizerRules,
  resolveHumanizerRules
};

