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
- 标题用 Devin 自己的 `title`。Devin 让模型生成标题，标题还没生成或生成失败时可能为空，这时用用户输入的第一条消息（`is_user_input` 的用户消息）作标题，和 Codex 一样。

## 子代理

Devin 在 `subagent_heads` 里记下每个子代理的链头，子代理的消息是同一会话消息树里的另一条链。子代理列表按各自接到的任务（子代理链上的第一条用户消息）命名；读取某个子代理时从它的链头往回读，不混进会话自己的历史。Devin 不记录子代理是否仍在运行，状态报告为 `unknown`。手机端可以查看会话的子代理，只读；桌面和 Web 目前没有子代理视图。

## 在 AgentKib 里运行 Devin

每一轮由 AgentKib 启动一次非交互的 `devin -p`：新建时带上第一条消息，继续时加 `-r <会话 ID>`，第一条消息和之后的消息都写进只有当前用户可读的临时文件，用 `--prompt-file` 交给 Devin，这一轮结束后删除。进度从 Devin 的会话库读回，会话页每秒更新一次；停止会结束这个进程：先发 SIGINT；`devin -p` 不因 SIGINT 退出，1.5 秒后发 SIGTERM，5 秒后仍在运行则 SIGKILL。

- **登录**：Devin CLI 作为自己的宿主，用 `devin auth login` 保存的登录；AgentKib 不读取也不保存凭据。Devin Desktop 的登录只交给它自己启动的 `devin acp`，不能给 CLI 用。`devin acp` 在 ACP 模式下有意不用 CLI 的登录、要求宿主提供 API Key，所以这里不用 ACP。CLI 没有登录时 AgentKib 不提示；用户在 AgentKib 里新建或发送时，才说明需要先在终端运行一次 `devin auth login`。 未登录或工作区未信任时，会话页输入框上方和新建失败的提示里说明原因；桌面端另有“在终端登录 Devin CLI”“在终端信任这个工作区”按钮，在终端里运行 `devin auth login`，或在工作区里运行 `devin` 让它询问是否信任。AgentKib 只启动命令，看不到输入的内容；这个入口只接受桌面端自己的请求，Web 和手机只显示说明。
- **权限和模型**：用 Devin 自己的权限模式，对整轮生效：`accept-edits`（默认，自动批准只读工具和工作区内的文件修改）、`auto`（只自动批准只读工具）、`smart`、`dangerous`。`devin -p` 运行中不能询问，不在权限内的操作直接被拒绝，所以没有一轮中途的审批和提问。新建时选择首轮权限。桌面和 Web 的已有会话支持在运行中保存模型、推理强度和权限。下一轮 Devin 进程使用新设置。选择按 Devin 会话 ID 存在 AgentKib 数据目录的 `devin-session-settings.json` 里，AgentKib 重启后仍然有效。没选模型时继续会话沿用 Devin 保存的模型。输入框会显示可识别的模型家族、推理强度和速度。`smart` 和 `dangerous` 只接受有完全访问权限的设备。Devin 会话库里的 `agent_mode` 只记新建时的模式，之后不更新；AgentKib 每一轮都传 `--permission-mode`。
  用 3000.12.59 和 swe-2 在临时工作区实测：`auto` 下写文件被拒绝；`accept-edits` 下能写文件，但运行 shell 命令被拒绝。
