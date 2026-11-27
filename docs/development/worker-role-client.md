# Worker 职责接线

- 桌面和 Web 的项目 Agent 面板从 `lead.workers[].role` 读取职责。字段包括 `label`、`description`、`updatedBy`（`user` 或 `project-agent`）和 ISO 8601 时间 `updatedAt`。同一行的 `title` 仍是当前任务。
- `lead.roleChanges` 是按时间排列的职责活动，包含 `workerSessionId`、`roleLabel`、`updatedBy`、`updatedAt`。空数组也表示主机已经提供职责编辑。配对设备只能看到授权范围内可见 Worker 的活动，`roleLabel: null` 表示清除。
- 保存用桌面 IPC `lead-worker-role` 或 `POST /api/web/v1/managed/project-agent` 的 `worker-role`。两边都传 `sessionId`（项目 Agent）、`worker`（Worker 会话 ID）和 `role: { label, description }`。传 `role: null` 清除。使用响应中的 `lead` 刷新面板。主机填写修改者和时间。
- 配对设备按照现有「修改设定」权限显示并启用编辑。主机会核对项目 Agent 和 Worker 的工作区，以及修改设定需要的权限。`workspace_not_authorized` 表示工作区权限不足，`invalid_input` 表示内容不符合契约。角色标签 1–48 个字符且占一行，说明 1–1200 个字符。使用 `REMOTE_WORKER_ROLE_CONTRACT.input` 中的长度限制。
- 职责预设由客户端提供，选择后把标签和说明填进表单，用户可再编辑。主机只存最终文字。
- 汇报卡从 `ConversationEvent.worker_reports.parts[].workerRoleLabel` 读取汇报所记录的职责标签。该字段可缺省。显示老汇报时使用汇报自带的数据。
