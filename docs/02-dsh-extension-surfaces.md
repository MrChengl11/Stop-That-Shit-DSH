# DeepSeek Harness 扩展面调研报告

> 研究对象：本机安装的 DSH 桌面端 v0.2.1-rc.2（Electron，win32-x64，hostProtocolVersion 4，内置 Node 24.21.0，pnpm 11.28.5）
> 调研目的：判断 DSH 能否承载第三方「Skill + 工具调用前拦截」插件（对标 Claude Code 的 PreToolUse / Codex hooks）
> 取证方式：直接读取 app.asar 内的已发布 ESM 源码与随包文档（bash 无法进 asar，run_code 的 Electron patched fs 可直接 readFileSync），并对照本机已安装的第三方插件 dsh-ops 真实实现。全程只读，未改动任何用户配置或安装目录。

---

## 0. 结论先行

| 问题 | 结论 |
| --- | --- |
| 是否存在「工具调用前」拦截/否决钩子？ | **有，且是一等公民**。`tools/pre-execute` waterfall + `ctx.tools.guard()` 单调否决 + `ctx.tools.restrict()` 工具裁剪 + `approval` ask 通道，四层齐全 |
| 能否从插件里读到工具名与 JSON 参数？ | 能。pre-execute 的 `exec` 含 `{ token, callId, rootCallId, name, signal, agent, parent, schema, arguments }` |
| 能否改写工具参数？ | **不能**。`exec.arguments` 被 `deepFreeze` 深冻结，`exec` 自身 `Object.freeze`；改写属被拒绝的设计 |
| 能否否决（阻止执行）？ | 能。返回 `{ kind: "deny", reason, info? }`，工具体根本不会执行；或 `{ kind: "ask" }` 走用户批准 |
| 技能系统是否兼容 Claude Agent Skills？ | 部分兼容：`name` + `description` 必填，`whenToUse`/`metadata` 可选，多余键被容忍但忽略；**没有** `.claude/skills` 目录，**没有** `allowed-tools` 强制 |
| 技能里能否带可执行脚本？ | 能作为资源文件存在，但执行只能走普通 bash/pwsh 工具，没有技能自带执行器 |
| 第三方插件装在哪？ | `C:/Users/<you>/.dsh/profiles/desktop/node_modules`，由 profile 的 `package.json` + `dsh.profile.bundles` 激活 |
| 插件能力边界？ | 进程内、无沙箱的全权宿主代码（plugin_manager README 原文：installed Host code executes in-process outside the workspace sandbox） |
| 是否自带 Claude Code / Codex 兼容层？ | 有对应官方包（`dsh-hooks-claude-code` / `dsh-hooks-codex` / `dsh-experimental-claude-code-mods`），**但本机未安装、随包也未附带**，属可选 registry 包 |

**一句话**：DSH 不但能承载「Skill + 调用前拦截」，它把 Claude Code 的 PreToolUse 语义做成了核心运行时事件，第三方插件（本机 dsh-ops 就是活证据）已经在生产使用这套 seam。

---

## 1. 取证方法与坐标

- ASAR 根：`C:/Users/<you>/AppData/Local/Programs/DeepSeek Harness/resources/app.asar`
- DSH 核心包：`app.asar/dsh/node_modules/@deepseek-ai/*`（304 个 sharedPackages）
- 清单：`app.asar/dsh/desktop-runtime.json`，`{ schemaVersion, release, platform, arch, sharedPackages[], files[{path,bytes,sha256,executable}] }`，`files[]` 的 path 相对 `app.asar/dsh/`，共 17261 条 —— 这是枚举/全量扫描 asar 的可靠入口。
- 只读方式：`run_code` 内 `fs.readFileSync` 直接传 asar 内路径可用（Electron patched fs）；git-bash 不行。

---

## 2. 工具调用前拦截（核心结论）

### 2.1 运行时管线（权威顺序）

来源：`app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/README.md`（Enforce policy on calls / Execution and cancellation）+ `dsh-tools/lib/index.js`。

```
tools/pre-execute   (可扩展 waterfall：allow | deny | ask | cancel)
        ↓
registered monotonic guards   (ctx.tools.guard —— 只能否决，不能放行)
        ↓
tools/execute       (around-dispatch：超时/重试/指标，只能替换 exec.signal)
        ↓
tools/post-execute  (accept / 替换 content / block，可挂 additionalContexts)
        ↓
finalizeContent     (工具自己拥有的最终内容变换)
        ↓
tools/result        (只读观察冻结后的最终结果)
```

### 2.2 精确代码证据（文件 + 行号）

文件：`app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`（161962 B）

