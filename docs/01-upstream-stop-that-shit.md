# Stop That Shit（别再造史了 / STS）对宿主的能力要求 — 调研报告

调研对象：https://github.com/lennney/stop-that-shit
版本：v0.2.5（MIT），本地检出 `D:\tmp111\sts`，分支 main，HEAD `c7497a134122fd1c1a4b8d0300a4b74120e42d98`
调研方式：`git clone --depth 1`（本会话对 raw.githubusercontent.com 的 web_fetch 返回 404，GitHub REST API 可用但需反转义，最终以 clone 为准）+ 实机跑 hook 冒烟测试
最终目的：判断能否装到 DeepSeek Harness（Electron 桌面 AI coding agent，cordis 插件系统）

---

## 0. 一句话结论

STS 的 **Skill 部分是纯 Markdown + YAML frontmatter，可原样复用**；**Guard 部分不是插件 API 绑定，而是一个"输入 JSON → 输出 JSON"的策略进程**，核心零第三方依赖，任何宿主只要能 (a) 给出稳定 sessionId、(b) 在用户输入时喂一次 prompt.submit、(c) 在工具执行前喂一次 action.before 并接受否决，就能接。STS 自己把这条通用缝叫 **ControlEvent v2**。

---

## 1. 仓库目录结构（370 个条目）

```
stop-that-shit/
├─ README.md / README_EN.md / README_CN.md / README_KO.md
├─ ARCHITECTURE.md  CHANGELOG.md  CONTRIBUTING.md  EVIDENCE.md  PRIVACY.md  SECURITY.md
├─ HOST-ADAPTER-CONTRACT.md      # 37911B，权威 Adapter 契约文档
├─ INSTALL.md (22064B)  INSTALL_FOR_AGENTS.md (5492B)  release-files.json
│
├─ .claude-plugin/{plugin.json, marketplace.json}     # Claude Code
├─ .codex-plugin/plugin.json                          # Codex
├─ .agents/plugins/marketplace.json                   # 通用 agents 市场清单
├─ .hermes-plugin/{plugin.yaml, __init__.py, README.md,
│                  runtime/stop-that-shit.cjs (128547B 预构建单文件包), .npmignore}
├─ .codexignore
│
├─ hooks/
│   ├─ hooks.json                  # Claude Code hook 配置
│   ├─ codex-hooks.json            # Codex hook 配置
│   ├─ stop-that-shit-claude.cjs   # Claude 入口（1069B）
│   └─ stop-that-shit.cjs          # Codex/Hermes 通用入口（1025B）
│
├─ src/                            # 共享核心（全部 .cjs）
│   ├─ controller.cjs              # ★ 通用入口 handleControlEvent()
│   ├─ control-protocol.cjs        # ControlEvent v2 协议常量/校验
│   ├─ contracts.cjs               # mode/level/hash/deps/paths 契约模型
│   ├─ state.cjs  state-schema.cjs # 会话状态持久化（文件 + 锁）
│   ├─ decision.cjs  delegation-state.cjs  hash-intent.cjs
│   ├─ hook-policy.cjs             # 兼容 facade（旧 Codex 路径）
│   ├─ manifest-dependencies.cjs  shell-analysis.cjs
│   ├─ runtime-annotations.cjs  runtime-audit.cjs  runtime-storage.cjs
│   └─ adapters/
│       ├─ claude-hooks.cjs  claude-tool-classifier.cjs
│       ├─ codex-hooks.cjs   codex-tool-classifier.cjs
│       ├─ opencode-hooks.cjs  opencode-v2-hooks.cjs  opencode-tool-classifier.cjs
│       ├─ hermes-hooks.cjs  hermes-tool-classifier.cjs
│       ├─ pi-hooks.cjs  pi-extension.cjs  pi-tool-classifier.cjs
│       ├─ omp-hooks.cjs  omp-extension.cjs  omp-tool-classifier.cjs
│       └─ lifecycle-fields.cjs
│
├─ opencode/{stop-that-shit.mjs (14754B), runtime.mjs, v2.mjs}
├─ pi/stop-that-shit.ts            # 444B
├─ omp/stop-that-shit.ts           # 429B
├─ server.mjs                      # 140B，3 行 re-export
│
├─ skills/
│   ├─ stop-that-shit/{SKILL.md (8197B), agents/openai.yaml}
│   └─ stss/{SKILL.md (4694B), agents/openai.yaml, references/examples.md}
│
├─ scripts/{sts.cjs (CLI), build-hermes-plugin.cjs, release-check.cjs,
│           run-paired-eval.cjs, paired-eval-lib.cjs, case-bundle-lib.cjs,
│           test.cjs, test-hosts.cjs, build-release.cjs, evaluate-cases.cjs, ...}
├─ schemas/case-bundle-v1.schema.json
├─ cases/  evals/{codex-paired, stss}/
└─ test/   # 36 个测试文件，含 test/hooks.test.cjs (52344B)、test/contracts.test.cjs、各宿主 adapter 测试
```

---

## 2. 各宿主 adapter 具体接哪个钩子 API

来源：`HOST-ADAPTER-CONTRACT.md`（Codex mapping:122 / Claude Code mapping:191 / OpenCode mapping:238 / Hermes Agent CLI:348 / Pi:417 / Oh My Pi:466）+ 各入口源码。

STS 0.2.5 已实现 **6 个** 宿主 adapter：Codex、Claude Code、OpenCode、Hermes Agent CLI、Pi、Oh My Pi。所有 adapter 都翻译成同一个 **ControlEvent v2**，再复用同一套 parser/controller/decision/state。

### 2.1 通用事件模型（所有宿主的公共接口）

`HOST-ADAPTER-CONTRACT.md:40-60` 原文给出最小归一事件：

```json
{
  "protocolVersion": 2,
  "lifecycleVersion": 2,
  "kind": "action.before",
  "sessionId": "opaque",
  "action": {
    "name": "Edit",
    "mutability": "write",
    "affectedPaths": ["src/config.cjs"],
    "dependencyIntent": false,
    "hashIntent": false
  }
}
```

