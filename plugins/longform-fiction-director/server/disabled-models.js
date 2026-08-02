"use strict";

// Models deliberately removed from this plugin stay unavailable even when an
// older account gateway still returns them in its live catalog.
const DISABLED_MODEL_IDS = new Set(["kimi-k3"]);

function normalizeModelId(value) {
  return String(value || "").trim().toLowerCase();
}

function isDisabledModel(value) {
  return DISABLED_MODEL_IDS.has(normalizeModelId(value));
}

function filterDisabledModels(models) {
  return (Array.isArray(models) ? models : []).filter((model) => {
    const id = typeof model === "string" ? model : model && model.id;
    return !isDisabledModel(id);
  });
}

module.exports = {
  DISABLED_MODEL_IDS,
  isDisabledModel,
  filterDisabledModels
};
