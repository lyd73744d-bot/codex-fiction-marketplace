"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

const editorIds = [
  "xuanhuan_power",
  "xianxia_cultivation",
  "wuxia_jianghu",
  "western_fantasy",
  "urban_hook",
  "career_reality",
  "historical_military",
  "suspense_mystery",
  "horror_weird",
  "scifi_apocalypse",
  "game_infinite",
  "sports_competition",
  "modern_romance",
  "ancient_romance",
  "palace_strategy",
  "era_farming",
  "youth_growth",
  "light_novel",
  "fanfiction_derivative"
];

const genres = read("skills/longform-fiction-director/references/genre-recipes.md");
const voice = read("skills/longform-fiction-director/references/editor-voice.md");
const skill = read("skills/longform-fiction-director/SKILL.md");
const beginner = read("skills/longform-fiction-director/references/beginner-coach.md");
const projectState = read("assets/workflow/project-template/辅助文档/00_使用说明与当前状态.md");
const manifest = JSON.parse(read(".codex-plugin/plugin.json"));

for (const id of editorIds) {
  const marker = `## ${id} · `;
  const start = genres.indexOf(marker);
  assert.ok(start >= 0, `missing editor profile: ${id}`);
  const next = genres.indexOf("\n## ", start + marker.length);
  const block = genres.slice(start, next >= 0 ? next : genres.length);
  for (const field of ["读者承诺：", "第一判断：", "开篇观察：", "长线发动机：", "常见误区：", "方向追问：", "具体肯定："]) {
    assert.ok(block.includes(field), `${id} missing field: ${field}`);
  }
  assert.ok((genres.match(new RegExp(`\\b${id}\\b`, "g")) || []).length >= 2, `${id} is not present in routing table`);
}

assert.ok(genres.includes("一次只启用一个主责编"), "single-primary-editor rule missing");
assert.ok(genres.includes("辅助标签不是第二位说话的责编"), "secondary-tag rule missing");
assert.ok(skill.includes("references/genre-recipes.md"), "main skill does not load genre editors");
assert.ok(skill.includes("references/editor-voice.md"), "main skill does not load editor voice rules");
assert.ok(beginner.includes("自动判断主类型并接入对应题材责编"), "new-user auto-routing rule missing");
assert.ok(beginner.includes("不让作者从完整名单里选"), "new users must not receive a genre menu");
for (const field of ["主类型：", "题材责编：", "辅助标签：", "读者持续追更是为了："]) {
  assert.ok(projectState.includes(field), `project state missing field: ${field}`);
}
assert.ok(voice.includes("温和对待作者，严格对待作品"), "editor stance missing");
assert.ok(voice.includes("不提前庆祝尚未完成的结果"), "anti-hype rule missing");
assert.ok(voice.includes("一次回复最多一句肯定"), "praise limit missing");
assert.ok(!genres.includes("开篇门槛："), "genre editors still force a single opening gate");
assert.ok(!/尽快|尽早|立刻|迫近压力/u.test(genres), "genre opening advice still forces urgency");
assert.ok(manifest.interface.capabilities.includes("19 genre-specific editor profiles"), "manifest capability missing");

console.log(`PASS selftest-editor-profiles: ${editorIds.length} differentiated editors OK`);
