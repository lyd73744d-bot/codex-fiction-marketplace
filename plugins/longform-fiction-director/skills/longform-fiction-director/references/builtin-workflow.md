# 内置写作工作流

插件已内置本地写作工作流，不必再单独携带“工作流资料”文件夹。

## 内置位置
- 项目模板：`assets/workflow/project-template/`
- 通用辅助文档母版：`assets/workflow/auxiliary-base/`
- 说明文档：`assets/workflow/docs/`

## 新书怎么开
1. 调用 `fiction_create_project`（自动带中文台账模板），或
2. 调用 `fiction_scaffold_book_folder` 把模板写到指定书目录
3. 用 `fiction_bind_quality_context` 绑定：
   - `辅助文档/00_使用说明与当前状态.md`
   - 人物/设定/时间线/伏笔等
   - 文风锚点与授权参考（如有）

## 默认一步步
绑定 → 脑洞(本地) → 细纲 → 候选正文 → 去AI味(可选) → 质检(可选) → 确认入台账

## 连续跑
`fiction_workflow_guide` + continuousPreset：
- to_draft
- chapter_once
- polish_once
- multi_chapter

不自动 settle；作者确认后才入台账。

## 模型
有积分即可调用。细纲/正文/去AI味/质检前先打开模型登录页确认。


## 提示词增强（已内置）
- 控制卡：chapter-control-card.md
- 钩子爽点：hook-shuangdian-checklist.md
- 去AI分级：deslop-grades.md
- 仪表盘：delivery-dashboard.md
- 拆解备忘：prompt-lessons-from-peers.md
