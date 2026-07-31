"use strict";

const { createRankingService } = require("./ranking-source-service");

function annotations({ readOnly = false, openWorld = false } = {}) {
  return { readOnlyHint: readOnly, openWorldHint: openWorld, destructiveHint: false };
}

function result(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

const definitions = [
  {
    name: "fiction_rank_sources",
    description: "List supported public Fanqie and Qidian rankings, channels, and categories. Fanqie categories are read live from its public catalog. This tool never calls a model.",
    annotations: annotations({ readOnly: true, openWorld: true }),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        platform: { type: "string", enum: ["fanqie", "qidian"] }
      }
    }
  },
  {
    name: "fiction_scan_rankings",
    description: "Read a current public Fanqie or Qidian ranking and optionally save a factual Markdown plus JSON snapshot under the writing project. It does not copy novel prose or make market predictions, and it never calls a model.",
    annotations: annotations({ readOnly: false, openWorld: true }),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["platform", "rank"],
      properties: {
        platform: { type: "string", enum: ["fanqie", "qidian"] },
        rank: { type: "string", maxLength: 60 },
        channel: { type: "string", maxLength: 40 },
        category: { type: "string", maxLength: 80 },
        period: { type: "string", pattern: "^[0-9]{6}$" },
        limit: { type: "number", minimum: 1, maximum: 30 },
        save: { type: "boolean" },
        projectDir: { type: "string", maxLength: 1024 }
      }
    }
  },
  {
    name: "fiction_compare_rank_snapshots",
    description: "Compare two saved ranking JSON snapshots, or the latest two matching snapshots, without calling a model. It reports entries, exits, and rank movement only; it does not claim a long-term trend.",
    annotations: annotations({ readOnly: false, openWorld: false }),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["projectDir"],
      properties: {
        projectDir: { type: "string", maxLength: 1024 },
        snapshotA: { type: "string", maxLength: 1024 },
        snapshotB: { type: "string", maxLength: 1024 },
        platform: { type: "string", enum: ["fanqie", "qidian"] },
        rank: { type: "string", maxLength: 60 },
        category: { type: "string", maxLength: 80 },
        save: { type: "boolean" }
      }
    }
  }
];

function createRankingMcpTools(options = {}) {
  const service = options.service || createRankingService(options);
  const names = new Set(definitions.map((tool) => tool.name));

  async function call(name, input = {}) {
    if (name === "fiction_rank_sources") return result(await service.listSources(input.platform || ""));
    if (name === "fiction_scan_rankings") {
      const snapshot = await service.scanRankings(input);
      if (input.save === true) {
        snapshot.saved = await service.saveSnapshot(input.projectDir, snapshot);
      }
      return result(snapshot);
    }
    if (name === "fiction_compare_rank_snapshots") return result(await service.compareSnapshots(input));
    const error = new Error(`Unknown ranking tool: ${name}`);
    error.code = names.has(name) ? "INVALID_ARGUMENT" : "TOOL_NOT_FOUND";
    throw error;
  }

  return Object.freeze({
    has: (name) => names.has(name),
    list: () => definitions.map((tool) => ({ ...tool })),
    call
  });
}

module.exports = { createRankingMcpTools };