- **工作区信任**：不传 `--respect-workspace-trust false`。Devin 还没信任的工作区会拒绝运行，AgentKib 说明需要先在那个目录里运行一次 `devin` 并选择信任。读取重置时间时启动的交互式 `devin` 也不替用户回答信任提问（见“重置时间”）。
- **会话锁**：Devin 在 `session_locks/<会话 ID>.lock` 里记下持有者的 PID，退出后文件仍留着。持有者仍是运行中的 Devin 进程（例如会话正在 Devin Desktop 或终端里打开）时，AgentKib 不发送，并提示到那边关掉后再发。
- **模型**：桌面首页和已有会话使用 `devin models list --format json` 提供的模型家族和具体变体。只选家族时把家族 slug 传给 Devin，由它选默认变体。选择推理强度或 Fast 时，AgentKib 匹配目录中真实存在的组合，把具体变体 ID 通过 `--model` 传给 Devin。目录中的特殊变体也可单独选择。已有会话的改动从下一轮生效。没有登录时列表为空，沿用 Devin 的默认配置。列表缓存 10 分钟。
- **环境**：Devin 给 ACP 宿主（例如 Devin Desktop）下的进程设置 `ACP_BACKEND`，继承了它的 CLI 会不用自己的登录。AgentKib 启动 `devin` 时去掉这个变量。
- **上下文用量**：已有会话复用上下文圆环。详情中的模型上限取自目录的 `max_context_tokens`。如果当前会话主链保存了同一模型变体的最近一次请求用量，可以显示该次请求的输入 token 和比例，并标明是历史记录。未找到匹配记录时，详情只显示已知的模型上限。日／周账户额度独立计算。
- **附件限制**：只能发送文字，不能带图片或文件。
- **回执**：新建、发送和停止都写入受控命令台账，结果不明时不会重复执行。新建要等 Devin 把会话写入会话库才返回会话 ID（最多 2 分钟）；超时视为结果不明，由回执核对。
- **运行中的一轮**：会话目录里标为“在 AgentKib 中运行”，首页的“进行中”、菜单栏的计数和手机的实时活动都算它。退出 AgentKib 会结束 `devin -p`（SIGTERM），所以退出确认里会列出它。AgentKib 新建的会话第一轮就算在内。
- **一轮的结果**：Devin 的会话库不记一轮在哪里结束，所以 AgentKib 在它运行的每一轮结束时，自己记下结果（完成、失败或被停止）作为已读状态，指向这一轮的提问和 Devin 的回答。之后和 Codex、Claude Code 会话一样：首页的“待查看”里有它，手机收到一轮结束的提醒，在桌面、Web 或手机上读到这条回答就标为已读。在 Devin Desktop 或终端里运行的轮次没有结果；AgentKib 没运行过任何一轮的会话没有待查看的内容。
- **访问范围**：只开放了部分工作区的设备，只能发送、停止和设置这些工作区里的 Devin 会话，知道其他会话的 ID 也不行。会话的实时状态和推送的状态都带 `workspaceId`，服务按它核对；Antigravity 会话同样如此。
- **一轮没有运行或没有完成**：原因用 Devin 自己的说法写在输入框上方（桌面和 Web）：CLI 未登录（`devin-login-required`）、工作区未信任（`devin-workspace-untrusted`）、找不到 CLI（`devin-cli-unavailable`）、会话在 Devin Desktop 或终端里打开着（`session-open-elsewhere`）、带了附件（`attachments-unsupported`）、运行失败（`devin-run-failed`）、`devin -p` 的进程在没人停止时被信号结束（`devin-run-stopped`）、结束后没找到 Devin 保存的会话（`devin-session-not-found`）。前两种在桌面端另有打开终端的按钮（见“登录”）。新建失败时，新建输入框用同样的说法。
- **使用上限**：额度用完时，Devin 的服务以 JSON-RPC 错误 `-32011`（`cognition.ai/errorKind: resource_exhausted`）结束这一轮，原文如 “Your daily usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.”，也有 weekly；CLI 自己的错误还有 “Quota exhausted”“Usage limit reached”“Organization usage limit reached”、每月上限、ChatGPT 订阅上限和 “Rate limited”。AgentKib 从 `devin -p` 打印的错误里认出这些说法：退出码为 0 时只看 stderr，失败时连同 stdout 一起看，所以回复里引用了同样的话也不算。这一轮按结束处理，会话照常可以发送，输入框上方马上提示“已达到每周使用上限。请稍后再试。”（每周额度）或“你已达到使用上限。请稍后再试。”，Devin 的原文保存在 `usageLimit.message`。
- **重置时间**：`devin -p` 不说什么时候重置。重置时间（账户的 `daily_quota_reset_at_unix`、`weekly_quota_reset_at_unix`）只在交互式 CLI 的 `/usage` 面板里显示，CLI 用自己的登录去读。所以 AgentKib 在后台用 `script(1)` 提供的伪终端（仓库里没有伪终端库，也没为此加依赖）启动一次交互式 `devin`：当前目录是这个会话的工作区，HOME 和登录都是用户平常的。它就绪（终端收到 OSC 7501 `state=idle`）后键入 `/usage`、单独按回车，读出面板里的窗口，如 “Weekly ■■■ 66% used · resets Nov 22, 4:00 PM (UTC+8)”（时间按括号里的 UTC 偏移换算，不写年份时取下一个这样的时间），然后关掉终端：`script` 和整个进程组一起结束，Devin 的终端随之挂断。整个过程最多 20 秒（实测约 6 秒），超时就结束整组进程；每次碰到上限至多读一次，几个会话同时碰到时共用一次读取。Devin 先问别的（例如是否信任这个目录）时 AgentKib 什么都不键入，直接放弃；面板说没有数据或未登录时也一样。读不到时间时保持上面的提示。启动交互式 CLI 也会启动 Devin 为这个工作区配置的 MCP 服务器，和每一轮 `devin -p` 一样。只在 macOS（BSD `script`）和 Linux（util-linux `script`）上读；Windows 上没有伪终端，只有提示。
- **自动继续**：读到时间后，按 Devin 原文里说的窗口（daily、weekly）取它的重置时间；原文没说时取用完（100%）的窗口里最晚重置的那个，和 Codex 一样。之后和 Codex 会话一样排上重置后自动继续，提示改为“……，11月22日 16:00 重置，重置后自动继续。”，可以选“不自动继续”或“重置后自动继续”（`usage-limit-cancel` / `usage-limit-continue`，能发消息的设备都可以点，手机也一样）；重新排上时以点选的设备的名义发出。发出的是 `AUTO_CONTINUE_TEXT.devin`（“Your Devin usage quota has reset. Continue the task…”），它是给模型的，会话记录、交接文档和搜索里都不出现，Devin 的回答归入它继续的那一轮。
- **重启之后**：提示存在受控命令台账（`managed_usage_limits` 表）里，AgentKib 重启后仍在，保留 7 天。已排上的自动继续随退出结束，提示改为由用户继续（`manual: "restarted"`），重置时间还没到时可以再排上；不知道重置时间的提示照旧。下一轮开始时清除。见[达到使用上限](usage-limits.md)。

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

