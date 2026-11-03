# rc.5 宿主契约复核（0.2.1-rc.3 → 0.2.1-rc.5）

> 结论先行：**五个宿主 seam 在 rc.5 里全部原样存在，且与 rc.3 逐字节相同**——插件 v0.2.0 用的 API 面（`agent/inbox/claimed`、`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`systemPrompt.context`）在 rc.5 无需改签名即可继续用。**没有任何 rename / removal / 决策联合收缩。**
> 真正会"挂掉"的只有一处，而且不是 API 变更，是**版本闸门**：`engines.dsh` 写成精确版 `0.2.1-rc.3` 时，rc.5 会把整个 bundle 层静默丢弃（写成 `^0.2.1-rc.3` 则通过，已实测）。
> 另有 3 处"必须动代码"的**既有缺陷/口径问题**（与 rc.5 无关，但本轮必须一起修）：`cwdOf()` 优先读了会话创建期快照 `session.header.cwd`、adapter 未分类 `exit_plan_mode`/`workflow`、以及 `systemPrompt.context` 的文本实际落在 runtime-context 用户消息里而不是 system prompt。

被测对象：本机安装的 DeepSeek Harness 桌面版 **0.2.1-rc.5**（Electron，win32-x64，hostProtocolVersion 4，内置 Node 24.21.0，pnpm 11.28.5）。
插件：`dsh-stop-that-shit` v0.2.0（本轮工作区已 bump 到 0.2.1，见 §5.1）。
方法：**npm 上 0.2.1-rc.3 与 0.2.1-rc.5 同包 tarball 逐文件比对** + **asar 内已安装副本 sha256 对齐** + **两次 headless 模型运行**（探针插件 + magpie 模型，含一次 deny 对照）+ 多次 `--dump-config` 与 `dsh plugin` CLI 实测。

---

## 一、结论表：五个 seam 的 rc.5 状态

| seam | rc.5 状态 | 与 rc.3 比较 | 关键实证 |
|---|---|---|---|
| `agent/inbox/claimed` | ✅ 存在，emit | **未变**（`dsh-agent-loop/lib/index.js` sha256 相同） | 实测 payload `{message, turn, agent}`，真实用户 prompt 的 `message.source.kind === "user"` |
| `agent/pre-step` | ✅ 存在，waterfall | **未变** | 实测 payload `{messages, turn, step, signal, agent}`；`next()` 后 `decision.kind === "enter"`；追加合成 user 消息被接受 |
| `tools/pre-execute` | ✅ 存在，waterfall | **未变**（`dsh-tools/lib/index.js` sha256 相同） | 实测 `exec` 9 个自有键；`{kind:"deny",reason}` → 模型收到 `Error: <reason>` |
| `tools/post-execute` | ✅ 存在，waterfall | **未变** | 实测 `(exec, result, next)`，`result` 含 `{isError, content, meta, value}`，默认决策 `{kind:"accept"}` |
| `systemPrompt.context` | ✅ 存在 | **未变**（`dsh-system-prompt/lib/index.js` sha256 相同） | 实测注册返回 disposer、回调 `context = {agent, scope, signal}`、同名重复注册抛错、`order: NaN` 抛 TypeError |
| （辅）`inject` | ✅ | 未变 | `inject=["systemPrompt"]` 生效：`ctx.systemPrompt` 在 `apply` 内可直接用 |
| （辅）`ctx.reflect.get("workingDirectory")` | ✅ | 未变 | `apply` 时为 `null`，工具调用时为服务实例，`get(session)` 返回当前工作目录 |
| （辅）`exec.deferContext` | ✅ | 未变 | 实测结果对象新增 `additionalContexts`，下一 step 进入模型上下文 |

**差异面证据（rc.3 → rc.5）**：305 个 `sharedPackages` 中，

| 类别 | 数量 | 说明 |
|---|---|---|
| 契约相关包，逐文件比对 → **完全相同** | 14 | `dsh-tools`、`dsh-agent-loop`、`dsh-system-prompt`、`dsh-agent`、`dsh-app-boot`、`dsh-tool-cordis`（含 `lib/types/api-catalog.js`）、`dsh-session`、`dsh-scope`、`dsh-working-directory`、`dsh-headless`、`dsh-base`、`dsh-plugin-manager`、`dsh-util-values`、`dsh`（CLI/loader 整树） |
| **实际有代码变化**（同样逐文件比对） | 7 | 全部与宿主契约无关，见下表 |
| 仅 `unpackedSize`/`fileCount` 一致（**未逐字节**） | 275 | 版本号与内部依赖 pin 由 rc.3 → rc.5，代码体量未变 |
| 独立版本号 vendor 包 | 9 | `cordis` 4.0.5 等；rc.3/rc.5 的 `dsh` 包 `dependencies` pin 完全一致（`~4.0.5` / `~1.0.10` / `~1.0.6` / `~1.1.7` / `~3.18.5`） |

7 个真正变化的包：

| 包 | 变化 |
|---|---|
| `dsh-mcp-client` | `resources/list` / `resources/templates/list` 先查 server 能力，未声明 resources 则返回空列表 |
| `dsh-cordis-client-runner` | 浏览器半槽位文档：`ReasoningBodyOwnerProps` 增 `rawText` |
| `dsh-client-ui-chat` | 新增 `reasoningText()`（剥 `<signature>` 包裹），文件数 106→107 |
| `dsh-client-ui-conversation` | View 标签溢出时给 tooltip |
| `dsh-experimental-client-ui-cot-translation` | 注释措辞 |
| `dsh-mcp-resources` | 与 mcp-client 配套 |
| `dsh-llm-deepseek-account` | 一行 `console.info` → `console.error` |

> 校准口径：逐文件 sha256 对比覆盖 **21 个包**（14 个完全相同 + 7 个变化包，含全部契约相关包与类型目录）；其余 **275 个** rc.3/rc.5 成对包只做体量一致性筛查；9 个 vendor 包按 rc.3/rc.5 `dsh` 包的 `dependencies` pin 对比。这一层证据足以支撑"五个 seam 的 emitter 与类型目录未变"，但**不等于**"全 asar 逐字节相同"。

---

## 二、逐 seam 契约（rc.5 实测 + 源码行号）

### 2.1 `agent/inbox/claimed`（emit）

**文档签名**（`dsh/node_modules/@deepseek-ai/dsh-tool-cordis/lib/types/api-catalog.js:3982`）：

```ts
'agent/inbox/claimed'(this: Scoped<Agent>, payload: { agent: Agent; message: UserMessage; turn: number }): void
```

**emitter**：`dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js:106-109`

```js
for (const message of claimed) this.dispatch.emit("agent/inbox/claimed", { message, turn });
```

注意这里**只显式给了 `message` 和 `turn`** —— `agent` 是 `agentEvents()` 熔接进 payload 的：`dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js:242-253`

```js
function agentEvents(ctx, agent, carrier = agentCarrier(agent)) {
  const fused = (payload) => ({ ...payload, agent });
  ...
  emit(name, payload) { const args = [carrier, name, fused(payload)]; ... }
```

**实测 payload**（探针 profile，真实用户 prompt）：

```json
{"payloadKeys":["message","turn","agent"],"turn":1,
 "message":{"role":"user","keys":["content","source","role","id"],
            "contentKind":"array","blocks":["text"],"source":{"kind":"user"},
            "text":"Use the read tool on notes.md, ..."},
 "agent":{"agentCtor":"ReactLoopAgent","agentId":"session-56c4...","sessionId":"session-56c4...",
          "headerKeys":["version","id","createdAt","cwd","isSeeded"],
          "headerCwd":"C:\\Users\\<you>\\AppData\\Local\\Temp\\sts-probe\\ws"}}
```

结论（对插件 `lib/index.js:152-187` 的假设逐条核对）：

| 插件假设 | rc.5 实测 |
|---|---|
| `payload.agent` 存在 | ✅ 存在（由 `agentEvents` 熔接，不是 emitter 显式给的） |
| `message.source.kind === "user"` 对真实用户 prompt 成立 | ✅ 成立 |
| 此时 harness 尚未混入上下文 | ✅ 成立：同一次运行里 `user/message` 事件的 source 依次是 `user`(inbox) → `runtime-context` → `skill-catalog`，后两条在 `systemPrompt.assemble` / `pre-step` 阶段才产生 |
| 顺序：先 claimed、后 pre-step | ✅ 成立：`preStep()` 先 `inbox.claim()`（→ 触发 claimed 事件），再 `assemble()`，再 `agent/pre-step` waterfall（`dsh-agent-loop/lib/index.js:902-920`） |
| 只对"入队 prompt"触发，不会对 `deferContext` / `inject` 的消息触发 | ✅ 实测：一次运行 1 条 `inbox/claimed`，而 `deferContext` 只产生 `user/message`（source `{"kind":"sts-probe","form":"deferred"}`） |

### 2.2 `agent/pre-step`（waterfall）

**文档签名**（api-catalog:4006）：

```ts
'agent/pre-step'(this: Scoped<Agent>, payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
                next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```

`PreStepDecision`（api-catalog:6424）：

```ts
export type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true };
```

**emitter**：`dsh-agent-loop/lib/index.js:909-920`，默认实现 `{kind:"enter", messages: context === undefined ? claimed : [...claimed, context]}`；`reject` 分支在 :922 直接返回。

**实测**（同一次运行的三次 step）：

| step | `payload.messages` | `await next()` 返回的 `decision.messages` |
|---|---|---|
| 1 | 1 条（source `user`） | 3 条，source 依次 `user` / `runtime-context` / `skill-catalog` |
| 2 | 0 条 | 0 条 |
| 3 | 0 条 | 0 条 |

三个必须记住的细节：

1. **`await next()` 之后再 append，合成消息排在本 step 消息数组末尾**（在 runtime-context 与 skill-catalog 之后），不是紧跟用户 prompt。插件 `lib/index.js:191-206` 正是这么做的：行为正确，但"notice 紧贴 prompt"的说法不准确。
2. **tool 续步（step ≥ 2）`payload.messages` 为空**；插件只在 `pendingNotices` 有值时 append 一次（`pendingNotices.delete`），实测确实只注入一次。
3. 合成消息**不需要** host 侧工厂：插件自拼的 `{role:"user", content:[{type:"text",...}], source:{kind:"sts",...}}` 被原样接受，落入 `user/message` 事件的 `data.source`（实测 `source.kind` 可为任意字符串，无 schema 校验）。

### 2.3 `tools/pre-execute`（waterfall）

**文档签名**（api-catalog:4486）+ 决策联合（api-catalog:6427-6428）：

```ts
'tools/pre-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>): Promise<PreToolDecision>

export type PreToolDecision =
  | { kind: 'allow' }
  | { kind: 'deny'; reason: string; info?: ToolErrorInfo }
  | { kind: 'cancel' }
  | { kind: 'ask'; reason?: string; displayReason?: { readonly en: string; readonly [locale: string]: string } };
```

`ToolExecution`（api-catalog:8167-8176）= `ToolExecutionInput + {rootCallId, token}`：

```ts
export interface ToolExecutionInput {
  readonly callId: ToolCallId;
  readonly rootCallId?: ToolCallId;
  readonly name: string;
  readonly schema?: ToolSchema;
  readonly arguments: unknown;
  readonly agent?: Agent;
  readonly parent?: ToolExecutionToken;
  readonly signal: AbortSignal;
}
```

**emitter**：`dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js:3321`

```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
```

管线（rc.5 行号，与 rc.3 完全相同）：

| 行 | 内容 |
|---|---|
| 3239-3254 | `base` 组装：`token / callId / rootCallId / name / signal / agent? / parent? / schema? / deferContext() / concludeTurn()` |
| 3259-3264 | `exec.arguments` 快照 + `deepFreeze`；不可无损 JSON 序列化则抛 TypeError |
| 3310-3369 | `prepareExecution`：pre-execute → ask → cancel → deny → dispatch |
| 3337-3353 | deny 落地：`content:[{type:"text",text:"Error: <reason>"}]`、`isError:true`、`error:{message, info?}`，并 `next({kind:"post-result"})` **跳过 dispatch** |
| 3423-3445 | `dispatchScheduledExecution`：`tools/execute` waterfall → 工具体（:3406 `tool.execute(exec.arguments, exec)`） |
| 3455-3493 | post-execute → finalize → 通知 |
| 3504-3506 | `notifyResult()` 里才 `Object.freeze(exec)`，紧接着 `tools/result` |

**实测 `exec` 形状**（顶层调用 `read`）：

```json
{"execKeys":["token","callId","rootCallId","name","signal","agent","deferContext","concludeTurn","arguments"],
 "name":"read","callId":"call_00_42qq...","rootCallId":"call_00_42qq...",
 "argsKeys":["file_path"],"argsFrozen":true,"execFrozen":false,
 "hasSignal":true,"hasParent":false,"parentIsSymbol":false,"hasSchema":false,"hasToken":true,
 "deferContextType":"function","concludeTurnType":"function"}
```

四点精确结论：

1. `exec.parent` / `exec.schema` 在**不存在时是缺键**（不是 `undefined` 值），因此 `"parent" in exec` 与 `exec.parent !== undefined` 等价可用。
2. **`exec.arguments` 深冻结，`exec` 本身在 pre-execute 阶段尚未冻结**。docs/02 写的"`exec` 自身 `Object.freeze`"对应的是 :3506，那是在 `tools/result` 之前一刻，不是 pre-execute。**参数不可改写**这个结论仍成立（深冻结 + dispatch 直接读 `exec.arguments`，:3406）。
3. **deny 语义实测**：模型侧 `tool_result` 事件原文
   ```json
   {"type":"tool_result","callId":"call_00_owdlex...","status":"error","result":"Error: STS-PROBE-DENY: blocked by sts-probe"}
   ```
   模型当轮放弃重试并复述原因；被拒的调用**仍会走 `tools/post-execute`**（`isError:true`，`result.error.info = {name:"ProbeError", code:"PROBE_DENY"}`）。
4. **PTC 子调用**（`run_code` 内 dispatch）在 `dsh-tools/lib/index.js:1362-1377` 构造：`callId = "<parent callId>:ptc:<n>"`、`rootCallId = parent.rootCallId`、`parent = parent.token`（symbol）、`agent` 透传 → **同一条 pre-execute 管线**，拦 PTC 子调用只需照常实现（`exec.parent !== undefined` 判定）。本 headless rig 未挂 `run_code`，该分支本轮只有源码证据。

### 2.4 `tools/post-execute`（waterfall）

**文档签名**（api-catalog:4478）+ `PostToolDecision`（api-catalog:6384）：

```ts
'tools/post-execute'(this: Scoped<ToolRuntime>, exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision>

export type PostToolDecision =
  | { kind: 'accept'; content?: ContentBlock[]; value?: never; additionalContexts?: UserMessage[] }
  | { kind: 'accept'; value: JsonValue; content?: never; additionalContexts?: UserMessage[] }
  | { kind: 'block'; feedback: ContentBlock[]; additionalContexts?: UserMessage[] };
```

**emitter**：`dsh-tools/lib/index.js:3600`；落地逻辑 :3601-3627（`block` → `isError:true` + `error.message = failureMessageFromContent(feedback)`；`accept` 可替换 `content`/`value`；两者都可挂 `additionalContexts`）。

**实测**：

| 场景 | `result` 键 | `decision` |
|---|---|---|
| 成功 | `["isError","content","meta","value"]` | `{kind:"accept"}` |
| 被 pre-execute deny | `["isError","error","content"]`（无 `value`） | `{kind:"accept"}` |
| 被 `deferContext` 加持 | `["isError","content","meta","value","additionalContexts"]` | `{kind:"accept"}` |

对插件 `lib/index.js:275-292` 的含义：该 seam 只做"释放委派预留"的簿记，签名与语义**完全够用**；但注意 deny 路径下 `result` 没有 `value` 键——若以后想读工具返回值，必须先判 `isError`。

### 2.5 `systemPrompt.context`

**服务方法**（api-catalog:7940 `SystemPrompt` 类）：`context(context: PromptContext): () => void`。

`PromptContext`（api-catalog:6484）：

```ts
export interface PromptContext {
  readonly name: string;
  readonly order: number;
  readonly text: string | ((context: AssembleContext) => string);
  readonly interpolate?: boolean;
  readonly required?: boolean;      // required=true 时即使 runtime context 被抑制仍保留
}
```

**实现**：`dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js`

| 行 | 内容 |
|---|---|
| 44-52 | `CONTEXT_ORDERS`：`WORKING_DIRECTORY:100, SANDBOX_POLICY:110, APPROVAL_POLICY:115, SUBAGENT_DELEGATION:120, TEAM_IDENTITY:125, HARNESS_SOURCE:200, WEB_SURFACE:210` |
| 184-190 | `resolveContext(entry, context)`：函数式 `text` 以 `context` 求值，返回 `{name, text, interpolate?}` |
| 204 | 同层同名重复注册 → `prompt context "<name>" is already registered (for a per-agent override, register through that agent's agent.ctx instead)` |
| 279-282 | `context(context)`：`order` 非有限数 → TypeError；注册走 `layers.effect` → 返回 disposer |
| 324-346 | `refreshContext()`：请求准入时**再次**调用 provider（`required` 的还会被补回） |
| 356-406 | `assemble()`：contexts 按 `order` 升序；`suppressRuntimeContext()` 生效时只保留 `required === true` |
| 151-156 | `renderContextSections()`：`text.length > 0` 才保留 |

**回调实参**：`dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js:291-297`

```js
function assembleContextFor(agent, signal) { return { agent, scope: agent, ...(signal === undefined ? {} : { signal }) }; }
```

**实测**：`contextKeys: ["agent","scope","signal"]`、`hasAgent: true`、`scopeIsAgent: true`、`agent.session.id` 可用 —— 插件 `lib/index.js:300-314` 的 `(context) => context.agent` 写法精确匹配。
注册实测：`disposerType: "function"`；重复注册抛错；`order: NaN` → `TypeError: prompt context "..." order must be a finite number`。

**落点与直觉不同（重要口径）**：`systemPrompt.context` 的文本**不进 system prompt**，而是被 `preStep` 的默认实现渲染成 **runtime-context 用户消息里的一个 section**：

```js
// dsh-agent-loop/lib/index.js:913-919
const sections = renderContextSections(assembly);
const context = this.runtimeContext.project(joinContextSections(sections), sections);
return Promise.resolve({ kind: "enter", messages: context === void 0 ? claimed : [...claimed, context] });
```

实测 session log 的 `user/message`（source `runtime-context`）：

```json
{"kind":"runtime-context","form":"snapshot","sections":[
  {"name":"working-directory:current","text":"Current working directory: ..."},
  {"name":"sandbox:policy","text":"Current DSH file policy: ..."},
  {"name":"approval:policy","text":"Approval policy: ..."},
  {"name":"sts-probe:contract","text":"PROBE-CONTEXT-MARKER-550"}]}
```

所以：插件那段的文案应按"运行时上下文"而不是"系统提示"来写；`order: 550` 排在全部内置 context（100-210）**之后**（实测顺序即上面 4 条）。

### 2.6 辅助面：`inject` / `ctx.reflect` / 会话身份 / `deferContext`

**`inject`**（cordis）：`dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1317-1328`

```js
_refresh() {
  for (const name of Object.keys(this.inject)) { const impl = this._store[name]; if (!impl) { epoch = INACTIVE; break; } ... }
  this._setEpoch(epoch);
}
```

即"注入的服务全部就绪才 apply"；访问未声明注入的服务抛 `cannot get property "<prop>" without inject`（:676），已注入但未激活则抛 `cannot get required service "<prop>" in inactive context`（:687-689）。实测 `apply` 内 `ctx.systemPrompt` 可用、`ctx.systemPrompt.constructor.name === "SystemPrompt"`。

**`ctx.reflect.get(name)`**（cordis:763-772）**绕过注入检查**：服务未提供时返回 `undefined`，不抛错。实测 `apply` 阶段 `ctx.reflect.get("workingDirectory")` → `null`（服务尚未就绪），`tools/pre-execute` 阶段 → 服务实例，`service.get(exec.agent.session)` → 当前工作目录字符串。插件 `lib/index.js:109-115 + 217-225` 的惰性用法是对的。

**会话身份**（实测，跨 4 个 seam 一致）：

| 事实 | 值 |
|---|---|
| `exec.agent.session.id` | `"session-<uuid>"`（字符串），与 `agent.id`、`session.header.id` 三者相同 |
| 稳定性 | 同一次 session 的 `inbox/claimed`、`pre-step`、`pre-execute`、`post-execute`、`systemPrompt.context` 回调拿到完全相同的 id |
| `session.header.cwd` | 存在且等于启动工作目录；`headerKeys = ["version","id","createdAt","cwd","isSeeded"]` |
| `session.header` 语义 | **创建期快照，冻结**：`dsh-session/lib/index.js:1066-1076`（`snapshotSessionHeader` 深拷贝+校验）与 :1336-1346 注释"Kept out of the event log — it is a storage concern"，`get id() { return this.header.id }` |

**`deferContext`**（dsh-tools:3248-3250 / 3432-3435 / 1458-1459）：工具体或 pre-execute 期间调用，结果对象带上 `additionalContexts`，随后进入 loop 的 active-batch FIFO，成为下一 step 的 `user/message`。实测：`tools/post-execute` 的 `result` 多出 `additionalContexts` 键，session log 出现 `user/message` `source:{"kind":"sts-probe","form":"deferred"}`。

---

## 三、兼容闸门（`evaluatePluginCompatibility`）与 `dsh plugin allow-version`

### 3.1 判定逻辑

全部在 `dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js`（rc.3 ↔ rc.5 **逐字节相同**）：

| 行 | 内容 |
|---|---|
| 276-278 | `satisfies()`：`range.trim() !== "" && semver.satisfies(runtimeVersion, range, { includePrerelease: true })` |
| 279-299 | `unmetRequirements()`：**有 `engines.dsh` 就只看它**（:281-285，peer 全部忽略）；否则遍历 `peerDependencies`，只检查 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*` 前缀，`workspace:^ / workspace:~ / workspace:*` 视为等于当前 runtime；两者都没有 → `{}` 兼容 |
| 271-275 | runtime 版本 = **app-boot 自己 package.json 的 version**（即 DSH 版本，实测 0.2.1-rc.5） |
| 311-326 | `evaluatePluginCompatibility(manifest, exemptions, runtimeVersion)`：返回 `{name, version, runtimeVersion, requirements, exempted}` 或 `undefined` |
| 333-336 | 诊断文案（含 `dsh plugin allow-version` 指引） |

**关键 semver 事实**（用 rc.5 自带 semver 7.8.5 实测）：

| `engines.dsh` | 对 `0.2.1-rc.5` 是否满足 |
|---|---|
| `"0.2.1-rc.3"`（精确） | ❌ **false** |
| `"^0.2.1-rc.3"` | ✅ true |
| `">=0.2.1-rc.3"` / `"~0.2.1-rc.3"` | ✅ true |
| `"^0.2.1"`（不带 prerelease） | ❌ **false**（陷阱：看起来更宽松，实际排除所有 rc） |
| `"0.2.1-rc.3 || 0.2.1-rc.5"` | ✅ true（但每升一版就要改，不推荐） |

### 3.2 三种清单写法 → rc.5 实测结果

| package.json | 结果 | 证据 |
|---|---|---|
| `engines.dsh: "0.2.1-rc.3"`（精确） | ❌ **整个 bundle 层消失** | 实测 stderr：`dsh: skipping profile bundle "dsh-stop-that-shit": Error: Plugin dsh-stop-that-shit@0.1.0 is incompatible with dsh 0.2.1-rc.5: requirements {"engines.dsh":"0.2.1-rc.3"} ... Exact-version exemption: not active.`；`--dump-config` 里 0 行 `sts-native`，**退出码 0** |
| `engines.dsh: "^0.2.1-rc.3"`（当前工作区） | ✅ 正常挂载 | `--dump-config` 末尾出现 `# == dsh-stop-that-shit` 注释段与 `- id: sts-native` / `name: dsh-stop-that-shit` 两行，stderr 空 |
| 不写 `engines.dsh` / 不写 dsh peer | ✅ 放行 | `unmetRequirements` 返回 `{}`（:286） |

跳过行为的两级与可观测性：

- **bundle 级**：`loadProfileDirectory` 里 `evaluatePluginCompatibility` 失败且未豁免 → 抛错被 catch 进 `skippedBundles`（:1015-1051），由 `reportSkippedBundles()` 打到 stderr（:537-539）。
- **row 级**（profile/bundle 里 `insert` 的行）：`prepareProfileEntries → preflight` 对每行读 manifest 再判一次，不兼容则 `row.disabled = true` 并打 `dsh: disabling profile plugin row "<id>": ...`（:2305-2337）。

### 3.3 精确版豁免：`dsh plugin allow-version`

语义：**只豁免"这个包的精确版本 + 这个精确 runtime 版本"这一对**，落在 `<profile>/compatibility.json`。

- 文件名常量：`PROFILE_COMPATIBILITY_FILENAME = "compatibility.json"`（app-boot:341）
- 校验/写入：`validatePluginVersionExemption`（:361-365）、`setProfileVersionExemption`（:434-452，`--accept-risk` 必填，追加 `[...new Set([...versions, runtimeVersion])]`）
- 安装时提示：`dsh: to accept the risk, run: dsh plugin --profile <p> allow-version <name>@<version> --dsh-version <runtime> --accept-risk`（`dsh/lib/plugin-BiveYA7h.js:95`）
- CLI 子命令：`allow-version` / `revoke-version` / `version-exemptions`（同文件 :16-48）

**实测**（scratch profile `stsprobe`）：

```bash
$ dsh plugin --profile stsprobe version-exemptions
{}
$ dsh plugin --profile stsprobe allow-version fake-plugin@1.0.0 --dsh-version 0.2.1-rc.5 --accept-risk
dsh: warning: allowing incompatible plugin versions can break the application or corrupt data. ...
dsh: allowed fake-plugin@1.0.0 for DSH 0.2.1-rc.5
$ cat ~/.dsh/profiles/stsprobe/compatibility.json
{ "fake-plugin@1.0.0": [ "0.2.1-rc.5" ] }
$ dsh plugin --profile stsprobe revoke-version fake-plugin@1.0.0 --dsh-version 0.2.1-rc.5
dsh: revoked fake-plugin@1.0.0 for DSH 0.2.1-rc.5   # 文件变回 {}
```

**给本项目的结论**：豁免是"逃生舱"，**不应当是发布形态**。正确写法是让 `engines.dsh` 语义化地覆盖未来 rc（`^0.2.1-rc.3`），这样 rc.4/rc.5/rc.6/0.2.x 正式版都能过；而 `^0.2.1` 那种"去掉 prerelease"的写法反而会挂。

### 3.4 bundle 解析与 junction

| 行 | 内容 |
|---|---|
| app-boot:995-1001 | `resolveBundleDir`：先 dsh 安装目录、再 profile 目录两个锚点；用 `createRequire(anchor).resolve.paths()` 探测目录（不要求包导出 `./package.json`），`existsSync` 天然跟随 symlink/junction |
| app-boot:637-646 | `removeLinkProjections`：只删指向 `<profile>/.dsh-module-fallback/node_modules` 的链接，其它链接（含我们的 junction）不动 |
| app-boot:664-680 | `linkedProfileRoots`：把"指向 profiles 树之外"的链接识别为 linked root（供宿主插件清单上报） |

实测：`C:\Users\<you>\.dsh\profiles\stsrc5\node_modules\dsh-stop-that-shit` 是指向仓库的 junction，bundle 正常解析并挂载（见 §3.2 第二行）。

---

## 四、stsrc5 挂载清单（base + headless）

profile：`~/.dsh/profiles/stsrc5`，`dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", "dsh-stop-that-shit"]`，`node_modules/dsh-stop-that-shit` 为指向本仓库的 junction，`cordis.patch.yml` 仅含 `llm-pi-ai`（magpie）与 `agent-default-model` 两行。

组合树共 **99 行**（`--dump-config` 输出 1264 行文本）。STS 只贡献 **1 行、0 个工具**：

```yaml
# == dsh-stop-that-shit
- id: sts-native
  name: dsh-stop-that-shit
```

### 4.1 模型可见工具（实测：session log `request/header`，共 25 个）

| 工具名 | 提供行（`--dump-config` 的 `name:`） | 说明 |
|---|---|---|
| `read` / `write` / `edit` / `read_image` | `@deepseek-ai/dsh-tool-fs` | STS 核心拦截面 |
| `glob` / `grep` | `@deepseek-ai/dsh-tool-fs-search` | |
| `pwsh` | `@deepseek-ai/dsh-tool-pwsh` | **Windows 上唯一的 shell**；`tool-bash` 行 `disabled: !!js process.platform === 'win32'` |
| `job_list` / `job_output` / `job_kill` | `@deepseek-ai/dsh-tool-jobs` | |
| `skill` | `@deepseek-ai/dsh-tool-skill` | |
| `todo_write` | `@deepseek-ai/dsh-tool-todo` | |
| `create_goal` / `get_goal` / `update_goal` | `@deepseek-ai/dsh-tool-goal` | |
| `web_search` / `web_fetch` | `@deepseek-ai/dsh-tool-web` | |
| `subagent` / `subagent_fork` | `@deepseek-ai/dsh-tool-subagent`（两行，`config.toolName` 区分） | 委派预算面 |
| `list_agents` / `send_message` / `interrupt_agent` | `@deepseek-ai/dsh-tool-subagent-control` + `.../list-agents` | Agent Teams 基座 |
| `workflow` | `@deepseek-ai/dsh-tool-workflow` | 脚本化工作流（可再起子代理） |
| `exit_plan_mode` | `@deepseek-ai/dsh-plan-mode` | |
| `working_directory` | `@deepseek-ai/dsh-tool-working-directory` | 会改会话 cwd，见 §5.2 |

未挂载但 adapter 已分类的名字（属于 desktop/PTC 面，由 task-2 负责）：`run_code`、`present`、`ask_user_question`、`str_replace_editor`、`spawn_teammate`、`team_task_*`、`ops_*`、`terminal_*`、`bash`（win32 关闭）、`create_worktree`。
**本 rig 也没有 `run_code`**，所以 PTC 的 `exec.parent` 只有源码证据（§2.3 第 4 点）。

---

## 五、必需改动清单（映射到仓库文件）

> 结论：**seam 层零改动**；下面每一条都是"闸门 / 口径 / 分类"层面的必要修正。
>
> **落地状态（2026-11-03 复核工作区）**：5.1 / 5.2 / 5.3 已由 plugin-fix 落地并在 rc.5 上逐项复核通过 —— `engines.dsh = "^0.2.1-rc.3"`、`cwdOf()` 已改为优先 `workingDirectory` 服务、`analyzeDshTool("exit_plan_mode") === "control"` 与 `analyzeDshTool("workflow") === "delegate"` 实测符合预期；5.4 已落地（注册项现为 `interpolate: false` + `required: true`）；5.5 是文档勘误，`docs/02` 已随本次发布修订。

### 5.1 `package.json` —— `engines.dsh` 绝对不能精确 pin

现状（本轮工作区已由 plugin-fix 改动，尚未提交）：

```json
"version": "0.2.1",
"engines": { "dsh": "^0.2.1-rc.3", "node": ">=22" }
```

- ✅ 保留 `^0.2.1-rc.3`（rc.5 实测通过；且不会像 `0.2.1-rc.3` 那样在 rc.5 上整层消失）。
- ❌ 不要改成 `^0.2.1`（会排除所有 rc）；也不要写死成 `0.2.1-rc.5`（下个 rc 再次失效）。
- 发布形态建议：`engines.dsh` 用 caret；`@deepseek-ai/dsh-*` 的 peerDependencies **一个都不要写**（只有不写 `engines.dsh` 时才看 peer，写了精确 pin 必挂）。

### 5.2 `lib/index.js` —— `cwdOf()` 读错了字段（真实缺陷）

现状（`lib/index.js:91-96`）：

```js
function cwdOf(exec, fallback) {
  const session = exec && exec.agent && exec.agent.session;
  const cwd = session && session.header && session.header.cwd;   // <- 创建期快照
  if (typeof cwd === "string" && cwd) return cwd;
  return fallback();
}
```

证据链：

1. `session.header` 是**创建期**深拷贝快照（`dsh-session/lib/index.js:1066-1076`），注释明确"Kept out of the event log"（:1336-1340）；
2. `working_directory` 工具执行 `cd` 时只 append `working-directory/change` 事件（`dsh-working-directory/lib/index.js:139`），**不会改 header**；
3. 权威当前目录是投影：`workingDirectory.get(session)`（`dsh-working-directory/lib/index.js:76-78`），runtime-context 里那句 `Current working directory: ...` 就是它渲染的（:121-123）。

后果：模型一旦用 `working_directory` 换过目录，插件仍用初始目录解析相对路径 → `adapter.absolutePath()` 归一化错误 → 误放行 / 误拒。

建议改法（优先服务、header 只做兜底）：

```js
const cwdOf = (exec) => {
  const session = exec && exec.agent && exec.agent.session;
  const service = workingDirectory();
  if (service && session && typeof service.get === "function") {
    try {
      const resolved = service.get(session);
      if (typeof resolved === "string" && resolved) return resolved;
    } catch { /* fall through */ }
  }
  const header = session && session.header ? session.header.cwd : undefined;
  if (typeof header === "string" && header) return header;
  return fallbackCwd();
};
```

（服务仍可能因 profile 未挂 `dsh-working-directory` 而不存在 —— 保留 header / process.cwd 兜底。）

### 5.3 `lib/adapter.js` —— 两个挂载中的工具名落到 `mutability:"unknown"`

用 `request/header` 的 25 个真实工具名逐一对照 `analyzeDshTool`：

| 工具名 | 当前分类 | 建议 |
|---|---|---|
| `exit_plan_mode` | ❌ unknown | 加入 `CONTROL_TOOLS`（呈现计划、不改工作树） |
| `workflow` | ❌ unknown | 加入 `DELEGATE_TOOLS`（脚本可再起子代理，按委派计预算），或至少显式 `control` + 说明 |
| `working_directory` | ✅ control | 但它会改变 cwd（配合 §5.2） |

其余 22 个名字（`read` / `write` / `edit` / `read_image` / `glob` / `grep` / `pwsh` / `job_*` / `skill` / `todo_write` / `create_goal` / `get_goal` / `update_goal` / `web_search` / `web_fetch` / `subagent` / `subagent_fork` / `list_agents` / `send_message` / `interrupt_agent`）已正确分类，**无需改动**。

DESKTOP 面（task-2 负责，这里只提示）：`present` / `ask_user_question`（已 control）、`spawn_teammate` / `team_task_*`（已 delegate / control）、`run_code`（已 control，子调用单独判）都已覆盖；**新增工具名应集中登记在一个地方**，避免再次 unknown。

### 5.4 `systemPrompt.context` 注册项（已落地）

- 原注册 `{name:"sts:contract", order:550, text:(context)=>...}` 没有 `required: true`。若某个 profile/preset 调了 `systemPrompt.suppressRuntimeContext()`（如 `dsh-persona` 的 `includeRuntimeContext: false`，`dsh-system-prompt/lib/index.js:243`），非 required 的 context 会被整体丢弃（:394 / :332），插件的契约文本就静默消失 —— 拦截本身不受影响，但"告诉模型当前布防状态"的价值没了。
- `required: true` 在本插件上是安全的：未布防时 `text` 返回 `""`，而 `renderContextSections` 会过滤空文本（:151-156），不会污染提示。本轮已在 `lib/index.js` 落地（同时加 `interpolate: false`，避免契约文本里的 `{{` 被当成提示变量模板）。
- 文案层面：这段文字是作为 runtime-context 的一个 section 出现的（§2.5），不是 system prompt，措辞上不要自称"系统提示 / 系统指令"。

### 5.5 文档口径勘误（`docs/02`、`e2e/REPORT` 的相关句子）

| 原文 | 更正 |
|---|---|
| docs/02 §2.2 "3506 `Object.freeze(exec)`（exec 本体也冻结）" | 该行在 `notifyResult()` 里、post-execute **之后**；pre-execute 阶段 `exec` 未冻结，冻结的只有 `exec.arguments`（:3259-3264）。结论"不能改写参数"不变 |
| e2e/REPORT §5.4 "要么写 `"engines": {"dsh": "0.2.1-rc.3"}`" | 该建议已作废：精确版在 rc.5 上整层被丢弃（§3.2 实测）。应写 caret |
| e2e/REPORT §7.9 "`systemPrompt.context` 动态上下文" | 落点是 runtime-context 用户消息的 section，不是 system prompt（§2.5） |
| e2e/REPORT §5.1 "`exec`: { token, callId, rootCallId, name, signal, agent, deferContext, concludeTurn, arguments }" | ✅ 与 rc.5 实测完全一致（`parent` / `schema` 仅在存在时出现） |

---

## 六、未覆盖 / 残留风险

1. **desktop profile 工具面**（`run_code` / `ops_*` / `terminal_*` / `present` / `spawn_teammate` 等）由 task-2 负责；本轮只覆盖 base+headless（stsrc5）的 25 个工具。
2. **PTC 子调用**（`exec.parent`）在本 rig 无 `run_code`，只有 `dsh-tools:1362-1377` 的源码证据。
3. **desktop GUI 加载路径**未验证（本轮全部是 headless CLI）。
4. 没有 rc.4 基线：本文只比较 rc.3 → rc.5。rc.3 与 rc.5 的这些包逐字节相同，说明中间版本要么没动它们、要么被回滚，不影响结论。
5. 探针 profile `~/.dsh/profiles/stsprobe` 与 `%TEMP%\sts-probe\` 是 scratch，可随时删除；**桌面真 profile 全程未触碰**。
6. 275 个"仅体量一致"的包未逐字节比对（见 §1 的校准口径）。

---

## 七、证据清单

| 主题 | 路径 / 行 |
|---|---|
| 工具管线（rc.5 = rc.3） | `dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js`：3239-3264（exec 组装 / 深冻结）、3310-3369（prepareExecution）、3337-3353（deny）、3390-3415（dispatch）、3504-3506（notifyResult 冻结）、3535（serviceAsk）、3599-3627（postExecute）、1362-1377（PTC 子调用）、1458-1459（additionalContexts / concludesTurn） |
| Agent 循环 | `dsh-agent-loop/lib/index.js`：103-111（inbox.claim → claimed 事件）、902-927（preStep：claim → assemble → pre-step） |
| Agent 事件熔接 | `dsh-agent/lib/index.js`：242-273（agentEvents：payload 注入 agent）、291-297（assembleContextFor） |
| 系统提示 / 上下文 | `dsh-system-prompt/lib/index.js`：44-52（CONTEXT_ORDERS）、151-156、184-190、204、279-282、324-346、356-406 |
| seam 类型目录（权威声明） | `dsh-tool-cordis/lib/types/api-catalog.js`：3980-3985、4004-4009、4476-4489、6383-6384、6423-6428、6483-6484、7939-7940、8159-8191 |
| 版本闸门 | `dsh-app-boot/lib/index.js`：252-336（判定 + 文案）、341（compatibility.json）、361-365、434-452（豁免读写）、995-1001（bundle 解析）、1015-1051（loadProfileDirectory）、537-539（skipping 日志）、2305-2337（row 级 preflight）、637-646（link 投影） |
| CLI 豁免子命令 | `dsh/lib/plugin-BiveYA7h.js`：16-48、95 |
| Cordis inject / reflect | `dsh/node_modules/@deepseek-ai/cordis/lib/index.js`：676、687-689、763-772、1306-1328 |
| 作用域路由 | `dsh-scope/lib/index.js`：327-338（scopeTarget：只过滤监听者，不注入实参） |
| 会话身份 | `dsh-session/lib/index.js`：1066-1076（header 快照）、1336-1346（header 语义 + `get id()`）、1415（header 赋值） |
| 工作目录 | `dsh-working-directory/lib/index.js`：25（服务名）、30-40（投影）、76-78（get）、121-123（context 文本）、134-152（commit 只 append 事件） |
| 实测产物 | `C:\Users\<you>\AppData\Local\Temp\sts-probe\{probe.log,probe2.log,run.out,run2.out,dump.out}`；`...\sts-recon\dump-rc5.{out,err}`；session log `~/.dsh/sessions/--C-Users-...-sts-probe-ws--/session-f57069c9-.../session.v4.jsonl.zstd` |

---

*本文只读取证：未修改 `lib/`、`package.json`、`test/`、`e2e/`；未触碰 `~/.dsh/profiles/desktop`。scratch profile 与探针目录可整体删除。*
