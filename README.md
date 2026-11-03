# Stop-That-Shit-DSH（STS × DeepSeek Harness 二次开发）

> **这是二次开发（derivative work），不是上游官方项目。**
>
> * 上游：[lennney/stop-that-shit](https://github.com/lennney/stop-that-shit)（基于 commit `e2660f4`，即 tag 0.2.5 之后合并了 DSH host adapter 的 18 个提交），MIT，作者 "Stop That Shit contributors"
> * 本仓库：MrChengl11 在 DeepSeek Harness 上的移植与适配层（DSH adapter）
> * 上游**没有** DeepSeek Harness 适配器；本仓库的 `lib/`、`install.mjs`、`cordis.patch.yml`、`test/`、`docs/`、`e2e/`、`research/` 均为本仓库新增
> * 上游决策引擎（`src/controller.cjs`、`src/decision.cjs`、`src/contracts.cjs` 等）以 MIT 条款收录在 `vendor-sts/`，只在 `src/shell-analysis.cjs` 与 `src/decision.cjs` 上打了上游 0.2.5.1 的两项修复（见下方「本次修复」），其余未改
> * 上游 MIT 许可证与版权声明保留在 `vendor-sts/LICENSE`；本仓库自身代码同样以 MIT 发布，见 `LICENSE`

---

## 目录

| 路径 | 内容 | 来源 |
| --- | --- | --- |
| `lib/index.js` | DSH 插件入口：挂 `tools/pre-execute` 等宿主钩子 | 本仓库新增 |
| `lib/adapter.js` | DSH 工具名 → 上游 ControlEvent v2 的适配 | 本仓库新增 |
| `vendor-sts/` | 上游 STS 决策引擎（commit `e2660f4` + 0.2.5.1 两项修复，MIT） | 上游 |
| `test/conformance.mjs` | 121 条 conformance 断言，不跑模型 | 本仓库新增 |
| `test/rc5-tool-inventory.mjs` | rc.5 实挂工具名与分类（签入证据，供断言） | 本仓库新增 |
| `install.mjs` | 幂等安装/卸载到任意 DSH profile | 本仓库新增 |
| `e2e/` | 端到端探针（真实 headless 启动 + 真实模型） | 本仓库新增 |
| `research/claude-code-bridge/` | 早期走 Claude Code hook 桥接路线的探针与结论 | 本仓库新增 |
| `docs/01..03` | 上游分析、DSH 扩展面取证、桥接路线记录 | 本仓库新增 |
| `docs/04..05` | 兼容性判定报告、原生插件设计报告（中文） | 本仓库新增 |
| `docs/06` | rc.5 宿主契约复核（本轮适配的证据基础，中文） | 本仓库新增 |

## 与上游的关系

本仓库只提供**宿主粘合层**：把 DeepSeek Harness 的扩展点翻译成上游认识的事件。

| DSH 扩展点 | 用途 |
| --- | --- |
| `agent/inbox/claimed` | 在 harness 拼接上下文之前拿到**真实用户 prompt** |
| `agent/pre-step` | 把契约/状态提示注入本轮 |
| `tools/pre-execute` | before-action，可真正返回 `deny` |
| `tools/post-execute` | 子 agent 结束时释放 delegation 预留 |
| `systemPrompt.context` | 按请求把当前契约状态发布到 runtime-context 用户消息里的一个 section（order 550；**不是** system prompt） |

决定"拦不拦"的逻辑全部来自上游 `vendor-sts/`，本仓库不重写判定规则。

## 本次修复（v0.2.1）：rc.5 版本闸门与工具面

`dsh-stop-that-shit` 在 DeepSeek Harness 0.2.1-rc.5 上曾经**完全没生效**：不报错、装得上、进程正常退出，
只是守卫不在。原因是版本闸门，不是 API 变更 —— 插件用到的五个宿主扩展点在 rc.3 → rc.5 之间**逐字节未变**
（复核记录见 [`docs/06-rc5-host-contract.zh.md`](docs/06-rc5-host-contract.zh.md)）。

| 症状 | 实际发生的事 |
| --- | --- |
| 没有任何拦截，模型该写就写 | `dsh-app-boot` 的 `evaluatePluginCompatibility()` 判定 `engines.dsh` 不满足运行版本，**整个 bundle 被跳过** |
| stderr 只有一行 `dsh: skipping profile bundle ...`，退出码 0 | 这是 rc.5 的静默降级路径：没有异常、没有非零退出、不会提示「插件没装上」 |
| `dsh --profile <p> --dump-config` 里找不到 `sts-native` 行 | 插件从未 `apply()`，五个钩子一个都没挂上 |

| 修复 | 位置 | 效果 |
| --- | --- | --- |
| `engines.dsh: "^0.2.1-rc.3"` | `package.json` | 覆盖 0.2.1-rc.3 起的 0.2.x（含后续 rc 与 0.2 正式版），拒绝 0.3.x |
| `cwdOf()` 优先活动投影 | `lib/index.js` | 读 `workingDirectory.get(session)` 而不是创建期快照；`cd` 之后相对路径按当前目录判 |
| rc.5 工具面重新分类 | `lib/adapter.js` | 按实挂工具名逐条分类（桌面 117 个 / headless 25 个）：`exit_plan_mode`→control、`workflow`→delegate、`ops_*` / 插件簿记 / qqbot 频道→control、`cordis_inspect_*`→read；`mcp__*` 是动态前缀，保持 unknown fail-closed |
| `interpolate:false` + `required:true` | `lib/index.js` | 契约文本不再被当 `{{模板}}` 求值（rc.5 遇未知变量会抛错）；预设抑制 runtime context 时也不静默丢契约 |
| 委派预留回收 | `lib/index.js` | `tools/post-execute` 对**所有** delegate 工具释放预留（原先漏了 `workflow`）；后台 workflow 报 `running`，槽位不提前交还 |

两个容易踩的版本写法：

* `"^0.2.1"`（省掉 prerelease）**也会失败** —— 它排除所有预发布版本，0.2.1-rc.5 依然不满足；
* 写死精确版 `"0.2.1-rc.3"` 是最坏的一种：每升一个 rc 就静默失效一次。

## 兼容性

| 项 | 值 |
| --- | --- |
| 已验证的运行时 | DeepSeek Harness **0.2.1-rc.5**（Electron 桌面版 win32-x64；验收走同一安装产物的 headless CLI，GUI 加载路径未单独验收） |
| 声明支持范围 | `engines.dsh: "^0.2.1-rc.3"` → 0.2.1-rc.3 起、含 0.2.x；**不含 0.3.x** |
| Node.js | >= 22 |
| 判定口径 | `engines.dsh` 存在时**只看它**，`@deepseek-ai/dsh-*` 的 `peerDependencies` 一律忽略 |
| 运行时不在范围内 | 整个 bundle 被静默跳过（stderr 一行 `dsh: skipping profile bundle ...`，退出码 0），插件不会加载 |

逃生舱（不推荐作为常规用法）：如果运行时确实不在支持范围，可以按「精确插件版本 + 精确运行时版本」这一对做豁免，
结果写进 `<profile>/compatibility.json`：

```bash
dsh plugin --profile <profile> allow-version <name>@<version> --dsh-version <runtime> --accept-risk
dsh plugin --profile <profile> version-exemptions     # 查看当前豁免
dsh plugin --profile <profile> revoke-version <name>@<version> --dsh-version <runtime>
```

## 本次修复（v0.2.0）

上游 0.2.5 的 shell 判定只给命令分类，不给出**写目标路径**。因此在 `files=` 边界下设了界，
任何 `mkdir` / `touch` / `git add` / shell 重定向都会被判 `WRITE_PATH_UNPROVEN` —— 即使目标就在边界内。
本版本把上游 0.2.5.1 的两项修复搬进 `vendor-sts/`，并在 DSH 适配层接上：

| 修复 | 位置 | 效果 |
| --- | --- | --- |
| A. 证明 shell 写目标 | `vendor-sts/src/shell-analysis.cjs` | `mkdir -p src/new` → `["src/new"]`；`echo hi > src/out.txt` → `["src/out.txt"]`；`git add -A` 这类不指名目标的仍为 `[]`，继续按未证明处理 |
| A′. 适配层并集 | `lib/adapter.js` | shell 分析出的路径并入 `affectedPaths`，`files=` 边界能真正判定而不是一律 `WRITE_PATH_UNPROVEN` |
| B. 依赖授权先于文件边界 | `vendor-sts/src/decision.cjs` | `deps=allow` 下装依赖不再被路径检查抢占；`deps=ask` / `deps=deny` 仍照常拦 |

边界被证明在界外时，拒绝从 `WRITE_PATH_UNPROVEN` 变成更准确的 `PATH_OUTSIDE_CONTRACT`；
已证明在界内的 shell 写（如 `touch src/app.ts`）直接放行。**无法证明目标的命令（`node build.js`、`npm run build`）行为不变，仍然 fail-closed。**

## 快速开始

也可以直接从 [Releases](https://github.com/MrChengl11/Stop-That-Shit-DSH/releases) 取打包件，解包后跑 `node install.mjs`。

```bash
node install.mjs              # 安装到默认 profile "desktop"
node install.mjs --profile X  # 指定 profile
node install.mjs --uninstall  # 卸载
node test/conformance.mjs     # 121 条断言
```

---

# 以下为插件本体文档

[Stop That Shit](https://github.com/lennney/stop-that-shit) as a **native DeepSeek Harness plugin**.

Stop That Shit is a task-boundary guard: it does not sandbox the process, it keeps the
agent inside the mode, files, dependency policy and delegation budget the user declared
with a `$stop-that-shit` directive. Upstream ships adapters for Codex, Claude Code,
OpenCode, Hermes Agent CLI, Pi and Oh My Pi. This package is the DeepSeek Harness adapter:
it reuses the upstream decision engine and supplies the host glue.

`vendor-sts/` is pinned to upstream commit `e2660f4` (merge of the upstream DSH host adapter)
plus the two `0.2.5.1` fixes: the shell analyser now reports provable write targets, and
dependency authority is decided before the file boundary. See “本次修复” above.

## What it does

| DSH seam | Used for |
| --- | --- |
| `agent/inbox/claimed` | Read the **real user prompt** before the harness merges context into it, so a directive is still the first non-empty line. |
| `agent/pre-step` | Append the guard's contract / status notice as a user message for the step that prompt belongs to. |
| `tools/pre-execute` | The before-action event. Returns `{kind:"deny", reason}` — a real denial whose reason reaches the model as `Error: <reason>`. |
| `tools/post-execute` | Release a delegation reservation when a **delegate** call settles (`subagent`, `subagent_fork`, `spawn_teammate`, `workflow`); a background `workflow` reports `running`, not `joined`. |
| `systemPrompt.context` | Publish the live contract state per request (order 550) as **one section of the harness's runtime-context user message** — it never becomes part of the system prompt. |

Nested PTC sub-calls (`run_code` dispatching `tools.write`) arrive at
`tools/pre-execute` as their own executions and are judged individually.

## Install

```jsonc
// <profile>/package.json
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-stop-that-shit"] } }
}
```

Put this package in `<profile>/node_modules/dsh-stop-that-shit` (a junction is fine) and
declare it in the bundle list. The package declares `dsh.bundle.patch`, which inserts one
cordis entry (`sts-native`) into the profile tree.

`engines.dsh` is `^0.2.1-rc.3` — a prerelease-aware caret range: 0.2.1-rc.3 through 0.2.x
pass, 0.3.x does not. (`^0.2.1` without the prerelease does **not** match a running rc
build.) When present, `engines.dsh` decides compatibility alone and `peerDependencies` on
`@deepseek-ai/dsh-*` are ignored; an unsatisfied gate makes the host skip the whole bundle
**silently** — one stderr line, exit code 0, no plugin at all. The escape hatch on an
out-of-range runtime is
`dsh plugin --profile <p> allow-version <name>@<version> --dsh-version <runtime> --accept-risk`,
which writes a `<profile>/compatibility.json` exemption; that is an emergency override,
not the release shape. The plugin imports **no** `@deepseek-ai` package at runtime — a
linked profile bundle cannot resolve host packages the profile does not re-export.

## Use

The directive must be the **first non-empty line** of a message, and the task text must
come **after `--`**:

```
$stop-that-shit change files=src/app.ts -- Refactor the handler in src/app.ts.
```

| Field | Values |
| --- | --- |
| mode | `answer` `review` `monitor` `change` |
| level | `watch` `guard` `lock` |
| scope | `files=a\|b`, `**` for the whole tree |
| policies | `deps=deny\|ask\|allow`, `hash=deny\|ask\|allow` |
| budget | `agents=N` |

Query it with `$stop-that-shit status`, `... runtime`, `... explain evt_...`,
`... label evt_... correct|incorrect|inconclusive`.

**Two syntax traps**, both inherited from upstream and both real:

* **`--` is mandatory** when task text follows. `$stop-that-shit review do the thing`
  answers `INVALID_DIRECTIVE_TOKEN` and leaves the session unarmed for that turn.
* A level is a **bare word**, not a key: `$stop-that-shit change watch files=src/app.ts`.
  Writing `level=watch` is rejected as an unknown directive field.

Any message that does not start with the directive leaves the guard `unconfirmed` /
watch-only, and nothing is denied.

## Configuration

```yaml
- id: sts-native
  name: dsh-stop-that-shit
  config:
    dataDir: C:/Users/you/.dsh/sts-data   # default: $DSH_HOME/sts-data or ~/.dsh/sts-data
    announceWhenUnarmed: true             # publish the watch-only preamble as runtime context
    announceOnPrompt: true                # inject the contract after a steering prompt
```

## Verify it

```
node test/conformance.mjs      # 121 assertions, no model in the loop
```

The suite drives the same handlers the plugin registers on a fake cordis ctx and asserts
the whole decision matrix: shape, directive parsing, in/out-of-boundary writes, shell
classification, PTC container, `review` mode, `watch` level, hash and dependency policy,
agent budget, runtime commands, and fail-open behaviour.

End-to-end (real headless boot, real model, real files on disk) is covered by `e2e/rc5/`;
`e2e/REPORT-rc5.md` is the generated report of the run against the installed 0.2.1-rc.5
(7 scenarios pass, 48/48 checks — 5 checks depend on the model's tool choice and are
reported as informational, never as verdicts; evidence in `e2e/REPORT-rc5.md`). Its
assertions depend on which tool the model chooses, so the conformance suite remains the
deterministic gate.

## Known limits

* **Not a security boundary.** Stop That Shit calls itself a guardrail; the real boundary
  stays the DSH sandbox and permission preset. A `run_code` script that writes through
  `node:fs` is classified as `control`, not as a file write, and is not path-checked.
* A shell command whose target cannot be proven (e.g. `node -e ...`, `python x.py`,
  `npm run build`) is `unknown`; under a `files=` boundary that is denied as
  `WRITE_PATH_UNPROVEN`. Since 0.2.0 the analyser proves targets for `mkdir`, `rm`,
  `cp`, `mv`, `touch`, `git add <path>`, `Set-Content`, `Remove-Item` and shell
  redirections, so those are judged by path instead of being refused outright.
* The same upstream classifier is deliberately conservative in `review` mode: common
  PowerShell one-liners do not count as proven static reads —
  `Get-ChildItem -Recurse -Filter *.ts`, `... | Where-Object { ... }`,
  `git status | Out-String` and `2>$null` redirections all come back
  `MUTABILITY_UNPROVEN`. Use the dedicated `read` / `glob` / `grep` tools for review
  work instead of a shell probe; the classifier is not loosened for this.
* `mcp__<server>__<tool>` tools stay unclassified **on purpose** — an MCP server decides
  its own effects at run time. They are `unknown` and fail closed: under `review`, or
  once a `files=` boundary is armed, the call is denied as unproven.
* `workflow` spends delegation budget like `subagent` (`agents=N` applies to it); the
  file writes its children attempt are separate nested executions and are judged
  individually, exactly like `run_code` sub-dispatches.
* The guard fails open: a hook error is logged and the action is allowed, matching the
  upstream hook adapters.

## Licensing

`vendor-sts/` is the upstream `stop-that-shit` decision engine at commit `e2660f4`,
MIT, with the two shell/dependency fixes from upstream `0.2.5.1` applied; see
`vendor-sts/LICENSE`. This package's own glue is MIT.
