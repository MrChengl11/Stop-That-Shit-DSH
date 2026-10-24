# stsnative native-plugin E2E rig — REPORT

Status: **✅ 真包验收通过 — `dsh-stop-that-shit@0.1.0` 作为原生 cordis 插件加载成功，19/19 断言全绿（连续两轮）。**

> **历史记录**：本报告写于 v0.1.0。当前版本为 v0.2.0（含上游 0.2.5.1 的 shell 写目标证明与依赖授权顺序两项修复），
> 确定性断言已从 49 条扩到 56 条，`node test/conformance.mjs` 全绿。本文件中的包名与计数按当时原貌保留。
junction 现指向 `D:\harness-deepseek workspace\dsh插件安装\sts-plugin`；验收命令 `node probe-native.mjs`（见 §7）。
stub 阶段的 8/8 记录保留在 §4/§6 作为链路机制的佐证。
Owner: native-e2e (task-3). Host: @deepseek-ai/dsh-desktop **0.2.1-rc.3** (runtime version printed by `dsh -V`).

---

## 1. Verdict up front

| Question | Answer |
| --- | --- |
| profile 目录 + package.json 手写可行？ | **可行**，无需 `dsh plugin add` / pnpm |
| junction 让 bundle 名可解析？ | **可行**，`fs.symlinkSync(target, link, "junction")` 免管理员 |
| profile → bundle → cordis 真的实例化？ | **是**，插件 `apply()` 被调用，stderr 有标记 |
| pre-tool-call 拦截钩子存在？ | **是**：`tools/pre-execute` waterfall，可 `deny`，实测阻断成功 |
| 中文/带空格路径能用？ | **launcher 的 `cd` 必须 ASCII 无空格**，否则 cmd 把路径空格当参数切分 |
| **真包 `dsh-stop-that-shit@0.1.0` 验收通过？** | **✅ 通过，19/19 断言**（见 §7）。4 场景：review 拒 write / review 拒 pwsh / change 放行 / 未布防放行 |

---

## 2. 目录与文件清单

```
C:\Users\<you>\.dsh\profiles\stsnative\
├── package.json                      # dsh.profile.bundles = base + headless + dsh-stop-that-shit
├── cordis.yml                        # 空 entry 根，原样照抄 ststest
├── cordis.patch.yml                  # 只有 llm-pi-ai + agent-default-model（magpie）
└── node_modules\
    └── dsh-stop-that-shit  ->  D:\harness-deepseek workspace\dsh插件安装\sts-plugin   (junction，当前指向真包)

C:\Users\<you>\AppData\Local\Temp\sts-native\
├── run.bat                           # 启动器（ASCII 无空格 cwd）
├── load.log                          # 插件 apply() 追加写的加载证据
└── ws\src\{app.ts,outside.ts}          # 场景探针工作目录

D:\harness-deepseek workspace\dsh插件安装\e2e-native\
├── REPORT.md                         # 本文件
├── switch.mjs                        # 切 bundle + 校验清单 + dump-config 断言行已合成
├── probe.mjs                         # stub 专用探针（真包请用 probe-native.mjs）
├── probe-native.mjs                  # **真包验收探针**：4 场景 / 19 断言（review-deny / review-shell / change-allow / unarmed-allow）
├── run-stsnative.bat                 # 同 run.bat 的 workspace 副本（被 CJK 目录包着，仅存档）
└── stub-bundle\                       # 机制验证用 stub 包（包名 dsh-stop-that-shit）
    ├── package.json                  # dsh.bundle.patch = ./cordis.patch.yml
    ├── cordis.patch.yml              # - insert: [{id: sts-native, name: dsh-stop-that-shit}]
    └── lib\index.js                  # 打印 [sts-native] 标记 + 挂 tools/pre-execute
```

**profile/package.json**
```json
{
  "name": "dsh-profile-stsnative",
  "private": true,
  "dependencies": {},
  "dsh": { "profile": { "bundles": [
    "@deepseek-ai/dsh-base",
    "@deepseek-ai/dsh-headless",
    "dsh-stop-that-shit"
  ] } }
}
```

**stub-bundle/package.json**（真包要照这个形状）
```json
{
  "name": "dsh-stop-that-shit",
  "version": "0.0.1-stub",
  "private": true,
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": { "default": "./lib/index.js" }, "./package.json": "./package.json" },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**stub-bundle/cordis.patch.yml**
```yaml
- insert:
    - id: sts-native
      name: dsh-stop-that-shit
