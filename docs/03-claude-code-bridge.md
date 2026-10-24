# 官方桥接包 `@deepseek-ai/dsh-hooks-claude-code` 跑 Stop That Shit 的实验报告

- 实验日期：2026-10-24（Asia/Hong_Kong）
- DSH 运行时：`0.2.1-rc.3`（实验开始时为 `0.2.1-rc.2`，中途被升级，两个版本都测过）
- 桥接包：`@deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.2` / `@0.2.1-rc.3`（**两者 `lib/index.js` 字节级相同**，只有 package.json 的 peer 版本号不同）
- STS：`D:\harness-deepseek workspace\dsh插件安装\lead-sts`（v0.2.5，只读，未修改）
- 全部实验产物：`D:\harness-deepseek workspace\dsh插件安装\bridge-test\`（脚本可重跑）
- **未修改**：`C:\Users\<you>\.dsh` 下任何文件、DSH 安装目录、`lead-sts/` 任何文件；未在真实 DSH 进程里装插件（隔离实验用 `DSH_HOME` 指向临时目录）

---

## ① 结论

### 1. 能不能跑起来？——能，但有条件

桥接包**确实能把 STS 的 `hooks/hooks.json` 跑起来，并在 `tools/pre-execute` 上真的产生 deny**。最小验证（场景 b，原样输出见 ③）：

```json
{
  "kind": "deny",
  "reason": "STOP / SCOPE\nGuard returned permission deny.\nReason: PATH_OUTSIDE_CONTRACT\nDetail: The action writes outside the declared file boundary: src/other.ts."
}
```

这条 deny 是 STS 自己算出来的（`S/PATH_OUTSIDE_CONTRACT`），说明链路 `DSH tools/pre-execute → bridge → child_process spawn node → STS handleClaudeHook → stdout CC JSON → bridge 解析 → {kind:'deny',reason}` 全程可用。

### 2. 但「照抄 hooks.json」不可用——四类硬伤

| # | 硬伤 | 后果 | 证据 |
|---|---|---|---|
| A | **DSH 工具名与 STS 的 Claude 分类器完全不匹配** | `glob` / `grep` / `ops_bash` / `run_code` / `subagent` / `present` / `todo_write` / `send_message` / `create_goal` / `update_goal` 在 armed contract 下被误判成 write → 全部 deny；模型连 `todo_write` 都用不了 | ③-1、③-9、③-10 |
| B | **3 个事件永不触发**（`SessionEnd` / `PostToolUseFailure` / `PermissionDenied`），且**无任何 warning** | STS 的收尾/失败/拒绝统计全部丢失 | ③-6 |
| C | **`pluginRoot` 不配 = 静默 fail-open** | 守卫整个死掉，宿主以为已武装，越界写被放行 | ③-11 |
| D | **profile 安装缺 peer（pnpm `nodeLinker: hoisted` + `autoInstallPeers: false`）→ 插件加载当场 `ERR_MODULE_NOT_FOUND`** | 插件树加载失败 | ③-13、⑤ |

另外两个「环境级」硬伤（不是桥接包的代码缺陷，但会让人以为桥接包坏了）：

| # | 硬伤 | 证据 |
|---|---|---|
| E | **版本门禁**：运行时是 `0.2.1-rc.3`，装 `rc.2` 的桥接包会被整行 `disabling profile plugin row`（peer 声明 `0.2.1-rc.2` ≠ 运行时 `0.2.1-rc.3`） | ③-14 |
| F | **`dsh plugin` 没有 `allow-version` 子命令**（帮助里只有 `--profile` / `-h`，剩余参数转发给 pnpm），报错文案却让你用它 | ③-14 |

### 3. 需要什么改造？——一个包装脚本 + 一条配置 + 四个包

1. **必须**把 `PreToolUse` 的命令从 STS 原版换成**工具名映射包装器**（本报告实测有效的 `bridge-test/sts-dsh-wrapper.cjs`）：把 DSH 名映射成 STS 认的 Claude 名，再进程内 `require` STS 的 `handleClaudeHook`。改造后 ③-2 显示 `glob` / `ops_bash` 变成放行、越界 `write` 仍然 deny。
2. **必须**在 `cordis.patch.yml` 里显式配 `pluginRoot`（并在 `hooks.json` 里保持 `${CLAUDE_PLUGIN_ROOT}` 写法），否则 fail-open。
3. **必须**在 profile 里显式安装 `dsh-hook-protocol` + `dsh-hooks-claude-code` + `dsh-llm` + `cordis`（版本必须**严格等于**运行时版本）。
4. **建议**接受三个降级（无法在桥接层修复）：`SessionEnd`/`PostToolUseFailure`/`PermissionDenied` 不触发；`PostToolUse` 的 `tool_response` 被拍平成文本 → **STS 的委派预算永远不释放**（③-7）；`continue:false` 被丢弃（③-8）。

**结论一句话**：桥接包本身可用（代码质量不错，超时单位、deny>ask>allow 合并、exit code 语义都对），但 **STS 直接拿来用会「过度 deny + 部分事件静默失效」**，必须加一层工具名映射包装器 + 显式配置，才能作为可用的守卫。

---

## ② 实验装置

### 2.1 完全隔离的 scratch 安装

`bridge-test/` 是一个独立的 npm 项目（不碰 `C:\Users\<you>\.dsh`，不碰 DSH 安装目录）：

```
bridge-test/
  package.json                 # private, type=commonjs
  node_modules/@deepseek-ai/   # 真实 npm 包装的：dsh-hooks-claude-code@0.2.1-rc.3
                               #                  dsh-hook-protocol@0.2.1-rc.3
                               #                  dsh-llm@0.2.1-rc.3, schemastery, cordis, cosmokit
  harness.mjs                  # ★ 最小 ctx stub（见 2.2）
  run-scenarios.mjs            # ★ 主驱动：baseline / mapped 两轮逐场景
  sts-dsh-wrapper.cjs          # ★ DSH→Claude 工具名映射包装器（mapped 方案的核心）
  make-hooks-dsh.cjs           # 由 leads-sts/hooks/hooks.json 生成 hooks-dsh.json
  hooks-raw.json / hooks-dsh.json
  mark.cjs / slow-hook.cjs / continue-false-hook.cjs
  coverage.mjs / timeout-probe.mjs / agents-probe.mjs / cwd-probe.mjs
  probe-names.cjs / probe-control.mjs / probe-plugin-root.mjs / probe-reject.mjs
  probe-datadir.mjs / probe-latency.mjs / probe-matcher.mjs
  probe-shell.cjs / probe-shell2.cjs / drive.mjs / drive-unarmed.mjs / drive-timing.mjs
  fixtures/                    # 探针用的小 hooks.json（非法 matcher / Bash|Write / continue:false ...）
  results/                     # 所有实测输出（原样 JSON，报告 ③ 就是这些文件）
  ref/                         # 从 asar 提取/解包的只读参考源码（作证据用）
```

安装命令（实际执行过的）：

```bash
cd 'D:/harness-deepseek workspace/dsh插件安装/bridge-test'
npm install --no-save \
  @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.3 \
  @deepseek-ai/dsh-hook-protocol@0.2.1-rc.3 \
  @deepseek-ai/dsh-llm@0.2.1-rc.3 \
  @deepseek-ai/cordis@4.0.5
```

### 2.2 最小 ctx stub（`bridge-test/harness.mjs`）

桥接包是 ESM cordis 插件，`apply(ctx, config)` 只用到这些缝（每一处都在源码里核对过行号）：

| ctx 成员 | 桥接包用在哪 | stub 实现 |
|---|---|---|
| `ctx.logger.warn(msg)` | `lib/index.js:148,150,195,196,232,324,337` | 推进数组，测试末尾打印 |
| `ctx.effect(dispose, label)` | `lib/index.js:155`（drain detached runs） | 记录后返回 dispose |
| `ctx.on(event, handler)` | `lib/index.js:223,237,253,270,297,314,327` | Map<event, [{handler}]>，直接抓出来调用 |
| `ctx.get('agents')?.get(id)` | `lib/index.js:315` | 返回 `undefined`（子代理不在本轮关注范围） |
| `ctx.sessionProjections.stateOf(session,'turnBoundary').lastTurn` | `lib/index.js:349-352` | 返回 `{lastTurn: 1}` |
| `ctx.workingDirectory.get(session)` / `.ensure(agent, signal)` | `lib/index.js:169` | 返回固定 cwd |
| `ctx.shell.resolve(request)` / `ctx.shell.execute(spec) → {result()}` | `dsh-hook-protocol lib/index.js:210` | **真的 spawn 子进程**（`bash -c`，注入 stdin、env、workdir、timeoutMs，支持 signal abort） |

`ctx.shell` 的**确切签名**（从 hook-protocol 反推出来的，也是真实 DSH 的契约）：

```js
ctx.shell.resolve({ command, workdir, timeoutMs, stdin, env, signal, onExpiry, stdoutMaxBytes })
//   → spec
const handle = await ctx.shell.execute(spec)   // 立刻返回 handle，不等进程结束
handle.result()                                // → { exitCode, stdout:{text}, stderr:{text}, timedOut, ... }
```

`runHook` 就是 `await (await bash.execute(bash.resolve(request))).result()`（`dsh-hook-protocol lib/index.js:210`），所以 stub 必须实现「execute 立即返回句柄 + result() 才 await」。

`harness.mjs` 还导出了 `loadBridge / dispatchPreExecute / dispatchPostExecute / dispatchPreStep / dispatchTurnStopping / makeAgent`，`loadBridge` 会用**真的 schemastery schema**（`mod.Config(config)`）跑一遍，保证 default 值与真实插件一致。

### 2.3 重跑方法

```bash
cd 'D:/harness-deepseek workspace/dsh插件安装/bridge-test'

# 1) 原样 STS 配置（无映射）
node run-scenarios.mjs --config '../lead-sts/hooks/hooks.json' --plugin-root '../lead-sts' --label baseline-raw

