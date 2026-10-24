# Stop That Shit × DeepSeek Harness 兼容性报告

> 结论先行：**分两层看——纯 Skill 100% 兼容，零改造；Guard（运行时拦截）不能原样装，但通过 DSH 官方 Claude Code 桥接包 + 一层约 50 行的工具名 shim，已在真机端到端跑通。**

被测对象：`lennney/stop-that-shit` v0.2.5；本机 DSH `@deepseek-ai/dsh-desktop` 0.2.1-rc.2（Windows，Electron 桌面版）。

---

## 一、STS 是什么（决定兼容性判定的关键结构）

STS 是 **Skill + Guard** 双组件，官方支持 6 个宿主：Codex、Claude Code、OpenCode、Hermes Agent CLI、Pi、Oh My Pi。DSH 不在其中。

| 组件 | 载体 | 依赖宿主能力 | DSH 兼容性 |
|---|---|---|---|
| **Skill** | `skills/stop-that-shit/SKILL.md`、`skills/stss/SKILL.md` | 无（纯 markdown，frontmatter 仅 name/description/license） | ✅ 直接可用 |
| **Guard** | `hooks/hooks.json` + `src/controller.cjs` 等 | 4 项：稳定 session id、prompt 事件、**可真正 deny 的 before-action 事件**、工具名+入参 | ⚠️ 需接线 |

STS 自己声明（HOST-ADAPTER-CONTRACT.md:596）：*"returned permission deny 只证明 adapter 响应，不证明宿主最终没执行"*；且 *"执行与沙箱由宿主负责，STS 只管任务边界"*。**它不是沙箱，是护栏。**

---

## 二、Skill 层：零改造可用（已实测）

用 DSH 真实的 `FileSystemSkillProvider` 加载 STS 的 `skills/` 目录：

```
stop-that-shit [custom] user=true model=true
stss           [custom] user=true model=true
warnings: (none)
```

- DSH 技能格式要求：`<name>/SKILL.md`，frontmatter 必须有 name + description；STS 完全符合（多出的 `license` 作为未知键被忽略）。
- 正文可直接注入：stop-that-shit 7954 字节、stss 4342 字节。
- **安装方式**（两种任选）：
  - 项目级：`<project>/.dsh/skills/stop-that-shit/SKILL.md`（优先级 100）
  - 用户级：`~/.dsh/skills/stop-that-shit/SKILL.md`（优先级 400）
- 限制：纯 Skill 是 **advisory**（只有规则文本，无运行时拦截、无 deny、无 agent 预算、无 `$stop-that-shit` 指令解析）。

---

## 三、Guard 层：不能原样装，但有官方桥

### 3.1 为什么不能原样装

DSH 里**没有** Claude Code / Codex / OpenCode 的 hook 插件兼容层（在 asar 内 306 个 `@deepseek-ai/*` 包里扫描 `PreToolUse`、`CLAUDE_PLUGIN_ROOT`、`codex-hooks`、`hooks.json` → 全部 0 命中）。STS 的 `hooks.json` 与 `src/adapters/*` 无法直接加载。

STS 的 `package.json` 是 `"private": true` 且 exports 只白名单 `"."` 与 `"./server"`，npm 装不了内部模块 → 必须 vendoring（拷 `src/` 进程内 require）。

### 3.2 DSH 官方桥接包（关键发现）

`@deepseek-ai/dsh-hooks-claude-code` —— **npm 上真实存在**（34 个版本），其中 **0.2.1-rc.2 的 9 个 peerDependencies 与本机版本精确对齐**。

事件映射：

| Claude Code 事件 | DSH 扩展点 | 语义 |
|---|---|---|
| SessionStart | `agent/created` (emit) | 仅观察，context 走 agent.inject() |
| UserPromptSubmit | `agent/pre-step` (waterfall) | deny → PreStepDecision.reject |
| **PreToolUse** | `tools/pre-execute` (waterfall) | **deny → 真拦截，工具根本不执行** |
| PostToolUse | `tools/post-execute` | 结果后处理 |
| Stop | `agent/turn-stopping` | 可踢回再走一步 |
| SubagentStart | `subagent/start` | 仅观察 |

DSH 侧 deny 的落地（`dsh-tools/lib/index.js` 原文）：
```js
const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
// denialReason !== undefined → materializeFinalResult({content:[{type:"text",text:`Error: ${denialReason}`}], isError:true})
// 并直接 next({kind:"post-result"}) 跳过 dispatch
```
→ **deny 时工具根本不会执行**，模型看到的是 `Error: <reason>`。

### 3.3 数据通路已实测打通（真机）

桥接包构造的 payload（实测从 shim 落盘的原样 JSON）：

```json
{"session_id":"session-...","transcript_path":"","hook_event_name":"PreToolUse",
 "tool_name":"write","tool_input":{"file_path":"...","content":"..."},
 "tool_use_id":"call_00_...","cwd":"..."}
```

STS 需要的 5 个字段（session_id / tool_name / tool_input / tool_use_id / cwd）**全部都有**。

