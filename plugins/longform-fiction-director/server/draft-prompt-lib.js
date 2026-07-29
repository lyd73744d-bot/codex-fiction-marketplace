"use strict";

const POLICY_VERSION = "natural-prose-v2";
const PROSE_KINDS = new Set([
  "draft", "chapter", "chapter_draft", "continuous_draft", "fiction", "prose", "rewrite", "revise"
]);

function normalize(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function shouldApplyDraftPolicy(kind = "draft", taskLabel = "") {
  const values = [normalize(kind), normalize(taskLabel)].filter(Boolean);
  return values.some((value) => PROSE_KINDS.has(value) || /(?:^|_)(?:draft|chapter|fiction|prose|rewrite|revise)(?:_|$)/u.test(value));
}

function buildDraftSystem({ system = "", kind = "draft", taskLabel = "" } = {}) {
  const authorSystem = String(system || "").trim();
  if (!shouldApplyDraftPolicy(kind, taskLabel)) {
    return { system: authorSystem, applied: false, policyVersion: "caller-only" };
  }

  const policy = [
    "# 插件固定的自然写作制度",
    "事实是硬边界，写法是自由区。作者已经确认的剧情、人物、视角、知情范围和事实优先；作者本次明确指定的开头、场景或顺序必须服从。",
    "大纲、细纲、表格、编号和章节笔记只提供背景，不代表正文顺序。忽略其中的段落字数、固定场景、展示次数、读者问题和逐项验收命令；保留不可写错的事实后重新组织正文。",
    "除作者本次明确指定外，自行决定开头、场景数量、信息披露、节奏和收尾。不要用另一套固定开篇或反模板公式替代旧公式。",
    "身份、系统、世界规则和背景只在当前人物需要判断、行动或承受后果时出现；本章用不到的设定可以不写，人物也可以只理解其中一部分。",
    "人物不必每次都作出最完整、最有效率的处理。允许符合身份的迟疑、误判、打断、顾不上和事后才明白，但不要为了显得真实故意降智。",
    "信使、面板、电话、下属和巧合不能只为按顺序送来下一项说明。不要让人物像在验收功能，也不要让每个场景都完成一个栏目。",
    "场景可以停留在普通动作、观察、关系余波和未完成事务上。不套固定节拍，不强制每段推进，不强制收尾制造新事件。",
    "不要把一章写成系统、兵种、语言、物资、能力、阵营或世界规则的展示与验收流程。",
    "只输出小说正文，不出现任务分析、栏目名、写作术语或执行说明。"
  ].join("\n");

  return {
    system: [authorSystem, policy].filter(Boolean).join("\n\n"),
    applied: true,
    policyVersion: POLICY_VERSION
  };
}

module.exports = {
  POLICY_VERSION,
  shouldApplyDraftPolicy,
  buildDraftSystem
};