`src/control-protocol.cjs`：
- `PROTOCOL_VERSION = 2`
- `EVENT_KINDS = Set('session.start','prompt.submit','action.before','action.after','subagent.start','subagent.stop','session.end')`
- `MUTABILITIES = Set('read','write','delegate','control','unknown')`

`HOST-ADAPTER-CONTRACT.md:10-17` 列出 adapter 能复用决策模块的**四个必要条件**（原文）：

1. a stable session identifier;
2. user prompts or explicit mode changes;
3. a before-action event that can actually deny an action;
4. tool name, input, and enough information to classify mutability.

> 这四条就是「宿主能力要求」的官方定义。任何宿主满足这 4 条即可接。

### 2.2 Claude Code

Hook 事件映射（`src/adapters/claude-hooks.cjs` 的 `EVENT_KIND`）：

```
SessionStart         -> session.start
UserPromptSubmit     -> prompt.submit   (含 /stop-that-shit:stop-that-shit slash 形式)
UserPromptExpansion  -> prompt.submit   (仅 SKILL 用，可选)
PreToolUse           -> action.before
PostToolUse          -> action.after    (按 tool_use_id 关联)
PostToolUseFailure   -> action.after    (lifecycle = unknown)
PermissionDenied     -> action.after    (lifecycle = not_started，仅 auto 模式)
SubagentStart        -> subagent.start
SubagentStop         -> 忽略（stop 尝试可被其它 hook 继续，不能证明终止）
SessionEnd           -> session.end
```

**配置文件** `hooks/hooks.json`：8 个事件，全部 `"type":"command"`、`"timeout": 5`，命令统一为 `node "${CLAUDE_PLUGIN_ROOT}/hooks/stop-that-shit-claude.cjs"`。结构：

```json
{
  "description": "Stop That Shit for Claude Code: ...",
  "hooks": {
    "SessionStart":       [{"matcher":"*","hooks":[{"type":"command","command":"node \"<CPR>/hooks/stop-that-shit-claude.cjs\"","timeout":5}]}],
    "UserPromptSubmit":   [{"hooks":[...同上...]}],
    "PostToolUse":        [{"matcher":"*","hooks":[...]}],
    "PreToolUse":         [{"matcher":"*","hooks":[{..., "timeout":5, "statusMessage":"Checking the Stop Ladder..."}]}],
    "SessionEnd":         [{"matcher":"*","hooks":[...]}],
    "SubagentStart":      [{"matcher":"*","hooks":[...]}],
    "PostToolUseFailure": [{"matcher":"*","hooks":[...]}],
    "PermissionDenied":   [{"matcher":"*","hooks":[...]}]
  }
}
```

（UserPromptSubmit 没有 matcher；其余都是 `"matcher":"*"`。）

**stdin 字段**（adapter 实际读取）：`hook_event_name`、`session_id`、`prompt_id|turn_id`、`model`、`permission_mode`、`agent_id`、`agent_type`、`tool_name`、`tool_input`、`tool_use_id|tool_call_id`、`tool_response.{agentId|agent_id,status}`、`cwd`、`prompt`（UserPromptSubmit）、`expansion_type`/`command_name`（UserPromptExpansion）。

**stdout 结构**（三种）：
```json
// 拒绝
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"<message>"}}
// 注入上下文
{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"<text>"}}
// 无效指令
{"decision":"block","reason":"<message>"}
```

**plugin.json**：`.claude-plugin/plugin.json` → `name/displayName/version/description/author/homepage/repository/license/keywords/skills`，其中 `"skills": "./skills/"`。另 `.claude-plugin/marketplace.json`（`plugins[0].source = "./"`）。

### 2.3 Codex

映射（`src/adapters/codex-hooks.cjs`，只 5 个事件）：

```
SessionStart     -> session.start
UserPromptSubmit -> prompt.submit
PreToolUse       -> action.before
PostToolUse      -> action.after
SessionEnd       -> session.end
```

**配置** `hooks/codex-hooks.json`（4 个事件），命令形式用 `node -e` + 环境变量回退：

```json
"command": "node -e \"const p=require('node:path');require(p.join(process.env.PLUGIN_ROOT??process.env.CLAUDE_PLUGIN_ROOT,'hooks','stop-that-shit.cjs'))\""
```

`PostToolUse` 的 matcher 只抓 spawn/wait：
`^(?:spawn_agent|Agent|wait_agent|multi_agent_v1wait_agent|collaborationspawn_agent|collaborationwait_agent)$`

Codex 专有细节：`spawn_agent` 返回 `{agent_id, nickname}`（UUID）；`wait_agent` 的 `timed_out===false` + `targets[]` + `status{}` 才能释放槽位；识别 `multi_agent_v1{wait_agent,send_input,resume_agent,close_agent}`；桌面版 `collaboration` 命名空间前缀（`collaborationspawn_agent` 等 6 个）由 `canonicalCodexToolName()` 归一。**Codex 的 PreToolUse 不支持 `permissionDecision:"ask"`**，需要续授权时降级为 deny+解释。

**信任流程**：`codex plugin marketplace add lennney/stop-that-shit --ref 0.2.5` → `codex plugin add stop-that-shit@stop-that-shit` → 重启 → 在新 CLI TUI 里敲 `/hooks` 审查并信任命令。

**plugin.json**：`.codex-plugin/plugin.json` → 多出 `"hooks": "./hooks/codex-hooks.json"` 和 `interface{displayName,shortDescription,longDescription,developerName,category,capabilities,websiteURL,privacyPolicyURL,termsOfServiceURL,brandColor,composerIcon,logo,defaultPrompt[]}`。

### 2.4 OpenCode

