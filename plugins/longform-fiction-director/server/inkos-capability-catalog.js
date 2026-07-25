"use strict";

function capability(id, label, group, taskKind, promptDirective, legacyActions = []) {
  return Object.freeze({ id, label, group, taskKind, promptDirective, legacyActions: Object.freeze([...legacyActions]) });
}

const CAPABILITIES = Object.freeze([
  capability("idea-start", "脑洞起点", "脑洞与立项", "brainstorm", "从作者给出的任意灵感出发，提出会改变方向的关键问题并生成可选方向，不规定候选数量。", ["project:createFromIdea", "idea:radar"]),
  capability("idea-expand", "脑洞扩展", "脑洞与立项", "brainstorm", "扩展现有脑洞的冲突、人物欲望和代价，只保留与当前方向有因果关系的可能性。", ["idea:radarExpand"]),
  capability("reference-recommendation", "参考书方向", "脑洞与立项", "specialist", "基于公开资料推荐可合法研究的参考方向，说明可迁移技法，不复制作品表达或独特桥段。", ["idea:recommendBooks"]),
  capability("existing-novel-ledger", "旧稿提取台账", "项目与台账", "specialist", "从作者提供的旧稿提取明确事实、待确认推断和连续性风险，候选结果不得直接写入正式台账。", ["project:importExistingNovelToLedgers"]),
  capability("title-synopsis", "书名与简介", "定位与包装", "specialist", "结合题材承诺、主冲突和读者预期生成或诊断书名与简介，不使用空泛万能句式。", ["title:generate", "title:confirm"]),
  capability("outline-design", "长篇大纲", "结构与连续性", "outline", "按当前故事因果设计可调整的大纲，不预设卷数、章数或爽点间隔。"),
  capability("outline-logic-check", "大纲逻辑检查", "结构与连续性", "specialist", "检查大纲逻辑、因果链、人物动机、信息释放、伏笔回收和时间线，指出证据与具体缺口。", ["outline:logicVerify"]),
  capability("outline-logic-revision", "大纲逻辑修订", "结构与连续性", "specialist", "根据作者采纳的逻辑问题给出可执行修订稿；未获确认时只生成候选，不改正式大纲。", ["outline:applyLogicFix"]),
  capability("chapter-brief", "章节意图", "章节生产", "chapter-brief", "结合当前台账和前后章因果形成章节意图，不套固定场景数量。", ["chapter:generateBrief"]),
  capability("chapter-draft", "章节正文", "章节生产", "draft", "按章节意图和已确认事实起草正文，并执行去 AI 味检查。", ["draft:generateInternal", "chapter:generateText"]),
  capability("draft-quality-check", "正文质量检查", "审稿与改稿", "review", "检查正文的叙事推进、人物声音、场景证据、重复、解释腔和 AI 痕迹。", ["draft:qualityCheck", "review:generate"]),
  capability("draft-qc-revision", "按质检改稿", "审稿与改稿", "specialist", "只针对已指出的问题给出逐处改法，保持原有事实、叙事视角和有效表达。", ["draft:reviseWithQc"]),
  capability("self-critique-rewrite", "自我批评重写", "审稿与改稿", "specialist", "先定位文本最弱的具体段落和原因，再给局部重写；不把整章统一改成一种模型腔。", ["draft:selfCritique"]),
  capability("dialogue-meme-polish", "对白与梗润色", "审稿与改稿", "specialist", "检查对白功能、人物区分度和梗的语境，只在角色与场景允许时使用网络表达。", ["draft:polishMemes"]),
  capability("three-chapter-review", "连续三章回看", "结构与连续性", "review", "跨近期章节检查承诺、兑现、信息重复、人物状态和下一步推动。", ["review:loadRecentFinalChapters", "writeback:generateThreeChapter"]),
  capability("review-writeback", "审稿建议写回", "审稿与改稿", "specialist", "把作者采纳的审稿意见整理成大纲或章节修订候选，明确影响范围和回滚点。", ["review:applyToChapterPlan", "review:applyToChapters"]),
  capability("iron-rules", "全书铁律", "项目与台账", "specialist", "整理作者明确提出的长期禁区和硬约束，区分永久规则、项目规则与本章临时要求。", ["ironRules:read", "ironRules:add", "ironRules:save"]),
  capability("fanfic-constraints", "同人设定约束", "世界观与资料", "specialist", "整理同人原作硬设定、可改动空间和读者预期；未知事实必须标注待核对。", ["tongren:list", "tongren:apply"]),
  capability("world-library", "世界观设定", "世界观与资料", "specialist", "建立服务当前故事冲突的世界规则、资源、权力和代价，不堆砌百科条目。", ["world:list", "world:apply"]),
  capability("world-research", "世界资料研究", "世界观与资料", "specialist", "先使用可验证公开来源研究背景，再区分事实、推断和创作改编。", ["world:research", "web:search"]),
  capability("vip-library", "专属资料库", "世界观与资料", "specialist", "围绕作者已授权的专属资料库说明可用范围、检索结果和项目绑定建议，不跨项目泄露资料。", ["vip:list", "project:bindLibrary"]),
  capability("project-experience", "项目经验提炼", "学习与进化", "specialist", "从作者接受、拒绝和手改证据中提炼候选经验；单次偏好不得自动升级成永久规则。", ["experience:summary", "experience:appendFromRewrite", "experience:promoteToGlobal"]),
  capability("style-evolution", "风格 Skill 提炼", "学习与进化", "specialist", "比较已确认章节与修改记录，提炼可评测、可回滚的风格候选规则。", ["style:refineFromChapters", "style:history"]),
  capability("rag-library", "RAG 资料检索", "世界观与资料", "specialist", "判断当前问题需要哪些项目资料和检索证据，报告命中、缺口和冲突，不把检索片段直接当事实。", ["rag:get", "rag:refresh"]),
  capability("benchmark-analysis", "样本基准分析", "拆书与学习", "specialist", "对作者登记的样本做结构、节奏、压力和兑现分析，只输出可迁移技法。", ["benchmark:get", "benchmark:analyze"]),
  capability("character-board", "角色板", "人物", "specialist", "整理角色目标、恐惧、资源、秘密、关系状态和声音证据，不规定角色数量。", ["character-board:get", "character-board:save"]),
  capability("character-seed", "角色种子", "人物", "specialist", "从故事冲突反推必要角色及其互相施压方式，不为凑数增加人物。", ["character-board:generateSeed"]),
  capability("character-writeback", "角色变化写回", "人物", "specialist", "从已发生剧情提取角色状态变化和关系变化，形成待作者确认的写回建议。", ["character-board:generateWritebackSuggestion"]),
  capability("character-image-prompt", "角色视觉提示", "定位与包装", "specialist", "根据已确认角色事实形成图像提示词，避免文本模型声称已经生成图片。", ["character-board:generateImage"]),
  capability("style-workflow", "文风专项", "审稿与改稿", "specialist", "按作者指定的文风问题做诊断、对照片段和局部修订，保留人物与叙事差异。", ["style:run"]),
  capability("prose-length-normalizer", "正文长度归一", "审稿与改稿", "specialist", "按作者指定目标对正文做有约束的扩写或压缩，保持情节事实、人物声音和因果顺序。", ["prose:normalize"]),
  capability("plot-forecast", "情节分支预测", "结构与连续性", "specialist", "基于当前已确认状态预测可行分支，明确每个分支的前提、代价和连续性风险，不把预测写成既定事实。", ["forecast:generate"]),
  capability("plot-forecast-repair", "预测结构修复", "结构与连续性", "specialist", "依据结构校验错误修复情节预测，只修改导致无效的字段和因果连接。", ["forecast:repair"]),
  capability("cover-prompt", "封面提示词", "定位与包装", "specialist", "从书名、题材承诺、主角和核心冲突生成可交给图像模型的封面提示词。", ["cover:buildPrompt"]),
  capability("public-web-research", "公开网络研究", "世界观与资料", "specialist", "围绕当前写作问题做一次聚焦公开检索，记录来源、日期、可验证结论和不确定项。", ["web:search"]),
  capability("market-scan", "番茄公开榜研究", "市场研究", "market-scan", "只研究公开排行与可见元数据，保存证据，不进入私密阅读页。"),
  capability("authorized-download", "授权书源下载", "拆书与学习", "download", "只通过作者配置并明确授权的回环下载服务导入书源。"),
  capability("source-deconstruction", "登记书源拆解", "拆书与学习", "deconstruct", "只拆解项目已登记书源，输出可迁移技法而非复述原文。"),
  capability("chapter-settlement", "作者确认落账", "项目与台账", "settle", "只有作者明确确认的正文和事实才能进入正式台账。")
]);

const BY_ID = new Map(CAPABILITIES.map((item) => [item.id, item]));

function listInkOsCapabilities() { return CAPABILITIES; }
function getInkOsCapability(id) { return BY_ID.get(String(id || "")) || null; }

module.exports = { getInkOsCapability, listInkOsCapabilities };
