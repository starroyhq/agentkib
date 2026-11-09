# 原生导入版本门限复验 — 2026-11-09

## 范围与环境
- 分支 `native-import-compat`，起点 `4d43a1409`。改动：Codex 原生导入从“正好 0.159.2”改为“0.159.2 或更新”，Claude Code 从“2.1.x”改为“2.1 或更新”；写入的记录结构不变。
- Codex CLI `0.163.0`（Homebrew cask，arm64 原生二进制），Claude Code `2.1.319`；macOS 27.0.1，Node `26.12.0`。
- 每个用例用一个新建的临时目录，里面有各自的 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`TMPDIR`、AgentKib 数据目录和工作区 `work space.v2`。`PATH` 里只有指向真实 CLI 的链接和系统目录。没有读写用户自己的 `~/.codex`、`~/.claude`、`~/.agentkib`，没有用用户的账号。
- 没有调用真实模型。CLI 都在 `sandbox-exec` 里运行，除本机的模拟接口外禁止联网。Codex 用沙盒里 `codex login --with-api-key` 写入的假密钥，Claude Code 用 `ANTHROPIC_API_KEY` 假密钥。

## 做法
- **AgentKib 侧：** 用 vite 把本分支的后端源码打包成 Node 脚本，按产品流程依次调用：
  - `prepareSessionHandoff`（预览）；
  - `planSessionHandoff`（生成 ChangeSet）；
  - `applySessionHandoff`（`approveHome: true`）；
  - `prepareHandoffLaunch` 与 `verifyNativeSession`（启动前读回）。

  版本检查调用真实 CLI 的 `--version`，没有替身。只跳过最后打开 Terminal.app 的一步，记下 AgentKib 会执行的命令。
- **来源：** 手工构造的会话文档，共 6 轮：
  - 用户消息里有随机暗号；
  - 助手调用 `Read` 工具，工具结果里有存储决定；
  - 用户发了一张 1×1 PNG。

  导入 Codex 时来源记为 Claude Code，导入 Claude Code 时来源记为 Codex。
- **Codex 侧：**
  - `codex app-server` 启动两次，每次都调用 `thread/read`、`thread/resume`、`thread/list`。第一次另发一次 `turn/start`；第二次只读，相当于重启后读回。
  - 导入记录写的提供方是 `openai`，Codex 恢复时沿用它（见发现 1）。因此沙盒配置用 `openai_base_url` 把内置的 `openai` 提供方指向本机模拟的 Responses 接口，并关闭 websocket。
  - 终端界面：用 AgentKib 记下的命令 `codex resume <ID> -C <工作区>`，在独立的 tmux 里打开，只加了 `--no-daemon`（见发现 2），之后用 Ctrl+C 退出。
  - 只读查看 `state_5.sqlite` 的 `threads` 行。
- **Claude Code 侧：** 用 AgentKib 记下的命令 `claude --resume <ID>`，加 `-p` 和一个提问，在工作区里运行，请求发给本机模拟的 Messages 接口。

## 结果

| 编号 | 项目 | 结论 | 观察 |
| --- | --- | --- | --- |
| A1 | Codex 0.163.0：预览 | 通过 | `mode: native-session`，`native_resume: supported`，没有损失项。 |
| A2 | 生成变更、应用、启动前读回 | 通过 | ChangeSet 只有 1 个 `agent-home` 文件，需要 Home 批准；写入内容与计划逐字节一致（15 行），`verifyNativeSession` 通过。`session_meta.cli_version` 为 `0.159.2`。 |
| B1 | Codex 读回与恢复 | 通过 | 两次启动的 `thread/read` 与 `thread/resume` 都返回同一 ID、工作区 cwd 和 5 条可见消息：暗号、两条助手回复、图片那一轮的文字、最后的回复。`thread/list` 正好列出这一条。 |
| B2 | 续接一轮 | 通过 | 发给模型的输入顺序为：<br>1. 系统说明；<br>2. 导入提示；<br>3. 暗号消息与助手文字；<br>4. `Read` 的 `function_call` 与同一 `call_id` 的 `function_call_output`；<br>5. 存储决定；<br>6. 图片（`data:image/png;base64`）与文字；<br>7. 最后的回复；<br>8. 环境信息和新提问。<br>这一轮 `completed`，第二次启动读回 7 条消息。 |
| B3 | 导入的文件 | 通过 | 导入的字节原样保留，Codex 只在后面追加了 15 行；`sessions/` 下只有这一个 rollout。 |
| B4 | 状态库索引 | 通过 | `threads` 行的 `title`、`first_user_message`、`preview` 都是暗号那条消息，不是导入提示。`cli_version` 为 `0.159.2`，`history_mode` 为 `legacy`，`originator` 为 `agentkib`，`model_provider` 为 `openai`。 |
| B5 | 终端界面 | 通过 | 显示工作区路径和上面 5 条历史，没有询问工作目录。约 17 秒后加载完成，等待来自沙盒拦截联网后的重试。Ctrl+C 退出，退出码 0。 |
| C1 | Claude Code 2.1.319：预览、变更、应用、读回 | 通过 | 同 A1、A2；会话写到 `projects/<按规则编码的目录>/<ID>.jsonl`。 |
| C2 | `claude -p --resume <ID>` | 通过 | 退出码 0，`session_id` 不变，`result` 是模拟回复。请求的 `messages` 包含导入提示与暗号、`call_nia_1` 的 `tool_use` 与 `tool_result`、存储决定、图片与文字、最后的回复，以及新提问。导入的字节原样保留，CLI 追加了 27 行。 |

## 发现
1. **导入的 Codex 会话按记录里的 `model_provider: "openai"` 恢复。**
   - 沙盒配置的 `model_provider` 改为其他提供方时，`thread/resume` 返回的仍是 `openai`，续接请求发往 OpenAI（被沙盒拦下）。
   - 因此只配置了其他提供方、没有登录 OpenAI 的用户，导入后无法在 Codex 里继续对话。
   - 这与版本门限无关，本次不改代码，已写进[会话互通文档](../docs/SESSION-INTEROPERABILITY.md)。
2. **Codex 0.163.0 的终端界面默认启动共享后台服务，并调用 `ps` 记录这个进程。**
   - `sandbox-exec` 里 `ps` 没有权限，Codex 打印 "failed to invoke ps … Operation not permitted" 后直接退出。
   - 这是验收沙盒造成的，普通终端不受影响；终端界面检查因此加了 `--no-daemon`。

## 未覆盖
- 真实模型回复：没有使用用户的账号。
- 其他 Codex 与 Claude Code 版本，以及 Codex Desktop、Windows、Linux。
- Claude Code 2.2 及以后的版本：尚未发布，届时由会话格式探针判断。
- 只验证了合成来源的两个方向：Claude Code→Codex 与 Codex→Claude Code。

## 清理
- 临时目录都在会话的 scratchpad 下。
- tmux 用的是独立 socket，结束后服务已停止、socket 已删除；没有残留进程。
