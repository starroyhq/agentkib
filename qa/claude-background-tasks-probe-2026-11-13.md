# Claude Code 后台任务与自发轮次：实测记录（2026-11-13）

## 为什么测

托管的 Claude Code 会话原来在启动时设置 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`。模型因此不能把命令放到后台，托管会话里没法像终端里那样在后台等 CI 或跑长命令。这次放开了它（见 [Claude Code 托管执行](../docs/agents/claude-code-managed.md)的“后台任务”），放开之前先确认两件此前没有用真实 CLI 验证过的事：

- 无头模式下，后台命令结束后 CLI 会不会自己开始一轮；
- 这时出现哪些帧，能不能和主机发起的轮次分开。

## 方法

- **CLI**：真实的 Claude Code 2.1.322，macOS（Darwin 27.0.0）；后来补测了从 npm 装的 2.1.263 与 2.1.299（见“补测”）。
- **启动参数**：和托管运行器相同：`--session-id=<UUID> --print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompts host --permission-prompt-tool stdio`，另加 `--model claude-sonnet-4-6`。
- **主机一侧**：由探针 [`qa/probes/claude-background-turn.mjs`](probes/claude-background-turn.mjs) 扮演：发 `initialize`，收到响应后发用户帧，对 `can_use_tool` 一律允许，逐帧记录标准输出。
- **模型**：本机回环上的模拟服务，按固定脚本回复。第一次回复要求用 Bash 后台执行 `sleep N; echo bg-done`（`run_in_background: true`），之后只回一句文字。
- **隔离**：`HOME`、`CLAUDE_CONFIG_DIR`、`TMPDIR` 都在临时目录；`sandbox-exec` 禁止除模拟服务端口以外的网络。不读写用户的 Claude 配置和凭据，没有真实的模型请求。

运行：

```sh
node qa/probes/claude-background-turn.mjs <新的运行目录> <claude 可执行文件> [enabled|disabled] [后台秒数] [首个 result 后等待秒数] [plain|send-while-running|finish-during-turn|tool-in-self-turn|two-tasks|two-tasks-apart]
```

## 结果

| 场景 | 结果 |
| --- | --- |
| 不设禁用变量 | Bash 工具的参数里有 `run_in_background` |
| 设了禁用变量（现在的托管会话） | Bash 工具的参数里没有 `run_in_background`。模型仍然传它时，工具返回 `InputValidationError: … An unexpected parameter run_in_background was provided`，命令不执行 |
| 发起后台命令 | 工具结果立即返回（“Command running in background with ID …”），本轮照常以 `result` 结束 |
| 后台命令结束时会话空闲 | CLI 自己开始一轮并以 `result` 结束，共发出第三次模型请求 |
| 后台命令运行期间主机又发一条消息 | 这条消息照常是一轮。后台命令结束后，CLI 再自己开始一轮 |
| 后台命令在主机发起的一轮当中结束 | 不另开一轮。通知附在这一轮下一个工具结果后面发给模型，这一轮只有一个 `result` |
| 自发的一轮里模型调用需要审批的工具（`touch …`） | 照常向主机发 `can_use_tool`；主机允许后命令执行，这一轮正常结束 |
| 后台命令还在跑时结束 CLI | 关闭标准输入后 CLI 6 秒内没有退出。强行结束 CLI 后，后台命令的 shell 和 `sleep` 仍在运行，父进程变成 1 |

### 帧的顺序

主机发起、其中启动了后台命令的一轮：

```text
command_lifecycle(queued) > command_lifecycle(started) > system/init > system/status
> assistant(tool_use Bash, run_in_background) > system/background_tasks_changed > system/task_started
> user(tool_result) > system/status > assistant(text) > result > command_lifecycle(completed)
```

后台命令结束后，CLI 自发的一轮：

```text
system/task_updated > system/task_notification > system/background_tasks_changed
> system/init > system/status > assistant(text) > result
```

### 能用来区分的字段

- 主机发起的一轮有 `command_lifecycle` 帧，`command_uuid` 等于用户帧的 `uuid`；`system/status` 带 `user_message_uuids`，值也是这个 `uuid`。
- 自发的一轮没有 `command_lifecycle`，`system/status` 不带 `user_message_uuids`；它前面紧挨着 `system/task_notification`。
- `system/background_tasks_changed` 的 `tasks` 是当前全部后台任务，每项有 `task_id`、`run_id`、`task_type`（这里是 `local_bash`）和 `description`；任务结束后是空数组。
- `system/task_started` 带 `task_id`、`tool_use_id`、`task_type` 和 `is_backgrounded: true`。前台命令的同一帧是 `is_backgrounded: false`。
- `system/task_notification` 带 `task_id`、`tool_use_id`、`status`、`output_file` 和 `summary`。
- 审批请求的格式在两种轮次里相同。`sleep N; echo …` 这类命令 CLI 自己放行，不向主机请求审批，两种轮次都是这样。

### 发给模型的通知

自发的一轮里，CLI 给模型的是一条用户角色的消息，内容是一个 `<system-reminder>`：开头写明 `[SYSTEM NOTIFICATION - NOT USER INPUT]`，说明这是自动的后台任务事件、不是用户的确认或回答，后面是 `<task-notification>`（任务 ID、工具调用 ID、输出文件、状态和一行摘要，例如 `Background command "…" completed (exit code 0)`）。

### 进程

强行结束 CLI 后留下的两个进程：

```text
  PID  PPID  PGID STAT
