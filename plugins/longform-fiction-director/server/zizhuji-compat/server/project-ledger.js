"use strict";

const crypto = require("node:crypto");

const LEDGER_PATH = "项目资料/创作台账.json";
const TIERS = new Set(["core", "major", "support", "minor"]);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function text(value, label, max = 20_000, fallback = "") {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${label} must be bounded text`);
  return value.trim();
}

function integer(value, label, fallback = 0) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} chapter/count must be a non-negative integer`);
  return value;
}

function list(value, label, max, mapper) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > max) throw new TypeError(`${label} must be a bounded array`);
  return value.map(mapper);
}

function textList(value, label, max = 100) {
  return list(value, label, max, (item, index) => text(item, `${label}[${index}]`, 2_000));
}

function allowedKeys(value, label, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TypeError(`${label}.${key} is not allowed`);
  }
}

function optionalText(source, key, label, max) {
  if (!Object.prototype.hasOwnProperty.call(source, key) || source[key] === undefined) return undefined;
  return text(source[key], label, max);
}

function positiveInteger(value, label) {
  const result = integer(value, label);
  if (result < 1) throw new TypeError(`${label} must be a positive integer`);
  return result;
}

function characterTier(character) {
  const role = String(character.role || "").toLowerCase();
  const appearances = integer(character.appearanceCount, "character appearanceCount", 0);
  if (/主角|核心|protagonist|antagonist|反派/.test(role)) return "core";
  if (/重要|major/.test(role) || appearances >= 8) return "major";
  if (/配角|support/.test(role) || appearances >= 3) return "support";
  return "minor";
}

function normalizeCharacter(value, index) {
  const source = record(value, `characters[${index}]`);
  const name = text(source.name, `characters[${index}].name`, 120);
  if (!name) throw new TypeError(`characters[${index}].name is required`);
  const id = text(source.id, `characters[${index}].id`, 128)
    || `char_${crypto.createHash("sha256").update(name, "utf8").digest("hex").slice(0, 20)}`;
  if (!/^[A-Za-z0-9_\-\u4e00-\u9fff]{1,128}$/u.test(id)) throw new TypeError(`characters[${index}].id is invalid`);
  const profile = source.profile === undefined ? {} : record(source.profile, `characters[${index}].profile`);
  const voice = source.voice === undefined ? {} : record(source.voice, `characters[${index}].voice`);
  const current = source.current === undefined ? {} : record(source.current, `characters[${index}].current`);
  const timeline = list(source.timeline, `characters[${index}].timeline`, 2_000, (item, itemIndex) => {
    const event = record(item, `characters[${index}].timeline[${itemIndex}]`);
    return {
      chapter: integer(event.chapter, `characters[${index}].timeline[${itemIndex}]`),
      event: text(event.event, `characters[${index}].timeline[${itemIndex}].event`, 2_000),
      change: text(event.change, `characters[${index}].timeline[${itemIndex}].change`, 2_000),
      source: text(event.source, `characters[${index}].timeline[${itemIndex}].source`, 300)
    };
  }).sort((left, right) => left.chapter - right.chapter || left.event.localeCompare(right.event, "zh-CN"));
  return {
    id,
    name,
    role: text(source.role, `characters[${index}].role`, 200),
    tier: characterTier(source),
    appearanceCount: integer(source.appearanceCount, `characters[${index}].appearanceCount`),
    profile: {
      goal: text(profile.goal, "profile.goal", 2_000),
      motivation: text(profile.motivation, "profile.motivation", 2_000),
      personality: text(profile.personality, "profile.personality", 2_000),
      taboos: textList(profile.taboos, "profile.taboos", 50)
    },
    voice: {
      rhythm: text(voice.rhythm, "voice.rhythm", 2_000),
      vocabulary: textList(voice.vocabulary, "voice.vocabulary", 100),
      habits: textList(voice.habits, "voice.habits", 100),
      avoids: textList(voice.avoids, "voice.avoids", 100),
      sampleLines: textList(voice.sampleLines, "voice.sampleLines", 100)
    },
    current: {
      location: text(current.location, "current.location", 500),
      status: text(current.status, "current.status", 2_000),
      knowledge: textList(current.knowledge, "current.knowledge", 300),
      relationships: list(current.relationships, "current.relationships", 300, (item, relationIndex) => {
        const relation = record(item, `relationships[${relationIndex}]`);
        return { targetId: text(relation.targetId, "relationship.targetId", 128), relation: text(relation.relation, "relationship.relation", 1_000) };
      })
    },
    timeline
  };
}

