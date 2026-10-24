# Changelog

本文件记录本仓库（DeepSeek Harness 适配层）的变更。上游 stop-that-shit 的变更请见
https://github.com/lennney/stop-that-shit 。

## v0.2.0 — shell 写目标证明 / 依赖授权顺序

对应上游 stop-that-shit **0.2.5.1**。修的是 0.1.0 的一个真实可用性问题：
在 `files=` 边界下，凡是用 shell 写文件（`mkdir`、`touch`、`git add`、`> file`）
都会被判 `WRITE_PATH_UNPROVEN`，即使目标就在边界内 —— 因为上游判定引擎拿不到写目标。

### 修复

* **A. shell 写目标证明**（`vendor-sts/src/shell-analysis.cjs`，来自上游 0.2.5.1）
  新增 `redirectTarget` / `posixWritePaths` / `powershellWritePaths` / `gitAddPaths` /
  `writePathsFromArguments` / `provenWritePaths` / `combineAffectedPaths`。
  现在能证明 `mkdir -p src/new`、`rm -rf src/old`、`cp`、`mv`、`touch`、`git add <path>`、
  `Set-Content`、`Remove-Item` 与 shell 重定向（含引号内字面量路径）的写目标。
  **一条命令链里任何一个写命令无法证明，整条链回到 `[]`**（不猜）。
* **A′. 适配层并集**（`lib/adapter.js`）
  shell 分析出的路径并入 `affectedPaths`，让 `files=` 边界能真正按路径判定。
  原先 DSH 适配层把 shell 一律判为「可能写但没证明」，是这里漏了 union。
* **B. 依赖授权先于文件边界**（`vendor-sts/src/decision.cjs`，来自上游 0.2.5.1）
  `dependencyIntent` 的判定整体移到文件边界检查之前，并新增 `dependencySettled` 豁免，
  使 `deps=allow` 不再被 `WRITE_PATH_UNPROVEN` 抢占；`deps=ask` / `deps=deny` 行为不变。

### 行为变化

| 场景（`change` + `files=src/**`） | 0.1.0 | 0.2.0 |
| --- | --- | --- |
| `mkdir -p src/new` | deny `WRITE_PATH_UNPROVEN` | **allow** |
| `touch src/app.ts` | deny `WRITE_PATH_UNPROVEN` | **allow** |
| `echo hi > src/out.txt` | deny `WRITE_PATH_UNPROVEN` | **allow** |
| `touch README.md` | deny `WRITE_PATH_UNPROVEN` | deny `PATH_OUTSIDE_CONTRACT`（拒绝理由从「没证明」变准确） |
| `git add -A` | deny `WRITE_PATH_UNPROVEN` | deny `WRITE_PATH_UNPROVEN`（不指名目标，不变） |
| `npm run build` / `node scripts/build.js` | deny `WRITE_PATH_UNPROVEN` | deny `WRITE_PATH_UNPROVEN`（无法证明目标，仍 fail-closed） |
| `deps=allow` + `npm install yaml` | deny `WRITE_PATH_UNPROVEN` | **allow** |
| `deps=ask` + `npm install yaml` | deny `DEPENDENCY_NOT_AUTHORIZED` | deny `DEPENDENCY_NOT_AUTHORIZED`（不变） |

上表为 `files=src/**` 下逐条实测。边界收窄成精确文件时（`files=src/app.ts`），
`mkdir -p src/new` 会从「没证明」变成准确的 `PATH_OUTSIDE_CONTRACT`（目标在界外）。

### 测试

* `test/conformance.mjs` 从 49 条扩到 **56 条**，全部通过（不调模型）。
  原来那条「`mkdir -p src/new` 应报 `WRITE_PATH_UNPROVEN`」的断言已过时，
  拆成三条：界外已证明目标 → `PATH_OUTSIDE_CONTRACT`；界内已证明目标 → allow；不指名目标 → `WRITE_PATH_UNPROVEN`。
  另加两条依赖授权顺序回归（`deps=allow` 放行、`deps=deny` 仍拦）。

### 兼容性

* DeepSeek Harness 0.2.1-rc.2 / 0.2.1-rc.3
* Node.js >= 22
* 上游 stop-that-shit `e2660f4` + 0.2.5.1 修复

## v0.1.0 — 首个版本

首个可安装的 DeepSeek Harness 适配层，`vendor-sts/` 取自上游 stop-that-shit commit `e2660f4`。

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
* `vendor-sts/` — 上游决策引擎源码，MIT。0.2.0 起打了两项上游 0.2.5.1 修复，见顶部条目。
* `test/conformance.mjs` — 初始 49 条断言，全部不调用模型（0.2.0 起 56 条）。
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
* 上游 stop-that-shit v0.2.5（0.2.0 起为 commit `e2660f4` + 0.2.5.1 修复）
