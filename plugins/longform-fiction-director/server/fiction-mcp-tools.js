"use strict";

const { scaffoldBookFolder, describeBuiltinWorkflow } = require("./workflow-scaffold");
const { ensureBookWorkspace, confirmChapterToLedgers, describeOrganizedWorkflow } = require("./ledger-organizer");

const { listInkOsCapabilities } = require("./inkos-capability-catalog");
const { recommendModels, listTaskCatalog } = require("./model-router");
const { writeArtifact, readArtifact, listArtifacts, generateToArtifact } = require("./artifact-pipeline");
const { importSampleBook, listSampleBooks, readSampleNotes } = require("./sample-book-service");
const { createResearchDoc, createCharacterCard, listCharacterCards } = require("./research-doc-service");
const { ensureFactLibrary, readFactLibrary, upsertFacts } = require("./fact-library-service");
const { upsertSoftChapterLedger, checkChapterContinuity } = require("./soft-chapter-ledger");
const { buildDraftPacket } = require("./draft-coach-service");
const { getFirstRunCoach } = require("./first-run-coach-service");
const { listMethodCatalog } = require("./method-catalog");
const { smokeLiveGateway } = require("./live-gateway-smoke");
const { readContinuousMode, setGoldenThreeReady, enableContinuousMode, disableContinuousMode } = require("./continuous-mode");
const { getGuidedStatus, advanceGuidedStage, saveGuidedAnswers, ensureSoftLedgers } = require("./guided-stage-service");
const { compareStyle } = require("./style-compare-service");
const { optimizeWithModels } = require("./multi-model-optimize");
const { markGoldenChapter, getGoldenThreeStatus, getChapterCoach } = require("./golden-three-service");
const { learnSampleTechniques, deepLearnSampleTechniques, ensureProjectWritingSkill } = require("./sample-learn-service");
const { ensureBrainstormBoard, updateBrainstormBoard, getBrainstormCoach } = require("./brainstorm-service");
const { appendResearchFindings } = require("./research-fill-service");
const { planResearch } = require("./research-plan-service");
const { getProductGuide } = require("./product-guide");
const { getWorkflowSnapshot } = require("./workflow-snapshot-service");
const { createOutlineScaffold } = require("./outline-service");
const { createChapterBrief } = require("./chapter-brief-service");
const { assessPipeline } = require("./pipeline-coach-service");
const { bootstrapProject } = require("./project-bootstrap");
const { upsertVoiceAnchor } = require("./voice-anchor-service");
const { planNextContinuousChapter } = require("./continuous-runner");

const MAX_OUTPUT_DEPTH = 32;
const MAX_OUTPUT_NODES = 10_000;
// Canonical prose is artifact-first. Do not silently truncate MCP payloads before the host applies its own limit.
const MAX_OUTPUT_CHARACTERS = Number.POSITIVE_INFINITY;
const SENSITIVE_KEY_PARTS = [
  "key", "token", "password", "secret", "authorization", "rechargecode",
  "credential", "cookie", "session", "bearer"
];

function normalizedKey(key) { return String(key).toLowerCase().replace(/[^a-z0-9]/g, ""); }
function isSensitiveKey(key) {
  const normalized = normalizedKey(key);
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}
function sanitizeOutput(value, state = { characters: 0, nodes: 0, seen: new WeakSet() }, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    state.characters += value.length;
    return value;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return String(value);
  if (typeof value !== "object") return null;
  if (depth >= MAX_OUTPUT_DEPTH || state.nodes >= MAX_OUTPUT_NODES || state.characters >= MAX_OUTPUT_CHARACTERS) return "[truncated]";
  if (state.seen.has(value)) return "[circular]";
  state.seen.add(value);
  state.nodes += 1;
  if (Array.isArray(value)) return value.slice(0, MAX_OUTPUT_NODES).map((item) => sanitizeOutput(item, state, depth + 1));
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) continue;
    result[key] = sanitizeOutput(item, state, depth + 1);
  }
  return result;
}
function toolResult(value) { return { content: [{ type: "text", text: JSON.stringify(sanitizeOutput(value), null, 2) }] }; }
function required(value, name) {
  if (typeof value !== "string" || !value.trim()) { const error = new Error(`${name} is required.`); error.code = "INVALID_ARGUMENT"; throw error; }
  return value.trim();
}
function safetyAnnotations(readOnlyHint) {
  return { readOnlyHint, openWorldHint: false, destructiveHint: false };
}

