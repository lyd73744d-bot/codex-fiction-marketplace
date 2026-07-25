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

- 版本：`4.1.0-fusion.28+codex.20260726034256`
- 对话前台责编教练
- 网关模型调用（有积分可调用）
- **Claude Opus 5 / Sonnet 5 已测活并展示**
- 流式候选 txt
- 样书精拆 / 去 AI 味 / 风格对照
- 作者确认后再入台账
