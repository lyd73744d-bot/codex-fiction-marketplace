"use strict";

const crypto = require("node:crypto");

const OFFICIAL_PATTERN_IDS = new Set([
  ...Array.from({ length: 24 }, (_, index) => `H${String(index + 1).padStart(2, "0")}`),
  "N01", "N02", "N03", "N04", "N05"
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const RULE_REF_PATTERN = /^[a-zA-Z0-9._:-]+@[1-9][0-9]*$/;

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function assertString(value, label, maxLength = 800) {
  if (typeof value !== "string" || !value || value.length > maxLength) {
    throw new TypeError(`${label} is invalid`);
  }
  return value;
}

function verifySource(chapterText, sourceHash) {
  if (typeof chapterText !== "string" || !chapterText) throw new TypeError("chapterText is invalid");
  if (typeof sourceHash !== "string" || !HASH_PATTERN.test(sourceHash) || sha256(chapterText) !== sourceHash) {
    throw new Error("sourceHash does not match chapterText");
  }
}

function verifyQuote(chapterText, finding) {
  const quote = assertString(finding.quote, "finding.quote");
  const startOffset = finding.startOffset;
  const endOffset = finding.endOffset;
  if (!Number.isSafeInteger(startOffset) || startOffset < 0
    || !Number.isSafeInteger(endOffset) || endOffset <= startOffset
    || chapterText.slice(startOffset, endOffset) !== quote) {
    throw new Error("finding quote does not match its UTF-16 offset range");
  }
  return { quote, startOffset, endOffset };
}

function uniqueStrings(value, label, pattern) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) throw new TypeError(`${label} is invalid`);
  const strings = value.map((item) => assertString(item, label, 160));
  if (pattern && strings.some((item) => !pattern.test(item))) throw new TypeError(`${label} is invalid`);
  return [...new Set(strings)].sort();
}

function normalizeOfficialFinding(chapterText, sourceHash, finding, index) {
  assertObject(finding, "official finding");
  const range = verifyQuote(chapterText, finding);
  if (finding.sourceHash !== undefined && finding.sourceHash !== sourceHash) throw new Error("finding sourceHash mismatch");
  if (!OFFICIAL_PATTERN_IDS.has(finding.patternId)) throw new Error("official finding patternId is invalid");
  return {
    id: assertString(finding.id || `official-${index + 1}`, "finding.id", 128),
    patternId: finding.patternId,
    ...range,
    sourceHash
  };
}

function normalizeCommunityFinding(chapterText, sourceHash, finding, index) {
  assertObject(finding, "community finding");
  const range = verifyQuote(chapterText, finding);
  if (finding.sourceHash !== sourceHash) throw new Error("finding sourceHash mismatch");
  const categoryIds = uniqueStrings(
    finding.categoryIds || [finding.categoryId],
    "finding.categoryIds"
  );
  const categoryId = assertString(finding.categoryId || categoryIds[0], "finding.categoryId", 160);
  if (!categoryIds.includes(categoryId)) throw new Error("finding categoryId must be included in categoryIds");
  return {
    id: `community-${index + 1}`,
    ...range,
    categoryId,
    categoryIds,
    ruleRefs: uniqueStrings(finding.ruleRefs, "finding.ruleRefs", RULE_REF_PATTERN),
    sourceHash
  };
}

function buildHumanizerWorkflowInput(input = {}) {
  assertObject(input, "humanizer workflow input");
  const chapterText = input.chapterText;
  const sourceHash = input.sourceHash;
  verifySource(chapterText, sourceHash);
  const officialFindings = Array.isArray(input.officialFindings) ? input.officialFindings : [];
  const communityFindings = Array.isArray(input.communityFindings) ? input.communityFindings : [];
  if (officialFindings.length + communityFindings.length > 64) throw new Error("too many humanizer findings");
  return {
    chapterText,
    sourceHash,
    officialFindings: officialFindings.map((finding, index) => normalizeOfficialFinding(chapterText, sourceHash, finding, index)),
    communityFindings: communityFindings.map((finding, index) => normalizeCommunityFinding(chapterText, sourceHash, finding, index))
  };
}

function applyValidatedHumanizerRevision(input = {}) {
  assertObject(input, "humanizer revision input");
  const chapterText = input.chapterText;
  const sourceHash = input.sourceHash;
  verifySource(chapterText, sourceHash);
  const revision = assertObject(input.revision, "revision");
  if (revision.sourceHash !== sourceHash) throw new Error("revision sourceHash mismatch");
  const findings = Array.isArray(input.findings) ? input.findings : [];
  const byId = new Map();
  for (const finding of findings) {
    assertObject(finding, "finding");
    const id = assertString(finding.id, "finding.id", 128);
    if (byId.has(id)) throw new Error("duplicate finding id");
    verifyQuote(chapterText, finding);
    if (finding.sourceHash !== sourceHash) throw new Error("finding sourceHash mismatch");
    byId.set(id, finding);
  }

  const changes = Array.isArray(revision.changes) ? revision.changes : [];
  const unresolved = Array.isArray(revision.unresolved) ? revision.unresolved : [];
  const covered = new Set();
  const patches = [];
  for (const change of changes) {
    assertObject(change, "revision change");
    const id = assertString(change.findingId, "change.findingId", 128);
    const finding = byId.get(id);
    if (!finding || covered.has(id)) throw new Error("each finding must appear exactly once");
    if (change.startOffset !== finding.startOffset || change.endOffset !== finding.endOffset
      || change.before !== finding.quote || chapterText.slice(change.startOffset, change.endOffset) !== change.before) {
      throw new Error("revision change is outside its validated finding");
    }
    if (typeof change.after !== "string" || change.after.length > 4_000) throw new Error("revision replacement is invalid");
    covered.add(id);
    patches.push({ startOffset: change.startOffset, endOffset: change.endOffset, after: change.after });
  }
  for (const item of unresolved) {
    assertObject(item, "unresolved finding");
    const id = assertString(item.findingId, "unresolved.findingId", 128);
    if (!byId.has(id) || covered.has(id)) throw new Error("each finding must appear exactly once");
    covered.add(id);
  }
  if (covered.size !== byId.size) throw new Error("each finding must appear exactly once");

  patches.sort((left, right) => left.startOffset - right.startOffset);
  for (let index = 1; index < patches.length; index += 1) {
    if (patches[index].startOffset < patches[index - 1].endOffset) throw new Error("validated finding patches overlap");
  }
  let cursor = 0;
  let revisedText = "";
  for (const patch of patches) {
    revisedText += chapterText.slice(cursor, patch.startOffset);
    revisedText += patch.after;
    cursor = patch.endOffset;
  }
  revisedText += chapterText.slice(cursor);
  if (revision.revisedText !== revisedText) throw new Error("revision revisedText does not equal the exact patches");
  return { sourceHash, revisedText, preservedOutsideFindings: true };
}

module.exports = {
  OFFICIAL_PATTERN_IDS,
  applyValidatedHumanizerRevision,
  buildHumanizerWorkflowInput
};
