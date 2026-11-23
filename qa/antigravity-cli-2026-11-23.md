# Antigravity 经 CLI 的 `agy acp` 控制（2026-11-23）

## 环境

- Antigravity App 2.34.0：不包含 CLI 和 ACP 服务。
- Antigravity CLI 1.5.14（`~/.local/bin/agy`，用户按官方安装命令安装并登录）：`agy acp` 报告 `Antigravity ACP Server` 1.5.14，能力含 `loadSession`、`sessionCapabilities.resume/close/load/list`、`promptCapabilities.image`。

## 探测结论（只读或临时会话）

- `session/list` 列出 38 个会话，全部是 App 会话库里的会话（App 共 40 个）：CLI 与 App 共用会话。
- `session/new`、`session/resume` 都接受 `type: http` 的 `mcpServers`；Antigravity 调用了探测 MCP 服务器的工具。工具审批 `toolCall.name` 为 `mcp_<服务名>_<工具>`，选项为 `allow`（allow_once）和 `deny`（reject_once）。
- `configOptions`：`model`（gemini-3.8-flash、claude-sonnet-4-6、claude-opus-4-6-thinking、gpt-oss-120b-medium）、`thought_level`（low、medium、high）、`mode`（default、accept-edits、auto、plan）。`session/set_config_option` 返回新的 `configOptions`。续接后模式保留，推理档位回到 high。
- 命令审批的 `rawInput` 为 `CommandLine`、`WaitMsBeforeAsync`、`toolSummary`；编辑为 `Path`、`Target`、`Replacement`（新文件为 `Content`），并附 `diff` 内容和以 `/private/tmp` 拼写的位置。
- 图片提示可用（2×2 红色 PNG 回答 red）。运行中再发一条提示会被接受：前一个提示立即 `end_turn`，内容继续。
- 没有消息的会话不会被保存；`session/close` 可用。

## AgentKib 实测（临时工作区，模型 gemini-3.8-flash，推理档位 low）

| 场景 | 结果 |
| --- | --- |
| 用 AgentKib 的运行器续接会话、发送、停止 | 通过；上下文用量正常 |
| 命令审批（default 模式运行 `touch`） | 显示为可决定的审批，拒绝后文件没有创建 |
| 编辑审批（替换文件中的词） | 显示差异，允许后文件被修改 |
| 新建会话并带上推理档位 low、模式 accept-edits | 通过；第一轮后出现在会话列表 |
| 两轮之间修改模式和推理档位 | 生效 |
| 作为项目 Agent 续接并调用 worker 工具 | 工具被调用，审批自动放行，没有留下待审批 |

## 自动检查

- `pnpm format:check`、`pnpm typecheck` 通过；`pnpm lint` 在本次改动中没有新增告警。
- 新增 `apps/desktop/test/antigravity-cli-control.test.ts`（新建与设置、项目 Agent 工具自动放行与 CLI 审批映射、一轮失败不中断会话）；Antigravity 的 HTTP 基线改为新行为（缺第一条消息时拒绝新建、读取 CLI 的新建选项）。

## 未验证

- 未在界面上走查桌面、Web、手机；未用真实额度用完触发使用上限；未测试未登录时 `agy acp` 的实际报错。
- Windows 和 Linux。
- 测试会话留在 Antigravity 的会话列表中（临时目录下，均只有一两条短消息）。
