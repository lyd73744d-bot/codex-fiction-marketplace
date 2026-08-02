"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const { inspectChapter } = require("../server/writing-hard-gates");

const main = read("skills/longform-fiction-director/SKILL.md");
const humanizer = read("skills/humanizer-zh/SKILL.md");
const deslop = read("skills/deslop-all/SKILL.md");
const chapterCard = read("skills/longform-fiction-director/references/chapter-control-card.md");
const hookChecklist = read("skills/longform-fiction-director/references/hook-shuangdian-checklist.md");
const division = read("skills/longform-fiction-director/references/editor-model-division.md");
const naturalSystem = read("skills/longform-fiction-director/references/natural-writing-system.md");
const storyCore = read("skills/longform-fiction-director/references/commercial-fiction-principles.md");
const gates = read("skills/longform-fiction-director/references/quality-gates.md");
const builtinWorkflow = read("skills/longform-fiction-director/references/builtin-workflow.md");
const chapterTemplate = read("assets/workflow/project-template/细纲/01_当前章细纲.md");
const pluginManifest = JSON.parse(read(".codex-plugin/plugin.json"));
const scenarios = JSON.parse(read("skills/humanizer-zh/test-prompts.json"));
const { buildOptimizeSystem, buildOptimizePrompt, FOCUS_HINTS, loadMethodPack, boundedContext } = require("../server/humanizer-prompt-lib");
const { authorFeedbackBlock } = require("../server/author-feedback-lib");
const { minimumRewriteChars } = require("../server/multi-model-optimize");
const { recommendModels } = require("../server/model-router");
const { roughStats } = require("../server/style-compare-service");
const {
  buildDraftSystem,
  buildPlanningSystem,
  planningFocus,
  prepareDraftPrompt,
  sanitizeProjectContext,
  POLICY_VERSION
} = require("../server/draft-prompt-lib");

for (const [name, body] of Object.entries({ main, humanizer, deslop, division, gates })) {
  assert.ok(/潜台词|话说满|一次说完/.test(body), `${name} misses narrative-restraint language`);
}

assert.ok(main.includes("正文请求不能只有") && main.includes("最值得发生的变化"), "draft handoff lacks a meaningful story direction");
assert.ok(humanizer.includes("关键事实与必要因果仍要清楚"), "humanizer may hide required plot information");
assert.ok(humanizer.includes("不能靠堆省略号、删成谜语"), "humanizer lacks fake-restraint guardrail");
assert.ok(gates.includes("动作、反应、上下文或后果"), "quality gate cannot verify recoverable subtext");
assert.ok(scenarios.some((item) => item.id === 8 && item.expected.includes("不得堆省略号")), "regression scenario missing");

const humanizeSystem = buildOptimizeSystem({ mode: "humanize", focus: "dialogue" });
const reviewSystem = buildOptimizeSystem({ mode: "review", focus: "full" });
for (const prompt of [humanizeSystem, reviewSystem]) {
  assert.ok(prompt.includes("叙事留白"), "runtime prompt misses narrative restraint");
  assert.ok(prompt.includes("必要事实与因果仍须清楚"), "runtime prompt may sacrifice clarity");
  assert.ok(prompt.includes("密集省略号"), "runtime prompt lacks fake-restraint guardrail");
  assert.ok(prompt.includes("对白去口号") && prompt.includes("当前对象、旧事、筹码"), "runtime prompt misses generic-threat restraint");
}
assert.ok(FOCUS_HINTS.dialogue.includes("该直说时可以直说"), "dialogue focus hint forces artificial restraint");
assert.ok(FOCUS_HINTS.narration.includes("不替读者翻译潜台词"), "narration focus hint is stale");

assert.ok(naturalSystem.includes("不写脱离姓名和现场仍可套用的通用狠话"), "global writing policy misses generic-threat restraint");
assert.ok(gates.includes("脱离人物与现场也能成立的通用狠话"), "quality gate misses generic-threat restraint");
assert.ok(humanizer.includes("通用套话的处理"), "humanizer misses generic-threat diagnosis");
assert.ok(!humanizer.includes("算账"), "model-visible humanizer still primes a rejected catchphrase");
const threatStats = roughStats("他盯着门外，低声道：‘这笔账该收了。’");
assert.ok(threatStats.aiHints.includes("通用狠话风险"), "local style check misses a generic threat slogan");
const literalLedgerStats = roughStats("账房把账簿翻到本月，核对米价、车脚钱和已经付过的银两。");
assert.ok(!literalLedgerStats.aiHints.includes("通用狠话风险"), "local style check mislabels a literal ledger scene");

