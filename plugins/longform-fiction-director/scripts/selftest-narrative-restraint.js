"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const main = read("skills/longform-fiction-director/SKILL.md");
const humanizer = read("skills/humanizer-zh/SKILL.md");
const deslop = read("skills/deslop-all/SKILL.md");
const chapterCard = read("skills/longform-fiction-director/references/chapter-control-card.md");
const hookChecklist = read("skills/longform-fiction-director/references/hook-shuangdian-checklist.md");
const division = read("skills/longform-fiction-director/references/editor-model-division.md");
const naturalSystem = read("skills/longform-fiction-director/references/natural-writing-system.md");
const gates = read("skills/longform-fiction-director/references/quality-gates.md");
const builtinWorkflow = read("skills/longform-fiction-director/references/builtin-workflow.md");
const chapterTemplate = read("assets/workflow/project-template/细纲/01_当前章细纲.md");
const pluginManifest = JSON.parse(read(".codex-plugin/plugin.json"));
const scenarios = JSON.parse(read("skills/humanizer-zh/test-prompts.json"));
const { buildOptimizeSystem, FOCUS_HINTS } = require("../server/humanizer-prompt-lib");
const {
  buildDraftSystem,
  prepareDraftPrompt,
  sanitizeProjectContext,
  POLICY_VERSION
} = require("../server/draft-prompt-lib");

