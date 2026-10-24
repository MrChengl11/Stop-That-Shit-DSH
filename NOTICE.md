# NOTICE — 二次开发声明 / Derivative work notice

本仓库 **Stop-That-Shit-DSH** 是 [lennney/stop-that-shit](https://github.com/lennney/stop-that-shit) 的二次开发（derivative work），
不是上游官方项目，也未获得上游官方背书。

This repository is a **derivative work** of [lennney/stop-that-shit](https://github.com/lennney/stop-that-shit).
It is not an official upstream project and carries no upstream endorsement.

## 上游 / Upstream

| 项 | 值 |
| --- | --- |
| 仓库 | https://github.com/lennney/stop-that-shit |
| 版本 | v0.2.5 |
| 许可证 | MIT |
| 版权 | Copyright (c) 2026 Stop That Shit contributors |
| 收录位置 | `vendor-sts/`（原样拷贝，未修改） |

## 本仓库新增（二次开发部分）

| 路径 | 说明 |
| --- | --- |
| `lib/index.js` | DeepSeek Harness 插件入口，注册宿主扩展点 |
| `lib/adapter.js` | DSH 工具调用 → 上游 ControlEvent v2 的适配层 |
| `cordis.patch.yml` | DSH profile 的 cordis 补丁（insert `sts-native`） |
| `install.mjs` | 幂等安装/卸载脚本 |
| `test/conformance.mjs` | 49 条一致性断言 |
| `e2e/` | 端到端探针与报告 |
| `research/claude-code-bridge/` | 早期桥接路线探针与结论 |
| `docs/01–03` | 上游与 DSH 扩展面取证记录 |
| `docs/04–05` | 兼容性判定与原生插件设计（中文） |

## 为什么是二次开发而不是 fork 上游

上游提供的宿主适配器覆盖 Codex、Claude Code、OpenCode、Hermes Agent CLI、Pi、Oh My Pi，
**不包含 DeepSeek Harness**。上游的决策引擎与宿主解耦（ControlEvent v2 协议），
本仓库利用这一设计，只补一个宿主适配层，因此：

* 上游的判定规则、指令语法、状态机 **一行未改**；
* 上游升级时，只需替换 `vendor-sts/` 即可跟进；
* 本仓库的所有缺陷都应算在适配层，而非上游。

## 许可证

上游与本仓库均为 MIT。上游版权声明保留于 `vendor-sts/LICENSE` 与本仓库 `LICENSE`。
分发本仓库时请同时保留两份声明。
