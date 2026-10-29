# 全 Agent 会话互通实施与 QA — 2026-09-27

## 基线与边界

- 实施目录：`/Users/user/.codex/worktrees/all-agent-continuation/agentkib`，新建的独立 managed worktree。
- 基础 revision：`057da8b81a3f3c9536a568287175af8e50c12176`，detached HEAD。本轮没有 commit、push、PR、tag、安装覆盖或发布。
- 开始时主目录有 57 个 tracked 修改及 559 个 nonignored untracked 文件，全部复制到新工作树作为输入基线。基线文件哈希位于 `/tmp/agentkib-all-agent-baseline/files.json`，另有 `tracked.patch`、`status.txt`。本轮没有在主目录实施修改。
- 版本号保留输入基线的 `0.11.0`；不能因对话曾提及 release 推断当前脏工作树已是发布源码。
- 本轮文件清单及 SHA-256：[变更清单](all-agent-continuation-2026-09-27-files.json)。清单相对复制后的输入基线，排除了原有脏改动；基线文件没有缺失。
- 工具链：Node `22.23.2`（显式 PATH）、pnpm `10.8.1`、Cargo `1.92.0`，macOS 本机。
- 不新增生产依赖，不修改 AgentKib 数据库表，不改变远程控制/鉴权协议。新增导入操作记录使用应用数据目录中的版本化 JSON 文件。

结论：代码与离线验证已实现，**本轮不满足“所有原生方向真实回复验收通过”的完成条件**。具体安装、授权、格式与既有检查阻塞如下；没有把文件交接或离线导入冒充原生互通通过。

## 实施结果

复用 `SessionDocument`，补 Hermes、Grok Build、OpenClaw（schema-23 SQLite 与无权威 SQLite 时的旧 JSONL）、固定 Cursor CLI 原生图来源；通过 Runtime 具体会话解析决定入口可用性。Cursor IDE/Agents Window 与 Antigravity Desktop/CLI 仍未标记原生目标通过。新版 OpenClaw 后续补充实施与验收见文末及专项 QA。

OpenCode/Hermes 新目标使用官方导入格式及命令；OpenClaw 新目标使用固定版本官方事务写入函数，并由官方状态锁限定为离线本地导入。Changes 审查准备文件，批准后执行目标内部写入；固定来源指纹、目标版本/模型/存储环境，先落盘尝试标记，再调用 CLI，再核对完整目标正文与身份。未知结果保留现场并查回，不自动重导入或降级。启动失败只重开已创建会话。prepared 记录回到原会话重新审查，不能通过恢复按钮跳过首次确认。

导入后的历史工具操作转换为文本摘要，工具参数/输出和附件损失在预览披露；未知必要正文损失拒绝。新目标暂不支持 AgentKib 长历史 MCP 检索，因此不静默截断长会话。后台串行执行器限制 8 个等待请求，退出拒绝排队请求，未完成的外部导入保留恢复记录。

## 实际目标版本与方向结果

完整方向矩阵见 [SESSION-INTEROPERABILITY](../docs/SESSION-INTEROPERABILITY.md)。该矩阵对所有可解析来源分别适用，未验收不计为通过。

| 目标/表面 | 证据及本轮结果 |
| --- | --- |
| OpenCode 1.18.32 | 隔离官方 CLI 导入 Rust 载荷，独立进程两次导出严格相等；通过。未安装于用户 PATH，未配置可用授权/模型，真实回复未验收。 |
| Hermes 0.21.5 / v2026.9.24 | 独立进程执行官方完整 CLI 入口 `python -m hermes_cli.main --profile default sessions import --from claude`，退出后官方 `SessionDB` 重开正文/角色及 origin 标识相等；通过。交互历史和真实回复未验收。 |
| Claude Code 2.1.282 | 现有实现保留。实际 `claude auth status --json` 在独立 CLAUDE_CONFIG_DIR 返回 exit 1、loggedIn=false、authMethod=none；没有复制凭据或反复调用模型。新增来源到此目标未做真实回复验收。 |
| Codex 0.155.1 | 实际版本超出现有原生导入门限 0.146；本轮不扩大旧版本写入承诺。新增来源到此目标真实验收阻塞。 |
| Grok Build 1.0.41 | 实际官方 binary 不认识文档中的 import 子命令；手工候选文件未被 sessions list/export 识别，权威 updates/索引格式未建立。原生目标禁用。 |
| Cursor CLI 2026.09.26-dd393fe | 官方 serializer 合成 fixture 的来源解析通过；现存 CLI 2025.09.18-7ae6800 不被当成新版格式。CLI 目标写入未验收。 |
| Cursor IDE / Agents Window 3.19.19 | 确有官方 Claude 导入及 fork 注册表流程；未建立可调用、受测的目标身份关联契约，不能用 CLI 数据库代替。 |
| Antigravity Desktop 2.12.2 / CLI 1.2.12 / ACP | 保留 ACP 来源。官方自身 Desktop→CLI 导入不证明外来历史可导入；目标禁用。 |
| OpenClaw 2026.9.6 | 后续已实现 schema-23 SQLite 来源及离线原生目标；官方写入、Gateway 重启后的列表/正文、本地 TUI 重复恢复均通过。运行中的 Gateway 不支持热导入；真实模型回复未验收，见专项 QA。 |

