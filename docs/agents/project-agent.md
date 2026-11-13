# 项目 Agent：Claude Code 指挥 Codex Worker

项目 Agent 是一个由 AgentKib 运行的 Claude Code 会话。用户允许后，它可以在指定的工作区里开 Worker（由 AgentKib 运行的 Codex 会话）、给 Worker 派任务、读取 Worker 的状态和回复、停止 Worker 当前这一轮。Worker 的一轮结束、开始等用户处理或被用户直接操作时，AgentKib 把汇报作为新的一轮送回项目 Agent。

用户继续在 AgentKib 的桌面、Web 或手机上和项目 Agent 对话。Worker 的审批和提问照常进入“等待你”，由用户处理；项目 Agent 只收到告知，不能代批。

目前只有桌面端能设定项目 Agent；Web 和手机把项目 Agent 和 Worker 当作普通会话显示和操作。

## 设定

在一个由 AgentKib 运行的 Claude Code 会话里打开“更多操作”，选择“设为项目 Agent…”，确定：

- **Worker 可以使用的工作区**：默认只有这个会话所在的工作区。多个工作树放在同一个目录时，可以把那个目录登记为工作区并勾选，Worker 建在它的根目录，任务里写明用哪个工作树。
- **允许 Worker 使用 Codex 自动审核**：默认不允许，Worker 用“工作区可写、需要时询问”。完全访问不开放给项目 Agent，需要时由用户在那个 Worker 自己的设置里改。
- **Worker 数量上限**（默认 4，最多 8）和**连续自动轮次上限**（默认 25）。

只有本机设备能设定（需要管理权限）。设定记下是哪台设备做的；这台设备的授权被撤销或变更时，委派暂停。

同一个面板列出 Worker（名称、状态、当前任务、最近一次汇报），可以打开 Worker 的会话、暂停和恢复委派、取消项目 Agent。取消后 Worker 会话保留为普通会话。

## 项目 Agent 拿到的工具

AgentKib 为每个项目 Agent 开一个只在本机回环地址上的 MCP 端点，路径是随机生成的能力 URL，只存在于 AgentKib 进程和这个会话的启动参数里，不写入用户的 Claude Code 配置。会话每次启动时带上它（`--mcp-config`，服务名 `agentkib_workers`），与持续目标的汇报端点合并；同时用 `--allowedTools mcp__agentkib_workers` 让这些工具不必逐次审批：设为项目 Agent 本身就是授权，主机在每次调用时按授权范围检查（2.1.263、2.1.299、2.1.323 实测不再发出 `can_use_tool`）。设为项目 Agent 或取消后，下一次发送时如果进程空闲，会换一个带或不带这些工具的新进程。

| 工具 | 作用 |
| --- | --- |
| `worker_list` | 列出 Worker 的状态、当前任务和最近汇报，以及新 Worker 可用的工作区、Codex 模型和权限档；委派暂停时注明 |
| `worker_open` | 在允许的工作区新建一个 Codex 会话作为 Worker，或接管一个已有的 Codex 会话（沿用接管的现有检查）。已经由 AgentKib 运行的 Codex 会话直接登记 |
| `worker_send` | 给 Worker 派任务或跟进，立即返回回执；Worker 运行中时默认排到这一轮之后，也可以加入这一轮。结果未知时不自动重发 |
| `worker_read` | 读取 Worker 的状态、最近几条回复（每条最多 4,000 字符）和在等用户处理的事 |
| `worker_stop` | 停止 Worker 当前这一轮 |

工具的回执和拒绝原因都是固定的代码，例如 `worker-limit-reached`、`workspace-not-allowed`、`policy-not-allowed`、`delegation-paused`、`codex-owner-busy`（Worker 正被 Codex 应用占用）。项目 Agent 只能操作自己名下的 Worker，不能选择授权范围以外的工作区和权限档，也不能回答审批。

端点的说明（MCP `instructions`）控制在 2,000 字符以内：Claude Code 把它放进第一条用户消息，2.1.263 超过约 2,000 字符、2.1.299 和 2.1.323 超过约 4,000 字符时截断；`/compact` 之后会重新放入（三个版本实测）。具体用法写在各工具的描述里。

## 汇报

- **什么时候**：Worker 的一轮结束（完成、失败或被停止）；Worker 开始等用户审批或回答；用户直接给 Worker 发消息或停止它（同一个 Worker 一分钟内只报一次）。
- **内容**：以 `[AgentKib report] Worker "<名称>" (Codex) · <发生了什么>` 开头；一轮结束时带上这一轮最后一条回复，经过与交接、正文搜索相同的脱敏，最多 4,000 字符，并注明它是 Worker 的工作结果，不是用户的指令。每一轮只报一次。
- **怎么送达**：作为项目 Agent 会话的自动待办，与排队消息、持续目标走同一套派发：项目 Agent 空闲时才送，用户自己排的消息先送；还没送出的汇报合并成一条；派发前按设定项目 Agent 的设备重新授权。项目 Agent 有后台任务在跑但不在一轮当中时照常送达。
- **暂停**：委派暂停时汇报先存着，恢复时合并送出。主机或后端重启后，委派处于暂停，用户在面板里恢复后才继续。汇报送不出去时委派暂停。
- **自动轮次上限**：每送出一条需要新一轮的汇报计一次，合并进已有汇报不计；达到上限时委派暂停，用户在项目 Agent 会话里发一条消息即清零并继续。

## 没有做的

- 终端里运行的 Claude Code 作项目 Agent；Codex、DeepSeek Harness 作项目 Agent 或作 Worker。
- Web 和手机上的项目 Agent 面板和设定；会话列表里标明 Worker 由哪个项目 Agent 委派，会话头显示项目 Agent 标识（现在只在“更多操作”的面板里能看到）。
- 项目 Agent 代为回答 Worker 的提问、代批审批。
- 按项目 Agent 汇总的手机通知：Worker 一轮结束仍按普通会话通知。
- Codex 应用里正在使用的 Worker（跟随桌面端时）的汇报；Codex CLI 自己开始的轮次计入自动轮次；汇报里的用时。