| 行 | 内容 |
| --- | --- |
| 3310 | `async prepareExecution(input, next) {` —— 策略入口 |
| 3321 | `const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));` |
| 3322-3325 | `const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : { decision: gate, approvalCancelled: false };` |
| 3332-3336 | `cancel` 分支 → `next({ kind: "post-result", exec, result: toolAbortedBeforeDispatchResult() })` |
| 3337-3338 | `const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason; const denialInfo = decision.kind === "deny" ? decision.info : void 0;` |
| 3339-3353 | deny 分支 → `next({ kind: "post-result", exec, result: this.materializeFinalResult({ content: [{ type: "text", text: `Error: ${denialReason}` }], isError: true, error: { message: denialReason, ...info } }) })` —— **工具体不执行** |
| 3427 | `const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));` |
| 3390 | `async dispatchToolBody(exec) {` —— `:3406` `const returned = await tool.execute(exec.arguments, exec);` |
| 3506 | `Object.freeze(exec);` |
| 3600 | `const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));` |
| 3017-3021 | `guard(guard) { return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), { label: "tools.guard()", notify: false }); }` |
| 2743-2748 | `guardReason(exec) { for (const guard of this.guards.values()) { const reason = guard(exec); if (reason !== void 0) return reason; } }` —— 先全局层、再 scope 链，第一个返回 string 的 guard 即否决 |
| 2991-3014 | `restrict(filter)`：必须来自 `agent.ctx`，`{}` 报错，不能点名 `run_code`，未知工具名报错 |
| 2974-2989 | `register(definition)`：scoped 注册遮蔽 global；`run_code` 为保留名 |
| 3259-3263 | `const detached = snapshotJsonValue(exec.arguments); … arguments: deepFreeze(detached)` —— 参数深冻结 |
| 3535-3590 | `async serviceAsk(exec, ask)`：`const approval = this.ctx.get("approval")` 缺失 → deny `tool "<n>" requires approval (not yet supported)`；无 agent → deny `... but the call has no agent to route it through`；否则 `approval.request({ agent, toolName, callId, reason?, displayReason?, signal })` |

### 2.3 公开 API 一览（插件作者视角）

```js
// A. 事件式（可 await，能问用户）
ctx.on("tools/pre-execute", async (exec, next) => {
  if (/^rm\b/.test(String(exec.arguments?.command ?? "")))
    return { kind: "deny", reason: "blocked by policy", info: { name: "PolicyError", code: "BLOCKED" } };
  return next();
});

// B. 单调守卫（同步，绝对否决，不受注册顺序影响）
ctx.effect(() => ctx.tools.guard((exec) => (forbidden(exec.name) ? "blocked by policy" : undefined)), "my-guard");

// C. 工具裁剪（只能减，不能加；必须 agent.ctx）
agent.ctx.tools.restrict({ deny: ["bash"] });

// D. 结果后处理（改写/阻断返回内容）
ctx.on("tools/post-execute", async (exec, result, next) => next());

// E. 只读观察
ctx.on("tools/result", (exec, result) => { /* ... */ });
```

- waterfall 监听者**不属于自己决策时必须 `return next()`**（否则吞掉后续监听者）。
- `guard` 是**同步**的：需要 await（问用户、调 LLM）的决策必须走 `tools/pre-execute` 的 `ask`。
- 作用域：普通 `ctx` 上注册 = 全局；`agent.ctx` 上注册 = 仅该 agent（配合 `agent/created` 注册、`agent/disposed` 清理）。

### 2.4 现成可抄的生产实现

1. **本机第三方插件 dsh-ops**（`C:/Users/<you>/.dsh/profiles/desktop/node_modules/dsh-ops`）—— 活证据：
   - `lib/index.js`：`ctx.on("tools/pre-execute", async (exec, next) => { const refusal = hostShellRefusal({ toolName: String(exec?.name ?? ""), denied }); return refusal ? { kind: "deny", reason: refusal.reason } : next(); });` 以及 `ctx.effect(() => ctx.tools.guard(exec => hostShellRefusal({...})?.reason), "dsh-ops: host shell guard");`
   - `lib/official-tool-hiding.js:104-160`：deny 附带 `info: { name: "ReadinessError", code: "READINESS_BLOCKED" }`；并用 `agent.ctx.tools.restrict({ deny })` 在 `agent/created` 时裁剪、`agent/disposed` 时解除。
   - `lib/workspace-preparation.js` 用 `tools/execute`；`lib/modes/native/read-dedup.js` 用 `tools/result`。
2. **官方 `@deepseek-ai/dsh-experimental-auto-review`**：Auto 权限预设的逐调用 LLM 风险审查，返回 `{ kind: "deny", reason, info }` 或 `{ kind: "ask", reason, displayReason: { en, zh } }`，并按 `permissionPresets.current(agent.session)` 决定是否介入。
3. 其他 seam 消费者：`dsh-tool-call-timeout-policy` / `dsh-session-checkpoint-policy`（tools/execute）、`dsh-repeat-tool-reminder` / `dsh-spill-policy` / `dsh-tool-fs-search`（tools/post-execute）、`dsh-workspace-changes` / `dsh-tool-jobs`（tools/pre-execute）、`dsh-subagent`（tools.guard）。

### 2.5 批准（ask）通道

