---
name: style-compare
description: Compare draft style against sample-book notes and voice anchors; give executable fixes.
---

# 文风对比

## 输入
- 当前候选正文（优先 plainPath）
- `样书/*/00_手法学习笔记.md`
- `辅助文档/06_风格与写作要求.md`
- `辅助文档/08_事实库_防OOC.md`

## 对比维度
1. 句长与段节奏
2. 对话密度
3. 信息投放早晚
4. 情绪表达方式
5. 章尾钩子习惯

## 输出格式
- 像样书的 3 点
- 走样的 3 点
- 下一次改稿只动的 3 个动作
- 需要的话调用 `fiction_compare_style` 并落盘候选
