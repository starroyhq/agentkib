# Devin 接入

Devin Desktop 把 Devin CLI 打包在应用里，以 `devin acp` 子进程运行会话；终端里的 Devin CLI 与它共用同一个会话库。AgentKib 发现工作区、浏览和搜索会话、把会话交给其他 Agent，管理规则、Skills、MCP 和 CLI 本身，并能在桌面、Web 和手机上新建和继续 Devin 会话（见“在 AgentKib 里运行 Devin”）。

## 已验证基线

| 组件 | 已验证 | 说明 |
| --- | --- | --- |
| Devin Desktop 自带 CLI | 3000.12.43、3000.12.59，macOS | `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`，不在 PATH 上 |
| 会话库 | refinery 迁移 v20，`app_state.schema_compat_version = 0` | `~/.local/share/devin/cli/sessions.db`（SQLite WAL） |

Windows（`%APPDATA%\devin\cli`）和 Linux（`$XDG_DATA_HOME/devin/cli`）的路径按官方文档实现，本机未实测。设置 `DEVIN_SESSIONS_DIR` 后，会话库和会话锁放在它下面的 `cli/` 里（3000.12.59 实测）；实验性的 `DEVIN_SESSION_STORE=files` 文件式存储暂不支持。

## 会话读取

- 只读打开会话库：数据库正在被 Devin 使用时走普通只读事务，读到一份一致的快照；没有进程打开时以 `immutable` 方式打开，不创建 `-wal`/`-shm` 辅助文件。AgentKib 从不写这个库。
- 放行条件是必需的表和列存在，且 Devin 自己的兼容标记 `schema_compat_version` 是已知值（目前只有 `0`）。标记变成未知值时，会话只显示标题和时间，历史提示暂不可读。迁移版本只记录不拦截。
- 跳过 `hidden = 1` 的内部会话（摘要、代码地图等辅助 Agent）。会话按 `working_directory` 归入其所在的工作区。
- Devin 把一个会话存成消息树。当前对话是从 `main_chain_id` 回溯到根的路径；压缩后这条路径以一条系统摘要开头，摘要的 `summarized_from` 指向被替换历史的最后一个节点。读取时沿这些链接接回完整对话。模型切换等操作会把消息复制到新的根上，同一 `message_id` 只显示一次。
- 时间线只包含用户输入、Devin 的回复和工具调用；系统消息、注入的上下文和推理内容不显示。工具详情来自 Devin 保存的 ACP 工具状态：命令显示命令和输出末尾，编辑显示差异，读取、搜索和抓取只显示目标。所有文本都经过与其他来源相同的脱敏和长度限制。
- Devin 只给少数回答标了 `final_answer`。没有标记时，一轮里最后一条之后没有工具调用的回复视为回答，其余回复视为过程说明。
- 用户消息里的图片可以在会话页查看；工具结果里的截图不显示，交接文档记为外部附件。

## 在 AgentKib 里运行 Devin

每一轮由 AgentKib 启动一次非交互的 `devin -p`：新建时带上第一条消息，继续时加 `-r <会话 ID>`，第一条消息和之后的消息都写进只有当前用户可读的临时文件，用 `--prompt-file` 交给 Devin，这一轮结束后删除。进度从 Devin 的会话库读回，会话页每秒更新一次；停止会结束这个进程：先发 SIGINT；`devin -p` 不因 SIGINT 退出，1.5 秒后发 SIGTERM，5 秒后仍在运行则 SIGKILL。

- **登录**：Devin CLI 作为自己的宿主，用 `devin auth login` 保存的登录；AgentKib 不读取也不保存凭据。Devin Desktop 的登录只交给它自己启动的 `devin acp`，不能给 CLI 用。`devin acp` 在 ACP 模式下有意不用 CLI 的登录、要求宿主提供 API Key，所以这里不用 ACP。CLI 没有登录时 AgentKib 不提示；用户在 AgentKib 里新建或发送时，才说明需要先在终端运行一次 `devin auth login`。 未登录或工作区未信任时，会话页输入框上方和新建失败的提示里说明原因；桌面端另有“在终端登录 Devin CLI”“在终端信任这个工作区”按钮，在终端里运行 `devin auth login`，或在工作区里运行 `devin` 让它询问是否信任。AgentKib 只启动命令，看不到输入的内容；这个入口只接受桌面端自己的请求，Web 和手机只显示说明。
- **权限和模型**：用 Devin 自己的权限模式，对整轮生效：`accept-edits`（默认，自动批准只读工具和工作区内的文件修改）、`auto`（只自动批准只读工具）、`smart`、`dangerous`。`devin -p` 运行中不能询问，不在权限内的操作直接被拒绝，所以没有一轮中途的审批和提问。新建时选，或在会话页的“会话设置”里改；改动从下一轮生效，按 Devin 会话 ID 存在 AgentKib 数据目录的 `devin-session-settings.json` 里，AgentKib 重启后仍然有效。没选模型时继续会话不传 `--model`，Devin 沿用这个会话保存的模型，输入框里显示它。`smart` 和 `dangerous` 只接受有完全访问权限的设备。Devin 会话库里的 `agent_mode` 只记新建时的模式，之后不更新；AgentKib 每一轮都传 `--permission-mode`。
- **工作区信任**：不传 `--respect-workspace-trust false`。Devin 还没信任的工作区会拒绝运行，AgentKib 说明需要先在那个目录里运行一次 `devin` 并选择信任。
- **会话锁**：Devin 在 `session_locks/<会话 ID>.lock` 里记下持有者的 PID，退出后文件仍留着。持有者仍是运行中的 Devin 进程（例如会话正在 Devin Desktop 或终端里打开）时，AgentKib 不发送，并提示到那边关掉后再发。
- **模型**：新建时按 `devin models list --format json` 的模型家族列出，用 `--model <slug>` 传给 Devin，由它选具体变体；没有登录时列表为空，用 Devin 配置的默认模型。列表缓存 10 分钟。
- **环境**：Devin 给 ACP 宿主（例如 Devin Desktop）下的进程设置 `ACP_BACKEND`，继承了它的 CLI 会不用自己的登录。AgentKib 启动 `devin` 时去掉这个变量。
- **限制**：只能发送文字，不能带图片或文件；没有上下文用量。
- **回执**：新建、发送和停止都写入受控命令台账，结果不明时不会重复执行。新建要等 Devin 把会话写入会话库才返回会话 ID（最多 2 分钟）；超时视为结果不明，由回执核对。