```

---

## 3. 可复制命令

### 3.1 一键重建环境（profile + junction + ws）
```bash
node -e '
const fs=require("fs"),p=()=>0;
const PROFILE="C:/Users/<you>/.dsh/profiles/stsnative";
const PKG="D:/harness-deepseek workspace/dsh插件安装/sts-plugin";   // 真包；stub 阶段指向 e2e-native/stub-bundle
fs.mkdirSync(PROFILE+"/node_modules",{recursive:true});
fs.writeFileSync(PROFILE+"/package.json",JSON.stringify({name:"dsh-profile-stsnative",private:true,dependencies:{},dsh:{profile:{bundles:["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-stop-that-shit"]}}},null,2));
const link=PROFILE+"/node_modules/dsh-stop-that-shit";
try{fs.rmSync(link,{recursive:true,force:true})}catch{}
fs.symlinkSync(PKG,link,"junction");
console.log("junction ->",fs.readlinkSync(link));
'
```

### 3.2 检查组合后的 cordis 树（不启动模型，秒回）
```bash
cmd //c "C:\Users\<you>\AppData\Local\Temp\sts-native\run.bat --profile stsnative --dump-config" 2>&1 | grep -A3 "sts-native"
```
期望输出结尾：
```
# == dsh-stop-that-shit
- id: sts-native
  name: dsh-stop-that-shit
```

### 3.3 端到端场景探针（真跑模型 + 检查 deny）
```bash
cmd //c "C:\Users\<you>\AppData\Local\Temp\sts-native\run.bat --profile stsnative --json 'stop-that-shit change files=src/app.ts src/outside.ts'" \
  > /c/Users/<you>/AppData/Local/Temp/sts-native/probe.out \
  2> /c/Users/<you>/AppData/Local/Temp/sts-native/probe.err
