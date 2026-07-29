---
name: deslop-hook
description: Diagnose weak or cheap chapter-end hooks and provide rewrite constraints; under longform-fiction-director, route the actual prose rewrite to an external model after per-call consent.
---

# 章尾钩子打磨

> 主流程分工：Codex 诊断并验收，外部写作模型默认改正文；作者明确要求 Codex 写临时候选时才本地改。

## 铁律（先于下面所有改法）
- 换皮不算改：同义替换（一切才刚开始→好戏还在后头）仍是 AI 味。
- 只删表现手段，保留可核对事实（数字 / 物件 / 因果 / 伏笔 / 人物选择）。
- 钩子从已有因果长出，不补造新黑影、新预告、新五感。综合改味见 `humanizer-zh`。

## 好钩子
- 新压力落地
- 人物选择把后路堵死
- 读者想知道“他下一步怎么扛”

## 烂钩子
- 无来由惊吓
- “一切才刚刚开始”
- 与本章因果无关的黑影一闪

## 流程
1. 确认本章主冲突是否兑现
2. 钩子从已有因果长出
3. 只改尾段，写入候选 txt
