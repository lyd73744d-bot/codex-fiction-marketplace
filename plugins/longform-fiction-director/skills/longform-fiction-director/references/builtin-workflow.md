# 内置写作工作流

插件已内置本地写作工作流，不必再单独携带“工作流资料”文件夹。

## 内置位置
- 项目模板：`assets/workflow/project-template/`
- 说明文档：`assets/workflow/docs/`

## 新书怎么开
1. Codex 直接在指定书目录内建好中文台账模板（参照 `assets/workflow/project-template/`）
2. Codex 读取并**记住**要长期重读的资料清单：
   - `辅助文档/00_使用说明与当前状态.md`
   - 人物/设定/时间线/伏笔等
   - 文风锚点与授权参考（如有）
3. 每次生成正文或做终检前重读这份清单

## 默认协作
作者可以从脑洞、大纲、细纲、正文、改稿或续写中的任何位置进入。Codex 先判断当前任务，只补会影响这一步的最少资料；需要模型时单独询问，正文默认直接写入 `正文/`，确认采用后才更新台账。阶段判断统一读取 `commercial-fiction-principles.md`，不让作者重新走一套固定流程。

## 连续处理
作者明确授权连续处理时，可以连续准备和生成正文，但每次外部模型调用仍单独询问。去 AI 味和质检按实际问题使用，不作为每章必跑步骤。同一章重写默认覆盖正文文件；作者确认采用后，Codex 才更新发生变化的台账。

## 模型
选择使用其他模型并永久绑定后即可调用。只有未登录时才打开登录页。


## 提示词增强（已内置）
- 全局自然写作制度：natural-writing-system.md
- 分阶段故事判断：commercial-fiction-principles.md
- 可选章节笔记：chapter-control-card.md（旧文件名仅为兼容）
- 可选平台节奏观察：hook-shuangdian-checklist.md
- 去AI分级：deslop-grades.md
- 里程碑状态摘要：delivery-dashboard.md（只在整章完成、质检完成或作者问进度时使用）
- 拆解备忘：prompt-lessons-from-peers.md
- 题材责编：genre-recipes.md
- 责编口吻：editor-voice.md