`@deepseek-ai/dsh-user-approval/lib/index.js`（8474 B）导出 `ApprovalRequestId`、`APPROVAL_POLICIES = ["ask","never"]`、`ApprovalService`（默认）、`setApprovalPolicy`。
- `ctx.approval.request({ agent, toolName, callId, reason?, displayReason?, signal })`；必须在打开的 turn 内（扫描 `turn/start` / `turn/end`），否则抛错。
- 结果词汇：`allowed-once`（唯一放行）/ `rejected` / `cancelled` / `unavailable`。
- 应答者是 `approval/request` waterfall 的监听者；没有可用应答者时 **fail closed** 为 `unavailable` → deny。
- 权限预设 `@deepseek-ai/dsh-permission-presets` 把 `{ sandbox, approval }` 打成名（read-only / workspace-write / danger-full-access），另有保留名 `custom`、`auto`。本机默认 `danger-full-access` + `approval: never` —— 意味着任何依赖「用户点同意」的方案在本机默认失效。

### 2.6 第二道闸：文件层拦截

除工具层，`ctx.fs` 写入还有单槽 waterfall：
- `fs/write-intent`：`(target: FsTarget, actor, next) => Promise<FsWriteIntent | undefined>`，「下一个 FileSystem.writeText 的单槽决策，第一个返回 intent 的监听者独占决策」。
- `fs/edit-intent`：同上，针对 `editText`。
- `fs/observed`：同步记录器（抛错会使工具调用失败）。

### 2.7 PTC（run_code）模式的影响

本机 preset 为 `ptc`（`agent-preset-registry selectedDefault: ptc`）。`dsh-tools/README.md` 明确：ptc 下模型直调面收敛为 `run_code`，直调其他工具名在策略前就判 `UNKNOWN_TOOL`；但 **`run_code` 内部子调用带 `parent` token（callId 形如 `<parent>:ptc:<n>`）仍走同一条 prepareExecution 策略管线**。所以 pre-execute 拦截对 PTC 子调用同样有效（`dsh-experimental-auto-review` 正是显式跳过 `exec.parent === undefined && exec.name === RUN_CODE_NAME` 这一情形）。

---

## 3. Lead 的三个交叉验证点

### 3.1 `tools/pre-execute` 能否改写 `exec.arguments`？

**不能。你的结论正确。**

证据（`dsh-tools/lib/index.js`）：
- 3259-3264：`const detached = snapshotJsonValue(exec.arguments); if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable"); const execution = { ...base, arguments: deepFreeze(detached) };`
- `deepFreeze` 来自 `@deepseek-ai/dsh-util-values`（迭代 WeakSet 遍历 + 每个节点 `Object.freeze`，跳过 `AbortSignal`）→ 任何嵌套对象都不可写。
- 3506：`Object.freeze(exec);`（exec 本体也冻结）。
- 3389-3410 `dispatchToolBody(exec)`：`const returned = await tool.execute(exec.arguments, exec);` —— 直接用同一个冻结对象，策略阶段之后不再重新校验参数。

因此：ESM 严格模式下写冻结属性会抛 TypeError；即便静默忽略，dispatch 读的仍是 `exec.arguments`，改写也不会生效。**要改行为请用 `tools/execute`（包一层）或 `tools/post-execute`（改结果），要阻止请用 deny/ask。**

### 3.2 除「profile node_modules + dsh.profile.bundles + 插件自身 cordis.patch.yml」外，还有别的注册路径吗？

**有，共 8 条。**

1. **profile 用户层** `~/.dsh/profiles/<name>/cordis.patch.yml`：顶层 YAML 数组，元素为补丁项 —— `- id: <rowId>` + `config` / `disabled`，或 `- insert: [ { id, name, config, disabled } ]`，支持 `!!js` 表达式。本机的权限预设、插件市场索引、dsh-ops 各行、better-sidebar、magpie MCP、llm-pi-ai 全在这里（该文件 19465 B）。
2. **home 级用户层** `$DSH_HOME/cordis.patch.yml`（`homePatchPath()`，`dsh/lib/profile-boot-C14i-8IN.js:115`）：机器级偏好，作用于**每个** profile，且**优先级高于** profile 层。（本机该文件**不存在**，`C:/Users/<you>/.dsh/cordis.patch.yml` 已核实缺失 —— 这是能力，不是现状。）
3. **`--patch <file>` CLI 覆盖层**：按 argv 顺序叠加，位于 home 层之后。
4. **任意 bundle 的 `- insert:` 行可以直接挂任意模块说明符**，不必是自己的包（本机就用 insert 挂了 `@deepseek-ai/dsh-mcp-client` 的 rea 行；dsh-ops 用 insert 挂了自家 `./shell`、`./file`、`./ptc` 子路径）。
5. **agent preset 的 `config.plugins`**：`dsh-web-app/presets/{cordis,minimal,ptc,standard}.patch.yml` 描述每个 preset 挂哪些行；Plugins 页面里「Agent-preset rows remain read-only」。
6. **动态双半插件（cordis_define 路线，无需 npm 安装）**：`@deepseek-ai/dsh-cordis-host-runner`（动态包定义注册表 + host 沙箱生命周期）、`dsh-cordis-client-runner`（浏览器半 + guard facade + loader 条目）、`dsh-tool-cordis`（只读运行时 API 检视）、`dsh-client-ui-cordis`（`cordis_define` 工具行 + run/stop 开关）。
7. **`plugin_manager` API**：`listVersionExemptions / setVersionExemption / listPlugins / listBundles / registries / inspect / setPluginEnabled / setBundleEnabled / installBundle / waitForInstall / cancelInstall / removeBundle`；实际是在 profile 目录内跑 pnpm（`pnpmCommand` 默认 `pnpm`，回退源 `https://registry.npmmirror.com/`，失败时还原 `package.json` + `pnpm-lock.yaml`），并会改写 `pnpm-workspace.yaml` 批准依赖构建脚本。
8. **profile 的 `cordis.yml` 根文件 —— 不是注册路径**：`prepareProfile()` / `composeProfile()` 每次启动都重写为 `[]`（`PROFILE_ROOT_CONFIG` 注释原文：dsh profile root — an empty entry list… Edit cordis.patch.yml, not this file.）。它存在只是给 Loader 一个真实 include 根来锚定 `baseUrl`。