const longContextTail = {
  voice: "文风".repeat(5500) + "[VOICE-END]",
  cards: "人物".repeat(19000) + "[CARDS-END]",
  brief: "细纲".repeat(9000) + "[BRIEF-END]",
  facts: "事实".repeat(12000) + "[FACTS-END]"
};
const longOptimizePrompt = buildOptimizePrompt({
  draftText: "正文".repeat(6000) + "[DRAFT-END]",
  context: longContextTail
});
for (const marker of ["[VOICE-END]", "[CARDS-END]", "[BRIEF-END]", "[FACTS-END]", "[DRAFT-END]"]) {
  assert.ok(longOptimizePrompt.includes(marker), `long optimization context lost ${marker}`);
}
assert.ok(longOptimizePrompt.length < 42_000, "optimization prompt still dumps the full project archive");
assert.ok(!longOptimizePrompt.includes("# skills/"), "optimization prompt still embeds full skill manuals");
assert.ok(loadMethodPack("full").length < 240, "revision method pack is too large to be a task hint");
assert.ok(boundedContext("a".repeat(8_000) + "[END]", 2_000).includes("[END]"), "bounded context must preserve the latest boundary note");
assert.strictEqual(authorFeedbackBlock(""), "", "empty feedback must not become a fake author instruction");
assert.ok(!authorFeedbackBlock("保留人物口气，删去重复解释").includes("希望延续"), "author feedback is still formatted as a worksheet");
assert.strictEqual(minimumRewriteChars(240), 120, "short revision must not be rejected for becoming cleaner");
assert.strictEqual(minimumRewriteChars(2_000), 1_400, "long revision still needs a meaningful length floor");

assert.ok(main.includes("不能成为正文顺序") && main.includes("照着细纲栏目逐项完成"), "draft handoff misses whole-chapter anti-checklist rule");
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
assert.ok(gates.includes("逐项展示和验收"), "quality gate misses brief-driven process voice");
assert.ok(scenarios.some((item) => item.id === 10 && item.expected.includes("细纲栏目")), "whole-chapter process-voice regression scenario missing");
assert.ok(naturalSystem.includes("反模板也不能变成新模板"), "global system replaces one opening formula with another");
assert.ok(main.includes("commercial-fiction-principles.md"), "main skill does not route planning through the story craft core");
assert.ok(naturalSystem.includes("人物与因果的正向判断") && naturalSystem.includes("不是新的检查表"), "natural system does not bound the story craft core");
assert.ok(storyCore.includes("不是出厂流程") && storyCore.includes("不是正文施工单"), "story craft core is presented as a template");
assert.ok(storyCore.includes("大纲要把故事从开头讲到结局") && storyCore.includes("性格通过一连串具体选择被认识"), "story craft core misses outline or character causality");
assert.ok(storyCore.includes("不要求每章同时具备") && storyCore.includes("不把本文整份发送给正文模型"), "story craft core can leak as a chapter checklist");
assert.ok(!/每隔\s*\d+|前\s*\d+\s*字|三次升级/u.test(storyCore), "story craft core retained fixed course quotas");
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
assert.strictEqual(POLICY_VERSION, "natural-prose-v7", "draft policy version is stale");
assert.ok(draftSystem.system.includes("事实是硬边界，写法是自由区"), "draft runtime policy misses fact/creative split");
assert.ok(draftSystem.system.includes("不是正文施工顺序"), "draft runtime policy still treats planning order as prose order");
assert.ok(draftSystem.system.includes("不能按提示词栏目逐项亮相"), "draft runtime policy misses checklist-prose protection");
assert.ok(draftSystem.system.includes("不要为了所谓人味刻意制造误判或残缺"), "draft runtime policy forces artificial imperfection");
assert.ok(draftSystem.system.includes("一个意思只留一次") && draftSystem.system.includes("内心只保留会改变下一步行动"), "draft runtime policy still permits explanation echoes");
assert.ok(draftSystem.system.includes("具体生活") && draftSystem.system.includes("不要为了抓人强行新增事故"), "opening policy still defaults to a manufactured crisis");
assert.ok(draftSystem.system.includes("可以直说") && draftSystem.system.includes("不要为了避开‘说’字"), "dialogue policy replaced one formula with another");
assert.ok(draftSystem.system.includes("不要批量") && draftSystem.system.includes("喉结"), "emotion policy still encourages stock bodily reactions");
assert.ok(draftSystem.system.includes("精确数量") && draftSystem.system.includes("暂时不知道也可以"), "draft runtime policy permits invented precision");
assert.ok(draftSystem.system.includes("不得凭模型记忆补全") && draftSystem.system.includes("未给出的地点、人数、军队名称"), "draft runtime policy still invents historical detail from model memory");
assert.ok(draftSystem.system.includes("不把过渡动作") && draftSystem.system.includes("拖成整章"), "draft runtime policy permits bridge-scene inflation");
assert.ok(draftSystem.system.includes("篇幅来自事情继续发生") && draftSystem.system.includes("虚构精确细节凑长文"), "draft runtime policy permits long-form padding");
assert.ok(draftSystem.system.includes("人物、关系或局势") && draftSystem.system.includes("先做A、再做B、最后发现C"), "draft runtime policy still treats chapter direction as an action checklist");
assert.ok(draftSystem.system.includes("人物各自想得到、保住、逃开或弄明白") && draftSystem.system.includes("不为追求刺激强行增加事故"), "draft runtime policy misses character-led causality");
assert.ok(draftSystem.system.includes("固定情绪曲线") && draftSystem.system.includes("固定章尾形式"), "draft runtime policy still permits mechanical pacing");
assert.ok(!draftSystem.system.includes("300–500"), "draft runtime policy hardcodes an opening span");
assert.ok(main.includes("不要整包发送人物库、系统表、历史库"), "main skill still permits full-ledger prompt dumping");

