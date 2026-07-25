# 多模型编排（辅助建议）

> 本插件永远是**辅助位**。模型推荐是责编建议，作者可随时覆盖。

## 怎么接入模型

1. 配置网关（二选一）
   - 字字珠玑账号网关（legacy）
   - OpenAI 兼容源：%LOCALAPPDATA%\\Zizhuji\\longform-fiction-director\\primary-gateway.json
     字段：mode=openai, baseUrl, apiKey, allowedModels, modelCredits, preferredModel
2. MCP 启动后先调 fiction_list_models 看当前真正可用的模型。
3. 再调 fiction_recommend_models，传入任务类型（draft/outline/humanize/review…）。
4. 写稿时优先 fiction_generate_to_file：非流式完整生成 → 写到 Codex候选/*.txt → 再 fiction_read_artifact 读取。

## 任务 → 模型角色

| 任务 | 角色 | 默认倾向 |
|---|---|---|
| 脑洞/市场 | 探索 | flash / luna / 低积分 |
| 大纲/细纲/控制卡 | 结构 | terra / sonnet / kimi / glm |
| 正文候选 | 主写 | claude-opus-4-6 / claude-opus-4-7 / claude-opus-4-8 / claude-sonnet-5 / terra / kimi |
| 去AI味 | 风格 | claude-sonnet-5 / terra / kimi |
| 质检 | 审核+连续 | claude-sonnet-5 / terra；硬伤再上 claude-opus-4-6/4-8 |
| 定稿 | 成稿 | claude-opus-4-6 / claude-opus-4-8（作者确认前） |

## Codex 对作者的说话方式

- 先报进度与下一步，再报「建议模型 + 大概积分」
- 默认够用就行，不堆旗舰
- 结果先落候选 txt，确认后才入正文/台账
- 调用失败：保留已成功结果与错误，不静默重复扣费

## 传输纪律（重要）

流式 SSE 经常半截断开。本融合版默认：

1. callModels 先走 stream:false 拿完整 JSON
2. 失败再回退 SSE 一次
3. 业务层用 fiction_generate_to_file 把全文写 txt
4. 展示/质检都读文件，不靠聊天窗口里的半截流

## 调用纪律

1. 只从 fiction_list_models 返回的清单里选
2. 不在项目文件里存密钥
3. 每个模型只拿完成角色所需的最小上下文
4. 原始结果独立落盘（候选 txt），Codex 再综合
5. 不以多数票代替判断
6. 未经作者确认不得 settle / 入正式正文


## 传输策略（流式优先 + 必出结果）

1. 优先流式
2. 失败自动重试最多 3 次
3. 仍失败则非流式兜底，必须产出完整文本
4. 写入 Codex候选/*.txt（含 .body.txt）
5. txt 可被模型再次读取做质检/去AI味/文风对比
6. 聊天只给路径+短预览

## 可靠性（fusion.14）

- 流式优先，失败重试，再非流式兜底。
- 多模型 ID 时默认 fallbackChain：第一个失败就换下一个，直到写出完整 txt。
- 硬门槛拦截：过程泄漏 / 审稿腔包装 / 空输出；通过后才落盘。
- 产物：Codex候选/*.txt + *.body.txt（纯正文，可再喂模型）。
- 优化：iction_optimize_with_models 按模型顺序串行，每步完整落盘。
