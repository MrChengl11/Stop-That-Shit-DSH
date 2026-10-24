# 把 Stop That Shit 做成 DSH 原生插件：可行，且已经做出来了

> 结论先行：**可行，而且比走 Claude Code 兼容层干净得多。** 插件已写出并通过真机验证
> （49 条确定性断言 + 19 条端到端断言，两套全绿）。
> 交付物：[`sts-plugin/`](sts-plugin) — 包名 `dsh-stop-that-shit@0.1.0`。

> **文档状态**：本文件是 v0.1.0 阶段的设计记录，保留原貌。v0.2.0 起 `vendor-sts/` 不再是上游原文
> 冻结快照 —— 它基于上游 commit `e2660f4`，并打上了上游 0.2.5.1 的两项修复（shell 写目标证明、
> 依赖授权先于文件边界）。当前状态见 `README.md`「本次修复」与 `CHANGELOG.md` 顶条。

---

## 一、上一轮的结论要改一半

上一轮的判定是「Skill 层 100% 兼容；Guard 层不能原样装，只能靠官方桥接包 + 工具名 shim」。
前半句仍然成立，**后半句现在可以撤回**：Guard 层不需要桥接包，DSH 自己的扩展点足够承载
Stop That Shit 的全部判定逻辑。

原因很简单 —— STS 在 `HOST-ADAPTER-CONTRACT.md` 里对宿主提了四项要求，DSH 四项全有，而且
每一处都比 Claude Code 更干净：

| STS 对宿主的要求 | Claude Code 的做法 | DSH 的做法 | 谁更干净 |
| --- | --- | --- | --- |
| 稳定 session 标识 | `session_id` in hook stdin | `exec.agent.session.id` / `message` 所属 agent | 平手 |
| 干净的用户 prompt | `UserPromptSubmit` 的 prompt 字段，但 SessionStart 注入会污染 | `agent/inbox/claimed` 拿到**未被拼接过 harness 上下文**的原始消息 | **DSH 更好** |
| 能在执行前真正拒绝 | `PreToolUse` 返回 `permissionDecision: deny` | `tools/pre-execute` 返回 `{kind:"deny", reason}` | 平手 |
| 工具名 + 入参 + 可变性 | hook stdin 的 `tool_name` / `tool_input` | `exec.name` / `exec.arguments`（冻结快照） | 平手 |

上一轮踩到的三个坑，在原生插件里**两个自动消失**、一个变成可选项：

| 上一轮的坑（桥接方案） | 原生插件下 |
| --- | --- |
| SessionStart 注入污染 prompt，指令不再是首个非空行 → 整轮失效 | **不存在**。`agent/inbox/claimed` 在 harness 合并上下文之前派发，指令永远是首行 |
| 中文路径下 hook 静默不执行 | **不存在**。没有子进程、没有 `cmd` 传参，纯 in-process 调用 |
| SessionEnd / PostToolUseFailure / PermissionDenied 被桥接包丢弃 | 只用得上的一处（delegation 释放）改用 `tools/post-execute`，事件齐全 |

性能也换了一个量级：桥接方案每次工具调用 spawn 一个 node 子进程，实测 114.4 ms；
原生插件是 in-process 调用，**实测 0.717 ms/次决策**（200 次 loop 平均）。

---

## 二、插件怎么接进去的

包结构（[`sts-plugin/`](sts-plugin)）：

```
sts-plugin/
├─ package.json          dsh.bundle.patch → ./cordis.patch.yml，engines.dsh = 0.2.1-rc.3
├─ cordis.patch.yml      三行：- insert: / - id: sts-native / name: dsh-stop-that-shit
├─ lib/index.js          cordis 插件本体（335 行）
├─ lib/adapter.js        DSH 工具名 → STS action 事实（176 行）
├─ vendor-sts/           upstream 决策引擎 src/ 30 个 .cjs，MIT（0.2.0 起含 0.2.5.1 两项修复）
└─ test/conformance.mjs  确定性断言（v0.1.0 时 49 条，0.2.0 起 56 条）
```

**关键设计：判定逻辑一行没改。** `vendor-sts/src/decision.cjs` 是 upstream 的原文，
插件只做两件事——把 DSH 的工具调用翻译成 `ControlEvent v2`，再把 `deny` 翻译回去。

五个宿主接缝：

