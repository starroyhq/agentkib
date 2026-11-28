# 兼容代码登记表

新增兼容、旧版适配或兜底分支时，在同一个 PR 登记代码位置、保留原因、支持版本和可核验的删除条件。一个分支一条。发版时核对到期条目，删除分支后同步移除登记。已有基线随触及的代码逐步补录。

在手机 App 发布到 TestFlight 前，手机端以 0.35.0 及以上主机为兼容范围。只为更早主机服务的分支标为可删，并在删除前核对 0.35.0 的契约。远程 Web 有外部用户，Web 与主机之间的现有兼容照常保留。桌面旧数据格式的迁移保留至 0.38.0（含），移除前核对从受支持版本升级的数据。

## Tracked branches

CI 读取下表。每条记录写在一行，前两列用反引号包裹仓库相对路径和源码中对应的标识符或注释片段。注释片段须包含用于识别分支的文字，例如 `legacy`、`compat` 或 `fallback`。单元格内避免使用竖线。

| 代码位置 | 标识符或注释片段 | 保留原因 | 支持版本 | 删除条件 |
| --- | --- | --- | --- | --- |
| `packages/backend/src/orchestration-tool-results.ts` | `legacyPanelStopReason` | 停止 Worker 时，原生运行器已不可用仍使用旧 RPC `detail: project-agent-failed`，具体原因由 `reason: session-runner-unavailable` 返回。 | 仍读取旧 RPC 主码的项目 Agent 面板客户端，包括 0.36.4 | 所有受支持的面板已读取 `reason`，并核对旧主码的任何依赖已移除后，删除映射。 |
| `apps/desktop/electron/main/quit-work-preview.ts` | `The catalog fallback can warn about work.` | 旧后台不提供退出预检时，从目录读取仍在运行的任务供用户确认。目录只用于提醒，续跑票据来自当前后台核验。 | 仍可连接未实现 `quitWork.prepare` 的同机后台版本 | 最早受支持后台均实现预检后，用空任务、读失败和旧后台夹具核对，再移除旧版 RPC 分支。 |
| `apps/desktop/test/read-state-claude-history.test.ts` | `legacyReport` | 核对旧桥接插件以 `isMeta` 写入的汇报仍有独立原生轮次，且已读只能使用当前记录的回复。 | 可读取含旧桥接汇报的 Claude Code 记录的宿主 | 确认所有受支持的历史和导入来源均不再含这一形状后，移除配套识别和测试。 |
| `apps/desktop/electron/main/application-data-dir.ts` | `migrateLegacyDataDirectory` | 正式桌面应用首次启动时将旧数据目录迁到当前目录，保留用户配置和历史。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认支持的升级起点已使用新目录，旧数据迁移已完成。 |
| `packages/backend/src/store-migrations.ts` | `normalizeLegacyWorkspaceTimestamps` | 把旧 SQLite 工作区和来源记录的时间字段转成当前时间格式。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认支持的升级起点已完成 schema 10 的时间转换，并保留当前格式的建库流程。 |
| `packages/backend/src/session-store.ts` | `Legacy Antigravity ACP index failure` | 已有目录状态可能把 ACP 停用写成读取失败。首次重新索引前隐藏该原因，保留其他原因和缓存。 | 桌面旧数据升级至 0.38.0（含），以及仍受支持的旧库恢复 | 0.38.0 之后，在所有受支持的升级和恢复路径中先持久清理目录状态里的 `antigravity-acp-disabled`，包括从未刷新过的工作区。用旧库夹具核对单独停用与混合错误，确认其他原因、上次成功时间和缓存完整保留后删除读时分支。 |
| `packages/backend/src/agents/claude/claude-bridge.ts` | `#migrateLegacyBindings` | 在旧开发版不再占用绑定登记时，将可迁移的 Claude 终端绑定移入共享后台。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认受支持的升级起点不再留下需要迁移的绑定或待核对请求。 |
| `packages/claude-bridge-plugin/hooks/register.js` | `Host compatibility` | 宿主未声明从原生记录读取历史时，快照仍带消息和工具预览。 | 0.5.13 及以上插件连接仍受支持的旧宿主 | 所有受支持宿主均声明 `terminal-transcript-history` 后删除快照预览读取。 |
| `apps/desktop/electron/main/web/claude-dispatch.ts` | `Same-version legacy runtimes` | 同版本的旧后台拒绝终端显示字段时，使用原请求取得会话状态。 | 同版本连接至 0.36.2 的早期后台构建 | 所有可共享的后台构建均接受终端显示字段后移除。 |
| `apps/desktop/electron/main/web/catalog-stream.ts` | `Legacy catalog patch v1` | `catalogPatch=1` 仍接收能表示的字段补丁，新增、移除、改名和归档等 v2 更新降级为整目录失效，供旧客户端重读。 | 仍受支持的 `catalogPatch=1` 客户端，包括已载入的旧 Web 页面 | 确认受支持的 Web、桌面和手机客户端均已停止请求 v1 补丁。核对 v2 仍收到行更新，未请求补丁的客户端仍收到整目录失效，再移除此 v1 专用降级。 |
| `packages/runtime-protocol/src/conversation-tools.ts` | `Legacy tool preview wire IDs` | 终端 Claude 工具预览仅用原生 ID 的前缀形式发送和撤销，避免旧 Web 把已落盘的工具当成预览覆盖或删除。 | 会话流协议 v2 的客户端，包括已载入的旧 Web 页面 | 仅在受支持客户端均升级到区分预览与原生行的替代协议后移除，核对两个到达顺序和有界快照中的撤销。 |
| `packages/backend/src/conversation-read-state.ts` | `Legacy clients require a current version` | 证明暂缺时返回 `version: null`，让旧客户端按原有规则等待，证明恢复后可自动确认。显式标记仍可使用 `manualVersion`。 | 仍受支持但忽略 `canAcknowledge` 的 Flutter 客户端（已核对 `0296c874`）和 Web 页面（包括 0.36.3） | 确认所有仍受支持的手机、桌面和已载入的 Web 客户端均识别 `canAcknowledge`，并验证证明暂缺时不提交、恢复后只提交一次，再移除空 `version` 的兼容分支。 |
| `packages/backend/src/agents/claude/claude-terminal-display.ts` | `Native completion fallback` | 终端还在送达结束事件时，以已观察到的原生轮次完成恢复界面状态，保留终端的写入权限和回执。 | 支持桥接的 Claude Code 原生记录 | 已验证所有支持的终端插件在慢历史读取期间仍可及时送达结束和状态事件后核对移除。 |
| `apps/desktop/test/claude-bridge.test.ts` | `CLAUDE_BRIDGE_COMPATIBILITY` | 验证主机只对当前连接中声明支持的终端插件公开 Worker 设置工具。 | 声明该功能的主机及支持连接的插件 | 终端桥不再需要逐连接协商 Worker 设置工具后移除对应夹具。 |
| `packages/claude-bridge-plugin/tests/bridge.test.ts` | `CLAUDE_BRIDGE_COMPATIBILITY` | 验证新插件连接未声明 Worker 设置工具的主机时保留原工具集合。 | 0.5.10 插件与仍支持连接的主机 | 最低受支持的主机均提供 Worker 设置工具后移除对应夹具。 |
| `packages/backend/src/agents/claude/claude-bridge.ts` | `Legacy lead readiness` | 旧终端插件只声明能注册工具，未确认当前工具清单已注册。保留角色资格和派工能力，就绪状态返回未知。 | 仍支持连接且不发送工具注册回执的 Claude 插件 | 核对最低受支持的插件会在每次桥接租约上发送注册回执后移除未知分支。 |
| `packages/claude-bridge-plugin/hooks/register.js` | `Legacy host poll shape` | 旧主机未声明 `lead-tools-registration` 时保持原轮询字段。 | 仍支持连接且未声明工具注册回执的主机 | 核对最低受支持主机会协商并处理注册回执后移除降级。 |
| `packages/backend/src/agents/claude/claude-question-history.ts` | `nativeAnswerFallback` | 结构化答案缺失时，用完整的 Claude 原生结果文本和同 ID 的原始题目恢复问答。 | AgentKib 支持读取的 Claude Code 会话记录 | 确认所有受支持的原生记录及导入来源都保存结构化答案后移除。 |
| `packages/backend/src/control-receipt.ts` | `legacyPrepared` | 旧控制日志的 prepared 记录缺少设备或操作元数据时，仍提供未派发的凭据，供客户端核对请求。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认升级后的日志已处理旧记录，并核对远端消费者再移除回执形状。 |
| `packages/backend/src/local-runtime-trace.ts` | `legacy timing-only request rows` | 旧诊断行只有耗时，仍可读取并计为 `unclassified`。 | 尚可从 0.36.2 及以前版本升级的桌面 | 确认支持的升级起点均已写入结果字段，且旧诊断文件不再需要导出。 |
| `packages/backend/src/local-runtime-request-result.ts` | `rpcIncompatibleProtocol` | 将版本不匹配的既有握手错误记录为固定原因。其他方法报告同一 RPC 数值时不推断版本不匹配。 | 仍使用此握手错误的本机后台 | 停止用此 RPC 数值报告握手版本不匹配后移除对应诊断分支。 |
| `apps/desktop/electron/main/web/conversation-transport.ts` | `REMOTE_LEGACY_CODEX` | 对仍受支持的 Codex 旧 POST 判断控制请求，并让追踪只记录登记过的操作。 | 仍使用旧 POST 的托管 Web 构建 | 核对受支持客户端全部迁到通用入口，删除旧 POST 时同步移除该分支。 |
| `apps/desktop/electron/main/web/conversation-transport.ts` | `The remaining legacy POSTs are control requests` | 旧 Codex 写操作继续使用控制回执和预检，旧 `inspect` 仍是只读。 | 仍使用旧 POST 的托管 Web 构建 | 删除保留的 Codex 旧 POST 后移除该分支。 |
| `apps/desktop/electron/main/web/conversation-transport.ts` | `A compatibility projection` | 工作区已不可访问时返回空的禁用实时状态，旧客户端可继续按原有形状读取。 | 仍使用旧式逐项工作区授权的远程客户端 | 核对所有支持的远程客户端都能将工作区拒绝与设备撤销区分处理后，改为直接拒绝。 |
| `apps/desktop/electron/main/web/conversation-transport.ts` | `Older mobile compatibility` | 在详情流发出空的不可用通知，避免旧手机将工作区范围变化误认成设备撤销。 | 将详情流握手 403 当作设备撤销的手机构建 | 最低支持的手机构建能区分工作区拒绝和设备撤销后，核对重新连接和目录刷新再移除。 |
| `apps/desktop/test/managed-session-catalog.test.ts` | `approveLegacyBrowser` | 使用旧逐项配对夹具核对普通 Codex 已授权详情在全量目录读取失败时仍可读。 | 仍可使用逐项授权的旧配对凭据 | 移除逐项授权的配对凭据后，把整目录失败用例迁到当前配对夹具。 |
| `packages/backend/src/agents/codex/session-provider.ts` | `legacyUpgradeProof` | 旧版退出时可能只保存了超长轮次已中断的检查点。对待续跑的升级记录，用原生中断标记重新核对，防止升级后漏跑。 | 从 0.36.1 及以前升级，桌面保留至 0.38.0（含） | 0.38.0 后，确认受支持的升级起点会保存超长轮次的退出指纹。 |
| `packages/backend/src/agents/codex/desktop-follower.ts` | `Codex desktop IPC compatibility: confirmed no listener while the app is running.` | Codex App 仍持写锁但明确没有跟随监听时，保留原生轮次和归属，禁用跟随发送、停止，等已核验的 IPC 或释放写锁。 | macOS 上仍在使用的无跟随监听版本，已核实 26.1120.50957（30866） | 确认所有受支持版本恢复了可核验的跟随控制，或旧跟随通道完全被具有同等归属校验的替代方案取代后删除。 |
| `apps/desktop/test/codex-large-history.test.ts` | `legacy` | 用 Codex 的 `event_msg.user_message` 夹具核对直接的 `client_id`，避免与分页存储形状混淆。 | 仍可读取两种 Codex rollout 存储形状的版本 | 原生历史读取停止支持 `event_msg.user_message` 后移除对应夹具。 |
| `packages/backend/src/agents/claude/claude-host-state.ts` | `legacy` | `terminalReportReplay` 识别旧交接中工作项 ID 和请求 ID 相同的已导入汇报，核对设备归属并防止把同一汇报再次入队。 | 桌面至 0.38.0（含） | 0.38.0 之后，用受支持的升级起点核对 `terminalReportImports` 已能识别仍可能重放的汇报，重试不会重复入队。 |
| `apps/desktop/electron/main/web/service.ts` | `Legacy hosted clients check this` | `GET /info` 的 `protocolVersion: 1` 供旧版托管 Web 在鉴权前探测主机。早期客户端只接受 `1`，现网托管构建接受 `1` 或 `2`，仍要求该字段。会话协议由 `conversationProtocolVersion` 协商。 | 保留仍支持的托管 Web 构建和已加载的旧页面 | 确认所有受支持的托管 Web 构建仅用新字段完成探测和协商。用候选主机验证配对、历史读取和回执查询，再下一版移除旧字段。 |
| `apps/desktop/electron/main/push/policy.ts` | `legacyVersion` | 未显式请求版本 2 的客户端继续收到 `pushPolicyVersion: 1`。旧手机和桌面设置面板用精确版本判断，仍能读取和局部更新原有字段。 | 仍受支持的只接受通知策略版本 1 的客户端 | 核对支持范围内的客户端均能读取版本 2，并验证旧式局部更新保留 Worker 结果设置后，移除版本 1 降级。 |
| `apps/desktop/electron/main/push/policy.ts` | `Preserve the legacy disk shape` | 原 `notification-policy.json` 始终写严格的 v1 形状。新开关单独存于版本化的 `notification-worker-results.json`，缺失或损坏时仅该开关按关闭处理。旧桌面读取和保存原有策略只接触原文件。 | 支持降级至严格解析 v1 策略的旧桌面，含 0.36.4 和 0.36.5 | 确认所有受支持的降级目标均能读取新合并格式，且受支持的升级路径已无须读取分文件数据后，才合并存储并移除旧文件适配。 |
| `apps/desktop/electron/main/push/policy.test.ts` | `legacyStoredPolicy` | 用冻结的 0.36.4 严格读取规则验证开启 Worker 结果后可降级读取及编辑原策略，再升级仍保留开关。 | 与策略磁盘 v1 保持兼容的桌面版本 | 移除策略磁盘兼容后同步移除冻结的读取器和降级断言。 |
| `packages/runtime-protocol/src/generated/remote-contract.ts` | `legacyVersion` | 由契约生成通知策略版本 1 的线值，供新宿主响应旧客户端。 | 仍受支持的只接受通知策略版本 1 的客户端 | 移除版本 1 降级时从契约删去此字段并重新生成 TS 和 Dart。 |
| `packages/runtime-protocol/test/remote-contract.test.ts` | `legacyVersion` | 验证版本 1 探测响应与生成契约一致。 | 仍受支持的只接受通知策略版本 1 的客户端 | 移除版本 1 降级时删除相应断言。 |
| `packages/runtime-protocol/test/remote-contract.test.ts` | `legacy` | 用共享夹具验证旧客户端提交策略时可以省略新字段。 | 仍受支持的省略 Worker 结果设置的客户端 | 移除旧客户端兼容后同步调整夹具和断言。 |
| `packages/web-client/src/index.ts` | `legacyVersion` | 访问能力类型接受版本 1，保留旧宿主上的原有策略面板。 | 仍受支持的只公布通知策略版本 1 的宿主 | 所有受支持宿主均能协商版本 2 后缩小响应类型。 |
| `apps/desktop/electron/main/web/service.ts` | `legacyCodex` | 托管 Web 0.8.0 读取 `GET /codex/capabilities`、`/codex/queue`、`/codex/session-settings`、`/codex/goals`、`/codex/context-options`。当前 Web 仍使用队列、目标和上下文资源的旧读路径。 | 保留仍使用这些路径的托管 Web 构建，现网构建为 `91c3fb5f` | 逐条确认受支持的客户端已改用 `/managed/capabilities`、`/managed/queue`、`/managed/settings`、`/managed/goals`、`/managed/resources`。通过托管网页一起验证跨源预检、原有设备权限、Codex 队列可见范围和响应字段，再删除对应别名。 |
| `apps/desktop/electron/main/web/service.ts` | `legacyOperation` | 托管 Web 0.8.0 的 Codex 界面使用 `POST /codex/{inspect,resume,steer,queue-add,queue-update,queue-delete,queue-reorder,queue-start,rename,archive,unarchive,fork,settings,goal-set,goal-pause,goal-resume,goal-clear}`。当前 Web 在局域网仍用 `queue-delete` 删除等待写锁的消息。保留现有传输和授权限制。 | 保留仍使用这些路径的托管 Web 构建，现网构建为 `91c3fb5f` | 逐条确认受支持的远程客户端迁到通用入口。对局域网单独验证队列删除的原有授权、跨源预检、请求去重和回执，再删除对应别名。 |
| `packages/backend/src/remote-tls.ts` | `LEGACY_HISTORY_ERROR_CODES` | 已配对电脑的 TLS v1 历史失败保留旧 `error`，细分原因通过可选的 `reason` 传递。 | 支持 TLS v1 的新旧桌面，含 0.36.4 及更早客户端 | 新的桌面协议主版本直接登记细分错误，且所有支持的对端都已迁出 TLS v1 后，移除旧线码和配对映射。 |
| `apps/desktop/test/remote-tls-native.test.ts` | `readLegacyHistoryFrame` | 用 TLS v1 原始响应帧核对旧桌面消费的错误字段。 | 仍需和 TLS v1 旧客户端互通的版本 | 不再支持 TLS v1 旧客户端时，随宿主的旧线码映射移除此夹具。 |

