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
const division = read("skills/longform-fiction-director/references/editor-model-division.md");
const gates = read("skills/longform-fiction-director/references/quality-gates.md");
const scenarios = JSON.parse(read("skills/humanizer-zh/test-prompts.json"));
const { buildOptimizeSystem, FOCUS_HINTS } = require("../server/humanizer-prompt-lib");

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

console.log("PASS selftest-narrative-restraint: dialogue and narration leave recoverable space");