| 接缝 | 用途 |
| --- | --- |
| `agent/inbox/claimed` | 取**真用户 prompt**（`message.source.kind === "user"`），发 `prompt.submit` |
| `agent/pre-step` | 把契约/状态通知作为一条 user 消息追加到该 step |
| `tools/pre-execute` | before-action。返回 `{kind:"deny", reason}` → 模型收到 `Error: <reason>` |
| `tools/post-execute` | 只用于 `subagent` / `spawn_teammate` 结算后释放 delegation 预算 |
| `systemPrompt.context` | order 550，每次请求刷新当前契约状态，不动稳定系统提示 |

三个必须知道的实现细节：

1. **拒绝只能用 `{kind:"deny", reason}`，绝不能用 `{kind:"cancel"}`。**
   `dsh-tools/lib/index.js` 里 `cancel` 会走 `toolAbortedBeforeDispatchResult()`，reason 被丢弃，
   模型只看到写死的 `Error: tool call aborted before dispatch`，还会诱发重试。这条踩过。
2. **不要 `import` 任何 `@deepseek-ai/*` 运行时包。** 第三方 bundle 由 linked 层解析，
   profile 没 re-export 的宿主包在 bundle 自己的 `node_modules` 里找不到，直接 `ERR_MODULE_NOT_FOUND`。
   插件只用 `node:` 内建 + 内嵌的 vendor 代码。
3. **PTC 嵌套调用会天然过闸。** `run_code` 内部 dispatch 的 `tools.write` 是独立的 execution
   （`exec.parent` 有值），同样走 `tools/pre-execute`，逐个判。`run_code` 容器本身归为 `control`
   —— 它只解释脚本文本，不直接写盘。

---

## 三、验证结果

### 3.1 确定性一致性套件 — 49/49 PASS，无模型参与

`node test/conformance.mjs`：用假 cordis ctx 驱动插件真正注册的那几个 handler，
断言整张决策矩阵。

```
plugin shape ............................. 8   PASS
directive parsing ........................ 5   PASS
mutation inside the boundary is allowed .. 4   PASS
mutation outside is denied ............... 9   PASS
PTC container and delegation ............. 2   PASS
fail-open on malformed input ............. 1   PASS
review mode forbids mutation ............. 5   PASS
hash and dependency policy ............... 4   PASS
agent budget ............................. 2   PASS
watch level reports instead of denying ... 3   PASS
runtime commands ......................... 3   PASS
late directive does not arm ............... 2   PASS
plain prompt injects nothing ............. 1   PASS
RESULT: 49/49 checks passed.
```

覆盖到的拒绝码：`PATH_OUTSIDE_CONTRACT`、`WRITE_PATH_UNPROVEN`、`MODE_FORBIDS_MUTATION`、
`MUTABILITY_UNPROVEN`、`HASH_NOT_AUTHORIZED`、`DEPENDENCY_NOT_AUTHORIZED`、
`AGENT_BUDGET_EXHAUSTED`。

### 3.2 端到端 — 19/19 PASS，真 headless boot + 真模型

`e2e-native/probe-native.mjs`，profile `stsnative`，模型走本机 magpie 网关
（`opencode-go/deepseek-v4.1-flash`）。每次都是全新 boot，插件自报：

```
[sts-native] loaded pid=5752 dataDir=C:\Users\<you>\.dsh\sts-data
[sts-native] hooked tools/pre-execute, tools/post-execute, agent/inbox/claimed, agent/pre-step, systemPrompt.context
```

| 场景 | 模式 | 动作 | 结果 |
| --- | --- | --- | --- |
| review-deny | review | `write src/review-denied.ts` | DENY `MODE_FORBIDS_MUTATION`，文件未创建 |
| review-shell | review | pwsh `New-Item` | DENY `MODE_FORBIDS_MUTATION` / `MUTABILITY_UNPROVEN`，文件未创建 |
| change-allow | change | `write src/change-ok.ts` | 放行，内容正确 |
| unarmed-allow | 无指令 | `write src/unarmed.ts` | 放行（watch-only 不是一刀切拒绝） |

**最关键的一条**：同一个 `write` 工具，review 拒 / change 放 / 未布防放
—— 证明决策真的来自 STS 契约，不是写死 deny。

模型看到并逐字引用的拒绝原文：

