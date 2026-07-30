"use strict";

const { scaffoldBookFolder, describeBuiltinWorkflow } = require("./workflow-scaffold");
const { importSampleBook, listSampleBooks, readSampleNotes } = require("./sample-book-service");
const { learnSampleTechniques, ensureProjectWritingSkill } = require("./sample-learn-service");
const { ensureFactLibrary, readFactLibrary, upsertFacts } = require("./fact-library-service");
const { planResearch } = require("./research-plan-service");
const { createResearchDoc, createCharacterCard, listCharacterCards } = require("./research-doc-service");
const { appendResearchFindings } = require("./research-fill-service");
const { upsertVoiceAnchor } = require("./voice-anchor-service");

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) {
    const error = new Error(`${name} is required.`);
    error.code = "INVALID_ARGUMENT";
    throw error;
  }
  return value.trim();
}

function annotations(readOnlyHint) {
  return { readOnlyHint, openWorldHint: false, destructiveHint: false };
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const definitions = [
  {
    name: "fiction_project",
    description: "Create a writing project from the built-in lightweight template, or inspect the built-in project layout. This local tool never calls a model.",
    annotations: annotations(false),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: ["create", "describe"] },
        projectDir: { type: "string", maxLength: 1024 },
        title: { type: "string", maxLength: 160 },
        overwrite: { type: "boolean" }
      }
    }
  },
  {
    name: "fiction_sample_book",
    description: "Import, list, read notes from, or locally study authorized sample books. It keeps sourced full-sentence passages for local comparison, but never drafts from them or adopts observations automatically.",
    annotations: annotations(false),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "projectDir"],
      properties: {
        action: { type: "string", enum: ["import", "list", "read_notes", "learn", "ensure_writing_skill"] },
        projectDir: { type: "string", maxLength: 1024 },
        sourcePath: { type: "string", maxLength: 2048 },
        title: { type: "string", maxLength: 160 },
        sampleName: { type: "string", maxLength: 160 },
        maxFiles: { type: "number", minimum: 1, maximum: 500 },
        focus: { type: "string", maxLength: 2000 },
        currentBook: { type: "string", maxLength: 3000 },
        authorRules: { type: "string", maxLength: 3000 }
      }
    }
  },
  {
    name: "fiction_research",
    description: "Plan and store real-world or historical research, character cards, and sourced findings. It does not claim web facts until sources are supplied.",
    annotations: annotations(false),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "projectDir"],
      properties: {
        action: { type: "string", enum: ["plan", "create_doc", "create_character", "list_characters", "append_findings"] },
        projectDir: { type: "string", maxLength: 1024 },
        topic: { type: "string", maxLength: 200 },
        genre: { type: "string", maxLength: 100 },
        names: { type: "array", items: { type: "string" }, maxItems: 20 },
        storyRole: { type: "string", maxLength: 1000 },
        notes: { type: "string", maxLength: 8000 },
        createDoc: { type: "boolean" },
        name: { type: "string", maxLength: 120 },
        kind: { type: "string", maxLength: 40 },
        summary: { type: "string", maxLength: 1200 },
        sources: { type: "array", items: { type: "string" }, maxItems: 40 },
        facts: { type: "array", items: { type: "string" }, maxItems: 80 },
        forbidden: { type: "array", items: { type: "string" }, maxItems: 80 },
        fictionBounds: { type: "array", items: { type: "string" }, maxItems: 40 }
      }
    }
  },
  {
    name: "fiction_facts",
    description: "Create, read, or update the project's hard-fact and anti-OOC ledger. This is memory only and never dictates prose order.",
    annotations: annotations(false),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["action", "projectDir"],
      properties: {
        action: { type: "string", enum: ["ensure", "read", "upsert"] },
        projectDir: { type: "string", maxLength: 1024 },
        facts: { type: "array", items: { type: "string" }, maxItems: 80 },
        forbidden: { type: "array", items: { type: "string" }, maxItems: 80 },
        fictionBounds: { type: "array", items: { type: "string" }, maxItems: 40 },
        pending: { type: "array", items: { type: "string" }, maxItems: 40 },
        sources: { type: "array", items: { type: "string" }, maxItems: 40 },
        note: { type: "string", maxLength: 4000 }
      }
    }
  },
  {
    name: "fiction_voice_anchor",
    description: "Store concise, project-specific voice observations for later comparison. It does not generate or rewrite prose.",
    annotations: annotations(false),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectDir"],
      properties: {
        projectDir: { type: "string", maxLength: 1024 },
        narration: { type: "string", maxLength: 4000 },
        dialogue: { type: "string", maxLength: 4000 },
        pacing: { type: "string", maxLength: 4000 },
        fromSample: { type: "string", maxLength: 4000 },
        forbid: { type: "string", maxLength: 4000 },
        author: { type: "string", maxLength: 4000 }
      }
    }
  }
];