**入口** `opencode/stop-that-shit.mjs`，默认导出 `{ id:'stop-that-shit', server: StopThatShitPlugin, effect: (ctx)=>...import('./v2.mjs') }`。两个 loader 都解析它，宿主自己选 V1 或 V2。`package.json` 的 `main` 指向该文件；根 `server.mjs` 是 3 行 re-export，因为 **OpenCode V2 的本地目录发现会探测物理入口文件**。

**V1 钩子（只用文档化 API）**：
- `event: async ({event}) => {...}` —— 处理 `message.part.updated`、`session.created`、`session.updated`、`session.deleted`、`session.idle`、`session.status`
- `'tool.execute.before': async (input, output) => {...}` —— **拒绝方式：`throw new Error(result.message)`**
- `'tool.execute.after': async (input, output) => {...}` —— 把 watch 上下文 `appendToolContext(output, text)` 塞进 `output.output`

V1 用到的 SDK：`client.session.get({path:{id}})`、`client.session.message({path:{id,messageID}})`、`client.session.prompt({path:{id}, body:{noReply:true, parts:[{type:'text',text,synthetic:true}]}})`、`client.app.agents()`、`client.app.log({body:{...}})`。

**V2 钩子（Effect API）** `opencode/v2.mjs`：
- `ctx.session.hook('context', cb)` → `session.context`
- `ctx.tool.hook('execute.before', cb)`
- `ctx.tool.hook('execute.after', cb)`
- `ctx.event.subscribe()` 流式事件
- `ctx.storage.get/set/remove`、`ctx.session.get`、`ctx.session.context`、`ctx.agent.get`
- 拒绝 = 抛 `Tool.Error`（不是把 Promise reject 转成 defect）
- 依赖 `@opencode/schema 2.0.30` + `effect 4.0.0-rc.112`；`engines.opencode = ">=1.18.18 <2 || >=2.0.18 <3"`

V2 文档明确写「Code Mode 不是整程序执行边界」—— 直接网络效应不过 tool hook。

### 2.5 Hermes Agent CLI

**Python 原生插件** `.hermes-plugin/__init__.py`，通过 `subprocess.run(["node", _RUNTIME], input=json.dumps(envelope), text=True, capture_output=True, timeout=2.0)` 调用预构建 Node 单文件包 `.hermes-plugin/runtime/stop-that-shit.cjs`。

**manifest** `.hermes-plugin/plugin.yaml`：
```yaml
name: stop-that-shit
version: "0.2.5"
description: "Stop That Shit task-boundary Guard for Hermes Agent CLI."
manifest_version: 1
hooks:
  - pre_llm_call
  - pre_tool_call
```

**注册的 hook**（`register(ctx)`，共 6 个）：
```python
ctx.register_hook("pre_llm_call",   _prompt)        # -> prompt.submit
ctx.register_hook("pre_tool_call",  _tool)          # -> action.before
ctx.register_hook("post_tool_call", _post_tool)     # -> action.after（只对 delegate_task）
ctx.register_hook("subagent_start", _subagent_start)
ctx.register_hook("subagent_stop",  _subagent_stop)
ctx.register_hook("on_session_end", _session_end)
```

**envelope**（Python → Node）：`{hook_event_name, session_id, tool_call_id, tool_name, tool_input, cwd, model, extra:{...}}`。
**返回**：context → `{"context":"..."}`；拒绝 → `{"action":"block","message":"..."}`。
超时 2.0s；`returncode != 0` 或 stdout 空 或非 dict → None（fail-open）。

### 2.6 Pi

**入口** `pi/stop-that-shit.ts`（444B），peerDependency `@earendil-works/pi-coding-agent`，实测 `0.84.4`：

```ts
import { getAgentDir, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
const { registerPiExtension } = require('../src/adapters/pi-extension.cjs');
export default function stopThatShitPiExtension(pi: ExtensionAPI) {
  registerPiExtension(pi, { dataDir: path.join(getAgentDir(), 'stop-that-shit') });
}
```

**Extension 钩子**（`src/adapters/pi-extension.cjs`）：
```
pi.on('input', (event, ctx) => ...)                -> prompt.submit；返回 {action:'continue'|'handled'}
pi.on('before_agent_start', (_event, ctx) => ...)  -> 返回 {message:{customType, content, display:false}}
pi.on('tool_call', (event, ctx) => ...)            -> action.before；拒绝 {block:true, reason}
pi.on('tool_result', (event, ctx) => ...)          -> action.after + 追加 context 到 event.content
pi.on('session_shutdown', (event, ctx) => ...)     -> session.end
```
用到的 ctx：`ctx.sessionManager.getSessionId()`、`ctx.cwd`、`ctx.mode`、`ctx.hasUI`、`ctx.model`、`ctx.ui.notify(message, level)`；`pi.sendMessage({customType, content, display}, {triggerTurn:false})`。
Pi 0.84.4 自身要求 Node `22.19.0`+。
`package.json` 的 `pi` 字段：`{"extensions":["./pi/stop-that-shit.ts"],"skills":["./skills/stop-that-shit","./skills/stss"]}`。

### 2.7 Oh My Pi (OMP)

**入口** `omp/stop-that-shit.ts`（429B），`@oh-my-pi/pi-coding-agent` `18.4.4`：
```ts
export default function stopThatShitOmpExtension(pi: ExtensionAPI) {
  registerOmpExtension(pi, { dataDir: path.join(pi.pi.getAgentDir(), 'stop-that-shit') });
}
```

**钩子**（`src/adapters/omp-extension.cjs`）：
```
pi.registerFlag('sts-contract', {type:'string', ...})
pi.registerCommand('sts', {description, handler(args, ctx)})
pi.on('session_start',  (_event, ctx) => ...)
pi.on('input',          (event, ctx) => ...)   // event.source ∈ {'interactive','rpc','extension'}
pi.on('before_agent_start', (_event, ctx) => ...)
pi.on('tool_call',      (event, ctx) => ...)   // 拒绝 {block:true, reason}
pi.on('tool_result',    (event, ctx) => ...)
pi.on('tool_approval_resolved', event => ...)  // 被拒 → action.after lifecycle='not_started'
pi.events.on('task:subagent:lifecycle', event => ...)
```
OMP 额外用 `ctx.sessionManager.getSessionFile()` 做父子会话关联（写 `{dataDir}/omp-parents/<sha256>.json`）。