22858     1 22858 Ss     /bin/zsh -c … eval 'sleep 41.7; echo bg-done' …
22859 22858 22858 S      sleep 41.7
```

后台命令在自己的会话和进程组里（`PGID` 等于它自己的 `PID`），所以结束 CLI 所在的进程组清不掉它。测完后这两个进程已手动结束。

## 补测

同样的方法，又测了下面这些（2.1.322，除非另外注明）。

| 场景 | 结果 |
| --- | --- |
| 两个后台命令差不多同时结束 | CLI 先发 `system/init` 和一个空的 `result`（`num_turns: 0`），再开一轮，模型在这一轮里同时收到两条通知 |
| 两个后台命令相隔几秒结束 | 每个各开一轮 |
| 后台子代理（`Agent` 带 `run_in_background`） | `task_started` 的 `task_type` 是 `local_agent`、`is_backgrounded: true`；结束后 CLI 自己开一轮。它结束在主机的一轮当中时，CLI 也另开了一轮，没有并进那一轮 |
| `Monitor` 工具 | 2.1.322 有，2.1.263 和 2.1.299 没有。它起一个 `local_bash` 后台任务；每输出一行，CLI 就自己开一轮，前面没有 `task_notification`；输出流结束时有一条 `task_notification`（摘要 `Monitor "…" stream ended`），再开一轮。设了禁用变量也能用 |
| 设了禁用变量 | `Agent` 工具的参数里也没有 `run_in_background` |
| 进程在后台命令运行时被结束，之后用同一会话 ID 重新启动 | 收到第一条消息后，CLI 先发这个命令的 `task_notification`（`status: "stopped"`），再在 `system/init` 之后发一个空的 `result`（`num_turns: 0`），在这条消息的 `command_lifecycle` 的 `queued` 之前或之后、`started` 之前。只在第一次重启时出现；三个版本都有，设了禁用变量也有。CLI 随下一轮把命令被停止的事告诉模型 |
| 2.1.299 | 帧的顺序与 2.1.322 相同，`system/status` 带 `user_message_uuids` |
| 2.1.263 | 有 `command_lifecycle`，但 `system/status` 不带 `user_message_uuids`；`background_tasks_changed` 的空数组在 `task_notification` 之前到达 |

会话文件里，CLI 自己开始的一轮前面是一条 `origin.kind: "task-notification"` 的用户行，内容是 `<task-notification>`（`<summary>`，Monitor 事件另有 `<event>`，后台子代理另有 `<result>` 与 `<usage>`）。2.1.263 与 2.1.299 的 `origin` 只有 `kind`。

**发现的已有问题。** 重启后的空 `result` 会被当时的运行器当作刚发出的这一轮的结果：这一轮被提前记为结束，下一帧随即按“轮次外的内容”（`claude-unrequested-turn`）停止会话，会话进入“结果待核对”。用真实帧在 `ClaudeRunnerState` 上复现过。这次的改动修好了它，与是否允许后台任务无关。

## 实现

- 允许条件：macOS、CLI ≥ 2.1.299（2.1.263 不报 `user_message_uuids`）、偏好 `claude_background_tasks`（缺省为开）。不满足时照旧设禁用变量。
- 一轮从 `command_lifecycle` 的 `started`（或带这条消息 ID 的 `user_message_uuids`）算起；之前到达的 `result` 忽略并计数（`strayResults`）。
- CLI 自己开始的一轮只在有后台任务运行、或有已结束还没处理的后台任务时接受；每个结束的任务最多换一轮。连续 25 轮没有人发消息，AgentKib 结束进程，提示 `background-limit`。
- 空闲时的审批请求在有后台任务时拒绝。
- 有后台任务时不做闲置回收；退出确认列出这些会话。
- 历史里的通知行显示为 CLI 的一行说明，不当作用户的消息。

## 运行器层面的验收

`apps/desktop/test/claude-background-native.test.ts`：真实 CLI 在 `ClaudeManagedRunnerProcess` 下运行（模拟模型、`sandbox-exec`、临时 `HOME` 与配置目录），设 `AGENTKIB_CLAUDE_BACKGROUND_NATIVE=1` 才运行，`AGENTKIB_CLAUDE_EXECUTABLE` 可指定 CLI。四项：

1. 后台命令结束后，CLI 自己开始的一轮有自己的轮次 ID，结束后进程可以回收；
2. Monitor 每个事件一轮，结束再一轮（CLI 没有 Monitor 工具时这一项只检查第一轮）；
3. 后台命令运行时结束进程，命令随之结束；不允许后台任务时重新启动，空结果被忽略，会话照常可用；
4. 同上，允许后台任务时重新启动。

| CLI | 结果 |
| --- | --- |
| 2.1.323 | 4 项通过 |
| 2.1.322 | 4 项通过 |
| 2.1.299 | 4 项通过（没有 Monitor，第 2 项只检查第一轮） |

`apps/desktop/test/fixtures/claude-background/` 里的 13 份帧记录由 `claude-background-turns.test.ts` 回放到 `ClaudeRunnerState`；`claude-background-process.test.ts` 用假 CLI 测进程一侧（环境变量、保留进程、结束进程树、连续轮次上限）。

## 结论

- 放开后台任务以后，托管运行器会遇到 CLI 自发的轮次。帧上能明确分出两种轮次，也能跟踪当前有哪些后台任务。
- 自发的轮次里也会出现审批请求，主机要能处理没有对应用户请求的审批。
- 后台命令在一轮当中结束时通常不产生额外的轮次，但后台子代理会；不能假定结束在一轮当中就没有自发轮次。
- 停止、回收和退出时，只结束 CLI 的进程组不够，要另外结束后台命令；macOS 上按进程树结束可以做到。
- `result` 不一定属于正在等的那一轮：重启后的空结果、CLI 自己那一轮的结果都可能先到，要以 `started` 为准。

## 没有覆盖的

- 模型是模拟的，没有真实模型的行为。
- 只测了 macOS；Linux 上按进程组结束清不掉后台命令，所以没有在 Linux 开放。
- 没有测 `/loop` 一类的命令，也没有测多个 Monitor 并发、长时间运行的会话。
- 后台子代理在没有轮次运行时请求审批（会被拒绝）只用合成帧测过。
- 主机刚发出消息时 CLI 正好开始自己的一轮，这种交错只用合成帧测过。
- AgentKib 的“停止”仍是结束整个 CLI 进程，会连同后台任务一起结束；没有试用 CLI 的 `interrupt` 只停一轮。
- CLI 还有 `stop_task`、`get_task_output` 等控制请求（在 2.1.299 与 2.1.323 的程序里看到），这次没有用，也没有测。
