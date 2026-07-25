const ALLOWED_SECTIONS = ["本书定位", "本书需要的写法", "正文执行", "不要带入"];

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
  const book = compact(currentBook, 900) || "尚未确认。确认脑洞和大纲后，再从本书样书中提取真正需要的写法。";
  const author = compact(authorRules, 900);
  return [
    "# 写作Skill",
    "",
    "> 这份 Skill 只服务当前项目。作者要求、当前章细纲和已定稿正文始终优先。",
    "",
    "## 本书定位",
    "",
    `- ${book}`,
    "",
    "## 本书需要的写法",
    "",
    "- 待样书拆解后，只补入与本书题材、人物和当前写作目标直接相关的 3-8 条规则。",
    "- 每条规则都要能落实成正文动作、对话、段落节奏或章尾处理，不能写成泛泛理论。",
    "",
    "## 正文执行",
    "",
    "- 动笔前读取当前章细纲、最近正文和本书台账；冲突时以作者最新意见和已定稿正文为准。",
    "- 写完只检查本章是否推进、人物是否按当前状态行动、设定和资源是否与台账一致。",
    ...(author ? ["- 作者已明确的本书要求：" + author] : []),
    "",
    "## 不要带入",
    "",
    "- 不复制样书原句、角色、专有设定、完整桥段和事件顺序。",
    "- 不加载与本书无关的题材模板、类型预设、拆书教程或通用提示词库。",
    ""
  ].join("\n");
}

function sectionMap(markdown = "") {
  const source = String(markdown || "")
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```\s*$/i, "")
    .replace(/\r\n?/g, "\n");
  const matches = [...source.matchAll(/^##\s+(.+?)\s*$/gm)];
  const sections = {};
  for (let index = 0; index < matches.length; index += 1) {
    const heading = matches[index][1].trim();
    const start = matches[index].index + matches[index][0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : source.length;
    sections[heading] = source.slice(start, end).trim().slice(0, 2400);
  }
  return sections;
}

function needsLegacyWritingSkillMigration(markdown = "") {
  const source = String(markdown || "");
  const markers = [
    "## 可选简单 Skill 预设",
    "## 题材提示词预设库",
    "### 类型选择示例",
    "### 样书章节拆解"
  ];
  return markers.filter((marker) => source.includes(marker)).length >= 2;
}

function extractLegacyCurrentBookRules(markdown = "") {
  const body = sectionMap(markdown)["本书专属 Skill"] || "";
  const emptyLabels = /^(?:句子质感|段落节奏|对话口味|动作描写|氛围锚点|不喜欢)[：:]\s*$/;
  return body
    .split("\n")
    .map((line) => line.trim().replace(/^[-*]\s*/, ""))
    .filter((line) => line && !emptyLabels.test(line) && !/待提取|待补充|尚未确认/.test(line))
    .slice(0, 12)
    .join("；")
    .slice(0, 1800);
}

function migrateLegacyWritingSkill(markdown = "", { currentBook = "" } = {}) {
  if (!needsLegacyWritingSkillMigration(markdown)) return String(markdown || "");
  return buildDefaultWritingSkill({
    currentBook,
    authorRules: extractLegacyCurrentBookRules(markdown)
  });
}

function sectionBullets(body = "", limit = 8) {
  return String(body || "")
    .split("\n")
    .map((line) => line.trim().match(/^[-*]\s+(.+)$/)?.[1]?.trim() || "")
    .filter(Boolean)
    .slice(0, limit);
}

function enrichWritingSkillFromRhythmPalette(markdown = "", palette = "", { currentBook = "" } = {}) {
  const current = String(markdown || "");
  if (!/待样书拆解后/.test(current) || !String(palette || "").trim()) return current;
  const paletteSections = sectionMap(palette);
  const rules = [
    ...sectionBullets(paletteSections["写当前章细纲时"], 2),
    ...sectionBullets(paletteSections["写正文时"], 4),
    ...sectionBullets(paletteSections["文风执行"], 2)
  ].filter((value, index, list) => list.indexOf(value) === index).slice(0, 8);
  if (!rules.length) return current;
  const currentSections = sectionMap(current);
  const existingForbidden = sectionBullets(currentSections["不要带入"], 6);
  const paletteForbidden = sectionBullets(paletteSections["禁止照搬"], 6);
  const forbidden = [...existingForbidden, ...paletteForbidden]
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, 8);
  const raw = [
    "# 写作Skill",
    "",
    "## 本书定位",
    "",
    currentSections["本书定位"] || `- ${compact(currentBook, 900)}`,
    "",
    "## 本书需要的写法",
    "",
    ...rules.map((rule) => `- ${rule}`),
    "",
    "## 正文执行",
    "",
    currentSections["正文执行"] || "- 动笔前读取当前章细纲、最近正文和本书台账。",
    "",
    "## 不要带入",
    "",
    ...forbidden.map((rule) => `- ${rule}`)
  ].join("\n");
  return sanitizeCurrentBookWritingSkill(raw, { currentBook });
}

function extractExistingCurrentBookRules(markdown = "") {
  const sections = sectionMap(markdown);
  return ALLOWED_SECTIONS
    .filter((heading) => sections[heading])
    .map((heading) => `## ${heading}\n${sections[heading]}`)
    .join("\n\n")
    .slice(0, 5000);
}

