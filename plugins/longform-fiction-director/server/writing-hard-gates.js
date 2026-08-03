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

const FIRST_DRAFT_REJECTED_PHRASES = [
  "算账",
  "这笔账",
  "该收了",
  "该算账",
  "压力",
  "施压",
  "层层加码",
  "声音密得像有人在拿沙袋往木板上倒",
  "声音密得像有人拿沙袋往木板上倒",
  "目光如炬",
  "声音如钟",
  "雪花纷扬如鹅毛",
  "远山如黛"
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
  const historyScope = /(?:历史小说|历史题材|明末|大明|清军|崇祯|万历|天启|顺治|康熙)/u.test(request);
  const nameBoundary = /(?:没有确认|未确认|尚未确认|未知|待定|不明确).{0,12}(?:姓名|名字|专名|人物身份)|(?:姓名|名字|专名|人物身份).{0,8}(?:没有确认|未确认|尚未确认|未知|待定|不明确)|(?:不要|不得|禁止).{0,16}(?:补造|编造|新增|自行补全).{0,10}(?:姓名|名字|专名|人物身份)/u.test(request);
  const quantityBoundary = historyScope || /(?:不要|不得|禁止|没有确认|未确认|未知).{0,36}(?:精确)?(?:数量|数字|兵力|存量|日期)|(?:数量|数字|兵力|存量|日期).{0,8}(?:没有确认|未确认|未知|待定)/u.test(request);
  const placeBoundary = historyScope || /(?:没有确认|未确认|尚未确认|未知|待定|不明确).{0,12}(?:地点|地名|地形|营地)|(?:地点|地名|地形|营地).{0,8}(?:没有确认|未确认|尚未确认|未知|待定|不明确)|(?:不要|不得|禁止).{0,28}(?:真实战役|地点|地名|地形)/u.test(request);

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
    const placePattern = historyScope
      ? /([一-龥]{1,5}(?:州|府|县|驿|关|镇|卫|堡|寨|庄))/gu
      : /(?:从|往|到|去|回|驻|移驻|来自|在|于)\s*([一-龥]{1,5}(?:州|府|县|驿|关|镇|卫|堡|寨|庄))/gu;
    const places = uniqueMatches(body, placePattern, 1)
      .filter((item) => !request.includes(item));
    if (places.length) {
      issues.push(hardIssue("unconfirmed-place-risk", places.slice(0, 6).join("、"), "未确认的地名或路线不得落成确定事实；保留相对方位或先核验", "medium"));
    }
  }
  return issues;
}

function declaredConstraintIssues(body, requestText) {
  const request = String(requestText || "");
  const text = String(body || "");
  const issues = [];

  // A supplied reign-year is a concrete fact, not an invitation to retell it from memory.
  const requestedEra = request.match(/(崇祯|万历|天启|顺治|康熙)([〇零一二三四五六七八九十百\d]+)年/u);
  if (requestedEra) {
    const bodyEras = [...text.matchAll(/(崇祯|万历|天启|顺治|康熙)([〇零一二三四五六七八九十百\d]+)年/gu)];
    const conflict = bodyEras.find((match) => match[1] === requestedEra[1] && match[2] !== requestedEra[2]);
    if (conflict) {
      issues.push(hardIssue("declared-era-conflict", conflict[0], "沿用作者已给定的年号与年份；不凭模型记忆改写历史时间", "high"));
    }
  }

  const knownOnlyMap = /(?:军图|地图).{0,36}(?:只|仅).{0,16}(?:已知|所见所闻)|(?:只|仅).{0,20}(?:记录|显示).{0,16}(?:已知|所见所闻)/u.test(request);
  if (knownOnlyMap) {
    const forbiddenPower = text.match(/(?:军图|地图).{0,36}(?:全知|全能|意念|控制|完美|随时看见|直接指挥)|(?:全知|全能|意念|控制|完美|随时看见|直接指挥).{0,36}(?:军图|地图)/u);
    if (forbiddenPower) {
      issues.push(hardIssue("known-only-map-expanded", forbiddenPower[0], "军图只保留作者给定的已知信息边界；把超出部分改为人物的推测、误读或未明之处", "medium"));
    }
  }

  const soleVision = request.match(/只有\s*([一-龥]{2,4})\s*的?(?:视野|眼前).{0,24}(?:军图|地图)/u);
  if (soleVision) {
    const physicalMap = text.match(/(?:案上|桌上|几上|手里).{0,16}(?:多了|摆着|摊着|放着|递来).{0,20}(?:军图|地图|图)|(?:亲兵|旁人|众人|他人).{0,40}(?:看见|看了|见过|动过).{0,16}(?:军图|地图|图)/u);
    if (physicalMap) {
      issues.push(hardIssue("sole-viewpoint-objectified", physicalMap[0], "作者限定为单人视野中的信息时，不得把它写成可被旁人传递、触碰或看见的实物", "high"));
    }
  }
  return issues;
}

function firstDraftExpressionIssues(body) {
  const text = String(body || "");
  const issues = [];
  const contrast = uniqueMatches(text, /(?:不是|并非|并不是)(?:[^。！？!?\n]{0,48})而是/gu);
  if (contrast.length) {
    issues.push(hardIssue(
      "mechanical-contrast-phrase",
      contrast.slice(0, 4).join("、"),
      "删去“不是……而是……”式解释，让动作、对话或前后文自行形成对照",
      "medium"
    ));
  }
  if (text.includes("——")) {
    issues.push(hardIssue(
      "em-dash-prose",
      "——",
      "改为正常句号、逗号或直接断句，不用破折号制造转折和强调",
      "medium"
    ));
  }
  const rejected = FIRST_DRAFT_REJECTED_PHRASES.filter((phrase) => text.includes(phrase));
  if (rejected.length) {
    issues.push(hardIssue(
      "rejected-stock-phrase",
      rejected.slice(0, 6).join("、"),
      "删去作者已明确拒绝的套话或空泛施压词，改由现场事实、人物行动和具体后果承担语气",
      "medium"
    ));
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
  issues.push(...declaredConstraintIssues(body, options.requestText));
  issues.push(...firstDraftExpressionIssues(body));

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
  // A first draft may be imperfect, but direct-adoption status must reject the
  // mechanical constructions explicitly prohibited by the writing policy.
  const blockers = gate.issues.filter((i) =>
    ["empty-output", "visible-process-leak", "non-chapter-output", "output-wrapper", "mechanical-contrast-phrase", "em-dash-prose", "rejected-stock-phrase"].includes(i.rule)
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
  , declaredConstraintIssues,
  firstDraftExpressionIssues,
  FIRST_DRAFT_REJECTED_PHRASES
};
