"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const fanqieFontMaps = require("./data/fanqie-font-maps.json");

const FANQIE_BASE_URL = "https://fanqienovel.com";
const FANQIE_RANKS = Object.freeze([
  { id: "read", name: "阅读榜", rankMold: 2 },
  { id: "new", name: "新书榜", rankMold: 1 }
]);
const FANQIE_CHANNELS = Object.freeze([
  { id: "male", name: "男频", gender: 1 },
  { id: "female", name: "女频", gender: 0 }
]);

const QIDIAN_RANKS = Object.freeze([
  { id: "yuepiao", route: "yuepiao", name: "月票榜", period: "month" },
  { id: "hotsales", route: "hotsales", name: "畅销榜" },
  { id: "readindex", route: "readindex", name: "阅读指数榜" },
  { id: "newfans", route: "newfans", name: "书友榜", categorySuffix: "3" },
  { id: "recom", route: "rec", name: "推荐榜", categorySuffix: "3" },
  { id: "vipup", route: "update", name: "更新榜" },
  { id: "signnewbook", route: "sign", name: "签约榜" },
  { id: "pubnewbook", route: "newbook", name: "新书榜" },
  { id: "newauthor", route: "newauthor", name: "新人榜" }
]);
const QIDIAN_CATEGORIES = Object.freeze([
  { id: "-1", name: "全站" },
  { id: "21", name: "玄幻" },
  { id: "1", name: "奇幻" },
  { id: "2", name: "武侠" },
  { id: "22", name: "仙侠" },
  { id: "4", name: "都市" },
  { id: "15", name: "现实" },
  { id: "6", name: "军事" },
  { id: "5", name: "历史" },
  { id: "7", name: "游戏" },
  { id: "8", name: "体育" },
  { id: "9", name: "科幻" },
  { id: "10", name: "悬疑灵异" },
  { id: "20109", name: "诸天无限" },
  { id: "12", name: "轻小说" }
]);

const DEFAULT_HEADERS = Object.freeze({
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
  "accept-language": "zh-CN,zh;q=0.9",
  accept: "text/html,application/json;q=0.9,*/*;q=0.8"
});
const MOBILE_HEADERS = Object.freeze({
  ...DEFAULT_HEADERS,
  "user-agent": "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36"
});

function toolError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function clean(value) {
  return String(value == null ? "" : value).trim();
}

function safeSegment(value, fallback = "榜单") {
  const name = clean(value) || fallback;
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/\s+/g, " ").slice(0, 80) || fallback;
}

