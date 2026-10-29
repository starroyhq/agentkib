# 会话互通平台探测：Cursor、Antigravity、OpenClaw

日期：2026-09-27。源码基线：`057da8b81a3f3c9536a568287175af8e50c12176`。

工作目录：`/Users/user/.codex/worktrees/all-agent-continuation/agentkib`。本记录对应该基线之上的未提交互通改动，不代表已发布版本。测试安装和原始程序包仅位于 `/tmp/agentkib-interop-probes`，未升级或覆盖原安装；未读取真实用户会话、数据库或凭据。本文仅记录此子任务实际完成的探测和测试，全仓库验收由主 QA 记录汇总。

## 版本与证据

| 产品表面 | 核对版本 | 取得方式 | 原生目标验收 |
| --- | --- | --- | --- |
| Cursor 已安装 CLI | `2025.09.18-7ae6800` | `~/.local/bin/cursor-agent --version/--help`，只读程序包 | 未验收 |
| Cursor 隔离 CLI | `2026.09.26-dd393fe` | 官方安装脚本公布的 macOS arm64 包，解压至独立临时目录 | 未验收 |
| Cursor IDE / Agents Window | `3.19.19`，commit `6496ea8a068aebfcd21990e70ff522e9abf10c80` | `/Applications/Cursor.app` 中 package、product 和已发布 JS，只读 | 未验收 |
| Antigravity Desktop | `2.12.2` | `/Applications/Antigravity.app/Contents/Info.plist` | 未验收 |
| Antigravity 隔离 CLI | `1.2.12` | 官方 manifest 下载地址，独立解压后执行 `--version/--help` | 未验收 |
| OpenClaw 发布包 | `2026.9.6` | npm 注册表精确版本包，独立解压并核对源码 | 未运行 Gateway，未验收 |

下载校验：

- Cursor tar.gz SHA-256：`538827d96a779bab854a865c8e42859e8e87db34b5f69770261b90fc8cfff191`。
- OpenClaw tgz SHA-256：`1a7355691bc0e605222ba818f1f72c1787253c78dfeb0df6be2086ec73b71e63`。
- Antigravity tar.gz SHA-512：`92bcd4d1976b570d6f053a1b5716e2f2962c22ca3cf7657a3fcb66b05b0f5523fa2d6f1899f157c09b66abda2c2f81938101ad7cd31845e1eda8f277addc2b8e`，与官方下载 manifest 完全一致。

## Cursor 来源实现

新增 `CursorProvider` 从 CLI 原生 `chats/<workspace-md5>/<chat-id>/store.db` 读取，不采用 `agent-transcripts` 引用导出，也不接触 IDE 的 `state.vscdb`。

程序包核对结果：

- CLI 配置目录依次使用 `CURSOR_CONFIG_DIR`、`XDG_CONFIG_HOME/cursor`、`~/.cursor`。
- `store.db` 的 SQLite `user_version` 为 1；`meta` 的 `0` 行是 hex 编码 JSON，包含 `latestRootBlobId`；`blobs` 用 SHA-256 内容地址保存原生 protobuf。
- 新版 `ConversationStateStructure.turns` 为字段 8，`previous_workspace_uris` 为字段 9。按 root→turn→user/step 的真实记录解析，保持源消息顺序。
- `agent-transcripts` 是二次生成的 citation 文件：工具结果与关联 ID 不完整，reasoning 可合并到 text，工作区路径经过有碰撞的 slug 化。因此不将它当成完整原生历史。

适配行为：

- 保留普通用户/助手正文；推理块单独计入 `ReasoningExcluded`，不会混入正文。
- 工具步骤、shell turn、selected context 暂不转换，明确返回需要确认的内容损失。
- 原生回读采用只读 SQLite 事务，校验 blob 地址及长度，限定单块、累计字节数、扫描数和 protobuf 字段数。正文缺失、非法 UTF-8、缺 blob、哈希不符、未知 wire/oneof、未知数据库版本均拒绝，不自动用摘要或显示文本替代。
- 仅凭实际 workspace URI 归属发现会话。旧版本缺少该信息的记录不猜测归属；扫描标记不完整。
- 当前暂不导入 compacted/summary archive 历史，返回明确不支持；不得据此宣称长历史互通完成。压缩、加密或非内容寻址存储不在已验证格式内。
- Cursor CLI 来源支持不等于 Cursor IDE/Agents Window 来源或目标支持；目标写入保持关闭。

合成 fixture 由隔离官方 `2026.09.26-dd393fe` 程序包中的 protobuf serializer 生成（跳过 CLI 主入口），包含随机任务标记、用户消息、助手消息及独立 reasoning。没有从真实用户历史取样，也没有复制专有运行时进仓库。原始 serializer 输出保存在 `crates/agentkib-conversations/tests/fixtures/cursor-cli-2026-09-26.json`。