未执行任何真实模型轮次，模型用量为 0。只检查环境变量是否存在：常用模型 API 凭据均未设置，没有输出或保存其值。没有将旧 QA 结果计入本轮真实验收。官方实验命令、源码 revision、下载校验和细分限制见 [目标实验](interop-targets-2026-09-27.md) 与 [平台探测](interop-platform-probes-2026-09-27.md)。

## 实际命令与结果

前端命令均在上述 worktree 执行，并先设置：

```sh
export PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH
```

| 命令 | 实际结果 |
| --- | --- |
| `pnpm install --frozen-lockfile` | 通过，未升级锁文件。 |
| `pnpm --filter @agentkib/desktop protocol:generate` | 通过，同步新 sourceCapability/nativeImports RPC 名称。 |
| `cargo fmt --all -- --check` | 最终通过。 |
| `cargo test --workspace` | 执行过，失败；最初包含新增能力后旧断言不匹配，已修复。剩余既有 Runtime timing failures 见下。 |
| `cargo test --workspace -- --test-threads=2` | 继续验证，Runtime 177 通过、2 个既有超时失败。 |
| `cargo test -p agentkib-runtime -- --test-threads=1` | 177 通过、2 个既有超时失败；未削弱期限或断言。失败的 Codex 用例随负载变化。 |
| `cargo test --workspace --exclude agentkib-runtime -- --test-threads=2` | conversations 163 单测及 4 集成通过（2 官方离线用例默认忽略）；core 116、adapters 66、platform 32 等通过。遇到旧 Store Cursor 禁用断言后停止，断言已按新支持范围改为 DeepSeek Harness；Store 单独 56/56 通过。 |
| `cargo test -p agentkib-conversations native_targets --lib` | 7 通过；2 需要显式隔离安装的官方测试默认忽略，已另外执行通过。 |
| `cargo test -p agentkib-runtime native_import::tests --bin agentkib-runtime` | 最终 8/8 通过。 |
| `cargo test -p agentkib-runtime --test native_import` | 4/4 通过。来源变化、目标版本变化、批准前不导入、慢导入普通请求<1秒、部分导入/重启不重放、退出回执唯一。 |
| `cargo test -p agentkib-runtime continuation_worker::tests --bin agentkib-runtime` | 5/5 通过：顺序、1运行+8排队、队满、排队期限、退出与回执。 |
| `cargo test -p agentkib-store --lib` | 56/56 通过。 |
| `cargo test -p agentkib-tools` | 42/42 通过（补齐前次 workspace 停止后未运行的 crate）。 |
| `cargo test -p agentkib-runtime --test stdio_shutdown` | 1/1 通过，既有 Skill 退出回执不回归。 |
| `cargo clippy -p agentkib-conversations -p agentkib-platform --all-targets -- -D warnings` | 新来源/转换器及终端模块通过。 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 未通过：8 个错误均位于哈希与输入基线一致的 codex_managed 文件；本轮新增测试的 collapsible_if 已修。 |
| `pnpm typecheck` | Desktop 和 Web 均通过。 |
| `pnpm lint` | 通过，存在 warnings；没有以忽略规则消除诊断。 |
| `pnpm format:check` | 未通过，2 个与基线哈希一致的 Web 文件格式问题，见下。 |
| `pnpm --filter @agentkib/desktop exec vitest run` | 最终 829 通过、1 skipped；1 个既有约束测试失败，另有既有 node:test 文件被 Vitest 收集时报空套件。 |
| 前端互通 7 个文件定向 Vitest | 61/61 通过，包括 source A→B→A 失效、指纹传递、损失确认、prepared 重审与 unknown 只查回。 |
| `pnpm test:web` | 22 文件、203 测试通过。 |
| `pnpm build` | 最终修复后完整桌面构建通过，包含 release Runtime、Web、renderer、Electron main/preload。 |
| `pnpm build:web:hosted` | 通过。 |
| `git diff --check` | 通过。 |

