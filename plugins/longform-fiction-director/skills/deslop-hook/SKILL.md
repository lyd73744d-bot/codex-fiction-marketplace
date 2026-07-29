---
name: deslop-hook
description: Diagnose weak or cheap chapter-end hooks and provide rewrite constraints; under longform-fiction-director, route the actual prose rewrite to an external model after per-call consent.
---

# 收尾去预制

> 主流程分工：Codex 诊断并验收，外部写作模型默认改正文；作者明确要求 Codex 写临时候选时才本地改。

## 铁律（先于下面所有改法）
- 换皮不算改：同义替换（一切才刚开始→好戏还在后头）仍是 AI 味。
- 只删表现手段，保留可核对事实（数字 / 物件 / 因果 / 伏笔 / 人物选择）。
- 不补造新黑影、新预告、新五感。综合改味见 `humanizer-zh`。

章节不一定需要钩子。自然收尾可以是具体结果、一个动作完成后的余波、关系变化、仍在继续的日常，或确实存在的未完成行动。

## 自然收尾
- 由本章已经发生的事自然停住
- 人物选择产生了具体结果
- 最后一个动作、物件或对白仍属于这个场景

## 烂钩子
- 无来由惊吓
- “一切才刚刚开始”
- 与本章因果无关的黑影一闪

## 流程
1. 确认本章主冲突是否兑现
2. 判断原文需要完成、停留还是保留未完成行动
3. 只改确有问题的尾段，写入候选 txt