---

## 3. skills/ 的 SKILL.md 是什么格式

**就是 Claude Agent Skills 标准：YAML frontmatter + Markdown 正文，纯静态，不需要运行时。**

`skills/stop-that-shit/SKILL.md` 头部（逐字）：
```yaml
---
name: stop-that-shit
description: Complete requested work while preventing speculative defenses and scope creep. Use when considering extra hardening, reviewing possible overengineering, resolving repeated verification loops, following explicit task boundaries, or when the user invokes Stop That Shit. Ordinary use of validation, retries, or dependencies alone is not a trigger.
license: MIT
---
```

`skills/stss/SKILL.md` 头部（逐字）：
```yaml
---
name: stss
description: Reduce defensive disclaimers, stacked hedging, and self-protective narration when drafting, rewriting, or auditing proposals, articles, case studies, captions, and other reader-facing prose. Use when defensive wording is requested for review or appears in a draft, including wording the assistant adds. Preserve meaningful limits; do not perform general style cleanup or ordinary code work.
license: MIT
---
```

**frontmatter 字段仅 3 个**：`name`、`description`、`license`。没有 `allowed-tools`、没有 `version`、没有 `metadata`。
正文：纯 Markdown（Stop Ladder 五问、SHIT 哲学四类），无脚本、无模板变量、无 include 指令。
→ **可移植性最高**：任何支持"目录下 SKILL.md + YAML frontmatter"的宿主都能原样吃下。

旁挂 `skills/*/agents/openai.yaml` 是 Codex 界面元数据（不属于 SKILL 标准）：
```yaml
interface:
  display_name: "Stop That Shit"
  short_description: "Keep Codex on task. Stop the rest."
  brand_color: "#D92D20"
  default_prompt: "$stop-that-shit review -- Review this diff. Report findings; do not edit."
policy:
  allow_implicit_invocation: true
```
`skills/stss/references/examples.md`（7597B）是纯参考文档，被 SKILL.md 正文引用。

SKILL.md 自述（原文）："This Skill is advisory and works without the Guard hooks. It cannot guarantee model behavior." → **Skill 与 Guard 解耦，可以只装 Skill**（INSTALL.md 有 "Optional: Skill-only" 一节）。

---

## 4. Guard 的实现语言 / 运行时 / 入口 / 调用协议

- **语言**：纯 JavaScript，CommonJS（`src/**/*.cjs`）+ ESM 包装（`opencode/*.mjs`、`pi|omp/*.ts`）。
- **Node 版本**：`package.json` `engines: {"node": ">=18"}`；INSTALL.md 第 14 行「The Guard requires Node.js 18 or newer.」
- **原生依赖**：**零**。无 gyp、无 prebuild。`dependencies` 只有 `@opencode/schema`(2.0.30) 和 `effect`(4.0.0-rc.112)，且这两者只被 OpenCode V2 adapter 用；Codex/Claude/Hermes 路径完全不碰。
- **第三方依赖实证**：`grep -rn "require('[^.]" src/ hooks/ | grep -v "require('node:"` → **空**。src/ 与 hooks/ 内所有 require 要么相对路径，要么 `node:` 内置。
- **零安装实证**：只把 `hooks/` + `src/` + `package.json` 复制到干净目录（无 node_modules、不跑 npm install），hook 依然输出完全相同的 JSON、退出码 0。

### 4.1 入口文件

| 入口 | 路径 | 大小 | 用途 |
|---|---|---|---|
| 通用（Codex/Hermes） | `hooks/stop-that-shit.cjs` | 1025B | stdin→stdout JSON |
| Claude 专用 | `hooks/stop-that-shit-claude.cjs` | 1069B | stdin→stdout JSON（Claude 事件名） |
| Hermes 单文件包 | `.hermes-plugin/runtime/stop-that-shit.cjs` | 128547B | 自包含 bundle，内部 `__modules` + `__require("src/...cjs")` |
| OpenCode | `opencode/stop-that-shit.mjs` | 14754B | 插件对象 |
| Pi | `pi/stop-that-shit.ts` | 444B | ExtensionAPI |
| OMP | `omp/stop-that-shit.ts` | 429B | ExtensionAPI |
| CLI（只读工具） | `scripts/sts.cjs`（bin `sts`） | — | doctor/runtime/explain/label/case |

### 4.2 宿主如何调用 —— stdin/stdout JSON，**退出码无语义**

`hooks/stop-that-shit.cjs` 全文（1025B）：

```js
#!/usr/bin/env node
const { handleHook } = require('../src/hook-policy.cjs');
function readStdin(maxWaitMs = 1500) {
  return new Promise((resolve) => {
    let settled = false; let body = '';
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(body); };
    const timer = setTimeout(finish, maxWaitMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { body += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    process.stdin.resume();
  });
}
(async () => {
  try {
    const raw = await readStdin();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const output = handleHook(input);
    if (output) { process.stdout.write(JSON.stringify(output) + '\n'); }
  } catch (error) {
    const errorName = error && error.name ? error.name : 'HookError';
    process.stderr.write('Stop That Shit hook failed open: ' + errorName + '\n');
  }
})();
```

要点：
- **stdin 最多等 1500ms**，读到多少算多少。
- **退出码恒为 0**（全仓库无任何 `process.exitCode` 赋值）。「拒绝」只通过 stdout JSON 表达。
- **fail-open**：JSON 解析失败 / 任何异常 → stderr 一行、退出 0，不阻塞宿主。
- 允许的操作 **stdout 完全无输出**。
- 宿主侧 timeout 是 5s（`hooks.json` 的 `"timeout": 5`），Codex SessionEnd 是 3s。

### 4.3 实测冒烟（真跑，非推断）