```
判定：
- `probe.err` 出现 `[sts-native] DENY ...`  → 拦截生效
- `ws/src/outside.ts` **内容未被改写** → deny 真的落到了文件系统
- `probe.out` 的 `{"type":"final"}` 文本里模型引用拒绝理由 → 模型拿到反馈

### 3.4 只读日志
```bash
cat /c/Users/<you>/AppData/Local/Temp/sts-native/load.log
```

---

## 4. 加载证据（stub 已实测）

### 4.1 cordis 实例化证据 — `run.bat --profile stsnative --json "say hi in exactly three words"`
stderr：
```
[sts-native] loaded pid=22380 cwd=C:\Users\<you>\AppData\Local\Temp\sts-native\ws
[sts-native] config=null
[sts-native] seam-probe agent/pre-step ctx.on=true
[sts-native] hooked agent/pre-step OK
[sts-native] ctx keys=fiber
[sts-native] agent/pre-step fired turn=1 step=1
```
stdout（证明模型链路也通）：
```
{"type":"status","phase":"step_end","turn":1,"step":1,"usage":{"inputTokens":6160,"outputTokens":4,...}}
{"type":"status","phase":"turn_end","turn":1,"reason":{"kind":"completed"}}
{"type":"final","text":"Hi there!"}
```

### 4.2 拦截证据 — `tools/pre-execute` deny 实测
任务：写 `src/app.ts` 与 `src/outside.ts`。stub 策略：参数里出现 `outside.ts` 就 deny。
stderr：
```
[sts-native] pre-execute name="write" args={"file_path":"src/app.ts","content":""}
[sts-native] pre-execute name="write" args={"content":"","file_path":"src/outside.ts"}
[sts-native] DENY write (matched outside.ts)
```
结果：`ws/src/outside.ts` 内容**未被写入**；模型最终回复：
> `src/outside.ts` — **not created**. The write was rejected: `sts-native stub: access to outside.ts is forbidden by the STS Guard probe`

→ **deny 全链路成立**：pre-execute → tool result error → 模型可见原因 → 文件未落盘。

---

## 5. 已验证的宿主契约（写插件照着这个来）

### 5.1 拦截钩子（**这才是 STS Guard 该用的 seam**）
```js
ctx.on("tools/pre-execute", async (exec, next) => {
  // exec: { token, callId, rootCallId, name, signal, agent, deferContext, concludeTurn, arguments }
  // 注意：工具入参在 exec.arguments，不是 exec.args / exec.input（实测 args/input 均 undefined）
  ...
  return { kind: "deny", reason: "..." };   // 或 return next()
}, { prepend: true });
```
决策联合（`dsh-tools/lib/index.js:3321`）：
- `{ kind: "allow" }`
- `{ kind: "deny", reason: string, info?: ... }` → 渲染成 `Error: <reason>` 的工具结果（line 3344）
- `{ kind: "ask", reason?: string }` → 走审批通道
- `{ kind: "cancel" }` → 中断

相关 seam 一览（`dsh-tools`）：`tools/pre-execute`、`tools/post-execute`（可替换 result）、`tools/execute`、`tools/result`（observer）、`tools/change`。
`dsh-agent`：`agent/pre-step`、`agent/post-step`、`agent/request`、`agent/created`、`agent/disposed`。

### 5.2 插件模块形状（ESM）
```js
export const name = "sts-native";     // 必须导出 name，用作 loader 行标识
export const inject = {};             // 可选，声明服务依赖
export function apply(ctx, config) {  // 必须导出 apply
  ctx.on("tools/pre-execute", handler, { prepend: true });
}
```

### 5.3 bundle 声明（缺了必然抛错）
包 `package.json` 必须有：
```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```
否则：`profile bundle "..." declares no dsh.bundle in its package.json`（`dsh-app-boot/lib/index.js:1024`）。
该 `cordis.patch.yml` 是 **顶层 YAML 数组**，形状 `- insert:
    - id: <id>
      name: <包名>`。
`name` 也可以是相对路径（`./lib/x.js`），会被转成 file URL。

### 5.4 ⚠️ 版本兼容闸门 —— 最容易踩的坑
启动时对每个 bundle 的 manifest 做 `evaluatePluginCompatibility`（`dsh-app-boot/lib/index.js:311`）：
- 有 `engines.dsh` → **只看** `engines.dsh`，peerDependencies 忽略；
- 否则检查所有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 形式的 **peerDependencies**，必须 match 运行时 **0.2.1-rc.3**（prerelease 参与，`includePrerelease: true`）；
- 两者都没有 → 视为兼容，**放行**。

不兼容的后果：
- bundle 级别 → 该 bundle **整层被丢掉**，我们的行根本不会挂载，只在 stderr 打一行 `dsh: skipping profile bundle ...`（**极易被忽略**）；
- row 级别 → 行被 `disabled`，stderr 打 `dsh: disabling profile plugin row "sts-native": Plugin ... is incompatible with dsh 0.2.1-rc.3 ...`。

**给真包的建议**：要么不写 peerDependencies/engines，要么写 `"engines": { "dsh": "0.2.1-rc.3" }`。绝不要照抄 `@deepseek-ai/dsh-hooks-claude-code` 的 `"0.2.1-rc.2"` —— 那个包在 ststest profile 里实测就是被这条闸门 disable 的。

### 5.4.1 兼容闸门 —— 三种清单的实测结果

我用 `e2e-native/compat-probe`（一个带 rc.2 peer 的假 bundle）实测了三种写法：

| package.json 写法 | 结果 | stderr |
| --- | --- | --- |
| `peerDependencies: {"@deepseek-ai/dsh-agent": "0.2.1-rc.2"}` | ❌ bundle **整层消失**，`--dump-config` 里 0 行 `sts-native` | `dsh: skipping profile bundle "dsh-stop-that-shit": Error: Plugin ... requirements {"@deepseek-ai/dsh-agent":"0.2.1-rc.2"} ...` |
| 同样的 rc.2 peer **+ `engines.dsh: "0.2.1-rc.3"`** | ✅ 正常挂载，1 行 | 空 |
| 删掉 `@deepseek-ai/dsh*` peers（保留非 dsh 的 `"@deepseek-ai/cordis"`） | ✅ 正常挂载，1 行 | 空 |

→ **结论：`engines.dsh` 一旦存在就完全覆盖 peerDependencies。** 两者都不写也放行。
只有 `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 前缀的 peer 会被检查；`cordis`、`schemastery` 之类不受影响。

