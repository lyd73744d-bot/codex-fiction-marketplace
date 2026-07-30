"use strict";
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { listSampleBooks } = require("./sample-book-service");
const { writeArtifact } = require("./artifact-pipeline");
const { buildDefaultWritingSkill } = require("./writing-skill-lib");

async function listChapterFiles(sampleDir) {
  const files = [];
  const stack = [sampleDir];
  const generated = new Set([
    "00_手法学习笔记.md",
    "01_剧情对话文风摘句.md",
    "01_措辞节奏文风摘句.md"
  ]);
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of await fsp.readdir(cur, { withFileTypes: true })) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && /\.(txt|md|markdown)$/i.test(ent.name) && !ent.name.startsWith("_") && !generated.has(ent.name)) files.push(full);
    }
  }
  files.sort((a, b) => a.localeCompare(b, "zh"));
  return files;
}

function compactExcerpt(value, maxChars = 260, preserveLineBreaks = false) {
  const raw = String(value || "").replace(/\r\n?/g, "\n");
  const text = preserveLineBreaks
    ? raw.split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n")
    : raw.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) return text;
  const clipped = text.slice(0, maxChars);
  const stops = [...clipped.matchAll(/[。！？；.!?]/gu)];
  const lastStop = stops.length ? stops[stops.length - 1].index + 1 : 0;
  if (lastStop >= Math.floor(maxChars * 0.6)) return clipped.slice(0, lastStop);
  return clipped.replace(/[，、；：,.!?！？]?[^，。！？；,.!?]{0,24}$/u, "") + "……";
}

function excerptCandidates(text, fileName) {
  const rawLines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const lines = rawLines
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((item) => item.text && !/^第[一二三四五六七八九十百千\d]+[章节卷回]/u.test(item.text));
  const plot = [];
  const dialogue = [];
  const voice = [];

  for (let index = 0; index < lines.length; index += 1) {
    const item = lines[index];
    const length = item.text.length;
    const following = lines.slice(index, index + 4).filter((candidate, offset, group) => offset === 0 || candidate.line <= group[offset - 1].line + 2);
    if (following.length >= 2) {
      const combined = following.map((candidate) => candidate.text).join("\n");
      const actionCount = (combined.match(/推|掀|按|搁|捡|抬|走|站|看|听|问|答|笑|喊|握|放|拿|递|转|停|坐|起|落|开|关|回|追|躲|等|离开/gu) || []).length;
      const changeCount = (combined.match(/却|才|已经|仍|后来|随后|结果|直到|于是|原来|没想到|不再/gu) || []).length;
      if (combined.length >= 100 && combined.length <= 600) {
        plot.push({
          category: "剧情",
          file: fileName,
          firstLine: item.line,
          lastLine: following[following.length - 1].line,
          text: compactExcerpt(combined, 600, true),
          score: actionCount + changeCount * 2 + (following.length >= 3 ? 2 : 0)
        });
      }
      const dialogueLines = following.filter((candidate) => /[“”「"」]/u.test(candidate.text)).length;
      if (dialogueLines && combined.length >= 70 && combined.length <= 520) {
        const reactionCount = (combined.match(/没回答|没有回答|打断|改口|沉默|抬头|低头|看了|转身|停了|笑了|问道|答道|说道/gu) || []).length;
        dialogue.push({
          category: "对话",
          file: fileName,
          firstLine: item.line,
          lastLine: following[following.length - 1].line,
          text: compactExcerpt(combined, 520, true),
          score: dialogueLines * 3 + reactionCount * 2 + (following.length >= 3 ? 1 : 0)
        });
      }
    }

    if (length >= 45 && length <= 320) {
      const perspective = (item.text.match(/他|她|我|只见|知道|觉得|想|记得|没想到|原来|却|仍|只是/gu) || []).length;
      const concrete = (item.text.match(/推|掀|按|搁|捡|抬|走|站|看|听|问|答|笑|喊|握|放|拿|递|转|停|坐|起|落|开|关/gu) || []).length;
      voice.push({
        category: "文风",
        file: fileName,
        firstLine: item.line,
        lastLine: item.line,
        text: compactExcerpt(item.text, 320),
        score: perspective + concrete + (length >= 80 ? 2 : 0) + (/[。！？]$/u.test(item.text) ? 1 : 0)
      });
    }
  }

  return { plot, dialogue, voice };
}

function selectExcerpts(chapterTexts, perCategory = 3) {
  const buckets = { plot: [], dialogue: [], voice: [] };
  for (const chapter of chapterTexts) {
    const candidates = excerptCandidates(chapter.text, chapter.file);
    for (const key of Object.keys(buckets)) buckets[key].push(...candidates[key]);
  }
  const select = (items) => {
    const used = new Set();
    const ranges = [];
    return items
      .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file, "zh") || a.firstLine - b.firstLine)
      .filter((item) => {
        const key = item.text.replace(/\s+/g, "");
        if (!key || used.has(key)) return false;
        const overlaps = ranges.some((range) => range.file === item.file && item.firstLine <= range.lastLine && item.lastLine >= range.firstLine);
        if (overlaps) return false;
        used.add(key);
        ranges.push({ file: item.file, firstLine: item.firstLine, lastLine: item.lastLine });
        return true;
      })
      .slice(0, perCategory)
      .map(({ score, ...item }) => item);
  };
  return {
    plot: select(buckets.plot),
    dialogue: select(buckets.dialogue),
    voice: select(buckets.voice)
  };
}

