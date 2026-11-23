# 新增一个 Agent

受控会话的接入分三步。实现一个 Provider，声明它的能力，需要时再注册专属面板。先完成只读接入，确保 AgentKib 能发现会话并读取历史。

## 只读：发现、会话历史和资产

**名称和图标**

- `packages/agent-identity/src/index.tsx` 提供显示名称和图标，SVG 放在同目录的 `assets/`。桌面和 Web 都从这里取名字。

**Agent 种类**

- `apps/desktop/src/core/types.ts` 的 `AgentKind`、`apps/desktop/src/core/agents.ts` 的 `AGENT_ORDER`、`apps/desktop/electron/main/ipc/validation.ts` 的 `AGENT_KINDS` 分别定义桌面类型、列表顺序和 IPC 校验。
- 更新 `packages/web-client/src/index.ts` 的 `ConversationSessionSummary.agent` 和 `apps/desktop/src/features/agents/AgentsPage.tsx` 的 Agent 列表。洞察支持的 Agent 由 `apps/desktop/src/features/insights/insights.ts` 的 `insightsAgentKinds` 决定。
- 支持配置 MCP 时，更新 `packages/runtime-protocol/src/mcp-management.ts` 的相关定义。

**后端与文档**

- 发现用 `packages/backend/src/native-discovery-configured.ts`。会话读取入口在 `packages/backend/src/session-readers.ts`，各家的历史读取实现放在自己的 Agent 目录。接口是 `packages/backend/src/sessions/history-provider.ts` 的 `SessionHistoryProvider`，在 `packages/backend/src/sessions/providers.ts` 的 `providerReaders` 登记。支持原生已读状态或交接时，也在同一处登记对应适配。
- 上下文、诊断、技能和用量分别从 `packages/backend/src/context.ts`、`packages/backend/src/doctor.ts`、`packages/backend/src/skill-manager.ts` 和 `packages/backend/src/usage-providers.ts` 接入。交接启动入口在 `packages/backend/src/session-handoff-launch.ts`。
- 更新[功能与兼容矩阵](../FEATURES.md)。需要单独说明的，在 `docs/agents/` 下加一篇，并登记到[文档索引](../README.md)。

## 1. 实现并注册 Provider

- [`packages/backend/src/session-provider.ts`](../../packages/backend/src/session-provider.ts) 定义 `SessionProvider`、`TypedSessionProvider` 和 `SessionProviderRequest`。按实际支持的范围接入实时状态、能力查询和操作。可新建会话时，还需实现创建、选项和设置。参考 [DeepSeek Harness 的 Provider](../../packages/backend/src/agents/dsh/session-provider.ts)。只接入已有会话的例子是 [Antigravity](../../packages/backend/src/agents/antigravity/session-provider.ts)。
- 在 [`packages/backend/src/sessions/providers.ts`](../../packages/backend/src/sessions/providers.ts) 的 `createSessionProviders()` 注册实现，由 `SessionProviderRegistry` 按 Agent 查找。原生 API、参数语义和执行环境适配放在各家的 `packages/backend/src/agents/` 子目录。公共准入需要的原生参数校验接到 Provider 的 `validateControl`，对应校验放在 [`packages/backend/src/sessions/validate/`](../../packages/backend/src/sessions/validate)。
- 在 [`packages/runtime-protocol/src/agents.ts`](../../packages/runtime-protocol/src/agents.ts) 登记可新建的 `MANAGED_AGENTS`。`LIVE_SESSION_AGENTS` 包含这些 Agent 和只能从已有会话进入实时界面的 Agent。
- 桌面主机通过 `session.request` 将会话请求送到后端。测试应覆盖从设备请求到 Provider 的实际链路。已有 `/managed/*`、`/codex/*` 和兼容通道仍服务现有客户端，改动要保留原有响应和授权边界。

### 公共准入、回执和串行队列

- [桌面主机的 `service.ts`](../../apps/desktop/electron/main/web/service.ts) 使用 `admitSessionAction()` 检查设备、工作区范围、会话和操作授权。后端的 [`control-admission.ts`](../../packages/backend/src/sessions/control-admission.ts) 复用控制请求格式和回执准入，Provider 校验当前执行器能接受的参数。实时或只读结果只表示当前证据，实际写入仍需核对会话、运行时实例和修订号。
- [`control-receipts.ts`](../../packages/backend/src/sessions/control-receipts.ts) 把控制请求 ID 和请求内容绑定，供重复请求和结果核对复用。原生派发前后要沿用已有的回执处理。结果待核对时查询原回执，避免再次派发。
- Devin 和 Antigravity 的宿主待发队列使用 [`serial-session-queue.ts`](../../packages/backend/src/sessions/serial-session-queue.ts) 的 `SerialSessionQueue`。消息按会话存储，当原生执行器可以接收下一轮时再派发。其他 Provider 有原生队列时，按各家已有的队列行为接入。