### 3.4 但是：raw 模式会大面积误杀（必须加 shim）

STS 的 Cl仪包分类器只认 Claude 工具名（Read/Write/Edit/Bash/Glob/Grep/Agent…），DSH 的工具名是小写。实测未加映射时：

| DSH 工具 | raw 模式结果 |
|---|---|
| read / edit / write | ✅ allow（恰好被 Codex 名字正则命中 READ_NAME/WRITE_NAME） |
| **glob / grep / pwsh / ops_bash / run_code / subagent / spawn_teammate / todo_write** | ❌ **全部 DENY，Reason: WRITE_PATH_UNPROVEN** |

→ 连只读的 `glob`、`git status` 都被杀掉，实际不可用。

**加一层工具名映射 shim 后（约 50 行 Node，非侵入）**：

| 场景 | 结果 |
|---|---|
| `$stop-that-shit change files=src/app.ts` + write src/app.ts | ✅ 允许，文件创建 |
| 同一 turn 内 write src/outside.ts | ❌ **DENY PATH_OUTSIDE_CONTRACT，文件未创建** |
| `$stop-that-shit review` + write | ❌ **DENY MODE_FORBIDS_MUTATION** |
| read / glob / grep / pwsh / git status | ✅ 允许 |

模型看到的原文（真机 transcript）：
```
Error: STOP / SCOPE
Guard returned permission deny.
Reason: PATH_OUTSIDE_CONTRACT
Detail: The action writes outside the declared file boundary: src/outside.ts.
Code: S/PATH_OUTSIDE_CONTRACT
State: ARMED / change
Next: Keep the write inside files=..., or obtain a new explicit file boundary.
```
且 `ls src` 确认 outside.ts **确实不存在** —— 拦截是真的。

---

## 四、已知缺口与坑（全部实测）

1. **3 个事件被静默丢弃**：STS 的 hooks.json 注册 8 个事件，桥接包只支持 7 个且只解析 SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/SubagentStart/SubagentStop。**SessionEnd / PostToolUseFailure / PermissionDenied 完全不告警地丢掉**（影响 agent 预算释放、失败观察，不影响核心拦截）。

2. **SessionStart 注入会污染下一轮 prompt，导致指令失效**：DSH 会把上一轮注入的 additionalContext 拼到下一轮 prompt 前面，而 STS 要求 `$stop-that-shit` 必须位于**第一个非空行**（`contracts.cjs:32` 的正则 `^(?:[ \t]*\r?\n)* {0,3}\$...`）。实测：一旦注入，改为 `DIRECTIVE_NOT_ARMED` 警告，模式退回 watch-only，拦截全部失效。
   - **解法 A**：不注册 SessionStart（推荐，实测可用）。
   - **解法 B**：shim 里把 prompt 重新锚定到**最后一个** `$stop-that-shit` 出现位置（注意要用最后一个，用第一个会切掉正确指令）。

3. **PostToolUse 的 tool_response 被拍平成纯文本**，STS 读不到结构化 status → deleg ation 预算释放会漏。

4. **PreToolUse 的 allow 不能预批准**（DSH 本来就默认放行，无实际影响）；`updatedInput`、`additionalContext`、`systemMessage` 被忽略（只 warn）。

5. **性能**：每次工具调用 spawn 一次 node 子进程，实测 **平均 114.4 ms/次**（武装状态下）。

6. **中文路径会静默失败**：hook 命令里含中文字符时（实测 `D:\harness-deepseek workspace\dsh插件安装`）hook **完全不执行**，STS 静默不生效。**必须用纯 ASCII 路径**。

7. **headless 默认 workspace-write 会挡住 hook 子进程的落盘副作用**（桌面版默认 danger-full-access，无此问题）。

8. **升级风险**：桥接包是 rc 版且 peer 全是精确 pin（`0.2.1-rc.2`）；`dsh-hook-protocol` **不在 asar 内**，必须显式安装（profile 的 pnpm-workspace.yaml 是 `autoInstallPeers: false`）。

---

## 五、桌面版可执行安装步骤

### 路线 1：只要 Skill（5 分钟，推荐先试）

```powershell
# 用户级（所有项目生效）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills\stop-that-shit"
Copy-Item "stop-that-shit\skills\stop-that-shit\SKILL.md" "$env:USERPROFILE\.dsh\skills\stop-that-shit\SKILL.md"

# 可选：同时装 stss（减少防御性免责话术）
New-Item -ItemType Directory -Force "$env:USERPROFILE\.dsh\skills\stss"
Copy-Item "stop-that-shit\skills\stss\SKILL.md" "$env:USERPROFILE\.dsh\skills\stss\SKILL.md"
```
重启会话后生效（DSH 有 chokidar 热监听，也许无需重启）。**无运行时拦截**，只是规则注入。

### 路线 2：Skill + Guard（完整拦截）

1. 把 STS 仓库拷到**纯 ASCII 路径**（如 `C:\sts\stop-that-shit`）。
2. 装桥接包（桌面 profile 需先退出 DSH 桌面应用）：
   ```
   dsh plugin --profile desktop add @deepseek-ai/dsh-hooks-claude-code@0.2.1-rc.2 @deepseek-ai/dsh-hook-protocol@0.2.1-rc.2
   ```