function normalizeState(input, defaults = {}) {
  const source = record(input, "ledger state");
  const book = source.book === undefined ? {} : record(source.book, "book");
  const current = source.current === undefined ? {} : record(source.current, "current");
  const characters = list(source.characters, "characters", 2_000, normalizeCharacter);
  const ids = new Set();
  const names = new Set();
  for (const character of characters) {
    if (ids.has(character.id)) throw new TypeError(`duplicate character id: ${character.id}`);
    const normalizedName = character.name.toLocaleLowerCase("zh-CN");
    if (names.has(normalizedName)) throw new TypeError(`duplicate character name: ${character.name}`);
    ids.add(character.id);
    names.add(normalizedName);
  }
  return {
    version: 1,
    revision: integer(source.revision, "revision"),
    updatedAt: text(source.updatedAt, "updatedAt", 80, defaults.updatedAt || ""),
    book: {
      title: text(book.title, "book.title", 300, defaults.title || ""),
      genre: text(book.genre, "book.genre", 300),
      premise: text(book.premise, "book.premise", 20_000),
      authorIntent: text(book.authorIntent, "book.authorIntent", 20_000),
      currentChapter: integer(book.currentChapter, "book.currentChapter")
    },
    current: {
      location: text(current.location, "current.location", 2_000),
      goal: text(current.goal, "current.goal", 5_000),
      conflict: text(current.conflict, "current.conflict", 5_000),
      constraints: textList(current.constraints, "current.constraints", 300)
    },
    characters,
    hooks: list(source.hooks, "hooks", 2_000, (item, index) => {
      const hook = record(item, `hooks[${index}]`);
      const status = text(hook.status, `hooks[${index}].status`, 40, "open");
      if (!["open", "progressing", "deferred", "resolved"].includes(status)) throw new TypeError(`hooks[${index}].status is invalid`);
      return {
        id: text(hook.id, `hooks[${index}].id`, 128),
        title: text(hook.title, `hooks[${index}].title`, 500),
        status,
        startChapter: integer(hook.startChapter, `hooks[${index}].startChapter`),
        lastAdvancedChapter: integer(hook.lastAdvancedChapter, `hooks[${index}].lastAdvancedChapter`),
        payoff: text(hook.payoff, `hooks[${index}].payoff`, 2_000),
        notes: text(hook.notes, `hooks[${index}].notes`, 5_000)
      };
    }),
    chapterSummaries: list(source.chapterSummaries, "chapterSummaries", 10_000, (item, index) => {
      const summary = record(item, `chapterSummaries[${index}]`);
      return {
        chapter: integer(summary.chapter, `chapterSummaries[${index}]`),
        title: text(summary.title, `chapterSummaries[${index}].title`, 500),
        summary: text(summary.summary, `chapterSummaries[${index}].summary`, 10_000),
        characters: textList(summary.characters, `chapterSummaries[${index}].characters`, 300),
        changes: textList(summary.changes, `chapterSummaries[${index}].changes`, 300)
      };
    }).sort((left, right) => left.chapter - right.chapter)
  };
}

function settlementError(message) {
  return Object.assign(new TypeError(message), { code: "INVALID_SETTLEMENT", statusCode: 400 });
}