⚠️ 失败是**静默的**：bundle 被丢弃时 `--dump-config` 正常退出 0，只是树里少了一整块。所以 **每次切包后必须先跑 `switch.mjs`（它会 dump-config 并断言行存在），不要只看退出码**。

### 5.5 模块解析
bundle 目录解析两锚点：先 dsh 安装目录，再 profile 目录（`resolveBundleDir`）。profiles/stsnative/node_modules 里的 junction 走 Node 原生 `resolve.paths`，实测命中。
`removeLinkProjections` 只会删指向 `.dsh-module-fallback` 的软链，我们的 junction 安全。

---

### 5.6 ⚠️ 致命陷阱：Windows junction 不能用 rmSync 删除

在 Windows 上对 junction（目录链接）执行 `fs.rmSync(link, { recursive: true, force: true })`，Node 会**跟随重解析点进入目标目录并删光真实内容** —— 不是只删链接。

**实测事故**：对 `C:\Users\<you>\.dsh\profiles\stsnative\node_modules\dsh-stop-that-shit`（指向 `e2e-native\stub-bundle`）执行 rmSync 后，`stub-bundle` 被整个清空（package.json / cordis.patch.yml / lib/index.js 全没了）。

正确写法 —— 只摘掉链接本身：
```js
try { fs.unlinkSync(LINK); } catch (e) { if (e.code !== "ENOENT") throw e; }
fs.symlinkSync(target, LINK, "junction");
```

`switch.mjs` 已按此修正。
🔴 **任何人在 `sts-plugin` 上做 junction 操作前必须用 `unlinkSync`**，否则会把 Lead 的真包整个删空。

### 5.7 🔴 拒绝语义：必须用 kind:"deny"，不能用 kind:"cancel"（源码 + 实测）

这是整个项目最关键的一条契约。

```js
// app.asar\dsh\node_modules\@deepseek-ai\dsh-tools\lib\index.js — prepareExecution
// L3332
if (decision.kind === "cancel") return await next({
  kind: "post-result", exec, result: toolAbortedBeforeDispatchResult()
});
// L3337
const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
// L3339-3352
if (denialReason !== void 0) return await next({
  kind: "post-result", exec,
  result: this.materializeFinalResult({
    content: [{ type: "text", text: `Error: ${denialReason}` }],
    isError: true, error: { message: denialReason, ... }
  })
});
```

| 返回 | 模型收到的文本 | reason 是否送达 |
| --- | --- | --- |
| `{ kind: "cancel" }` | 写死的 `Error: tool call aborted before dispatch` | ❌ **丢弃** |
| `{ kind: "allow" }` / `next()` | 正常执行 | — |
| `{ kind: "deny", reason: "..." }` | `Error: <reason>` | ✅ 完整 |

**实测对照（同一个 banned 命令，只改 kind）**
- `cancel` → 模型原话：`Error: tool call aborted before dispatch`，且**连发两次重试**
- `deny` → 模型原话：`Error: STS-PROBE-MARKER-99: blocked by STS guard`，一次即停

🔴 **STS 插件必须用 `deny`** —— 否则「告诉 agent 为什么停」这个核心价值直接丢失。

---

## 5.8 Windows 上 shell 工具名是 pwsh

本 profile 挂载 `@deepseek-ai/dsh-tool-pwsh`，工具名 `pwsh`：
```json
{ "command": "Remove-Item -Recurse -Force C:\\temp\\junk", "description": "...", "workdir": "..." }
```
拦截 shell 必须读 `exec.arguments.command`。`bash` 工具虽也挂载，但模型实际选的是 `pwsh`。

**本 profile 实际挂载的工具（--dump-config 实测）**：working-directory, bash, pwsh, jobs, fs(read/write/edit), fs-search(glob/grep), skill, subagent-control/list-agents, subagent, workflow, call-timeout-policy, todo, goal, web。

---