function buildSampleSkillMessages({
  currentBook = "",
  focus = "",
  existingCurrentBookRules = "",
  sampleMarkdown = "",
  antiSlopText = ""
} = {}) {
  return [
    {
      role: "system",
      content: [
        "你是中文商业小说的样书学习编辑。最终产物只服务当前这一本书。",
        "从样书中只提取能直接改善当前书正文的写法；不适合当前书的内容直接丢弃。",
        "禁止复制样书原句、角色名、地名、专有设定、完整桥段和事件顺序。",
        "不要输出通用教程、题材预设库、拆书流程或与正文执行无关的 Skill。",
        compact(antiSlopText, 1800)
      ].filter(Boolean).join("\n")
    },
    {
      role: "user",
      content: [
        "# 当前这一本书",
        compact(currentBook, 5000) || "尚未确认，请只保留最少规则并标明待作者确认。",
        "",
        "# 作者本次最想学习",
        compact(focus, 1200) || "请从样书中挑 3-8 条最适合当前书的具体写法。",
        "",
        "# 作者已确认的本书规则",
        compact(existingCurrentBookRules, 5000) || "暂无。",
        "",
        "# 样书材料",
        String(sampleMarkdown || "").slice(0, 30000),
        "",
        "# 输出合同",
        "只输出一个 Markdown 文件，不要解释，严格使用以下四个二级标题：",
        "# 写作Skill",
        "## 本书定位",
        "## 本书需要的写法",
        "## 正文执行",
        "## 不要带入",
        "每节只写当前书真正会用到的内容；每条必须具体、可执行，总长度控制在 2500 字以内。"
      ].join("\n")
    }
  ];
}

function sanitizeCurrentBookWritingSkill(raw = "", { currentBook = "", authorRules = "" } = {}) {
  const fallback = buildDefaultWritingSkill({ currentBook, authorRules });
  const fallbackSections = sectionMap(fallback);
  const returnedSections = sectionMap(raw);
  const lines = [
    "# 写作Skill",
    "",
    "> 这份 Skill 只服务当前项目。作者要求、当前章细纲和已定稿正文始终优先。"
  ];
  for (const heading of ALLOWED_SECTIONS) {
    const body = compact(returnedSections[heading], 2400) || fallbackSections[heading];
    lines.push("", `## ${heading}`, "", body);
  }
  return `${lines.join("\n").trim()}\n`;
}

module.exports = {
  buildDefaultWritingSkill,
  buildSampleSkillMessages,
  sanitizeCurrentBookWritingSkill,
  extractExistingCurrentBookRules,
  needsLegacyWritingSkillMigration,
  migrateLegacyWritingSkill,
  enrichWritingSkillFromRhythmPalette
};
