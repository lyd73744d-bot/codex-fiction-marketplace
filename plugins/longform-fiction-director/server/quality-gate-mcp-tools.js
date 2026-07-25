"use strict";

const SENSITIVE_KEY_PARTS = ["key", "token", "password", "secret", "authorization", "credential", "cookie", "session", "bearer"];

function isSensitiveKey(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
  return SENSITIVE_KEY_PARTS.some((part) => normalized.includes(part));
}

function sanitize(value, state = { characters: 0, nodes: 0, seen: new WeakSet() }, depth = 0) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const remaining = Math.max(0, 160_000 - state.characters);
    const result = value.slice(0, remaining);
    state.characters += result.length;
    return result.length < value.length ? `${result}[truncated]` : result;
  }
  if (!value || typeof value !== "object" || depth > 16 || state.nodes > 2_048) return "[truncated]";
  if (state.seen.has(value)) return "[circular]";
  state.seen.add(value);
  state.nodes += 1;
  if (Array.isArray(value)) return value.slice(0, 256).map((item) => sanitize(item, state, depth + 1));
  const output = {};
  for (const [key, item] of Object.entries(value)) if (!isSensitiveKey(key)) output[key] = sanitize(item, state, depth + 1);
  return output;
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(sanitize(value), null, 2) }] };
}

function createQualityGateMcpTools({ service, openLoginPage } = {}) {
  if (!service || typeof service.accountStatus !== "function" || typeof service.bind !== "function" || typeof service.workflowGuide !== "function" || typeof service.guideStage !== "function" || typeof service.prepareStage !== "function" || typeof service.review !== "function" || typeof service.writeWithModel !== "function") throw new TypeError("quality gate service is required");
  const definitions = [
    { name: "fiction_quality_account_status", description: "Report whether the local gateway session is logged in. It never returns credentials.", annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_bind_quality_context", description: "Persistently bind a project control document, optional explicit auxiliary-document list, one authorized reference book, and one style anchor. Every later writing or quality call rereads all bound documents.", annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, required: ["projectPath", "auxiliaryPath", "referencePath", "styleAnchorPath", "referenceAuthorized"], properties: { projectPath: { type: "string" }, auxiliaryPath: { type: "string" }, auxiliaryPaths: { type: "array", minItems: 1, maxItems: 16, items: { type: "string" } }, referencePath: { type: "string" }, styleAnchorPath: { type: "string" }, referenceAuthorized: { type: "boolean" } } } },
    { name: "fiction_list_quality_bindings", description: "List active local quality bindings without returning bound document content.", annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_list_quality_models", description: "List currently available non-GPT gateway models after local login.", annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, properties: {} } },
    { name: "fiction_workflow_guide", description: "Return writing steps (step-by-step by default), optional continuous-run plan, checklist, soft next actions, and optional genre recipe. This never calls a model, spends credits, or prevents the author from choosing another step.", annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, required: ["bindingId"], properties: { bindingId: { type: "string" }, phase: { type: "string", enum: ["brainstorm", "outline", "draft", "humanize", "review", "revise", "confirm"] }, genreId: { type: "string" }, progress: { type: "object", additionalProperties: true }, continuousPreset: { type: "string", enum: ["to_draft", "chapter_once", "polish_once", "multi_chapter"] }, chapterCount: { type: "integer", minimum: 1, maximum: 20 }, includeHumanize: { type: "boolean" }, includeReview: { type: "boolean" }, fromPhase: { type: "string" } } } },
    { name: "fiction_guide_stage", description: "Start a conversational writing or quality stage. It checks login, prepares a one-time stage credential, and returns a chat-ready non-GPT model list. Codex may brainstorm directly, or use this route when the author explicitly selects a gateway model.", annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, required: ["bindingId", "stage"], properties: { bindingId: { type: "string" }, stage: { type: "string", enum: ["brainstorm", "outline", "draft", "humanize", "review", "revise"] } } } },
    { name: "fiction_prepare_quality_stage", description: "Before a paid brainstorm, outline, draft, humanization, review, or revision, verify local login and return this stage's non-GPT model list plus a one-time confirmation id.", annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, required: ["bindingId", "stage"], properties: { bindingId: { type: "string" }, stage: { type: "string", enum: ["brainstorm", "outline", "draft", "humanize", "review", "revise"] } } } },
    { name: "fiction_write_with_model", description: "Run one bound brainstorm, outline, draft, or humanization step with the author-confirmed non-GPT modelId and fresh one-time confirmation id. Returns a candidate only and never starts a quality review automatically. An author-requested artifactPath streams the candidate into a project-local .md or .txt file.", annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, required: ["bindingId", "preparationId", "stage", "modelId", "instruction"], properties: { bindingId: { type: "string" }, preparationId: { type: "string" }, stage: { type: "string", enum: ["brainstorm", "outline", "draft", "humanize"] }, modelId: { type: "string" }, instruction: { type: "string", maxLength: 120000 }, artifactPath: { type: "string", maxLength: 512 } } } },
    { name: "fiction_quality_gate", description: "Author-invoked final quality gate. It needs a fresh one-time confirmed review/revise stage, rereads every bound document, checks AI-style issues, and requires a non-GPT gateway verdict before that review can pass.", annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, required: ["bindingId", "preparationId", "prose", "modelId"], properties: { bindingId: { type: "string" }, preparationId: { type: "string" }, prose: { type: "string", maxLength: 120000 }, modelId: { type: "string" }, mode: { type: "string", enum: ["review", "revise"] } } } }
  ];
  if (typeof openLoginPage === "function") {
    definitions.unshift({ name: "fiction_generate_cover", description: "Generate a novel cover image with gpt-image-2 (50 credits display). Returns saved path or base64 availability; never returns API keys.", annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, genre: { type: "string" }, prompt: { type: "string" }, style: { type: "string" }, modelId: { type: "string" }, savePath: { type: "string" }, size: { type: "string" } } } },
    { name: "fiction_open_gateway_login", description: "Open the local model connection page before real model work. Codex must show this URL in the in-app browser. After login the page shows credits, available models, and a live probe. Credentials never go through MCP.", annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false }, inputSchema: { type: "object", additionalProperties: false, properties: {} } });
  }
  async function call(name, input = {}) {
    switch (name) {
      case "fiction_generate_cover":
      if (typeof service.generateCover !== "function") throw Object.assign(new Error("Cover generation is unavailable."), { code: "TOOL_NOT_FOUND" });
      return result(await service.generateCover(args || {}));
    case "fiction_open_gateway_login": {
        if (typeof openLoginPage !== "function") { const error = new Error("Tool not found."); error.code = "TOOL_NOT_FOUND"; throw error; }
        return result(await openLoginPage());
      }
      case "fiction_quality_account_status": return result(await service.accountStatus());
      case "fiction_bind_quality_context": return result(await service.bind(input));
      case "fiction_list_quality_bindings": return result({ bindings: await service.listBindings() });
      case "fiction_list_quality_models": return result({ models: await service.listModels() });
      case "fiction_workflow_guide": return result(await service.workflowGuide(input));
      case "fiction_guide_stage": return result(await service.guideStage(input));
      case "fiction_prepare_quality_stage": return result(await service.prepareStage(input));
      case "fiction_write_with_model": return result(await service.writeWithModel(input));
      case "fiction_quality_gate": return result(await service.review(input));
      default: { const error = new Error("Tool not found."); error.code = "TOOL_NOT_FOUND"; throw error; }
    }
  }
  return Object.freeze({ list: () => definitions.map((tool) => ({ ...tool })), call });
}

module.exports = { createQualityGateMcpTools };
