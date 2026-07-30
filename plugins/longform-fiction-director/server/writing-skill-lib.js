"use strict";

function textValue(value) {
  if (value == null || value === false) return "";
  if (Array.isArray(value)) return value.map(textValue).filter(Boolean).join("\n");
  if (typeof value === "object") return Object.values(value).map(textValue).filter(Boolean).join("\n");
  return String(value);
}

function compact(value = "", limit = 900) {
  return textValue(value).replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").trim().slice(0, limit);
}

function buildDefaultWritingSkill({ currentBook = "", authorRules = "" } = {}) {
  const book = compact(currentBook) || "尚未确认。先把本书故事和作者口味聊清楚，不从题材模板自动补规则。";
  const author = compact(authorRules);
  return [
    "# 写作Skill",
    "",
    "> 这份 Skill 只服务当前项目。作者要求、已定稿正文和已确认事实始终优先。",
    "",
    "## 本书定位",
    "",
    `- ${book}`,
    "",
    "## 本书需要的写法",
    "",
    "- 样书观察只有经过作者确认、并在当前稿试用有效后，才在这里保留少量长期习惯。",
    "- 用自然话说明人物如何说、叙述何时靠近或退开、哪些意思不必说完；不写固定次数和句长。",
    "",
    "## 正文执行",
    "",
    "- 动笔前只读取当前确实相关的承接、最近正文和硬事实，不把大纲或细纲栏目当成正文顺序。",
    "- 写完检查人物选择、已知范围、事实与因果；没有问题就不为凑规则强改。",
    ...(author ? ["- 作者已经明确：" + author] : []),
    "",
    "## 不要带入",
    "",
    "- 不复制样书标志性措辞、角色、专有设定、完整桥段、事件顺序或段落顺序。",
    "- 不加载与本书无关的题材模板、拆书教程、固定开篇、固定节拍或通用提示词库。",
    ""
  ].join("\n");
}

module.exports = { buildDefaultWritingSkill };
