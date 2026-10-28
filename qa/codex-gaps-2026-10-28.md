# Codex 接入补齐（2026-10-28）

分支 `feat/codex-gaps`，基于 `main` 的 `4e4f8a6b2`。补齐上一轮 Codex 接入分析找出的缺口：失败与重试、Plan、附件、MCP 请求、手动压缩、`/` 菜单、后台终端，以及最低版本上的待发队列，并加上 CI 协议检查。行为与规则见 [Codex 托管执行](../docs/CODEX-MANAGED.md)。

| 提交 | 内容 |
| --- | --- |
| `eacb67fcc` | 失败的轮次显示 Codex 的错误并保持可发送，重试时显示进度 |
| `fbcf078a1` | 托管会话开放 Plan；历史去掉 `<proposed_plan>` 标签 |
| `d964736f8` | 托管会话开放附件，附件按钮说明不可用原因 |
| `ce2613e8a` | MCP 工具审批与 MCP 请求显示为审批，其他服务端请求不再让轮次卡住 |
| `eae67bd64` | 上下文用量里的“压缩上下文”接到 `thread/compact/start` |
| `f0e192103` | Codex 会话的 `/` 菜单，AgentKib 代为执行能对应的命令 |
| `4ebb9ef8f` | `/stop` 结束后台终端（`thread/backgroundTerminals/clean`） |
| `a5d2c03bd` | 没有 `thread/queue` 的 CLI（0.147.0）不开放待发队列 |
| `ff5c8994b` | CI：检查 Codex app-server 协议与 AgentKib 依赖的方法和字段 |
| `168639768` | 运行中追加指令或加入队列时，Codex 命令也不作为文字发出 |

本轮没有调用模型，也没有使用真实账号或 API key。CLI 行为来自真实 CLI 对本地桩的离线运行：Responses API 桩和一个 MCP 桩只监听 `127.0.0.1`；`codex app-server --stdio` 在只放行 localhost 的 `sandbox-exec` 里运行，`CODEX_HOME` 是只配置了桩 provider 的临时目录，`HOME` 是空目录，用假 key，工作区是临时 Git 仓库。版本为 Homebrew 的 0.163.0，以及从 npm 装到临时目录的 0.163.0 与 0.147.0。

## 发现的问题

修复前在 0.163.0 上观察到：

- 失败的轮次依次收到 `error`（`willRetry:true`，“Reconnecting... 1/2”）若干条、`thread/status/changed{systemError}`、`error`（`willRetry:false`）和 `turn/completed{status:"failed", error}`。AgentKib 收到 `systemError` 就把会话记为 `codex-thread-error`，`turn/completed` 不清除，发送不可用约 1 分钟，直到 runner 回收，界面没有说明；重试和错误文字都不显示。按 0.163.0 的 `thread_status.rs`，`systemError` 只是“上一轮出错”的空闲标志，下一轮开始时清除。
- 非只读 MCP 工具的审批就是 `mcpServer/elicitation/request`：`_meta.codex_approval_kind` 为 `mcp_tool_call`，`persist` 为 `["session","always"]`，表单为空。AgentKib 不处理，轮次停在等待输入，每个这样的工具调用都会卡住。
- Plan 实际不可用：`planVerified` 从未置为 true（TypeScript 迁移时丢了 Rust 版按版本开放的条件）；设置检查按 `entry.id` 找预设，而 `collaborationMode/list` 的行只有 `mode`。
- 附件能力固定为 `native-operation-not-integrated`，文档却写着支持。
- `/compact` 等斜杠命令作为文字交给模型；手动压缩没有接 `thread/compact/start`。
- 原生记录里 Plan 回复带 `<proposed_plan>` 标签，历史原样显示。
- 自查时发现：`/` 菜单最初只在发送时判断 Codex 命令，运行中选“追加指令”或“加入队列”会把 `/compact`、`/stop` 这样的文字交给模型，排队的还会多出一轮。`168639768` 改为三种操作都先判断，与 Claude 会话一致。
- `review/start` 返回的轮次 ID 与 `turn/started` 里的不同，项目和 `turn/completed` 用前者。照现有状态机接入会停在运行中，所以本轮不接 `/review`。
- CI 检查器发现 0.147.0（写入锁要求的最低版本）没有 `thread/queue/*`，0.148.0 才有，而队列按钮照常开放。真实 CLI 上，0.147.0 对 `thread/queue/list` 回 -32600 “Invalid request: unknown variant `thread/queue/list`”，连接保持；0.163.0 对已加载的线程回空队列，对未加载的线程回 -32603 “no rollout found”，所以探测放在 thread/resume 之后。

## 真实 CLI 核对

经 AgentKib 后端（临时测试，未提交）驱动 0.163.0：

- 失败与重试：桩回 500、401 时，实时状态依次报告重试（`apiRetry`，次数取自 “Reconnecting... n/2”），轮次以 Codex 的错误文字结束，之后可以发送。
- Plan：选择 Plan 后发送，`thread/settings/updated` 确认 `plan`，计划作为 `plan` 项显示。
- MCP：允许后工具执行；拒绝后工具结果为 “user rejected MCP tool call”，轮次继续。
- 附件：图片作为 `localImage` 发出，桩收到 `input_image` 的 data URL。

