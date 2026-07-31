"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLocalCoreTools } = require("../server/local-core-tools");

function decode(reply) {
  return JSON.parse(reply.content[0].text);
}

async function main() {
  const tools = createLocalCoreTools();
  const pluginRoot = path.resolve(__dirname, "..");
  assert.deepStrictEqual(tools.list().map((tool) => tool.name), [
    "fiction_project",
    "fiction_sample_book",
    "fiction_research",
    "fiction_facts",
    "fiction_voice_anchor"
  ]);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fiction-local-core-"));
  const projectDir = path.join(tempRoot, "novel");
  const samplePath = path.join(tempRoot, "sample.txt");
  fs.writeFileSync(samplePath, [
    "第一章",
    "他把已经凉透的茶盏推到窗边，听完院里那阵渐渐停下的脚步声，才问：\"你今晚到底去不去？\"",
    "对方没有回答，只把门推开了一条缝，冷风卷着檐下的雨丝落进来，也把桌角那张没写完的信吹翻了半页。",
    "院里的人还在说话，声音隔着雨幕听不清楚，他却没有再问，只伸手压住那张信，像是早已从沉默里得到了答案。",
    "",
    "第二章",
    "天亮以后，桌上的信已经不见了。"
  ].join("\n"), "utf8");

  try {
    const created = decode(await tools.call("fiction_project", { action: "create", projectDir, title: "测试小说" }));
    assert.strictEqual(created.ok, true);
    const outlinePath = path.join(projectDir, "辅助文档", "01_全书大纲.md");
    assert.ok(fs.existsSync(outlinePath));
    const outline = fs.readFileSync(outlinePath, "utf8");
    assert.ok(outline.includes("从头到尾讲清楚"));
    assert.ok(outline.includes("最后走到哪里"));
    assert.ok(!/^\|.+\|$/m.test(outline), "scaffolded outline should be prose, not a task table");

    const imported = decode(await tools.call("fiction_sample_book", { action: "import", projectDir, sourcePath: samplePath, title: "测试样书" }));
    assert.strictEqual(imported.ok, true);
    const learned = decode(await tools.call("fiction_sample_book", { action: "learn", projectDir, sampleName: "测试样书", currentBook: "历史小说", focus: "对话如何留白" }));
    assert.strictEqual(learned.ok, true);
    assert.deepStrictEqual(learned.adopted, []);
    assert.ok(fs.existsSync(learned.notesPath));
    assert.ok(fs.existsSync(learned.excerptPath));
    assert.ok(learned.excerptCount > 0);
    assert.ok(learned.excerpts.plot.length > 0);
    assert.ok(learned.excerpts.dialogue.length > 0);
    assert.ok(learned.excerpts.voice.length > 0);
    assert.ok(learned.excerpts.plot.every((item) => item.text.length >= 100 && item.text.includes("\n")));
    assert.ok(learned.excerpts.dialogue.every((item) => item.text.length >= 70 && item.text.includes("\n")));
    assert.ok(learned.excerpts.voice.every((item) => item.text.length >= 45));
    assert.ok(!fs.existsSync(path.join(projectDir, "辅助文档", "10_本书写作Skill.md")), "sample observations must not auto-write the project skill");
    const notes = fs.readFileSync(learned.notesPath, "utf8");
    assert.ok(notes.includes("本地观察，不自动采用"));
    assert.ok(notes.includes("对话如何留白"));
    const excerptNotes = fs.readFileSync(learned.excerptPath, "utf8");
    assert.ok(excerptNotes.includes("剧情片段"));
    assert.ok(excerptNotes.includes("对话片段"));
    assert.ok(excerptNotes.includes("文风片段"));
    assert.match(excerptNotes, /第 \d+(?:-\d+)? 行/);
    assert.ok(excerptNotes.includes("第 2-4 行"));
    assert.ok(excerptNotes.includes("\n> 对方没有回答"), "sample excerpts must preserve novel paragraph breaks");
    const relearned = decode(await tools.call("fiction_sample_book", { action: "learn", projectDir, sampleName: "测试样书" }));
    assert.strictEqual(relearned.filesRead, 1, "generated sample notes must never be relearned as source prose");
    assert.ok(Object.values(relearned.excerpts).flat().every((item) => item.file === "sample.txt"));

    decode(await tools.call("fiction_facts", { action: "upsert", projectDir, facts: ["主人公尚不知道信被谁拿走"], forbidden: ["不能让主人公提前知情"] }));
    const facts = decode(await tools.call("fiction_facts", { action: "read", projectDir }));
    assert.ok(facts.content.includes("主人公尚不知道信被谁拿走"));

    const research = decode(await tools.call("fiction_research", { action: "create_doc", projectDir, topic: "明末军制", genre: "历史" }));
    assert.strictEqual(research.ok, true);
    assert.ok(fs.existsSync(research.path));

    const character = decode(await tools.call("fiction_research", { action: "create_character", projectDir, name: "卢象升", kind: "historical", summary: "主角" }));
    assert.strictEqual(character.ok, true);

    const voice = decode(await tools.call("fiction_voice_anchor", { projectDir, narration: "叙述克制，不替人物说完", dialogue: "允许回避和半答" }));
    assert.strictEqual(voice.ok, true);
    assert.ok(fs.existsSync(voice.path));
    decode(await tools.call("fiction_voice_anchor", { projectDir, pacing: "长短段跟着人物注意力变化" }));
    const updatedVoice = fs.readFileSync(voice.path, "utf8");
    assert.ok(updatedVoice.includes("叙述克制，不替人物说完"), "partial voice-anchor updates must preserve narration");
    assert.ok(updatedVoice.includes("允许回避和半答"), "partial voice-anchor updates must preserve dialogue");
    assert.ok(updatedVoice.includes("长短段跟着人物注意力变化"));

    for (const bundled of [
      path.join(pluginRoot, "bin", "tomato-novel-downloader.exe"),
      path.join(pluginRoot, "bin", "tomato-novel-downloader-LICENSE"),
      path.join(pluginRoot, "server", "download-provider.js"),
      path.join(pluginRoot, "server", "managed-download-provider.js"),
      path.join(pluginRoot, "server", "fanqie-charset.json")
    ]) assert.ok(fs.existsSync(bundled), `bundled downloader component missing: ${bundled}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("PASS selftest-local-core: project, sample observations, research, facts and voice anchors OK");
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  process.exit(1);
});
