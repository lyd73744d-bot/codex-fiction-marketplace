"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const main = read("skills/longform-fiction-director/SKILL.md");
const division = read("skills/longform-fiction-director/references/editor-model-division.md");
const beginner = read("skills/longform-fiction-director/references/beginner-coach.md");
const collaboration = read("skills/fiction-collaboration/SKILL.md");
const humanizer = read("skills/humanizer-methods/SKILL.md");
const agent = read("skills/longform-fiction-director/agents/openai.yaml");
const usage = read("使用说明.md");
const delivery = read("交付说明.md");
const workflowReadme = read("assets/workflow/docs/README.md");
const guidedWorkflow = read("skills/longform-fiction-director/references/guided-editor-workflow.md");
const agentTeam = read("skills/longform-fiction-director/references/codex-agent-team.md");
const evalScenarios = JSON.parse(read("skills/longform-fiction-director/references/eval-scenarios.json"));
const onboardingScript = read("scripts/post-install-onboarding.js");
const modelRouter = read("server/model-router.js");
const { recommendModels } = require("../server/model-router");
const manifest = JSON.parse(read(".codex-plugin/plugin.json"));

assert.ok(main.includes("references/editor-model-division.md"), "main skill must load editor/model division");
assert.ok(main.includes("references/codex-agent-team.md"), "main skill must load the prebuilt Codex agent team");
assert.ok(main.includes("审稿记录/模型写作记录.md"), "main skill misses persistent model-writing history");
assert.ok(main.includes("你大概想写什么类型？没想好也没关系"), "new-book flow must ask genre first");
assert.ok(!main.includes("作者选新书后先问临时书名"), "new-book flow still asks title first");
assert.ok(main.includes("角色定位：总责编位"), "Codex lead-editor role missing");
assert.ok(main.includes("外部写作模型默认占正文与正文优化的 A 位"), "external prose A-position missing");
assert.ok(division.includes("继续把控制卡磨清楚，还是让我先写一版临时候选？"), "decline fallback question missing");
assert.ok(beginner.includes("不自动接管整章"), "beginner flow still lets Codex take prose by default");
assert.ok(beginner.includes("核心脑洞问清后、正式收束前"), "beginner flow misses optional external brainstorm expansion");
assert.ok(beginner.includes("作者不同意就按当前脑洞继续"), "declined brainstorm must stay local and silent");
assert.ok(collaboration.includes("默认抢写完整正文、改写或润色"), "collaboration boundary missing");
assert.ok(humanizer.includes("外部写作模型默认负责实际改写"), "humanizer rewrite must route externally");
assert.ok(agent.includes("lead editor and director"), "agent prompt role is stale");
assert.ok(agent.includes("ask the genre first"), "agent prompt does not enforce genre-first cold start");
assert.ok(agent.includes("do not announce that you are locating or reading plugin files"), "agent prompt still allows technical cold-start narration");
assert.ok(modelRouter.includes("Codex 在总责编位调度"), "runtime recommendation role is stale");
assert.ok(!modelRouter.includes("责编助手（辅助位）"), "runtime still labels Codex as auxiliary");
assert.ok(modelRouter.includes("leadEditorRouter: true"), "runtime must identify the lead-editor router");
assert.ok(modelRouter.includes("externalWritingModels: true"), "runtime must identify external prose models");
assert.ok(!modelRouter.includes("auxiliary: true"), "runtime still exposes the old auxiliary role");
const runtimeRecommendation = recommendModels({
  task: "draft",
  availableModels: [{ id: "claude-sonnet-5", credits: 10 }],
  unpaid: true
});
assert.strictEqual(runtimeRecommendation.leadEditorRouter, true, "runtime recommendation lost lead-editor role");
assert.strictEqual(runtimeRecommendation.externalWritingModels, true, "runtime recommendation lost external writer role");
assert.ok(!Object.hasOwn(runtimeRecommendation, "auxiliary"), "runtime recommendation exposes stale auxiliary field");
assert.ok(!runtimeRecommendation.coachAdvice.includes("未确认则继续用当前模型"), "unconfirmed prose still falls back silently");
assert.ok(usage.includes("正文初稿、改写与去 AI 味默认交给"), "user guide still assigns prose to Codex");
assert.ok(delivery.includes("不默认抢正文 A 位"), "delivery guide misses the no-takeover boundary");
assert.ok(workflowReadme.includes("`外部写作模型`"), "workflow docs do not expose the prose writer role");
assert.ok(guidedWorkflow.includes("正文与正文优化默认交给"), "guided workflow still assigns prose locally");
assert.ok(onboardingScript.includes("正文默认交给作者当次同意的写作模型"), "post-install message still assigns prose locally");
assert.ok(manifest.interface.capabilities.includes("Codex lead-editor role; external models write prose"), "manifest capability missing");
assert.ok(manifest.interface.capabilities.includes("Optional external brainstorm expansion before direction lock"), "manifest brainstorm capability missing");
assert.ok(manifest.interface.capabilities.includes("Prebuilt on-demand Codex editorial agents"), "manifest Codex agent-team capability missing");
assert.ok(manifest.interface.capabilities.includes("Persistent model-output txt and Markdown writing history"), "manifest model-writing history capability missing");
assert.ok(manifest.interface.capabilities.includes("Genre-first beginner cold start with automatic working title"), "manifest genre-first cold-start capability missing");
assert.ok(manifest.interface.defaultPrompt.some((item) => item.includes("准备定方向前建议一次可选的外部模型发散")), "default prompt misses brainstorm handoff");
assert.ok(manifest.interface.defaultPrompt.some((item) => item.includes("我选择新书后，先问类型")), "default prompt misses genre-first cold start");
assert.ok(manifest.interface.defaultPrompt.some((item) => item.includes("不先问书名和文件夹")), "default prompt still allows title-first cold start");
for (const role of ["idea-architect", "research-verifier", "sample-method-analyst", "continuity-keeper", "draft-reviewer"]) {
  assert.ok(agentTeam.includes(role), `prebuilt Codex agent role missing: ${role}`);
}
assert.ok(agentTeam.includes("一次最多启用两个"), "agent concurrency boundary missing");
assert.ok(agentTeam.includes("不得调用写作网关"), "agent gateway boundary missing");
assert.ok(agentTeam.includes("默认只读"), "agent read-only boundary missing");
assert.ok(usage.includes("模型写作记录.md"), "user guide misses model-writing history");
assert.ok(beginner.indexOf("先问类型") < beginner.indexOf("临时项目名"), "beginner flow asks for project name before genre");
assert.ok(beginner.includes("不得先问书名或文件夹"), "beginner flow does not block title/folder-first behavior");
assert.ok(evalScenarios.some((item) => item.id === "new-book-genre-before-title"), "genre-first cold-start eval missing");

for (const forbidden of [
  "角色定位：辅助位",
  "当前 Codex/作者自己的模型可以完成全部写作步骤",
  "Codex 可以直接构思、写作、改稿",
  "作者当次选择“不使用”：直接用 Codex/自己的模型完成",
  "默认直接使用当前 Codex 或作者自己的模型",
  "未确认则继续用当前模型"
]) {
  const allRoleDocs = [main, usage, delivery, workflowReadme, guidedWorkflow, onboardingScript, modelRouter].join("\n");
  assert.ok(!allRoleDocs.includes(forbidden), `stale role wording remains: ${forbidden}`);
}

console.log("PASS selftest-editor-model-division: Codex directs, external models write prose");
