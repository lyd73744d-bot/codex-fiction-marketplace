# 字字珠玑 · Codex 写作插件市场

让别人在 Codex 里安装本插件：

```bash
codex plugin marketplace add lyd73744d-bot/codex-fiction-marketplace
codex plugin add longform-fiction-director@zizhuji-fiction
```

或：

```bash
codex plugin marketplace add lyd73744d-bot/codex-fiction-marketplace --ref main
codex plugin add longform-fiction-director@zizhuji-fiction
```

## 说明

- 这是 **Git 第三方市场**，别人添加本仓库后可安装。
- **不能** 直接塞进 OpenAI 官方 curated 市场。
- 本机 personal 市场只自己可见，别人搜不到。

## 仓库结构

- `.agents/plugins/marketplace.json` 市场清单
- `plugins/longform-fiction-director/` 插件本体

## 插件

**写小说真的太简单了 / longform-fiction-director**

- 版本：`4.2.1`（安装包使用时间戳缓存版本）
- 对话前台责编教练
- 5 个本地核心工具：项目建档、样书学习、研究、事实库、文风锚点
- 15 个网关与候选稿工具；每次调用外部模型前由作者确认
- 流式候选 txt
- 样书剧情、对话、文风对照 / 去 AI 味 / 自然大纲与章节笔记
- 作者确认后再入台账
