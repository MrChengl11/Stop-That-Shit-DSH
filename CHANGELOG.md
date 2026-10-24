# Changelog

本文件记录本仓库（DeepSeek Harness 适配层）的变更。上游 stop-that-shit 的变更请见
https://github.com/lennney/stop-that-shit 。

## v0.1.0 — 首个版本

首个可安装的 DeepSeek Harness 适配层，对应上游 stop-that-shit v0.2.5。

### 新增

* `lib/index.js` — DSH cordis 插件入口 `sts-native`，挂载五个宿主扩展点：
  `agent/inbox/claimed`、`agent/pre-step`、`tools/pre-execute`、
  `tools/post-execute`、`systemPrompt.context`。
* `lib/adapter.js` — 把 DSH 工具调用翻译成上游 ControlEvent v2：
  工具名 → mutability 分类、`arguments` → affectedPaths / hashIntent / dependencyIntent。
  未知工具 fail-closed 归为 write。
* `cordis.patch.yml` — 单条目 patch，把 `sts-native` 插进 profile。
* `install.mjs` — 幂等安装/卸载：复制到 `~/.dsh/plugins/dsh-stop-that-shit`、
  建 junction、写 profile 的 `dependencies` 与 `dsh.profile.bundles`。
* `vendor-sts/` — 上游 v0.2.5 源码，**未做任何修改**（MIT）。
* `test/conformance.mjs` — 49 条断言，全部不调用模型。
* `e2e/` — 真实 headless DSH 启动 + 真实模型的端到端探针。
* `research/claude-code-bridge/` — 早期 Claude Code hook 桥接路线的探针与放弃理由。
* `docs/01`–`docs/05` — 上游取证、DSH 扩展面取证、桥接记录、兼容性判定、原生插件设计。

### 行为

* 未布防（`unconfirmed` / `watch`）时放行一切，只在上下文里给一行提示。
* 武装后按上游判定顺序拦截：模式、文件边界、hash、依赖、delegation 预算。
* 拒绝以 `{kind:"deny", reason}` 返回，模型看到的是 `Error: <reason>` 加 Code/State/Event/Next。
* PTC 嵌套调用（`run_code` 内部派发的工具）同样经过 `tools/pre-execute`，同样被拦。

### 已知限制

* 这是 **guardrail，不是 security boundary**。真正的边界仍是 DSH 的 sandbox 与 permission 设置。
* 只覆盖经过工具调用的动作；模型直接输出的文本不在管辖范围内。
* 上游的 `SessionEnd` / `PostToolUseFailure` / `PermissionDenied` 三个事件在 DSH 侧没有对应缝隙，未接线。

### 兼容性

* DeepSeek Harness 0.2.1-rc.2 / 0.2.1-rc.3
* Node.js >= 22
* 上游 stop-that-shit v0.2.5
