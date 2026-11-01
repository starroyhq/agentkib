# 手机上看会话是否在运行

日期：2026-11-01。桌面分支 `feat/external-turn-status`，基于 v0.24.3（`78cc7ea83`）。手机改动在 Flutter 仓库 `feat/redesign-p8` 的 `256b877`，只在本地提交。

## 范围

手机上看不出电脑上的会话是否正在运行。这次做了三件事：

1. 手机显示电脑报告的状态：会话列表的行、工作区分组标题、待处理页的“进行中”、会话页的状态条。
2. 在这台电脑上安装 Claude Code 连接终端插件。
3. 桌面后端识别 Codex 应用或 CLI 正在跑的一轮，只用于显示。
4. 桌面和 Web 的会话列表显示和手机一样的状态。

旧的 Codex follower 桥接没有重新启用。

## 桌面后端

新模块 `packages/backend/src/codex-external-turns.ts`：

- 只看 `CODEX_HOME/thread-writer-locks/` 里有锁文件的线程，在 Codex 的 `state_*.sqlite` 里查它们的 rollout 路径。
- 同时满足下面几条才算一轮正在运行：
  - 写锁被持有。只有锁，说明线程只是开着。
  - rollout 里最后开始的一轮（`task_started`）之后，没有这一轮的 `task_complete` 或 `turn_aborted`。只有这一条，可能是客户端在一轮中途退出了。
  - 锁文件不比这一轮新。
  - rollout 6 小时内写过。
- 压缩成 `.zst` 的 rollout 属于空闲线程，直接算不在运行。
- 只看最后开始的一轮，是因为分支和子代理线程的 rollout 开头带着父线程没有结束的轮次。本机 rollout 里一轮未结束又开始另一轮的情况有 19 处，都是这样。
- 锁文件比这一轮新，说明线程是在这一轮开始之后才被现在的客户端打开的，开始这一轮的客户端已经退出。依据是 Codex 的 `codex-rs/rollout/src/writer_lock.rs`：锁文件从不写入，释放时删除，新进程第一次取锁时删掉无人持有的旧文件。
- 每条 rollout 第一次只从末尾往回读，最多 8 MiB，之后只读新增的部分。这 8 MiB 里没有轮次事件时，改用新版 Codex 自己维护的 `thread_history_*.sqlite`（`thread_turns` 和 `thread_history_projection_state`），它的检查点必须落在读过的这一段里才算。本机 1714 轮里有 53 轮超过 8 MiB，最大 218 MB。
- 探测写锁用 AgentKib 已有的 `existingFileLeaseBusy`，每条线程最多 5 秒一次，而且只在 rollout 显示这一轮还没结束时才探测。

`web-read.ts`：

- 目录给 Codex 会话加 `externalTurn: { status: "running", startedAt }`。托管记录按原生 ID 对应，索引会话按索引 ID 对应，别名归到它的托管记录。AgentKib 自己的 runner 持有的线程不算，有 runner 的会话也不加。读目录不会创建索引用的盐。
- live 状态在 `ownershipReason` 为 `codex-owner-busy` 时带 `externalTurn`，其他时候为 `null`。
- `continuation`、发送、分支和占用判断都没有改。

目录每 2 秒由全局会话流读一次，内容变化时推送 `catalog-invalidated`，所以手机最多晚约 2 秒看到变化。

文档：`docs/CODEX-MANAGED.md`、`docs/REMOTE-CODEX-WEB.md`、`docs/CONVERSATIONS.md`。

## 桌面和 Web 的列表

规则在 `packages/session-ui` 的 `sessionContinuationListState`，桌面侧栏、桌面概览、桌面工作区会话列表、Web 目录和 Web 首页的最近会话共用，结果和手机一致：

- 等待你：`continuation` 为 `awaiting-approval` 或 `waiting-input`，琥珀色圆点。
- 一轮正在运行：`continuation` 为 `running` 或 `starting`，或有 `externalTurn`。圆点换成转动的圆环，减少动态效果时不转。悬停和读屏写出在哪里运行：在 AgentKib 中运行、在终端中运行、在 Codex 中运行。
- 终端：连接终端里空闲的 Claude Code，灰色圆点，和以前一样。
- 仅可查看：和以前一样。
- 不显示：只在别处打开、结果待核对、已归档的会话，以及 AgentKib 的后台进程空闲驻留。最后这一条是改变：以前侧栏对驻留的进程也显示“在 AgentKib 中运行”，现在只在真的有一轮在跑时显示。会话页里的“在 AgentKib 中运行”没有改。

