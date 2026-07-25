# InkOS 长篇能力路由

本路由把旧桌面版的细碎按钮收回到 Codex 自然语言编排中。它保留能力，不保留固定套路。先以空对象 `{}` 调用 `fiction_list_capabilities` 获取当前安装版本的能力目录；每项的 `legacyActions` 用于追溯旧 InkOS 动作，`taskKind` 是实际任务路由，`id` 是稳定能力 ID。例如 `outline-logic-check` 的 `legacyActions` 包含 `outline:logicVerify`。

## 调用格式

`fiction_run` 的必填字段是 `projectId`、`kind`、`instruction`。可选字段包括 `specialistId`、`modelIds` 和 `ledgerFiles`：

- `projectId`：插件项目 ID，不是任意文件路径。
- `kind`：使用能力目录返回的 `taskKind`。
- `instruction`：作者当前的自然语言要求。
- `specialistId`：仅在目录项的 `taskKind` 为 `specialist` 时传该项 `id`。
- `modelIds`：先以空对象调用 `fiction_list_models`，再从已登录账户返回的模型中按角色选择；可以为空。
- `ledgerFiles`：只在需要限制台账上下文时传相对台账文件名；省略时服务自动读取有界项目方向和默认台账上下文。不要构造 `context` 或上传整个项目。

大纲因果检查示例：

```json
{
  "projectId": "当前项目ID",
  "kind": "specialist",
  "specialistId": "outline-logic-check",
  "instruction": "检查当前大纲的因果链、人物动机和伏笔回收，不预设卷数或章数。",
  "modelIds": ["已选择的结构模型", "已选择的连续性模型"],
  "ledgerFiles": ["facts.md"]
}
```

服务会自动读取有界的项目方向、`.fiction-director/blueprint.md` 已确认蓝图、`.fiction-director/working/outline.md` 工作大纲和允许的台账内容，把能力目录中的专项边界加入模型提示；不存在的文件会跳过。调用者不手工拼接私密项目上下文。

## 专项任务

以下意图在能力目录返回 `taskKind: "specialist"` 时调用 `fiction_run`，并设置对应的 `specialistId`：

- 标题、简介、开篇纪律和黄金开场诊断。
- 角色板、人物弧光、关系变化、人物声音和角色写回建议。
- 世界观、题材库、同人或 VIP 题材约束、背景资料研究。
- 大纲逻辑检查、因果缺口、伏笔回收、节奏和数值体系审计。
- 章节质量检查、自我批评、风格提炼、梗与对白检查、去 AI 味检查。
- 改稿方案、逐段修订、三章连续回看、后续章节写回建议。
- RAG 资料检索建议、基准样本分析、项目经验总结和候选规则提炼。
- 封面文案与封面提示词；需要生成图片时再调用可用的图像生成 Skill，不把图片能力伪装成文本模型能力。

专项任务必须带入有界项目状态和相关台账。可按任务选择结构模型、正文模型、连续性模型或多个模型；Codex 综合结果，不做简单投票。

## 独立能力

- 脑洞与方向：`brainstorm`
- 大纲候选与确认：`outline`
- 章节意图：`chapter-brief`
- 正文草稿：`draft`
- 审稿：`review`
- 公开番茄榜证据：`market-scan`
- 授权下载与书源登记：`fiction_download_book`
- 已登记书源拆解：`fiction_deconstruct_book`
- 作者确认后的台账事务：`settle`

## 写入规则

所有 `specialist` 结果只写入 `.fiction-director/working/specialist/`。它们是候选工件，不得自动改正式正文、蓝图或台账，也不能自动落账。作者确认采用后，再由对应的大纲、写作、审稿或落账任务执行。
