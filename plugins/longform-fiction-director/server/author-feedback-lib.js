"use strict";

function compact(value, fallback = "") {
  return String(value || fallback).trim();
}

function normalizeAuthorFeedback(value) {
  const raw = compact(value);
  const result = {
    raw,
    preserveIntent: [],
    requestedChange: [],
    avoid: [],
    desiredEffect: [],
    exactText: []
  };
  if (!raw) return result;
  const parts = raw.split(/[\n，；;]+/).map((item) => item.trim()).filter(Boolean);
  for (const part of parts) {
    if (/一字不改|逐字保留|原句保留|原封不动/.test(part)) result.exactText.push(part);
    else if (/保留|别删|延续|维持/.test(part)) result.preserveIntent.push(part);
    else if (/删除|删掉|去掉|不要|避免|禁止|别写/.test(part)) result.avoid.push(part);
    else if (/加强|增加|多一点|更强|更狠|突出|强化/.test(part)) result.desiredEffect.push(part);
    else result.requestedChange.push(part);
  }
  return result;
}

function listOrNone(items) {
  return items.length ? items.map((item) => "- " + item).join("\n") : "- 无";
}

function authorFeedbackBlock(value) {
  const feedback = normalizeAuthorFeedback(value);
  if (!feedback.raw) return "";
  return [
    "# 作者本次要求",
    feedback.raw,
    "",
    "这只是本次取向，不是正文素材；除明确要求逐字保留的原句外，不要把它改写进正文。"
  ].join("\n");
}

module.exports = {
  normalizeAuthorFeedback,
  authorFeedbackBlock
};