function normalizeLookup(value) {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function resolveOption(value, options, label, fallbackId = null) {
  const requested = normalizeLookup(value || fallbackId);
  const match = options.find((item) => normalizeLookup(item.id) === requested || normalizeLookup(item.name) === requested);
  if (!match) throw toolError("INVALID_ARGUMENT", `${label}不支持：${clean(value) || "（空）"}`);
  return match;
}

function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isoFromSeconds(value) {
  const number = numberOrNull(value);
  if (number == null) return null;
  const milliseconds = number < 1e12 ? number * 1000 : number;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function decodeHtml(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, token) => {
    if (token[0] === "#") {
      const hex = token[1].toLowerCase() === "x";
      const parsed = Number.parseInt(token.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : _;
    }
    return named[token.toLowerCase()] ?? _;
  });
}

function stripHtml(value) {
  return decodeHtml(String(value || "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<em\b[^>]*>/gi, " · ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/[\t\r ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function privateUseCount(value) {
  return [...String(value || "")].filter((char) => {
    const code = char.codePointAt(0);
    return code >= 0xe000 && code <= 0xf8ff;
  }).length;
}

const compiledFontMaps = new Map(fanqieFontMaps.map((entry) => {
  const encoded = [...entry.encoded];
  const decoded = [...entry.decoded];
  if (encoded.length !== decoded.length) throw new Error(`Invalid Fanqie font map: ${entry.fontId}`);
  return [entry.fontId, { ...entry, map: new Map(encoded.map((char, index) => [char, decoded[index]])) }];
}));

function fontIdFromHeader(header) {
  const match = String(header || "").match(/(?:^|;)\s*f=([^;]+)/i);
  return match ? match[1].trim() : null;
}

function decodeFanqieText(value, fontId) {
  const original = String(value || "");
  const config = compiledFontMaps.get(fontId);
  if (!config) return { text: original, mappingKnown: false, remaining: privateUseCount(original) };
  const text = [...original].map((char) => config.map.get(char) || char).join("");
  return { text, mappingKnown: true, remaining: privateUseCount(text) };
}

async function readResponseText(response, maxBytes) {
  const declared = numberOrNull(response.headers?.get?.("content-length"));
  if (declared != null && declared > maxBytes) {
    throw toolError("SOURCE_RESPONSE_TOO_LARGE", `公开榜单响应超过 ${maxBytes} 字节。`);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) throw toolError("SOURCE_RESPONSE_TOO_LARGE", "公开榜单响应过大。");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw toolError("SOURCE_RESPONSE_TOO_LARGE", "公开榜单响应过大。");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createRankingService(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch is unavailable");
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 15000));
  const maxResponseBytes = Math.max(64 * 1024, Number(options.maxResponseBytes || 2 * 1024 * 1024));

  async function fetchPublic(url, requestOptions = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "follow",
        headers: requestOptions.headers || DEFAULT_HEADERS,
        signal: controller.signal
      });
      if (!response || !response.ok) {
        throw toolError("SOURCE_UNAVAILABLE", `公开榜单返回 HTTP ${response?.status || "unknown"}。`, { url: String(url), status: response?.status || null });
      }
      const text = await readResponseText(response, maxResponseBytes);
      return { response, text };
    } catch (cause) {
      if (cause?.code) throw cause;
      if (cause?.name === "AbortError") throw toolError("SOURCE_TIMEOUT", "公开榜单读取超时。", { url: String(url) });
      throw toolError("SOURCE_UNAVAILABLE", "公开榜单当前无法读取。", { url: String(url), cause: cause?.message || String(cause) });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchJson(url, requestOptions = {}) {
    const result = await fetchPublic(url, requestOptions);
    try {
      return { ...result, json: JSON.parse(result.text) };
    } catch {
      throw toolError("SOURCE_FORMAT_CHANGED", "公开榜单没有返回可识别的 JSON。", { url: String(url) });
    }
  }

  async function fanqieCatalog() {
    const url = new URL("/api/config/list", FANQIE_BASE_URL);
    url.searchParams.set("config_key", "serial_rank_category_list_common");
    const { json } = await fetchJson(url, { headers: { ...DEFAULT_HEADERS, referer: `${FANQIE_BASE_URL}/rank` } });
    if (json?.code !== 0 || !Array.isArray(json?.data?.list)) {
      throw toolError("SOURCE_FORMAT_CHANGED", "番茄榜单分类数据格式已变化。", { sourceUrl: url.href });
    }
    return {
      sourceUrl: url.href,
      categories: json.data.list.map((item) => ({ id: String(item.id), name: clean(item.name), channels: Array.isArray(item.group) ? item.group.map(clean) : [] }))
    };
  }

  async function listSources(platform = "") {
    const requested = normalizeLookup(platform);
    if (requested && !["fanqie", "番茄", "qidian", "起点"].includes(requested)) {
      throw toolError("INVALID_ARGUMENT", `不支持的平台：${platform}`);
    }
    const includeFanqie = !requested || requested === "fanqie" || requested === "番茄";
    const includeQidian = !requested || requested === "qidian" || requested === "起点";
    const sources = [];
    const warnings = [];
    if (includeFanqie) {
      try {
        const catalog = await fanqieCatalog();
        sources.push({
          id: "fanqie",
          name: "番茄小说",
          publicPageUrl: `${FANQIE_BASE_URL}/rank`,
          catalogSourceUrl: catalog.sourceUrl,
          channels: FANQIE_CHANNELS.map(({ id, name }) => ({ id, name })),
          ranks: FANQIE_RANKS.map(({ id, name }) => ({ id, name })),
          categories: catalog.categories
        });
      } catch (cause) {
        warnings.push(`番茄分类暂时不可读：${cause.message}`);
      }
    }
    if (includeQidian) {
      sources.push({
        id: "qidian",
        name: "起点中文网",
        publicPageUrl: "https://www.qidian.com/rank/",
        dataPageUrl: "https://m.qidian.com/rank",
        channels: [{ id: "male", name: "男生" }],
        ranks: QIDIAN_RANKS.map(({ id, name, period }) => ({ id, name, ...(period ? { period } : {}) })),
        categories: QIDIAN_CATEGORIES.map((item) => ({ ...item }))
      });
    }
    if (!sources.length) throw toolError("SOURCE_UNAVAILABLE", "榜单来源当前都不可读。");
    return { ok: true, fetchedAt: now().toISOString(), sources, warnings };
  }

  async function scanFanqie(input) {
    const rank = resolveOption(input.rank, FANQIE_RANKS, "番茄榜单", "read");
    const channel = resolveOption(input.channel, FANQIE_CHANNELS, "番茄频道", "male");
    const catalog = await fanqieCatalog();
    if (!clean(input.category)) throw toolError("INVALID_ARGUMENT", "扫描番茄榜单时需要指定分类名称或分类 ID。请先调用 fiction_rank_sources 查看分类。");
    const category = resolveOption(input.category, catalog.categories.filter((item) => item.channels.includes(channel.id)), "番茄分类");
    const limit = Math.min(30, Math.max(1, Number(input.limit || 10)));
    const url = new URL("/api/rank/category/list", FANQIE_BASE_URL);
    for (const [key, value] of Object.entries({
      app_id: "2503",
      rank_list_type: "3",
      offset: "0",
      limit: String(limit),
      category_id: category.id,
      rank_version: "",
      gender: String(channel.gender),
      rankMold: String(rank.rankMold)
    })) url.searchParams.set(key, value);
    const { response, json } = await fetchJson(url, { headers: { ...DEFAULT_HEADERS, accept: "application/json", referer: `${FANQIE_BASE_URL}/rank` } });
    if (json?.code !== 0 || !Array.isArray(json?.data?.book_list)) {
      throw toolError("SOURCE_FORMAT_CHANGED", "番茄榜单数据格式已变化。", { sourceUrl: url.href });
    }
    const fontId = fontIdFromHeader(response.headers?.get?.("x-tt-zhal"));
    let mappingKnown = !!fontId && compiledFontMaps.has(fontId);
    let remainingPrivateUseChars = 0;
    const decode = (value) => {
      const result = decodeFanqieText(value, fontId);
      mappingKnown = mappingKnown && result.mappingKnown;
      remainingPrivateUseChars += result.remaining;
      return result.text;
    };
    const items = json.data.book_list.slice(0, limit).map((book, index) => ({
      rank: numberOrNull(book.currentPos) || index + 1,
      positionDeltaRaw: numberOrNull(book.rankPosDiff),
      bookId: clean(book.bookId),
      title: decode(book.bookName),
      author: decode(book.author),
      category: category.name,
      summary: decode(book.abstract),
      wordCount: numberOrNull(book.wordNumber),
      visibleReadCountRaw: numberOrNull(book.read_count ?? book.readCount),
      lastChapterTitle: decode(book.lastChapterTitle),
      lastUpdatedAt: isoFromSeconds(book.lastChapterUpdateTime),
      sourceUrl: `${FANQIE_BASE_URL}/page/${encodeURIComponent(clean(book.bookId))}`
    }));
    const warnings = [];
    if (!fontId) warnings.push("番茄本次响应没有提供字体映射标识；已保留原始可见字段。需浏览器核验书名、作者与简介。");
    else if (!mappingKnown) warnings.push(`番茄字体映射 ${fontId} 尚未收录；结果可能含私用区字符，需浏览器核验。`);
    if (remainingPrivateUseChars > 0) warnings.push(`仍有 ${remainingPrivateUseChars} 个混淆字符未还原，相关文字不能直接用于分析。`);
    if (items.length < limit) warnings.push(`公开接口只返回 ${items.length} 本，少于请求的 ${limit} 本。`);
    return {
      schemaVersion: 1,
      ok: true,
      platform: "fanqie",
      platformName: "番茄小说",
      channel: { id: channel.id, name: channel.name },
      rank: { id: rank.id, name: rank.name },
      category: { id: category.id, name: category.name },
      period: null,
      fetchedAt: now().toISOString(),
      sourceUrl: url.href,
      publicPageUrl: `${FANQIE_BASE_URL}/rank/${channel.gender}_${rank.rankMold}_${category.id}`,
      totalVisible: numberOrNull(json.data.total_num),
      textDecode: { fontId, mappingKnown, remainingPrivateUseChars },
      warnings,
      items
    };
  }

  function currentMonth() {
    const date = now();
    return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  function qidianUrl(rank, category, period) {
    const base = "https://m.qidian.com";
    const route = rank.route || rank.id;
    if (rank.id === "yuepiao") {
      return `${base}/rank/${route}/catid${category.id}/${period || currentMonth()}/`;
    }
    if (category.id === "-1") return `${base}/rank/${route}/`;
    const suffix = rank.categorySuffix ? `${rank.categorySuffix}/` : "";
    return `${base}/rank/${route}/catid${category.id}/${suffix}`;
  }

  function parseQidianItems(html, sourceUrl, limit) {
    const chunks = String(html || "").split(/<div class="y-list__item"[^>]*>/i).slice(1);
    const items = [];
    for (const chunk of chunks) {
      if (items.length >= limit) break;
      const href = chunk.match(/<a\b[^>]*href="([^"]*\/book\/([0-9]+)\/?)"[^>]*>/i);
      const title = chunk.match(/<h2\b[^>]*class="[^"]*_title_[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
      if (!href || !title) continue;
      const dataIndex = chunk.match(/data-index="(\d+)"/i);
      const rankText = chunk.match(/<div\b[^>]*class="[^"]*_ranking_[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const metric = chunk.match(/<div\b[^>]*class="[^"]*_bookTitleR_[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
      const summary = chunk.match(/<p\b[^>]*class="[^"]*_bookDesc_[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      const subtitle = chunk.match(/<p\b[^>]*class="[^"]*_subTitle_[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
      const parts = stripHtml(subtitle?.[1] || "").split(/\s*·\s*/).map(clean).filter(Boolean);
      items.push({
        rank: numberOrNull(stripHtml(rankText?.[1] || "")) || (dataIndex ? Number(dataIndex[1]) + 1 : items.length + 1),
        bookId: href[2],
        title: stripHtml(title[1]),
        author: parts[0] || "",
        category: parts[1] || "",
        wordCountText: parts[2] || "",
        visibleMetric: stripHtml(metric?.[1] || ""),
        summary: stripHtml(summary?.[1] || ""),
        sourceUrl: new URL(href[1], sourceUrl).href
      });
    }
    return items;
  }

  async function scanQidian(input) {
    const rank = resolveOption(input.rank, QIDIAN_RANKS, "起点榜单", "yuepiao");
    const channel = normalizeLookup(input.channel || "male");
    if (!["male", "男生", "男频"].includes(channel)) throw toolError("INVALID_ARGUMENT", "当前起点扫描器先支持男生频道；女生榜会单独适配，不能把男榜数据冒充女榜。" );
    const category = resolveOption(input.category, QIDIAN_CATEGORIES, "起点分类", "-1");
    const limit = Math.min(30, Math.max(1, Number(input.limit || 10)));
    const requestedPeriod = clean(input.period);
    if (requestedPeriod && !/^\d{6}$/.test(requestedPeriod)) throw toolError("INVALID_ARGUMENT", "起点月票榜 period 必须是 YYYYMM，例如 202607。" );
    const period = rank.period === "month" ? (requestedPeriod || currentMonth()) : null;
    const sourceUrl = qidianUrl(rank, category, period);
    const { text } = await fetchPublic(sourceUrl, { headers: MOBILE_HEADERS });
    const items = parseQidianItems(text, sourceUrl, limit);
    if (!items.length) {
      throw toolError("SOURCE_FORMAT_CHANGED", "起点公开移动榜单没有找到作品条目；页面结构可能已变化。", { sourceUrl });
    }
    const warnings = [];
    if (items.length < limit) warnings.push(`公开页面只展示 ${items.length} 本，少于请求的 ${limit} 本。`);
    if (requestedPeriod && !rank.period) warnings.push(`${rank.name}不使用月份筛选，已忽略 period。`);
    return {
      schemaVersion: 1,
      ok: true,
      platform: "qidian",
      platformName: "起点中文网",
      channel: { id: "male", name: "男生" },
      rank: { id: rank.id, name: rank.name },
      category: { id: category.id, name: category.name },
      period,
      fetchedAt: now().toISOString(),
      sourceUrl,
      publicPageUrl: `https://www.qidian.com/rank/${rank.id}/`,
      warnings,
      items
    };
  }

  async function scanRankings(input = {}) {
    const platform = normalizeLookup(input.platform);
    if (["fanqie", "番茄"].includes(platform)) return scanFanqie(input);
    if (["qidian", "起点"].includes(platform)) return scanQidian(input);
    throw toolError("INVALID_ARGUMENT", "platform 必须是 fanqie（番茄）或 qidian（起点）。");
  }

  function snapshotDir(projectDir) {
    return path.join(path.resolve(projectDir), "辅助文档", "市场与榜单");
  }

  function snapshotFileStem(snapshot) {
    const stamp = snapshot.fetchedAt.replace(/[:.]/g, "-");
    return [stamp, snapshot.platformName, snapshot.rank?.name, snapshot.category?.name].map((item) => safeSegment(item)).join("_");
  }

  function snapshotMarkdown(snapshot) {
    const lines = [
      `# 榜单快照：${snapshot.platformName} · ${snapshot.rank.name} · ${snapshot.category.name}`,
      "",
      `- 抓取时间：${snapshot.fetchedAt}`,
      `- 频道：${snapshot.channel.name}`,
      `- 来源：${snapshot.sourceUrl}`,
      ...(snapshot.period ? [`- 榜期：${snapshot.period}`] : []),
      ...(snapshot.warnings || []).map((warning) => `- 核验提示：${warning}`),
      "",
      "## 当次可见作品",
      ""
    ];
    for (const item of snapshot.items) {
      lines.push(`${item.rank}. 《${item.title}》 / ${item.author || "作者未显示"}`);
      const facts = [
        item.category ? `分类：${item.category}` : "",
        item.wordCountText ? `字数：${item.wordCountText}` : (item.wordCount != null ? `字数原值：${item.wordCount}` : ""),
        item.visibleMetric ? `页面可见数据：${item.visibleMetric}` : (item.visibleReadCountRaw != null ? `阅读数原值：${item.visibleReadCountRaw}` : ""),
        item.positionDeltaRaw != null ? `名次变化原值：${item.positionDeltaRaw}` : "",
        item.lastUpdatedAt ? `最近更新：${item.lastUpdatedAt}` : "",
        `作品页：${item.sourceUrl}`
      ].filter(Boolean);
      for (const fact of facts) lines.push(`   - ${fact}`);
      if (item.summary) lines.push(`   - 简介：${item.summary.replace(/\s+/g, " ").slice(0, 500)}`);
      lines.push("");
    }
    lines.push("## 使用边界", "", "这里只记录公开榜位和页面可见信息，不复制作品正文，不把一次榜单快照当作流行趋势结论。", "");
    return lines.join("\n");
  }

  async function saveSnapshot(projectDir, snapshot) {
    if (!clean(projectDir)) throw toolError("INVALID_ARGUMENT", "保存榜单快照需要 projectDir。" );
    const dir = snapshotDir(projectDir);
    await fsp.mkdir(dir, { recursive: true });
    const stem = snapshotFileStem(snapshot);
    let jsonPath = path.join(dir, `${stem}.json`);
    let markdownPath = path.join(dir, `${stem}.md`);
    for (let copy = 2; fs.existsSync(jsonPath) || fs.existsSync(markdownPath); copy += 1) {
      jsonPath = path.join(dir, `${stem}-${copy}.json`);
      markdownPath = path.join(dir, `${stem}-${copy}.md`);
    }
    await Promise.all([
      fsp.writeFile(jsonPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8"),
      fsp.writeFile(markdownPath, snapshotMarkdown(snapshot), "utf8")
    ]);
    return { jsonPath, markdownPath, relativeJsonPath: path.relative(path.resolve(projectDir), jsonPath), relativeMarkdownPath: path.relative(path.resolve(projectDir), markdownPath) };
  }

  function resolveSnapshotPath(projectDir, requested) {
    const dir = snapshotDir(projectDir);
    const resolved = path.resolve(dir, requested);
    const relative = path.relative(dir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw toolError("INVALID_ARGUMENT", "快照路径必须位于项目的 辅助文档/市场与榜单 目录内。" );
    return resolved;
  }

  async function readSnapshot(file) {
    let parsed;
    try { parsed = JSON.parse(await fsp.readFile(file, "utf8")); }
    catch { throw toolError("INVALID_ARGUMENT", `无法读取榜单快照：${path.basename(file)}`); }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.items)) throw toolError("INVALID_ARGUMENT", `不是可比较的榜单快照：${path.basename(file)}`);
    return parsed;
  }

  async function selectSnapshots(input) {
    const projectDir = clean(input.projectDir);
    if (!projectDir) throw toolError("INVALID_ARGUMENT", "projectDir is required." );
    if (input.snapshotA || input.snapshotB) {
      if (!input.snapshotA || !input.snapshotB) throw toolError("INVALID_ARGUMENT", "snapshotA 和 snapshotB 必须同时提供。" );
      return [resolveSnapshotPath(projectDir, input.snapshotA), resolveSnapshotPath(projectDir, input.snapshotB)];
    }
    const dir = snapshotDir(projectDir);
    if (!fs.existsSync(dir)) throw toolError("INVALID_ARGUMENT", "项目里还没有榜单快照。" );
    const candidates = [];
    for (const name of await fsp.readdir(dir)) {
      if (!name.toLowerCase().endsWith(".json") || name.startsWith("对比_")) continue;
      const file = path.join(dir, name);
      try {
        const snapshot = await readSnapshot(file);
        if (input.platform && normalizeLookup(snapshot.platform) !== normalizeLookup(input.platform)) continue;
        if (input.rank && normalizeLookup(snapshot.rank?.id) !== normalizeLookup(input.rank) && normalizeLookup(snapshot.rank?.name) !== normalizeLookup(input.rank)) continue;
        if (input.category && normalizeLookup(snapshot.category?.id) !== normalizeLookup(input.category) && normalizeLookup(snapshot.category?.name) !== normalizeLookup(input.category)) continue;
        candidates.push({ file, fetchedAt: Date.parse(snapshot.fetchedAt) || 0 });
      } catch (cause) {
        if (cause?.code !== "INVALID_ARGUMENT") throw cause;
      }
    }
    candidates.sort((a, b) => a.fetchedAt - b.fetchedAt || a.file.localeCompare(b.file));
    if (candidates.length < 2) throw toolError("INVALID_ARGUMENT", "符合条件的榜单快照不足两份。" );
    return candidates.slice(-2).map((item) => item.file);
  }

  async function compareSnapshots(input = {}) {
    const files = await selectSnapshots(input);
    const snapshots = await Promise.all(files.map(readSnapshot));
    const ordered = snapshots.map((snapshot, index) => ({ snapshot, file: files[index] }))
      .sort((a, b) => (Date.parse(a.snapshot.fetchedAt) || 0) - (Date.parse(b.snapshot.fetchedAt) || 0));
    const earlier = ordered[0];
    const later = ordered[1];
    const keyOf = (item) => clean(item.bookId) || `${clean(item.title)}\u0000${clean(item.author)}`;
    const before = new Map(earlier.snapshot.items.map((item) => [keyOf(item), item]));
    const after = new Map(later.snapshot.items.map((item) => [keyOf(item), item]));
    const climbed = [];
    const fell = [];
    const unchanged = [];
    const entered = [];
    const dropped = [];
    for (const [key, item] of after) {
      const previous = before.get(key);
      if (!previous) {
        entered.push(item);
        continue;
      }
      const movement = Number(previous.rank) - Number(item.rank);
      const record = { bookId: item.bookId, title: item.title, author: item.author, from: previous.rank, to: item.rank, movement };
      if (movement > 0) climbed.push(record);
      else if (movement < 0) fell.push(record);
      else unchanged.push(record);
    }
    for (const [key, item] of before) if (!after.has(key)) dropped.push(item);
    climbed.sort((a, b) => b.movement - a.movement);
    fell.sort((a, b) => a.movement - b.movement);
    const comparison = {
      ok: true,
      platform: later.snapshot.platform,
      rank: later.snapshot.rank,
      category: later.snapshot.category,
      earlier: { fetchedAt: earlier.snapshot.fetchedAt, path: earlier.file },
      later: { fetchedAt: later.snapshot.fetchedAt, path: later.file },
      climbed,
      fell,
      unchanged,
      entered,
      dropped,
      note: "名次变化只描述两次公开快照之间的差异，不等于长期趋势，也不预测题材成绩。"
    };
    if (input.save === true) {
      const dir = snapshotDir(input.projectDir);
      const file = path.join(dir, `对比_${safeSegment(earlier.snapshot.fetchedAt)}_${safeSegment(later.snapshot.fetchedAt)}.md`);
      const lines = [
        `# 榜单快照对比：${later.snapshot.platformName} · ${later.snapshot.rank.name} · ${later.snapshot.category.name}`,
        "",
        `- 较早快照：${earlier.snapshot.fetchedAt}`,
        `- 较晚快照：${later.snapshot.fetchedAt}`,
        `- 来源：${later.snapshot.sourceUrl}`,
        "",
        "## 上升",
        ...(climbed.length ? climbed.map((item) => `- 《${item.title}》：${item.from} → ${item.to}`) : ["- 无"]),
        "",
        "## 下降",
        ...(fell.length ? fell.map((item) => `- 《${item.title}》：${item.from} → ${item.to}`) : ["- 无"]),
        "",
        "## 新进入当前可见范围",
        ...(entered.length ? entered.map((item) => `- 《${item.title}》：第 ${item.rank} 位`) : ["- 无"]),
        "",
        "## 离开当前可见范围",
        ...(dropped.length ? dropped.map((item) => `- 《${item.title}》：此前第 ${item.rank} 位`) : ["- 无"]),
        "",
        comparison.note,
        ""
      ];
      await fsp.writeFile(file, lines.join("\n"), "utf8");
      comparison.savedPath = file;
    }
    return comparison;
  }

  return Object.freeze({ listSources, scanRankings, saveSnapshot, compareSnapshots });
}

module.exports = {
  FANQIE_RANKS,
  QIDIAN_RANKS,
  QIDIAN_CATEGORIES,
  createRankingService,
  decodeFanqieText,
  fontIdFromHeader
};
