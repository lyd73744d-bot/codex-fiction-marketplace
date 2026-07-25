# 什么时候用模型

## 本地优先（先别烧积分）
- 问清脑洞、拆卡点、解释进度
- 建软台账、控制卡骨架
- 本地样书粗提、文风统计对比

## 建议上模型
- 样书深挖（`fiction_deep_learn_sample`）
- 正文初稿（`fiction_generate_to_file`）
- 去AI味/润色/找硬伤（`fiction_optimize_with_models`）
- 多模型交叉看问题

## 选型粗原则
- 探索/脑暴：便宜快模型
- 正文：中强叙事模型
- 找硬伤/定稿：更强模型
- 以 `fiction_recommend_models` + 实时目录为准

## 传输
流式优先 → 重试 → 非流式兜底 → 完整写入 Codex候选 txt（.body 可再读）
