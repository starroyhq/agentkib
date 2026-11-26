# Antigravity 接入与会话能力

Antigravity 不能直接复用 Gemini CLI 的会话适配器。两者共享 `GEMINI.md`、`.agents/skills` 和 MCP 配置约定，但会话存储、控制协议和可验证能力不同。AgentKib 将配置资产适配与会话协议适配分开实现。

## 当前版本为只读会话接入

Google 限制在消费者登录下使用 Antigravity 作为第三方 Agent 或后台编排的执行端。AgentKib 因此停用 Antigravity 的 ACP 控制，也暂停已有项目 Agent、Worker 指派和待发队列的自动发送。桌面、Web 和手机的相关操作保持可见并置灰。ACP 连接实现保留给内部兼容测试。参见 [Google Antigravity FAQ](https://antigravity.google/docs/faq)、[附加服务条款第 6 节](https://antigravity.google/terms)和[官方协作者说明](https://github.com/google-antigravity/antigravity-cli/issues/1493)。

Antigravity App 和 IDE 的可读历史、AgentKib 以前创建且能在本地核验的会话，以及配置资产管理仍然可用。本地有可读内容时，可以预览并导入 Codex、Claude Code 或 OpenCode 等现有目标。只在 ACP 服务中可回放的旧会话保留已索引的元数据，正文需要原生 `session/load`。

## 当前适配基线

| 组件                   | 已验证版本 | 用途                                                                                 |
| ---------------------- | ---------- | ------------------------------------------------------------------------------------ |
| Antigravity CLI        | 1.5.14     | 安装检测、版本检测；`agy acp` 提供与 Antigravity App 共用会话的 ACP 服务             |
| Antigravity ACP server | 1.1.1      | 旧版独立服务：ACP v1 会话列表、加载、续接、发送、停止和逐次审批                      |
| ACP protocol           | v1         | `session/list`、`session/load`、`session/resume`、`session/prompt`、`session/cancel` |

内部兼容测试的 ACP 连接可从绝对路径环境变量 `AGENTKIB_ANTIGRAVITY_ACP_BIN` 查找服务器，也可从 PATH 查找旧版 `agy_acp_server.par`、`agy_acp_server.exe` 或新版 `agy acp`。发送、停止和审批的协议测试校验服务端身份及版本。旧版独立服务报告 `antigravity-acp`，版本完整匹配 `agy_acp_server_数字.数字.数字` 且不低于 `1.1.1`。新版 CLI 报告 `Antigravity ACP Server`，版本为三段数字且不低于 `1.5.14`。

上下文占用仅接收原生 `usage_update.used` 与 `size`，缺失或无效时保持未知。连接声明可选的 ACP v1 `session.compaction` 扩展；收到压缩通知时按原生 `compactionId` 保存有界生命周期、摘要块及 nullable patch，首次接收位置保持不变，历史允许从终态开始。未知状态不能确认压缩结束；压缩结束也不能确认当前轮次结束。压缩期间禁用新发送，保留停止及有效原生审批；没有这些通知时只依赖原有运行状态锁。扩展处理与离线测试通过不证明已安装服务器实际会上报它们。

压缩期间的合法用量报告保留为待确认候选，包括连续压缩或模型切换后开始的压缩。压缩结束后仍显示“用量待更新”；只有普通请求或输出边界之后的新原生报告才能恢复当前占用比例，结束通知本身不会使候选报告变为当前值。

每次新建 ACP runner 都分配当前 Backend 内递增的用量报告代次。重连后的报告编号可以重新从 1 开始；桌面和 Remote 持续订阅时，也能按代次撤销旧实例报告并接受新报告。模型切换、压缩和同一连接内的状态更新保留该代次。

## 本机 App / IDE 只读浏览

会话目录独立发现 `~/.gemini/antigravity`（App）与 `~/.gemini/antigravity-ide`（IDE），不要求安装 ACP。只读打开 `conversation_summaries.db`，或读取 `agyhub_summaries_proto.pb` 的已核验摘要字段；只将有可信工作区、原生 ID 与对应历史文件的条目加入项目。迁移到两个目录的同 ID、同工作区会话择更新时间较新的来源，时间相同时优先使用 App，只显示一份。缺少摘要、无法证明工作区的孤立 `.pb` 不猜测归属。

原生应用已运行时，通过其当前用户私有 daemon 元数据找到已认证的本机 HTTP 服务，仅调用列举与读取历史方法；不启动后台 agent，不发送、恢复或接管会话。请求直连固定的 `127.0.0.1`，绕过 HTTP 代理并禁止重定向，不记录或传给前端 daemon 的认证凭据。App 2.24.0 的 `GetCascadeTrajectorySteps` 已实际核验：使用 PROD_UI 投影读取用户输入与助手可见答复，排除 planner thinking；工具细节、附件等未投影内容保留部分历史提示。

应用关闭或首次原生读取失败时，可回退到本来源的 SQLite 搜索索引。运行中的数据库使用 SQLite 只读事务，已关闭的 WAL 库读取时不会创建辅助文件。正文从尾部按页取对应的块，按原生 step 与 UTF-8 字节偏移恢复文字顺序，明确显示部分历史，不将它当作完整 transcript。离线分页游标绑定来源和数据库及 WAL 的版本。翻页期间不自动切换在线/离线来源。离线缺少正文索引或本库工作区摘要的会话只显示元数据。IDE 原生目录补全使用运行中 daemon 的只读摘要能力；本机缺少 IDE 运行时的记录仅验证离线部分，不能声称全部旧 IDE 历史已恢复。

App / IDE 读取由串行、有界的后台 Worker 处理。已核验的 daemon 接口返回整段快照，单次响应上限为 32 MiB。读取导入和搜索所需的正文时，一次快照即可投影整段可见消息。

已有会话 ID 会与同一工作区中可核验的本地记录关联。可读的部分历史沿用导入预览、脱敏、损失确认和回读验证流程。

验证入口：`antigravity-local-store.test.ts`、`antigravity-local-runtime.test.ts`、`antigravity-history.test.ts`、`antigravity-local-readonly.test.ts`、`antigravity-modern-acp.test.ts`、`antigravity-runtime-scope.test.ts` 和 `antigravity-continuation.test.ts`，位于 `apps/desktop/test`。使用隔离目录、合成 SQLite/Protobuf、只读 HTTP fixture 与合成 ACP 子进程，不依赖用户凭据或模型调用。

## 已实现范围

- 发现 `agy` CLI 和 Antigravity 桌面应用。
- 读取全局 `~/.gemini/GEMINI.md`、`~/.gemini/antigravity-cli/settings.json`、`~/.gemini/antigravity-cli/skills`、`~/.gemini/antigravity-cli/rules`、`~/.gemini/config/skills` 和 `~/.gemini/config/mcp_config.json`。资产目录同时扫描 CLI 暂存插件 `~/.gemini/antigravity-cli/plugins/*` 与全局插件 `~/.gemini/config/plugins/*`。
- 读取和生成项目 `AGENTS.md`、`GEMINI.md`、`.agents/skills` 与 `.agents/mcp_config.json`；规则扫描支持 `.agents/rules` 和兼容路径 `.agent/rules`，同名时以新路径为准。有效上下文只纳入可确认常驻的工作区/全局规则；Manual、Model Decision、Glob 及未知激活模式保留为资产并显示预览警告。远程 MCP 使用 `serverUrl`，并保留未知 JSON 字段。
- 仅有 `GEMINI.md` 的项目若将其规则提升为共享规则，生成 `AGENTS.md` 的同次变更也会清理 `GEMINI.md` 中的重复内容，即使尚未启用 Antigravity；无法确定旧专用规则与编辑后的规则如何合并时，预览会要求先协调原文。
- 加载项目根 `.agents/plugins/*`、全局 `~/.gemini/config/plugins/*` 以及 CLI 暂存目录 `~/.gemini/antigravity-cli/plugins/*` 中通过 `plugin.json` 校验的插件规则。CLI 插件按官方自动发现语义默认启用，并尊重已验证的配置覆盖和 manifest 默认禁用值；无法解析的显式状态会失败关闭并告警。名称冲突或带有无法可靠解释的 `rules.json` 时同样排除并告警。
- 原生 MCP 迁移会保留无法转换的配置：带静态 OAuth 客户端配置或显式 SSE 传输的服务不会标为可自动迁移；未声明传输的远程服务仍需通过迁移前连接探测。

## ACP 兼容实现（默认停用）

以下记录描述停用前的实现。ACP 1.5.14 的历史验收见 [`qa/antigravity-cli-2026-11-23.md`](../../qa/antigravity-cli-2026-11-23.md)。

- **安装引导**：Antigravity App 不包含 CLI。“设置 › 工具与更新”提供官方安装命令供复制（macOS/Linux `curl -fsSL https://antigravity.google/cli/install.sh | bash`，Windows 为对应的 PowerShell 命令），AgentKib 不替用户执行远程脚本。CLI 装在 `~/.local/bin/agy` 也能被发现。
- **与 App 共用会话**：`agy acp` 的 `session/list` 列出的就是 Antigravity App 的会话。实测 ACP 列出了 App 库里 40 条会话中的 38 条。相同会话只显示一份，ACP 确认可控制时优先使用该来源，只在 App/IDE 本地存储里的条目仍然只读（“请在 Antigravity 中继续”）。
- **受控 Agent**：Antigravity 加入 `MANAGED_AGENTS`。新建会话时在所选工作区 `session/new`，按选择设置模型、推理档位和模式后发出第一条消息；新建选项取自一个不发消息的临时会话（CLI 不保存没有消息的会话）。
- **设置**：模型、推理档位（`thought_level`）和模式（`mode`：default、accept-edits、auto、plan）是会话自己的 ACP 选项，在两轮之间用 `session/set_config_option` 设置，下一轮生效。Antigravity 续接会话时推理档位回到默认值，所以 AgentKib 把用户的选择记在数据目录的 `antigravity-session-settings.json`，每次连接时重新设置。`auto` 会自动执行它认为安全的命令，只接受完全访问的设备。
- **审批**：CLI 的工具参数与旧服务不同（命令为 `CommandLine`，编辑为 `Path`、`Target`、`Replacement` 加上差异），AgentKib 先映射到既有的核对规则：命令显示命令行，编辑以差异显示。对于能完整展示工具名和参数的具名 MCP 请求，也可在会话中审批。参数被脱敏、缺失或无法核对时不可审批。只提供 CLI 给出的“允许一次”和“拒绝”。
- **项目 Agent**：由 AgentKib 控制的 Antigravity 会话可以担任项目 Agent。连接会话时把 `agentkib_workers` 回环端点作为 `mcpServers` 交给 Antigravity，不写入 Antigravity 的配置。AgentKib 按该端点实际登记的工具生成完整名称（如 `mcp_agentkib_workers_worker_list`），精确匹配时自动允许一次，其余审批照常请求确认。代批、代答范围变化后，在两轮之间重新连接以换上新工具。汇报经 AgentKib 的会话控制发出，忙时排队。
- **失败原因**：一轮没能运行或完成时，会话保持可用，输入框上方说明原因：额度或速率限制（`antigravity-usage-limited`）、未登录（`antigravity-login-required`，在终端运行一次 `agy` 登录）或其他失败（`antigravity-run-failed`）。
- **附件与运行中发送**：空闲 ACP 会话按原生协商支持图片和文件。普通文件使用 Markdown 链接，并按协商提供资源内容或链接。内嵌内容合计上限 600 KiB。运行中的消息仍按队列在一轮结束后发送，队列与新建会话的首条消息接收文字。

## 官方接口尚未提供的能力

ACP v1 的 `session/new` 没有导入外部历史的参数。Antigravity CLI 1.2.7 也没有把任意外部 transcript 创建为目标原生会话的稳定命令。因此 Codex/Claude Code → Antigravity 的原生历史导入保持 `native-history-import-unsupported`，不会降级后仍标记为原生导入。

旧版独立 ACP server 使用自己的会话存储（新版 CLI 的 `agy acp` 与 App 共用会话，见上文）。尚无公开稳定接口证明它可以完整列出或控制 Antigravity Desktop/IDE 与 `agy` CLI 已有的全部会话。ACP 来源只索引服务端返回的会话。服务端还须支持 `session/load` 才能读取正文，否则仅展示元数据。未安装可选 ACP server 时，ACP 来源为空，本机 App/IDE 的只读来源仍可使用；不会把 ACP 能力扩大解释为对现有 Desktop/IDE 或 CLI 会话的控制。

## ACP 委派兼容实现（默认停用）

用户可以指派能由 AgentKib 控制的 Antigravity ACP 会话，包括 `agy acp` 1.5.14 起列出且通过校验的 App 会话。只读 App/IDE 条目不能指派。指派保留会话的模型、权限和工作区，首次发送仍须通过 ACP 会话及服务端身份校验。

项目 Agent 可以派任务、读取可见回复、停止当前轮，并按[汇报规则](project-agent.md#汇报)接收轮次结果与等待审批的消息。经用户授权可代办符合委派范围的单次命令或文件变更审批，AgentKib 只回传 ACP 给出的对应一次性选项。AgentKib 当前没有为 Antigravity 接入自由问答或加入本轮。忙时发来的消息排到后续轮次。

用户和项目 Agent 共用会话的待发队列。AgentKib 保留纯文本任务，在上一轮结束且当前授权仍有效时按顺序发送。桌面和 Web 的会话输入框附近可以查看、编辑、移除任务以及暂停和恢复队列。

执行中的 ACP 连接由 AgentKib 持有。断线后没有确认的轮次保持结果待核实，会话回放提供历史消息，缺少可用于补报的终态和时间关联，因此不能补报宿主关闭期间无法核实的轮次。

## 源码与验收

[Antigravity 会话 Provider](../../packages/backend/src/agents/antigravity/session-provider.ts)发布控制能力和可用状态。[历史读取](../../packages/backend/src/agents/antigravity/history-reader.ts)处理本机 App／IDE 与 ACP 记录。已有待发消息仍保存在 AgentKib 的[串行会话队列](../../packages/backend/src/sessions/serial-session-queue.ts)。

[会话基线](../../apps/desktop/test/session-baseline/antigravity.test.ts)覆盖 ACP 会话的发送、停止、审批和排队，以及未核实的控制保持不可用。[CLI 控制测试](../../apps/desktop/test/antigravity-cli-control.test.ts)覆盖首轮设置、轮次之间修改选项、项目 Agent 工具审批以及有明确原因的轮次失败。

完整验收定义、八个跨 Agent 方向、A01–A14 场景和证据要求见 [`qa/ANTIGRAVITY-ACCEPTANCE.md`](../../qa/ANTIGRAVITY-ACCEPTANCE.md)。其中 A05 是整体放行条件：只要 Codex/Claude Code → Antigravity 仍不能创建可重启、可继续的 Antigravity 原生历史，完整支持就不能验收通过。
