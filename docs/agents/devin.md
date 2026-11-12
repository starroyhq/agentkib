# Devin 只读接入

Devin Desktop 把 Devin CLI 打包在应用里，以 `devin acp` 子进程运行会话；终端里的 Devin CLI 与它共用同一个会话库。AgentKib 一期只读：发现工作区、浏览和搜索会话、把会话交给其他 Agent，以及管理规则、Skills、MCP 和 CLI 本身。在 AgentKib 里继续或新建 Devin 会话（经 `devin acp`）是二期内容，当前不提供。

## 已验证基线

| 组件 | 已验证 | 说明 |
| --- | --- | --- |
| Devin Desktop 自带 CLI | 3000.12.43，macOS | `/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin`，不在 PATH 上 |
| 会话库 | refinery 迁移 v20，`app_state.schema_compat_version = 0` | `~/.local/share/devin/cli/sessions.db`（SQLite WAL） |

Windows（`%APPDATA%\devin\cli`）和 Linux（`$XDG_DATA_HOME/devin/cli`）的路径按官方文档实现，本机未实测。`DEVIN_SESSIONS_DIR` 指定的目录会代替默认位置；实验性的 `DEVIN_SESSION_STORE=files` 文件式存储暂不支持。

## 会话读取

- 只读打开会话库：数据库正在被 Devin 使用时走普通只读事务，读到一份一致的快照；没有进程打开时以 `immutable` 方式打开，不创建 `-wal`/`-shm` 辅助文件。AgentKib 从不写这个库。
- 放行条件是必需的表和列存在，且 Devin 自己的兼容标记 `schema_compat_version` 是已知值（目前只有 `0`）。标记变成未知值时，会话只显示标题和时间，历史提示暂不可读。迁移版本只记录不拦截。
- 跳过 `hidden = 1` 的内部会话（摘要、代码地图等辅助 Agent）。会话按 `working_directory` 归入其所在的工作区。
- Devin 把一个会话存成消息树。当前对话是从 `main_chain_id` 回溯到根的路径；压缩后这条路径以一条系统摘要开头，摘要的 `summarized_from` 指向被替换历史的最后一个节点。读取时沿这些链接接回完整对话。模型切换等操作会把消息复制到新的根上，同一 `message_id` 只显示一次。
- 时间线只包含用户输入、Devin 的回复和工具调用；系统消息、注入的上下文和推理内容不显示。工具详情来自 Devin 保存的 ACP 工具状态：命令显示命令和输出末尾，编辑显示差异，读取、搜索和抓取只显示目标。所有文本都经过与其他来源相同的脱敏和长度限制。
- Devin 只给少数回答标了 `final_answer`。没有标记时，一轮里最后一条之后没有工具调用的回复视为回答，其余回复视为过程说明。
- 用户消息里的图片可以在会话页查看；工具结果里的截图不显示，交接文档记为外部附件。

## 交接

- 作为来源：默认只包含 Devin 模型当前看到的内容，即最近一次压缩的摘要和之后的对话，被替换的历史计入 `compacted-history`。选择包含压缩前历史时，按顺序保留全部片段，并在压缩处加标注。
- 作为目标：用交接文件开始，在终端里启动 `devin`，第一条消息让它先读取交接文件。Devin 没有导入其他 Agent 历史的接口，原生导入标为 `native-history-import-unsupported`。

## 规则、Skills 与 MCP

- 上下文预览按 Devin 文档的加载规则列出常驻指令：`~/.config/devin/AGENTS.md`；工作区里的 `AGENTS.md`、`AGENTS.local.md`、`AGENT.md`、`.windsurfrules`；`.devin/global_rules.md`，没有时用 `.windsurf/global_rules.md`；`.devin/rules`、`.windsurf/rules` 中 `trigger: always_on` 的规则；`.cursor/rules` 中 `alwaysApply` 的规则；`CLAUDE.md` 与 `~/.claude/CLAUDE.md`。按需激活或无法确认激活方式的规则不并入，并给出提示。`.devin/config.json`、`.devin/config.local.json` 和用户配置里的 `read_config_from` 关闭某个来源时，预览同步排除。Devin Desktop 还会读取 Windsurf 稳定版的 `~/.codeium/windsurf/memories/global_rules.md`，这一点在本机核实过。
- Skills：项目部署到 `.devin/skills`，个人部署到 `~/.config/devin/skills`。Devin 也读取 `.agents/skills`、`~/.agents/skills` 和项目的 `.claude/skills`，部署到这些位置的 Skill 同样标为对 Devin 可见。
- MCP：读取 `~/.config/devin/mcp_config.json` 和 `.devin/mcp_config.json`，MCP Hub 的连接写入 `.devin/mcp_config.json`。值里含 `${env:…}` 或 `${file:…}` 的服务器不能收录，需要手动配置。
- Manifest 适配器默认关闭，和 OpenCode、Grok Build、Antigravity 一样需要在工作区里显式启用。AgentKib 只写共享的 `AGENTS.md`，不生成 Devin 专属的指令文件。

## 工具链

安装检测同时识别 PATH 上的 `devin`、官方安装器（`~/.local/bin/devin`，版本目录在 `~/.local/share/devin/cli/_versions/`）和 Devin Desktop 自带的 CLI。Desktop 自带的 CLI 随应用更新；未安装时只提供官方安装器的命令。

## 验证

`apps/desktop/test/devin-sessions.test.ts` 用合成的会话库覆盖以下内容：列表与隐藏会话、压缩链与去重、分页、工具详情、交接文档的两种模式、图片、正文搜索记录、未知存储格式，以及 `DEVIN_SESSIONS_DIR` 和上下文来源。在本机真实会话库上也只读跑过一遍：6 个会话全部可读，压缩链完整还原，最长的会话首屏约 2.3 秒，之后 30 秒内翻页复用已读取的链。
