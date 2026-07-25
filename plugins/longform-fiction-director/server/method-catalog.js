"use strict";

const fs = require("node:fs");
const path = require("node:path");

const CATALOG = [
  { id: "humanizer-zh", focus: "full", path: "skills/humanizer-zh/SKILL.md", useWhen: "综合去AI味、机械腔、解释腔、假对话" },
  { id: "humanizer-methods", focus: "full", path: "skills/humanizer-methods/SKILL.md", useWhen: "先分流再调用对应 deslop 微方法" },
  { id: "deslop-dialogue", focus: "dialogue", path: "skills/deslop-dialogue/SKILL.md", useWhen: "对话像朗读、没有信息差/打断" },
  { id: "deslop-narration", focus: "narration", path: "skills/deslop-narration/SKILL.md", useWhen: "叙述总结腔、翻译腔、空描写" },
  { id: "deslop-pacing", focus: "pacing", path: "skills/deslop-pacing/SKILL.md", useWhen: "赶场或注水、节拍不清" },
  { id: "deslop-emotion", focus: "emotion", path: "skills/deslop-emotion/SKILL.md", useWhen: "情绪贴标签、缺少动作停顿" },
  { id: "deslop-info-dump", focus: "info", path: "skills/deslop-info-dump/SKILL.md", useWhen: "设定倾倒、说明书感" },
  { id: "deslop-hook", focus: "hook", path: "skills/deslop-hook/SKILL.md", useWhen: "章尾廉价惊吓或无因果钩子" },
  { id: "deslop-explain", focus: "explain", path: "skills/deslop-explain/SKILL.md", useWhen: "这意味着/不难看出 等解释腔" },
  { id: "style-compare", focus: "full", path: "skills/style-compare/SKILL.md", useWhen: "对照样书/文风锚点找偏差" },
  { id: "anti-ooc-research", focus: "research", path: "skills/anti-ooc-research/SKILL.md", useWhen: "真实人物/历史/专业内容防穿帮" }
];

function listMethodCatalog(pluginRoot = path.join(__dirname, "..")) {
  const items = CATALOG.map((item) => {
    const abs = path.join(pluginRoot, item.path);
    return {
      ...item,
      exists: fs.existsSync(abs),
      optimizeFocus: item.focus === "research" ? null : item.focus,
      toolHint: item.focus === "research"
        ? "fiction_plan_research / fiction_append_research_findings"
        : "fiction_optimize_with_models focus=" + (item.focus === "full" ? "full" : item.focus)
    };
  });
  return {
    ok: true,
    items,
    coach: "先 style-compare 或人工判断病灶，再选对应 deslop/humanizer；优化结果仍落候选 txt，确认前不入正文。"
  };
}

module.exports = { listMethodCatalog, CATALOG };
