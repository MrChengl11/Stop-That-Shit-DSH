# Changelog

本文件记录本仓库（DeepSeek Harness 适配层）的变更。上游 stop-that-shit 的变更请见
https://github.com/lennney/stop-that-shit 。

## v0.2.1 — 适配 DeepSeek Harness 0.2.1-rc.5（版本闸门 / 工具面 / 工作目录）

本版只做「让插件在 rc.5 上像在 rc.3 上一样工作」：插件用到的五个宿主扩展点在 rc.3 → rc.5 之间
**逐字节未变**（复核见 [`docs/06-rc5-host-contract.zh.md`](docs/06-rc5-host-contract.zh.md)），
所以挂载方式一行没改。真正会「挂掉」的不是 API 变更，是**版本闸门**。

### 根因：`engines.dsh` 精确 pin 让 rc.5 静默跳过整个 bundle

`dsh-app-boot` 在启动时用 `evaluatePluginCompatibility()` 读插件清单的 `engines.dsh`，
判定口径是 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })`
（`dsh-app-boot/lib/index.js:276-278`）。`0.2.1-rc.3` 是**精确版**，不匹配运行中的 `0.2.1-rc.5`：

* rc.5 不报错、退出码 0，只在 stderr 留一行 `dsh: skipping profile bundle "dsh-stop-that-shit": ...`；
* `--dump-config` 里没有 `sts-native` 行，插件从未 `apply()`，**守卫静默缺席**；
* 所以现象是「什么都没拦」，而不是「装不上」——这是本轮最值得记住的一条。

### 修复

* **A. 版本闸门**（`package.json`）：`engines.dsh` 从精确版 `0.2.1-rc.3` 改为 **`^0.2.1-rc.3`** ——
  接受 0.2.1-rc.3 起的 0.2.x（含 rc.4 / rc.5 / 正式版），拒绝 0.3.x。两个反直觉点：
  * `^0.2.1`（省掉 prerelease）**也会挂**：它排除所有预发布版本，rc.5 依然不满足；
  * 精确 pin 每升一个 rc 就要改一次，不该出现在发布形态里。
  * 逃生舱：运行时确实不受支持时，`dsh plugin --profile <p> allow-version <name>@<version> --dsh-version <runtime> --accept-risk`
    会把「该版本 + 该运行时」这一对写进 `<profile>/compatibility.json` 豁免；应急手段，不是发布写法。
* **B. `cwdOf()` 优先读活动投影**（`lib/index.js`）：原先取 `session.header.cwd` —— 那是**创建期快照**，
  `working_directory` 工具 `cd` 之后只追加 `working-directory/change` 投影，不改 header。
  后果：模型换过目录后相对路径仍按初始目录归一化，`adapter.absolutePath()` 判错根 → 误放行 / 误拒。
  现在优先 `workingDirectory.get(session)` 的活动投影，header 只做兜底，服务缺失时退回 `process.cwd()`。
* **C. rc.5 工具面重新分类**（`lib/adapter.js`）：按 rc.5 桌面 profile 与 headless profile 的**实挂工具名**
  逐条归类（桌面面 117 个、headless 面 25 个工具名；`mcp__*` 是动态前缀，不列入清单），
  清单落在 `test/rc5-tool-inventory.mjs`，conformance 逐条断言分类：
  * `exit_plan_mode` → `control`（呈现计划，不动工作树）
  * `workflow` → `delegate`（可再起子代理，花同一份委派预算；子代理自己的写调用是独立 execution，照常逐个判）
  * `ops_load_sdk` / `ops_result` / `plugin_manager` / `plugin_market` / `unlag_refresh` /
    `gain_qq_tools` 与 qqbot 频道类工具 → `control`（效果在任务工作树之外）
  * `cordis_inspect_*` → `read`（只读插件树）
  * 保留 0.2.0 的 shell 写目标并集，并把 `ops_*` 一套文件工具一并覆盖
  * `mcp__*` **故意不分类**：MCP server 自己决定效果，保持 `unknown` fail-closed
* **D. `systemPrompt.context` 加固**（`lib/index.js`）：新增 `interpolate: false` 与 `required: true`。
  * `interpolate: false`：契约文本是宿主状态原文（指令里可能有 `{}`、glob、路径），不能被当成
    `{{变量}}` 模板——rc.5 遇到未知变量会抛错，那会打断当轮整次上下文组装。
  * `required: true`：预设抑制 runtime context 时（如 `dsh-persona` 的 `includeRuntimeContext: false`）
    非 required 的 context 会被整体丢弃，契约文本随之静默消失；未布防时 `text` 返回 `""`，
    空 section 会被过滤，不会污染提示。
* **E. 委派生命周期回收**（`lib/index.js`）：`tools/post-execute` 现在对**所有** `delegate` 工具
  （`subagent` / `subagent_fork` / `spawn_teammate` / `workflow`）释放委派预留。C 把 `workflow`
  归为 `delegate` 之后复核发现：post-execute 原本只释放前三个名字，`workflow` 占的槽位会一直挂着
  （reservation leak），后续委派随即被误判 `AGENT_BUDGET_EXHAUSTED`。另外 rc.5 的 `workflow` 支持
  `run_in_background: true` —— 这类调用立即返回 `{kind:"background", jobId, runId}` 而子代理还在跑，
  post-execute 因此对它上报 `lifecycle: "running"` 而不是 `"joined"`，避免槽位提前交还；被 deny 的调用
  没有预留，pre-execute 侧同时清掉 background 标记。delegate 动作在 pre-execute 一并带 `completionScope: "call"`。

### 行为变化（0.2.1-rc.5 实测）

`engines.dsh` 闸门：

| 项 | v0.2.0 | v0.2.1 |
| --- | --- | --- |
| 在 0.2.1-rc.5 上加载 | 整个 bundle 被静默跳过（stderr 一行、退出码 0），无任何拦截 | 正常挂载，stderr 出现 `[sts-native] loaded` |

工具面分类（v0.2.0 对这些名字一律 `unknown`）：

| 工具 / 场景 | v0.2.1 分类 | 实测效果 |
| --- | --- | --- |
| `exit_plan_mode` | `control` | `review` 模式下放行 |
| `workflow` | `delegate` | 预算内放行并预留；耗尽 → `AGENT_BUDGET_EXHAUSTED` |
| `ops_load_sdk` / `ops_result` / `plugin_manager` / `plugin_market` / `unlag_refresh` / `gain_qq_tools` / qqbot 频道工具 | `control` | 不动任务工作树，放行 |
| `cordis_inspect_*` | `read` | 只读 |
| `mcp__*` | `unknown`（不变） | 武装且带文件边界后按未证明动作拒绝 |

其它：

| 场景 | v0.2.0 | v0.2.1 |
| --- | --- | --- |
| 先 `working_directory` 换目录、再写相对路径 | 按创建期 cwd 判 → 误放行 / 误拒 | 按当前 cwd 判 |
| 契约文本里的 `{}` / 未知 `{{变量}}` | 可能被当模板求值（rc.5 遇未知变量抛错） | `interpolate:false`，保留原文 |
| 预设抑制 runtime context | 契约文本静默消失 | `required:true`，仍保留 |

### 测试

* `test/conformance.mjs`：56 条扩到 **121 条**，全部通过（不调模型）。新增覆盖 rc.5 工具面分类、
  `exit_plan_mode` / `workflow` 的语义、MCP 工具 fail-closed、活动工作目录投影优先、
  `required: true` 在抑制 runtime context 后仍保留契约文本，以及委派生命周期（每个 delegate 工具都回收预留、
  后台 workflow 报 `running`、被 deny 的调用不留残留）。
* `test/rc5-tool-inventory.mjs`（新）：把 rc.5 桌面与 headless 两个 profile 的实挂工具名与分类
  作为**可审计的签入证据**；来源与读取方法写在该文件头部注释里。
* `e2e/REPORT-rc5.md`（新）：真实 headless 启动 + 真实模型 + 真实文件系统，7 个场景全部通过，48/48 项检查（其中 5 项依赖模型行为，标记为信息性、不参与判定），运行对象是安装版 0.2.1-rc.5。
  权威的拦截证明是 forced `review-write` 场景（`DENY write MODE_FORBIDS_MUTATION`、文件未创建、
  拒绝理由出现在持久化 transcript）；`change` 模式证明界内放行、界外 `PATH_OUTSIDE_CONTRACT`；
  `dump-config` 证明 `sts-native` 行存在且 stderr 为空；未布防证明 0 条 `source.kind="sts"` 通知。
  自然语言的 `review-deny` 场景依赖模型行为，只作信息性观察。

### 兼容性

* **已验证**：DeepSeek Harness **0.2.1-rc.5**（Electron 桌面版 win32-x64 的 headless CLI，
  同一份安装产物；GUI 路径未在验收范围内）
* **支持范围**：`^0.2.1-rc.3` → 0.2.1-rc.3 起、含 0.2.x；**不含 0.3.x**
* Node.js >= 22
* 上游 stop-that-shit `e2660f4` + 0.2.5.1 修复

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
