"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

const FANQIE_PUA_BASE = 0xE3E8;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

let bundledCharset = [];
try {
  const parsed = require("./fanqie-charset.json");
  bundledCharset = Array.isArray(parsed?.[0]) ? parsed[0] : [];
} catch {
  bundledCharset = [];
}

function createError(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function isWithin(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isLoopbackHostname(hostname) {
  const value = String(hostname || "").toLowerCase();
  if (value === "localhost" || value === "::1" || value === "[::1]") return true;
  if (!/^127(?:\.\d{1,3}){3}$/u.test(value)) return false;
  return value.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function normalizeBaseUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || ""));
  } catch (error) {
    throw createError("PROVIDER_CONFIG_REQUIRED", "A valid downloader baseUrl is required.", error);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)
    || !isLoopbackHostname(parsed.hostname)
    || parsed.username
    || parsed.password) {
    throw createError("PROVIDER_NOT_LOOPBACK", "The authorized downloader must use a loopback HTTP service.");
  }
  if ((parsed.pathname && parsed.pathname !== "/") || parsed.search || parsed.hash) {
    throw createError("PROVIDER_BASE_URL_INVALID", "The downloader baseUrl must contain only its loopback origin.");
  }
  return parsed.origin;
}

function normalizeBookId(value) {
  const bookId = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(bookId)) {
    throw createError("INVALID_BOOK_ID", "The downloader returned an invalid book id.");
  }
  return bookId;
}

function safeName(value, fallback = "book") {
  let name = String(value || "")
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001F]/gu, "-")
    .replace(/\s+/gu, " ")
    .replace(/[. ]+$/gu, "")
    .trim()
    .slice(0, 72);
  if (!name) name = fallback;
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(name)) name = `_${name}`;
  return name;
}

