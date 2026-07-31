"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createDownloadProvider, htmlChapterToText, sortChaptersByTitleOrdinal } = require("../server/download-provider");
const { createDownloadMcpTools } = require("../server/download-mcp-tools");

function decode(reply) {
  return JSON.parse(reply.content[0].text);
}

async function main() {
  const outOfOrder = [17, 18, 1, 2].map((number) => ({
    title: `\u7b2c${number}\u7ae0 test-${number}`,
    body: String(number)
  }));
  assert.deepStrictEqual(
    sortChaptersByTitleOrdinal(outOfOrder).map((chapter) => chapter.body),
    ["1", "2", "17", "18"],
    "downloaded chapters must be sorted by an unambiguous title ordinal"
  );
  const mixedTitles = [{ title: "preface", body: "p" }, ...outOfOrder];
  assert.strictEqual(
    sortChaptersByTitleOrdinal(mixedTitles)[0].body,
    "p",
    "unrecognized chapter titles must preserve provider order"
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fiction-download-"));
  const projectDir = path.join(tempRoot, "novel");
  const dataDir = path.join(tempRoot, "provider-data");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, "book-1"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "book-1", "downloaded_chapters.jsonl"), [
    JSON.stringify({ title: "第一章 雨夜", content: "<p>门外有人敲了三下。</p><p>他没有应声，只把灯拨暗。</p>" }),
    JSON.stringify({ title: "第二章 来客", content: "<p>雨停以后，台阶上多了一双泥脚印。</p>" })
  ].join("\n") + "\n", "utf8");

  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || "GET" });
    if (String(url).includes("/api/search")) {
      return new Response(JSON.stringify({ items: [{ book_id: "book-1", title: "测试样书" }] }), { status: 200 });
    }
    if (String(url).endsWith("/api/jobs") && options.method === "POST") {
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (String(url).endsWith("/api/jobs")) {
      return new Response(JSON.stringify({ items: [{ book_id: "book-1", title: "测试样书", state: "done" }] }), { status: 200 });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const provider = createDownloadProvider({
    baseUrl: "http://127.0.0.1:18888",
    dataDir,
    fetchImpl,
    pollIntervalMs: 0,
    timeoutMs: 1000,
    charset: []
  });
  const tools = createDownloadMcpTools({ provider });

  try {
    const searched = await provider.search("测试样书");
    assert.deepStrictEqual(searched, [{ bookId: "book-1", title: "测试样书", author: "" }]);
    assert.deepStrictEqual(tools.list().map((tool) => tool.name), ["fiction_download_book"]);
    await assert.rejects(
      () => tools.call("fiction_download_book", { projectDir, title: "测试样书", authorized: false }),
      (error) => error.code === "SOURCE_NOT_AUTHORIZED"
    );
    assert.strictEqual(requests.length, 1, "authorization failure must not add another downloader request");

    const downloaded = decode(await tools.call("fiction_download_book", {
      projectDir,
      title: "测试样书",
      author: "测试作者",
      focus: "对话与节奏",
      authorized: true
    }));
    assert.strictEqual(downloaded.ok, true);
    assert.strictEqual(downloaded.source.bookId, "book-1");
    assert.strictEqual(downloaded.source.chapterCount, 2);
    assert.ok(fs.existsSync(path.join(projectDir, downloaded.source.relativePath)));
    assert.ok(fs.existsSync(path.join(projectDir, downloaded.source.metadataRelativePath)));
    assert.ok(fs.existsSync(path.join(projectDir, downloaded.sample.relativeDir, "book.txt")));
    assert.ok(fs.readFileSync(path.join(projectDir, downloaded.sample.relativeDir, "book.txt"), "utf8").includes("门外有人敲了三下"));
    assert.strictEqual(htmlChapterToText("<p>甲<br>乙</p>"), "甲\n乙");
  } finally {
    await tools.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("PASS selftest-download: authorization, local provider, source record and sample import OK");
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  process.exit(1);
});
