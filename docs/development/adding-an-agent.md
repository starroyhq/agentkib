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

**新建会话**（`packages/session-ui/src/new-session.ts`）

- `NewSessionAgent` 和 `NEW_SESSION_AGENTS`：必须和 `MANAGED_AGENTS` 一致，`apps/web/src/managed-agents.test.ts` 会检查。
- `PERMISSIONS`：权限选项，用这个 Agent 自己的说法，四种语言。
- `PRESET_AGENTS`：它有预设时才加。

**主机**

- 后端的受控适配：新建、发送、审批、回答、停止、读取实时状态，以及控制回执（参考 `codexManaged`、`claudeManaged` 和 DSH 插件桥）。新的运行时方法登记在 `packages/runtime-protocol` 的 `RUNTIME_METHODS`。
- `apps/desktop/electron/main/web/service.ts`：把这个 Agent 的 `/managed/options`、新建和会话操作分到它的适配。这两处是对 `ManagedAgent` 的穷举 `switch`，加进登记表后编译会停在 `unhandledManagedAgent`，补上它的 `case` 即可。
- 回执：`web-client` 的 `needsDurableReceipt` 认为受控 Agent 都会留下回执，所以适配必须写控制回执，否则结果不明时没法核对。

**各 Agent 自己的界面**（按需）

- 会话页的提示、队列、工具菜单、会话设置等，参考 Codex（`codex-session-controls.tsx`、`codex-tools.tsx`）和 DSH（`dsh-queue.tsx`）。
- 会话页桌面和 Web 各有一份（`apps/desktop/src/features/sessions/conversation/` 和 `apps/web/src/features/conversation/`），两边要一起改。