function normalizeSettlementDelta(value) {
  let source;
  try {
    source = record(value, "settlement delta");
    allowedKeys(source, "settlement delta", new Set(["chapter", "title", "summary", "current", "characters", "hooks", "changes"]));
    const chapter = positiveInteger(source.chapter, "settlement chapter");
    const summary = text(source.summary, "settlement summary", 10_000);
    if (!summary) throw new TypeError("settlement summary is required");

    const currentSource = source.current == null ? null : record(source.current, "settlement current");
    if (currentSource) allowedKeys(currentSource, "settlement current", new Set(["location", "goal", "conflict", "constraints"]));
    const current = currentSource ? {
      location: optionalText(currentSource, "location", "settlement current.location", 2_000),
      goal: optionalText(currentSource, "goal", "settlement current.goal", 5_000),
      conflict: optionalText(currentSource, "conflict", "settlement current.conflict", 5_000),
      constraints: Object.prototype.hasOwnProperty.call(currentSource, "constraints")
        ? textList(currentSource.constraints, "settlement current.constraints", 300)
        : undefined
    } : null;

    const characters = list(source.characters, "settlement characters", 500, (item, index) => {
      const character = record(item, `settlement characters[${index}]`);
      allowedKeys(character, `settlement characters[${index}]`, new Set([
        "id", "name", "role", "appeared", "current", "knowledgeAdd", "relationships", "timeline"
      ]));
      const id = optionalText(character, "id", `settlement characters[${index}].id`, 128);
      const name = optionalText(character, "name", `settlement characters[${index}].name`, 120);
      if (!id && !name) throw new TypeError(`settlement characters[${index}] requires id or name`);
      if (Object.prototype.hasOwnProperty.call(character, "appeared") && typeof character.appeared !== "boolean") {
        throw new TypeError(`settlement characters[${index}].appeared must be boolean`);
      }
      const characterCurrent = character.current == null ? null : record(character.current, `settlement characters[${index}].current`);
      if (characterCurrent) allowedKeys(characterCurrent, `settlement characters[${index}].current`, new Set(["location", "status"]));
      return {
        id,
        name,
        role: optionalText(character, "role", `settlement characters[${index}].role`, 200),
        appeared: character.appeared !== false,
        current: characterCurrent ? {
          location: optionalText(characterCurrent, "location", `settlement characters[${index}].current.location`, 500),
          status: optionalText(characterCurrent, "status", `settlement characters[${index}].current.status`, 2_000)
        } : null,
        knowledgeAdd: textList(character.knowledgeAdd, `settlement characters[${index}].knowledgeAdd`, 300),
        relationships: list(character.relationships, `settlement characters[${index}].relationships`, 300, (relationValue, relationIndex) => {
          const relation = record(relationValue, `settlement characters[${index}].relationships[${relationIndex}]`);
          allowedKeys(relation, `settlement characters[${index}].relationships[${relationIndex}]`, new Set(["targetId", "targetName", "relation"]));
          const targetId = optionalText(relation, "targetId", "settlement relationship.targetId", 128);
          const targetName = optionalText(relation, "targetName", "settlement relationship.targetName", 120);
          const relationText = text(relation.relation, "settlement relationship.relation", 1_000);
          if ((!targetId && !targetName) || !relationText) throw new TypeError("settlement relationship requires a target and relation");
          return { targetId, targetName, relation: relationText };
        }),
        timeline: list(character.timeline, `settlement characters[${index}].timeline`, 50, (eventValue, eventIndex) => {
          const event = record(eventValue, `settlement characters[${index}].timeline[${eventIndex}]`);
          allowedKeys(event, `settlement characters[${index}].timeline[${eventIndex}]`, new Set(["event", "change"]));
          const eventText = text(event.event, "settlement timeline.event", 2_000);
          if (!eventText) throw new TypeError("settlement timeline event is required");
          return { event: eventText, change: text(event.change, "settlement timeline.change", 2_000) };
        })
      };
    });

    const hooks = list(source.hooks, "settlement hooks", 300, (item, index) => {
      const hook = record(item, `settlement hooks[${index}]`);
      allowedKeys(hook, `settlement hooks[${index}]`, new Set(["id", "title", "status", "payoff", "notes"]));
      const id = optionalText(hook, "id", `settlement hooks[${index}].id`, 128);
      const title = optionalText(hook, "title", `settlement hooks[${index}].title`, 500);
      if (!id && !title) throw new TypeError(`settlement hooks[${index}] requires id or title`);
      const status = optionalText(hook, "status", `settlement hooks[${index}].status`, 40);
      if (status && !["open", "progressing", "deferred", "resolved"].includes(status)) {
        throw new TypeError(`settlement hooks[${index}].status is invalid`);
      }
      return {
        id,
        title,
        status,
        payoff: optionalText(hook, "payoff", `settlement hooks[${index}].payoff`, 2_000),
        notes: optionalText(hook, "notes", `settlement hooks[${index}].notes`, 5_000)
      };
    });

    return {
      chapter,
      title: text(source.title, "settlement title", 500),
      summary,
      current,
      characters,
      hooks,
      changes: textList(source.changes, "settlement changes", 300)
    };
  } catch (error) {
    if (error?.code === "INVALID_SETTLEMENT") throw error;
    throw settlementError(error.message || "settlement delta is invalid");
  }
}