桌面侧栏和 Web 目录的分组标题在会话数前显示在等和运行中的数量，各带圆点或圆环，收起时仍显示；悬停和读屏读作“2 个在等你, 3 个运行中”。Web 目录里一条会话同时被主机报告在等、又被页面标记为待处理时，只显示琥珀色圆点，不再另加“●”。

文档：`docs/UI-TERMINOLOGY.md` 的术语表和列表规则，`docs/REMOTE-CODEX-WEB.md`。

## 手机

- 模型：`SessionSummary.continuation`、`SessionSummary.externalTurn`，`LiveState.executionLocation`、`ownershipReason`、`externalTurn`。
- `sessionActivity` 决定列表上的状态，优先顺序是：等待你，运行中，终端，不显示。
  - 等待你：`pendingInteraction`，目录 `continuation` 为 `awaiting-approval` 或 `waiting-input`，或待处理页读实时状态时看到的审批和提问。
  - 运行中：`continuation` 为 `running` 或 `starting`，或有 `externalTurn`。详情行开头写“在 Codex 中”或“在终端中”。
  - 终端：连接终端里空闲的 Claude Code。
  - 不显示：只在别处打开、AgentKib 的进程空闲驻留、结果待核对、已归档、缓存目录。空闲驻留的 runner 不算运行中，桌面和 Web 现在也一样。
- 工作区分组标题在名称后显示“N 个在等你”“N 个运行中”，放不下时换到第二行，收起时仍显示。
- 待处理页在“需要你处理”之后加“进行中”，列出目录报告正在运行的会话。目录报告在等的会话优先关注，不再算作“检查”。
- 会话页状态条：
  - 被 Codex 应用占用：“正在 Codex 中使用 · 完全退出 Codex 后可在这里继续”。
  - 那边正在跑一轮：“在 Codex 中运行”。
  - 连接终端的 Claude Code 空闲时：“在终端中运行 · 已连接”。
  - Claude Code 被 AgentKib 之外的进程占用时，同样显示“正在 Claude Code 中使用”。
- 标题搜索的结果行用同一套状态。四种语言都有文案，`docs/FEATURE_MATRIX.md` 已更新。

## Claude Code 插件

`claude plugin list` 显示 `agentkib-bridge@agentkib-local`，版本 0.4.0，来自 `/Applications/AgentKib.app/Contents/Resources/claude-bridge`，用户范围，已启用。旧配置备份在 `/tmp/akb-plugin-backup/`。安装时没有正在运行的 Claude Code。已经开着的终端要执行 `/reload-plugins`，新开的终端会自动连接。没有实际连一次终端验证。

## 检查

一次性测试验证后已删除，没有提交。

桌面（`apps/desktop/test` 里的临时文件）：

- 模块 6 项：
  - 锁和未结束的一轮同时存在才算运行，一轮结束后不算；写到一半的行等写完再算；客户端退出后不算。
  - 未持有的锁文件不算；锁文件比这一轮新时不算，比这一轮旧时算。
  - rollout 超过 6 小时没写入、压缩、移走都不算；移回来后重新查到。
  - 分支线程只看最后开始的一轮，冷启动读取和增量读取结论一致，没有轮次 ID 时按顺序配对。
  - 轮次事件跨 64 KiB 块边界、长行跨三个块、事件在文件第一行时都能读到。
  - 超过 8 MiB 的一轮用 Codex 的轮次记录补上，检查点落在读过的范围之外时不用。
- 目录和 live 2 项：
  - 索引会话在 Codex 里运行时目录带 `externalTurn`，live 带 `codex-owner-busy`、`external` 和同一个 `externalTurn`。只开着没运行的会话 live 为 `null`、目录不带。一轮结束后目录不再带。
  - 有托管记录时标在托管记录上，被隐藏的别名不出现。
