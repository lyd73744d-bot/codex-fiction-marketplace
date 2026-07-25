"use strict";

(function expose(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ZizhujiCommandState = api;
})(typeof globalThis === "object" ? globalThis : this, () => {
  function createCommandState() {
    return { selectedModelIds: [], tasks: [], selectedTaskId: null };
  }

  function toggleModel(state, modelId, enabled) {
    const selectedModelIds = state.selectedModelIds.filter((id) => id !== modelId);
    if (enabled) selectedModelIds.push(modelId);
    return { ...state, selectedModelIds };
  }

  function addTask(state, task) {
    const tasks = [{ ...task }, ...state.tasks.filter((item) => item.id !== task.id)].slice(0, 50);
    return { ...state, tasks, selectedTaskId: task.id };
  }

  function updateTask(state, patch) {
    return {
      ...state,
      tasks: state.tasks.map((task) => task.id === patch.id ? { ...task, ...patch } : task)
    };
  }

  function selectTask(state, taskId) {
    return { ...state, selectedTaskId: taskId };
  }

  function isTerminalStatus(status) {
    return ["completed", "failed", "cancelled", "canceled"].includes(status);
  }

  function enqueueRecoverable(previous, operation) {
    return Promise.resolve(previous).catch(() => undefined).then(operation);
  }

  return Object.freeze({ createCommandState, toggleModel, addTask, updateTask, selectTask, isTerminalStatus, enqueueRecoverable });
});