function decodeHtmlEntities(value) {
  const named = new Map([
    ["nbsp", " "],
    ["amp", "&"],
    ["lt", "<"],
    ["gt", ">"],
    ["quot", "\""],
    ["apos", "'"],
    ["#39", "'"]
  ]);
  return String(value || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity) => {
    const key = entity.toLowerCase();
    if (named.has(key)) return named.get(key);
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function htmlChapterToText(html) {
  return decodeHtmlEntities(String(html || "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "")
    .replace(/<\s*br\s*\/?>/giu, "\n")
    .replace(/<\/(?:p|h[1-6]|div|li|blockquote)>/giu, "\n")
    .replace(/<[^>]+>/gu, ""))
    .replace(/\r\n?/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function decodeFanqieText(text, charset = bundledCharset) {
  const value = String(text || "");
  if (!Array.isArray(charset) || !charset.length) return value;
  let output = "";
  for (const character of value) {
    const code = character.codePointAt(0);
    if (code >= FANQIE_PUA_BASE && code < FANQIE_PUA_BASE + charset.length) {
      const decoded = charset[code - FANQIE_PUA_BASE];
      output += decoded && decoded !== "?" ? decoded : "〇";
    } else {
      output += character;
    }
  }
  return output;
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function readDownloadedBook(jsonlPath, title, charset) {
  let raw;
  try {
    raw = await fs.readFile(jsonlPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      throw createError("DOWNLOADED_BOOK_MISSING", "The provider job completed but its chapter file was not found.");
    }
    throw error;
  }

  const chapters = [];
  for (const line of raw.split(/\r?\n/gu)) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const body = decodeFanqieText(htmlChapterToText(record.content), charset);
    if (!body) continue;
    const chapterTitle = decodeFanqieText(String(record.title || "").trim(), charset)
      || `第 ${chapters.length + 1} 章`;
    chapters.push({ title: chapterTitle, body });
  }

  if (!chapters.length) {
    throw createError("DOWNLOADED_BOOK_EMPTY", "The provider chapter file did not contain readable chapters.");
  }
  const header = title ? `《${title}》\n\n` : "";
  const text = `${header}${chapters.map((chapter) => `${chapter.title}\n\n${chapter.body}`).join("\n\n\n")}\n`;
  return { text, chapters };
}

function createDownloadProvider({
  baseUrl,
  dataDir,
  fetchImpl = globalThis.fetch,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  sleepImpl = (delay) => new Promise((resolve) => setTimeout(resolve, delay)),
  charset = bundledCharset
} = {}) {
  const providerBaseUrl = normalizeBaseUrl(baseUrl);
  if (!dataDir) throw createError("PROVIDER_CONFIG_REQUIRED", "A downloader dataDir is required.");
  if (typeof fetchImpl !== "function") throw createError("PROVIDER_FETCH_REQUIRED", "A fetch implementation is required.");
  const resolvedDataDir = path.resolve(dataDir);
  const safePollIntervalMs = Math.max(0, Number(pollIntervalMs) || 0);
  const safeTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const safeRequestTimeoutMs = Math.max(1, Number(requestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS);

  async function requestJson(endpoint, options = {}) {
    const requestUrl = new URL(endpoint, providerBaseUrl).toString();
    let response;
    try {
      response = await fetchImpl(requestUrl, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(safeRequestTimeoutMs)
      });
    } catch (error) {
      throw createError("PROVIDER_REQUEST_FAILED", `The local downloader request failed: ${endpoint}`, error);
    }
    if (!response?.ok) {
      const details = response ? await response.text().catch(() => "") : "";
      throw createError(
        "PROVIDER_HTTP_ERROR",
        `The local downloader returned HTTP ${response?.status || "unknown"}: ${details.slice(0, 160)}`
      );
    }
    try {
      return await response.json();
    } catch (error) {
      throw createError("PROVIDER_RESPONSE_INVALID", "The local downloader returned invalid JSON.", error);
    }
  }

  async function resolveBook({ title, bookId }) {
    if (bookId) return { bookId: normalizeBookId(bookId), title: String(title || "").trim() };
    const wantedTitle = String(title || "").trim();
    if (!wantedTitle) {
      throw createError("DOWNLOAD_TITLE_OR_ID_REQUIRED", "A title or book id is required.");
    }
    const result = await requestJson(`/api/search?q=${encodeURIComponent(wantedTitle)}`);
    const items = Array.isArray(result?.items) ? result.items : [];
    if (!items.length) throw createError("BOOK_NOT_FOUND", `The downloader did not find ${wantedTitle}.`);
    const selected = items.find((item) => String(item.title || "").trim() === wantedTitle) || items[0];
    return {
      bookId: normalizeBookId(selected.book_id || selected.bookId),
      title: String(selected.title || wantedTitle).trim() || wantedTitle
    };
  }

  async function waitForJob(bookId, fallbackTitle) {
    const maxAttempts = Math.max(1, Math.ceil(safeTimeoutMs / Math.max(safePollIntervalMs, 50)));
    let finalTitle = fallbackTitle;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0 || safePollIntervalMs > 0) await sleepImpl(safePollIntervalMs);
      const result = await requestJson("/api/jobs");
      const jobs = Array.isArray(result?.items) ? result.items : [];
      const job = jobs.find((entry) => String(entry.book_id || entry.bookId || "") === bookId);
      if (!job) continue;
      finalTitle = String(job.title || finalTitle || "").trim();
      const state = String(job.state || "").toLowerCase();
      if (state === "done" || state === "completed") return { title: finalTitle };
      if (state === "failed") {
        throw createError("PROVIDER_JOB_FAILED", `The downloader job failed: ${String(job.message || "unknown error")}`);
      }
      if (state === "canceled" || state === "cancelled") {
        throw createError("PROVIDER_JOB_CANCELED", "The downloader job was canceled.");
      }
    }
    throw createError("PROVIDER_JOB_TIMEOUT", "The downloader job did not finish before its configured timeout.");
  }

  async function download({ projectPath, title, bookId, author = "", focus = "", authorized = false } = {}) {
    if (authorized !== true) {
      throw createError("SOURCE_NOT_AUTHORIZED", "The author must confirm authorization before downloading a book.");
    }
    if (!projectPath) throw createError("PROJECT_PATH_REQUIRED", "A project path is required.");

    const selected = await resolveBook({ title, bookId });
    await requestJson("/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book_id: selected.bookId })
    });
    const completed = await waitForJob(selected.bookId, selected.title || title);
    const finalTitle = completed.title || selected.title || String(title || "").trim() || selected.bookId;

    const chapterPath = path.resolve(resolvedDataDir, selected.bookId, "downloaded_chapters.jsonl");
    if (!isWithin(resolvedDataDir, chapterPath)) {
      throw createError("PROVIDER_DATA_PATH_ESCAPE", "The provider chapter path escaped its configured data directory.");
    }
    const book = await readDownloadedBook(chapterPath, finalTitle, charset);
    const contentsHash = sha256(book.text);
    const sourceId = `${safeName(finalTitle, "book")}-${selected.bookId}`.slice(0, 140);
    const sourceDirectory = path.join(
      path.resolve(projectPath),
      ".fiction-director",
      "sources",
      "books",
      sourceId
    );
    const sourcePath = path.join(sourceDirectory, "book.txt");
    const metadataPath = path.join(sourceDirectory, "source.json");
    await fs.mkdir(sourceDirectory, { recursive: true });
    await fs.writeFile(sourcePath, book.text, "utf8");

    const sourceRelativePath = path.relative(path.resolve(projectPath), sourcePath).split(path.sep).join("/");
    const metadataRelativePath = path.relative(path.resolve(projectPath), metadataPath).split(path.sep).join("/");
    const metadata = {
      version: 1,
      sourceId,
      type: "authorized-download",
      title: finalTitle,
      author: String(author || "").trim(),
      focus: String(focus || "").trim(),
      bookId: selected.bookId,
      authorized: true,
      provider: { baseUrl: providerBaseUrl },
      importedAt: new Date().toISOString(),
      chapterCount: book.chapters.length,
      charCount: book.text.length,
      sha256: contentsHash,
      sourceRelativePath
    };
    await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");

    return {
      ...metadata,
      relativePath: sourceRelativePath,
      metadataRelativePath
    };
  }

  return { download };
}

module.exports = {
  createDownloadProvider,
  decodeFanqieText,
  htmlChapterToText
};