## 已停发的错误码

| 契约位置 | 错误码 | 保留原因 | 支持版本 | 删除条件 |
| --- | --- | --- | --- | --- |
| `packages/runtime-protocol/remote-contract.json` 的 `managedSessionLimit` | `managed-session-limit` | 让客户端识别旧主机的 Codex 托管会话限额。 | 仍受支持的 0.36.0 及较早主机 | 确认所有受支持的主机和客户端均已跨过移除并发限额的版本，旧回执也无需再解析该值。 |
| `packages/runtime-protocol/remote-contract.json` 的 `liveSessionLimit` | `live-session-limit` | 让客户端识别旧主机的 Antigravity 和 Devin 运行会话限额。 | 仍受支持的 0.36.0 及较早主机 | 确认所有受支持的主机和客户端均已跨过移除并发限额的版本，旧回执也无需再解析该值。 |

## 项目 Agent 的兼容错误字段

| 契约位置 | 原线码 | 保留原因 | 支持版本 | 删除条件 |
| --- | --- | --- | --- | --- |
| `packages/runtime-protocol/remote-contract.json` 的 `leadRequiresManagedClaude` | `lead-requires-managed-claude` | 旧调用方读取 HTTP `error` 和 RPC `detail`。新调用方读取同一拒绝上可选的 `reason`。 | 仍受支持的 0.36.2 及更早客户端 | 所有受支持客户端已读取具体原因。 |
| `packages/runtime-protocol/remote-contract.json` 的 `workerUnavailable` | `worker-unavailable` | 旧调用方仍能识别旧的冲突响应。新原因区分已移出、终端断连、不可控和探测失败。 | 仍受支持的 0.36.2 及更早客户端 | 所有受支持客户端已读取具体原因，旧主机的回执也无需解析该值。 |

