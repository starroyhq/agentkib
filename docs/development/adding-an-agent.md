# 新增一个 Agent

接入一个新 Agent 时要改的地方。分两档：只读取它的会话和资产；以及由 AgentKib 新建会话、发送、审批、回答和停止的受控 Agent。受控 Agent 要先完成只读那一档。

## 只读：发现、会话历史和资产

**名称和图标**

- `packages/agent-identity/src/index.tsx`：显示名称和图标（SVG 放在同目录的 `assets/`）。桌面和 Web 都从这里取名字。

**Agent 种类**：下面几处列出全部 Agent，新 Agent 要逐一加上。其中用 `Record<AgentKind, …>` 的地方，漏了会编译不过。

- `apps/desktop/src/core/types.ts`：`AgentKind`。
- `apps/desktop/src/core/agents.ts`：`AGENT_ORDER`，决定各处列表里的顺序。
- `apps/desktop/electron/main/ipc/validation.ts`：`AGENT_KINDS`，IPC 只接受登记过的 Agent。
- `packages/web-client/src/index.ts`：会话摘要的 `agent` 类型。
- `apps/desktop/src/features/agents/AgentsPage.tsx`：Agent 页的列表。
- `apps/desktop/src/features/insights/insights.ts`：`insightsAgentKinds`，洞察页统计哪些 Agent。
- `packages/runtime-protocol/src/mcp-management.ts`：要给它配置 MCP 时才加。

**后端**（`packages/backend/src`）：每个 Agent 有自己的读取适配，参考已有的 Agent。

- 发现：`native-discovery-configured.ts`；
- 会话读取：`session-readers.ts`，加上它自己的读取模块（如 `antigravity-sessions.ts`）；
- 上下文和诊断：`context.ts`、`doctor.ts`；
- Skill：`skill-manager.ts`；
- 用量：`usage-providers.ts`；
- 交接：`session-handoff-launch.ts`。

**文档**：`docs/FEATURES.md` 的 Agent 支持表；需要单独说明的，在 `docs/agents/` 下加一篇，并登记到 `docs/README.md`。

## 受控：在 AgentKib 里新建和控制会话

**登记**

- `packages/runtime-protocol/src/agents.ts`：加进 `MANAGED_AGENTS`。
  - 两端会话页、首页、菜单栏、待核对记录、新建会话的默认目标，以及主进程 Web 服务的检查，都读这一份；`web-client` 原样转出 `ManagedAgent` 和 `managedAgentOf`。
  - 用 `Record<ManagedAgent, …>` 的地方，漏了会编译不过。
- 只能在会话页继续、不能新建的 Agent（如 Antigravity），加进同一文件的 `LIVE_SESSION_AGENTS`。

**会话 Provider**

- 在 `packages/backend/src/session-provider.ts` 注册 Agent 的实时状态、能力查询、操作和上下文用量。支持新建的 Agent 同时接入创建和设置。Antigravity 通过 ACP 接入已有会话。原生参数和回执校验放在各自适配器。
- 在 `packages/runtime-protocol/src/session-providers.ts` 声明会话详情、已读、输入框和创建能力。桌面和 Web 共用详情页、记录和输入框组件。共用控件读取主机返回的可用性、实际模型目录和可写字段。
- `/managed/options`、`/managed/create`、`/managed/capabilities`、`/managed/settings` 和 `/managed/action` 走统一入口。已有会话由后端确认所属 Agent。Claude Code 使用所选工作区的模型目录，显式选择的启动模型需原生确认。连接终端后使用终端实际提供的能力。
- DeepSeek Harness 由桥接插件提供 Agent 预设、按提供方分组的模型目录和各模型的推理档位。实际可选项以插件返回为准。插件暂未上报占用量，桌面和 Web 隐藏上下文用量控件。
- 工作区授权、设备权限、会话修订号和回执仍在主机与后端校验。旧请求路径继续由同一个适配器处理。

**新建会话的展示配置**（`packages/session-ui/src/new-session.ts`）

- `NewSessionAgent` 和 `NEW_SESSION_AGENTS`：必须和 `MANAGED_AGENTS` 一致，`apps/web/src/managed-agents.test.ts` 会检查。
- `PERMISSIONS`：权限选项，用这个 Agent 自己的说法，四种语言。
- 支持新建预设时在 Provider 声明 `create.agentPresets`，会话开始后按原生权限能力显示设置。

**主机**

- 后端的受控适配：新建、发送、审批、回答、停止、读取实时状态，以及控制回执（参考 `codexManaged`、`claudeManaged` 和 DSH 插件桥）。新的运行时方法登记在 `packages/runtime-protocol` 的 `RUNTIME_METHODS`。
- 旧请求的兼容路由和 Provider 专属的权限规则位于 `apps/desktop/electron/main/web/service.ts`。会话发送、审批和停止继续使用现有的执行适配。
- 回执：`web-client` 的 `needsDurableReceipt` 认为受控 Agent 都会留下回执，所以适配必须写控制回执，否则结果不明时没法核对。

**各 Agent 自己的界面**（按需）

- 会话页的提示、队列、工具菜单、会话设置等，参考 Codex（`codex-session-controls.tsx`、`codex-tools.tsx`）和 DSH（`dsh-queue.tsx`）。
- 会话页桌面和 Web 各有一份（`apps/desktop/src/features/sessions/conversation/` 和 `apps/web/src/features/conversation/`），两边要一起改。