const outlineSystem = buildPlanningSystem({ kind: "outline", taskLabel: "卢象升全书大纲" });
assert.strictEqual(outlineSystem.policyVersion, "story-planning-v1", "outline planning policy version is missing");
assert.ok(outlineSystem.system.includes("从开头讲到结局") && outlineSystem.system.includes("系统功能巡展"), "outline model can still return a feature tour");
const chapterOutlineSystem = buildDraftSystem({ kind: "outline", taskLabel: "第一章细纲优化" });
assert.strictEqual(planningFocus("outline", "第一章细纲优化"), "chapter-outline", "chapter outline focus routing failed");
assert.ok(chapterOutlineSystem.system.includes("自然段讲清承接") && chapterOutlineSystem.system.includes("不规定正文第一句"), "chapter-outline model still receives a rigid brief");
const characterSystem = buildDraftSystem({ kind: "character", taskLabel: "人物关系" });
assert.ok(characterSystem.system.includes("性格由选择表现") && characterSystem.system.includes("不强迫每人"), "character planning still enforces identical slots");
const packagingSystem = buildDraftSystem({ kind: "title", taskLabel: "书名与简介" });
assert.ok(packagingSystem.system.includes("准确传达") && packagingSystem.system.includes("不套固定热词结构"), "packaging planning still uses a title formula");

const boundaryGate = inspectChapter(
  "千总陈望带六百人从涿州出发，营里还剩十一个伤兵。",
  { requestText: "主将和营地没有确认姓名，不要补造姓名，不要擅自套用真实战役、精确日期或兵力数字；地点未确认。" }
);
assert.ok(boundaryGate.issues.some((item) => item.rule === "unconfirmed-name-risk"), "unconfirmed name risk was not reported");
assert.ok(boundaryGate.issues.some((item) => item.rule === "unconfirmed-quantity-risk"), "unconfirmed quantity risk was not reported");
assert.ok(boundaryGate.issues.some((item) => item.rule === "unconfirmed-place-risk"), "unconfirmed place risk was not reported");
const chineseQuantityGate = inspectChapter("另有一百人守在关外。", { requestText: "兵力数字未确认。" });
assert.ok(chineseQuantityGate.issues.some((item) => item.rule === "unconfirmed-quantity-risk"), "Chinese quantity beginning with one was not reported");
const historicalPrecisionGate = inspectChapter(
  "崇祯十二年，巨鹿贾庄的存粮只够三日。",
  { requestText: "崇祯十二年，巨鹿战前，粮食已经难以支撑。" }
);
assert.ok(historicalPrecisionGate.issues.some((item) => item.rule === "unconfirmed-quantity-risk"), "historical task accepts invented exact quantity");
assert.ok(historicalPrecisionGate.issues.some((item) => item.rule === "unconfirmed-place-risk"), "historical task accepts invented exact place");
const longDraftRecommendation = recommendModels({
  task: "draft",
  mode: "quick",
  targetChars: 6_000,
  availableModels: ["gemini-3.5-flash", "glm-5.2", "gemini-3.1-pro-preview"]
});
assert.ok(!longDraftRecommendation.modelIds.includes("gemini-3.5-flash"), "short-form Flash is still recommended for long prose");
const noFalseName = inspectChapter("总兵的印压在公文上，校尉看他一眼。", { requestText: "人物姓名未确认。" });
assert.ok(!noFalseName.issues.some((item) => item.rule === "unconfirmed-name-risk"), "ordinary title phrase was mislabeled as a name");
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
