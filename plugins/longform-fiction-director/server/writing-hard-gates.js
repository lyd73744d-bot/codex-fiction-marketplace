"use strict";

function compact(value) {
  return String(value || "").trim();
}

function countPublishChars(value) {
  return String(value || "").replace(/\s+/g, "").length;
}

function stripTitleLine(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").trim().split("\n");
  if (/^\s*标题[：:]\s*\S+/.test(lines[0] || "")) lines.shift();
  return lines.join("\n").trim();
}

const VISIBLE_PROCESS_PATTERNS = [
  /(?:^|\n)\s*Check constraints\b/i,
  /(?:^|\n)\s*(?:检查说明|审稿意见|修改建议|审核结论|分析结果|自检结果|思考过程|推理过程)\s*[：:]/,
  /(?:^|\n)\s*(?:我先|让我|首先分析|作为AI|作为语言模型)/,
  /(?:^|\n)\s*(?:Step\s*\d+|步骤\s*\d+)\s*[:：]/i,
  /<\/?think>/i
];

function processLeakEvidence(raw) {
  const text = String(raw || "");
  for (const pattern of VISIBLE_PROCESS_PATTERNS) {
    const match = text.match(pattern);
    if (match) return compact(match[0]).slice(0, 80);
  }
  return "";
}

function hardIssue(rule, evidence, fix, severity = "high") {
  return {
    reviewer: "hard-gate",
    severity,
    evidence: compact(evidence).slice(0, 120),
    rule,
    fix: compact(fix)
  };
}

/**
 * Local hard gates before treating model output as usable chapter/candidate.
 * Soft templates are avoided: only block clear process leaks / empty / wrapper junk.
 */
function inspectChapter(value, options = {}) {
  const raw = String(value || "").replace(/\r\n?/g, "\n").trim();
  const body = stripTitleLine(raw);
  const chars = countPublishChars(body);
  const minChars = Math.max(0, Number(options.minChars ?? 0));
  const maxChars = Math.max(minChars, Number(options.maxChars ?? Number.MAX_SAFE_INTEGER));
  const issues = [];

  if (!body) {
    issues.push(hardIssue("empty-output", "正文为空", "重新生成完整正文"));
  }
  const leak = processLeakEvidence(raw);
  if (leak) {
    issues.push(hardIssue("visible-process-leak", leak, "只输出正文，不输出思考、自检或约束计算"));
  }
  if (/^```[\s\S]*```\s*$/.test(raw) || /^```/.test(raw.trim()) && /```\s*$/.test(raw.trim())) {
    issues.push(hardIssue("output-wrapper", "```", "移除代码块和正文之外的包装"));
  }
  const nonChapterLead = body.match(/^\s*(?:检查说明|审稿意见|修改建议|审核结论|分析结果|自检结果)\s*[：:]/);
  if (nonChapterLead) {
    issues.push(hardIssue("non-chapter-output", nonChapterLead[0], "只返回完整章节正文，不返回检查或修改说明"));
  }
  if (chars > 0 && chars < minChars) {
    issues.push(hardIssue("chapter-too-short", "当前 " + chars + " 字", "在不新增设定的前提下扩写到至少 " + minChars + " 字"));
  }
  if (chars > maxChars) {
    issues.push(hardIssue("chapter-too-long", "当前 " + chars + " 字", "保留完整因果并重写压缩到不超过 " + maxChars + " 字"));
  }

  return {
    ok: issues.length === 0,
    issues,
    body,
    chars,
    modelReadable: true
  };
}

function isAcceptableCandidate(value, options = {}) {
  const gate = inspectChapter(value, options);
  // For candidate generation, only hard-fail empty + process leak + non-chapter wrapper.
  const blockers = gate.issues.filter((i) =>
    ["empty-output", "visible-process-leak", "non-chapter-output", "output-wrapper"].includes(i.rule)
  );
  return {
    ok: blockers.length === 0,
    blockers,
    gate
  };
}

module.exports = {
  inspectChapter,
  isAcceptableCandidate,
  countPublishChars,
  processLeakEvidence
};
