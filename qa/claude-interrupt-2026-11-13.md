# Claude Code 停止只结束这一轮：实测记录（2026-11-13）

## 为什么测

托管会话允许后台任务以后，AgentKib 的“停止”仍然结束整个 CLI 进程，后台命令、Monitor 和后台子代理一起被结束。终端里按 Esc 只结束这一轮。CLI 的 stream-json 控制协议有 `interrupt` 请求（Claude Agent SDK 的 `interrupt()` 用的就是它），这次核对：

- 无头模式下它在各种时刻（前台命令运行中、审批没回答、模型还没回复、有已加入本轮的消息）会发出哪些帧；
- 进程和后台任务是否留着，之后能否照常发送；
- AgentKib 支持的最低版本是否也有同样的行为。

## 方法

- **探针**：[`qa/probes/claude-background-turn.mjs`](probes/claude-background-turn.mjs) 新增场景 `interrupt-tool`、`interrupt-approval`、`interrupt-model`、`interrupt-steer`。真实 CLI 按托管运行器的参数启动，模型是本机回环上的模拟服务；`HOME`、`CLAUDE_CONFIG_DIR`、`TMPDIR` 在临时目录，`sandbox-exec` 只放行模拟服务的端口。不读写用户的 Claude 配置和凭据，没有真实的模型请求。
- **过程**：第一条消息让模型在后台运行一个命令（`sleep N`）。第二条消息时，模型要求在前台运行一个约 30 秒的命令（用 `perl` 计时，因为 2.1.323 会直接拒绝前台的 `sleep 30; …`，提示改用 Monitor），或者模拟服务压着不回复。主机在其间发送 `{"subtype":"interrupt"}`（`interrupt-steer` 带 `cancel_queued: true`，并在之前加入一条 `priority: "next"` 的消息），随后发第三条消息，再等后台命令结束。
- **版本**：2.1.263（托管会话的最低版本）、2.1.299（允许后台任务的最低版本）、2.1.322、2.1.323。

## 结果

| 时刻 | 2.1.263 | 2.1.299 | 2.1.323 |
| --- | --- | --- | --- |
| 前台命令运行中（约 2.5 秒，尚未报成任务） | 同右 | 见下文说明 | `control_response` success `{"still_queued":[]}` → 工具结果“The user doesn't want to proceed…” → 用户帧 `[Request interrupted by user for tool use]` → `result` `error_during_execution`（`is_error: true`）→ `command_lifecycle` `cancelled` |
| 前台命令运行约 9 秒（已报成前台任务 `task_started`，`is_backgrounded: false`） | 同右 | 未测 | 应答之后先有该任务的 `task_notification` `stopped`，其余同上 |
| 审批没有回答 | 先有 `control_cancel_request`（撤回那次 `can_use_tool`），其余同上 | 未测 | 同左 |
| 模型还没回复 | 未测 | 应答 → `[Request interrupted by user]` → `result` `error_during_execution` → `cancelled` | 同左 |
| 已加入本轮的消息还没用上，`cancel_queued: true` | 那条消息 `command_lifecycle` `cancelled`，应答 `{"still_queued":[],"cancelled":[<它的 UUID>]}`，其余同上 | 未测 | 同左 |

每种情况下：

- 进程留着，第三条消息照常开始和结束新的一轮；
- 后台命令照常运行，结束后 CLI 照常自己开始一轮；
- 被中断的前台命令进程不再存在（`pgrep` 核对）；
- 打开 `CLAUDE_CODE_SDK_READS_SESSION_STATE=1` 时，`system/session_state_changed` 依次报 `running`、`requires_action`（等待审批时）和 `idle`。

2.1.299 的前台命令场景在这个沙箱里没有走到中断：它用自动模式的分类器审这次 Bash，分类器请求打到模拟模型上失败，CLI 直接拒绝了命令（`system/permission_denied`，`decision_reason_type: "classifier"`），没有向主机要审批。“模型还没回复”的场景在 2.1.299 上完整走通，帧与其他版本相同。

## AgentKib 的做法

见 [Claude Code 托管执行](../docs/agents/claude-code-managed.md)的“后台任务 · 停止只结束这一轮”：

- 允许后台任务的进程上，停止先发 `interrupt`（带 `cancel_queued`），等这一轮的 `result` 到来，把这一轮记为取消；
- CLI 5 秒内没有这样结束、应答里 `still_queued` 不为空、或进程正在启动或更换设置时，改为结束整个进程（原来的做法）；
- 不允许后台任务的进程照旧结束进程；
- 连续自动轮次达到上限时照旧结束进程。

没有采用 `CLAUDE_CODE_SDK_READS_SESSION_STATE`：它是 SDK 专用的内部开关，现有的 `command_lifecycle`、`system/status` 和 `result` 已经足够判断轮次边界。

## 自动测试

- `apps/desktop/test/claude-interrupt.test.ts`：把上面的录制（`fixtures/claude-interrupt/`，覆盖 2.1.263、2.1.299、2.1.323）回放给运行器状态：被中断的一轮记为取消，没有原因，后台任务还在，第三条消息的一轮照常成功；CLI 自己开始的一轮也能这样停止（合成帧）；没有请求中断时，`error_during_execution` 仍按失败处理。
- `apps/desktop/test/claude-background-process.test.ts`：模拟 CLI 下，停止只发一次带 `cancel_queued` 的 `interrupt`，进程与后台进程都留着；CLI 不应答，或应答里仍有排着的消息时，结束进程和后台进程。
- `apps/desktop/test/claude-background-native.test.ts`（`AGENTKIB_CLAUDE_BACKGROUND_NATIVE=1`）：真实 CLI 在 AgentKib 的进程管理下，前台命令运行中停止（2.1.263、2.1.322、2.1.323 完整走通；2.1.299 被上述自动模式拒绝，用例提前结束），以及模型还没回复时停止（2.1.263、2.1.299、2.1.323）。停止后进程 ID 不变，后台命令还在运行，之后的消息或后台命令结束后的那一轮照常完成。

## 没有覆盖的

- 前台子代理运行中被中断：没有测；如果它没有在 `result` 之前报结束，这一轮的前台任务记录会被清掉。
- 单独停止某个后台任务（CLI 的 `stop_task`）还没有入口；要结束后台任务，可以退出 AgentKib，或等连续自动轮次达到上限。
