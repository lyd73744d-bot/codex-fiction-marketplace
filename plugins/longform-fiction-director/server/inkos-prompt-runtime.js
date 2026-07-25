"use strict";

const inventory = require("./zizhuji-compat/resources/prompts/inkos-prompt-inventory.json");
const sourceMap = require("./zizhuji-compat/resources/prompts/sources/inkos-prompt-sources.json");

const CORE_BINDINGS = Object.freeze({
  brainstorm: [
    "inkos.agent.agent-system-prompt.build-chat-prompt",
    "inkos.agent.agent-system-prompt.build-book-create-prompt"
  ],
  outline: [
    "inkos.agents.architect.architect-agent.build-chinese-foundation-prompt",
    "inkos.agents.foundation-reviewer.foundation-reviewer-agent.build-chinese-review-prompt"
  ],
  "chapter-brief": [
    "inkos.agents.planner-prompts.get-planner-memo-system-prompt",
    "inkos.agents.planner-prompts.build-planner-user-message",
    "inkos.agents.planner-prompts.build-golden-opening-guidance"
  ],
  draft: [
    "inkos.agents.writer-prompts.build-writer-system-prompt",
    "inkos.agents.writer.writer-agent.build-governed-user-prompt",
    "inkos.utils.writing-methodology.build-writing-methodology-section",
    "inkos.prompt-pack.longform.writer"
  ],
  review: [
    "inkos.agents.foundation-reviewer.foundation-reviewer-agent.build-chinese-review-prompt",
    "inkos.prompt-pack.longform.auditor"
  ]
});

const CAPABILITY_BINDINGS = Object.freeze({
  "reference-recommendation": CORE_BINDINGS.brainstorm,
  "existing-novel-ledger": ["inkos.agents.observer-prompts.build-observer-system-prompt", "inkos.agents.observer-prompts.build-observer-user-prompt"],
  "title-synopsis": CORE_BINDINGS.brainstorm,
  "outline-logic-check": ["inkos.agents.foundation-reviewer.foundation-reviewer-agent.build-chinese-review-prompt"],
  "outline-logic-revision": ["inkos.agents.architect.architect-agent.build-revise-prompt"],
  "draft-qc-revision": ["inkos.agents.reviser.reviser-agent.build-auto-system-prompt", "inkos.prompt-pack.longform.reviser"],
  "self-critique-rewrite": ["inkos.agents.reviser.reviser-agent.build-auto-system-prompt", "inkos.prompt-pack.longform.reviser"],
  "dialogue-meme-polish": ["inkos.agents.polisher.build-chinese-system-prompt"],
  "three-chapter-review": ["inkos.prompt-pack.longform.auditor", "inkos.agents.foundation-reviewer.foundation-reviewer-agent.build-chinese-review-prompt"],
  "review-writeback": ["inkos.agents.reviser.reviser-agent.build-auto-system-prompt"],
  "iron-rules": ["inkos.agent.agent-system-prompt.build-book-prompt"],
  "fanfic-constraints": [
    "inkos.agents.fanfic-prompt-sections.build-fanfic-canon-section",
    "inkos.agents.fanfic-prompt-sections.build-fanfic-mode-instructions",
    "inkos.agents.fanfic-prompt-sections.build-character-voice-profiles"
  ],
  "world-library": ["inkos.agents.architect.architect-agent.build-chinese-foundation-prompt"],
  "world-research": ["inkos.agent.agent-system-prompt.build-book-prompt"],
  "vip-library": ["inkos.agent.agent-system-prompt.build-book-prompt"],
  "project-experience": ["inkos.agents.observer-prompts.build-observer-system-prompt"],
  "style-evolution": ["inkos.agents.polisher.build-chinese-system-prompt", "inkos.agents.reviser.reviser-agent.build-auto-system-prompt"],
  "rag-library": ["inkos.agent.agent-system-prompt.build-book-prompt"],
  "benchmark-analysis": ["inkos.prompt-pack.longform.auditor"],
  "character-board": ["inkos.agents.architect.architect-agent.build-chinese-foundation-prompt"],
  "character-seed": ["inkos.agents.architect.architect-agent.build-chinese-foundation-prompt"],
  "character-writeback": ["inkos.agents.chapter-analyzer.chapter-analyzer-agent.build-system-prompt", "inkos.agents.chapter-analyzer.chapter-analyzer-agent.build-user-prompt"],
  "character-image-prompt": ["inkos.agents.architect.architect-agent.build-chinese-foundation-prompt"],
  "style-workflow": ["inkos.agents.polisher.build-chinese-system-prompt", "inkos.agents.reviser.reviser-agent.build-auto-system-prompt"],
  "cover-prompt": ["inkos.agent.agent-system-prompt.build-book-create-prompt"],
  "public-web-research": ["inkos.agent.agent-system-prompt.build-book-prompt"],
  "prose-length-normalizer": ["inkos.agents.length-normalizer.length-normalizer-agent.build-system-prompt", "inkos.agents.length-normalizer.length-normalizer-agent.build-user-prompt"],
  "plot-forecast": ["inkos.forecast.prompts.build-forecast-system-prompt", "inkos.forecast.prompts.build-forecast-user-prompt"],
  "plot-forecast-repair": ["inkos.forecast.prompts.build-forecast-repair-prompt"]
});

const BY_ID = new Map(inventory.prompts.map((record) => [record.id, record]));

function listInkOsPromptBindings() {
  return Object.freeze(Object.fromEntries(Object.entries(CAPABILITY_BINDINGS).map(([id, bindings]) => [id, [...bindings]])));
}

function buildInkOsPromptContext({ taskType, specialistId } = {}) {
  const ids = specialistId ? CAPABILITY_BINDINGS[specialistId] : CORE_BINDINGS[taskType];
  if (!Array.isArray(ids) || !ids.length) return "";
  let remaining = 32_000;
  const sections = [];
  for (const id of ids) {
    if (remaining <= 0) break;
    const record = BY_ID.get(id);
    const source = record && sourceMap[record.sourceArtifactKey];
    if (!record || typeof source !== "string") continue;
    const bounded = source.slice(0, Math.min(12_000, remaining));
    remaining -= bounded.length;
    sections.push([
      `### ${record.id}`,
      `source: ${record.sourceFile}#${record.sourceSymbol}`,
      `stage: ${record.stage}`,
      bounded
    ].join("\n"));
  }
  if (!sections.length) return "";
  return [
    "以下是 @actalk/inkos-core 1.7.1（commit a713a2e87ccc595221571d24ab193d8a79ea4df7）提取出的原始提示构造器。",
    "把其中与当前任务有关的约束、输出协议和检查维度实际应用到本次输出；代码中的占位变量由后面的项目上下文和作者指令提供。不要复述代码。",
    ...sections
  ].join("\n\n");
}

module.exports = { buildInkOsPromptContext, listInkOsPromptBindings };