function jsonObjectSlices(value) {
  const results = [];
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(value.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return results;
}

function extractSettlementDelta(output, depth = 0) {
  if (depth > 5) throw settlementError("settlement output nesting is invalid");
  if (output && typeof output === "object" && !Array.isArray(output)) {
    if (Object.prototype.hasOwnProperty.call(output, "chapter")) return normalizeSettlementDelta(output);
    if (Object.prototype.hasOwnProperty.call(output, "delta")) return extractSettlementDelta(output.delta, depth + 1);
    if (typeof output.content === "string") return extractSettlementDelta(output.content, depth + 1);
    if (output.output && typeof output.output === "object") return extractSettlementDelta(output.output, depth + 1);
  }
  if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > 2 * 1024 * 1024) {
    throw settlementError("settlement output must contain bounded JSON");
  }
  const source = output.trim();
  const candidates = [source];
  for (const match of source.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)) candidates.push(match[1].trim());
  candidates.push(...jsonObjectSlices(source));
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      return extractSettlementDelta(parsed, depth + 1);
    } catch (error) {
      if (error?.code === "INVALID_SETTLEMENT") throw error;
    }
  }
  throw settlementError("settlement output does not contain valid JSON");
}

function stableGeneratedId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value, "utf8").digest("hex").slice(0, 20)}`;
}

function applySettlementDelta(inputState, inputDelta, options = {}) {
  const state = normalizeState(inputState);
  const delta = normalizeSettlementDelta(inputDelta);
  const repair = options.repair === true;
  const currentChapter = state.book.currentChapter;
  if (repair) {
    if (currentChapter < 1 || delta.chapter !== currentChapter) {
      throw settlementError("repair must target the current settled chapter");
    }
  } else if (delta.chapter === currentChapter) {
    throw settlementError("chapter is already settled; use explicit repair mode");
  } else if (delta.chapter !== currentChapter + 1) {
    throw settlementError(`settlement must target the next chapter: ${currentChapter + 1}`);
  }

  const sourceTag = `settlement:chapter:${delta.chapter}`;
  const previousSummary = state.chapterSummaries.find((item) => item.chapter === delta.chapter);
  if (repair && previousSummary) {
    const previousNames = new Set(previousSummary.characters);
    for (const character of state.characters) {
      if (previousNames.has(character.name)) character.appearanceCount = Math.max(0, character.appearanceCount - 1);
      character.timeline = character.timeline.filter((event) => event.source !== sourceTag);
    }
  }

  const byId = new Map(state.characters.map((character) => [character.id, character]));
  const byName = new Map(state.characters.map((character) => [character.name.toLocaleLowerCase("zh-CN"), character]));
  const updates = [];
  const seenCharacters = new Set();
  for (const change of delta.characters) {
    const named = change.name ? byName.get(change.name.toLocaleLowerCase("zh-CN")) : null;
    const identified = change.id ? byId.get(change.id) : null;
    if (named && identified && named !== identified) throw settlementError(`character id/name conflict: ${change.name}`);
    if (named && change.id && named.id !== change.id) throw settlementError(`character name already uses another id: ${change.name}`);
    if (identified && change.name && identified.name !== change.name) throw settlementError(`character id already uses another name: ${change.id}`);
    let character = identified || named;
    if (!character) {
      if (!change.name) throw settlementError(`unknown character requires a name: ${change.id}`);
      character = normalizeCharacter({
        id: change.id || stableGeneratedId("char", change.name),
        name: change.name,
        role: change.role || "",
        appearanceCount: 0
      }, state.characters.length);
      state.characters.push(character);
      byId.set(character.id, character);
      byName.set(character.name.toLocaleLowerCase("zh-CN"), character);
    }
    if (seenCharacters.has(character.id)) throw settlementError(`duplicate settlement character: ${character.name}`);
    seenCharacters.add(character.id);
    updates.push({ character, change });
  }

  for (const { character, change } of updates) {
    if (change.role !== undefined) character.role = change.role;
    if (change.appeared) character.appearanceCount += 1;
    if (change.current) {
      if (change.current.location !== undefined) character.current.location = change.current.location;
      if (change.current.status !== undefined) character.current.status = change.current.status;
    }
    character.current.knowledge = [...new Set([...character.current.knowledge, ...change.knowledgeAdd])];
    for (const relation of change.relationships) {
      const target = relation.targetId
        ? byId.get(relation.targetId)
        : byName.get(relation.targetName.toLocaleLowerCase("zh-CN"));
      if (!target) throw settlementError(`relationship target is unknown: ${relation.targetId || relation.targetName}`);
      const existing = character.current.relationships.find((item) => item.targetId === target.id);
      if (existing) existing.relation = relation.relation;
      else character.current.relationships.push({ targetId: target.id, relation: relation.relation });
    }
    for (const event of change.timeline) {
      character.timeline.push({ chapter: delta.chapter, event: event.event, change: event.change, source: sourceTag });
    }
  }

  if (delta.current) {
    for (const key of ["location", "goal", "conflict", "constraints"]) {
      if (delta.current[key] !== undefined) state.current[key] = delta.current[key];
    }
  }

  const hooksById = new Map(state.hooks.map((hook) => [hook.id, hook]));
  const hooksByTitle = new Map(state.hooks.map((hook) => [hook.title, hook]));
  for (const change of delta.hooks) {
    const byExistingId = change.id ? hooksById.get(change.id) : null;
    const byExistingTitle = change.title ? hooksByTitle.get(change.title) : null;
    if (byExistingId && byExistingTitle && byExistingId !== byExistingTitle) throw settlementError("hook id/title conflict");
    let hook = byExistingId || byExistingTitle;
    if (!hook) {
      if (!change.title) throw settlementError(`unknown hook requires a title: ${change.id}`);
      hook = {
        id: change.id || stableGeneratedId("hook", change.title),
        title: change.title,
        status: "open",
        startChapter: delta.chapter,
        lastAdvancedChapter: delta.chapter,
        payoff: "",
        notes: ""
      };
      state.hooks.push(hook);
      hooksById.set(hook.id, hook);
      hooksByTitle.set(hook.title, hook);
    }
    if (change.title !== undefined) hook.title = change.title;
    if (change.status !== undefined) hook.status = change.status;
    if (change.payoff !== undefined) hook.payoff = change.payoff;
    if (change.notes !== undefined) hook.notes = change.notes;
    hook.lastAdvancedChapter = delta.chapter;
  }

  state.book.currentChapter = delta.chapter;
  state.chapterSummaries = state.chapterSummaries.filter((item) => item.chapter !== delta.chapter);
  state.chapterSummaries.push({
    chapter: delta.chapter,
    title: delta.title,
    summary: delta.summary,
    characters: updates.filter(({ change }) => change.appeared).map(({ character }) => character.name),
    changes: delta.changes
  });
  return normalizeState(state);
}

function etag(state) {
  return `ledger_${crypto.createHash("sha256").update(JSON.stringify(state), "utf8").digest("base64url")}`;
}

function createProjectLedger(options = {}) {
  const projectStore = options.projectStore;
  if (!projectStore || typeof projectStore.openProject !== "function") throw new TypeError("projectStore is required");
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();

  async function readCurrent({ projectId }) {
    const project = await projectStore.openProject(projectId);
    let state;
    let raw = null;
    try {
      raw = await project.readText(LEDGER_PATH);
      state = normalizeState(JSON.parse(raw), { title: project.name });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = normalizeState({ version: 1, revision: 0, updatedAt: "", book: { title: project.name }, current: {}, characters: [], hooks: [], chapterSummaries: [] }, { title: project.name });
    }
    return { etag: etag(state), project, raw, state };
  }

  async function read({ projectId }) {
    const current = await readCurrent({ projectId });
    return { etag: current.etag, state: current.state };
  }

  function nextSavedState(input, project, current) {
    const state = normalizeState(input, { title: project.name, updatedAt: now() });
    state.revision = current.state.revision + 1;
    state.updatedAt = now();
    return state;
  }

  async function save({ projectId, ifMatch, state: input }) {
    const current = await readCurrent({ projectId });
    if (ifMatch !== current.etag) throw Object.assign(new Error("ledger changed; reload before saving"), { code: "ETAG_MISMATCH" });
    const state = nextSavedState(input, current.project, current);
    await current.project.writeTexts([{
      relativePath: LEDGER_PATH,
      content: `${JSON.stringify(state, null, 2)}\n`,
      expectedContent: current.raw
    }], { transactionId: `ledger-${crypto.randomUUID()}` });
    return { etag: etag(state), state };
  }

  async function settle({ projectId, ifMatch, output, delta, repair = false }) {
    const parsedDelta = delta === undefined ? extractSettlementDelta(output) : normalizeSettlementDelta(delta);
    const current = await read({ projectId });
    if (ifMatch !== current.etag) throw Object.assign(new Error("ledger changed; reload before settling"), { code: "ETAG_MISMATCH" });
    const state = applySettlementDelta(current.state, parsedDelta, { repair });
    return save({ projectId, ifMatch, state });
  }

  async function commitChapter({ projectId, ifMatch, relativePath, content, output, delta, repair = false }) {
    const parsedDelta = delta === undefined ? extractSettlementDelta(output) : normalizeSettlementDelta(delta);
    const current = await readCurrent({ projectId });
    if (ifMatch !== current.etag) throw Object.assign(new Error("ledger changed; reload before committing"), { code: "ETAG_MISMATCH" });
    const settled = applySettlementDelta(current.state, parsedDelta, { repair });
    const state = nextSavedState(settled, current.project, current);
    const [artifact] = await current.project.writeTexts([
      { relativePath, content },
      {
        relativePath: LEDGER_PATH,
        content: `${JSON.stringify(state, null, 2)}\n`,
        expectedContent: current.raw
      }
    ], { transactionId: `chapter-${parsedDelta.chapter}-${crypto.randomUUID()}` });
    return { artifact, etag: etag(state), state };
  }

  return Object.freeze({ commitChapter, read, save, settle });
}

module.exports = {
  LEDGER_PATH,
  applySettlementDelta,
  characterTier,
  createProjectLedger,
  extractSettlementDelta,
  normalizeSettlementDelta
};