前置 `cd D:/tmp111/sts`，`PLUGIN_DATA=D:/tmp111/stsdata`。

1. UserPromptSubmit + `$stop-that-shit review -- inspect only` → stdout：
   `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"Stop That Shit (active): mode=review; agents=0/9007199254740991 reserved; hash=deny; deps=ask; files=unbounded. Stop Ladder: ... Harness interception coverage is a guardrail, not a security boundary."}}` exit=0
2. PreToolUse Write → stdout：
   `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"STOP / INTENT\nGuard returned permission deny.\nReason: MODE_FORBIDS_MUTATION\nDetail: Task mode review does not authorize repository mutation.\nCode: I/MODE_FORBIDS_MUTATION\nState: ARMED / review\nEvent: evt_<uuid>\nNext: Report the finding, use a read-only action, or obtain an explicit change contract."}}` exit=0
3. PreToolUse Read → stdout 空，exit=0
4. stdin `not json` → stdout 空，stderr `Stop That Shit hook failed open: SyntaxError`，exit=0（fail-open 实测）
5. stdin 空 → 无输出无报错，exit=0
6. 未知 `hook_event_name` → 无输出，exit=0

### 4.4 通用缝：`handleControlEvent()` —— 新宿主不需要任何 adapter

`src/controller.cjs:304` 导出 `{ contractContext, handleControlEvent, runtimeCommand }`。

```js
handleControlEvent(rawEvent, options = {})   // src/controller.cjs:278
// assertControlEvent(rawEvent)
// switch (event.kind):
//   'prompt.submit'  -> runtimeCommand ? handleRuntimeCommand : handlePrompt
//   'action.before'  -> handleBeforeAction(event, options)
//   'action.after'   -> handleAfterAction(event, options)
//   'session.start'|'subagent.start'|'subagent.stop'|'session.end' -> handleLifecycleContext
//   default -> none()
```

返回纯对象（不需要是 JSON）：
- `{kind:'none'}`
- `{kind:'context', text}`
- `{kind:'deny', decision:{outcome,family,reasonCode,explanation,nextStep}, eventId, message}`
- `{kind:'prompt-error', ...}`

**实测（完全绕过所有宿主 adapter）**：
```js
const { handleControlEvent } = require('./src/controller.cjs');

handleControlEvent({protocolVersion:2, lifecycleVersion:2, kind:'prompt.submit',
                    sessionId:'gen2', prompt:'$stop-that-shit review -- look only'})
// -> { kind:'context', text:'Stop That Shit (active): mode=review; ...' }

handleControlEvent({protocolVersion:2, lifecycleVersion:2, kind:'action.before', sessionId:'gen2',
                    action:{id:'a1', name:'write_file', mutability:'write', affectedPaths:['other.txt']}})
// -> {"kind":"deny","decision":{"outcome":"deny_and_explain","family":"I","reasonCode":"MODE_FORBIDS_MUTATION",
//     "explanation":"Task mode review does not authorize repository mutation.",
//     "nextStep":"Report the finding, use a read-only action, or obtain an explicit change contract."},
//     "eventId":"evt_...","message":"STOP / INTENT\nGuard returned permission deny.\n..."}

handleControlEvent({protocolVersion:2, lifecycleVersion:2, kind:'action.before', sessionId:'gen2',
                    action:{id:'a2', name:'read_file', mutability:'read'}})
// -> {"kind":"none"}
```

→ **新宿主只需 4 件事**：(a) 稳定 sessionId；(b) 用户回合喂 `prompt.submit`；(c) 每次工具调用前喂 `action.before {name, mutability, affectedPaths}`；(d) `kind==='deny'` 就当否决。**完全不需要 Claude/Codex 的 JSON 形状。**

### 4.5 新 adapter 必须提供的 4 个事实

`src/adapters/pi-tool-classifier.cjs:97` 导出：
```js
module.exports = { analyzePiTool, classifyPiTool, detectDependencyIntent,
                   detectHashIntent, extractAffectedPaths, piDelegationShape };
```
`analyzeXTool` 返回（第 90-94 行）：
```js
{ mutability: classifyXTool(toolName, toolInput),
  hashIntent: detectHashIntent(toolName, toolInput),
  dependencyIntent: detectDependencyIntent(toolName, toolInput),
  affectedPaths: extractAffectedPaths(toolName, toolInput, cwd) }
```
→ 下游全部共享；写 adapter 只需填这 4 个。

### 4.6 状态存储（可重定向，无宿主耦合）

`src/state.cjs:12`：
```js
function dataRoot(override) {
  return override || process.env.PLUGIN_DATA || process.env.CLAUDE_PLUGIN_DATA
      || path.join(os.tmpdir(), 'stop-that-shit-dev');
}
```
`sessionKey(sessionId) = sha256(String(sessionId||'unknown')).slice(0,24)`；状态文件 `{dataRoot}/sessions/{sessionKey}.json`；`LOCK_STALE_MS = 10000`；写状态用 `mode 0o600` 的 tmp+rename。

→ **新宿主只要传 `options.dataDir` 或设 `PLUGIN_DATA` 即可，零代码改动。不写 `~/.claude`、不改全局配置。**

### 4.7 CLI（`scripts/sts.cjs`，bin `sts`）—— 只读工具，不是策略入口

```
sts doctor [--check-update] [--data-dir <path>]
sts runtime [--data-dir <path>]
sts explain <eventId> [--data-dir <path>]
sts label <eventId> correct|incorrect|inconclusive [--data-dir <path>]
sts case new --id <slug> [--output <path>]
sts case validate <directory>
```
错误 → stderr `sts failed: <message>`，这里**才**有 `process.exitCode = 1`（scripts/sts.cjs:151-153）。

### 4.8 决策 reasonCode 全表（`src/decision.cjs`）

