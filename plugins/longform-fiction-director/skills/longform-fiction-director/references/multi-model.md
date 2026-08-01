# 多模型编排（总责编调度）

> Codex 永远在**总责编位**，外部写作模型默认在正文 A 位。模型推荐是责编建议，作者可随时覆盖；详细边界见 `editor-model-division.md`。

## 怎么接入模型

1. 首次明确选择外部模型时，打开字字珠玑登录页，使用账号密码登录。插件不接收模型供应商 API 密钥。
2. MCP 登录后调用 fiction_list_models，从字字珠玑后台实时读取当前真正可用的模型，不在插件里写死线路。
3. 再调 fiction_recommend_models，传入任务类型（draft/outline/humanize/review…）。
4. 写稿时先询问，作者当次选择使用后才以 authorConfirmed=true 调用 fiction_generate_to_file。长文传 background=true，本地核对连续性后用 fiction_generation_status 取回结果，再读候选文件。

## 任务 → 模型角色

| 任务 | 角色 | 默认倾向 |
|---|---|---|
| 脑洞/市场 | 探索 | seed-2.1-turbo / minimax-m3 / qwen3.7-max / gemini-3.5-flash / glm-5.2 |
| 大纲/细纲/章节构思 | Codex 总责编默认本地完成；需要第二意见才调用 | glm-5.2 / claude-sonnet-5 / seed-2.1-pro / gemini-3.1-pro-preview / kimi-k3 |
| 正文候选 | 主写 | claude-sonnet-5 / seed-2.1-pro / glm-5.2 / kimi-k3 / minimax-m3；需要旗舰时再选 claude-opus-4-6 |
| 去AI味 | 风格 | claude-sonnet-5 / seed-2.1-pro / glm-5.2 / kimi-k3 |
| 质检 | 审核+连续 | claude-sonnet-5 / glm-5.2 / gemini-3.1-pro-preview；硬伤再上 Claude Opus |
| 定稿 | 成稿 | claude-opus-4-6（作者确认前） |

`grok-4.5` 是 5 积分的慢速备用线路。仅在作者明确点名时手动调用，不进入默认推荐，也不自动替换其他失败模型。

## Codex 对作者的说话方式

- 每次先推荐一个模型并询问是否使用；当次选择使用才调用，不展示积分
- 默认够用就行，不堆旗舰
- 结果先落候选 txt，确认后才入正文/台账
- 作者拒绝时不抢写，先问继续把这一章想清楚，还是由 Codex 写临时候选
- 调用失败：保留已成功结果与错误，不静默重复扣费

## 传输纪律（重要）

长文传输默认：

1. callModels 先走流式请求并持续保存已收到内容
2. 空流也不切换非流式协议重发；网络、限流、5xx、超时或已有部分正文均不重复提交
3. 作者当次确认后，业务层用 fiction_generate_to_file（authorConfirmed=true）把全文写 txt
4. 展示/质检都读文件，不靠聊天窗口里的半截流

## 调用纪律

1. 只从 fiction_list_models 返回的清单里选
2. 不在项目文件里存密钥
3. 每个模型只拿完成角色所需的最小上下文
4. 原始结果独立落盘（候选 txt），Codex 再综合
5. 不以多数票代替判断
6. 未经作者确认不得 settle / 入正式正文


## 传输策略（单次流式 + 完整落盘）

1. 长文只提交一次流式请求
2. 网络、限流、空流、5xx、超时或部分正文都不自动重发；任何重试或续写都重新征得作者确认
3. 只有成功返回空流时才尝试一次非流式协议兼容
4. 写入 Codex候选/*.txt（含 .body.txt）
5. txt 可被模型再次读取做质检/去AI味/文风对比
6. 聊天只给路径+短预览

## 可靠性（fusion.14）

- 单次流式优先；超时不重发，只有空流响应才做一次非流式兼容。
- 默认只调用作者明确选择的第一个模型，不自动换模型；只有作者本次明确要求 `fallbackChain=true` 时，才按给定顺序依次尝试。
- 硬门槛拦截：过程泄漏 / 审稿腔包装 / 空输出；通过后才落盘。
- 产物：Codex候选/*.txt + *.body.txt（纯正文，可再喂模型）。
- 优化：`fiction_optimize_with_models` 按模型顺序串行，每步完整落盘。