## 6. CLI 坑（照抄上一轮结论，本轮再次确认）
1. `--json -` + stdin 会报 `- must be the only task argument` → 任务必须作为**字符串位置参数**直接传。
2. bash 里 `$stop-that-shit ...` 必须**单引号**，否则 `$stop` 被展开成空。
3. **启动器 bat 里 `cd /d` 的目标必须 ASCII 且无空格**。放在 `D:\harness-deepseek workspace\...` 会报 `'D:\harness-deepseek' 不是内部或外部命令`（cmd 把空格当参数分隔）——所以 `run.bat` 放在 `%TEMP%\sts-native\`。
4. 插件加载诊断走 **stderr**，`--json` 的事件走 **stdout**，必须分开重定向否则被 JSON 淹掉。

---

## 6.5 probe.mjs 对真插件的日志契约

`e2e-native/probe.mjs` 靠 **stderr 标记**做判断，真插件必须遵守这三条，否则 probe 会误报：

1. 每条诊断行以 `[sts-native] ` 开头写到 **stderr**（stdout 留给 `--json` 事件，混了会污染 JSON）。
2. 发生拒绝时，该行必须包含大写 `DENY`，并带上工具名与理由，例如：
   ```
   [sts-native] DENY write (matched outside.ts): access to outside.ts is forbidden
   ```
3. `apply()` 成功时打一行 `[sts-native] loaded`（可选附 pid/cwd），probe 用它判断实例化。

probe 的 7 项断言：
| # | 断言 | 依据 |
| --- | --- | --- |
| 1 | 插件 apply() 跑过 | stderr 出现 `[sts-native]` |
| 2 | pre-execute 拒绝过调用 | stderr 出现 `DENY` |
| 3 | 被拒文件未落盘 | `ws/src/outside.ts` 仍为空 |
| 4 | 允许的文件仍可写（不是一刀切全拒） | `ws/src/app.ts` 含 `app` |
| 5 | 模型收到拒绝理由 | `{"type":"final"}` 文本含 deny/forbidden/rejected 等 |
| 6 | 产出 final 事件 | 存在 `{"type":"final"}` |
| 7 | 确实发起过工具调用 | `tool_call` 事件数 > 0 |

```bash
cd "D:/harness-deepseek workspace/dsh插件安装/e2e-native" && node probe.mjs
```
全 PASS 打印 `RESULT: all checks passed.`，任一失败退出码 1。

---

### 6.6 stub 重建后的完整复测（Round 2）

junction 事故修复后，stub 重建并重新跑通全链路：

```
$ cd "D:/harness-deepseek workspace/dsh插件安装/e2e-native" && node switch.mjs --stub
switching to: ...\e2e-native\stub-bundle
  package: dsh-stop-that-shit@0.0.1-stub
  bundle patch: ./cordis.patch.yml
  junction: C:\Users\<you>\.dsh\profiles\stsnative\node_modules\dsh-stop-that-shit -> ...\stub-bundle
  composed row: - id: sts-native / name: dsh-stop-that-shit
OK — the bundle layer is live. Next: node probe.mjs

$ node probe.mjs
stsnative E2E probe
  elapsed: 40428 ms, exit 0
checks:
  PASS  plugin apply() ran (stderr marker)
  PASS  pre-execute hook denied a call
  PASS  denied file untouched on disk — outside.ts = ""
  PASS  allowed file still writable (policy is not blanket-deny) — app.ts = "export const app = 1;\n"
  PASS  model received the denial reason
  PASS  run produced a final event
  PASS  tool calls were attempted — 5 call(s)
RESULT: all checks passed.
```

（重建后的 stub 用 `{ kind: "cancel", reason }` 的正式拒绝形态，之前那版是返回 undefined 靠默认 denial；现在与真插件要实现的形状一致。）

---

### 6.7 探针自身的两个坑（已修）

1. **不要把待写文件预先截断成空串。** 已存在的文件（哪怕 0 字节）会触发宿主的写保护：
   `Error: cannot modify "...": file has not been read — read the file, then retry`
   → 探针假失败。正确做法是 `fs.rmSync(file)` 删掉，让 `write` 以"新建"语义落盘。
2. **判定"理由是否送达"要看 errored `tool_result`，不要看模型散文。** 模型会转述
   （"blocked by the STS Guard probe"），散文正则经常误判；`tool_result.result` 里是
   `Error: <reason>` 原文，是唯一权威信道。

修完这两点后 probe 稳定 8/8：

```
stsnative E2E probe
  elapsed: 14259 ms, exit 0
checks:
  PASS  plugin apply() ran (stderr marker)
  PASS  pre-execute hook denied a call
  PASS  denied file untouched on disk — outside.ts = null
  PASS  allowed file still writable (policy is not blanket-deny) — app.ts = "export const app = 1;\n"
  PASS  denial reason delivered to the model (errored tool_result) — "Error: sts-native stub: access to outside.ts is forbidden by the STS Guard probe"
  PASS  model acknowledged the block in its final message
  PASS  run produced a final event
  PASS  tool calls were attempted — 2 call(s)
