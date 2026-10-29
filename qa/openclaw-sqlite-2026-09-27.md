# OpenClaw 2026.9.6 SQLite 实验与验收

日期：2026-09-27，macOS 本机。此记录补充全 Agent 互通 QA，不替代真实模型回复验收。

## 环境与隔离

- 工作树：`/Users/user/.codex/worktrees/all-agent-continuation/agentkib`，源码基线 `057da8b81a3f3c9536a568287175af8e50c12176`，dirty 工作区，未提交。
- 官方 npm 包：`openclaw@2026.9.6`，CLI 显示 `OpenClaw 2026.9.6 (eb377ac)`。
- 临时完整安装：`/tmp/agentkib-openclaw-probe-install/node_modules/openclaw`。
- 安装命令：`npm install --prefix /tmp/agentkib-openclaw-probe-install openclaw@2026.9.6 --omit=dev --no-audit --no-fund`。Node `v26.9.0` 满足产品自身 engines；未改变 AgentKib Node 22 工具链。
- 所有实验指定隔离的 `OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`HOME`。未读取用户会话、迁移凭据、启动或重启用户 Gateway。
- Gateway 为本机 loopback，隔离端口 19876、19877；用完已终止本次创建的具体进程。无插件、无模型消息发送。

## 官方接口和存储事实

官方包声明 agent schema **23**、global schema **18**。实际 agent 库在 `agents/main/agent/openclaw-agent.sqlite`，不是旧 `sessions/*.jsonl`。

`gateway call chat.inject` 仅追加 assistant 消息，无法保留来源 user/assistant 角色，不适合作完整导入。`sessions.create` 的 idempotency 缓存保存在进程 WeakMap，不能作为跨重启的去重依据。

固定版本适配实验调用产品自身函数，在同一事务中创建 session entry 与全部 transcript events，由官方实现维护 window、identity、generation、active projection 等表：

| 官方模块（dist）                                        | 导出别名  | 作用                                                  |
| ------------------------------------------------------- | --------- | ----------------------------------------------------- |
| `openclaw-agent-db-CaQAStOA.mjs`                        | `f`       | `runOpenClawAgentWriteTransaction`                    |
| `session-accessor.sqlite-entry-store-DTntRuil.mjs`      | `f`       | `writeSessionEntry`                                   |
| `session-accessor.sqlite-transcript-store-CFksbmAY.mjs` | `u` / `m` | `replaceSqliteTranscriptEventsInTransaction` / header |
| `session-accessor.sqlite-read-DG0i0-yW.mjs`             | `l`       | 全部原始事件回读                                      |
| `session-accessor.sqlite-active-events-Cnt-hBim.mjs`    | `l`       | 官方当前可见历史回读 oracle                           |
| `embedded-state-lock-Cw9nQxv5.mjs`                      | `t`       | 官方 embedded lifecycle/state 锁                      |

这里是固定版本私有模块适配，不宣称官方提供稳定的跨 Agent 导入 API。

## 实际实验结果

1. **官方 writer → Gateway list/history：通过。** 合成会话 key `agent:main:agentkib:55d149a5-226d-4ed7-b1ed-47dff3ac2c31`，user/assistant 两条消息包含 `AKIB-SQLITE-7a30e09` 与项目决定 `SQLite WAL`。Gateway 启动后 `sessions.list` 返回独立会话，`chat.history` 返回同样的两条正文与角色。
2. **活跃 Gateway 外部写入：不可直接支持。** Gateway 运行期间创建第二个 key，新的 CLI 连接调用 `sessions.list` 仍只返回旧会话；按新 key 调 `chat.history` 返回 `UNAVAILABLE: session changed while reading history; reload the conversation`。不能仅靠 SQLite 成功写入宣称现有 Gateway 已认识新会话，也不能靠固定睡眠解决。
3. **Gateway 完整重启：通过。** 仅停止并重启本次隔离 Gateway，`sessions.list` 返回两个会话，第二个 key 的 `chat.history` 返回两条完整消息。第一条合成记录保留。
4. **官方生命周期锁：通过。** 有活跃隔离 Gateway 时，`acquireEmbeddedStateLock` 拒绝；独立无 Gateway 状态下正常取得并释放锁。该函数持有官方 gateway lifecycle coordinator 与 state/config 锁，防止写入期间 Gateway 同时启动。`timeoutMs: 0` 在此版本会直接跳过文件锁尝试，实验使用 `1000`。设置 `allowInTests: true`，避免 `NODE_ENV=test` 静默绕过锁。
5. **TUI 本地恢复：通过。** 在真实 PTY 执行 `openclaw tui --local --session agent:main:agentkib:a11a0000-0000-4000-8000-000000000001`，显示完整用户和助手历史，状态 `local ready | idle`。历史助手只有 role/content/timestamp，没有伪造 model/api/provider 字段。未传 `--message`，不自动触发模型。
6. **重复恢复：通过。** 正常退出 TUI 后，以相同命令再打开，再次显示同样历史。前后比较全部五条合成会话的身份与 19 条原始事件哈希，无新增会话、无改写消息、无历史工具执行。
7. **`agents list --json` 不能视为纯只读：已复现。** 在独立 `/tmp/agentkib-openclaw-readonly-probe` 中，将 global 库的 `user_version` 与 `schema_meta` 标为 17，然后只运行 `agents list --json`；命令成功返回，同时日志提示 `state database schema migration pending; verifying integrity first`，两处版本均被改为 18。库 SHA256 从 `9e1ff797af5766f3594ecbbc7a399a3e6fe0dd3725d90d4da2ef982e9398a1e6` 变为 `b65aed86ff8639868a84f5ae714e3e06d4e7c1c9747ec0ffd2f56a40301c9fdb`。生产预览不能未经状态预审直接调用该命令；目标适配器已取消该 CLI 调用，改用下一项的只读路径，并在读取 inventory 前检查真实 global 库版本。
8. **纯只读 inventory 替代：通过。** 官方 `io.runtime-hPN4FOBi.mjs` 的 `readConfigFileSnapshot({observe:false,skipPluginValidation:true})` 配合 `agents.config-G5R7b0ly.mjs` 的 `buildAgentSummaries(snapshot.config)` 能返回相同 workspace/agentDir。global schema 17 在调用后仍为 17，SHA256 前后均为 `ebae660a40163a2b27acc03c5e5a050988ee5191d18d7bf25ef0170cb8aceb17`。另在仅有 config 的全新隔离 state 调用，未创建 global/agent 数据库。

Gateway 命令（在上述隔离环境变量下执行）：

```sh
node "$OPENCLAW_PACKAGE/openclaw.mjs" gateway run --port 19876
node "$OPENCLAW_PACKAGE/openclaw.mjs" gateway call sessions.list --json --params '{}'
node "$OPENCLAW_PACKAGE/openclaw.mjs" gateway call chat.history --json --params '{"sessionKey":"agent:main:agentkib:55d149a5-226d-4ed7-b1ed-47dff3ac2c31","limit":100}'
node "$OPENCLAW_PACKAGE/openclaw.mjs" tui --local --session agent:main:agentkib:a11a0000-0000-4000-8000-000000000001
```

第二个 Gateway 用 `OPENCLAW_GATEWAY_PORT=19877` 匹配启动端口；直接 `--url` 在 auth:none 下会要求显式凭据，不适合该隔离测试配置。

本轮离线证据：`/tmp/agentkib-openclaw-gateway-list.json`、`gateway-history.json`、`gateway-active-list.json`、`gateway-active-history.json`、`gateway-restarted-list.json`、`gateway-restarted-history.json`（这些文件均以 `agentkib-openclaw-` 为前缀）。无模型调用，模型与 token 用量记为“不适用”，不是零用量真实回复通过。

## 可重复生成的官方 fixture

仓库脚本：`qa/probes/openclaw-sqlite-fixtures.mjs`。必须传入全新的状态目录，已有目录直接拒绝，避免覆盖数据。

```sh
node qa/probes/openclaw-sqlite-fixtures.mjs \
  /tmp/agentkib-openclaw-probe-install/node_modules/openclaw \
  /tmp/agentkib-openclaw-source-fixtures-v3
```

实际生成路径：`/tmp/agentkib-openclaw-source-fixtures-v3/agents/main/agent/openclaw-agent.sqlite`。同目录根 `expected.json` 包含原始事件以及官方 `readSessionTranscriptMessageEvents` 输出，后者作为分支及 reset 的比较 oracle。

- ordinary：普通 user/assistant。
- branch：side append 和 leaf 控制；官方可见结果只保留所选回答。
- compaction：原文保留，摘要作为元数据，不将摘要冒充来源原文。
- reset：官方可见结果排除之前窗口。
- compressed：约 110 KB 合成文本；实际产生 1 条 `event_zstd`，证明新库压缩路径存在。

## 验收边界

已证明固定版本原生存储写入、产品回读、进程重启和本地 TUI 恢复可行。**未完成真实模型单轮回复验收，不能标注完整“原生互通通过”。** 新版本、生产 Gateway 热导入、Windows/Linux 实机不在本记录通过范围。

运行中的 Gateway 必须由用户在产品侧正常停止后才能使用此离线导入策略；AgentKib 不得擅自重启用户 Gateway。未知版本、路径归属不符、旧 schema 或锁冲突必须拒绝写入。

## AgentKib 生产路径与回归

来源官方 fixture 由主代理在最终版本再次执行并保存日志 `/tmp/agentkib-openclaw-sqlite-baseline/source-official.log`：

```sh
AGENTKIB_TEST_OPENCLAW_FIXTURES=/tmp/agentkib-openclaw-source-fixtures-v3 \
AGENTKIB_TEST_OPENCLAW_STATE=/tmp/agentkib-openclaw-native-state \
AGENTKIB_TEST_OPENCLAW_EXPECTED=/tmp/agentkib-openclaw-writer-result.json \
cargo test -p agentkib-conversations openclaw::sqlite::tests::reads_official -- --ignored
```

结果：2/2 通过。普通单测 `cargo test -p agentkib-conversations openclaw:: --lib` 为 13 通过、2 默认忽略。

目标作者使用生产 Rust renderer、context、bridge、run/verify 执行：

```sh
AGENTKIB_TEST_OPENCLAW_PACKAGE=/tmp/agentkib-openclaw-probe-install/node_modules/openclaw \
AGENTKIB_BENCHMARK_DATA_DIR=/private/tmp/agentkib-openclaw-rust-data-5 \
OPENCLAW_STATE_DIR=/private/tmp/agentkib-openclaw-rust-state-5 \
OPENCLAW_CONFIG_PATH=/private/tmp/agentkib-openclaw-rust-state-5/openclaw.json \
cargo test -p agentkib-runtime --bin agentkib-runtime \
  official_openclaw_import_reopen_and_conflicts -- --ignored --nocapture
```

结果：通过，8.92 秒。覆盖预览前后两库主文件不变、旧 global schema 17 拒绝且不迁移、官方写入及独立进程回读、重复 key 不覆盖、正常追加后前缀恢复、reset/上下文排除/代际改写/正文外改/未知 schema 拒绝。每次测试要求全新隔离状态目录，重跑需换新路径。

独立非作者子代理复核了官方源代码和最终适配器：上述发现均已关闭，未发现剩余明确阻断问题；这不代替真实模型回复验收。全量构建与既有失败见总 QA 的补充记录。

同一生产 Rust 目标用例使用项目 Node `22.23.2` 复测通过（7.93 秒），将上面 state/data 路径的 `-5` 改为 `-6`，命令前设置 `PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH`。
