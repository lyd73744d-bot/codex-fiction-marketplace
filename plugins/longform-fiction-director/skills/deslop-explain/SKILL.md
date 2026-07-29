---
name: deslop-explain
description: Diagnose Chinese explain-y summary voice and lecturer tone; under longform-fiction-director, route the actual prose rewrite to an external model after per-call consent.
---

# 去AI味：解释腔 / 总结腔

> 主流程分工：Codex 诊断并验收，外部写作模型默认改正文；作者明确要求 Codex 写临时候选时才本地改。

## 铁律（先于下面所有改法）
- 换皮不算改：同义替换（这意味着→也就是说、不难看出→显而易见）仍是 AI 味。
- 只删表现手段，保留可核对事实（数字 / 物件 / 因果 / 伏笔 / 人物选择）。
- 删套话后补回现场功能，不补造五感、动作、比喻、天气、心理。综合改味见 `humanizer-zh`。

## 典型句
- 这意味着……
- 不难看出……
- 他明白了一个道理……
- 从这一刻起，一切都不一样了

## 改法
1. 删掉结论句，改写为具体选择或损失
2. 角色不要替读者总结主题
3. 需要信息时，用行动失败/对话试探带出
4. 主题让读者自己品，不写进旁白讲义
5. 对白和动作已经显出的动机、情绪与关系变化不再紧跟一句标准答案，不替读者翻译潜台词；留白可由反应、上下文或后果读回，关键事实仍须清楚

不得把留白做成谜语：不堆省略号，不故意删掉理解剧情必需的信息，也不让所有人机械地欲言又止。

## 输出
去解释腔后的候选 txt。