**权威层序**（`profile-boot` composeProfile 注释）：bundle 层（按 `dsh.profile.bundles` 顺序）→ profile 用户层 → home 用户层 → `--patch` 覆盖层 → telemetry 开关。

**能力边界**：`plugin_manager` README 原文 —— 「Every tool action requires danger-full-access or approval for that call… installed Host code executes in-process outside the workspace sandbox」。即插件是进程内全权宿主代码，**没有插件级权限沙箱**。dsh-ops 里的 `dsh-plugin.json`（manifestVersion 0.15、`permissions[]`）来自外部 T-Auto/dsh-std schema，DSH 核心不校验、不强制。

### 3.3 有没有把 user prompt 注入上下文的公开扩展点？

**有，四条，按推荐度排序。**

1. **`agent/pre-step` waterfall（最接近 additionalContext）**：
   `@deepseek-ai/dsh-agent-loop/lib/index.js:902-925` `preStep()`：
   ```js
   const decision = await this.dispatch.waterfall("agent/pre-step",
     { messages: claimed, ...position, signal },
     () => { /* 默认 */ return Promise.resolve({
       kind: "enter",
       messages: context === void 0 ? claimed : [...claimed, context],
     }); });
   if (decision.kind === "reject") return decision;   // :956-975
   ```
   监听者可以返回改写的 `messages` 数组（**必须 spread 保留 `startsRequestSeries` 等字段**），或返回 `{ kind: "reject" }` 阻止这一步。DSH 自己注入 runtime context 就是走这里。
2. **`agent.inject(message)` + `ctx.systemPrompt.section()`**：随包技能 `cordis-plugin-development/references/practices.md` 的处方 —— 「Add prompt text with ctx.systemPrompt.section(). Add per-agent context with agent.inject(); it is logged as `agent/inbox/spliced` at call time and enters the next admitted step. agent/request listeners cannot change request messages.」这是**官方推荐**做法（因为会落盘到 session log，可回放）。
3. **工具结果的 `additionalContexts`**：`dsh-tools/lib/index.js:3248` `exec.deferContext(context)`、3434 / 3592-3626 把 `additionalContexts` 汇入 loop 的 active-batch FIFO；`tools/post-execute` 的 accept / block 决策都可携带 `additionalContexts`。即「工具执行后附加一段上下文给模型」。
4. **`system-prompt/assemble` waterfall**：整份 PromptAssembly 替换（最强、最危险，需自行保留其他人的贡献）。

注意：`agent/request` waterfall 只能替换 `LlmCallConfig`，**明确不能改 messages**（这是与 prompt 注入最常混淆的一点）。

---

## 4. 技能系统

### 4.1 加载器

包：`@deepseek-ai/dsh-skill-filesystem`（插件名常量 `skill-filesystem`，`inject = ["skills"]`）。

**根目录与优先级（rank 越小越先）**：

| rank | 路径 | source | 备注 |
| --- | --- | --- | --- |
| 100 | `<projectRoot>/.dsh/skills` | project-dsh | projectRoot = 最近含 `.git` 的祖先 |
| 200 | `<projectRoot>/.agents/skills` | project-agents | 跨 agent 共享目录（Claude 生态事实标准之一） |
| 300 | `customSkillDirs` 配置项 | custom | 数组，默认 `[]` |
| 400 | `$DSH_HOME/skills`（= `~/.dsh/skills`） | user-dsh | `skipSystem: true`，跳过 `.system` |
| 500 | `~/.agents/skills` | user-agents | |
| 600 | `bundledSkillDir` | bundled | `trustedHost: true` |

**没有** `.claude/skills` 根。Claude 兼容只体现在 `.agents/skills` 与 `CLAUDE.md` 指令文件。

