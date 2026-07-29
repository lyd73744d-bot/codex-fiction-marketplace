---
name: deslop-emotion
description: Diagnose emotional-label prose and provide protected rewrite methods; under longform-fiction-director, route the actual prose rewrite to an external model after per-call consent.
---

# 去AI味：情绪

> 主流程分工：Codex 诊断并验收，外部写作模型默认改正文；作者明确要求 Codex 写临时候选时才本地改。

## 铁律（先于下面所有改法）
- 换皮不算改：同义替换（倒吸凉气→吸凉气、下一秒→紧接着）仍是 AI 味。
- 只删表现手段，保留可核对事实（数字 / 物件 / 因果 / 伏笔 / 人物选择）。
- 删套话后补回现场功能，不补造五感、动作、比喻、天气、心理。综合改味见 `humanizer-zh`。

## 禁
- “他很愤怒/她很悲伤”直接贴标签
- 大段心中暗想解释自己为什么难过
- 全员同一套煽情句式

## 做
1. 原文已有动作/后果 → 情绪落到那个有目的的动作、停顿或选择
2. 原文只有明确情绪、没有可用动作 → 直说"又怕又怒"，**不补造身体反应**
3. 情绪已写清后，不再补"心里乱得说不清是什么滋味"这类同义重复
4. 让对话先硬后软、或先躲后爆，用现场关系承载情绪
5. 对照人物卡：此人会不会当众失态
6. 只保留会改变下一步选择的念头

> 最常见的 AI 味来源：把"他很愤怒"一律换成"眼神一沉/心头一震/拳头缓缓握紧"。那是换了一套模板，不是去味——没有动作依据时就直写情绪。

## 输出
候选 txt；剧情因果不动。