`AGENT_BUDGET_EXHAUSTED`、`CONTROL_INACTIVE`、`DELEGATION_LIFECYCLE_UNPROVEN`、`DELEGATION_STATE_UNPROVEN`、`DEPENDENCY_NOT_AUTHORIZED`、`DUPLICATE_ACTION_ID`、`HASH_NOT_AUTHORIZED`、`HYPOTHETICAL_UNREACHABLE`、`INVALID_DIRECTIVE`、`LIFECYCLE_PROTOCOL_REQUIRED`、`MODE_FORBIDS_MUTATION`、`MUTABILITY_UNPROVEN`、`PATH_OUTSIDE_CONTRACT`、`RECOVERY_READ_ONLY`、`STATE_DAMAGED`、`STS_LOCK_DAMAGED`、`UNAPPROVED_SCOPE_EXPANSION`、`UNBOUNDED_DELEGATION`、`WITHIN_CONTRACT`、`WRITE_PATH_UNPROVEN`

### 4.9 契约模型（`src/contracts.cjs`）

`MODES = answer|review|change|monitor|open`；`LEVELS = watch|guard|lock|off`；`HASH_POLICIES = deny|ask|allow`；`SCOPE_POLICIES = deny|ask|allow`；`DEFAULT_AGENT_LIMIT = Number.MAX_SAFE_INTEGER`。
`defaultContract()` → `{mode:'unconfirmed', level:'watch', agentBudget:MAX_SAFE_INTEGER, hashPolicy:'deny', allowedPaths:null, dependencyPolicy:'ask', source:'default'}`。
指令正则：`/^(?:[ \t]*\r?\n)* {0,3}\$(?:stop-that-shit:)?stop-that-shit(?=$|[\s,:])/i`（首行、非引用/代码块；4 空格或 tab 视为代码示例）。

---

## 5. 除 Guard 外的 hook / 插件配置文件清单

| 文件 | 宿主 | 作用 |
|---|---|---|
| `hooks/hooks.json` | Claude Code | 8 个 hook 事件，全部 `type:command` |
| `hooks/codex-hooks.json` | Codex | 4 个 hook 事件 |
| `.claude-plugin/plugin.json` | Claude Code | name/version/skills 指向 `./skills/` |
| `.claude-plugin/marketplace.json` | Claude Code | 本地 marketplace（`source: "./"`） |
| `.codex-plugin/plugin.json` | Codex | 多 `hooks` 字段 + `interface{}` 大对象 |
| `.agents/plugins/marketplace.json` | 通用 | `policy.installation=AVAILABLE`、`authentication=ON_INSTALL` |
| `.hermes-plugin/plugin.yaml` | Hermes | `manifest_version:1`、`hooks: [pre_llm_call, pre_tool_call]` |
| `.hermes-plugin/__init__.py` | Hermes | Python 适配层，6 个 `ctx.register_hook` |
| `package.json` 的 `pi` 字段 | Pi | `extensions` + `skills` 数组 |
| `package.json` 的 `main`/`bin` | OpenCode / CLI | `main: ./opencode/stop-that-shit.mjs`、`bin: {sts}` |
| `.codexignore` | Codex | 打包忽略 |

**没有**：`.cursor/`、`.windsurf/`、OMP 独立 manifest（OMP 靠 `omp/stop-that-shit.ts` 物理入口）。

---

## 6. 对 DeepSeek Harness（DSH）的可行性评估

从本机 DSH 安装（`C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar`，18309 条目）挖出的宿主侧 API，直接对上 STS 的四条件：

| STS 要求 | DSH 对应能力 | 出处 |
|---|---|---|
| 1. 稳定 sessionId | `exec.agent.session.id` | `@deepseek-ai/dsh-tools/lib/index.js` `createExecution` |
| 2. 用户 prompt / 模式变化 | `ctx.on("agent/pre-step", async (payload, next) => ...)`，返回 `{kind:'enter', messages}` 或 `{kind:'reject'}` | `@deepseek-ai/dsh-agent-loop/lib/index.js:909` |
| 3. 能真正否决的 before-action | `ctx.on("tools/pre-execute", async (exec, next) => ...)` 返回 `{kind:'allow'\|'deny'\|'ask'\|'cancel'}`；或 `ctx.tools.guard(syncGuard)`（返回 string 即拒绝，单调不可被后续覆写） | `@deepseek-ai/dsh-tools/lib/index.js:3321` / `:3017` |
| 4. tool name / input / mutability | `exec.name` + `exec.arguments`（deepFreeze 的 JSON） | 同上 |

DSH 执行管线（`dsh-tools/README.md:109` 原文）：
> 每次调用跑固定管线：`tools/pre-execute`（可扩展 allow/deny/ask）→ 已注册的单调 guards → `tools/execute`（around-dispatch）→ `tools/post-execute`（inspect/replace/attach context）→ 定义自有的 `finalizeContent` → 只读的 `tools/result` 事件。

DSH 拒绝形状（`dsh-experimental-auto-review/lib/index.js:417`）：
```js
{ kind: "deny", reason: 'Auto review rejected tool "' + exec.name + '"; its body was not executed',
  info: { name: AUTO_REVIEW_DENIED_ERROR_NAME, code: AUTO_REVIEW_DENIED_CODE, reason } }
```

