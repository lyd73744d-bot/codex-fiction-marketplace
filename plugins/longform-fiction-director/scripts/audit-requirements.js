"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..");

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}
function read(rel) {
  return fs.readFileSync(path.join(root, rel), "utf8");
}
function has(rel, re) {
  try { return re.test(read(rel)); } catch { return false; }
}

const checks = [
  {
    id: "install_login_popup",
    text: "安装后强制登录弹窗+小店；成功后不乱弹；掉线再提醒",
    ok: () => has("server/onboarding-state.js", /first_install_already_shown/) &&
      has("server/onboarding-state.js", /session_dropped/) &&
      has("server/gateway-login-console.js", /shop|小店|paymentPortalUrl/) &&
      exists("scripts/post-install-onboarding.js")
  },
  {
    id: "stream_txt_readable",
    text: "流式优先+重试+完整落盘txt；.body可再喂模型",
    ok: () => has("server/artifact-pipeline.js", /generateToArtifact/) &&
      has("server/artifact-pipeline.js", /\.body\./) &&
      has("server/openai-compatible-gateway.js", /stream/) &&
      has("server/openai-compatible-gateway.js", /non_stream_fallback|non-stream|postOnce\(false\)/)
  },
  {
    id: "local_without_pay",
    text: "不调用多模型也能写，效果较差",
    ok: () => has("server/fiction-mcp-tools.js", /fiction_write_local_candidate|write_local_candidate/) ||
      has("server/fiction-mcp-tools.js", /local_candidate|writeLocal/)
  },
  {
    id: "editor_coach",
    text: "引导编辑而非一键工厂",
    ok: () => has("server/first-run-coach-service.js", /责编|辅助/) &&
      has("skills/longform-fiction-director/SKILL.md", /责编|一步步/)
  },
  {
    id: "hidden_continuous",
    text: "黄金三章后可连续但需作者明确授权且不主推",
    ok: () => has("server/continuous-mode.js", /looksLikeExplicitEnable/) &&
      has("skills/longform-fiction-director/SKILL.md", /隐藏/)
  },
  {
    id: "brainstorm",
    text: "先脑洞",
    ok: () => exists("server/brainstorm-service.js") && has("server/fiction-mcp-tools.js", /fiction_get_brainstorm_coach|fiction_update_brainstorm/)
  },
  {
    id: "sample_book",
    text: "样书导入并学习手法",
    ok: () => exists("server/sample-book-service.js") && exists("server/sample-learn-service.js")
  },
  {
    id: "style_compare",
    text: "文风对比",
    ok: () => exists("server/style-compare-service.js") && has("server/fiction-mcp-tools.js", /fiction_compare_style/)
  },
  {
    id: "outline_golden",
    text: "大纲含黄金三章骨架",
    ok: () => has("server/outline-service.js", /黄金三章/) && exists("server/golden-three-service.js")
  },
  {
    id: "web_research_anti_ooc",
    text: "联网搜索建文档防OOC+人物卡",
    ok: () => exists("server/research-doc-service.js") &&
      exists("server/research-fill-service.js") &&
      exists("server/fact-library-service.js") &&
      has("skills/anti-ooc-research/SKILL.md", /联网|必须/)
  },
  {
    id: "draft_then_optimize",
    text: "先初稿再多模型优化",
    ok: () => has("server/fiction-mcp-tools.js", /fiction_generate_to_file/) &&
      has("server/fiction-mcp-tools.js", /fiction_optimize_with_models/) &&
      exists("server/multi-model-optimize.js")
  },
  {
    id: "humanizer_deslop",
    text: "去AI味 skills/方法齐全",
    ok: () => exists("skills/humanizer-zh/SKILL.md") &&
      exists("skills/deslop-dialogue/SKILL.md") &&
      exists("skills/deslop-narration/SKILL.md") &&
      has("server/fiction-mcp-tools.js", /fiction_list_deslop_methods/)
  },
  {
    id: "soft_ledgers",
    text: "软台账可用且少空模板",
    ok: () => exists("server/soft-chapter-ledger.js") && exists("server/fact-library-service.js")
  },
  {
    id: "plugin_skill_mcp",
    text: "整体插件 skill+MCP",
    ok: () => exists(".codex-plugin/plugin.json") && exists(".mcp.json") && exists("server/mcp-server.js")
  },
  {
    id: "model_router_quick_deep",
    text: "模型选型建议 quick/deep + fallbackChain",
    ok: () => has("server/model-router.js", /WRITING_MODE_PRESETS|normalizeMode/) &&
      has("server/fiction-mcp-tools.js", /mode=quick\|deep|mode: { type: "string"/)
  },
  {
    id: "live_gateway_e2e",
    text: "真网关多模型生成优化",
    ok: () => {
      // only true if session exists on machine
      const session = path.join(process.env.LOCALAPPDATA || "", "Zizhuji", "longform-fiction-director", "session.json");
      return fs.existsSync(session);
    },
    soft: true
  }
];

const results = checks.map((c) => {
  let pass = false;
  try { pass = !!c.ok(); } catch { pass = false; }
  return { id: c.id, text: c.text, pass, soft: !!c.soft };
});
const hardFail = results.filter((r) => !r.pass && !r.soft);
const softFail = results.filter((r) => !r.pass && r.soft);
console.log(JSON.stringify({
  version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version,
  hardPass: results.filter((r) => r.pass && !r.soft).length,
  hardTotal: results.filter((r) => !r.soft).length,
  softPass: results.filter((r) => r.pass && r.soft).length,
  softTotal: results.filter((r) => r.soft).length,
  results
}, null, 2));
if (hardFail.length) {
  console.error("HARD FAIL", hardFail.map((r) => r.id).join(", "));
  process.exit(1);
}
console.log("audit-requirements: PASS (hard requirements)");
if (softFail.length) console.log("SOFT PENDING", softFail.map((r) => r.id).join(", "));