for (const [name, body] of Object.entries({ main, humanizer, deslop, division, gates })) {
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
assert.ok(deslop.includes("细纲验收流程腔"), "deslop self-check does not detect brief-driven narration");
assert.ok(chapterCard.includes("不要要求模型逐条兑现细纲"), "chapter notes still behave like executable instructions");
assert.ok(chapterCard.includes("从什么状态走向什么状态") && chapterCard.includes("先做 A、再做 B、最后发现 C"), "chapter note policy still permits action-order briefs");
assert.ok(chapterCard.includes("重要章节可以更充分") && chapterCard.includes("过渡章节可以更短") && chapterCard.includes("不是达标线"), "chapter note policy still collapses detailed briefs into summaries");
assert.ok(chapterCard.includes("相关人物") && chapterCard.includes("暂时没有说透"), "chapter note policy misses character response or information restraint");
assert.ok(chapterCard.includes("不强制七项字段") && chapterCard.includes("不固定两到四个场景") && chapterCard.includes("不规定影响后续几章"), "chapter note policy copied a rigid checklist");
assert.ok(chapterTemplate.includes("相关人物出于各自处境") && chapterTemplate.includes("施工顺序"), "chapter note template lacks natural causal density");
assert.ok(chapterTemplate.startsWith("# 当前章细纲"), "chapter note template still uses the old ambiguous title");
assert.ok(!chapterTemplate.includes("## 从哪里接着写") && !chapterTemplate.includes("## 别写错"), "chapter note template still presents a fill-in form");
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
assert.strictEqual(POLICY_VERSION, "natural-prose-v5", "draft policy version is stale");
assert.ok(draftSystem.system.includes("事实是硬边界，写法是自由区"), "draft runtime policy misses fact/creative split");
assert.ok(draftSystem.system.includes("不是正文施工顺序"), "draft runtime policy still treats planning order as prose order");
assert.ok(draftSystem.system.includes("不能按提示词栏目逐项亮相"), "draft runtime policy misses checklist-prose protection");
assert.ok(draftSystem.system.includes("不要为了所谓人味刻意制造误判或残缺"), "draft runtime policy forces artificial imperfection");
assert.ok(draftSystem.system.includes("一个意思只留一次") && draftSystem.system.includes("内心只保留会改变下一步行动"), "draft runtime policy still permits explanation echoes");
assert.ok(draftSystem.system.includes("精确数量") && draftSystem.system.includes("暂时不知道也可以"), "draft runtime policy permits invented precision");
assert.ok(draftSystem.system.includes("不把过渡动作") && draftSystem.system.includes("拖成整章"), "draft runtime policy permits bridge-scene inflation");
assert.ok(draftSystem.system.includes("篇幅来自事情继续发生") && draftSystem.system.includes("虚构精确细节凑长文"), "draft runtime policy permits long-form padding");
assert.ok(draftSystem.system.includes("人物、关系或局势") && draftSystem.system.includes("先做A、再做B、最后发现C"), "draft runtime policy still treats chapter direction as an action checklist");
assert.ok(!draftSystem.system.includes("300–500"), "draft runtime policy hardcodes an opening span");
assert.ok(main.includes("不得把整份人物库、系统表、历史库") || main.includes("不得把整份人物库、系统表、历史库或 `00-08`"), "main skill still permits full-ledger prompt dumping");
assert.ok(builtinWorkflow.includes("最小") || read("skills/longform-fiction-director/references/natural-writing-system.md").includes("不能把整份人物库"), "workflow misses minimal-context handoff");
assert.ok(main.includes("耗时 502 不自动重发"), "main skill still replays long upstream 502 responses");
assert.ok(main.includes("从最后一个字继续") && main.includes("本地按原文顺序合并"), "main skill misses lossless segmented long-form recovery");
const startupPrompt = Array.isArray(pluginManifest.interface?.defaultPrompt)
  ? pluginManifest.interface.defaultPrompt.join("\n")
  : String(pluginManifest.interface?.defaultPrompt || "");
assert.ok(startupPrompt.includes("continue naturally + word count"), "plugin startup prompt still permits directionless long-form calls");
assert.ok(startupPrompt.includes("Unknown exact names, counts, terrain"), "plugin startup prompt still permits invented precision");

const contaminatedContext = [
  "卢象升不知道后世历史，系统不给敌情透视。",
  "前500字内同时出现至少三项压力。",
  "第1章完成文化选择，第2章列阵，第3章破阵。",
  "每400至700字必须出现一次压力变化。",
  "豪格率领清军侧翼部，卢象升战后才确认其身份。"
].join("\n");
const cleanedContext = sanitizeProjectContext(contaminatedContext);
assert.ok(cleanedContext.text.includes("卢象升不知道后世历史"), "context sanitizer dropped a factual boundary");
assert.ok(cleanedContext.text.includes("卢象升战后才确认其身份"), "context sanitizer dropped an unscheduled plot fact");
assert.ok(!cleanedContext.text.includes("前500字"), "context sanitizer retained a fixed opening quota");
assert.ok(!cleanedContext.text.includes("第1章完成"), "context sanitizer retained fixed chapter slots");
assert.ok(!cleanedContext.text.includes("每400至700字"), "context sanitizer retained fixed pacing intervals");
assert.ok(cleanedContext.removedCount >= 3, "context sanitizer did not report removed legacy directives");

const mixedContext = sanitizeProjectContext([
  "第1章里，卢象升已经见过陌生骑兵。第2章必须完成六支兵种点验。",
  "豪格率领清军侧翼部；每章至少展示一次系统面板。",
  "第3章末，卢象升尚未知道豪格姓名。"
].join("\n"));
assert.ok(mixedContext.text.includes("第1章里，卢象升已经见过陌生骑兵"), "context sanitizer removed an established chapter fact");
assert.ok(mixedContext.text.includes("豪格率领清军侧翼部"), "context sanitizer removed a fact sharing a line with a legacy directive");
assert.ok(mixedContext.text.includes("第3章末，卢象升尚未知道豪格姓名"), "context sanitizer removed a factual chapter reference");
assert.ok(!mixedContext.text.includes("六支兵种点验") && !mixedContext.text.includes("每章至少"), "context sanitizer retained mixed legacy directives");

const preparedDraft = prepareDraftPrompt({
  projectContext: contaminatedContext,
  prompt: "写第1章候选，开头和停处由人物现场决定。",
  minChars: 2500
});
assert.ok(preparedDraft.prompt.includes("作者本次要求"), "prepared prompt does not separate current author intent");
assert.ok(preparedDraft.prompt.includes("写第1章候选"), "prepared prompt altered the current author request");
assert.ok(!preparedDraft.prompt.includes("前500字内"), "prepared prompt leaked a legacy quota");
assert.ok(preparedDraft.prompt.includes("完整正文不得少于 2500 个中文字符"), "minimum length never reaches the model prompt");
assert.ok(preparedDraft.prompt.includes("沿现有因果") && preparedDraft.prompt.includes("不得靠复述"), "minimum length guidance encourages padding instead of story continuation");
assert.strictEqual(preparedDraft.minimumChars, 2500, "prepared prompt lost normalized minimum length");
assert.ok(preparedDraft.contextSanitization.applied, "prepared prompt did not mark context sanitation");

const noMinimumDraft = prepareDraftPrompt({ prompt: "写一段自然正文。" });
assert.strictEqual(noMinimumDraft.prompt, "写一段自然正文。", "optional minimum length changed ordinary prompts");
assert.strictEqual(noMinimumDraft.minimumChars, 0, "missing minimum length should normalize to zero");

console.log("PASS selftest-narrative-restraint: recoverable space and non-checklist chapters");