## 交接

- 作为来源：默认只包含 Devin 模型当前看到的内容，即最近一次压缩的摘要和之后的对话，被替换的历史计入 `compacted-history`。选择包含压缩前历史时，按顺序保留全部片段，并在压缩处加标注。
- 作为目标：用交接文件开始，在终端里启动 `devin`，第一条消息让它先读取交接文件。Devin 没有导入其他 Agent 历史的接口，原生导入标为 `native-history-import-unsupported`。

## 规则、Skills 与 MCP

- 上下文预览按 Devin 文档的加载规则列出常驻指令：`~/.config/devin/AGENTS.md`；工作区里的 `AGENTS.md`、`AGENTS.local.md`、`AGENT.md`、`.windsurfrules`；`.devin/global_rules.md`，没有时用 `.windsurf/global_rules.md`；`.devin/rules`、`.windsurf/rules` 中 `trigger: always_on` 的规则；`.cursor/rules` 中 `alwaysApply` 的规则；`CLAUDE.md` 与 `~/.claude/CLAUDE.md`。按需激活或无法确认激活方式的规则不并入，并给出提示。`.devin/config.json`、`.devin/config.local.json` 和用户配置里的 `read_config_from` 关闭某个来源时，预览同步排除。Devin Desktop 还会读取 Windsurf 稳定版的 `~/.codeium/windsurf/memories/global_rules.md`，这一点在本机核实过。
- Skills：项目部署到 `.devin/skills`，个人部署到 `~/.config/devin/skills`。Devin 也读取 `.agents/skills`、`~/.agents/skills` 和项目的 `.claude/skills`，部署到这些位置的 Skill 同样标为对 Devin 可见。
- MCP：读取 `~/.config/devin/mcp_config.json` 和 `.devin/mcp_config.json`，MCP Hub 的连接写入 `.devin/mcp_config.json`。值里含 `${env:…}` 或 `${file:…}` 的服务器不能收录，需要手动配置。
- Manifest 适配器默认关闭，和 OpenCode、Grok Build、Antigravity 一样需要在工作区里显式启用。AgentKib 只写共享的 `AGENTS.md`，不生成 Devin 专属的指令文件。

## 工具链

安装检测同时识别 PATH 上的 `devin`、官方安装器（`~/.local/bin/devin`，版本目录在 `~/.local/share/devin/cli/_versions/`）、Homebrew（cask `devin-cli`，最新版本取自 formulae.brew.sh）和 Devin Desktop 自带的 CLI。Desktop 自带的 CLI 随应用更新。运行会话和交接文件启动依次使用 PATH 上的 `devin`、`~/.local/bin/devin` 和 Desktop 自带的 CLI，所以只装了 Devin Desktop 也能用。

## 洞察

用量只统计 token：每条回复保存的 `metrics`（输入、输出、缓存读写），按会话、日期和模型汇总；同一条回复在多条链上的副本按消息 ID 只算一次，隐藏的辅助会话不计入。会话元数据里的 credits/ACU 不是剩余额度，不统计。

## 验证

`apps/desktop/test/devin-managed.test.ts` 用一个假的 `devin` 可执行文件覆盖：新建时识别 Devin 存下的会话、继续时带 `-r`、未登录时不启动、失败原因映射、停止、修订号和忙碌检查、会话锁（只认运行中的 Devin 进程）、CLI 回退到 Desktop 自带的副本，以及 token 用量去重。

`apps/desktop/test/devin-sessions.test.ts` 用合成的会话库覆盖以下内容：列表与隐藏会话、压缩链与去重、分页、工具详情、交接文档的两种模式、图片、正文搜索记录、未知存储格式，以及 `DEVIN_SESSIONS_DIR` 和上下文来源。在本机真实会话库上也只读跑过一遍：6 个会话全部可读，压缩链完整还原，最长的会话首屏约 2.3 秒，之后 30 秒内翻页复用已读取的链。