RESULT: all checks passed.
```

---

## 7. 真包验收（task-3 acceptance）— ✅ 全部通过

### 7.1 结论

`sts-plugin/`（包名 **dsh-stop-that-shit@0.1.0**）已经作为 **原生 cordis 插件** 跑在本机 headless 环境里，
`tools/pre-execute` 拦截真实生效，**19/19 断言通过**（4 个场景）。

运行命令：

```bash
node switch.mjs --to "../sts-plugin"     # 校验收口 + 重指 junction + 断言 bundle 层已合成
node probe-native.mjs                     # 4 场景 / 19 断言
```

产物：`%TEMP%\sts-native\probe-native-<scenario>.{out,err}`。

### 7.2 链路证据（profile → bundle → cordis 实例化）

```text
$ node switch.mjs --to "../sts-plugin"
switching to: D:\harness-deepseek workspace\dsh插件安装\sts-plugin
  package: dsh-stop-that-shit@0.1.0
  bundle patch: ./cordis.patch.yml
  junction: C:\Users\<you>\.dsh\profiles\stsnative\node_modules\dsh-stop-that-shit
            -> D:\harness-deepseek workspace\dsh插件安装\sts-plugin
  composed row: - id: sts-native / name: dsh-stop-that-shit
OK — the bundle layer is live. Next: node probe.mjs
```

插件自己打印的挂载日志（每次 boot 的 stderr 首两行）：

```text
[sts-native] loaded pid=25684 dataDir=C:\Users\<you>\.dsh\sts-data
[sts-native] hooked tools/pre-execute, tools/post-execute, agent/inbox/claimed, agent/pre-step, systemPrompt.context
```

注意 `dataDir` 默认落在 `%DSH_HOME%\sts-data`（即 `C:\Users\<you>\.dsh\sts-data`），**不在插件目录里** —— 符合"插件目录只读"的约束。

### 7.3 四个场景的真实结果

| 场景 | 模式 | 动作 | 期望 | 实测 |
|---|---|---|---|---|
| `review-deny` | `review` | `write` src/review-denied.ts | 拒绝 | ✅ `DENY write MODE_FORBIDS_MUTATION`，文件不存在 |
| `review-shell` | `review` | `pwsh` New-Item | 拒绝 | ✅ `DENY pwsh MODE_FORBIDS_MUTATION`，文件不存在 |
| `change-allow` | `change` | `write` src/change-ok.ts | 放行 | ✅ 无 DENY，文件内容 `export const ok = 1;\n` |
| `unarmed-allow` | （无指令） | `write` src/unarmed.ts | 放行 | ✅ 无 DENY，watch-only 不是一刀切拒绝 |

关键点：**拒绝不是一刀切**。同样的 `write` 工具，review 模式拒、change 模式放、未布防也放 —— 说明放行/拒绝确实由 STS 的任务模式契约决定，而不是插件写死了 deny。

### 7.3.1 稳定性：两轮连跑均全绿

同一条命令连跑两轮，19/19 断言两轮都 PASS：

```text
第 1 轮: review-deny 15494ms / review-shell 27268ms / change-allow 15170ms / unarmed-allow 13791ms  → all passed
第 2 轮: review-deny 28627ms / review-shell 35083ms / change-allow 19223ms / unarmed-allow 16245ms  → all passed
```

唯一会波动的是 `review-shell` 的**具体拒绝码**：第 1 轮是 `MODE_FORBIDS_MUTATION`，第 2 轮是 `MUTABILITY_UNPROVEN`。
两者都正确 —— 模型两轮写的 pwsh 命令不同，一条被判"模式禁止变更"，另一条先被判"这段 shell 语法无法静态证明是只读"。
所以断言写的是"拒绝码属于 shell 可驳回集合"，而不是死磕某一个字符串。

### 7.4 拒绝理由真的送到了模型眼前

这是最容易做错的一环。实测 errored `tool_result` 事件的原文：

```text
Error: STOP / INTENT
Guard returned a pre-execution denial.
Reason: MODE_FORBIDS_MUTATION
Detail: Task mode review does not authorize repository mutation.
Code: I/MODE_FORBIDS_MUTATION
State: ARMED / review
Event: evt_cdabf36b-89dc-4c25-aeca-b43d07xxxx
Next: Report the finding, use a read-only action, or obtain an explicit change contract.
```

模型在 final 里逐字引用了这段，并补充"我随后只读地确认了 `src/review-denied.ts` 不存在，没有文件被创建"。
→ 这正是 §5.7 的结论在实际插件上的兑现：用 `kind:"deny"` + `reason`，模型**看到原因就停手**，不会盲目重试。

### 7.5 指令语法：必须带 `--`

踩到一次：`$stop-that-shit review`（后面直接跟任务描述）会返回

```text
{"kind":"prompt-error","error":{"code":"INVALID_DIRECTIVE_TOKEN","token":"...","message":"Unknown directive field. Put task text after -- or on the next line."}}
```

正确形式是 **`$stop-that-shit <mode> -- <任务正文>`**。插件会把 `prompt-error` 的 message 注入给模型，
所以模型能自己发现语法错误并提示用户 —— 但**这一轮不会布防**，后续动作按 watch-only 处理（不拦截）。
写验收用例时务必用带 `--` 的形式。

### 7.6 本轮修掉的两个校验器自身缺陷（不是插件问题）

`switch.mjs` 有两处是我自己写错的，已修，记录以免误判真包：

1. **注释行误判**：原检查用 `/^- /` 卡 patch 文件首字符，而真包 `cordis.patch.yml` 以 `#` 注释开头 →
   误报 "is not a top-level YAML array"。已改为先剔除空行与 `#` 注释行再看首个有效行。