function createFictionMcpTools({ director, gateway, ainovel, openWorkbench, gatewayGuard, openLoginPage } = {}) {
  if (!director || typeof director.run !== "function") throw new TypeError("director with run is required");
  if (typeof openWorkbench !== "function") throw new TypeError("openWorkbench is required");
  async function requireGateway(reason = "tool_call") {
    if (!gatewayGuard || typeof gatewayGuard.ensureAccess !== "function") return { ok: true, loggedIn: true, skipped: true };
    return gatewayGuard.ensureAccess({ reason });
  }
  async function requireGatewayOrThrow(reason = "model_call") {
    const access = await requireGateway(reason);
    if (access.loggedIn) return access;
    const error = new Error(access.message || "Please log in first.");
    error.code = "AUTH_REQUIRED";
    error.access = access;
    throw error;
  }
  const definitions = [
    { name: "fiction_open_workbench", description: "Legacy compatibility only. Chat-first mode: do not open a browser UI; return chat-first guidance instead of a workbench page.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_first_run_coach", description: "First-run / anytime auxiliary coach: login rules, full writing ladder, next question/tools, deslop methods, continuous hidden note.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_list_deslop_methods", description: "List humanizer/deslop/style/anti-OOC method skills and which optimize focus to use.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_workflow_snapshot", description: "One-call coach snapshot: login/onboarding, guided stage, pipeline blockers, samples, artifacts, golden-three/continuous (hidden).", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: { projectDir: { type: "string", maxLength: 512 }, includeGuide: { type: "boolean" } } } },
    { name: "fiction_list_capabilities", description: "List retained InkOS long-form capabilities and their task routes.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_list_models", description: "List models available to the logged-in account and its public balance status.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_recommend_models", description: "Auxiliary coach: recommend models for a writing task. Supports mode=quick|deep. Returns fallbackChain for generate_to_file.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: { task: { type: "string", maxLength: 64 }, mode: { type: "string", maxLength: 16 }, maxPerRole: { type: "number" }, authorPrefer: { type: "array", items: { type: "string" }, maxItems: 8 } } } },
    { name: "fiction_list_model_tasks", description: "List task types supported by the auxiliary model router.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_write_artifact", description: "Write candidate text to project Codex候选 as txt (author confirmation still required before ledger settle).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "content"], properties: { projectDir: { type: "string", maxLength: 512 }, content: { type: "string", maxLength: 400000 }, kind: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, modelId: { type: "string", maxLength: 128 }, ext: { type: "string", maxLength: 8 } } } },
    { name: "fiction_read_artifact", description: "Read a candidate artifact txt/md written by the plugin.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", maxLength: 1024 }, maxChars: { type: "number" } } } },
    { name: "fiction_list_artifacts", description: "List candidate artifacts under project Codex候选.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, limit: { type: "number" } } } },
    { name: "fiction_import_sample_book", description: "Import a sample book file/folder into project 样书/ for technique learning (no plagiarism).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "sourcePath"], properties: { projectDir: { type: "string", maxLength: 512 }, sourcePath: { type: "string", maxLength: 1024 }, title: { type: "string", maxLength: 120 } } } },
    { name: "fiction_list_sample_books", description: "List imported sample books under project 样书/.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_read_sample_notes", description: "Read sample-book technique notes.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, sampleName: { type: "string", maxLength: 120 } } } },
    { name: "fiction_plan_research", description: "Plan anti-OOC web research: search queries, risks, checklist; optionally create research doc scaffold.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "topic"], properties: { projectDir: { type: "string", maxLength: 512 }, topic: { type: "string", maxLength: 120 }, genre: { type: "string", maxLength: 64 }, names: { type: "array", items: { type: "string" }, maxItems: 12 }, storyRole: { type: "string", maxLength: 200 }, notes: { type: "string", maxLength: 2000 }, createDoc: { type: "boolean" } } } },
    { name: "fiction_create_research_doc", description: "Create anti-OOC web-research doc scaffold under 辅助文档/联网核验 (must fill via real web search).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "topic"], properties: { projectDir: { type: "string", maxLength: 512 }, topic: { type: "string", maxLength: 120 }, genre: { type: "string", maxLength: 64 }, notes: { type: "string", maxLength: 4000 } } } },
    { name: "fiction_create_character_card", description: "Create a character card under 辅助文档/人物卡.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "name"], properties: { projectDir: { type: "string", maxLength: 512 }, name: { type: "string", maxLength: 80 }, kind: { type: "string", maxLength: 32 }, summary: { type: "string", maxLength: 500 } } } },
    { name: "fiction_list_character_cards", description: "List character cards.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_plan_next_chapter", description: "Prepare next chapter control card only if continuous mode already authorized.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, chapterNo: { type: "string", maxLength: 8 }, title: { type: "string", maxLength: 120 }, conflict: { type: "string", maxLength: 1000 }, hook: { type: "string", maxLength: 500 } } } },
    { name: "fiction_get_continuous_mode", description: "Read continuous-generation switch state (default off; author authorization required).", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_mark_golden_three_ready", description: "Mark golden-three chapters ready. Does NOT enable continuous mode.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, ready: { type: "boolean" } } } },
    { name: "fiction_enable_continuous_mode", description: "Enable continuous generation ONLY with explicit author authorization phrase after golden-three ready.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "authorPhrase"], properties: { projectDir: { type: "string", maxLength: 512 }, authorPhrase: { type: "string", maxLength: 300 } } } },
    { name: "fiction_disable_continuous_mode", description: "Disable continuous generation and return to guided writing.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_create_outline", description: "Create a non-formulaic outline scaffold from brainstorm + sample notes.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, hook: { type: "string", maxLength: 300 }, coreConflict: { type: "string", maxLength: 500 }, heroWant: { type: "string", maxLength: 500 }, pressurePlan: { type: "string", maxLength: 2000 }, midTwist: { type: "string", maxLength: 1000 }, notNow: { type: "string", maxLength: 1000 }, overwrite: { type: "boolean" } } } },
    { name: "fiction_create_chapter_brief", description: "Create chapter control card (conflict/beats/hook) before drafting.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, chapterNo: { type: "string", maxLength: 8 }, title: { type: "string", maxLength: 120 }, conflict: { type: "string", maxLength: 1000 }, beats: { type: "string", maxLength: 2000 }, hook: { type: "string", maxLength: 500 }, pov: { type: "string", maxLength: 120 }, mustInclude: { type: "string", maxLength: 1000 }, mustAvoid: { type: "string", maxLength: 1000 } } } },
    { name: "fiction_assess_pipeline", description: "Coach check: what is ready/missing before drafting; never auto-write.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_bootstrap_project", description: "Initialize guided project soft ledgers, brainstorm board, writing skill.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, title: { type: "string", maxLength: 120 } } } },
    { name: "fiction_deep_learn_sample", description: "Local sample learn + optional model deep extraction to transferable rules (saved to notes/txt).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, sampleName: { type: "string", maxLength: 120 }, modelIds: { type: "array", items: { type: "string" }, maxItems: 4 } } } },
    { name: "fiction_learn_sample_techniques", description: "Locally extract transferable techniques from imported sample book into notes + project writing skill.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, sampleName: { type: "string", maxLength: 120 }, maxChapters: { type: "number" } } } },
    { name: "fiction_ensure_writing_skill", description: "Ensure project 辅助文档/10_本书写作Skill.md exists (zizhuji-style current-book skill).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, currentBook: { type: "string", maxLength: 900 }, authorRules: { type: "string", maxLength: 900 } } } },
    { name: "fiction_get_brainstorm_coach", description: "Get brainstorm board path and next 1-3 coach questions.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_update_brainstorm", description: "Update brainstorm board fields after author answers.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, hook: { type: "string", maxLength: 500 }, desire: { type: "string", maxLength: 500 }, obstacle: { type: "string", maxLength: 500 }, hookWhy: { type: "string", maxLength: 500 }, later: { type: "string", maxLength: 1000 }, questions: { type: "string", maxLength: 1000 } } } },
    { name: "fiction_ensure_fact_library", description: "Ensure anti-OOC fact library exists under 辅助文档/12_事实库_防OOC.md.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_read_fact_library", description: "Read project anti-OOC fact library.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_upsert_facts", description: "Upsert hard facts / forbidden / sources into fact library (anti-OOC).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, facts: { type: "array", items: { type: "string" }, maxItems: 40 }, forbidden: { type: "array", items: { type: "string" }, maxItems: 40 }, fictionBounds: { type: "array", items: { type: "string" }, maxItems: 20 }, pending: { type: "array", items: { type: "string" }, maxItems: 20 }, sources: { type: "array", items: { type: "string" }, maxItems: 20 }, note: { type: "string", maxLength: 2000 } } } },
    { name: "fiction_upsert_soft_chapter_ledger", description: "Write/update soft chapter ledger card before formal confirmation.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "chapterNo"], properties: { projectDir: { type: "string", maxLength: 512 }, chapterNo: { type: "string", maxLength: 16 }, title: { type: "string", maxLength: 120 }, summary: { type: "string", maxLength: 2000 }, timePlace: { type: "string", maxLength: 500 }, characters: { type: "string", maxLength: 2000 }, changes: { type: "string", maxLength: 2000 }, relations: { type: "string", maxLength: 2000 }, foreshadow: { type: "string", maxLength: 1000 }, payoff: { type: "string", maxLength: 1000 }, hook: { type: "string", maxLength: 1000 }, candidatePath: { type: "string", maxLength: 512 } } } },
    { name: "fiction_check_continuity", description: "Check soft continuity readiness for a chapter (ledger/facts/timeline hints).", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "chapterNo"], properties: { projectDir: { type: "string", maxLength: 512 }, chapterNo: { type: "string", maxLength: 16 } } } },
    { name: "fiction_append_research_findings", description: "Append real web-research findings into anti-OOC research doc after browser search.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "topic"], properties: { projectDir: { type: "string", maxLength: 512 }, topic: { type: "string", maxLength: 120 }, sources: { type: "array", items: { type: "string" }, maxItems: 20 }, facts: { type: "array", items: { type: "string" }, maxItems: 40 }, forbidden: { type: "array", items: { type: "string" }, maxItems: 40 }, notes: { type: "string", maxLength: 4000 } } } },
    { name: "fiction_get_guided_status", description: "Get current guided-editor stage and what to ask next.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_advance_guided_stage", description: "Advance guided writing stage after author answers.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, toStage: { type: "string", maxLength: 64 }, note: { type: "string", maxLength: 500 }, answers: { type: "object" } } } },
    { name: "fiction_save_guided_answers", description: "Save answers for current/selected guided stage.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "answers"], properties: { projectDir: { type: "string", maxLength: 512 }, stageId: { type: "string", maxLength: 64 }, answers: { type: "object" } } } },
    { name: "fiction_ensure_soft_ledgers", description: "Ensure soft non-formulaic ledgers (文风锚点/脑洞板/人物卡/联网核验).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_upsert_voice_anchor", description: "Create/update non-formulaic voice anchors for style comparison.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, narration: { type: "string", maxLength: 2000 }, dialogue: { type: "string", maxLength: 2000 }, pacing: { type: "string", maxLength: 2000 }, fromSample: { type: "string", maxLength: 2000 }, forbid: { type: "string", maxLength: 2000 }, author: { type: "string", maxLength: 2000 } } } },
    { name: "fiction_compare_style", description: "Compare draft against voice anchors and sample-book notes; write report artifact.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, draftText: { type: "string", maxLength: 400000 }, draftPath: { type: "string", maxLength: 1024 }, title: { type: "string", maxLength: 120 } } } },
    { name: "fiction_optimize_with_models", description: "Sequential multi-model polish/humanize/review; each full result saved to Codex候选 txt for model/human reread.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "draftText"], properties: { projectDir: { type: "string", maxLength: 512 }, draftText: { type: "string", maxLength: 400000 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, modelIds: { type: "array", items: { type: "string" }, maxItems: 8 }, mode: { type: "string", maxLength: 32 }, focus: { type: "string", maxLength: 32 }, instruction: { type: "string", maxLength: 4000 }, autoRecommend: { type: "boolean" } } } },
    { name: "fiction_chapter_coach", description: "Golden-three / long-run chapter coach from 字字珠玑: stage goal, required state change, handoff, engine loop. Guidance only.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["chapterNo"], properties: { chapterNo: { type: "string", maxLength: 16 }, engineName: { type: "string", maxLength: 32 } } } },
    { name: "fiction_get_golden_three", description: "Get golden-three chapter readiness status.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 } } } },
    { name: "fiction_mark_golden_chapter", description: "Mark golden-three chapter 1/2/3 ready or not.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "chapterNo"], properties: { projectDir: { type: "string", maxLength: 512 }, chapterNo: { type: "string", maxLength: 8 }, ready: { type: "boolean" }, note: { type: "string", maxLength: 500 }, path: { type: "string", maxLength: 1024 } } } },
    { name: "fiction_smoke_live_gateway", description: "After login: list models → stream/txt generate → optional optimize → prove .body.txt is model-readable. Fails clearly if not logged in.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, properties: { projectDir: { type: "string", maxLength: 512 }, title: { type: "string", maxLength: 80 } } } },
    { name: "fiction_open_gateway_login", description: "Force-open gateway login page (with shop link). Use after install or when session drops. Credentials stay in local page, not MCP.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_account_status", description: "Read gateway login/account status without spamming login popup.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_write_local_candidate", description: "Save author/Codex-written prose to Codex候选 txt without gateway (for unpaid/local path). Model optimize still needs login.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "content"], properties: { projectDir: { type: "string", maxLength: 512 }, content: { type: "string", maxLength: 400000 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, kind: { type: "string", maxLength: 40 } } } },
    { name: "fiction_ensure_gateway", description: "Check gateway login. Popup only on first install or session drop; never spam if already logged in.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, properties: { force: { type: "boolean" } } } },
    { name: "fiction_build_draft_packet", description: "Guided draft coach: assemble system+prompt from brief/voice/facts/cards/sample/golden-three; recommend models; no gateway call. Then use fiction_generate_to_file or local candidate.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir"], properties: { projectDir: { type: "string", maxLength: 512 }, chapterNo: { type: "string", maxLength: 16 }, title: { type: "string", maxLength: 120 }, instruction: { type: "string", maxLength: 4000 }, engineName: { type: "string", maxLength: 32 }, minChars: { type: "number" }, maxChars: { type: "number" }, saveArtifact: { type: "boolean" } } } },
    { name: "fiction_generate_to_file", description: "Stream-first model call with retries + non-stream fallback + multi-model fallback chain; always write complete output to Codex候选 txt (+ .body plain). Prefer this when chat streaming is unreliable.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "prompt", "modelIds"], properties: { projectDir: { type: "string", maxLength: 512 }, prompt: { type: "string", maxLength: 200000 }, system: { type: "string", maxLength: 100000 }, modelIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 }, kind: { type: "string", maxLength: 64 }, title: { type: "string", maxLength: 120 }, chapterNo: { type: "string", maxLength: 32 }, taskLabel: { type: "string", maxLength: 64 }, previewChars: { type: "number" }, fallbackChain: { type: "boolean" }, minChars: { type: "number" }, applyHardGates: { type: "boolean" }, authorOverride: { type: "boolean" }, maxTokens: { type: "number", minimum: 256, maximum: 65536 } } } },
    { name: "fiction_list_projects", description: "List local long-form fiction projects, newest first.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_create_project", description: "Create a local long-form fiction project with built-in Chinese workflow folders (辅助文档/细纲/正文).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["title"], properties: { title: { type: "string", maxLength: 120 }, direction: { type: "string", maxLength: 1200 } } } },
    { name: "fiction_scaffold_book_folder", description: "Scaffold the built-in Chinese book workflow template into an existing folder (辅助文档/细纲/正文/候选/审稿).", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["targetDir"], properties: { targetDir: { type: "string", maxLength: 512 }, title: { type: "string", maxLength: 120 }, overwrite: { type: "boolean" } } } },
    { name: "fiction_describe_builtin_workflow", description: "Describe the plugin's built-in writing workflow assets and default ladder steps.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_ensure_book_workspace", description: "Ensure a book folder has organized Chinese ledgers (辅助文档/细纲/正文/候选/审稿/项目地图). No external workflow needed.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["targetDir"], properties: { targetDir: { type: "string", maxLength: 512 }, title: { type: "string", maxLength: 120 }, overwrite: { type: "boolean" } } } },
    { name: "fiction_confirm_chapter_ledgers", description: "After author confirmation, write formal chapter prose and auto-update status/character/timeline/foreshadow ledgers.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectDir", "prose", "authorConfirmed"], properties: { projectDir: { type: "string", maxLength: 512 }, prose: { type: "string", maxLength: 200000 }, authorConfirmed: { type: "boolean" }, title: { type: "string", maxLength: 120 }, chapterId: { type: "string", maxLength: 80 }, chapterNo: { type: "string", maxLength: 40 }, bookTitle: { type: "string", maxLength: 120 }, summary: { type: "string", maxLength: 2000 }, nextHook: { type: "string", maxLength: 1000 }, characterChanges: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } }, timeline: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } }, foreshadow: { type: "array", maxItems: 20, items: { type: "string", maxLength: 300 } }, saveCandidateSnapshot: { type: "boolean" } } } },
    { name: "fiction_get_project_state", description: "Read a project's direction, confirmed ledger, source counts, and active learning state.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" } } } },
    { name: "fiction_list_sources", description: "List registered authorized book sources without returning book prose.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" } } } },
    { name: "fiction_list_tasks", description: "List persisted tasks for one fiction project, newest first.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" } } } },
    { name: "fiction_get_task", description: "Read one persisted fiction task and its bounded event history.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string" } } } },
    { name: "fiction_pause_task", description: "Pause a non-terminal fiction task.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string" } } } },
    { name: "fiction_resume_task", description: "Return a paused fiction task to the queued state.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["taskId"], properties: { taskId: { type: "string" } } } },
    { name: "fiction_ainovel_status", description: "Read the managed ainovel-cli state, bounded logs, and generated chapter metadata for a project.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" } } } },
    { name: "fiction_ainovel_start", description: "Start ainovel-cli for a project through the logged-in account model gateway.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "prompt", "modelIds"], properties: { projectId: { type: "string" }, prompt: { type: "string", maxLength: 20000 }, modelIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } } } } },
    { name: "fiction_ainovel_pause", description: "Pause the managed ainovel-cli process while preserving its checkpoint.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" } } } },
    { name: "fiction_ainovel_resume", description: "Resume ainovel-cli from the project's saved checkpoint.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" }, modelIds: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } } } } },
    { name: "fiction_run", description: "Run a long-form fiction task for a project.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "kind", "instruction"], properties: { projectId: { type: "string" }, kind: { type: "string" }, specialistId: { type: "string" }, instruction: { type: "string" }, modelIds: { type: "array", items: { type: "string" } }, source: { type: "string" }, rankUrl: { type: "string" }, confirm: { type: "boolean" }, authorAccepted: { type: "boolean" }, confirmedProse: { type: "string" }, prose: { type: "string" }, ledgerFiles: { type: "array", items: { type: "string" } } } } },
    { name: "fiction_import_auxiliary", description: "Import an author's local auxiliary documents into a project.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "sourcePath"], properties: { projectId: { type: "string" }, sourcePath: { type: "string" } } } },
    { name: "fiction_download_book", description: "Run an explicitly authorized loopback book download task.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "authorized"], properties: { projectId: { type: "string" }, title: { type: "string" }, bookId: { type: "string" }, author: { type: "string" }, focus: { type: "string" }, authorized: { type: "boolean" } } } },
    { name: "fiction_deconstruct_book", description: "Deconstruct a registered project source into transferable craft observations.", annotations: safetyAnnotations(false), inputSchema: { type: "object", additionalProperties: false, required: ["projectId", "sourceRelativePath"], properties: { projectId: { type: "string" }, sourceRelativePath: { type: "string" }, modelIds: { type: "array", items: { type: "string" } }, force: { type: "boolean" } } } },
    { name: "fiction_read_ledger", description: "Read a project's confirmed writing ledger.", annotations: safetyAnnotations(true), inputSchema: { type: "object", additionalProperties: false, required: ["projectId"], properties: { projectId: { type: "string" } } } }
  ];
  async function call(name, input = {}) {
    switch (name) {
      case "fiction_open_workbench": return toolResult({
        ok: true,
        mode: "chat_first",
        opened: false,
        coach: "不要打开复杂工作台。以后所有结果直接在 Codex 对话里展示。MCP 只负责后台登录、模型调用、文件读写与台账。",
        next: [
          "在对话里继续写/拆/审",
          "需要登录时只用 fiction_open_gateway_login",
          "候选正文写到 Codex候选/*.txt 并在对话里摘要"
        ]
      });
      case "fiction_first_run_coach": {
        let loggedIn = null;
        try {
          if (gatewayGuard && typeof gatewayGuard.accountSnapshot === "function") {
            const snap = await gatewayGuard.accountSnapshot();
            loggedIn = !!snap.loggedIn;
          }
        } catch { loggedIn = false; }
        return toolResult(await getFirstRunCoach(String(input.projectDir || ""), { loggedIn }));
      }
      case "fiction_list_deslop_methods": return toolResult(listMethodCatalog());
      case "fiction_workflow_snapshot": return toolResult(await getWorkflowSnapshot(String(input.projectDir || ""), { includeGuide: input.includeGuide !== false }));
      case "fiction_list_capabilities": return toolResult({ capabilities: listInkOsCapabilities(), product: getProductGuide() });
      case "fiction_list_models": await requireGatewayOrThrow("list_models"); {
        if (!gateway || typeof gateway.listModels !== "function" || typeof gateway.accountStatus !== "function") {
          const error = new Error("Model gateway is unavailable."); error.code = "GATEWAY_REQUIRED"; throw error;
        }
        const [account, catalog] = await Promise.all([gateway.accountStatus(), gateway.listModels()]);
        return toolResult({ account, models: Array.isArray(catalog) ? catalog : catalog?.models || [] });
      }
      case "fiction_list_projects": return toolResult({ projects: await director.listProjects() });
      case "fiction_create_project": return toolResult(await director.createProject({ title: required(input.title, "title"), direction: String(input.direction || "").trim() }));
      case "fiction_scaffold_book_folder": return toolResult(await scaffoldBookFolder(required(input.targetDir, "targetDir"), { title: String(input.title || "").trim(), overwrite: input.overwrite === true, pluginRoot: require("node:path").join(__dirname, "..") }));
      case "fiction_describe_builtin_workflow": return toolResult(await describeOrganizedWorkflow(require("node:path").join(__dirname, "..")));
      case "fiction_ensure_book_workspace": return toolResult(await ensureBookWorkspace(required(input.targetDir, "targetDir"), { title: String(input.title || "").trim(), overwrite: input.overwrite === true, pluginRoot: require("node:path").join(__dirname, "..") }));
      case "fiction_confirm_chapter_ledgers": return toolResult(await confirmChapterToLedgers({ projectDir: required(input.projectDir, "projectDir"), prose: required(input.prose, "prose"), authorConfirmed: input.authorConfirmed === true, title: String(input.title || "").trim(), chapterId: String(input.chapterId || "").trim(), chapterNo: String(input.chapterNo || "").trim(), bookTitle: String(input.bookTitle || "").trim(), summary: String(input.summary || "").trim(), nextHook: String(input.nextHook || "").trim(), characterChanges: input.characterChanges, timeline: input.timeline, foreshadow: input.foreshadow, saveCandidateSnapshot: input.saveCandidateSnapshot === true, pluginRoot: require("node:path").join(__dirname, "..") }));
      case "fiction_get_project_state": return toolResult(await director.projectState(required(input.projectId, "projectId")));
      case "fiction_list_sources": return toolResult({ sources: await director.listSources(required(input.projectId, "projectId")) });
      case "fiction_list_tasks": return toolResult({ tasks: await director.taskStore.list({ projectId: required(input.projectId, "projectId") }) });
      case "fiction_get_task": return toolResult(await director.taskStore.read(required(input.taskId, "taskId")));
      case "fiction_pause_task": return toolResult(await director.taskStore.pause(required(input.taskId, "taskId")));
      case "fiction_resume_task": return toolResult(await director.taskStore.resume(required(input.taskId, "taskId")));
      case "fiction_ainovel_status": {
        if (!ainovel) { const error = new Error("ainovel-cli is unavailable."); error.code = "AINOVEL_UNAVAILABLE"; throw error; }
        return toolResult(await ainovel.status(required(input.projectId, "projectId")));
      }
      case "fiction_ainovel_start": {
        if (!ainovel) { const error = new Error("ainovel-cli is unavailable."); error.code = "AINOVEL_UNAVAILABLE"; throw error; }
        return toolResult(await ainovel.start({ projectId: required(input.projectId, "projectId"), prompt: required(input.prompt, "prompt"), modelIds: input.modelIds }));
      }
      case "fiction_ainovel_pause": {
        if (!ainovel) { const error = new Error("ainovel-cli is unavailable."); error.code = "AINOVEL_UNAVAILABLE"; throw error; }
        return toolResult(await ainovel.pause(required(input.projectId, "projectId")));
      }
      case "fiction_ainovel_resume": {
        if (!ainovel) { const error = new Error("ainovel-cli is unavailable."); error.code = "AINOVEL_UNAVAILABLE"; throw error; }
        return toolResult(await ainovel.resume({ projectId: required(input.projectId, "projectId"), modelIds: input.modelIds }));
      }
      case "fiction_run": await requireGatewayOrThrow("fiction_run"); return toolResult(await director.run({ ...input, projectId: required(input.projectId, "projectId"), kind: required(input.kind, "kind"), instruction: required(input.instruction, "instruction") }));
      case "fiction_import_auxiliary": return toolResult(await director.importAuxiliary({ projectId: required(input.projectId, "projectId"), sourcePath: required(input.sourcePath, "sourcePath") }));
      case "fiction_download_book": return toolResult(await director.run({ ...input, projectId: required(input.projectId, "projectId"), kind: "download", authorized: input.authorized === true }));
      case "fiction_deconstruct_book": return toolResult(await director.run({ ...input, projectId: required(input.projectId, "projectId"), kind: "deconstruct", sourceRelativePath: required(input.sourceRelativePath, "sourceRelativePath") }));
      case "fiction_read_ledger": return toolResult(await director.readLedger(required(input.projectId, "projectId")));
      case "fiction_list_model_tasks": return toolResult({ tasks: listTaskCatalog(), auxiliary: true });
      case "fiction_recommend_models": {
        const mode = String(input.mode || "quick");
        if (!gateway || typeof gateway.listModels !== "function") {
          return toolResult(recommendModels({
            task: String(input.task || "draft"),
            mode,
            availableModels: [],
            authorPrefer: input.authorPrefer,
            maxPerRole: Number(input.maxPerRole || 2),
            unpaid: true
          }));
        }
        let models = [];
        let unpaid = false;
        try {
          await requireGateway("recommend_models");
          const listed = await gateway.listModels();
          models = Array.isArray(listed?.models) ? listed.models : [];
        } catch {
          unpaid = true;
          models = [];
        }
        const creditsMap = {};
        for (const m of models) {
          if (m && m.id != null) creditsMap[m.id] = m.credits ?? m.credit ?? m.cost ?? null;
        }
        return toolResult(recommendModels({
          task: String(input.task || "draft"),
          mode,
          availableModels: models,
          creditsMap,
          authorPrefer: input.authorPrefer,
          maxPerRole: Number(input.maxPerRole || 2),
          unpaid: unpaid || models.length === 0
        }));
      }
      case "fiction_write_artifact": return toolResult(await writeArtifact({
        projectDir: required(input.projectDir, "projectDir"),
        content: required(input.content, "content"),
        kind: String(input.kind || "draft"),
        title: String(input.title || ""),
        chapterNo: String(input.chapterNo || ""),
        modelId: String(input.modelId || ""),
        ext: String(input.ext || "txt")
      }));
      case "fiction_read_artifact": return toolResult(await readArtifact(required(input.path, "path"), { maxChars: Number(input.maxChars || 200000) }));
      case "fiction_list_artifacts": return toolResult(await listArtifacts(required(input.projectDir, "projectDir"), { limit: Number(input.limit || 30) }));
      case "fiction_build_draft_packet": {
        let availableModels = [];
        try {
          if (gateway && typeof gateway.listModels === "function") {
            const listed = await gateway.listModels();
            availableModels = Array.isArray(listed?.models) ? listed.models : [];
          }
        } catch {}
        return toolResult(await buildDraftPacket({
          projectDir: required(input.projectDir, "projectDir"),
          chapterNo: String(input.chapterNo || "1"),
          title: String(input.title || ""),
          instruction: String(input.instruction || ""),
          engineName: String(input.engineName || ""),
          minChars: Number(input.minChars || 1800),
          maxChars: Number(input.maxChars || 3200),
          availableModels,
          saveArtifact: input.saveArtifact !== false
        }));
      }
      case "fiction_generate_to_file": await requireGatewayOrThrow("generate_to_file"); {
        if (input.authorOverride !== true) {
          try {
            const gate = await assessPipeline(required(input.projectDir, "projectDir"));
            if (!gate.canDraft) {
              return toolResult({ ok: false, blocked: true, reason: "pipeline_hard_block", pipeline: gate, coach: gate.coach + " 若作者明确要求强行写，可 authorOverride=true。" });
            }
          } catch (_) {}
        }
        if (!gateway || typeof gateway.callModels !== "function") {
          const error = new Error("gateway.callModels unavailable");
          error.code = "GATEWAY_UNAVAILABLE";
          throw error;
        }
        return toolResult(await generateToArtifact({gateway,
          projectDir: required(input.projectDir, "projectDir"),
          prompt: required(input.prompt, "prompt"),
          system: String(input.system || ""),
          modelIds: input.modelIds,
          kind: String(input.kind || "draft"),
          title: String(input.title || ""),
          chapterNo: String(input.chapterNo || ""),
          taskLabel: String(input.taskLabel || input.kind || "fiction"),
          previewChars: Number(input.previewChars || 800),
          fallbackChain: input.fallbackChain !== false,
          minChars: Number(input.minChars || 0),
          applyHardGates: input.applyHardGates !== false,
          maxTokens: Number(input.maxTokens || 24000)
        }));
      }
      
      case "fiction_import_sample_book": return toolResult(await importSampleBook({ projectDir: required(input.projectDir, "projectDir"), sourcePath: required(input.sourcePath, "sourcePath"), title: String(input.title || "") }));
      case "fiction_list_sample_books": return toolResult(await listSampleBooks(required(input.projectDir, "projectDir")));
      case "fiction_read_sample_notes": return toolResult(await readSampleNotes(required(input.projectDir, "projectDir"), String(input.sampleName || "")));
      case "fiction_plan_research": return toolResult(await planResearch({ projectDir: required(input.projectDir, "projectDir"), topic: required(input.topic, "topic"), genre: String(input.genre || ""), names: input.names || [], storyRole: String(input.storyRole || ""), notes: String(input.notes || ""), createDoc: input.createDoc !== false }));
      case "fiction_create_research_doc": return toolResult(await createResearchDoc({ projectDir: required(input.projectDir, "projectDir"), topic: required(input.topic, "topic"), genre: String(input.genre || ""), notes: String(input.notes || "") }));
      case "fiction_create_character_card": return toolResult(await createCharacterCard({ projectDir: required(input.projectDir, "projectDir"), name: required(input.name, "name"), kind: String(input.kind || "fictional"), summary: String(input.summary || "") }));
      case "fiction_list_character_cards": return toolResult(await listCharacterCards(required(input.projectDir, "projectDir")));
      case "fiction_plan_next_chapter": return toolResult(await planNextContinuousChapter(required(input.projectDir, "projectDir"), { chapterNo: String(input.chapterNo || ""), title: String(input.title || ""), conflict: String(input.conflict || ""), hook: String(input.hook || "") }));
      case "fiction_get_continuous_mode": return toolResult(await readContinuousMode(required(input.projectDir, "projectDir")));
      case "fiction_mark_golden_three_ready": return toolResult(await setGoldenThreeReady(required(input.projectDir, "projectDir"), input.ready !== false));
      case "fiction_enable_continuous_mode": return toolResult(await enableContinuousMode(required(input.projectDir, "projectDir"), required(input.authorPhrase, "authorPhrase")));
      case "fiction_disable_continuous_mode": return toolResult(await disableContinuousMode(required(input.projectDir, "projectDir")));
      case "fiction_create_outline": return toolResult(await createOutlineScaffold({ projectDir: required(input.projectDir, "projectDir"), answers: { hook: input.hook, coreConflict: input.coreConflict, heroWant: input.heroWant, pressurePlan: input.pressurePlan, midTwist: input.midTwist, notNow: input.notNow }, overwrite: input.overwrite === true }));
      case "fiction_create_chapter_brief": return toolResult(await createChapterBrief({ projectDir: required(input.projectDir, "projectDir"), chapterNo: String(input.chapterNo || "1"), title: String(input.title || ""), conflict: String(input.conflict || ""), beats: String(input.beats || ""), hook: String(input.hook || ""), pov: String(input.pov || ""), mustInclude: String(input.mustInclude || ""), mustAvoid: String(input.mustAvoid || "") }));
      case "fiction_assess_pipeline": return toolResult(await assessPipeline(required(input.projectDir, "projectDir")));
      case "fiction_bootstrap_project": return toolResult(await bootstrapProject(required(input.projectDir, "projectDir"), { title: String(input.title || "") }));
      case "fiction_deep_learn_sample": {
        await requireGatewayOrThrow("deep_learn_sample");
        return toolResult(await deepLearnSampleTechniques({ gateway, projectDir: required(input.projectDir, "projectDir"), sampleName: String(input.sampleName || ""), modelIds: input.modelIds || [] }));
      }
      case "fiction_learn_sample_techniques": return toolResult(await learnSampleTechniques({ projectDir: required(input.projectDir, "projectDir"), sampleName: String(input.sampleName || ""), maxChapters: Number(input.maxChapters || 30) }));
      case "fiction_ensure_writing_skill": return toolResult(await ensureProjectWritingSkill(required(input.projectDir, "projectDir"), { currentBook: String(input.currentBook || ""), authorRules: String(input.authorRules || "") }));
      case "fiction_get_brainstorm_coach": return toolResult(await getBrainstormCoach(required(input.projectDir, "projectDir")));
      case "fiction_update_brainstorm": return toolResult(await updateBrainstormBoard(required(input.projectDir, "projectDir"), { hook: input.hook, desire: input.desire, obstacle: input.obstacle, hookWhy: input.hookWhy, later: input.later, questions: input.questions }));
      case "fiction_ensure_fact_library": return toolResult(await ensureFactLibrary(required(input.projectDir, "projectDir")));
      case "fiction_read_fact_library": return toolResult(await readFactLibrary(required(input.projectDir, "projectDir")));
      case "fiction_upsert_facts": return toolResult(await upsertFacts(required(input.projectDir, "projectDir"), { facts: input.facts || [], forbidden: input.forbidden || [], fictionBounds: input.fictionBounds || [], pending: input.pending || [], sources: input.sources || [], note: String(input.note || "") }));
      case "fiction_upsert_soft_chapter_ledger": return toolResult(await upsertSoftChapterLedger(required(input.projectDir, "projectDir"), { chapterNo: required(input.chapterNo, "chapterNo"), title: String(input.title || ""), summary: String(input.summary || ""), timePlace: String(input.timePlace || ""), characters: String(input.characters || ""), changes: String(input.changes || ""), relations: String(input.relations || ""), foreshadow: String(input.foreshadow || ""), payoff: String(input.payoff || ""), hook: String(input.hook || ""), candidatePath: String(input.candidatePath || "") }));
      case "fiction_check_continuity": return toolResult(await checkChapterContinuity(required(input.projectDir, "projectDir"), required(input.chapterNo, "chapterNo")));
      case "fiction_append_research_findings": return toolResult(await appendResearchFindings({ projectDir: required(input.projectDir, "projectDir"), topic: required(input.topic, "topic"), sources: input.sources || [], facts: input.facts || [], forbidden: input.forbidden || [], notes: String(input.notes || "") }));
      case "fiction_get_guided_status": return toolResult(await getGuidedStatus(String(input.projectDir || "")));
      case "fiction_advance_guided_stage": return toolResult(await advanceGuidedStage(required(input.projectDir, "projectDir"), { toStage: String(input.toStage || ""), note: String(input.note || ""), answers: input.answers || null }));
      case "fiction_save_guided_answers": return toolResult(await saveGuidedAnswers(required(input.projectDir, "projectDir"), String(input.stageId || ""), input.answers));
      case "fiction_ensure_soft_ledgers": return toolResult(await ensureSoftLedgers(required(input.projectDir, "projectDir")));
      case "fiction_upsert_voice_anchor": return toolResult(await upsertVoiceAnchor(required(input.projectDir, "projectDir"), { narration: input.narration, dialogue: input.dialogue, pacing: input.pacing, fromSample: input.fromSample, forbid: input.forbid, author: input.author }));
      case "fiction_compare_style": return toolResult(await compareStyle({ projectDir: required(input.projectDir, "projectDir"), draftText: String(input.draftText || ""), draftPath: String(input.draftPath || ""), title: String(input.title || "") }));
      case "fiction_optimize_with_models": {
        await requireGatewayOrThrow("optimize_with_models");
        return toolResult(await optimizeWithModels({
          gateway,
          projectDir: required(input.projectDir, "projectDir"),
          draftText: required(input.draftText, "draftText"),
          title: String(input.title || ""),
          chapterNo: String(input.chapterNo || ""),
          modelIds: input.modelIds || [],
          mode: String(input.mode || "humanize"),
          focus: String(input.focus || "full"),
          instruction: String(input.instruction || ""),
          autoRecommend: input.autoRecommend !== false
        }));
      }
      case "fiction_chapter_coach": return toolResult(getChapterCoach(required(input.chapterNo, "chapterNo"), { engineName: String(input.engineName || "") }));
      case "fiction_get_golden_three": return toolResult(await getGoldenThreeStatus(required(input.projectDir, "projectDir")));
      case "fiction_mark_golden_chapter": return toolResult(await markGoldenChapter(required(input.projectDir, "projectDir"), required(input.chapterNo, "chapterNo"), { ready: input.ready !== false, note: String(input.note || ""), path: String(input.path || "") }));
      case "fiction_smoke_live_gateway": {
        if (!gateway) {
          const error = new Error("gateway unavailable"); error.code = "GATEWAY_UNAVAILABLE"; throw error;
        }
        return toolResult(await smokeLiveGateway({
          gateway,
          projectDir: String(input.projectDir || ""),
          title: String(input.title || "live-smoke")
        }));
      }
      case "fiction_open_gateway_login": {
        if (gatewayGuard && typeof gatewayGuard.ensureAccess === "function") {
          return toolResult(await gatewayGuard.ensureAccess({ force: true, reason: "open_gateway_login", openBrowser: true }));
        }
        if (typeof openLoginPage !== "function") {
          const error = new Error("Login page unavailable"); error.code = "TOOL_NOT_FOUND"; throw error;
        }
        const page = await openLoginPage();
        return toolResult({ ok: false, loggedIn: false, popupOpened: true, loginUrl: page?.url || null, shopUrl: process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || "https://catfk.com/shop/ZVZNANU8", message: page?.message || "请在浏览器完成登录。" });
      }
      case "fiction_account_status": {
        if (gatewayGuard && typeof gatewayGuard.accountSnapshot === "function") {
          const snap = await gatewayGuard.accountSnapshot();
          if (snap.loggedIn && typeof require("./onboarding-state").markLoginOk === "function") {
            try { await require("./onboarding-state").markLoginOk(); } catch {}
          }
          return toolResult({ ok: true, loggedIn: !!snap.loggedIn, online: !!snap.online, account: snap.raw || null, message: snap.loggedIn ? "网关已登录。" : "未登录。可用 fiction_open_gateway_login。" });
        }
        if (gateway && typeof gateway.accountStatus === "function") {
          try {
            const raw = await gateway.accountStatus();
            const loggedIn = !!(raw && (raw.loggedIn === true || raw.user));
            return toolResult({ ok: true, loggedIn, account: raw, message: loggedIn ? "网关已登录。" : "未登录。" });
          } catch {
            return toolResult({ ok: false, loggedIn: false, message: "无法读取账号状态。" });
          }
        }
        return toolResult({ ok: false, loggedIn: false, message: "账号状态接口不可用。" });
      }
      case "fiction_write_local_candidate": {
        const saved = await writeArtifact({
          projectDir: required(input.projectDir, "projectDir"),
          kind: String(input.kind || "local_draft"),
          title: String(input.title || ""),
          chapterNo: String(input.chapterNo || ""),
          modelId: "local-or-codex",
          content: required(input.content, "content"),
          ext: "txt",
          meta: { transport: "local_no_gateway", note: "本地/Codex 写入的候选，未走网关多模型" }
        });
        return toolResult({
          ok: true,
          artifact: saved,
          coach: "候选已落盘。不充值也能这样写；若要多模型优化/强模型，请先 fiction_open_gateway_login。"
        });
      }
      case "fiction_ensure_gateway": {
        if (!gatewayGuard || typeof gatewayGuard.ensureAccess !== "function") return toolResult({ ok: true, skipped: true, message: "gatewayGuard unavailable" });
        return toolResult(await gatewayGuard.ensureAccess({ force: input.force === true, reason: input.force ? "forced" : "ensure_gateway" }));
      }
      default: { const error = new Error(`Unknown fiction tool: ${name}`); error.code = "TOOL_NOT_FOUND"; throw error; }
    }
  }
  return Object.freeze({ list: () => definitions.map((tool) => ({ ...tool })), call });
}

module.exports = { createFictionMcpTools };