用 JSON-RPC 脚本直接驱动：

- 压缩：`thread/compact/start` 先回 `{}`，随后开始新的轮次，依次是 contextCompaction 开始与完成、长线程提示、`turn/completed`。
- 后台终端：`thread/backgroundTerminals/list` 与 `clean` 在空线程上可用。
- Plan 与 Default 的切换：0.163.0 与 0.147.0 的 `collaborationMode/list` 都列出这两个预设；Plan 轮次的 `thread/settings/updated` 为 `plan` 并产生 `plan` 项，下一轮切回 Default 同样得到确认。0.147.0 的 `ThreadResumeResponse` 没有 `collaborationMode`，恢复后模式在下一轮之前显示为未确认。
- `thread/queue/list` 在两个版本上的回答见上。

协议检查脚本用 `--cli` 指定本机的两个二进制运行：0.147.0 按 `required` 通过，0.163.0 按全部契约通过；0.147.0 按全部契约报出 7 处缺口（`thread/queue/*` 五个方法、`ThreadQueueAddParams`、`ThreadResumeResponse.collaborationMode`）。

## 验证

- 新增或更新的测试：
  - 实时状态与历史：重试的次数、HTTP 状态与说明，有输出或最终错误时清除；`systemError` 后可以发送；错误行带 `cli_output` 和 `turn_meta`，实时、hydrate 与原生记录得到同一行。
  - Plan：只有同时列出 plan 与 default 才开放；按 `mode` 匹配；历史去掉标签。
  - 附件：能力与发送一致；附件按钮说明不可用的原因。
  - MCP：工具审批的允许、拒绝、取消与“本会话内允许”；只能拒绝的类型；不属于当前轮次的请求回 `decline`；其他服务端请求回 -32601。
  - 压缩：等到压缩轮次开始才返回；运行中不可用；用量对话框的按钮在 Codex 会话里可用的条件。
  - `/` 菜单：命令判定（别名、参数，`/private/tmp` 这样的路径不算命令）；两端输入区执行、打开界面、保留草稿并说明原因；运行中追加指令与加入队列不执行也不发出命令。
  - `/stop`：调用 `thread/backgroundTerminals/clean`，按发送权限授权。
  - 队列：按 0.147.0 的回答关闭队列能力，控制与读取都拒绝，不发 `thread/queue/add`；启动探测时 CLI 退出则启动失败、不发轮次（Plan 探测同样）。
  - CI 脚本：缺口的固定标签、最低版本只查 `required`、版本参数、沙箱与环境变量、二进制查找、工作流的触发与权限。路径比较用 `path.join` 与 `realpath`，读工作流前去掉 CRLF，因为这些测试也在 Linux 与 Windows 的辅助任务里运行。
- 变异检查共 38 处，37 处被发现。没被发现的是“runner 尚未探测时按缺少队列处理”：能力查询只在 runner 已连接时走到这里，已连接的 runner 都已探测；唯一的例外是启动失败、正在关闭的 runner，这时其他条件已经关闭队列，所以是等价变异。“启动探测时 CLI 退出不再抛出”起初没被发现，补了测试后被发现。
- 全量（`ff5c8994b` 的代码）：后端、桌面、Web 类型检查，`format:check`、所有改动文件的 `oxfmt --check`、`git diff --check` 通过；`oxlint` 警告数与基线相同（276）；`.github/scripts` 的测试 103 项，68 项通过、35 项在 macOS 上跳过；测试分片检查通过；Web 74 个文件 1635 项通过；后端构建通过，桌面 `desktop` 项目 434 个文件中 433 个通过、1 个跳过（8635 项通过、3 项跳过），`filesystem` 与 `mcp-latency` 18 个文件 453 项通过。`168639768` 之后重跑了三处类型检查、`format:check`、改动文件的 `oxfmt --check`、`git diff --check`、`oxlint`（仍为 276）与两端会话界面的测试（桌面 `src/features/sessions`、`src/features/workspace` 89 个文件 1491 项，Web `src/features/conversation`、`src/features/sessions` 58 个文件 1230 项），全部通过。

## 未验证

- 没有用真实账号或真实模型核对。错误文字和重试次数来自桩回 500、401 时 CLI 的输出。
- 0.147.0 只核对了 Plan 与队列的协议行为，没有经 AgentKib 后端跑完整流程。
- 没有截图核对新的显示（错误行、重试提示、MCP 审批、`/` 菜单），只在 jsdom 里核对了 DOM。桌面的 `managed-turn-notice.tsx` 与 Web 版只差导入，组件测试只在 Web。
- CI 工作流还没有在 GitHub 上运行；本机没有重跑其中从 npm 安装 CLI 的一步。
- 暂不支持：`/review`、`!命令`（`thread/shellCommand`）、MCP 表单与 URL 请求（只能拒绝）、MCP 工具的“始终允许”。