构建产物位于本工作树的 `target/release/agentkib-runtime`、`apps/desktop/dist`、`apps/desktop/dist-electron`、`apps/web/dist` 与 `apps/web/dist-hosted`；未构建签名安装包，也未覆盖系统安装。

原始日志保存在 `/tmp/agentkib-all-agent-baseline/`。命令运行在脏工作树，不能只凭 HEAD 重现，需要本轮改动及已保留的输入基线。

## 既有失败与影响

- Runtime：`antigravity_runner::tests::slow_discovery_and_attachment_share_one_web_deadline` 报 ACP operation timed out；`codex_managed::tests::*` 部分 fixture 的 create 返回 `codex-version-timeout`。默认并发失败 8 个 Codex 用例，降低并发后变成不同单个用例；单线程仍有 1 个 Codex 用例及上述 Antigravity 失败。相关源/fixture 文件的 SHA-256 与本轮输入基线相同，未通过延长期限、跳过断言或修改这些功能来获取绿灯。
- Clippy：`codex_managed/completion.rs` 237/394、`state.rs` 63/101/133、`transport.rs` 80/84、`codex_managed.rs` 465。均为既有 collapsible_if、then、while-let 风格错误。
- Desktop：`scripts/stage-frpc.test.mjs` 使用 node:test，被现有 Vitest 收集为无套件；`ui-source-constraints` 指出 RemoteConnectionPanel/WebAccessSettings 的原生交互元素。三个文件均未被本轮改动；另执行 `node --test apps/desktop/scripts/stage-frpc.test.mjs` 1/1 通过，确认其实际 node:test 用例可运行。
- Format：`apps/web/src/features/catalog/catalog-copy.ts`、`session-details-dialog.tsx`，与基线哈希相同。

因此不能宣称全仓库测试、Clippy、format 全绿。新增互通链路的定向回归已独立执行；既有失败影响整体交付门槛。

## 独立审查及闭环

来源/前端、目标/执行器、平台探测分工，由非作者子代理审查公共路径。发现并修复：

1. 用户正文缺字段/null 被静默跳过：改为拒绝，补 Grok/OpenClaw 共用解析回归。
2. OpenCode 正文相同但 parentID、finish/error/summary 等行为状态改变：精确及前缀回读校验，补 mutation 测试。
3. OpenCode undo 后原文仍在导出：拒绝 `info.revert`，两个回读分支测试通过。
4. 终端继承旧 inline OpenCode 配置：拒绝 Runtime 内联值，并显式清除终端变量；只固定非秘密存储/配置路径。
5. prepared 恢复死入口：返回原来源重新审查；unknown 不自动重投。
6. Hermes resume 可能转向压缩/续接后代：同一 SQLite 快照拒绝任何父/子关联，直到实现完整 lineage 验证。保留父原文、另增子正文的回归 exact/prefix 均拒绝，独立复核 8/8 通过。
7. 额外绑定 plan 文档与 source fingerprint；导入记录限制普通文件及大小，回执重命名后同步父目录。

## 尚未完成的验收

- 新增来源×所有目标的真实单轮回复、目标交互历史界面、重启目标与 AgentKib 后的端到端恢复：未验收，原因分别见方向表。
- Hermes 官方完整 CLI 入口离线调用已补测通过；这仍不代替交互终端、真实回复或发布包安装验收。
- Windows/Linux 原生实机未验证；仓库现有 CI 已包含 workspace tests、Clippy 和构建，但本轮未 push，未触发远程 CI。
- 签名、公证、真实手机/第二台电脑、正式更新及发布不在本轮范围内。

## 新版 OpenClaw 补充实施

本节记录“继续完成”之后的增量，不把之前仅实现旧 JSONL 的阶段记成新版已通过。增量基线：`/tmp/agentkib-openclaw-sqlite-baseline/files.json`；仍使用相同 worktree，不修改主目录。