`apps/desktop/test/devin-managed.test.ts` 用一个假的 `devin` 可执行文件覆盖：新建时识别 Devin 存下的会话、继续时带 `-r`、未登录时不启动、失败原因映射、停止、进程被结束（`devin-run-stopped`）、修订号和忙碌检查、使用上限（按 Devin 日志里记下的 `-32011` 原文和 CLI 自己的错误文字识别，退出码为 0 时只看 stderr，下一轮清除；有重置时间才排上自动继续）、每一轮结束时先告诉宿主结果和回答再显示空闲、宿主给的使用上限提示不改修订号、会话锁（只认运行中的 Devin 进程）、CLI 回退到 Desktop 自带的副本，以及 token 用量去重。

`apps/desktop/test/devin-usage.test.ts` 用 3000.12.59 实际打印的终端输出（状态栏和 `/usage` 面板）覆盖面板解析：UTC 偏移、跨年、不带偏移时按本机时间、无效的日期和时间、按原文选窗口；再用一个假的交互式 REPL 在真的 `script` 伪终端里覆盖：就绪后才键入 `/usage` 且回车单独发送、遇到信任提问什么都不键入、一直不就绪时按时放弃、没有数据、中途取消，以及每种情况下进程都结束。

`apps/desktop/test/devin-web-read.test.ts` 用同样的假 CLI 驱动后端：实时状态和推送的状态带 `workspaceId`，状态事件是可直接合并的实时状态；运行中的一轮在会话目录里标为在 AgentKib 中运行并进入退出确认的列表；`/usage` 读不出时间时只有提示、没有自动继续可选；读出时间后排上自动继续，到点发出 Devin 的那句话，那一轮完成后提示和台账里的记录都清除；用户发消息接管、取消再排上；重启后提示改为由用户继续并可再排上，不知道重置时间的提示照旧；每一轮的结果（完成、失败、被停止）连同提问和回答记入已读状态，首页“待查看”有它，读过后消失，各读者分别记。`apps/desktop/electron/main/web/codex-actions.test.ts` 覆盖只开放部分工作区的设备不能发送、停止工作区外的 Devin 和 Antigravity 会话，Devin 的 `usage-limit-cancel` / `usage-limit-continue` 经通用操作发出且要有发送权限。

在本机用 Devin CLI 3000.12.59 实测读取 `/usage`：在已信任的目录（测试用包装脚本跳过信任检查）约 6 秒读出 “Weekly 67% used · resets Nov 22, 4:00 PM (UTC+8)”，结束后没有残留进程，会话库仍是原来的会话数；在未信任的目录停在信任提问，什么都没键入，信任列表没有变化。Linux 路径在 Debian 容器（util-linux 2.38.1）里用假的 REPL 跑过。

`apps/desktop/test/devin-sessions.test.ts` 用合成的会话库覆盖以下内容：列表与隐藏会话、压缩链与去重、分页、AgentKib 的继续不进时间线和搜索、工具详情、交接文档的两种模式、图片、正文搜索记录、未知存储格式，以及 `DEVIN_SESSIONS_DIR` 和上下文来源。在本机真实会话库上也只读跑过一遍：6 个会话全部可读，压缩链完整还原，最长的会话（约 5 千个消息节点）首屏冷读约 0.2 秒，再读和往前翻页约 10 毫秒（2026-11-15 复测）。
