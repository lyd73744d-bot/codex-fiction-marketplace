---
name: humanizer-methods
description: Diagnose Chinese deslop problems and route the method package to an external prose-optimization model under longform-fiction-director; ask per call and save candidate txt. Codex edits locally only when explicitly requested.
---

# 去AI味方法路由

## 角色边界

Codex 负责诊断、选焦点、整理保护项和验收；外部写作模型默认负责实际改写。作者拒绝模型时，不自动本地改全文，只问继续明确修改任务，还是由 Codex 做一版临时候选。

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

## 四条铁律（所有 deslop 子技能通用，优先级最高）

`humanizer-zh` 是母技能。不管调下面哪个子技能，这四条都不能破：

1. **禁止同义词逃逸**：换皮不算改。"所有人倒吸凉气→众人吸凉气""空气凝固→四下沉寂""下一秒→紧接着"都仍是 AI 味。
2. **分清事实与表达**：可核对的事实（数字、物件、因果、伏笔、人物选择、视角）必须留；要删的是表现手段（群体震惊、空氛围、预制宣言、万能身体反应）。
3. **删模板→补功能，不是补新套话**：删掉套话后补回它在现场承担的信息或反应；缺了信息就补具体事实，不补一句更漂亮的空话。
4. **不补造**：不为"证明改过"新增五感、动作、比喻、天气、心理、网络梗。默认轻改，拿不准就少改。

综合改味用 `humanizer-zh`；只有单一症状时再用下面的专项子技能。

## 执行纪律
1. 先读人物卡、细纲、核验文档
2. 改腔不改剧情
3. 调用外部模型前重新询问；作者当次选择使用后才以 `authorConfirmed: true` 调用 `fiction_optimize_with_models`。作者拒绝时不自动改全文；只有明确要求 Codex 改临时候选，才用 `fiction_write_artifact`
4. 结果写入 `Codex候选` txt；`.body.txt` 可再喂模型
5. 作者确认前不覆盖正式正文

可参考：
- skills/humanizer-zh/SKILL.md
- skills/humanizer-methods/references/humanizer-chapter-revise.md