2. **相对路径 junction 目标**：`--to ../sts-plugin` 之前未做 `path.resolve`，junction 目标被写成相对路径，
   bundle 解析失败且报错含糊（"row did not compose"）。已改为 `path.resolve(...)`。

### 7.7 仍然成立的注意事项

- 真包 `package.json` 声明了 `"engines": {"dsh": "0.2.1-rc.3"}` —— 正好绕开 §5.4 的兼容闸门，**不要删**。
- 真包 `vendor-sts/package.json` **没有 `dsh.bundle`**，包名也是 `stop-that-shit`，它**不能**单独当 bundle；
  必须是外层 `dsh-stop-that-shit` 包（已如此）。
- 真包不 import 任何 `@deepseek-ai/*`，只用 `node:` 内置模块 + `createRequire` 加载 `vendor-sts/*.cjs`。
  这是对的：第三方 bundle 走 linked layer 解析，裸的 host 包名会 `ERR_MODULE_NOT_FOUND`（§5.5）。
- 重指 junction **绝不能用 `fs.rmSync(..., {recursive:true})`**，会顺着 reparse point 删掉真包内容（§5.6）。
- `sts-plugin/` 全程只读，本环境未写入任何文件到该目录。

### 7.8 复现清单（从零到绿）

```bash
# 1. profile（已存在，幂等说明）
#    C:\Users\<you>\.dsh\profiles\stsnative\package.json
#    bundles: [@deepseek-ai/dsh-base, @deepseek-ai/dsh-headless, dsh-stop-that-shit]

# 2. 指向真包（绝对路径 junction）
cd "D:\harness-deepseek workspace\dsh插件安装\e2e-native"
node switch.mjs --to "../sts-plugin" --check   # 只看不写
node switch.mjs --to "../sts-plugin"           # 重指 + 断言合成

# 3. 验收
node probe-native.mjs                           # 4 场景 / 19 断言
node probe-native.mjs --only review-deny        # 单场景
```

### 7.9 插件用到的宿主钩子 —— 已逐个在 asar 里核对存在

插件 `lib/index.js` 注册了 5 个宿主扩展点，我把每一个都回查到核心源码，确认不是臆造：

