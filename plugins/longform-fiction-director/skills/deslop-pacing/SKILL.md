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
2. 太水：描写很多，冲突不前进

## 四拍检查
施压 → 反应 → 代价/选择 → 钩子

缺哪拍补哪拍；多出来的抒情/解释先砍。

## 做法
1. 标出本章唯一主冲突
2. 每段只保留一个功能
3. 长段拆短，短段别连珠空响
4. 章尾钩子必须从已有因果长出

## 输出
节奏修订候选 txt，不覆盖未确认正文。