# 2) 加了工具名映射的配置
node run-scenarios.mjs --config hooks-dsh.json --plugin-root '../lead-sts' --label mapped

# 3) 各项专项探针
node coverage.mjs          # 事件覆盖
node timeout-probe.mjs     # 超时单位（秒 or 毫秒）
node agents-probe.mjs      # 委派预算释放
node cwd-probe.mjs         # cwd 依赖
node probe-plugin-root.mjs # pluginRoot 未配置
node probe-reject.mjs      # prompt 被拦时理由是否保留
node probe-datadir.mjs     # 默认数据目录
node probe-latency.mjs raw # 每次工具调用的额外耗时
node probe-matcher.mjs fixtures/hooks-invalid-matcher.json invalid
node probe-matcher.mjs fixtures/hooks-matcher-bashwrite.json matcher
node probe-matcher.mjs fixtures/hooks-continue-false.json continuefalse
node probe-names.cjs       # DSH 工具名分类矩阵
node probe-control.mjs '../lead-sts/hooks/hooks.json' control-raw
node probe-control.mjs hooks-dsh.json control-mapped
```

> 所有场景都把 STS 的 `PLUGIN_DATA` 指向 `bridge-test/.sts-data/<label>`，每轮开始前 `rm -rf`，所以互不污染，也绝不写用户目录。

### 2.4 mapped 方案的包装器（`sts-dsh-wrapper.cjs`）

`hooks-dsh.json` 与 STS 原版 `hooks.json` **只有一条命令不同**：`PreToolUse` 的命令指向 `sts-dsh-wrapper.cjs`，其余 7 个事件保持原样。包装器做三件事：

1. 读 stdin 的 CC 形状 payload；
2. `tool_name` 按表映射（节选：`read→Read`、`write→Write`、`edit→Edit`、`glob→Glob`、`grep→Grep`、`ops_bash→Bash`、`ops_inspect_local_file→Read`、`subagent/subagent_fork/spawn_teammate→Agent`、`run_code→Bash`、`todo_write/present/create_goal/update_goal→TodoWrite`、`send_message→SendMessage`…），并给 `Read/Write/Edit` 补一个 `file_path`（STS 分类器 `file_path || path` 两个都认，双保险）；
3. **进程内** `require(lead-sts/src/adapters/claude-hooks.cjs).handleClaudeHook(mapped, {dataDir})`，把返回的 CC 形状 JSON 原样打到 stdout。

包装器失败时写 stderr 并**不输出任何 JSON**（即 fail-open，与 STS 自己的策略一致）。

---

## ③ 逐场景实测输出（原样 JSON）

> 全部来自 `bridge-test/results/*.json`，未做任何编辑。STS 状态目录每轮 `rm -rf` 过。

### ③-1 baseline：STS 原版 `hooks/hooks.json` **不做任何改造**（`results/baseline-raw.json`）

armed 指令：`$stop-that-shit change files=src/app.ts -- add the counter`

`listeners`（桥接注册的扩展点）：

```json
[
  "agent/created",
  "agent/pre-step",
  "tools/pre-execute",
  "tools/post-execute",
  "agent/turn-stopping",
  "subagent/start",
  "subagent/end"
]
```

`warnings`: `[]` —— **零警告**，但下面 c/d 全被误杀。

**agent/pre-step (UserPromptSubmit arming) -> $stop-that-shit change files=src/app.ts -- add the counter**

```json
{
  "kind": "enter",
  "messages": [
    {
      "content": [
        {
          "type": "text",
          "text": "Stop That Shit (active): mode=change; agents=0/9007199254740991 reserved; hash=deny; deps=ask; files=src/app.ts. Stop Ladder: Is it requested? Is it necessary? What reachable evidence proves that? Would omission fail the current acceptance? Report real findings even when implementation is not authorized. Before expanding scope, name reachable evidence, failure if omitted, and the fact that changes the next action. Harness interception coverage is a guardrail, not a security boundary."
        }
      ],
      "source": {
        "kind": "hooks-claude-code"
      },
      "role": "user",
      "id": "f8ae511c-8169-4f96-901a-db7daf9ade42"
    }
  ]
}
```

**a. read src/app.ts (in scope, expect allow)  [read]**

```json
{
  "input": {
    "name": "read",
    "arguments": {
      "path": "src/app.ts"
    },
    "callId": "c1"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "read",
    "tool_input": {
      "path": "src/app.ts"
    },
    "tool_use_id": "c1",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**b. write src/other.ts (out of scope, expect deny)  [write]**

```json
{
  "input": {
    "name": "write",
    "arguments": {
      "path": "src/other.ts",
      "content": "x"
    },
    "callId": "c2"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "write",
    "tool_input": {
      "path": "src/other.ts",
      "content": "x"
    },
    "tool_use_id": "c2",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"STOP / SCOPE\\nGuard returned permission deny.\\nReason: PATH_OUTSIDE_CONTRACT\\nDetail: The action writes outside the declared file boundary: src/other.ts.\\nCode: S/PATH_OUTSIDE_CONTRACT\\nState: ARMED / change\\nEvent: evt_898aaa0e-f063-4566-9c32-5c99341ca4bb\\nNext: Keep the write inside files=..., or obtain a new explicit file boundary.\"}}\n",
  "decision": {
    "kind": "deny",
    "reason": "STOP / SCOPE\nGuard returned permission deny.\nReason: PATH_OUTSIDE_CONTRACT\nDetail: The action writes outside the declared file boundary: src/other.ts.\nCode: S/PATH_OUTSIDE_CONTRACT\nState: ARMED / change\nEvent: evt_898aaa0e-f063-4566-9c32-5c99341ca4bb\nNext: Keep the write inside files=..., or obtain a new explicit file boundary."
  }
}
```

**c. glob **/*.ts (unknown to STS classifier)  [glob]**

```json
{
  "input": {
    "name": "glob",
    "arguments": {
      "pattern": "**/*.ts"
    },
    "callId": "c3"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "glob",
    "tool_input": {
      "pattern": "**/*.ts"
    },
    "tool_use_id": "c3",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"STOP / SCOPE\\nGuard returned permission deny.\\nReason: WRITE_PATH_UNPROVEN\\nDetail: The action may write through a tool whose target path is not proven inside the declared file boundary.\\nCode: S/WRITE_PATH_UNPROVEN\\nState: ARMED / change\\nEvent: evt_40269608-f4b0-42b0-b437-718fc1f0b45c\\nNext: Use apply_patch or an Edit tool with visible paths, or obtain approval for an explicit broader boundary.\"}}\n",
  "decision": {
    "kind": "deny",
    "reason": "STOP / SCOPE\nGuard returned permission deny.\nReason: WRITE_PATH_UNPROVEN\nDetail: The action may write through a tool whose target path is not proven inside the declared file boundary.\nCode: S/WRITE_PATH_UNPROVEN\nState: ARMED / change\nEvent: evt_40269608-f4b0-42b0-b437-718fc1f0b45c\nNext: Use apply_patch or an Edit tool with visible paths, or obtain approval for an explicit broader boundary."
  }
}
```

**d. ops_bash git status (unknown to STS classifier)  [ops_bash]**

```json
{
  "input": {
    "name": "ops_bash",
    "arguments": {
      "command": "git status"
    },
    "callId": "c4"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "ops_bash",
    "tool_input": {
      "command": "git status"
    },
    "tool_use_id": "c4",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"STOP / SCOPE\\nGuard returned permission deny.\\nReason: WRITE_PATH_UNPROVEN\\nDetail: The action may write through a tool whose target path is not proven inside the declared file boundary.\\nCode: S/WRITE_PATH_UNPROVEN\\nState: ARMED / change\\nEvent: evt_3fd9bd2c-0098-4c4d-847d-48fad0be8b19\\nNext: Use apply_patch or an Edit tool with visible paths, or obtain approval for an explicit broader boundary.\"}}\n",
  "decision": {
    "kind": "deny",
    "reason": "STOP / SCOPE\nGuard returned permission deny.\nReason: WRITE_PATH_UNPROVEN\nDetail: The action may write through a tool whose target path is not proven inside the declared file boundary.\nCode: S/WRITE_PATH_UNPROVEN\nState: ARMED / change\nEvent: evt_3fd9bd2c-0098-4c4d-847d-48fad0be8b19\nNext: Use apply_patch or an Edit tool with visible paths, or obtain approval for an explicit broader boundary."
  }
}
```

**e. write src/app.ts (in scope, expect allow)  [write]**

