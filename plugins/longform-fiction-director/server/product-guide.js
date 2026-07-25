"use strict";

function getProductGuide() {
  return {
    product: "写小说真的太简单了 / longform-fiction-director",
    role: "辅助责编，不是一键工厂",
    login: {
      firstInstall: "强制弹网关登录窗（含积分小店）",
      afterLogin: "不乱弹",
      sessionDrop: "再提醒",
      shopUrl: process.env.FICTION_DIRECTOR_PAYMENT_PORTAL_URL || "https://catfk.com/shop/ZVZNANU8",
      note: "不充值也能写，但多模型效果会差很多"
    },
    transport: {
      prefer: "stream",
      retry: "多次",
      fallback: "non-stream",
      persist: "Codex候选/*.txt + .body.txt（模型可读）"
    },
    workflow: [
      "脑洞",
      "样书入库/学手法",
      "文风锚点",
      "大纲",
      "联网核验（防OOC）",
      "人物卡",
      "细纲控制卡",
      "初稿候选txt",
      "多模型优化/去AI味",
      "作者确认入台账"
    ],
    hiddenContinuous: {
      default: false,
      require: "黄金三章就绪 + 作者明确授权短语",
      doNotAdvertise: true
    },
    toolsByStage: {
      boot: ["fiction_first_run_coach", "fiction_bootstrap_project", "fiction_get_guided_status", "fiction_assess_pipeline"],
      gateway: ["fiction_open_gateway_login", "fiction_ensure_gateway", "fiction_account_status", "fiction_list_models", "fiction_recommend_models", "fiction_smoke_live_gateway"],
      brainstorm: ["fiction_get_brainstorm_coach", "fiction_update_brainstorm"],
      sample: ["fiction_import_sample_book", "fiction_learn_sample_techniques", "fiction_deep_learn_sample"],
      voice: ["fiction_upsert_voice_anchor", "fiction_compare_style"],
      outline: ["fiction_create_outline"],
      research: ["fiction_plan_research", "fiction_create_research_doc", "fiction_append_research_findings", "fiction_ensure_fact_library", "fiction_upsert_facts", "fiction_check_continuity"],
      characters: ["fiction_create_character_card"],
      brief: ["fiction_create_chapter_brief"],
      draft: ["fiction_build_draft_packet", "fiction_generate_to_file", "fiction_write_local_candidate", "fiction_read_artifact"],
      optimize: ["fiction_optimize_with_models", "fiction_compare_style", "fiction_list_deslop_methods"],
      confirm: ["fiction_confirm_chapter_ledgers"]
    },
    optimizeFocus: ["full", "dialogue", "narration", "pacing", "emotion", "info", "hook", "explain"],
    modelModes: { quick: "省积分/日常正文", deep: "定稿/找硬伤/作者点名旗舰", tool: "fiction_recommend_models", note: "辅助建议，不强制" },
  coachRules: [
      "多询问，一次一个主下一步",
      "真实内容必须联网回填",
      "候选确认前不入正式正文",
      "不默认推销连续一键长篇"
    ]
  };
}

module.exports = { getProductGuide };