- 变异检查：分别去掉跨块拼接、锁文件新旧比较、只认最后一轮、Codex 轮次记录、6 小时限制，每一处都有对应的测试失败。改回后文件与原来一致。
- 本机只读核对（`~/.codex`，Codex CLI 0.163.0）：13 个锁文件里，`.coordination.lock` 被正确略过。只有一条线程判为运行中，开始时间是 `2026-11-01T11:18:17.628Z`，和 Codex 自己 `thread_turns` 里唯一的 `inProgress` 一致，其余 11 条都是 `completed`。第一次 73 ms，之后 0.4 ms。

自动化：

- 桌面全量：469 个文件，9299 项通过，13 项失败，3 项跳过，其中包括上面 9 项临时测试。失败都在 `claude-auto-continue`、`claude-managed-parity`、`claude-web-backend-integration`、`history-search-worker` 里，是超时，或 1 秒内没等到启动的子进程。当时手机仓库的分析在同时运行。这 4 个文件单独重跑：163 项通过，1 项跳过。
- 类型检查：backend、desktop、web 通过。oxfmt 通过；oxlint 没有错误，只有 `use-session-controller.ts` 里原有的警告。
- 手机：`flutter analyze` 没有问题；`flutter test` 697 项通过、1 项跳过，含 14 项临时测试，其余 683 项和改动前相同。
- 手机临时测试包括：
  - 各种状态的优先顺序；
  - 行和分组标题（收起后仍显示，在已归档里不显示）；
  - 320 宽、1.8 倍字号下四种语言的分组标题不溢出；
  - 待处理的关注顺序和“进行中”；
  - 状态条的五种情况。
- 手机渲染检查：会话列表、收起的分组、待处理页和状态条，中文，浅色和深色各一张，内容都是合成数据，人工看过。第一次渲染时，“在 Codex 中运行”的标签在行里被截断，于是改成标签只写“运行中”，地点放在详情行开头。
- 桌面和 Web 列表：
  - 临时测试：四种语言下各种状态的结果、分组计数和读法；桌面侧栏各行的圆点和圆环、收起后标题仍读出数量、概览写出状态；Web 目录的行、标题读法、收起后仍在、和页面待处理标记不重复。通过后删除。
  - 原有测试有两处按新行为修改：桌面 `SessionDirectory.test.tsx` 和 Web `session-catalog.test.tsx` 原来断言运行中的圆点是 `bg-primary`，现在断言它是转动的圆环。
  - 改之前，桌面 `src/features/sessions`、`src/features/workspace`、`src/features/home` 和 Web 全量各有 4 项失败，都是这处断言。删掉临时测试后重跑：桌面这三个目录 102 个文件 1601 项全过，Web 全量 77 个文件 1676 项全过。中间一次只跑 `src/features/catalog` 时，`session-catalog-loading` 有一项超时，单独重跑和全量里都通过。
  - 类型检查 backend、desktop、web 通过；格式和 oxlint 通过，只有原有的警告。
  - 桌面和 Web 的列表只经过组件测试，没有在真实界面上看过。

## 未覆盖

- 新后端没有装进真实的 AgentKib 桌面，也没有在手机上看过真实数据。需要先发布桌面新版本。
- 只验证了 Codex CLI 0.163.0。没有 `thread_history_*.sqlite` 的旧版 Codex，在 AgentKib 启动时已经写了超过 8 MiB 的一轮，要等下一轮开始才显示。
- 一个 Codex 进程崩溃时，另一个早已在运行的 Codex 进程随后打开同一条线程，残留的锁文件比这一轮旧，这一轮会一直显示为运行中，最长 6 小时。
- 一轮连续 6 小时没有写入任何内容（比如等一条很长的命令）时，会显示为不在运行。
- 不根据会话记录推测 AgentKib 之外的 Claude Code 是否在运行；没有通过插件连接的终端看不到状态。
- 没有新增提交的测试，上面的行为目前没有回归测试保护。
- 手机界面只经过组件测试和渲染检查，没有在真机上操作过。

## 清理

临时测试文件已删除。本机核对只读了 `~/.codex`，写锁探测只是加锁后立即释放，没有改动 Codex 的文件。