### 检查桌面 RuntimeRouter 放行清单

[桌面主进程的 `RuntimeRouter`](../../apps/desktop/electron/main/runtime-router.ts) 显式放行运行时方法。经 `session.request` 传入的操作由后端路由校验。新增独立运行时方法时，同时更新 [`RUNTIME_METHODS`](../../packages/runtime-protocol/src/index.ts) 和桌面路由。新增操作若还要经过旧 `codex.managed` 或 `web.request` 通道，也要加入对应的操作白名单。漏掉这一步时，直接调用后端可以成功，经过桌面主进程的调用仍会失败。在 [`runtime-router.test.ts`](../../apps/desktop/electron/main/runtime-router.test.ts) 测试实际转发。

## 2. 声明能力并接入公共界面

- 在 [`packages/runtime-protocol/src/session-providers.ts`](../../packages/runtime-protocol/src/session-providers.ts) 声明稳定能力，可用 `sessionProviderDeclaration()` 查找。按需声明新建、输入框、命令来源、队列操作、连接方式等。新建预设用 `create.agentPresets`，预设选项和模型目录由主机按当前环境返回。
- 桌面和 Web 的共同组件在 [`packages/session-ui/`](../../packages/session-ui)。`resolveSessionProvider()` 在 [`session-provider.ts`](../../packages/session-ui/src/session-provider.ts) 里读同会话的 Provider 声明，并处理旧主机缺字段时的回退。未知 Agent 使用只读会话界面。
- 显示条件读稳定声明或客户端面板注册。启用条件读同会话的实时能力和设备授权，例如 `features.send.available`、`Live.sendEnabled`、设置的 `writable` 或队列条目的 `actions`。已声明的控件暂不可用时，保留控件并置灰。主机提供固定的 `reason` 码，由客户端翻译后放在 `title`，避免另加说明文字。
- 新建会话的权限选项、风险文案和预设标签属于客户端描述，参考 [`session-permissions.ts`](../../packages/session-ui/src/agents/session-permissions.ts) 和 [`session-creation.ts`](../../packages/session-ui/src/agents/session-creation.ts)。界面只提供当前目录和设备授权允许的选项。界面用词见[界面术语](ui-terminology.md)。

## 3. 按需注册专属面板

组件和文案放在 `packages/session-ui/src/agents/` 下各家的目录。参考 [`session-connection-panels.ts`](../../packages/session-ui/src/agents/session-connection-panels.ts)，按声明的连接方式查找注册项，再按平台桥接能力和设备授权决定是否能操作。窗口、导航或本机桥接等平台差异通过 [`SessionPlatform`](../../packages/session-ui/src/session-platform.tsx) 接线。共用的会话操作、输入框和面板逻辑放在公共包。

## 测试

- 在 [桌面会话行为基线](../../apps/desktop/test/session-baseline) 补对应 Agent 的用例。覆盖其实际提供的新建、发送、插话或排队、停止、审批或回答、设置，以及能力和实时状态。未支持的操作也应有明确的测试结果。测试用现成的隔离夹具和模拟执行器。
- 主机转发和准入测试放在 `apps/desktop/electron/main/`，桌面执行与基线测试在 `apps/desktop/test/`。界面回归在两端会话功能的测试目录，测试共用组件在相应平台的授权、禁用状态和恢复行为。
- [副本门禁](../../.github/scripts/session-ui-forks.test.mjs)要求桌面和 Web 的会话功能目录里没有同相对路径的文件。[Agent 引用门禁](../../.github/scripts/session-ui-agent-branches.test.mjs)限制会话界面中 Agent 专属引用的文件数与行数，Agent 注册目录和测试不参与计数。

从仓库根目录运行以下命令。

```sh
pnpm install --frozen-lockfile
pnpm --filter @agentkib/desktop exec vitest run test/session-baseline
pnpm --filter @agentkib/desktop exec vitest run electron/main/runtime-router.test.ts electron/main/web/host-admission.test.ts
pnpm test:web
node --test .github/scripts/session-ui-forks.test.mjs .github/scripts/session-ui-agent-branches.test.mjs
```

提交前运行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm build` 和 `pnpm build:web:hosted`。桌面全量和后端稳定性分别用 `pnpm test` 和 `pnpm test:backend:stability`。
