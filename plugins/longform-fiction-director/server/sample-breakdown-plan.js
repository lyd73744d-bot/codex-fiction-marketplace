const DEFAULT_FRONT_CHAPTER_LIMIT = 30;
const MIN_FRONT_CHAPTER_LIMIT = 20;
const MAX_FRONT_CHAPTER_LIMIT = 30;
const FRONT_CHAPTER_BATCH_SIZE = 10;

function normalizeFrontChapterLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_FRONT_CHAPTER_LIMIT;
  return Math.max(MIN_FRONT_CHAPTER_LIMIT, Math.min(MAX_FRONT_CHAPTER_LIMIT, Math.floor(parsed)));
}

function buildFrontChapterBatches(chapters = [], options = {}) {
  const chapterLimit = normalizeFrontChapterLimit(options.chapterLimit);
  const selected = (Array.isArray(chapters) ? chapters : []).slice(0, chapterLimit);
  const batches = [];
  for (let index = 0; index < selected.length; index += FRONT_CHAPTER_BATCH_SIZE) {
    batches.push(selected.slice(index, index + FRONT_CHAPTER_BATCH_SIZE));
  }
  return batches;
}

function renderBreakdownProgressMarkdown({
  bookName = "样书",
  engineName = "",
  totalBatches = 0,
  completedBatches = [],
  status = ""
} = {}) {
  const completed = Array.isArray(completedBatches) ? completedBatches : [];
  const total = Math.max(0, Number(totalBatches) || 0);
  const progressStatus = status || (completed.length >= total && total > 0
    ? `批次拆解完成 ${completed.length}/${total}，正在整理最终文档`
    : completed.length > 0
      ? `拆解中 ${completed.length}/${total}`
      : `准备中 0/${total}`);
  const lines = [
    "# 样书拆解进度",
    "",
    `- 样书：${String(bookName || "样书").trim()}`,
    `- 使用引擎：${String(engineName || "未指定").trim()}`,
    `- 状态：${progressStatus}`,
    `- 范围：只拆前 ${DEFAULT_FRONT_CHAPTER_LIMIT} 章，每批 ${FRONT_CHAPTER_BATCH_SIZE} 章`,
    "",
    "## 已完成批次"
  ];

  if (!completed.length) {
    lines.push("", "尚未完成第一批，模型正在读取第 1 批材料。");
  } else {
    for (const [index, batch] of completed.entries()) {
      lines.push(
        "",
        `### 第 ${index + 1} 批：第 ${batch.first}-${batch.last} 章`,
        "",
        String(batch.note || "").trim() || "本批已完成。"
      );
    }
  }

  return `${lines.join("\n").trim()}\n`;
}

module.exports = {
  DEFAULT_FRONT_CHAPTER_LIMIT,
  MIN_FRONT_CHAPTER_LIMIT,
  MAX_FRONT_CHAPTER_LIMIT,
  FRONT_CHAPTER_BATCH_SIZE,
  normalizeFrontChapterLimit,
  buildFrontChapterBatches,
  renderBreakdownProgressMarkdown
};
