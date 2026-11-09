# Antigravity 接入边界与实施计划

Antigravity 不能直接复用 Gemini CLI 的会话适配器。两者共享 `GEMINI.md`、`.agents/skills` 和 MCP 配置约定，但会话存储、控制协议和可验证能力不同。AgentKib 将配置资产适配与会话协议适配分开实现。

## 当前适配基线

| 组件                   | 已验证版本 | 用途                                                                                 |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Antigravity CLI        | 1.2.7      | 安装检测、版本检测和官方 CLI 入口                                                    |
| Antigravity ACP server | 1.1.1      | ACP v1 会话列表、加载、续接、发送、停止和逐次审批                                    |
| ACP protocol           | v1         | `session/list`、`session/load`、`session/resume`、`session/prompt`、`session/cancel` |

AgentKib 不自动下载 ACP server，也不读取或复制 Google 登录凭据。运行时从绝对路径环境变量 `AGENTKIB_ANTIGRAVITY_ACP_BIN` 查找服务器；未设置时查找 PATH 中的 `agy_acp_server.par` 或 `agy_acp_server.exe`。只读历史按 ACP v1 能力协商；发送、停止和审批还要求服务端精确报告身份 `antigravity-acp`，版本完整匹配 `agy_acp_server_数字.数字.数字` 且不低于 `1.1.1`。版本范围只决定尝试兼容，实际 ACP v1、加载或续接能力、会话及审批身份仍须确认。

上下文占用仅接收原生 `usage_update.used` 与 `size`，缺失或无效时保持未知。连接声明可选的 ACP v1 `session.compaction` 扩展；收到压缩通知时按原生 `compactionId` 保存有界生命周期、摘要块及 nullable patch，首次接收位置保持不变，历史允许从终态开始。未知状态不能确认压缩结束；压缩结束也不能确认当前轮次结束。压缩期间禁用新发送，保留停止及有效原生审批；没有这些通知时只依赖原有运行状态锁。扩展处理与离线测试通过不证明已安装服务器实际会上报它们。

压缩期间的合法用量报告保留为待确认候选，包括连续压缩或模型切换后开始的压缩。压缩结束后仍显示“用量待更新”；只有普通请求或输出边界之后的新原生报告才能恢复当前占用比例，结束通知本身不会使候选报告变为当前值。

每次新建 ACP runner 都分配当前 Backend 内递增的用量报告代次。重连后的报告编号可以重新从 1 开始；桌面和 Remote 持续订阅时，也能按代次撤销旧实例报告并接受新报告。模型切换、压缩和同一连接内的状态更新保留该代次。

## 已实现范围

- 发现 `agy` CLI 和 Antigravity 桌面应用。
- 读取全局 `~/.gemini/GEMINI.md`、`~/.gemini/antigravity-cli/settings.json`、`~/.gemini/antigravity-cli/skills`、`~/.gemini/antigravity-cli/rules`、`~/.gemini/config/skills` 和 `~/.gemini/config/mcp_config.json`。资产目录同时扫描 CLI 暂存插件 `~/.gemini/antigravity-cli/plugins/*` 与全局插件 `~/.gemini/config/plugins/*`。
- 读取和生成项目 `AGENTS.md`、`GEMINI.md`、`.agents/skills` 与 `.agents/mcp_config.json`；规则扫描支持 `.agents/rules` 和兼容路径 `.agent/rules`，同名时以新路径为准。有效上下文只纳入可确认常驻的工作区/全局规则；Manual、Model Decision、Glob 及未知激活模式保留为资产并显示预览警告。远程 MCP 使用 `serverUrl`，并保留未知 JSON 字段。
- 仅有 `GEMINI.md` 的项目若将其规则提升为共享规则，生成 `AGENTS.md` 的同次变更也会清理 `GEMINI.md` 中的重复内容，即使尚未启用 Antigravity；无法确定旧专用规则与编辑后的规则如何合并时，预览会要求先协调原文。
- 加载项目根 `.agents/plugins/*`、全局 `~/.gemini/config/plugins/*` 以及 CLI 暂存目录 `~/.gemini/antigravity-cli/plugins/*` 中通过 `plugin.json` 校验的插件规则。CLI 插件按官方自动发现语义默认启用，并尊重已验证的配置覆盖和 manifest 默认禁用值；无法解析的显式状态会失败关闭并告警。名称冲突或带有无法可靠解释的 `rules.json` 时同样排除并告警。
- 通过 Google 分发的 ACP server 列出和读取 ACP 原生会话，归一化为 AgentKib `SessionDocument`。
- 原生 MCP 迁移会保留无法转换的配置：带静态 OAuth 客户端配置或显式 SSE 传输的服务不会标为可自动迁移；未声明传输的远程服务仍需通过迁移前连接探测。
- 在桌面与 Web 中对已核验的 ACP 会话发送消息、停止精确活动轮次，并只提交服务端真实提供的审批 `optionId`。审批仅在命令、文件编辑或单文件读取的操作范围可完整展示时开放；未验证的工具类型（包括移动、删除）保持不可审批。活动轮次断线后保留 outcome-unknown 防线，不自动重连或重发。
- 将 Antigravity ACP 会话作为来源，导入 Codex 或 Claude Code 的目标原生历史，并沿用预览、脱敏、损失确认和回读验证流程。

## 官方接口尚未提供的能力

ACP v1 的 `session/new` 没有导入外部历史的参数。Antigravity CLI 1.2.7 也没有把任意外部 transcript 创建为目标原生会话的稳定命令。因此 Codex/Claude Code → Antigravity 的原生历史导入保持 `native-history-import-unsupported`，不会降级后仍标记为原生导入。

当前 ACP server 使用自己的会话存储。尚无公开稳定接口证明它可以完整列出或控制 Antigravity Desktop/IDE 与 `agy` CLI 已有的全部会话。因此 AgentKib 只索引 ACP server 返回的会话；只有服务端同时支持 `session/load` 时才标记为可读，否则仅展示元数据。未安装可选 ACP server 时，会话来源为空；不会把 ACP 能力扩大解释为对现有 Desktop/IDE 或 CLI 会话的控制。

## 实施与验收

实施顺序是：冻结官方版本和协议能力；完成资产发现与保留式写入；用 ACP 能力协商接入历史；实现带 session、turn、revision 三重校验的控制；归一化会话；逐方向验证原生导入；最后执行全仓回归。任何缺少官方稳定接口的方向保持不支持，并记录证据。

完整验收定义、八个跨 Agent 方向、A01–A14 场景和证据要求见 [`qa/ANTIGRAVITY-ACCEPTANCE.md`](../../qa/ANTIGRAVITY-ACCEPTANCE.md)。其中 A05 是整体放行条件：只要 Codex/Claude Code → Antigravity 仍不能创建可重启、可继续的 Antigravity 原生历史，完整支持就不能验收通过。
