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

function uniqueMatches(value, pattern, group = 0) {
  const found = [];
  for (const match of String(value || "").matchAll(pattern)) {
    const evidence = compact(match[group] || match[0]);
    if (evidence && !found.includes(evidence)) found.push(evidence);
  }
  return found;
}

function factBoundaryIssues(body, requestText) {
  const request = String(requestText || "");
  if (!request.trim()) return [];
  const issues = [];
  const nameBoundary = /(?:没有确认|未确认|尚未确认|未知|待定|不明确).{0,12}(?:姓名|名字|专名|人物身份)|(?:姓名|名字|专名|人物身份).{0,8}(?:没有确认|未确认|尚未确认|未知|待定|不明确)|(?:不要|不得|禁止).{0,16}(?:补造|编造|新增|自行补全).{0,10}(?:姓名|名字|专名|人物身份)/u.test(request);
  const quantityBoundary = /(?:不要|不得|禁止|没有确认|未确认|未知).{0,36}(?:精确)?(?:数量|数字|兵力|存量|日期)|(?:数量|数字|兵力|存量|日期).{0,8}(?:没有确认|未确认|未知|待定)/u.test(request);
  const placeBoundary = /(?:没有确认|未确认|尚未确认|未知|待定|不明确).{0,12}(?:地点|地名|地形|营地)|(?:地点|地名|地形|营地).{0,8}(?:没有确认|未确认|尚未确认|未知|待定|不明确)|(?:不要|不得|禁止).{0,28}(?:真实战役|地点|地名|地形)/u.test(request);

  if (nameBoundary) {
    const rankedNames = uniqueMatches(body, /(?:千总|把总|百户|总旗|小旗|校尉|守备|参将|总兵)(?:名叫|叫)?\s*([一-龥]{2,3})(?=[从向把将带正走说问答回去来，。：；“”「」])/gu, 1)
      .filter((item) => !/^(?:的|在|把|将|正|说|问|答|走|回|去|来|看|听|带|从|向)/u.test(item));
    const givenNames = uniqueMatches(body, /(?:名叫|叫作)\s*([一-龥]{1,3})(?=[的，。：；“”「」])/gu, 1);
    const surnames = uniqueMatches(body, /姓\s*([一-龥])(?=[的，。：；“”「」])/gu, 1);
    const explicitNames = [...givenNames, ...surnames];
    const names = [...new Set([...rankedNames, ...explicitNames])].filter((item) => !request.includes(item));
    if (names.length) {
      issues.push(hardIssue("unconfirmed-name-risk", names.slice(0, 6).join("、"), "核对人物台账；未确认的姓名保持空缺、称谓或相对关系，不得自行命名", "medium"));
    }
  }

  if (quantityBoundary) {
    const quantities = uniqueMatches(body, /(?:\d+|[零〇一二三四五六七八九十百千万两廿卅]+)(?:余|来|多|成)?(?:人|名|骑|匹|石|斗|升|袋|车|队|里|尺|丈|营|具|支|杆|枚|日|天|月|年)/gu)
      .filter((item) => !request.includes(item));
    if (quantities.length) {
      issues.push(hardIssue("unconfirmed-quantity-risk", quantities.slice(0, 8).join("、"), "把未确认的精确数字改为相对判断，或先补齐可核验的事实来源", "medium"));
    }
  }

  if (placeBoundary) {
    const places = uniqueMatches(body, /(?:从|往|到|去|回|驻|移驻|来自)\s*([一-龥]{1,5}(?:州|府|县|驿|关|镇|卫|堡|寨))/gu, 1)
      .filter((item) => !request.includes(item));
    if (places.length) {
      issues.push(hardIssue("unconfirmed-place-risk", places.slice(0, 6).join("、"), "未确认的地名或路线不得落成确定事实；保留相对方位或先核验", "medium"));
    }
  }
  return issues;
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
  issues.push(...factBoundaryIssues(body, options.requestText));

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
  processLeakEvidence,
  factBoundaryIssues
};