```
Error: STOP / INTENT
Guard returned a pre-execution denial.
Reason: MODE_FORBIDS_MUTATION
Detail: Task mode review does not authorize repository mutation.
Code: I/MODE_FORBIDS_MUTATION
State: ARMED / review
Event: evt_86164452-dcb2-454a-9629-fd4c41049f4c
Next: Report the finding, use a read-only action, or obtain an explicit change contract.
```

它随后自己只读确认文件不存在并停手，**没有重试**。

### 3.3 手工补测的四个场景（headless，真模型）

| 场景 | 指令 | 实测 |
| --- | --- | --- |
| 越界写被拦后模型自证 | `change files=src/app.ts` | DENY `PATH_OUTSIDE_CONTRACT`；`outside.ts` 未创建；`app.ts` 正常写入 |
| 委派预算 | `change files=src agents=0` | DENY `AGENT_BUDGET_EXHAUSTED`（"allows 0 concurrently active subagent(s)…"）|
| 哈希闸门 | `change files=src/hashy.ts` 要求写 `createHash` | DENY `HASH_NOT_AUTHORIZED` |
| 未布防 | 无指令 | 文件正常创建，无任何 DENY 行 |

---

## 四、两个必须写进文档的语法坑（都是 upstream 行为，不是插件 bug）

1. **任务正文必须跟在 `--` 后面。**
   `$stop-that-shit review 把代码审查一遍` → `INVALID_DIRECTIVE_TOKEN`，**那一轮不布防**
   （错误会注入给模型，模型能自纠，但拦截不会生效）。
   正确：`$stop-that-shit review -- 把代码审查一遍`。

2. **level 是裸词，不是键值对。**
   `$stop-that-shit change watch files=src/app.ts` ✅
   `$stop-that-shit change files=src/app.ts level=watch` ❌ `INVALID_DIRECTIVE_TOKEN`

这两条我在自测时都踩了，已写进 [README](sts-plugin/README.md)。

---

## 五、还剩下的真实限制

- **它不是安全边界。** STS 自己就这么写（`Harness interception coverage is a guardrail, not a
  security boundary.`）。真正的边界仍然是 DSH 的 sandbox + permission preset（本机桌面版
  默认 `danger-full-access` + `never` 审批）。插件只是把"用户声明的任务边界"变成硬拦截。
- **`run_code` 里用 `node:fs` 直接写盘不经过分类器。** 容器归 `control`，脚本内部不透明。
  这是设计选择（PTC 里正常的 `tools.write` 会单独过闸），但确实是绕过面。
- **未知 shell 在 `files=` 边界下必被判 `WRITE_PATH_UNPROVEN`。** `node -e ...`、`python x.py`
  这类一律 fail closed。好处是安全，坏处是可能拦掉本可放行的动作 —— 用 `files=**` 或调 level 解决。
- **fail-open。** 任何 hook 异常只打 stderr 并放行，与 upstream 的 hook adapter 一致。
- **`vendor-sts` 基于 upstream commit `e2660f4` 的冻结快照**（0.2.0 起含 0.2.5.1 的两项修复）。upstream 升级判定逻辑时需要重新 vendor 并重打这两处。

---

## 六、怎么装到桌面版

目前只在 `stsnative` headless profile 里验证过（真机、真模型、真 boot），
**没有动用户的 `desktop` profile**。

装到桌面版：

1. 把 [`sts-plugin/`](sts-plugin) 放到 `C:\Users\<you>\.dsh\profiles\desktop\node_modules\dsh-stop-that-shit`
   （junction 也行）。
2. 桌面 profile 的 `package.json` 里 `dsh.profile.bundles` 追加 `"dsh-stop-that-shit"`。
3. 重启桌面版。

⚠️ **不要用 `fs.rmSync(path, {recursive:true})` 删那个 junction** —— Windows 上会顺着 reparse point
把真包内容删光。用 `fs.unlinkSync(link)`。

---

## 七、复现清单

```bash
# 1. 确定性套件（不需要模型、不需要 profile）
cd sts-plugin && node test/conformance.mjs        # 期望 49/49

# 2. 端到端（需要 stsnative profile + magpie 网关）
cd e2e-native
node switch.mjs --to ../sts-plugin                # 切 junction 并断言 bundle 层合成
node probe-native.mjs                             # 期望 4 场景 19 断言全 PASS
```