### 4.2 目录形态

`discoverRoot(dir)` 对每个条目：
- 目录 → `<dir>/SKILL.md`，`resourceBase = { kind: "directory", path: <dir> }`
- 以 `.md` 结尾的文件 → 扁平技能，`resourceBase` 目录取根本身
- `root.skipSystem` 时跳过 `.system` 目录

即 `skills/foo/SKILL.md` 与 `skills/foo.md` 两种写法都支持。符号链接可用（读写走 `realpath()`）。

### 4.3 Frontmatter 规范

解析：首行必须恰好 `---`（容忍 CRLF），到下一个 `---` 行结束，用 `yaml` 包 `parse()`，必须是**非数组对象**。

| 字段 | 必填 | 类型 | 说明 |
| --- | --- | --- | --- |
| `name` | ✅ | string | 必须匹配 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` |
| `description` | ✅ | string | 非空 |
| `whenToUse` | ❌ | string | 何时使用（模型可读提示） |
| `metadata` | ❌ | object | 自由结构 |
| `disable-model-invocation` | ❌ | boolean | true → 模型不可主动调用 |
| `user-invocable` | ❌ | boolean | false → 用户不能用 `/name` 触发 |

- 未知键：**静默接受并忽略**（`license`、`allowed-tools` 等 Claude 键不会报错，但也不生效）。
- 旧式键名（`disableModelInvocation` / `modelInvocable` / `userInvocable`）**直接拒收**：`frontmatter field "<legacy>" is unsupported; use "<canonical>"`。
- 失败一律只 `logger.warn`，技能被静默跳过：`skill file <path> ignored: invalid YAML frontmatter: …` / `…: missing YAML frontmatter` / `…: frontmatter requires name and description` / `invalid skill name "X"` / `invalid invocation frontmatter: …`。

### 4.4 与 Claude Agent Skills 的兼容性判定

- ✅ `name` / `description` 语义一致；`foo/SKILL.md` 布局一致；`whenToUse` 是 DSH 额外扩展。
- ✅ 额外键被容忍 → 一份 Claude 技能大概率可直接放进来用。
- ❌ 没有 `allowed-tools` 的权限强制（Claude 用它限制技能可用工具）。
- ❌ 没有 `.claude/skills` 扫描路径（要放 `~/.agents/skills` 或 `~/.dsh/skills`）。
- ⚠️ 技能可携带任意资源文件（含脚本），但**执行只能通过普通 bash/pwsh 工具**，DSH 没有技能自带执行器 —— 所以「技能」本身不是权限边界。

### 4.5 引用与注入

- `@deepseek-ai/dsh-tool-skill`：模型面向的 `skill` 工具 + 一条持久化的技能目录 user message（`catalogDescriptionMaxLength` 默认 500）+ 显式 `/name` 用户调用。
- 统一渲染：`<skill_content>` 由 `@deepseek-ai/dsh-skill` 的 `renderSkillContent` 生成。

### 4.6 挂载现状（本机）

- `dsh-base/cordis.patch.yml` 插入 `skill`（dsh-skill）、`skill-filesystem`、`tool-skill` 三行。
- `dsh-web-app/cordis.patch.yml` 在 host 层 **禁用** `skill-filesystem` 与 `tool-skill`（注释说明：由 preset 拥有本地发现）。
- `dsh-web-app/presets/cordis.patch.yml` 重新启用，并给 `customSkillDirs` 注入 `<resolved @deepseek-ai/dsh-agent-preset>/skills`。
- 随包技能：`dsh-agent-preset/skills/` 下 `agent-experience`、`cordis-composition-reference`、`cordis-plugin-development`、`editing-cordis-compositions`。

**磁盘实况**：`~/.dsh/skills` 下 3 个符号链接 `find-skills`、`frontend-design`、`hd2-lua-mod` → `C:/Users/<you>/.config/magpie/library/skills/*`；该库另有 `reverse-engineer-anything`、`scan-to-fixed-address`，二者又是指向 `C:/Users/<you>/.agents/skills/*` 的符号链接。

真实 frontmatter 样本：
- `find-skills`：仅 `name` + `description`。
- `frontend-design`：`name` + `description` + `license: Complete terms in LICENSE.txt` —— **证明多余键被容忍**。
- `hd2-lua-mod`：`name` + `description` + `whenToUse`。

---

## 5. 插件系统

### 5.1 模型

- 基于 **Cordis**（`@deepseek-ai/cordis` 4.0.5）。插件 = ES module，导出 `apply(ctx, config)`，可选 `name` / `inject` / `Config`（schemastery schema）。
- 服务：`ctx.<name>`；事件：`ctx.on` / `ctx.waterfall` / `ctx.serial` / `ctx.bail` / `ctx.parallel`；生命周期：`ctx.effect(disposer, label)`；作用域：`ctx.extend` / `ctx.isolate` / `ctx.intercept`。
- 组合 = 补丁树：根 `cordis.yml` 恒为 `[]`，实际树由各 bundle 的补丁层叠加而成。

```
<!-- profile/cordis.yml -->
[]

<!-- profile/package.json -->
{ "dsh": { "profile": { "bundles": [ "@deepseek-ai/dsh-base", "dsh-ops", "my-plugin", ... ] } } }

<!-- my-plugin/package.json -->
{ "dsh": { "bundle": { "patch": "./cordis.patch.yml" } } }

<!-- my-plugin/cordis.patch.yml -->
- insert:
    - id: my-guard
      name: my-plugin/guard
      config: { denyTools: ["bash"] }
```

### 5.2 Bundle 清单契约

- `package.json` → `dsh.bundle.patch`：指向本 bundle 的补丁文件（`billion-context` 用的是 `./dsh.bundle.patch.yml`，名字任意）。
- 可选 `dsh.client = { inject: [...], platform: "web" }`：声明浏览器半依赖。
- 一个包可导出多个子路径插件，用多行 insert 挂载：dsh-ops 的 exports 含 `./shell`、`./file`、`./ptc`、`./panel`、`./tui`、`./discovery`、`./hide-official`、`./background`、`./policy`、`./client`，对应稳定的行 id（`dsh-ops-shell`、`dsh-ops-file`、`dsh-ops-ptc`、`dsh-ops-discovery`、`dsh-ops-panel`(disabled)、`dsh-ops-tui`(disabled)、`dsh-ops-hide-official`(disabled)）。**这是「一个包交付多行插件」的范式，也是本次要实现形态的最佳模板。**

### 5.3 安装与开关

- 位置：`C:/Users/<you>/.dsh/profiles/desktop/node_modules/<pkg>`
- 依赖登记：profile `package.json` 的 `dependencies`
- 启用：profile `package.json` 的 `dsh.profile.bundles`（有序；**enable 时追加到末尾，会改变配置优先级**）
- 单行开关：profile `cordis.patch.yml` 里最后一条匹配的 `- id: <row>` + `disabled: true/false`（匹配 id + 可选模块名断言）
- Web 侧边栏 **Plugins 页面** = `@deepseek-ai/dsh-client-ui-plugin-manager`；模型侧 `plugin_manager` 工具 = `@deepseek-ai/dsh-plugin-manager`。
- 安装规范（随包技能 `cordis-plugin-development` 明示）：在 workspace 里用普通文件写 bundle，然后 `plugin_manager` 的 `install_bundle` 传**绝对包目录**；**不要**手写 profile 的 `package.json` / `cordis.patch.yml`，不要在 `$DSH_HOME` 下建包，不要在 profile 目录跑 pnpm。

### 5.4 相关包职责

| 包 | 职责 |
| --- | --- |
| `@deepseek-ai/cordis` | 插件/服务/事件/作用域内核 |
| `cordis-plugin-loader` / `-group` / `-include` / `-timer` | Loader（树装配、分组、include、定时器） |
| `dsh-plugin-manager` | 安装/卸载/启停 bundle 与行，跑 pnpm |
| `dsh-client-ui-plugin-manager` | Web 侧 Plugins 页面 |
| `dsh-plugin-market` / `dsh-plugin-market-index` | 插件市场索引（Discover 页 + `plugin_market` 工具） |
| `dsh-client-ui-plugin-market` | Discover 标签页 |
| `dsh-client-ui-settings-plugin-inventory` / `-plugins` | 设置里的插件清单（只读） |
| `dsh-host-plugin-inventory` | 宿主插件清单 |
| `dsh-plugin-package-inventory-deepseek` | 把「当前 Loader 装了什么包」上报给官方 DeepSeek LLM API 请求（不是插件源） |
| `dsh-cordis-host-runner` / `dsh-cordis-client-runner` / `dsh-tool-cordis` / `dsh-client-ui-cordis` | 动态双半插件（cordis_define） |

---

## 6. Claude Code / Codex / OpenCode 兼容层

**有官方对应包，但本机既未安装、随包也未附带。**

引用来源：
- `app.asar/dsh/node_modules/@deepseek-ai/dsh/package.json`：devDependencies 里列有 `@deepseek-ai/dsh-hooks-codex`、`@deepseek-ai/dsh-hooks-claude-code`。
- `app.asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md`（41003 B，官方包参考表）：

| 包 | 描述 |
| --- | --- |
| `dsh-hooks-claude-code` | Bridge plugin: run a Claude Code hooks.json / settings hook config on the DeepSeek Harness interception seams |
| `dsh-hooks-codex` | Bridge plugin: run a Codex hooks.json hook config on the DeepSeek Harness interception seams |
| `dsh-experimental-claude-code-mods` | Experimental bridge: load Claude Code mods (hooks modules) and run their hook chains on DeepSeek Harness extension points |
| `dsh-experimental-client-ui-claude-code-mods` | Web band above the prompt for Claude Code mods（可视化） |

**全 asar 文本扫描**（9877 个文本文件）命中这三个名字仅 3 处：上述 `packages.md`、`dsh-cordis-client-runner/lib/client.js`（402285 B，仅在文档化 `conversation.input.dock` 槽位占用者时提到 `experimental-client-ui-claude-code-mods Band id "claude-code-mods"`）、`dsh/package.json`。

**磁盘核对**：`app.asar/dsh/node_modules/@deepseek-ai`、`C:/Users/<you>/.dsh/profiles/desktop/node_modules`、`C:/Users/<you>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies` 三处均**不存在** `dsh-hooks-*` 或 `claude-code-mods` 包（目录枚举 + 递归扫描确认）。

**可选安装目录（Plugins → More）里也没有它们**：`dsh-app-boot/lib/index.js` 的 `const ON_DEMAND_BUNDLES = ["@deepseek-ai/dsh-subagent-claude-code", "@deepseek-ai/dsh-subagent-codex"];` 以及 `OFFICIAL_ON_DEMAND_CATALOG` 中仅有「Claude Code subagent」「Codex subagent」两条。也就是说：**官方 on-demand 目录只提供两个 subagent provider，hook 桥接包不在其中，需要走 registry / 市场自行安装。**

其余 claude/codex 字样均无关：`dsh-subagent-claude-code` / `dsh-subagent-codex`（一次性 subagent provider）、`dsh-tool-str-replace-editor`（Claude 风格编辑器）、`dsh-mcp-client`（`mcp__server__tool` 命名与 Claude/Codex 同形）、`dsh-agent-instructions`（读 `CLAUDE.md`）。

**OpenCode**：本机安装的 `dsh-opencode-go` 0.1.24 是 LLM 协议适配器（`protocolOverrides`），**不是** OpenCode 插件兼容层；asar 内没有 opencode 插件宿主实现。

---

## 7. 插件市场指向哪里

- `@deepseek-ai/dsh-plugin-market`：配置 `indexes: z.array(z.string().pattern(/^https?:\/\/\S+$/u)).default([])`，`fetchTimeoutMs` 15000，`maxBytes` 134217728，`cacheTtlMs` 600000；Remote 方法 `listIndexes` / `setIndexes` / `search(url, query)` / `entry(url, name)`。随包默认 **空数组**。
- 本机 profile 补丁把它指向第三方源：`https://raw.githubusercontent.com/yueyexiayu/dsh-market-zh/main/index.json`。
- 索引格式 1（`dsh-plugin-market-index`，13992 B）：
```json
{ "format": 1,
  "title": { "en": "...", "zh": "..." },
  "description": { "en": "...", "zh": "..." },
  "metadata": { ... },
  "plugins": [ { "name": "pkg-name", "title": { "en": "...", "zh": "..." },
    "versions": [ { "version": "1.2.3",
      "source": { "type": "npm", "registry": "https://..." }
    }, { "version": "1.2.4",
      "source": { "type": "git", "url": "https://github.com/u/r", "commit": "<sha>", "path": "packages/x" } } ] } ] }
```
- 安装参数：npm → `name@version`；git → `git+<url>.git#<commit>`（带 path 时追加 `&path:/<path>`）。
- 安装动作本身由 `dsh-plugin-manager` 用 pnpm 在 profile 内执行。

**含义**：第三方插件的发现与分发已经存在一条成熟链路（GitHub raw index + npm/git 安装），本次要交付的 STS 类插件完全可以走「私有/公共 market index 或直接 `install_bundle` 本地目录」两种方式落地。

---

## 8. 对本项目的可行性结论

### 8.1 可行，且无需借用 Claude 兼容层

要实现「Skill + 工具调用前拦截」：

1. **Skill 侧**：写 `~/.dsh/skills/<name>/SKILL.md`（或 `.agents/skills`），`name` + `description` 必填，`whenToUse` 写触发条件；脚本作为资源文件随包放，由技能正文指示模型用 bash/pwsh 调用。零改造。
2. **拦截侧**：写一个 Host 插件 bundle，在 `apply(ctx)` 里注册
   - `ctx.on("tools/pre-execute", async (exec, next) => ...)` —— 读 `exec.name` + `exec.arguments`，需要 await（策略服务、LLM 判定、问用户）时返回 `{ kind: "deny", reason }` / `{ kind: "ask", reason, displayReason }`；
   - `ctx.effect(() => ctx.tools.guard(...))` —— 只需同步绝对否决时的强保证；
   - 可选 `agent.ctx.tools.restrict({ deny })` —— 直接隐藏不该出现的工具；
   - 可选 `tools/post-execute` —— 改写/追加返回内容；
   - 可选 `fs/write-intent` / `fs/edit-intent` —— 文件写入层第二道闸。
3. **上下文注入侧**：`ctx.on("agent/pre-step", ...)` 改写 `messages`，或 `agent.inject(...)`、`ctx.systemPrompt.section()`、`tools/post-execute` 的 `additionalContexts`。

### 8.2 需要注意的约束

1. **不能改写工具参数**（深冻结）—— 只能放行 / 否决 / 问 / 后处理结果。若 STS 语义包含参数重写，需退化为「否决 + 提示」，或改用 `tools/execute` 包一层自行构造调用。
2. **`guard` 是同步的** —— 需要 IO 的判定必须走 `tools/pre-execute` 的 deny/ask，不能做成 guard。
3. **本机默认 `approval: never` + `danger-full-access`** —— 任何「弹窗让用户点同意」的设计在本机默认会 fail closed 成 deny；要么改成 deny + 文案，要么把预设切到 `ask`。
4. **ptc 模式下 `run_code` 是唯一模型直调面** —— 拦截必须覆盖 `exec.parent !== undefined` 的子调用，否则只挡外层 run_code 等于没挡（`dsh-experimental-auto-review` 的写法可参考）。
5. **插件是进程内全权代码**，无沙箱、无权限声明机制；分发到第三方需自行承担信任成本。
6. **不要手改 profile 配置文件** —— 走 `plugin_manager` / `install_bundle`，否则与 Loader 的树写回冲突。

### 8.3 与 Claude Code hooks 的语义映射

| Claude Code | DSH 等价物 |
| --- | --- |
| `PreToolUse`（可 deny、可改参数） | `tools/pre-execute`（可 deny/ask，**不可改参数**）+ `ctx.tools.guard`（同步强否决）|
| `PostToolUse` | `tools/post-execute`（可替换 content / block / 附加上下文）|
| `UserPromptSubmit`（注入上下文） | `agent/pre-step`（改写 messages）/ `agent.inject` |
| `SessionStart` / `Stop` | `agent/created` / `agent/turn-stopping` / `session/created` |
| `Notification` | 无直接等价（可用 `approval/request` 或 UI 槽位自建）|
| `hooks.json` 配置驱动 | 官方 `dsh-hooks-claude-code` 桥（本机未装，需自行安装）；否则直接用插件原生 API |

---

## 9. 关键证据清单

| 主题 | 路径 |
| --- | --- |
| 工具管线（权威） | `dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`（3310 prepareExecution / 3321 pre-execute / 3339-3353 deny / 3427 tools/execute / 3600 post-execute / 2743 guardReason / 2991 restrict / 2974 register / 3017 guard / 3259-3263 深冻结 / 3390+3406 dispatchToolBody / 3506 Object.freeze(exec) / 3535 serviceAsk） |
| 管线散文说明 | `dsh/node_modules/@deepseek-ai/dsh-tools/README.md`（Enforce policy on calls / Execution and cancellation / PTC mode） |
| 事件与 Service 契约目录 | `dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js`（663020 B，1988 条，89 个事件名） |
| 批准通道 | `dsh/node_modules/@deepseek-ai/dsh-user-approval/lib/index.js` |
| 权限预设 | `dsh/node_modules/@deepseek-ai/dsh-permission-presets` |
| Auto 审查范例 | `dsh/node_modules/@deepseek-ai/dsh-experimental-auto-review/lib/index.js` |
| 技能加载器 | `dsh/node_modules/@deepseek-ai/dsh-skill-filesystem/lib/index.js` |
| 技能工具与渲染 | `dsh/node_modules/@deepseek-ai/dsh-tool-skill`、`dsh-skill` |
| 指令注入 | `dsh/node_modules/@deepseek-ai/dsh-agent-instructions` |
| Agent 循环（pre-step） | `dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js`（902-925 / 956-975） |
| 插件安装 | `dsh/node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js` |
| 市场索引格式 | `dsh/node_modules/@deepseek-ai/dsh-plugin-market-index/lib/index.js` |
| on-demand 目录 | `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（ON_DEMAND_BUNDLES / OFFICIAL_ON_DEMAND_CATALOG） |
| 官方包参考表 | `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/references/packages.md` |
| 插件开发处方 | `dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/{SKILL.md,references/practices.md}` |
| profile 装配 | `dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot-C14i-8IN.js` |
| 第三方生产实证 | `C:/Users/<you>/.dsh/profiles/desktop/node_modules/dsh-ops/lib/index.js`、`lib/official-tool-hiding.js` |
| 本机 profile | `C:/Users/<you>/.dsh/profiles/desktop/{package.json,cordis.yml,cordis.patch.yml}` |

---

## 10. 未决 / 需实证的点

1. `tools/pre-execute` 的 `exec.arguments` 在 deny 之前是否可能被上游 `tools/execute` 包装器替换 —— 从代码看 `mutableExec` 只允许改 `signal`，参数对象未替换，但未做运行时实证。
2. `ask` 路径在 `approval: never` 预设下的实际体验（直接 deny 文案）未实测。
3. `agent/pre-step` 改写 messages 时对 `startsRequestSeries` 等字段的保留要求来自文档警告，未实测。
4. 官方 `dsh-hooks-claude-code` 包的行为（本机未安装，无法读取实现）—— 若要复用 Claude `hooks.json` 语义，需先安装后验证。

---

*报告基于只读静态取证，未修改任何用户配置或 DSH 安装目录。*