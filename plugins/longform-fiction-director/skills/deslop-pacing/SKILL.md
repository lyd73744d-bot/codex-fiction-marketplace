---
name: deslop-pacing
description: Diagnose rushed or bloated Chinese chapter pacing and provide protected rewrite constraints; under longform-fiction-director, route the actual prose rewrite to an external model after per-call consent.
---

# 去AI味：节奏

> 主流程分工：Codex 诊断并验收，外部写作模型默认改正文；作者明确要求 Codex 写临时候选时才本地改。

## 铁律（先于下面所有改法）
- 换皮不算改：同义替换（倒吸凉气→吸凉气、下一秒→紧接着）仍是 AI 味。
- 只删表现手段，保留可核对事实（数字 / 物件 / 因果 / 伏笔 / 人物选择）。
- 删套话后补回现场功能，不补造五感、动作、比喻、天气、心理。综合改味见 `humanizer-zh`。

## 两类病
1. 太赶：转场连跳，读者跟不上代价
2. 太水：同一信息和情绪反复解释，读者没有得到新的理解

## 因果与停留

不套固定拍数。先看人物在做什么、为什么这样做、做完改变了什么；中间允许观察、犹豫、日常动作、关系余波和没有新事件的停留。只有因果断裂或同义反复时才调整。

## 做法
1. 标出本章正在处理的主要事情，不强求唯一冲突
2. 保住动作、位置、信息和情绪的连续性
3. 只压缩重复解释；段落可以同时承担动作、观察和关系变化
4. 收尾可以完成一件事，也可以停在余波、未完成动作或关系变化上，不强制悬念

## 输出
节奏修订候选 txt，不覆盖未确认正文。