```json
{
  "input": {
    "name": "write",
    "arguments": {
      "path": "src/app.ts",
      "content": "y"
    },
    "callId": "c5"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "write",
    "tool_input": {
      "path": "src/app.ts",
      "content": "y"
    },
    "tool_use_id": "c5",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**f. read src/other.ts (read outside scope, expect allow since read tools are not path-gated)  [read]**

```json
{
  "input": {
    "name": "read",
    "arguments": {
      "path": "src/other.ts"
    },
    "callId": "c6"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "read",
    "tool_input": {
      "path": "src/other.ts"
    },
    "tool_use_id": "c6",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**g. tools/post-execute for write (what PostToolUse payload carries)**

```json
{
  "decision": {
    "kind": "enter"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PostToolUse",
    "tool_name": "write",
    "tool_input": {
      "path": "src/app.ts",
      "content": "y"
    },
    "tool_use_id": "c5",
    "tool_response": "Wrote src/app.ts",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": ""
}
```

**h. agent/turn-stopping (Stop event) -> bridge emits no hook call unless configures Stop**

```json
{
  "lastSpawn": "node \"D:\\harness-deepseek workspace\\dsh插件安装\\lead-sts/hooks/stop-that-shit-claude.cjs\""
}
```

**小结（baseline）**：

| 场景 | 工具 | 期望 | 实测 |
|---|---|---|---|
| a | `read src/app.ts`（范围内读） | allow | ✅ `{kind:'allow'}` |
| b | `write src/other.ts`（越界写） | deny | ✅ `deny` / `S/PATH_OUTSIDE_CONTRACT` |
| c | `glob **/*.ts`（只读的通配符搜索） | allow | ❌ **`deny` / `S/WRITE_PATH_UNPROVEN`** |
| d | `ops_bash git status`（只读 shell） | allow | ❌ **`deny` / `S/WRITE_PATH_UNPROVEN`** |
| e | `write src/app.ts`（范围内写） | allow | ✅ `allow` |
| f | `read src/other.ts`（范围外读） | allow | ✅ `allow` |

`PreToolDecision` 的确切形状：`{ kind: 'deny', reason: string }`（没有 `info` 字段，`reason` 就是 STS 的整段多行文本；`ask` 分支是 `{ kind: 'ask', reason?: string }`，但 STS 从不产出 ask）。

### ③-2 mapped：`hooks-dsh.json` + 工具名映射包装器（`results/mapped.json`）

除 `PreToolUse` 一条命令外，与 STS 原版完全一致。

**agent/pre-step (UserPromptSubmit arming) -> $stop-that-shit change files=src/app.ts -- add the counter**

```json
{
  "kind": "enter",
  "messages": [
    {
      "content": [
        {
          "type": "text",
          "text": "Stop That Shit (active): mode=change; agents=0/9007199254740991 reserved; hash=deny; deps=ask; files=src/app.ts. Stop Ladder: Is it requested? Is it necessary? What reachable evidence proves that? Would omission fail the current acceptance? Report real findings even when implementation is not authorized. Before expanding scope, name reachable evidence, failure if omitted, and the fact that changes the next action. Harness interception coverage is a guardrail, not a security boundary."
        }
      ],
      "source": {
        "kind": "hooks-claude-code"
      },
      "role": "user",
      "id": "a0025ecf-22bb-4116-8a3f-bea14a728f98"
    }
  ]
}
```

**a. read src/app.ts (in scope, expect allow)  [read]**

```json
{
  "input": {
    "name": "read",
    "arguments": {
      "path": "src/app.ts"
    },
    "callId": "c1"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "read",
    "tool_input": {
      "path": "src/app.ts"
    },
    "tool_use_id": "c1",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**b. write src/other.ts (out of scope, expect deny)  [write]**

```json
{
  "input": {
    "name": "write",
    "arguments": {
      "path": "src/other.ts",
      "content": "x"
    },
    "callId": "c2"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "write",
    "tool_input": {
      "path": "src/other.ts",
      "content": "x"
    },
    "tool_use_id": "c2",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"STOP / SCOPE\\nGuard returned permission deny.\\nReason: PATH_OUTSIDE_CONTRACT\\nDetail: The action writes outside the declared file boundary: src/other.ts.\\nCode: S/PATH_OUTSIDE_CONTRACT\\nState: ARMED / change\\nEvent: evt_f36d289c-eb8c-43ca-bcd0-902da093939d\\nNext: Keep the write inside files=..., or obtain a new explicit file boundary.\"}}\n",
  "decision": {
    "kind": "deny",
    "reason": "STOP / SCOPE\nGuard returned permission deny.\nReason: PATH_OUTSIDE_CONTRACT\nDetail: The action writes outside the declared file boundary: src/other.ts.\nCode: S/PATH_OUTSIDE_CONTRACT\nState: ARMED / change\nEvent: evt_f36d289c-eb8c-43ca-bcd0-902da093939d\nNext: Keep the write inside files=..., or obtain a new explicit file boundary."
  }
}
```

**c. glob **/*.ts (unknown to STS classifier)  [glob]**

```json
{
  "input": {
    "name": "glob",
    "arguments": {
      "pattern": "**/*.ts"
    },
    "callId": "c3"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "glob",
    "tool_input": {
      "pattern": "**/*.ts"
    },
    "tool_use_id": "c3",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**d. ops_bash git status (unknown to STS classifier)  [ops_bash]**

```json
{
  "input": {
    "name": "ops_bash",
    "arguments": {
      "command": "git status"
    },
    "callId": "c4"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "ops_bash",
    "tool_input": {
      "command": "git status"
    },
    "tool_use_id": "c4",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**e. write src/app.ts (in scope, expect allow)  [write]**

```json
{
  "input": {
    "name": "write",
    "arguments": {
      "path": "src/app.ts",
      "content": "y"
    },
    "callId": "c5"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "write",
    "tool_input": {
      "path": "src/app.ts",
      "content": "y"
    },
    "tool_use_id": "c5",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**f. read src/other.ts (read outside scope, expect allow since read tools are not path-gated)  [read]**

```json
{
  "input": {
    "name": "read",
    "arguments": {
      "path": "src/other.ts"
    },
    "callId": "c6"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PreToolUse",
    "tool_name": "read",
    "tool_input": {
      "path": "src/other.ts"
    },
    "tool_use_id": "c6",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": "",
  "decision": {
    "kind": "allow"
  }
}
```

**g. tools/post-execute for write (what PostToolUse payload carries)**

```json
{
  "decision": {
    "kind": "enter"
  },
  "payloadSentToHook": {
    "session_id": "sess-1",
    "transcript_path": "",
    "hook_event_name": "PostToolUse",
    "tool_name": "write",
    "tool_input": {
      "path": "src/app.ts",
      "content": "y"
    },
    "tool_use_id": "c5",
    "tool_response": "Wrote src/app.ts",
    "cwd": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "hookStdout": ""
}
```

**h. agent/turn-stopping (Stop event) -> bridge emits no hook call unless configures Stop**

```json
{
  "lastSpawn": "node \"D:\\harness-deepseek workspace\\dsh插件安装\\lead-sts/hooks/stop-that-shit-claude.cjs\""
}
```

**小结（mapped）**：

| 场景 | 工具 | baseline | mapped |
|---|---|---|---|
| a | `read src/app.ts` | allow | ✅ allow |
| b | `write src/other.ts` | deny `PATH_OUTSIDE_CONTRACT` | ✅ **仍然 deny** `PATH_OUTSIDE_CONTRACT` |
| c | `glob **/*.ts` | ❌ deny `WRITE_PATH_UNPROVEN` | ✅ **allow** |
| d | `ops_bash git status` | ❌ deny `WRITE_PATH_UNPROVEN` | ✅ **allow** |
| e | `write src/app.ts` | allow | ✅ allow |
| f | `read src/other.ts` | allow | ✅ allow |

即：**映射修好了误判，没有削弱越界拦截**。

### ③-3 DSH 工具名分类矩阵（不经映射，直接喂 STS 分类器；`results/name-matrix.json`）

源脚本 `probe-names.cjs`，直接调 `lead-sts/src/adapters/claude-tool-classifier.cjs` 的 `classifyClaudeTool`，29 个 DSH 真实工具名：

| 工具名 | STS 判定 | 后果（armed contract 下） |
|---|---|---|
| `read` | `read` | 放行 |
| `write` | `write` / ["src/app.ts"] | 按路径判（可 deny） |
| `edit` | `write` / ["src/app.ts"] | 按路径判（可 deny） |
| `glob` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `grep` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `ops_bash` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `ops_bash` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `ops_inspect_local_file` | `read` | 放行 |
| `run_code` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `subagent` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `subagent_fork` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `spawn_teammate` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `send_message` | `write` | **无路径 → deny** |
| `todo_write` | `write` | **无路径 → deny** |
| `list_agents` | `read` | 放行 |
| `job_output` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `job_kill` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `present` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `ask_user_question` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `create_goal` | `write` | **无路径 → deny** |
| `update_goal` | `write` | **无路径 → deny** |
| `compress` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `decompress` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `schedule_create` | `write` | **无路径 → deny** |
| `terminal_open` | `read` | 放行 |
| `terminal_send` | `write` | **无路径 → deny** |
| `working_directory` | `unknown` | **`WRITE_PATH_UNPROVEN` → deny** |
| `web_fetch` | `read` | 放行 |
| `web_search` | `read` | 放行 |

关键点：**`glob` / `grep` / `ops_bash` / `run_code` / `subagent` / `subagent_fork` / `spawn_teammate` / `present` / `ask_user_question` / `job_*` / `working_directory` 全是 `unknown`**；而 `send_message` / `todo_write` / `create_goal` / `update_goal` / `schedule_create` / `terminal_send` 被 STS 的 Codex 名字回退正则命成 **`write`（且路径为空）** —— 比 `unknown` 更糟。

原始 JSON：

```json
[
  {
    "name": "read",
    "mutability": "read",
    "paths": [],
    "reason": null
  },
  {
    "name": "write",
    "mutability": "write",
    "paths": [
      "src/app.ts"
    ],
    "reason": null
  },
  {
    "name": "edit",
    "mutability": "write",
    "paths": [
      "src/app.ts"
    ],
    "reason": null
  },
  {
    "name": "glob",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "grep",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "ops_bash",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "ops_bash",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "ops_inspect_local_file",
    "mutability": "read",
    "paths": [],
    "reason": null
  },
  {
    "name": "run_code",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "subagent",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "subagent_fork",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "spawn_teammate",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "send_message",
    "mutability": "write",
    "paths": [],
    "reason": null
  },
  {
    "name": "todo_write",
    "mutability": "write",
    "paths": [],
    "reason": null
  },
  {
    "name": "list_agents",
    "mutability": "read",
    "paths": [],
    "reason": null
  },
  {
    "name": "job_output",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "job_kill",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "present",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "ask_user_question",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "create_goal",
    "mutability": "write",
    "paths": [],
    "reason": null
  },
  {
    "name": "update_goal",
    "mutability": "write",
    "paths": [],
    "reason": null
  },
  {
    "name": "compress",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "decompress",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "schedule_create",
    "mutability": "write",
    "paths": [],
    "reason": null
  },
  {
    "name": "terminal_open",
    "mutability": "read",
    "paths": [],
    "reason": null
  },
  {
    "name": "terminal_send",
    "mutability": "write",
    "paths": [],
    "reason": null
  },
  {
    "name": "working_directory",
    "mutability": "unknown",
    "paths": [],
    "reason": null
  },
  {
    "name": "web_fetch",
    "mutability": "read",
    "paths": [],
    "reason": null
  },
  {
    "name": "web_search",
    "mutability": "read",
    "paths": [],
    "reason": null
  }
]
```

### ③-4 armed contract 下控制类工具被误杀（`results/control-tools-control-raw.json`）

`probe-control.mjs`：armed（`files=src/app.ts`）后逐个调用 DSH 的控制类工具。

```json
[
  {
    "tool": "todo_write",
    "decisionKind": "deny",
    "reasonCode": "S/WRITE_PATH_UNPROVEN",
    "reasonHead": "STOP / SCOPE | Guard returned permission deny. | Reason: WRITE_PATH_UNPROVEN | Detail: The action may write through a tool whose target path is not proven inside the declared file boundary."
  },
  {
    "tool": "send_message",
    "decisionKind": "deny",
    "reasonCode": "S/WRITE_PATH_UNPROVEN",
    "reasonHead": "STOP / SCOPE | Guard returned permission deny. | Reason: WRITE_PATH_UNPROVEN | Detail: The action may write through a tool whose target path is not proven inside the declared file boundary."
  },
  {
    "tool": "create_goal",
    "decisionKind": "deny",
    "reasonCode": "S/WRITE_PATH_UNPROVEN",
    "reasonHead": "STOP / SCOPE | Guard returned permission deny. | Reason: WRITE_PATH_UNPROVEN | Detail: The action may write through a tool whose target path is not proven inside the declared file boundary."
  },
  {
    "tool": "update_goal",
    "decisionKind": "deny",
    "reasonCode": "S/WRITE_PATH_UNPROVEN",
    "reasonHead": "STOP / SCOPE | Guard returned permission deny. | Reason: WRITE_PATH_UNPROVEN | Detail: The action may write through a tool whose target path is not proven inside the declared file boundary."
  },
  {
    "tool": "present",
    "decisionKind": "deny",
    "reasonCode": "S/WRITE_PATH_UNPROVEN",
    "reasonHead": "STOP / SCOPE | Guard returned permission deny. | Reason: WRITE_PATH_UNPROVEN | Detail: The action may write through a tool whose target path is not proven inside the declared file boundary."
  },
  {
    "tool": "list_agents",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  },
  {
    "tool": "read",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  }
]
```

### ③-5 同一批工具在 mapped 配置下全部放行（`results/control-tools-control-mapped.json`）

同一个探针换 `hooks-dsh.json`（映射包装器）。

```json
[
  {
    "tool": "todo_write",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  },
  {
    "tool": "send_message",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  },
  {
    "tool": "create_goal",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  },
  {
    "tool": "update_goal",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  },
  {
    "tool": "present",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  },
  {
    "tool": "list_agents",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  },
  {
    "tool": "read",
    "decisionKind": "allow",
    "reasonCode": null,
    "reasonHead": null
  }
]
```

### ③-6 事件覆盖：注册 8 个事件，只有 5 个能触发（`results/coverage-events.json`）

`coverage.mjs`：把 STS 的 8 个事件全部指向 `mark.cjs <Event>`，驱动桥接注册的 7 个扩展点，看哪些标记文件出现。

```json
{
  "registeredEvents": [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "SessionEnd",
    "SubagentStart",
    "PostToolUseFailure",
    "PermissionDenied"
  ],
  "markersObserved": [
    "PostToolUse",
    "PreToolUse",
    "SessionStart",
    "SubagentStart",
    "UserPromptSubmit"
  ],
  "reached": {
    "SessionStart": true,
    "UserPromptSubmit": true,
    "PreToolUse": true,
    "PostToolUse": true,
    "SessionEnd": false,
    "SubagentStart": true,
    "PostToolUseFailure": false,
    "PermissionDenied": false
  },
  "unreachable": [
    "SessionEnd",
    "PostToolUseFailure",
    "PermissionDenied"
  ],
  "bridgeListeners": [
    "agent/created",
    "agent/pre-step",
    "tools/pre-execute",
    "tools/post-execute",
    "agent/turn-stopping",
    "subagent/start",
    "subagent/end"
  ],
  "warnings": [],
  "extensionPointResults": {
    "agent/created": "ran",
    "agent/pre-step": {
      "kind": "enter",
      "messages": []
    },
    "tools/pre-execute": {
      "kind": "allow"
    },
    "tools/post-execute": {
      "kind": "enter"
    },
    "subagent/start": "ran",
    "subagent/end": "ran"
  }
}
```

→ **`SessionEnd` / `PostToolUseFailure` / `PermissionDenied` 注册了但永不触发，且 `warnings` 为空**（连提示都没有）。

### ③-7 委派预算：bridge payload 永远放不回预算（`results/agents-probe.json`）

指令：`$stop-that-shit change files=src/app.ts agents=1 -- add the counter`。两臂对照：`bridge` 走桥接的 PostToolUse payload；`direct` 手喂 CC 形状 `tool_response:{status:'completed'}`。

```json
{
  "bridge": {
    "dataDir": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\.sts-data\\agents-bridge",
    "armDecision": [],
    "firstDelegation": {
      "kind": "allow"
    },
    "postExecuteDecision": {
      "kind": "enter"
    },
    "secondDelegation": {
      "kind": "deny",
      "reason": "STOP / SCOPE\nGuard returned permission deny.\nReason: AGENT_BUDGET_EXHAUSTED\nDetail: The session allows 1 concurrently active subagent(s), with 1 units reserved, and this action requires 1.\nCode: S/AGENT_BUDGET_EXHAUSTED\nState: ARMED / change\nEvent: evt_929f7bdb-cd79-4b2b-b14a-498af16ee808\nNext: Wait for the current delegation to complete or increase agents=N in a corrected directive."
    },
    "secondIsDenied": true
  },
  "direct": {
    "dataDir": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\.sts-data\\agents-direct",
    "firstDelegation": {
      "kind": "allow"
    },
    "directPostHook": {
      "exitCode": 0,
      "stdout": "",
      "stderr": ""
    },
    "secondDelegation": {
      "kind": "allow"
    },
    "secondIsDenied": false
  }
}
```

→ `bridge` 臂第二次 `subagent` 被 `AGENT_BUDGET_EXHAUSTED` 拒；`direct` 臂放行。**长会话里 `agents=N` 会被永久耗尽。**

### ③-8 `continue:false` / `stopReason` 被完全丢弃（`results/probe-continuefalse.json`）

hook 输出 `{"continue":false,"stopReason":"host should stop here"}`，挂在 `UserPromptSubmit` + `PreToolUse(* )`。

```json
{
  "label": "continuefalse",
  "configPath": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\fixtures\\hooks-continue-false.json",
  "warnings": [],
  "listeners": [
    "agent/created",
    "agent/pre-step",
    "tools/pre-execute",
    "tools/post-execute",
    "agent/turn-stopping",
    "subagent/start",
    "subagent/end"
  ],
  "preExecute": [
    {
      "name": "ops_bash",
      "decision": {
        "kind": "allow"
      },
      "spawned": 1,
      "error": null
    },
    {
      "name": "write",
      "decision": {
        "kind": "allow"
      },
      "spawned": 1,
      "error": null
    },
    {
      "name": "Bash",
      "decision": {
        "kind": "allow"
      },
      "spawned": 1,
      "error": null
    },
    {
      "name": "Write",
      "decision": {
        "kind": "allow"
      },
      "spawned": 1,
      "error": null
    },
    {
      "name": "read",
      "decision": {
        "kind": "allow"
      },
      "spawned": 1,
      "error": null
    }
  ],
  "preStep": {
    "kind": "enter",
    "messages": []
  },
  "preStepError": null,
  "totalHookSpawns": 6,
  "warningsAfter": []
}
```

→ 6 次 spawn 全部执行，**所有 decision 仍是 `allow`，pre-step 仍是 `enter`**。

### ③-9 matcher 按 CC 字面量匹配：`Bash|Write` 只命中大写名（`results/probe-matcher.json`）

`fixtures/hooks-matcher-bashwrite.json`，matcher = `Bash|Write`。

```json
{
  "label": "matcher",
  "configPath": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\fixtures\\hooks-matcher-bashwrite.json",
  "warnings": [],
  "listeners": [
    "agent/created",
    "agent/pre-step",
    "tools/pre-execute",
    "tools/post-execute",
    "agent/turn-stopping",
    "subagent/start",
    "subagent/end"
  ],
  "preExecute": [
    {
      "name": "ops_bash",
      "decision": {
        "kind": "allow"
      },
      "spawned": 0,
      "error": null
    },
    {
      "name": "write",
      "decision": {
        "kind": "allow"
      },
      "spawned": 0,
      "error": null
    },
    {
      "name": "Bash",
      "decision": {
        "kind": "allow"
      },
      "spawned": 1,
      "error": null
    },
    {
      "name": "Write",
      "decision": {
        "kind": "allow"
      },
      "spawned": 1,
      "error": null
    },
    {
      "name": "read",
      "decision": {
        "kind": "allow"
      },
      "spawned": 0,
      "error": null
    }
  ],
  "preStep": {
    "kind": "enter",
    "messages": []
  },
  "preStepError": null,
  "totalHookSpawns": 2,
  "warningsAfter": []
}
```

→ 只有 `Bash` / `Write` 两个名字各 spawn 1 次；`ops_bash` / `write` / `read` **spawned 为 0**。DSH 的小写工具名永远不会命中任何 CC matcher。

### ③-10 非法 matcher 让**整个** hooks.json 全部失效（`results/probe-invalid.json`）

`fixtures/hooks-invalid-matcher.json`：`PreToolUse` 里第一个 group 的 matcher 写成非法正则 `Bash(`（第二个 group 是合法的 `*`）：

```json
{
  "label": "invalid",
  "configPath": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\fixtures\\hooks-invalid-matcher.json",
  "warnings": [
    "hooks-claude-code: could not load hook config \"D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\fixtures\\hooks-invalid-matcher.json\": SyntaxError: invalid claude-code regex matcher \"Bash(\" on event \"PreToolUse\" — no hooks registered"
  ],
  "listeners": [],
  "preExecute": [
    {
      "name": "ops_bash",
      "decision": {
        "kind": "no-listener-fail-open"
      },
      "spawned": 0,
      "error": "no listener registered for tools/pre-execute"
    },
    {
      "name": "write",
      "decision": {
        "kind": "no-listener-fail-open"
      },
      "spawned": 0,
      "error": "no listener registered for tools/pre-execute"
    },
    {
      "name": "Bash",
      "decision": {
        "kind": "no-listener-fail-open"
      },
      "spawned": 0,
      "error": "no listener registered for tools/pre-execute"
    },
    {
      "name": "Write",
      "decision": {
        "kind": "no-listener-fail-open"
      },
      "spawned": 0,
      "error": "no listener registered for tools/pre-execute"
    },
    {
      "name": "read",
      "decision": {
        "kind": "no-listener-fail-open"
      },
      "spawned": 0,
      "error": "no listener registered for tools/pre-execute"
    }
  ],
  "preStep": {
    "kind": "no-listener-fail-open"
  },
  "preStepError": "no listener registered for agent/pre-step",
  "totalHookSpawns": 0,
  "warningsAfter": [
    "hooks-claude-code: could not load hook config \"D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\fixtures\\hooks-invalid-matcher.json\": SyntaxError: invalid claude-code regex matcher \"Bash(\" on event \"PreToolUse\" — no hooks registered"
  ]
}
```

→ `listeners: []`（**一个扩展点都没注册，包括其它 6 个完全合法的事件**），5 次 pre-execute 全部 `no listener registered`，`preStepError: "no listener registered for agent/pre-step"`，`totalHookSpawns: 0`。**一个 typo 让整个守卫消失**。

### ③-11 `pluginRoot` 未配置 = 静默 fail-open（`results/plugin-root-unset.json`）

```json
{
  "warnings": [],
  "preStepDecision": {
    "kind": "enter",
    "messages": []
  },
  "armedThoughGuardDead": true,
  "preExecuteDecision": {
    "kind": "allow"
  },
  "hookCommandAsExecuted": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/stop-that-shit-claude.cjs\"",
  "hookExitCode": 1,
  "hookStderr": "node:internal/modules/cjs/loader:1568\r |   throw err;\r |   ^\r | \r",
  "outOfScopeWriteAllowed": true
}
```

→ `warnings: []`，`preStepDecision: {kind:'enter'}`（看起来已经武装成功），但 hook 实际执行的是**未替换**的 `node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-that-shit-claude.cjs"`，exitCode 1、stderr 是 node 的 loader 报错，随后越界写被 **allow**。`armedThoughGuardDead: true` / `outOfScopeWriteAllowed: true`。

### ③-12 prompt 被拦时理由丢失（`results/prompt-reject.json`）

```json
{
  "prompt": "$stop-that-shit nope -- do it",
  "hookStdout": "{\"decision\":\"block\",\"reason\":\"Unknown directive field. Put task text after -- or on the next line.\"}",
  "bridgeDecision": {
    "kind": "reject"
  },
  "reasonPreserved": false
}
```

→ 钩子输出了完整的 `{"decision":"block","reason":"Unknown directive field. ..."}`，桥接只返回 `{kind:'reject'}`，`reasonPreserved: false`。下游 `dsh-agent-loop lib/index.js:960` 收到 `reject` 直接 `turnEnds = {kind:'blocked'}` 结束整轮，**用户看不到为什么**。

### ③-13 profile 装不上：peer 缺失（isolated `DSH_HOME` 实测）

在 `C:\Users\<you>\AppData\Local\Temp\dsh-home-probe` 下（`DSH_HOME` 隔离，真实 profile 分毫未动）：

```bash
$ dsh plugin --profile test1 add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.2 @deepseek-ai/dsh-hook-protocol@0.2.1-rc.2
dsh: initialized profile test1 at C:\Users\<you>\AppData\Local\Temp\dsh-home-probe\profiles\test1
Progress: resolved 1, reused 0, downloaded 0, added 0
[WARN] Issues with peer dependencies found. Run "pnpm peers check" to list them.
Packages: +5

$ ls node_modules/@deepseek-ai
cosmokit  dsh-hook-protocol  dsh-hooks-claude-code  schemastery

$ node -e "import('@deepseek-ai/dsh-hooks-claude-code').then(...)"
FAIL ERR_MODULE_NOT_FOUND | Cannot find package '@deepseek-ai/dsh-llm' imported from
     C:\Users\<you>\AppData\Local\Temp\dsh-home-probe\profiles\test1\node_modules\@deepseek-ai\dsh-hooks-claude-code\lib\index.js
```

`pnpm peers check` 列出缺 8 个：`@deepseek-ai/cordis`、`dsh-session`、`dsh-shell`、`dsh-agent`、`dsh-llm`、`dsh-session-projection`、`dsh-subagent`、`dsh-tools`。

补装 `dsh-llm` + `cordis` 后立刻正常：

```bash
$ dsh plugin --profile test1 add @deepseek-ai/dsh-llm@0.2.1-rc.2 @deepseek-ai/cordis@4.0.5
$ node -e "import('@deepseek-ai/dsh-hooks-claude-code')..."
OK [ 'Config', 'apply', 'inject', 'name' ]
```

**真实 profile `ststest` 就是坏的**（Lead 之前的试验）：`node_modules/@deepseek-ai` 只有 4 个包，`node -e import(...)` 报同样的 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm`。

### ③-14 版本门禁：rc.2 的桥接包在 rc.3 运行时上被整行禁用

实验中途本机 DSH 升到 `0.2.1-rc.3`（`dsh --version` → `0.2.1-rc.3`）。用 rc.2 的桥接包装进隔离 profile 后 boot：

```
dsh: disabling profile plugin row "sts-claude-hooks": Plugin @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.2 is
  incompatible with dsh 0.2.1-rc.3: requirements {"@deepseek-ai/dsh-agent":"0.2.1-rc.2",
  "@deepseek-ai/dsh-hook-protocol":"0.2.1-rc.2", ... 全部 0.2.1-rc.2}. Running it may cause crashes or data
  loss. Update the plugin or install a plugin version compatible with this dsh runtime. To accept this risk
  explicitly, grant the exact-version exemption for @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.2 on dsh
  0.2.1-rc.3 with `dsh plugin allow-version` or the plugin manager, then retry the installation or restart dsh.
  Exact-version exemption: not active.
```

→ **整行被 disabling，桥接根本不加载**（连 apply 都没跑）。npm 上已有 `0.2.1-rc.3`，装 rc.3 后无此警告。

**而报错文案推荐的 `dsh plugin allow-version` 并不存在**：

```
$ dsh plugin --help
Usage: dsh plugin [options] [args...]
manage a profile's plugins by forwarding the remaining arguments to pnpm in the profile directory
Arguments:  args    pnpm arguments, forwarded verbatim (add <pkg>, remove <pkg>, why <pkg>, ...)
Options:    --profile <name>    -h, --help
```

只能在插件管理器 UI 里授予豁免，或手写 profile 的兼容性文件。

### ③-15 `apply()` 确实在真实运行时执行过（正证据）

给 rc.3 隔离 profile 故意配 `stderrSummaryMaxChars: 0`：

```
dsh: warning: 1 entry did not activate
sts-claude-hooks (@deepseek-ai/dsh-hooks-claude-code): Error: hooks-claude-code: stderrSummaryMaxChars must be a positive integer
    at assertPositiveInteger (file:///C:/Users/<you>/AppData/Local/Temp/dsh-home-probe/profiles/test3/node_modules/@deepseek-ai/dsh-hooks-claude-code/lib/index.js:135:51)
    at new apply (file:///.../dsh-hooks-claude-code/lib/index.js:139:2)
    at Fiber.execute (.../app.asar/dsh/node_modules/@deepseek-ai/cordis/lib/index.js:1068:24)
```

→ 栈帧直接落在桥接包的 `apply` 里，**证明真实 DSH 运行时确实加载并执行了它**（cordis 捕获异常后只让该 entry 不激活，不中断 boot）。

### ③-16 超时单位是**秒**，超时被杀时静默放行（`results/timeout-probe.json`）

同一个 2500ms 的 hook，三组 config：

```json
[
  {
    "label": "timeout-1s-vs-2500ms-hook",
    "configTimeout": 1,
    "wallMs": 2632,
    "decision": {
      "kind": "allow"
    }
  },
  {
    "label": "timeout-5s-vs-2500ms-hook",
    "configTimeout": 5,
    "wallMs": 2650,
    "decision": {
      "kind": "deny",
      "reason": "slow hook reached its decision after 2500ms"
    }
  },
  {
    "label": "no-timeout-default-600000ms",
    "configTimeout": null,
    "wallMs": 2641,
    "decision": {
      "kind": "deny",
      "reason": "slow hook reached its decision after 2500ms"
    }
  }
]
```

→ `timeout: 1`（1 秒）时 hook 被 1s 超时杀掉 → **无输出 → `{kind:'allow'}`，静默 fail-open**；`timeout: 5` 与不写 timeout 都能拿到 deny。STS 写 `timeout: 5` 是**正确的（秒）**，与 CC 一致。

### ③-17 cwd 依赖（`results/cwd-probe.json`）

```json
{
  "absolutePath": "D:/harness-deepseek workspace/dsh插件安装/bridge-test/src/app.ts",
  "withCwd": {
    "hookStdout": ""
  },
  "withoutCwd": {
    "hookStdout": "{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"STOP / SCOPE\\nGuard returned permission deny.\\nReason: PATH_OUTSIDE_CONTRACT\\nDetail: The action writes outside the declared file boundary: D:/harness-deepseek workspace/dsh插件安装/bridge-test/src/app.ts.\\nCode: S/PATH_OUTSIDE_CONTRACT\\nState: ARMED / change\\nEvent: evt_2838b1cc-afe0-44b2-906e-8e963756201b\\nNext: Keep the write inside files=..., or obtain a new explicit file boundary.\"}}"
  },
  "bridgeDecision": {
    "kind": "allow"
  }
}
```

→ 桥接**确实发送 `cwd`**，STS 的相对路径判定可用；但一旦拿不到 cwd，STS 会把**合法的绝对路径**判成 `PATH_OUTSIDE_CONTRACT`。迁到别的宿主时的风险点。

### ③-18 默认数据目录落在系统临时目录（`results/datadir-default.json`）

```json
{
  "defaultDataRoot": "C:\\Users\\<you>\\AppData\\Local\\Temp\\stop-that-shit-dev",
  "defaultDataRootExists": true,
  "sessionFilesBefore": 25,
  "sessionFilesAfter": 26,
  "stateWrittenToDefaultRoot": true,
  "envPassedToHook": {
    "CLAUDE_PROJECT_DIR": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test"
  },
  "enforcementStillWorks": "deny"
}
```

→ 桥接只注入 `CLAUDE_PROJECT_DIR`（`lib/index.js:170-171`），**从不设 `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA`**，STS 退回 `os.tmpdir()/stop-that-shit-dev`（`lead-sts/src/state.cjs:11-13`）：机器全局共享（所有 DSH profile + 真 Claude Code 项目共用），且随时可能被临时目录清理。

### ③-19 每次工具调用的额外开销（`results/latency-raw.json` / `latency-mapped.json`）

```json
{
  "label": "raw",
  "configPath": "D:\\harness-deepseek workspace\\dsh插件安装\\lead-sts\\hooks\\hooks.json",
  "samplesMs": [
    120,
    116,
    115,
    118,
    113,
    119,
    117
  ],
  "medianMs": 117,
  "minMs": 113,
  "maxMs": 120
}
```

```json
{
  "label": "mapped",
  "configPath": "D:\\harness-deepseek workspace\\dsh插件安装\\bridge-test\\hooks-dsh.json",
  "samplesMs": [
    122,
    126,
    120,
    121,
    116,
    124,
    118
  ],
  "medianMs": 121,
  "minMs": 116,
  "maxMs": 126
}
```

→ 每次被匹配的 `PreToolUse` 都 spawn 一个新 node 进程，中位数 **117ms（raw）/ 121ms（mapped）**。对一个每秒几十次工具调用的会话是可感知的固定税。

### ③-20 未武装时全部放行（对照，`drive-unarmed.mjs` 输出）

```
warnings: []
plain prompt -> {"kind":"enter","messages":[]}
UNARMED read       -> {"kind":"allow"}
UNARMED write      -> {"kind":"allow"}
UNARMED bash       -> {"kind":"allow"}
UNARMED glob       -> {"kind":"allow"}
UNARMED run_code   -> {"kind":"allow"}
UNARMED subagent   -> {"kind":"allow"}
```

→ 桥接不改变未武装时的行为，守卫只在 STS 武装后生效（符合预期）。

---

## ④ 缺陷清单（每条带证据）

> 严重度：**S1** = 守卫失效/静默放行；**S2** = 功能缺失或误杀；**S3** = 体验/运维。

### D1 [S2] DSH 工具名与 STS 分类器命名空间不匹配

- **现象**：`glob` / `grep` / `ops_bash` / `run_code` / `subagent*` / `present` / `ask_user_question` 被 STS 判为 `unknown` → armed 时一律 `WRITE_PATH_UNPROVEN` deny；`todo_write` / `send_message` / `create_goal` / `update_goal` / `schedule_create` / `terminal_send` 被 STS 的 Codex 名字回退正则判成 **`write` 且路径为空** → 同样 deny。模型连 `todo_write` 都调不动。
- **证据**：桥接把工具名原样塞进 payload —— `dsh-hooks-claude-code lib/index.js:376-383`（`tool_name: exec.name`）；matcher 按 CC 字面量逐名匹配 —— `dsh-hook-protocol lib/index.js:15` `CLAUDE_LITERAL = /^[A-Za-z0-9_|]+$/`、`:50` `pattern.split("|").includes(query)`；STS 只认大写 CC 名 —— `lead-sts/src/adapters/claude-tool-classifier.cjs` 的 `CLAUDE_READ_TOOLS` / `CLAUDE_CONTROL_TOOLS` 集合。实测：③-3（29 个名字的分类矩阵）、③-4（控制类工具全 deny）、③-9（`Bash|Write` matcher 对 DSH 名字 0 命中）。
- **影响**：不改就没法用。
- **规避**：`bridge-test/sts-dsh-wrapper.cjs`（实测有效，见 ③-2 / ③-5）。

### D2 [S2] 3 个事件注册了但永不触发，且零警告

- **现象**：`hooks.json` 里的 `SessionEnd` / `PostToolUseFailure` / `PermissionDenied` 被静默忽略。STS 因此永远收不到会话结束、工具失败、权限拒绝。
- **证据**：桥接硬编码 7 个事件 —— `lib/index.js:13-21`（`SessionStart / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStart / SubagentStop`），parse 循环 `:61` 只遍历这 7 个，其它 key 连读都不读（`grep -n 'SessionEnd\|PostToolUseFailure\|PermissionDenied' lib/index.js` → **0 命中**）；`:148` 只对「非 command 类型」的 hook 发 warn，对「未知事件」不发。实测：③-6，`reached` 里三者全 `false`，`warnings: []`。
- **影响**：STS 的收尾统计与失败/拒绝计数失真；`SessionEnd` 缺失意味着 `handleLifecycleContext(session.end)` 永不调用（`lead-sts/src/controller.cjs:258-276`）。
- **规避**：无（桥接层不支持）。可用一个独立的原生 DSH 插件在 `agent/turn-stopping` / `tools/post-execute` 的错误分支里手喂 STS。

### D3 [S1] `pluginRoot` 不配 → 整条守卫静默死掉（fail-open）

- **现象**：`${CLAUDE_PLUGIN_ROOT}` 只在 parse 期替换（`lib/index.js:32-37`，调用点 `:143-146`）。不配 `pluginRoot` 时 token 原样进 shell，hook 以 exitCode 1 退出，**桥接不报错、不 deny**，越界写被放行；而 `UserPromptSubmit` 仍返回 `{kind:'enter'}`，看起来像「已武装」。
- **证据**：③-11 全文（`warnings: []` / `hookExitCode: 1` / `hookCommandAsExecuted` 里 token 还在 / `outOfScopeWriteAllowed: true`）。
- **影响**：最危险的一类——守卫失效而宿主毫无感知。
- **规避**：`cordis.patch.yml` 必须显式写 `pluginRoot`（且用正斜杠路径）。

### D4 [S1] hook 崩溃/超时一律静默 fail-open（无 warning）

- **现象**：hook 非零退出、被超时杀掉、或 stdin 解析失败时，`parseHookOutput` 得到「无 decision」→ `mergeHookOutputs` 返回 `decision:'none'` → 桥接 `return next()` → **allow**。全程没有任何 `ctx.logger.warn`（stderr 只写进 session event 的 stderrSummary）。
- **证据**：`dsh-hook-protocol lib/index.js:112-136`（`if (exitCode === 0)` 才解析 stdout；`BLOCKING_EXIT_CODE` 才给 block）、`:197-221`（异常被吞成 `parseHookOutput(void 0, "", message)`）；实测 ③-16（`timeout:1` 杀掉 2500ms 的 hook → `{kind:'allow'}`）、③-11（exitCode 1 → allow）。
- **影响**：STS 的 `dataDir` 不可写、node 版本不对、脚本被改名……任何一处故障都变成「守卫静默消失」。
- **规避**：只能靠外部健康检查（例如让 STS 在 `SessionStart` 里写一个心跳文件，另用脚本监控）。

### D5 [S1] 一个非法 matcher 让**整个** hooks.json 全部失效（并连带其它事件）

- **现象**：任一 group 的 matcher 不合法 → `SyntaxError` → `apply` 的 `catch` 里 `warn` 后 **直接 `return`**，一个 listener 都不注册。注意这连「本来合法的事件」也一起废掉。
- **证据**：`dsh-hooks-claude-code lib/index.js:89` `throw new SyntaxError(...)`；`:149-151` `catch (error) { ctx.logger.warn(...); return; }`。实测 ③-10：`listeners: []`、`preStepError: "no listener registered for agent/pre-step"`、`totalHookSpawns: 0`。
- **影响**：改 hooks.json 时打错一个括号 = 守卫全灭（好在至少有一条 warn）。
- **规避**：配置改动后用 `node probe-matcher.mjs <cfg> <label>` 之类的方式先验一遍。

### D6 [S2] `PostToolUse` 的 `tool_response` 被拍平成文本 → STS 的委派预算永不释放

- **现象**：桥接发 `tool_response: blocksToText(result.content)`（**字符串**）。STS 读 `input.tool_response.status` 得到 `undefined` → `lifecycle='unknown'` → 预留的 agent 单位不释放。长会话里 `agents=N` 会被永久耗尽。
- **证据**：`dsh-hooks-claude-code lib/index.js:390`（`tool_response: blocksToText(result.content)`，`blocksToText` 在 `:354-356`）；`lead-sts/src/adapters/claude-hooks.cjs:90`（`const status = input.tool_response && input.tool_response.status;`）；实测 ③-7（bridge 臂第二次 subagent → `AGENT_BUDGET_EXHAUSTED`；direct 臂手喂 `{status:'completed'}` → allow）。
- **影响**：`agents=N` 在多轮会话里只能成功 N 次。
- **规避**：mapped 包装器可以只在 `PostToolUse` 里把**字符串**转成 `{status:'completed'}`（本报告未纳入默认映射，因为无法区分成功/失败；建议在 DSH 侧用 `isError` 判断后填写）。

### D7 [S2] `continue:false` / `stopReason` 被完全丢弃

- **现象**：hook 说「停下来」，桥接照常继续。
- **证据**：`dsh-hook-protocol lib/index.js:283-288` 的 `mergeHookOutputs` **确实**返回 `stop`/`stopReason`；但 `dsh-hooks-claude-code lib/index.js` 里读 `merged.` 的只有 `:210`（additionalContext）、`:244/:260/:264/:278/:303`（decision）、`:262/:282/:304`（reason），**没有一处读 `merged.stop`**。实测 ③-8：6 次 spawn 全部执行，decision 全 `allow`。
- **影响**：STS 若未来用 `continue:false` 表达「任务已完成，别再调工具」，桥接层无法传达。
- **规避**：无。

### D8 [S2] `UserPromptSubmit` 拦截时理由被丢弃，整轮直接结束

- **现象**：STS 返回 `{"decision":"block","reason":"..."}`；桥接只返回 `{kind:'reject'}`（无 reason）。下游 `dsh-agent-loop` 收到 reject 就把整轮标为 `blocked` 并 `return false`，用户看不到任何解释。
- **证据**：`dsh-hooks-claude-code lib/index.js:244` `if (merged.decision === "deny") return { kind: "reject" };`（`merged.reason` 就在手边却没用）；`dsh-agent-loop lib/index.js:960` `if (decision.kind === "reject") { turnEnds = { kind: "blocked" }; return false; }`。实测 ③-12。
- **影响**：写错 STS 指令的人只会看到「这一轮什么都没发生」。
- **规避**：无（桥接层缺陷）；可让 STS 把理由同时写到 stderr，桥接会把它进 session event 的 stderrSummary。

### D9 [S3] `statusMessage`（以及 `async` / `once` 等 CC 字段）被静默丢弃

- **现象**：STS 的 `hooks/hooks.json` 里 `PreToolUse` 带 `statusMessage: "Checking the Stop Ladder..."`；桥接只保留 `type` / `command` / `timeout`（`lib/index.js:81-84`）。`grep -c statusMessage` 在**桥接包与 hook-protocol 里都是 0**，也没有任何 warn。
- **影响**：STS 侧无功能损失（`statusMessage` 只是 CC 的 UI 提示）——**但意味着 `async: true` 这类会改变执行语义的字段也会被静默丢弃**：CC 的 async hook 是后台跑，桥接会把它当同步 hook 阻塞工具调用。写在 hooks.json 里的 `async` 会让工具调用白等一个完整 hook 时长。
- **证据**：`lib/index.js:74-84`（只 push `{command, ...timeout}`）；实测 STS 的 hooks.json 里那条 `statusMessage` 在 `results/*.json` 的 `warnings` 里从未出现（③-1 `warnings: []`）。
- **规避**：hooks.json 里不要写 `async`。

### D10 [S3] `SubagentStop` 的 `agent_type` 硬编码成 `general-purpose`

- **现象**：`lib/index.js:347` `const SUBAGENT_TYPE = "general-purpose";`。hooks.json 里按具体 kind（如 `code-reviewer`）写的 matcher 永不命中；只有 `*` / 空 / `general-purpose` 能命中。
- **影响**：对 STS 无害（它用 `*`），但会影响任何按子代理类型分流的配置。

### D11 [S2] 默认状态目录落在系统临时目录且全局共享

- **现象**：桥接只注入 `CLAUDE_PROJECT_DIR`（`lib/index.js:170-171`），从不设 `PLUGIN_DATA` / `CLAUDE_PLUGIN_DATA`。STS 于是退回 `os.tmpdir()/stop-that-shit-dev`（`lead-sts/src/state.cjs:11-13`）。
- **证据**：实测 ③-18（`defaultDataRoot: "C:\\Users\\<you>\\AppData\\Local\\Temp\\stop-that-shit-dev"`，`sessionFiles 4 → 5`，`envPassedToHook` 只有 `CLAUDE_PROJECT_DIR`）。
- **影响**：多个 DSH profile、多个项目、以及真的 Claude Code 共用同一份状态；临时目录随时可能被清理 → 状态丢失（武装中突然变未武装）。
- **规避**：在包装器里显式 `dataDir`（`handleClaudeHook(input, { dataDir })`），或让 STS 换 env 名。

### D12 [S2] 精确版本 peer 声明：任何 DSH 小版本升级都会静默禁用插件

- **现象**：`peerDependencies` 全是精确版 `0.2.1-rc.2`（不是 `^`）。运行时升到 `0.2.1-rc.3` 后，整行被 `disabling profile plugin row` 禁用；rc.2 与 rc.3 的 `lib/index.js` **字节级相同**（diff 0 行），纯粹是版本号门禁。
- **证据**：③-14；`bridge = ref/rc2/package/lib/index.js` vs `ref/rc3/bridge-index.js` → `diff` 无输出；`package.json` 唯一差异是 peer 版本号。
- **影响**：每次 DSH 升级都要重新匹配桥接包版本；报错文案让你用 `dsh plugin allow-version`，但**该子命令不存在**（`dsh plugin --help` 只有 `--profile` / `-h`）。
- **规避**：锁死 DSH 版本，或升级后立刻装同版本桥接包，或用插件管理器授予 exact-version 豁免。

### D13 [S3] 每次命中的工具调用都要付一次 node 冷启动

- **证据**：实测 ③-19，中位数 **117ms（raw）/ 121ms（mapped）**。
- **影响**：一次 `PreToolUse` 一次进程；`PostToolUse` 对非委派工具是纯浪费（STS 在 `claude-hooks.cjs:142` 直接返回 null）。

### D14 [S3] `transcript_path` 恒为空串（**对 STS 无影响**，但要记录）

- **证据**：`lib/index.js:360` `transcript_path: ""`；官方 README 也明说「出于兼容性保留但始终为 ''」。
- **对 STS 无影响**：`grep -rn transcript_path lead-sts/src lead-sts/hooks` 在 STS 的逻辑代码里 **0 命中**，它不用这个字段。

### D15 [S2] STS 的 `require_user_approval` 被压成 `deny`，桥接的 `ask` 通路形同虚设

- **现象**：STS 有 `require_user_approval` 这个 outcome（`lead-sts/src/decision.cjs:108/119/141/163/223`），但 Claude 适配器只产出 `permissionDecision:'deny'`（`lead-sts/src/adapters/claude-hooks.cjs:146-154`）。所以桥接的 `{kind:'ask'}` 分支（`lib/index.js:264-267`）永远不会被触发——**所有需要人工确认的动作都变成硬拒绝**。
- **影响**：DSH 的 ask/approval UI 永远收不到 STS 的确认请求。
- **规避**：需要 STS 侧改适配器（它不是本报告范围，属于给 STS 上游的建议）。

---

## ⑤ 安装步骤草案

> 目标：在**真实 profile**（下面以 `desktop` 为例）里装上桥接包 + STS 守卫，且不重蹈 `ststest` 的覆辙。
> **前提**：桥接包版本必须严格等于 DSH 运行时版本（`dsh --version`）。本节以 `0.2.1-rc.3` 为例。

### 5.1 为什么必须显式装 4 个包（本机 profile 的特殊性）

profile 的 `pnpm-workspace.yaml` 是 DSH 自己写的模板（asar 内 `ref/app-boot-index.js:602` 的 `PROFILE_PNPM_WORKSPACE`，与 `C:\Users\<you>\.dsh\profiles\desktop\pnpm-workspace.yaml` 完全一致）：

```yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

`autoInstallPeers: false` + `hoisted` 的直接后果（已在隔离 `DSH_HOME` 上复现两次，见 ③-13）：

**只装 `dsh-hooks-claude-code` + `dsh-hook-protocol` → 加载即 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm`**。因为：

- 桥接包的 `dependencies` 只有 `@deepseek-ai/schemastery`（会装）；
- 它 `import` 了 `@deepseek-ai/dsh-llm`（`lib/index.js:3`，`createUserMessage`）与 `@deepseek-ai/dsh-hook-protocol`（`:4`），两者都只是 **peer**，pnpm 不会自动装；
- `@deepseek-ai/cordis` 也是 peer（`~4.0.5`），`Config`/`apply` 的宿主契约由它提供。

其余 peer（`dsh-agent` / `dsh-session` / `dsh-tools` / `dsh-subagent` / `dsh-session-projection` / `dsh-working-directory` / `dsh-shell`）**运行时不 import**，只在 `inject = ["shell","sessionProjections","workingDirectory"]`（`lib/index.js:114-118`）里按服务名查找 —— DSH 运行时会从安装 scope 供应。所以 `pnpm peers check` 仍会抱怨它们，但**不影响加载**（实测：补 `dsh-llm` + `cordis` 后 import 立刻 OK）。

### 5.2 安装命令（真实 profile）

> 本机 `dsh` **不在 PATH 上**（`which dsh` 无结果）。下面用绝对路径调用 desktop 自带的 CLI；如果你的 PATH 里有 `dsh`，把前缀换掉即可。
> desktop 是 Electron 独占的 profile，普通 `dsh` 不允许管理它（`dsh-ops/lib/profile-install.js:33-40` 的 `desktopCliCandidates()` 只认下面这一个 launcher）。

```bash
CLI='C:/Users/<you>/AppData/Local/Programs/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd'
```

```bash
# 0) 确认版本一致（版本不一致会被 disabling，见 D12）
"$CLI" --version                  # 例如 0.2.1-rc.3

# 1) 装桥接包 + 它运行时真正需要的两个 peer
"$CLI" plugin --profile desktop add \
  @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.3 \
  @deepseek-ai/dsh-hook-protocol@0.2.1-rc.3 \
  @deepseek-ai/dsh-llm@0.2.1-rc.3 \
  @deepseek-ai/cordis@4.0.5

# 2) 立刻验证能 import（这一步失败，后面全是白搭）
cd "$HOME/.dsh/profiles/desktop"
node -e "import('@deepseek-ai/dsh-hooks-claude-code').then(m=>console.log('OK',Object.keys(m)),e=>console.log('FAIL',e.code,'|',e.message))"
#   期望：OK [ 'Config', 'apply', 'inject', 'name' ]
```

> `$CLI plugin` 会打印两条 `declares no dsh.bundle - installed as a plain dependency, not a profile layer` 的 warning。**这是预期的**：桥接包不是 bundle，它要靠 `cordis.patch.yml` 的 `insert` 挂载，不需要进 `dsh.profile.bundles`。

### 5.3 准备 STS 的 hooks 配置（含工具名映射）

1. **包装器**：把 `bridge-test/sts-dsh-wrapper.cjs` 复制到一个**稳定路径**，例如 `C:\Users\<you>\.dsh\sts\sts-dsh-wrapper.cjs`。它靠 `STS_PLUGIN_ROOT` 环境变量（或默认 `../lead-sts`）定位 STS；生产环境建议在包装器顶部把 `STS_ROOT` 改成绝对路径，或设 `STS_PLUGIN_ROOT`。
2. **hooks 配置**：以 `bridge-test/make-hooks-dsh.cjs` 生成 `hooks-dsh.json`，与 STS 原版 `hooks.json` 的差别**只有** `PreToolUse` 那一条命令：

```jsonc
// hooks-dsh.json - 8 个事件保持 STS 原样，只有 PreToolUse 换命令
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [{
          "type": "command",
          "command": "node \"C:/Users/<you>/.dsh/sts/sts-dsh-wrapper.cjs\"",
          "timeout": 5               // 秒，与 CC 一致（核查见 ③-16）
        }]
      }
    ]
    // SessionStart / UserPromptSubmit / PostToolUse / SubagentStart：
    //   node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-that-shit-claude.cjs"，timeout 5 - 原样保留
    // SessionEnd / PostToolUseFailure / PermissionDenied：保留也无害，但永远不会被调用（D2）
  }
}
```

3. **路径要用正斜杠**：命令串是通过 `bash -c` 执行的，反斜杠会被当转义。本机实测正斜杠路径完全可用。

### 5.4 `cordis.patch.yml` 写法

`C:\Users\<you>\.dsh\profiles\desktop\cordis.patch.yml` 是一个**顶层 YAML 数组**（loader patch 列表），追加一条 `- insert:` 即可：

```yaml
- insert:
    - id: sts-claude-hooks            # 任意唯一 id，用于后续禁用/改配置
      name: "@deepseek-ai/dsh-hooks-claude-code"
      config:
        # 必填：STS（或映射版）的 hooks.json 绝对路径，正斜杠
        configPath: "C:/Users/<you>/.dsh/sts/hooks-dsh.json"
        # 【必填，否则整条守卫静默失效 - D3】
        pluginRoot: "D:/harness-deepseek workspace/dsh插件安装/lead-sts"
        # 可选：注入子进程的 CLAUDE_PROJECT_DIR；不写则用 agent 的工作目录
        projectDir: "D:/your/project"
        # 可选：hook 没写 timeout 时的默认值，单位毫秒（默认 600000）
        defaultTimeoutMs: 15000
```

要点：

- `id` 可以随便取，但**必须唯一**；以后临时关掉守卫就是给它加 `disabled: true`。
- `pluginRoot` **必须**指向 STS 仓库根（含 `hooks/stop-that-shit-claude.cjs` 的那一层），**不要带尾斜杠**。
- `projectDir` 建议显式写：它同时用作 hook 的 `cwd`（也是除 `defaultTimeoutMs` 外唯一影响相对路径判定的配置）。
- 保持 STS 的 `${CLAUDE_PLUGIN_ROOT}` 写法（让桥接去替换），**不要**自己把路径写死到 hooks.json 里 —— 写死也能跑，但换目录时要改两处。

### 5.5 让 STS 的状态落在可控目录（强烈建议）

桥接**不会**传 `PLUGIN_DATA`（D11），默认落在 `%TEMP%\stop-that-shit-dev`。桥接的 `Config` 只有 5 个键（`lib/index.js:121-127`），**没有 env 字段可配**，所以只能从包装器侧解决：在 `sts-dsh-wrapper.cjs` 里写死一个 `dataDir`（或用包装器自己的环境变量读取）。

```js
// sts-dsh-wrapper.cjs 末尾，替换默认的 handleClaudeHook 调用：
const output = handleClaudeHook(mapped, {
  dataDir: process.env.STS_DATA_DIR || 'C:/Users/<you>/.dsh/sts/data',
});
```

### 5.6 安装后自检清单

```bash
# 1) 插件是否真的激活（不是被 disabling、did not activate）
"$CLI" --profile desktop --dump-config | grep -A6 'sts-claude-hooks'

# 2) 启动后在日志里搜这几个串，任何一个出现都说明装错了
#    - disabling profile plugin row "sts-claude-hooks"        -> 版本不匹配（D12）
#    - 1 entry did not activate                               -> apply 抛异常（配置错）
#    - could not load hook config ... no hooks registered     -> hooks.json 路径/语法错（D5）

# 3) 交互式验证（在真实会话里）
#    a. 发一条普通 prompt，确认没有异常
#    b. 发 $stop-that-shit change files=src/app.ts -- do it，确认收到 'Stop That Shit (active)' 上下文
#    c. 让模型 write src/app.ts   -> 应放行
#    d. 让模型 write src/other.ts -> 应被 deny，错误文本含 STOP / SCOPE 与 PATH_OUTSIDE_CONTRACT
#    e. 让模型 glob / ops_bash    -> 映射生效时应放行（被 WRITE_PATH_UNPROVEN 拒 = 包装器没生效）
```

> **最省事的冒烟测试**：先不装进真实 profile，直接在 `bridge-test/` 里跑 `node run-scenarios.mjs --config hooks-dsh.json --plugin-root '../lead-sts' --label smoke`，看 ③-2 的 6 个场景是否全绿。

### 5.7 已知会踩的坑（按遇到概率排序）

| 现象 | 原因 | 处理 |
|---|---|---|
| 启动日志 `disabling profile plugin row` | 桥接包版本 ≠ DSH 运行时版本 | 装同版本桥接包（D12）；`dsh plugin allow-version` 不存在，只能走插件管理器 |
| `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-llm` | 只装了 2 个包（`autoInstallPeers:false`） | 补 `dsh-llm` + `cordis`（5.2） |
| 武装成功但越界写被放行 | `pluginRoot` 没配（D3） | 加 `pluginRoot` |
| `glob`/`ops_bash`/`todo_write` 全被拒 | 用了原版 `hooks.json`（D1） | 换 `hooks-dsh.json` + 包装器 |
| 改过 hooks.json 后守卫彻底没了 | 非法 matcher 让全部 listener 不注册（D5） | 看启动日志里的 `could not load hook config` |
| 长会话里 `subagent` 突然被 `AGENT_BUDGET_EXHAUSTED` 拒 | 委派预算没释放（D6） | 重启会话，或在包装器里补 `tool_response` 修复 |
| 状态莫名其妙丢失/串项目 | 默认数据目录在 `%TEMP%`（D11） | 在包装器里固定 `dataDir` |
| 每个工具调用明显变慢 | 每次 PreToolUse 都 spawn node（D13，+117ms） | 无法消除；只能接受 |

---

## 附录 A：证据来源速查

| 主题 | 文件 |
|---|---|
| 桥接包源码（rc.2 / rc.3 字节级相同） | `bridge-test/node_modules/@deepseek-ai/dsh-hooks-claude-code/lib/index.js`、`bridge-test/ref/rc2/package/lib/index.js` |
| hook 协议层源码 | `bridge-test/node_modules/@deepseek-ai/dsh-hook-protocol/lib/index.js` |
| DSH 宿主契约（tools waterfall / agent loop / subprocess env 清洗） | `bridge-test/ref/dsh-tools.js`、`ref/agent-loop.js`、`ref/dsh-subprocess.js` |
| profile 解析与 pnpm 模板 | `bridge-test/ref/app-boot-index.js`（`:602` 模板、`:311` 兼容性门禁、`:335` 报错文案、`:718` installation scope）、`ref/app-boot-profile-resolution.js`（`:401` routeScoped） |
| STS 源码（只读） | `lead-sts/src/adapters/claude-hooks.cjs`、`src/adapters/claude-tool-classifier.cjs`、`src/decision.cjs`、`src/controller.cjs`、`src/state.cjs` |
| 全部实测输出 | `bridge-test/results/*.json` |

## 附录 B：与任务书的偏差说明

1. **中途 DSH 从 rc.2 升级到 rc.3**。因此把 scratch 安装与最终 profile 验证都改用了 rc.3 的包；**并已验证 rc.2/rc.3 的 `lib/index.js` 与 hook-protocol 字节级相同**，所以 rc.2 上的行为结论全部成立（③-1、③-2 在 rc.3 上重跑，结论一致）。
2. **没能在真实会话里跑出「模型触发 + PreToolUse deny」的完整 e2e**：真实 `dsh --profile test3 headless` 因缺 `DEEPSEEK_API_KEY` 在 `MISSING_CREDENTIAL` 退出，没有创建 agent（所以 `agent/created` 与 `SessionStart` 都没触发）。已用**故意配错的配置**证明 `apply()` 在真实运行时确实执行（③-15），并说明了「脚本被杀/超时/崩溃」都会走同一条 fail-open 路径（D4）。要跑完整 e2e 需要已登录/有 API key 的环境。
3. **15 个缺陷里有 4 个是宿主/生态问题**（D12 版本门禁、`allow-version` 缺失、pnpm peer 策略、D13 的 node 冷启动），不是桥接包代码本身的锅，但会直接导致「装不上/太慢」，所以保留在清单里。