3. 写 shim（工具名映射 + prompt 重锚定，约 50 行，见附录）。
4. 在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 追加：
   ```yaml
   - insert:
       - id: sts-claude-hooks
         name: "@deepseek-ai/dsh-hooks-claude-code"
         config:
           configPath: "C:/Users/<you>/.dsh/profiles/desktop/sts-hooks.json"
           pluginRoot: "C:/sts/stop-that-shit"
           projectDir: "C:/your/project"
           defaultTimeoutMs: 15000
   ```
5. `sts-hooks.json` = STS 的 `hooks/hooks.json` 去掉 SessionStart 事件、把每条 command 改成 `node "C:/sts/sts-shim.cjs"`。
6. 重启 DSH。技能调用 `$stop-that-shit review|change files=... -- 任务`。

**注意**：`$stop-that-shit` 必须**独占首行**，任务正文放 `--` 之后。写错会返回 `{"decision":"block","reason":"Unknown directive field..."}`。

### 路线 3：写原生 DSH adapter（工作量大但零桥接依赖）

STS 官方指路的接缝是 `src/controller.cjs` 的 `handleControlEvent(rawEvent, options)`（ControlEvent v2）。写一个 cordis 插件，注册 `ctx.on("tools/pre-execute")`，把 DSH 的 exec 转成 ControlEvent v2 喂进去，返回 `{kind:"deny", reason}`。
Lead 已做出可工作原型（`lead-sts/dsh-adapter.cjs`，导出 classifyTool/toControlEvent/preExecuteGate），实测 read→allow、越界 write→deny PATH_OUTSIDE_CONTRACT、subagent→deny UNBOUNDED_DELEGATION、review 模式 write→deny MODE_FORBIDS_MUTATION。
坑：`action.mutability` 合法值只有 `read|write|delegate|control|unknown`；把 sessionId/cwd 漏传会导致全部 allow。

---

## 六、最终判定

| 维度 | 判定 |
|---|---|
| Skill 层 | ✅ **完全兼容**，零改造 |
| Guard 层（原样装） | ❌ **不兼容**（无 Claude/Codex hook 兼容层） |
| Guard 层（经官方桥接包 + shim） | ✅ **可用**，已真机端到端验证 |
| Guard 层（原生 adapter） | ✅ 可行，需自写 ~300 行 |
| 安全性声明 | ⚠️ STS 自述 "guardrail, not a security boundary"；DSH 的 sandbox/permission 才是边界 |
| 稳定性 | ⚠️ 桥接包 rc 版、精确 pin、每次调用 spawn 子进程；升级需 rebase |

**推荐路径**：先装 Skill（零风险、立即收益）；需要硬拦截再加 Guard（接受 shim 维护成本 + 中文路径限制）。

---

## 附录：shim 参考实现（工具名映射 + prompt 重锚定）

```js
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MAP = {
  read: 'Read', read_image: 'Read', ops_inspect_local_file: 'Read', ops_result: 'Read',
  write: 'Write', write_file: 'Write', edit: 'Edit', str_replace_editor: 'Edit',
  glob: 'Glob', ops_glob: 'Glob', grep: 'Grep', ops_grep: 'Grep', list_agents: 'ListAgents',
  bash: 'Bash', ops_bash: 'Bash', pwsh: 'PowerShell', terminal_send: 'Bash',
  terminal_open: 'Bash', terminal_read: 'Read', terminal_list: 'Read',
  web_fetch: 'WebFetch', web_search: 'WebSearch', skill: 'Skill', todo_write: 'TodoWrite',
  ask_user_question: 'AskUserQuestion',
  subagent: 'Agent', subagent_fork: 'Agent', spawn_teammate: 'Agent',
  send_message: 'SendMessage', interrupt_agent: 'SendMessage',
  schedule_create: 'ScheduleWakeup', schedule_update: 'ScheduleWakeup',
  run_code: 'ToolSearch', working_directory: 'Bash',
};

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => {
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  if (input.tool_name && MAP[input.tool_name]) input.tool_name = MAP[input.tool_name];
  // DSH 把上一轮注入的 context 拼到 prompt 前面；STS 要求指令在首个非空行
  if (input.hook_event_name === 'UserPromptSubmit' && typeof input.prompt === 'string') {
    const re = /\$(?:stop-that-shit:)?stop-that-shit(?=$|[\s,:])/gi;
    let m, idx = -1;
    while ((m = re.exec(input.prompt)) !== null) idx = m.index;   // 取最后一个
    if (idx > 0) input.prompt = input.prompt.slice(idx);
  }
  try {
    process.stdout.write(execFileSync(process.execPath,
      [path.join(__dirname, 'stop-that-shit', 'hooks', 'stop-that-shit-claude.cjs')],
      { input: JSON.stringify(input), timeout: 8000, encoding: 'utf8' }));
  } catch { /* fail open */ }
});
```