## 手机端待清理分支

手机实现位于独立的 `agentkib-flutter` 仓库。下表登记手机端分支的保留期限。主机仍会返回的兼容响应随主机条目核对，例如 `legacy-prepared` 仍用于上面登记的旧桌面控制日志。

| 代码位置 | 保留原因 | 支持版本 | 删除条件 |
| --- | --- | --- | --- |
| [client.dart 的限流等待](https://github.com/starroyhq/agentkib-flutter/blob/4a7eb09925ab602ddea60300b1fd2296e2c97bb0/packages/agentkib_client/lib/src/client.dart#L4430-L4441) | 老主机用尽请求配额后可能省略 `Retry-After`，手机用固定窗口等待。 | 0.35.0 以前的主机 | **可删。** 在 0.35.0 上核对 `rate_limited` 带 `Retry-After`，保留对代理或临时网络异常的安全退避。 |
| [conversation_menu.dart 的旧主机菜单回退](https://github.com/starroyhq/agentkib-flutter/blob/4a7eb09925ab602ddea60300b1fd2296e2c97bb0/lib/conversations/conversation_menu.dart#L88-L100) | 会话目录省略 `projectAgent` 时，手机允许进入项目 Agent 页再向主机核对。 | 0.35.0 以前的主机 | **可删。** 核对 0.35.0 会话目录给受支持和不受支持的会话都提供能力声明，由手机按声明决定入口。 |