**DSH Skill 系统**（`@deepseek-ai/dsh-skill-filesystem`）：
- 扫描根：`{projectRoot}/.dsh/skills`、`{projectRoot}/.agents/skills`、`customSkillDirs`、`{dshHome}/skills`（即 `~/.dsh/skills`）、`{agentsHome}/skills`、`bundledSkillDir`
- 目录型 bundle = `<dir>/SKILL.md`；也支持根级平铺 `.md`
- frontmatter：必须首行 `---` + `name` + `description`（缺则 warn 后忽略）
- `isSkillName` 正则 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` → `stop-that-shit` ✅ 通过
- 可选字段 `whenToUse`、`metadata`（object）、`disable-model-invocation`、`user-invocable`（bool）
- **未知字段不报错**（`license` 静默保留/忽略），但旧驼峰名 `disableModelInvocation`/`modelInvocable`/`userInvocable` 会 throw

### 结论

1. **Skill 部分零改造可用**：把 `skills/stop-that-shit/`（与 `skills/stss/`）整个目录放进 `~/.dsh/skills/` 或项目 `.dsh/skills/` 即可。frontmatter 三字段全部合规，`license` 不触发校验错误，`name: stop-that-shit` 合法。**纯 markdown，不需要 Node、不需要运行时、不需要 Guard。** 唯一注意：DSH 要求 `name`+`description`，STS 两个 SKILL.md 都齐。
2. **Guard 需要写一个 DSH adapter shim**（约 150-250 行 cordis 插件），但**不必 fork 子进程**，可进程内 `require('./src/controller.cjs')` 直接调 `handleControlEvent`：
   - `ctx.on("agent/pre-step", ...)` → 从 `payload.messages` 取最近 user 文本 → `{kind:'prompt.submit', prompt}` → 把返回的 `context.text` 作为额外 message 注入
   - `ctx.on("tools/pre-execute", async (exec, next) => ...)` → 用 `exec.name` + `exec.arguments` + `exec.agent.session.id` 造 `action.before`（需写一个 DSH tool classifier 填 `mutability/affectedPaths`）→ 返回 `{kind:"deny", reason: result.message}`
   - `ctx.on("tools/post-execute", ...)` → `action.after`（生命周期），可按需追加 context
   - `subagent.start/stop` → 需再查 `dsh-tool-subagent` 的事件名（本次未展开）
   - 备选（不推荐）：`tools/pre-execute` 里 spawn 一次 `node hooks/stop-that-shit.cjs` 喂 JSON —— 每次工具调用 +50~100ms 进程启动，且与 DSH「进程内 cordis 插件」设计不合。
3. **没有"零代码"通用接线**：STS 官方没有"任何宿主只要跑一个 shell 命令"的文档化入口。`hooks/stop-that-shit.cjs` 实质上就是 stdin/stdout JSON 缝，但它只认 Claude/Codex 的字段名，不是纯 ControlEvent。接新宿主最干净的是**写 adapter 直接调 `handleControlEvent`**，或写一个小脚本把宿主事件翻成 ControlEvent 再 spawn。
4. **风险/限制（STS 自述）**：`HOST-ADAPTER-CONTRACT.md:581-598` 明说所有 adapter 都是 **guardrail 不是 sandbox**；"returned permission deny 只是 adapter 响应证据，不证明宿主最终没执行"。DSH 侧同理：`tools/pre-execute` 之外的路径（`run_code` 内嵌套调用、直接网络效应、PTC 折叠）需单独确认是否都过 hook。STS 文档也点名 Code Mode/run_code 形态覆盖不全（OpenCode V2 章节）。
5. **不改用户全局配置**：本报告全程未写 `~/.dsh` 或 `~/.claude`；只在 `D:/tmp111/` 下做 checkout 与冒烟测试。

---

## 7. 一页速查：STS 需要的宿主能力（最小集）

```
必需 4 条（官方定义，HOST-ADAPTER-CONTRACT.md:10-17）
  1. stable session identifier
  2. user prompts or explicit mode changes
  3. a before-action event that can actually deny an action
  4. tool name, input, and enough information to classify mutability

强烈建议 3 条（否则 subagent 预算/生命周期退回"不确定保留"）
  5. subagent start / stop / join 证据（至少能证明"全部结束"）
  6. 工具结果回执（tool_result / post-tool-use），用于释放 delegation 预留
  7. 权限拒绝事件（permission denied / approval resolved），用于 not_started 记账

可移植性阶梯
  A. 纯 Skill 复用（0 代码）                  ← DSH 可直接做
  B. 进程内 adapter 调 handleControlEvent（~200 行） ← DSH 推荐
  C. 外部进程 + stdin/stdout JSON             ← 通用但慢
  D. 宿主官方 adapter（需上游 PR）            ← 长期