- 来源从 SQLite 原始事件读取正文，按已完成的官方投影选分支；校验 schema、归属、工作区、代际、WAL、reset 窗口和祖先完整性。压缩、冷归档、缺失外部上下文及未知版本明确拒绝。
- 目标通过 OpenClaw 自带状态锁及事务写入函数维护原生索引；已有 agent schema 23/global schema 18 才能执行，不自动升级用户数据。持久化记录继续使用现有工作流，新增 OpenClaw 字段为可选项，不破坏之前的 OpenCode/Hermes 记录。
- 新来源分页复核发现 Cursor/OpenClaw 首屏方向不符合既有“加载更早”契约；均改为最新尾页在先、后续向前翻页，页内维持原始顺序。
- 官方实际实验、隔离目录和脚本见 [OpenClaw 专项 QA](openclaw-sqlite-2026-09-27.md)。真实回复仍未执行。

补充检查结果在下方单独记录；前面的完整检查表属于初次实施阶段，不冒充补充代码已运行全套检查。

| 补充命令/检查 | 结果 |
| --- | --- |
| `cargo test -p agentkib-conversations openclaw:: --lib` | 最终 13 通过，2 官方安装用例默认忽略。 |
| OpenClaw 来源 2 个官方 fixture ignored 用例显式执行 | 2 通过；完整命令和数据目录见专项 QA。 |
| `cargo test -p agentkib-conversations --lib cursor::tests` | 分页修复后 7/7 通过。 |
| `cargo clippy -p agentkib-conversations --all-targets -- -D warnings` | 来源最终版本通过。 |
| `pnpm format:check` | 仍仅初始基线的两个 Web 文件失败，没有新增失败文件。 |
| `node --check qa/probes/openclaw-sqlite-fixtures.mjs` | 通过。 |

独立审查另复现了 `agents list --json` 的预览副作用：隔离 global schema 17 被迁移成 18。目标探测因此不能直接调用这个表面只读的 CLI 命令，必须在未知 schema 上保持原库不变；对应修复与回归记入专项 QA。曾尝试通用 prettier 检查，但项目未安装该工具，未补装，使用项目已有 `pnpm format:check`。

### 补充最终结果

代码冻结后：

| 实际命令 | 最终结果 |
| --- | --- |
| `cargo test --workspace --exclude agentkib-runtime -- --test-threads=2` | 全部通过；其中 conversations 172 单测及 4 集成通过，4 个官方安装用例默认忽略。 |
| `cargo test -p agentkib-runtime -- --test-threads=2` | 181 单测、4 个互通集成、1 个退出集成全部通过；1 个官方 OpenClaw 用例默认忽略、已显式执行通过。此次未复现前述既有 timing failures。 |
| `cargo fmt --all -- --check` | 通过。 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 仍仅上述 8 条既有 codex_managed 诊断，无新增互通代码诊断。 |
| `pnpm build` | 通过，包含 release Runtime、Web、Desktop renderer、Electron main/preload。 |
| `pnpm build:web:hosted` | 通过。 |
| `git diff --check` | 通过。 |

一次最早的整 workspace 尝试遇到正在新增的 OpenClaw 测试时间戳字面量 i32 溢出；已加 i64 并由上述最终全 crate 分批验证覆盖。没有跳过或削弱测试。

目标生产桥接也以项目 Node `22.23.2` 再次执行官方用例通过（7.93 秒；全新 `/private/tmp/agentkib-openclaw-rust-state-6`、`data-6`）。旧操作记录兼容、重复导入、追加后恢复、外部改变拒绝、旧 schema 预览不迁移均有回归证据。最终独立审查未发现剩余明确阻断问题。

本次增量没有前端生产改动，因此前端 typecheck/lint/Vitest 使用本记录前述初次全量结果；最新完整构建及 hosted 构建已重新执行。真实模型回复、其他产品的阻塞方向及 Windows/Linux 实机仍保留未验收，不因 Rust 与构建通过而改为“原生互通完整通过”。

新增日志目录：`/tmp/agentkib-openclaw-sqlite-baseline/`，含 `workspace-non-runtime.log`、`runtime-tests.log`、`source-official.log`、`cursor-tests.log`、`rustfmt.log`、`clippy.log`、`format-check.log`、`build.log`、`hosted-build.log`。