实际验证命令：

```sh
cargo test -p agentkib-conversations cursor::tests -- --nocapture
cargo clippy -p agentkib-conversations --lib -- -D warnings
rustfmt --edition 2024 crates/agentkib-conversations/src/cursor.rs
```

结果：7 项 Cursor 测试通过；Clippy 通过。覆盖原始正文及顺序、推理排除、只读文件不变、分页根指纹过期、工作区隔离、缺 blob、坏哈希、未知版本、截断 wire、符号链接和 compacted history 拒绝。

未验证：真实模型回复、官方目标会话恢复、用户既有历史覆盖率、Windows/Linux 实机。此结果只证明已验证原生格式的来源解析，不将任一 Cursor 原生互通方向标记为端到端通过。

## Cursor 目标与不同界面

`2025.09.18-7ae6800` 和 `2026.09.26-dd393fe` 的 CLI 帮助均提供 create/resume，没有外来会话导入命令。最新版 CLI 新增功能很多，仍不能从命令帮助推导存在通用历史写入接口。[Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)

Cursor `3.19.19` 的 `workbench.glass.main.js` 确实包含截图中的 Claude Code 导入功能；源码还有 `glass.claudeCodeSessionRegistry.v1`、来源路径/mtime 和后续 fork 到 local composer 的关联记录。这是 Agents Window 内的服务与注册表流程，不能把复制 Claude JSONL 到 CLI blob DB 当作等价实现。IDE 的会话结构另有 `composerData:` 等记录，未完成可回读、重启恢复及最小回复验证。

结论：普通 CLI 原生图来源已实现；Cursor 目标端、Agents Window 和 IDE 原生来源仍未验收。阻塞是未建立这些产品表面的受测导入/身份关联契约，不是宣称官方产品没有界面导入功能。

## Antigravity 目标

官方当前文档明确支持在 `/resume` picker 中选择 Desktop 会话，确认后复制到 CLI。它没有承诺导入其他 Agent 的任意记录。[官方 resume 文档](https://www.antigravity.google/docs/cli/commands/resume/)

独立包 `1.2.12` 的 `--help` 提供 `--conversation` 恢复、`--continue`、`--print`、`--input-format stream-json` 等参数，没有外来历史导入命令。stream-json 输入按行运行新提示，不能用来把历史工具轨迹安全恢复为原生历史。[官方 headless 文档](https://www.antigravity.google/docs/cli/headless/)

Desktop `2.12.2` 包内只有 `language_server` 和 `webm_encoder` 等二进制；其应用版本不等于独立 CLI 的版本。已有 AgentKib ACP 来源继续复用，不能因新版 Desktop→CLI 产品能力而自动宣称外来历史可写。

结论：Desktop→CLI 是有官方依据的产品内能力；外来 SessionDocument→Antigravity 的安全原生导入仍缺少经验证的入口和可恢复身份，不开放目标端。未请求模型回复、未登录、未迁移系统 keyring 凭据。

## OpenClaw 目标

以 npm `openclaw@2026.9.6` 实际发布代码核对：当前权威会话已在每 Agent 的 `openclaw-agent.sqlite`，不能继续只写旧 `sessions.json`/JSONL。[官方会话管理](https://docs.openclaw.ai/session)

发布包中的 `openclaw-agent-board-schema-*.mjs` 明确规定 `session_nodes.entry_json` 是逻辑会话权威记录，`session_windows` 与子表拥有 transcript generation。其他相关契约包括 `entry_valid` 校验触发器、`session_key_contract`、`transcript_events`、重写水位和 active transcript 投影。导入只写正文行会遗漏这些不变量。

官方 `doctor --session-sqlite import` 属于旧 OpenClaw 状态迁移，并要求停止 Gateway；它还管理迁移清单、备份和归档。普通 `doctor --fix` 的影响面更广，不能作为 AgentKib 单会话导入命令直接调用。[官方迁移说明](https://docs.openclaw.ai/gateway/doctor/state-and-sessions)

结论：源码格式可以继续研究固定版本适配，但本次未建立“单独创建新会话→权威校验通过→Gateway 恢复→真实回复”的完整实验；目标保持未验收。不会通过伪造旧 JSONL 让已有 Gateway 自动迁移，也不修改用户数据库或启动用户 Gateway。

## 后续新版 OpenClaw 补充

本记录保留初次探测结论。后续已进一步验证 schema-23 官方事务写入、Gateway 重启及本地 TUI 恢复，并实现来源/目标适配，详见 [专项 QA](openclaw-sqlite-2026-09-27.md) 与[当前能力矩阵](../docs/SESSION-INTEROPERABILITY.md)。初次“未验证”不代表后续仍禁用。
