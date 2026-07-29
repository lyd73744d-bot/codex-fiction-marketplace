"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const main = read("skills/longform-fiction-director/SKILL.md");
const humanizer = read("skills/humanizer-zh/SKILL.md");
const dialogue = read("skills/deslop-dialogue/SKILL.md");
const narration = read("skills/deslop-narration/SKILL.md");
const explain = read("skills/deslop-explain/SKILL.md");
const chapterCard = read("skills/longform-fiction-director/references/chapter-control-card.md");
const hookChecklist = read("skills/longform-fiction-director/references/hook-shuangdian-checklist.md");
const division = read("skills/longform-fiction-director/references/editor-model-division.md");
const naturalSystem = read("skills/longform-fiction-director/references/natural-writing-system.md");
const gates = read("skills/longform-fiction-director/references/quality-gates.md");
const builtinWorkflow = read("skills/longform-fiction-director/references/builtin-workflow.md");
const scenarios = JSON.parse(read("skills/humanizer-zh/test-prompts.json"));
const { buildOptimizeSystem, FOCUS_HINTS } = require("../server/humanizer-prompt-lib");
const { buildDraftSystem, POLICY_VERSION } = require("../server/draft-prompt-lib");

for (const [name, body] of Object.entries({ main, humanizer, dialogue, narration, explain, division, gates })) {
  assert.ok(/潜台词|话说满|一次说完/.test(body), `${name} misses narrative-restraint language`);
}

assert.ok(main.includes("每份正文或重写任务包"), "draft handoff does not enforce narrative restraint");
assert.ok(humanizer.includes("关键事实与必要因果仍要清楚"), "humanizer may hide required plot information");
assert.ok(humanizer.includes("不得靠堆省略号、删成谜语"), "humanizer lacks fake-restraint guardrail");
assert.ok(gates.includes("动作、反应、上下文或后果"), "quality gate cannot verify recoverable subtext");
assert.ok(scenarios.some((item) => item.id === 8 && item.expected.includes("不得堆省略号")), "regression scenario missing");

const humanizeSystem = buildOptimizeSystem({ mode: "humanize", focus: "dialogue" });
const reviewSystem = buildOptimizeSystem({ mode: "review", focus: "full" });
for (const prompt of [humanizeSystem, reviewSystem]) {
  assert.ok(prompt.includes("叙事留白"), "runtime prompt misses narrative restraint");
  assert.ok(prompt.includes("必要事实与因果仍须清楚"), "runtime prompt may sacrifice clarity");
  assert.ok(prompt.includes("密集省略号"), "runtime prompt lacks fake-restraint guardrail");
}
assert.ok(FOCUS_HINTS.dialogue.includes("自然留白"), "dialogue focus hint is stale");
assert.ok(FOCUS_HINTS.narration.includes("不替读者翻译潜台词"), "narration focus hint is stale");

assert.ok(main.includes("非施工单") && main.includes("流程腔"), "draft handoff misses whole-chapter anti-checklist rule");
assert.ok(humanizer.includes("整章专项：拆除细纲验收流程"), "humanizer misses whole-chapter process-voice diagnosis");
assert.ok(narration.includes("人物的行动是被自身处境推动"), "narration self-check does not distinguish story causality from brief order");
assert.ok(chapterCard.includes("不要要求模型逐条兑现笔记"), "chapter notes still behave like executable instructions");
assert.ok(hookChecklist.includes("不要为了证明“能抓人”另造事件") && hookChecklist.includes("不强制悬念"), "optional platform review still rewards formulaic urgency");
assert.ok(gates.includes("逐项展示和验收设定"), "quality gate misses brief-driven process voice");
assert.ok(scenarios.some((item) => item.id === 10 && item.expected.includes("细纲栏目")), "whole-chapter process-voice regression scenario missing");
assert.ok(naturalSystem.includes("反模板也不能变成新模板"), "global system replaces one opening formula with another");
assert.ok(!naturalSystem.includes("300–500"), "global system hardcodes an opening span");
assert.ok(!builtinWorkflow.includes("auxiliary-base"), "packaged legacy novel workflow is still advertised as a universal base");
const legacyAuxiliaryDir = path.join(root, "assets/workflow/auxiliary-base");
const legacyAuxiliaryFiles = fs.existsSync(legacyAuxiliaryDir)
  ? fs.readdirSync(legacyAuxiliaryDir, { recursive: true }).filter((item) => String(item).endsWith(".md"))
  : [];
assert.deepStrictEqual(legacyAuxiliaryFiles, [], "project-specific legacy writing rules are still bundled");

for (const prompt of [humanizeSystem, reviewSystem]) {
  assert.ok(prompt.includes("结构去流程腔"), "runtime prompt misses whole-chapter process-voice rule");
  assert.ok(prompt.includes("主角持续给出最优处理"), "runtime prompt misses over-efficient protagonist diagnosis");
  assert.ok(prompt.includes("单独一次危机、命令、回报或正确判断不算问题"), "runtime prompt lacks false-positive guardrail");
  assert.ok(!prompt.includes("300–500"), "runtime prompt hardcodes an opening span");
}
assert.ok(FOCUS_HINTS.full.includes("逐项执行提示词"), "full focus hint misses prompt-order process voice");
assert.ok(FOCUS_HINTS.narration.includes("细纲验收流程腔"), "narration focus hint misses brief-driven structure");

const draftSystem = buildDraftSystem({ kind: "draft", system: "保留既定历史事实。" });
assert.strictEqual(POLICY_VERSION, "natural-prose-v2", "draft policy version is stale");
assert.ok(draftSystem.system.includes("事实是硬边界，写法是自由区"), "draft runtime policy misses fact/creative split");
assert.ok(draftSystem.system.includes("不代表正文顺序"), "draft runtime policy still treats planning order as prose order");
assert.ok(draftSystem.system.includes("信使、面板、电话、下属和巧合"), "draft runtime policy misses answer-delivery pattern");
assert.ok(!draftSystem.system.includes("300–500"), "draft runtime policy hardcodes an opening span");

console.log("PASS selftest-narrative-restraint: recoverable space and non-checklist chapters");
