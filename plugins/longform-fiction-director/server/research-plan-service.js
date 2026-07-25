"use strict";

const { createResearchDoc } = require("./research-doc-service");
const { writeArtifact } = require("./artifact-pipeline");

function uniq(items) {
  return [...new Set((items || []).map((x) => String(x || "").trim()).filter(Boolean))];
}

function buildSearchQueries({ topic, genre = "", names = [], storyRole = "" } = {}) {
  const main = String(topic || "").trim();
  const g = String(genre || "").trim();
  const role = String(storyRole || "").trim();
  const people = uniq(names).slice(0, 8);
  const queries = uniq([
    main,
    main + " 生平",
    main + " 任职 官职",
    main + " 时间线",
    main + " 常见误区",
    g ? g + " " + main : "",
    role ? main + " " + role : "",
    ...people.map((n) => n + " 与 " + main),
    ...people.map((n) => n + " 历史 身份")
  ]);
  return queries.slice(0, 12);
}

function buildOocRisks({ topic, genre = "", names = [] } = {}) {
  const risks = [
    "身份/官职/职责写错",
    "时间线前后矛盾",
    "地理与行军距离不合理",
    "称谓/礼仪不符合时代",
    "把现代制度硬套历史",
    "人物性格与史料/已设人设冲突"
  ];
  if (/历史|明|清|唐|宋|民国|战争|军/.test(String(genre) + String(topic))) {
    risks.unshift("史实人物立场、阵营、生死节点写错");
  }
  if ((names || []).length) risks.push("群像关系网互相打架");
  return uniq(risks).slice(0, 10);
}

async function planResearch({
  projectDir,
  topic,
  genre = "",
  names = [],
  storyRole = "",
  notes = "",
  createDoc = true
} = {}) {
  if (!projectDir) throw new Error("projectDir required");
  if (!topic) throw new Error("topic required");

  const queries = buildSearchQueries({ topic, genre, names, storyRole });
  const risks = buildOocRisks({ topic, genre, names });
  const checklist = [
    "用内置浏览器打开至少 2 个可信来源（百科/史籍整理/学术或权威转载）",
    "记录：标题 + 链接 + 访问日期",
    "只把“已确认事实”写进核验文档",
    "明确“禁止写错”和“可虚构边界”",
    "真实人物再建人物卡（kind=historical）",
    "没来源的关键决策不许写进正文"
  ];

  let doc = null;
  if (createDoc) {
    doc = await createResearchDoc({ projectDir, topic, genre, notes: notes || ("故事作用：" + (storyRole || "待定")) });
  }

  const planMd = [
    "# 联网核验计划：" + topic,
    "",
    "> 先搜后写。此计划给责编与作者共用。",
    "",
    "## 题材/作用",
    "- 题材：" + (genre || "待定"),
    "- 在故事里的作用：" + (storyRole || "待定"),
    notes ? "- 备注：" + notes : "",
    "",
    "## 建议检索词",
    ...queries.map((q, i) => (i + 1) + ". " + q),
    "",
    "## OOC / 穿帮风险",
    ...risks.map((r) => "- " + r),
    "",
    "## 执行清单",
    ...checklist.map((c, i) => (i + 1) + ". " + c),
    "",
    "## 回填工具",
    "1. 浏览器真实检索",
    "2. fiction_append_research_findings",
    "3. fiction_create_character_card（如需）",
    "4. fiction_assess_pipeline 检查 research_filled",
    ""
  ].filter(Boolean).join("\n");

  const artifact = await writeArtifact({
    projectDir,
    kind: "research_plan",
    title: topic,
    content: planMd,
    ext: "md",
    modelId: "research-plan"
  });

  return {
    ok: true,
    topic,
    queries,
    risks,
    checklist,
    researchDoc: doc,
    artifact,
    coach: "请用内置浏览器按检索词真实搜索，再回填来源与事实。不要用模型记忆冒充检索。"
  };
}

module.exports = { planResearch, buildSearchQueries, buildOocRisks };