function createLocalCoreTools(options = {}) {
  const names = new Set(definitions.map((tool) => tool.name));

  async function call(name, input = {}) {
    switch (name) {
      case "fiction_project": {
        if (input.action === "describe") return result(describeBuiltinWorkflow());
        if (input.action === "create") {
          return result(await scaffoldBookFolder(required(input.projectDir, "projectDir"), {
            title: String(input.title || ""),
            overwrite: input.overwrite === true
          }));
        }
        break;
      }
      case "fiction_sample_book": {
        const projectDir = required(input.projectDir, "projectDir");
        if (input.action === "import") return result(await importSampleBook({ projectDir, sourcePath: required(input.sourcePath, "sourcePath"), title: String(input.title || "") }));
        if (input.action === "list") return result(await listSampleBooks(projectDir));
        if (input.action === "read_notes") return result(await readSampleNotes(projectDir, String(input.sampleName || "")));
        if (input.action === "learn") return result(await learnSampleTechniques({ projectDir, sampleName: String(input.sampleName || ""), maxFiles: input.maxFiles, focus: String(input.focus || ""), currentBook: String(input.currentBook || "") }));
        if (input.action === "ensure_writing_skill") return result(await ensureProjectWritingSkill(projectDir, { currentBook: String(input.currentBook || ""), authorRules: String(input.authorRules || "") }));
        break;
      }
      case "fiction_research": {
        const projectDir = required(input.projectDir, "projectDir");
        if (input.action === "plan") return result(await planResearch({ projectDir, topic: required(input.topic, "topic"), genre: String(input.genre || ""), names: input.names || [], storyRole: String(input.storyRole || ""), notes: String(input.notes || ""), createDoc: input.createDoc !== false }));
        if (input.action === "create_doc") return result(await createResearchDoc({ projectDir, topic: required(input.topic, "topic"), genre: String(input.genre || ""), notes: String(input.notes || "") }));
        if (input.action === "create_character") return result(await createCharacterCard({ projectDir, name: required(input.name, "name"), kind: String(input.kind || "fictional"), summary: String(input.summary || "") }));
        if (input.action === "list_characters") return result(await listCharacterCards(projectDir));
        if (input.action === "append_findings") return result(await appendResearchFindings({ projectDir, topic: required(input.topic, "topic"), sources: input.sources || [], facts: input.facts || [], forbidden: input.forbidden || [], fictionBounds: input.fictionBounds || [], notes: String(input.notes || "") }));
        break;
      }
      case "fiction_facts": {
        const projectDir = required(input.projectDir, "projectDir");
        if (input.action === "ensure") return result(await ensureFactLibrary(projectDir));
        if (input.action === "read") return result(await readFactLibrary(projectDir));
        if (input.action === "upsert") return result(await upsertFacts(projectDir, { facts: input.facts || [], forbidden: input.forbidden || [], fictionBounds: input.fictionBounds || [], pending: input.pending || [], sources: input.sources || [], note: String(input.note || "") }));
        break;
      }
      case "fiction_voice_anchor": return result(await upsertVoiceAnchor(required(input.projectDir, "projectDir"), input));
      default: break;
    }
    const error = new Error(`Unknown local core tool or action: ${name}/${input.action || ""}`);
    error.code = names.has(name) ? "INVALID_ARGUMENT" : "TOOL_NOT_FOUND";
    throw error;
  }

  return Object.freeze({
    has: (name) => names.has(name),
    list: () => definitions.map((tool) => ({ ...tool })),
    call
  });
}

module.exports = { createLocalCoreTools };
