# 内置写作工作流

插件已内置本地写作工作流，不必再单独携带“工作流资料”文件夹。

## 内置位置
- 项目模板：`assets/workflow/project-template/`
- 通用辅助文档母版：`assets/workflow/auxiliary-base/`
- 说明文档：`assets/workflow/docs/`

## 新书怎么开
1. Codex 直接在指定书目录内建好中文台账模板（参照 `assets/workflow/project-template/`）
2. Codex 读取并**记住**要长期重读的资料清单：
   - `辅助文档/00_使用说明与当前状态.md`
   - 人物/设定/时间线/伏笔等
   - 文风锚点与授权参考（如有）
3. 每次生成正文或做终检前重读这份清单

## 默认一步步
整理资料清单 → Codex 问清脑洞 → 接入题材责编 → 可选外部发散/优化 → 作者定方向 → 细纲 → 候选正文 → 去AI味(可选) → 质检(可选) → 确认入台账

## 连续跑
作者授权连续流程后仍需在每次外部模型调用前询问；当次确认后才以 `authorConfirmed: true` 调用 `fiction_generate_to_file`：
- to_draft：细纲 → 正文
- chapter_once：细纲 → 正文 → 去AI味 → 质检
- polish_once：去AI味 → 质检
- multi_chapter：循环 chapter_once

不自动 settle；作者确认后 Codex 才把定稿写入 `正文/` 并更新台账。

## 模型
选择使用其他模型并永久绑定后即可调用。只有未登录时才打开登录页。


## 提示词增强（已内置）
- 控制卡：chapter-control-card.md
- 钩子爽点：hook-shuangdian-checklist.md
- 去AI分级：deslop-grades.md
- 里程碑状态摘要：delivery-dashboard.md（只在整章完成、质检完成或作者问进度时使用）
- 拆解备忘：prompt-lessons-from-peers.md
- 题材责编：genre-recipes.md
- 责编口吻：editor-voice.md
