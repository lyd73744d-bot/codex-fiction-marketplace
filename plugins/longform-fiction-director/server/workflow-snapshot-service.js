"use strict";

const { getFirstRunCoach } = require("./first-run-coach-service");
const { getGuidedStatus } = require("./guided-stage-service");
const { assessPipeline } = require("./pipeline-coach-service");
const { getProductGuide } = require("./product-guide");
const { getGoldenThreeStatus } = require("./golden-three-service");
const { readContinuousMode } = require("./continuous-mode");
const { listSampleBooks } = require("./sample-book-service");
const { listArtifacts } = require("./artifact-pipeline");
const onboarding = require("./onboarding-state");

async function getWorkflowSnapshot(projectDir = "", { includeGuide = true } = {}) {
  const guide = includeGuide ? getProductGuide() : null;
  let onboardingState = null;
  try { onboardingState = await onboarding.readState(); } catch {}
  const firstRunCoach = await getFirstRunCoach(projectDir || "");

  if (!projectDir) {
    return {
      ok: true,
      scope: "global",
      firstRunCoach,
      onboarding: onboardingState ? {
        pendingFirstLogin: !!onboardingState.pendingFirstLogin,
        firstLoginCompletedAt: onboardingState.firstLoginCompletedAt,
        shopUrl: onboardingState.shopUrl
      } : null,
      product: guide,
      coach: firstRunCoach.coach || "先 bootstrap/打开项目目录，再按引导阶段推进。首次使用先登录网关。"
    };
  }

  const [guided, pipeline, golden, continuous, samples, artifacts] = await Promise.all([
    getGuidedStatus(projectDir),
    assessPipeline(projectDir),
    getGoldenThreeStatus(projectDir),
    readContinuousMode(projectDir),
    listSampleBooks(projectDir),
    listArtifacts(projectDir, { limit: 8 })
  ]);

  return {
    ok: true,
    scope: "project",
    projectDir,
    firstRunCoach,
    onboarding: onboardingState ? {
      pendingFirstLogin: !!onboardingState.pendingFirstLogin,
      firstLoginCompletedAt: onboardingState.firstLoginCompletedAt,
      shopUrl: onboardingState.shopUrl
    } : null,
    guided: {
      stage: guided.stage,
      index: guided.index,
      total: guided.total,
      askNow: guided.askNow,
      recommendedTools: guided.recommendedTools,
      advice: guided.advice
    },
    pipeline: {
      canDraft: pipeline.canDraft,
      nextAction: pipeline.nextAction,
      hardBlockers: pipeline.hardBlockers,
      softMissing: pipeline.softMissing,
      coach: pipeline.coach
    },
    samples: { count: (samples.items || []).length, names: (samples.items || []).map((x) => x.name) },
    artifacts: { count: (artifacts.items || []).length, latest: (artifacts.items || []).slice(0, 3) },
    goldenThree: golden,
    continuous: {
      enabled: continuous.enabled === true,
      goldenThreeReady: continuous.goldenThreeReady === true,
      note: continuous.note
    },
    product: guide,
    coach: firstRunCoach.coach || pipeline.coach || guided.advice || "继续引导，不要直接一键长篇。"
  };
}

module.exports = { getWorkflowSnapshot };