function renderExcerptNotes({ sampleName, excerpts, currentBook = "", focus = "" } = {}) {
  const sections = [
    ["剧情片段", excerpts.plot, "看一件事怎样引出下一件事，人物的选择留下了什么结果。只学因果，不搬原书剧情。"],
    ["对话片段", excerpts.dialogue, "看双方各自想要什么、说了多少、动作和沉默怎样接住对白。只学说话方法，不搬原句。"],
    ["文风片段", excerpts.voice, "看措辞、长短句、段落换气、叙述距离和说透程度。只学取舍，不模仿标志性表达。"]
  ];
  const lines = [
    "# 样书摘句与对照",
    "",
    "> 以下完整句段只作本地学习证据。保留出处便于回看上下文；不得整份发送给正文模型，不得复制标志性措辞、句式或连续情节。",
    "",
    `- 样书：${sampleName || "未命名"}`,
    `- 当前项目：${String(currentBook || "").trim() || "未提供"}`,
    `- 本次关注：${String(focus || "").trim() || "剧情、对话与文风"}`
  ];
  for (const [heading, items, question] of sections) {
    lines.push("", `## ${heading}`, "", `> 对照时：${question}`);
    if (!items.length) {
      lines.push("", "这一类暂未截到合适的完整片段，可以人工指定位置，不用凑数。");
      continue;
    }
    for (const item of items) {
      const range = item.firstLine === item.lastLine ? `第 ${item.firstLine} 行` : `第 ${item.firstLine}-${item.lastLine} 行`;
      lines.push("", `### ${item.file} · ${range}`, "", ...item.text.split("\n").map((line) => `> ${line}`), "", "随手记：");
    }
  }
  lines.push("", "## 给当前稿的参考", "", "这次真正想借的一点（可以不借）：", "", "试过以后还要不要留：待作者确认", "");
  return lines.join("\n");
}

