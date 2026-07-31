"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRankingService, decodeFanqieText } = require("../server/ranking-source-service");
const { createRankingMcpTools } = require("../server/ranking-mcp-tools");

const fixtureDir = path.join(__dirname, "fixtures");
const fanqieConfig = fs.readFileSync(path.join(fixtureDir, "fanqie-config.json"), "utf8");
const fanqieRank = fs.readFileSync(path.join(fixtureDir, "fanqie-rank.json"), "utf8");
const qidianRank = fs.readFileSync(path.join(fixtureDir, "qidian-rank.html"), "utf8");

async function mockFetch(url) {
  const value = String(url);
  if (value.includes("/api/config/list")) return new Response(fanqieConfig, { status: 200, headers: { "content-type": "application/json" } });
  if (value.includes("/api/rank/category/list")) return new Response(fanqieRank, { status: 200, headers: { "content-type": "application/json", "x-tt-zhal": "k=DNMrHsV173Pd4pgy;f=dc027189e0ba4cd;d1=example;d2=example" } });
  if (value.startsWith("https://m.qidian.com/rank/")) return new Response(qidianRank, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  throw new Error(`unexpected URL ${value}`);
}

function decode(reply) {
  return JSON.parse(reply.content[0].text);
}

async function main() {
  const service = createRankingService({ fetchImpl: mockFetch, now: () => new Date("2026-07-31T12:00:00.000Z") });
  const tools = createRankingMcpTools({ service });
  assert.deepStrictEqual(tools.list().map((tool) => tool.name), [
    "fiction_rank_sources",
    "fiction_scan_rankings",
    "fiction_compare_rank_snapshots"
  ]);

  const decoded = decodeFanqieText("云", "dc027189e0ba4cd");
  assert.strictEqual(decoded.text, "大明风云");
  assert.strictEqual(decoded.remaining, 0);
  const unknownFont = decodeFanqieText("", "unknown-font");
  assert.strictEqual(unknownFont.mappingKnown, false);
  assert.strictEqual(unknownFont.remaining, 1, "unknown Fanqie fonts must be reported, never silently accepted");

  const sources = decode(await tools.call("fiction_rank_sources", {}));
  assert.strictEqual(sources.sources.length, 2);
  assert.ok(sources.sources.find((source) => source.id === "fanqie").categories.some((item) => item.name === "历史古代"));

  const fanqie = decode(await tools.call("fiction_scan_rankings", { platform: "fanqie", rank: "new", channel: "male", category: "历史古代", limit: 2 }));
  assert.strictEqual(fanqie.items.length, 2);
  assert.strictEqual(fanqie.items[0].title, "科举：陛下！新科状元又惹事了！");
  assert.strictEqual(fanqie.items[0].author, "想飞的凌小白");
  assert.strictEqual(fanqie.textDecode.mappingKnown, true);
  assert.strictEqual(fanqie.textDecode.remainingPrivateUseChars, 0);

  const qidian = decode(await tools.call("fiction_scan_rankings", { platform: "qidian", rank: "yuepiao", category: "历史", limit: 2 }));
  assert.strictEqual(qidian.items.length, 2);
  assert.strictEqual(qidian.items[0].title, "玄鉴仙族");
  assert.strictEqual(qidian.items[0].author, "季越人");
  assert.strictEqual(qidian.items[0].visibleMetric, "14.54万月票");
  assert.strictEqual(qidian.period, "202607");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fiction-rankings-"));
  try {
    const earlier = { ...qidian, fetchedAt: "2026-07-30T12:00:00.000Z", items: qidian.items.map((item) => ({ ...item })) };
    const later = { ...qidian, fetchedAt: "2026-07-31T12:00:00.000Z", items: [
      { ...qidian.items[1], rank: 1 },
      { bookId: "999", title: "新进入作品", author: "测试作者", category: "历史", rank: 2, sourceUrl: "https://m.qidian.com/book/999/" }
    ] };
    const firstSave = await service.saveSnapshot(tempRoot, earlier);
    const secondSave = await service.saveSnapshot(tempRoot, later);
    assert.ok(fs.existsSync(firstSave.markdownPath));
    assert.ok(fs.existsSync(secondSave.jsonPath));
    const markdown = fs.readFileSync(firstSave.markdownPath, "utf8");
    assert.ok(markdown.includes("抓取时间"));
    assert.ok(markdown.includes("https://m.qidian.com"));
    assert.ok(!/^\|.+\|$/m.test(markdown), "ranking snapshot should remain readable prose, not a dense table");

    const comparison = await service.compareSnapshots({ projectDir: tempRoot, platform: "qidian", rank: "yuepiao", category: "历史", save: true });
    assert.strictEqual(comparison.climbed[0].title, "捞尸人");
    assert.strictEqual(comparison.entered[0].title, "新进入作品");
    assert.strictEqual(comparison.dropped[0].title, "玄鉴仙族");
    assert.ok(fs.existsSync(comparison.savedPath));
    const duplicateSave = await service.saveSnapshot(tempRoot, later);
    assert.notStrictEqual(duplicateSave.jsonPath, secondSave.jsonPath, "same-timestamp snapshots must not overwrite history");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("PASS selftest-rankings: public catalogs, Fanqie decoding, Qidian parsing, snapshots and comparison OK");
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  process.exit(1);
});
