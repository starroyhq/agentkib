# 兼容代码登记表

新增兼容、旧版适配或兜底分支时，在同一个 PR 登记代码位置、保留原因、支持版本和可核验的删除条件。一个分支一条。发版时核对到期条目，删除分支后同步移除登记。已有基线随触及的代码逐步补录。

在手机 App 发布到 TestFlight 前，手机端以 0.35.0 及以上主机为兼容范围。只为更早主机服务的分支标为可删，并在删除前核对 0.35.0 的契约。远程 Web 有外部用户，Web 与主机之间的现有兼容照常保留。

## Tracked branches

每条记录写在一行，前两列用反引号包裹仓库相对路径和源码中对应的标识符或注释片段。注释片段须包含用于识别分支的文字，例如 `legacy`、`compat` 或 `fallback`。单元格内避免使用竖线。

| 代码位置 | 标识符或注释片段 | 保留原因 | 支持版本 | 删除条件 |
| --- | --- | --- | --- | --- |
| `apps/desktop/electron/main/web/service.ts` | `Legacy hosted clients check this` | `GET /info` 的 `protocolVersion: 1` 供旧版托管 Web 在鉴权前探测主机。早期客户端只接受 `1`，现网托管构建接受 `1` 或 `2`，仍要求该字段。会话协议由 `conversationProtocolVersion` 协商。 | 保留仍支持的托管 Web 构建和已加载的旧页面 | 确认所有受支持的托管 Web 构建仅用新字段完成探测和协商。用候选主机验证配对、历史读取和回执查询，再下一版移除旧字段。 |
| `apps/desktop/electron/main/web/service.ts` | `legacyCodex` | 托管 Web 0.8.0 读取 `GET /codex/capabilities`、`/codex/queue`、`/codex/session-settings`、`/codex/goals`、`/codex/context-options`。当前 Web 仍使用队列、目标和上下文资源的旧读路径。 | 保留仍使用这些路径的托管 Web 构建，现网构建为 `91c3fb5f` | 逐条确认受支持的客户端已改用 `/managed/capabilities`、`/managed/queue`、`/managed/settings`、`/managed/goals`、`/managed/resources`。通过托管网页一起验证跨源预检、原有设备权限、Codex 队列可见范围和响应字段，再删除对应别名。 |
| `apps/desktop/electron/main/web/service.ts` | `legacyOperation` | 托管 Web 0.8.0 的 Codex 界面使用 `POST /codex/{inspect,resume,steer,queue-add,queue-update,queue-delete,queue-reorder,queue-start,rename,archive,unarchive,fork,settings,goal-set,goal-pause,goal-resume,goal-clear}`。当前 Web 在局域网仍用 `queue-delete` 删除等待写锁的消息。保留现有传输和授权限制。 | 保留仍使用这些路径的托管 Web 构建，现网构建为 `91c3fb5f` | 逐条确认受支持的远程客户端迁到通用入口。对局域网单独验证队列删除的原有授权、跨源预检、请求去重和回执，再删除对应别名。 |