function localTechniqueHints(text) {
  const body = String(text || "").replace(/\r\n?/g, "\n");
  const lines = body.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const chars = body.replace(/\s+/g, "").length;
  const dialogue = lines.filter((l) => /[“"「]|说|道|问|喝道|冷声/.test(l)).length;
  const shortParas = lines.filter((l) => l.length > 0 && l.length <= 18).length;
  const longParas = lines.filter((l) => l.length >= 80).length;
  const questions = (body.match(/[？?]/g) || []).length;
  const sensory = (body.match(/看见|听见|闻到|刺痛|发冷|发热|血腥|尘土|雨声|脚步/g) || []).length;
  const abstract = (body.match(/仿佛|似乎|不禁|心中一动|意味深长|毫无疑问|总而言之/g) || []).length;
  const conflict = (body.match(/拒绝|逼|压|威胁|反驳|对峙|谈判|翻脸|撕破/g) || []).length;
  const timeJump = (body.match(/翌日|次日|三天后|半晌|片刻|与此同时|与此同时/g) || []).length;
  const ratio = dialogue / Math.max(lines.length, 1);
  const hints = [];
  if (ratio > 0.35) hints.push("这部分主要由对话承载；需要回到原文核对信息是直接说出、绕开，还是由反应补足");
  if (ratio < 0.12 && chars > 1000) hints.push("这部分叙述占比明显较高；需要核对旁白是在推进当下判断，还是集中说明背景");
  if (shortParas / Math.max(lines.length, 1) > 0.28) hints.push("短段出现较多；先确认它们是否集中在某类场景，不推导成全书句式要求");
  if (longParas / Math.max(lines.length, 1) > 0.25) hints.push("长段出现较多；需要观察每段内部是否只处理一个关注点，还是容纳了时间推进");
  if (/(忽然|猛地|瞬间|下一秒)/.test(body)) hints.push("存在明显转折词；需要核对转折是否由前文因果支撑");
  if (/(他想|她想|心道|暗自)/.test(body)) hints.push("存在直接心理叙述；需要观察这些念头是否改变人物之后的行动");
  if (questions >= 3) hints.push("问句较多；需要区分真正追问、回避和单纯的信息问答");
  if (sensory >= 4 && sensory > abstract) hints.push("具体感受词多于抽象判断词；需要观察这些细节是否被人物当前处境筛选");
  if (abstract >= 5) hints.push("抽象判断词较多；不能自动判好坏，需要结合前后文看是否承担必要概括");
  if (conflict >= 3) hints.push("人物之间有明显对抗；需要回到原文确认分歧是否真的改变了选择");
  if (timeJump >= 2) hints.push("存在时间跳切；需要观察哪些过程被省略、哪些结果被保留");
  if (lines.length && lines[lines.length - 1].length < 40) hints.push("结尾较短；需要结合下一段或下一章判断它是自然停顿还是刻意悬置");
  if (!hints.length) hints.push("暂时没有稳定特征：保留原文观察，不强行归纳成方法");
  return {
    chars,
    lines: lines.length,
    dialogue,
    shortParas,
    longParas,
    questions,
    sensory,
    abstract,
    conflict,
    hints
  };
}

async function learnSampleTechniques({ projectDir, sampleName = "", maxFiles, focus = "", currentBook = "" } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const listed = await listSampleBooks(projectDir);
  if (!listed.items.length) return { ok: false, message: "还没有样书。请先拖入样书文件夹并 import。" };
  const item = sampleName ? listed.items.find((x) => x.name === sampleName) || listed.items[0] : listed.items[0];
  const files = await listChapterFiles(item.dir);
  const requested = Number(maxFiles);
  const limit = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), 500)
    : files.length;
  const selected = files.slice(0, limit);
  const chapters = [];
  const chapterTexts = [];
  for (const file of selected) {
    const text = await fsp.readFile(file, "utf8");
    const stats = localTechniqueHints(text.slice(0, 20000));
    chapters.push({ file: path.basename(file), relativePath: path.relative(projectDir, file), ...stats });
    chapterTexts.push({ file: path.basename(file), text: text.slice(0, 30000) });
  }
  const excerpts = selectExcerpts(chapterTexts);
  const excerptPath = path.join(item.dir, "01_剧情对话文风摘句.md");
  const excerptNotes = renderExcerptNotes({ sampleName: item.name, excerpts, currentBook, focus });
  await fsp.writeFile(excerptPath, excerptNotes, "utf8");
  const aggregateHints = [...new Set(chapters.flatMap((c) => c.hints))];
  const notesPath = path.join(item.dir, "00_手法学习笔记.md");
  const notes = [
    "# 样书手法学习笔记", "",
    "> 只看剧情怎样衔接、人物怎样说话、叙述文字怎样落下来。禁止照抄原句、角色、设定或完整桥段。", "",
    "## 样书", item.name, "",
    "## 当前项目与本次关注", "- 当前项目：" + (String(currentBook || "").trim() || "未提供，只做样书自身观察"), "- 本次关注：" + (String(focus || "").trim() || "未指定，不预设结论"), "",
    "## 已读范围", "- 文件数：" + chapters.length, "- 总字数约：" + chapters.reduce((s, c) => s + c.chars, 0), "",
    "## 值得继续核对的写法（本地观察，不自动采用）",
    ...aggregateHints.map((h) => "- " + h), "",
    "## 明确不要带入", "- 原书角色名、专有设定、完整事件顺序、原句", "",
    "## 分章观察",
    ...chapters.map((c) => "- " + c.file + "｜字数" + c.chars + "｜对话行" + c.dialogue + "｜" + c.hints.join("；")), ""
  ].join("\n");
  await fsp.writeFile(notesPath, notes, "utf8");
  const report = await writeArtifact({ projectDir, kind: "sample_learn", title: item.name, content: notes, ext: "md", modelId: "local-sample-learn" });
  const excerptCount = excerpts.plot.length + excerpts.dialogue.length + excerpts.voice.length;
  return { ok: true, sample: item.name, filesRead: chapters.length, notesPath, excerptPath, excerptCount, artifact: report, observations: aggregateHints, excerpts, adopted: [], coach: "剧情、对话和文风片段已按出处保存，但没有自动变成写作限制。把当前稿放在旁边，觉得哪一点有用就试哪一点；作者认可后再保留。" };
}

async function ensureProjectWritingSkill(projectDir, { currentBook = "", authorRules = "" } = {}) {
  const skillDir = path.join(projectDir, "辅助文档");
  await fsp.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "10_本书写作Skill.md");
  if (!fs.existsSync(skillPath)) {
    const body = buildDefaultWritingSkill({ currentBook, authorRules });
    await fsp.writeFile(skillPath, body, "utf8");
    return { ok: true, created: true, path: skillPath, content: body };
  }
  return { ok: true, created: false, path: skillPath, content: await fsp.readFile(skillPath, "utf8") };
}

module.exports = { learnSampleTechniques, ensureProjectWritingSkill, listChapterFiles, localTechniqueHints, excerptCandidates, selectExcerpts, renderExcerptNotes };
