# 兼容代码登记表

新增兼容、旧版适配或兜底分支时，在同一个 PR 登记代码位置、保留原因、支持版本和可核验的删除条件。一个分支一条。发版时核对到期条目，删除分支后同步移除登记。已有基线随触及的代码逐步补录。

在手机 App 发布到 TestFlight 前，手机端以 0.35.0 及以上主机为兼容范围。只为更早主机服务的分支标为可删，并在删除前核对 0.35.0 的契约。远程 Web 有外部用户，Web 与主机之间的现有兼容照常保留。桌面旧数据格式的迁移保留至 0.38.0（含），移除前核对从受支持版本升级的数据。

## Tracked branches

CI 读取下表。每条记录写在一行，前两列用反引号包裹仓库相对路径和源码中对应的标识符或注释片段。注释片段须包含用于识别分支的文字，例如 `legacy`、`compat` 或 `fallback`。单元格内避免使用竖线。

| 代码位置 | 标识符或注释片段 | 保留原因 | 支持版本 | 删除条件 |
| --- | --- | --- | --- | --- |
| `apps/desktop/electron/main/application-data-dir.ts` | `migrateLegacyDataDirectory` | 正式桌面应用首次启动时将旧数据目录迁到当前目录，保留用户配置和历史。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认支持的升级起点已使用新目录，旧数据迁移已完成。 |
| `packages/backend/src/store-migrations.ts` | `normalizeLegacyWorkspaceTimestamps` | 把旧 SQLite 工作区和来源记录的时间字段转成当前时间格式。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认支持的升级起点已完成 schema 10 的时间转换，并保留当前格式的建库流程。 |
| `packages/backend/src/agents/claude/claude-bridge.ts` | `#migrateLegacyBindings` | 在旧开发版不再占用绑定登记时，将可迁移的 Claude 终端绑定移入共享后台。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认受支持的升级起点不再留下需要迁移的绑定或待核对请求。 |
| `packages/backend/src/control-receipt.ts` | `legacyPrepared` | 旧控制日志的 prepared 记录缺少设备或操作元数据时，仍提供未派发的凭据，供客户端核对请求。 | 桌面至 0.38.0（含） | 0.38.0 之后，确认升级后的日志已处理旧记录，并核对远端消费者再移除回执形状。 |
| `packages/backend/src/agents/claude/claude-host-state.ts` | `legacy` | `terminalReportReplay` 识别旧交接中工作项 ID 和请求 ID 相同的已导入汇报，核对设备归属并防止把同一汇报再次入队。 | 桌面至 0.38.0（含） | 0.38.0 之后，用受支持的升级起点核对 `terminalReportImports` 已能识别仍可能重放的汇报，重试不会重复入队。 |
| `apps/desktop/electron/main/web/service.ts` | `Legacy hosted clients check this` | `GET /info` 的 `protocolVersion: 1` 供旧版托管 Web 在鉴权前探测主机。早期客户端只接受 `1`，现网托管构建接受 `1` 或 `2`，仍要求该字段。会话协议由 `conversationProtocolVersion` 协商。 | 保留仍支持的托管 Web 构建和已加载的旧页面 | 确认所有受支持的托管 Web 构建仅用新字段完成探测和协商。用候选主机验证配对、历史读取和回执查询，再下一版移除旧字段。 |
| `apps/desktop/electron/main/web/service.ts` | `legacyCodex` | 托管 Web 0.8.0 读取 `GET /codex/capabilities`、`/codex/queue`、`/codex/session-settings`、`/codex/goals`、`/codex/context-options`。当前 Web 仍使用队列、目标和上下文资源的旧读路径。 | 保留仍使用这些路径的托管 Web 构建，现网构建为 `91c3fb5f` | 逐条确认受支持的客户端已改用 `/managed/capabilities`、`/managed/queue`、`/managed/settings`、`/managed/goals`、`/managed/resources`。通过托管网页一起验证跨源预检、原有设备权限、Codex 队列可见范围和响应字段，再删除对应别名。 |
| `apps/desktop/electron/main/web/service.ts` | `legacyOperation` | 托管 Web 0.8.0 的 Codex 界面使用 `POST /codex/{inspect,resume,steer,queue-add,queue-update,queue-delete,queue-reorder,queue-start,rename,archive,unarchive,fork,settings,goal-set,goal-pause,goal-resume,goal-clear}`。当前 Web 在局域网仍用 `queue-delete` 删除等待写锁的消息。保留现有传输和授权限制。 | 保留仍使用这些路径的托管 Web 构建，现网构建为 `91c3fb5f` | 逐条确认受支持的远程客户端迁到通用入口。对局域网单独验证队列删除的原有授权、跨源预检、请求去重和回执，再删除对应别名。 |

## 手机端待清理分支

手机实现位于独立的 `agentkib-flutter` 仓库。下表登记手机端分支的保留期限。主机仍会返回的兼容响应随主机条目核对，例如 `legacy-prepared` 仍用于上面登记的旧桌面控制日志。

| 代码位置 | 保留原因 | 支持版本 | 删除条件 |
| --- | --- | --- | --- |
| [client.dart 的限流等待](https://github.com/starroyhq/agentkib-flutter/blob/4a7eb09925ab602ddea60300b1fd2296e2c97bb0/packages/agentkib_client/lib/src/client.dart#L4430-L4441) | 老主机用尽请求配额后可能省略 `Retry-After`，手机用固定窗口等待。 | 0.35.0 以前的主机 | **可删。** 在 0.35.0 上核对 `rate_limited` 带 `Retry-After`，保留对代理或临时网络异常的安全退避。 |
| [conversation_menu.dart 的旧主机菜单回退](https://github.com/starroyhq/agentkib-flutter/blob/4a7eb09925ab602ddea60300b1fd2296e2c97bb0/lib/conversations/conversation_menu.dart#L88-L100) | 会话目录省略 `projectAgent` 时，手机允许进入项目 Agent 页再向主机核对。 | 0.35.0 以前的主机 | **可删。** 核对 0.35.0 会话目录给受支持和不受支持的会话都提供能力声明，由手机按声明决定入口。 |