```

---

## 8. Lead 三个追问的确认（补充核实）

### 8.1 `hooks/hooks.json` 与 `hooks/codex-hooks.json` 是否还有别的宿主事件依赖？—— **没有**

对全仓做了穷举 grep（`hooks/*`、`src/*.cjs`、`src/adapters/*.cjs`、`opencode/*.mjs`、`pi/*.ts`、`omp/*.ts`、`.hermes-plugin/__init__.py`）统计 `process.env.*`：

```
      4 process.env.PLUGIN_ROOT          # codex-hooks.json 的 node -e 里
      4 process.env.CLAUDE_PLUGIN_ROOT   # hooks.json / codex-hooks.json fallback
      1 process.env.XDG_STATE_HOME       # opencode/runtime.mjs（仅 OpenCode）
      1 process.env.STS_RUNTIME_DATA     # src/runtime-storage.cjs、scripts/sts.cjs（可选数据目录）
      1 process.env.PLUGIN_DATA          # src/state.cjs（数据目录）
      1 process.env.LOCALAPPDATA         # opencode/runtime.mjs（仅 OpenCode）
      1 process.env.CLAUDE_PLUGIN_DATA   # src/state.cjs（数据目录 fallback）
```

**与 hook 派发相关的只有 2 个环境变量**：`PLUGIN_ROOT` / `CLAUDE_PLUGIN_ROOT`（前者为空时回退后者）。两条命令都只做一件事：用 `node` 执行 `hooks/stop-that-shit-claude.cjs` 或 `hooks/stop-that-shit.cjs`。**没有任何别的宿主 API、宿主 SDK、宿主配置文件路径被引用。**

另外 INSTALL.md:40 明确写了设计意图（原文）：
> `hooks/hooks.json` stays limited to events every supported host accepts.

以及 UserPromptExpansion 的处理（INSTALL.md:37-40，原文）：
> Hosts that expose `UserPromptExpansion` may register it for earlier, pre-expansion arming; the adapter keeps that handler, but the packaged `hooks/hooks.json` stays limited to events every supported host accepts.

→ 即：**adapter 里保留了 UserPromptExpansion 处理，但打包配置刻意不注册它**，因为不是每个宿主都有该事件。这说明 STS 的 hook 配置面向"最小公共事件集"，对 DSH 这种自研宿主反而友好。

补充：`SubagentStart` 在 Claude 配置里注册了，但 Codex 侧明确不注册（INSTALL.md:87 原文）：
> This tag does not register `Stop`, `SubagentStart`, or `SubagentStop` for Codex, and does not automatically continue a finished turn.

### 8.2 「Skill-only 安装」确切步骤 + 它不提供什么

出处：`INSTALL.md:389-415`「## Optional: Skill only」原文步骤：

**Claude Code：**
```bash
mkdir -p ~/.claude/skills/stop-that-shit
cp skills/stop-that-shit/SKILL.md ~/.claude/skills/stop-that-shit/SKILL.md
```

**Codex：**
```text
$skill-installer Install stop-that-shit from https://github.com/lennney/stop-that-shit/tree/0.2.5/skills/stop-that-shit
```

**只装 STSS（Slop 版）：**
```bash
npx skills add ./skills/stss --global
```

然后（INSTALL.md:411-415 原文）：
> Start a new task so the host discovers it. Skill only needs no Hook trust and has no runtime enforcement. It is advisory, model behavior can vary, and your existing sandbox and approval settings still apply.

移除（INSTALL.md:469-478）：`Remove-Item -LiteralPath "$env:CODEX_HOME\skills\stop-that-shit" -Recurse -Force`（未设 CODEX_HOME 时默认 `$HOME\.codex\skills\stop-that-shit`）。

**它不提供什么（明确清单）：**
- ❌ 无运行时强制（`no runtime enforcement`，README_EN.md:354 原文 "A Skill-only installation has no runtime enforcement."）
- ❌ 不做任何工具调用拦截 / 无 deny / 无 approval
- ❌ 无 agent budget 计数、无 subagent 生命周期记账
- ❌ 无 hash 策略、无 dependency 策略、无 allowedPaths 越界检查
- ❌ 无 `$stop-that-shit ...` 指令的**解析**（指令解析在 `src/contracts.cjs:parseContractPrompt`，是 Guard 读 prompt 做的；Skill-only 下模型只是读到一段文本）
- ❌ 无 `sts doctor/explain/label` 的运行时事件记录
- ✅ 只提供：SKILL.md 正文的行为引导（Stop Ladder 五问 + SHIT 四类），且**自述** "This Skill is advisory and works without the Guard hooks. It cannot guarantee model behavior."

→ 对 DSH：**只是把 `skills/stop-that-shit/` 和 `skills/stss/` 两个目录放进 `~/.dsh/skills/` 或项目 `.dsh/skills/`，零代码、零 Node 依赖、无需 trust 提示。**

### 8.3 Guard 是否有除 CLI 之外的可嵌入 API？`handleControlEvent` 是否是公开契约？

**结论：是"事实上的官方接缝"，但不是 npm 公开导出契约。要用必须 vendoring 而非 `npm install`。**

证据分三层：

**(a) 官方明确指路 —— 是。**
`src/hook-policy.cjs`（370B）注释原文：
> Compatibility facade for the original module path. New host integrations should implement the ControlEvent seam instead of importing Codex Hook shapes here.

`src/controller.cjs:304` 导出：
```js
module.exports = { contractContext, handleControlEvent, runtimeCommand };
```
这是 `src/` 里唯一的对外控制入口，`hook-policy.cjs` 也是 re-export 它（`handleControlEvent` 之外的 `contractContext`）。

**(b) 有版本化的正式规范 —— 是。**
`HOST-ADAPTER-CONTRACT.md:51` 明写 "The normalized event is versioned as `ControlEvent v2`"，并给出完整 JSON schema + 四条 adapter 必要条件 + lifecycle 语义 + 兼容规则；`CHANGELOG.md:256` 记录 v1→v2 的语义分离。这是**对外发表的协议契约**。

**(c) 但不是可 `require` 的包路径 —— 不是。**
`package.json`：
```json
"private": true,
"main": "./opencode/stop-that-shit.mjs",
"exports": {
  ".": "./opencode/stop-that-shit.mjs",
  "./server": "./opencode/stop-that-shit.mjs"
}
```
- `"private": true` → **不发 npm**，没有版本化安装通道。
- `"exports"` 白名单只有 `.` 和 `./server`（且都指向 OpenCode 插件对象）→ 即便装了包，`require('stop-that-shit/src/controller.cjs')` 会被 Node 的 exports 门禁挡成 `ERR_PACKAGE_PATH_NOT_EXPORTED`。
- `"files"` 里确实含 `"src/"`，所以 **vendoring（git submodule / 直接拷 src/）是可行的**。
- 交叉验证：`grep -rn 'handleControlEvent\|controller.cjs' --include=*.md .` 只命中 `ARCHITECTURE.md:31`（"stores the current contract and applies decisions"），**HOST-ADAPTER-CONTRACT.md 全篇没有提 `controller.cjs` 或 `handleControlEvent` 这个符号名** —— 规范公开的是 ControlEvent JSON 形状，模块路径属于实现细节。

**给 DSH 的工程建议（按优先级）**：
1. **vendoring**：把 `src/`（+ 需要的 `hooks/`）拷进 DSH 插件包，`require('./vendor/stop-that-shit/src/controller.cjs')` 直接进程内调 `handleControlEvent`。零子进程、零 npm、零 exports 门禁。（实测已证明这条路可行，见 §4.4）
2. **升级策略**：若上游改 ControlEvent 版本（v2→v3），需手动 rebase；建议把 vendored 目录的 commit sha 写进插件 manifest 便于追踪。
3. **不要** `npm install stop-that-shit`（private + exports 会失败）。
4. **不要**依赖 `scripts/sts.cjs` CLI 做策略判定（它只有 `doctor/runtime/explain/label/case` 六个只读/记录命令，见 §4.7）。
