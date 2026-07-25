"use strict";
const path = require("node:path");
const { ensureSoftLedgers, getGuidedStatus } = require("./guided-stage-service");
const { ensureBrainstormBoard } = require("./brainstorm-service");
const { ensureProjectWritingSkill } = require("./sample-learn-service");
async function bootstrapProject(projectDir, { title = "" } = {}) {
  if (!projectDir) throw new Error("projectDir required");
  const soft = await ensureSoftLedgers(projectDir);
  const brain = await ensureBrainstormBoard(projectDir);
  const skill = await ensureProjectWritingSkill(projectDir, { currentBook: title || path.basename(projectDir) });
  const guided = await getGuidedStatus(projectDir);
  return { ok: true, projectDir, soft, brainstormPath: brain.path, writingSkillPath: skill.path, guided, coach: "项目已初始化为引导模式。先脑洞，再样书，不要直接写正文。" };
}
module.exports = { bootstrapProject };