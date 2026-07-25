---
name: humanizer-methods
description: Route Chinese deslop work to the right micro-method skill plus humanizer-zh; always save candidate txt.
---

# 去AI味方法路由

不要一上来整章乱改。先判断问题类型，再调用对应 skill：

| 症状 | 用 |
|---|---|
| 对话假、轮流演讲 | deslop-dialogue |
| 叙述空、排比总结 | deslop-narration |
| 太赶或太水 | deslop-pacing |
| 情绪贴标签 | deslop-emotion |
| 设定倾倒 | deslop-info-dump |
| 章尾廉价悬念 | deslop-hook |
| 解释腔/主题总结 | deslop-explain |
| 综合改味 | humanizer-zh |

## 执行纪律
1. 先读人物卡、细纲、核验文档
2. 改腔不改剧情
3. 优先 `fiction_optimize_with_models` 或本地改后 `fiction_write_artifact`
4. 结果写入 `Codex候选` txt；`.body.txt` 可再喂模型
5. 作者确认前不覆盖正式正文

可参考：
- skills/humanizer-zh/SKILL.md
- server/zizhuji-compat/resources/prompts/sources/humanizer-chapter-revise.md