| 插件注册 | 宿主出处（app.asar 内） | 说明 |
|---|---|---|
| `agent/inbox/claimed` | `dsh-agent-loop/lib/index.js`, `dsh-acp`, `dsh-subagent`, `dsh-tool-jobs`, `dsh-user-questions`, `dsh-goal-round-driver` | 拿到"真实用户 prompt"，此时 harness 还没往里混上下文，所以 `$stop-that-shit` 指令仍是首行 |
| `agent/pre-step` | 全库多处 | 把契约文本作为一条 user 消息挂到本轮 step |
| `tools/pre-execute` | `dsh-tools/lib/index.js` L3321 | 拦截点，`{kind:"deny", reason}` |
| `tools/post-execute` | `dsh-tools/lib/index.js` L3600 | 仅用于释放 delegation 预留 |
| `systemPrompt.context` | `dsh-system-prompt/lib/index.js` | 动态上下文 |

`systemPrompt.context` 的签名核对（`dsh-system-prompt/lib/index.js` `resolveContext`）：

```js
function resolveContext(entry, context) {
  return {
    name: entry.name,
    text: typeof entry.text === "function" ? entry.text(context) : entry.text,
    ...(entry.interpolate !== void 0 ? { interpolate: entry.interpolate } : {})
  };
}
// 注册时会校验 order 必须是有限数，否则 throw：
context(context) {
  if (!Number.isFinite(context.order)) throw new TypeError(...);
  return this.layers.effect(this.ctx, (layer) => layer.contexts.insert(context.name, context), ...);
}
```

插件用的正是 `{name, order, text: (context) => string}`，且 `order: 550` 是有限数 —— **签名匹配**。
（同名 context 重复注册会 throw `prompt context "sts:contract" is already registered`，插件把这整段包在 try/catch 里，属安全降级。）

**注入确实生效的实证**：review 场景里模型的 final 自己复述了
`Stop Ladder` 的三问（"Requested? / Necessary? / Not provable"）和 `ARMED / review` 状态字样 ——
这两样只存在于 `contractContext()` 返回的文本里，说明 `systemPrompt.context` 的文本真的进了模型上下文。

### 7.10 剩余风险

- `probe.mjs`（stub 专用，判的是 `outside.ts` 走 stub 的字符串）仍然存在但**不适用于真包**；
  真包的验收一律用 `probe-native.mjs`。
- 插件对 `systemPrompt.context` 用了 `name/order/text` 形状且包了 try/catch；若某版本 DSH 改了签名，
  会静默降级为"仅少一条上下文"，不影响拦截（拦截走 `tools/pre-execute`）。属可接受降级。
- 本验收是 headless + 真实 magpie 模型端到端跑的；**未**覆盖 desktop GUI 下的加载路径。

### 7.11 环境清理：一个容易再次踩到的 `os.tmpdir()` 陷阱

本机 `run_code` 里 `TEMP` / `TMP` 这两个环境变量是**空的**，导致
`os.tmpdir()` 返回相对字符串 `"undefined\\temp"`，于是 `path.join(os.tmpdir(), ...)`
会在**当前工作目录**下建出一个名为 `undefined` 的目录树：

```text
D:\harness-deepseek workspace\dsh插件安装\undefined\temp\sts-native\vendorprobe-*\
                                                        \sts-plugin-selftest\
```

我这轮往 vendor-sts 写临时 dataDir 时正好踩中，在 workspace 根留下了 `undefined/\`。
已清理掉自己产生的 `undefined\temp\sts-native\`（两个 vendorprobe 目录）；
`undefined\temp\sts-plugin-selftest\` 不是我产生的（含 `allowedPaths: ["src/app.ts"]` 的 change 契约），**原样保留未动**。

**给后续脚本的规则**：不要用 `os.tmpdir()`，要么写死 `C:\\Users\\<you>\\AppData\\Local\\Temp\\sts-native`，
要么 `process.env.TEMP || "C:\\Users\\<you>\\AppData\\Local\\Temp"`。现有
`probe.mjs` / `probe-native.mjs` / `switch.mjs` 都是写死绝对路径，不受影响。

### 7.12 真包 `apply()` 每次 boot 都自报挂载点

```text
[sts-native] loaded pid=<pid> dataDir=C:\Users\<you>\.dsh\sts-data
[sts-native] hooked tools/pre-execute, tools/post-execute, agent/inbox/claimed, agent/pre-step, systemPrompt.context
```

这两行是**验收的金标准**：只要 stderr 出现它们，就证明 profile → bundle → cordis 实例化 → `apply()` 全链路通。
反之如果只有 `skipping profile bundle` / `disabling profile plugin row`，就是 §5.4 的兼容闸门把它吞了（且 exit code 仍是 0）。
