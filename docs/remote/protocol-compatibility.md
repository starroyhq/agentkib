# 远程协议与版本兼容

[远程契约](../../packages/runtime-protocol/remote-contract.json)登记主机与客户端共享的协议版本、能力键、错误码及路由。修改协议时先改契约，再从仓库根目录运行以下命令生成 TypeScript 和 Dart。CI 会检查两份生成物，并用[共享响应样例](../../packages/runtime-protocol/test/fixtures/remote-contract.json)验证契约。

```sh
pnpm install --frozen-lockfile
node packages/runtime-protocol/scripts/generate-remote-contract.mjs
node packages/runtime-protocol/scripts/generate-remote-contract.mjs --dart-output /path/to/remote_protocol.g.dart
```

## 协商规则

- **协议主版本**决定数据形状和操作语义。破坏现有客户端的变更需要新主版本，并为仍受支持的客户端保留旧入口。当前 HTTP 路由使用 `/api/web/v1`，本机运行时握手使用版本 17，会话流及控制请求使用版本 2。
- **最低版本**记录各协议仍支持的下界。当前本机运行时握手和会话控制都要求双方的版本一致。主机探测分开处理，旧托管 Web 可以从 `GET /info` 读到 `protocolVersion: 1`，会话协商读取 `conversationProtocolVersion`。
- **能力标志**用来启用单项功能。客户端应先确认主版本，再读取 `/access` 的能力及版本，例如 `readStateVersion`、`pendingInteractions.version` 和 `taskSummaryVersion`。字段缺失时按该能力不可用处理。设备权限仍由主机检查。

路由声明中的 `lan` 表示该方法允许通过局域网跨源预检，实际请求仍受鉴权、授权及传输限制。`control` 表示使用控制协议及回执。IPC 和 WebSocket 各自有更窄的放行规则。

## 错误与回执

HTTP 失败携带固定错误码。控制请求可附带 `controlOutcome`，以区分明确未派发和结果未知。IPC 可能通过 JSON-RPC 错误、结果中的拒绝字段或传输错误传递。客户端按固定码处理，本地化提示独立于错误码。

每个 HTTP 错误在契约里有一个基准状态。已有调用点的状态不同，使用具名例外保留原响应。例如 `capability_unavailable` 的基准是 409，路由拒绝、处理器缺失和服务不可用仍分别返回 403、404 和 503。

错误码只在契约的 `errors` 中登记。主机会话控制的拒绝出口使用生成的 `REMOTE_ERROR_CODES` 或 `REMOTE_ERROR_CONTRACT`，以 `RemoteErrorCode` 约束原因。对外只传固定码，原生异常原文不作为新原因传出。

每个错误条目的 `retry` 描述恢复条件。它是生成到 TS 和 Dart 的契约元数据，HTTP 和 IPC 响应形状不因此改变。

| 值 | 含义 |
| --- | --- |
| `never` | 终态，重试无效 |
| `after-refresh` | 当前状态已旧，先重读状态，旧操作不自动重放 |
| `after-backoff` | 暂时不可用，按退避和服务端等待时间恢复 |
| `after-user-action` | 先改变权限、策略、输入、配置、登录或安装等条件 |
| `reconcile-only` | 只核对原请求，不重发 |
| `unclassified` | 未核实的旧码，系统不自动重试，界面保持现有行为 |

**结果阶段优先于 `retry`。** 结果未知时只核对原请求，即使原因码通常可重试。只有幂等读取可由系统限次自动重试。写操作需证明未派发，再由用户发起。旧客户端看到新原因时保留原有阶段和响应形状。

CI 把错误条目与基准提交逐项对比。只有内容未变且仍未分类的既有条目可以保留 `unclassified`，因此它的总数只能减少。新增或修改的条目需要已核实的恢复条件，已分类条目不能改回 `unclassified`。

### 流重连和限流

SSE 握手继续使用原 HTTP 状态和错误码。Web 客户端以 `ApiError.retryAfterMs` 提供响应中的 `Retry-After`，支持秒数和 HTTP 日期。普通 API 的 429 也提供该字段，调用仍只发送一次。

已建立的 SSE 可以在 `unavailable` 事件中附可选的固定 `reason`。旧主机的空载荷按 `stream_unavailable` 处理。读端停止消费后，主机释放已阻塞的连接。能送达的终止通知不推进游标，重连从客户端实际应用的最后一个游标继续读。授权结束停止重连，暂时故障的连续重连有次数上限并遵守服务端等待时间。

## Worker 汇报事件

`ConversationEvent.worker_reports` 是投递账本提供的可选字段。`reportId` 标识整次投递，`parts` 保存其中各条汇报，`omittedDetails` 表示合批时有内容超过投递上限。每条汇报包含 Worker 会话与名称、Agent、事件种类、实际发生时间和是否需要用户处理。用时以毫秒计，`reply` 是 Worker 的 Markdown 回复，`waitingItems` 提供等待事项的结构化预览。

客户端根据 `kind`、`outcome`、`reasonCode` 和对应数据生成界面文案。模型使用原会话事件的 `content`，卡片使用结构化字段。`worker_reports` 缺失时按普通会话消息显示。各事件类型、合批和普通消息见[共享样例](../../packages/runtime-protocol/test/fixtures/worker-reports.json)。

## 旧客户端

[现网托管 Web 构建](https://remote.agentkib.com/build-info.json)仍依赖 `/info` 的探测字段、五个 Codex 旧读路径及部分旧控制路径。保留范围和逐条删除条件见[兼容代码登记表](../development/compat-registry.md)。

手机 App 上 TestFlight 前，只要求兼容 0.35.0 及更新主机。五个仅当前手机客户端调用的旧 POST 别名已移除，分别是 `delete`、`compact`、`terminals-clean`、`usage-limit-cancel` 和 `usage-limit-continue`。手机改用 `POST /managed/action`，在原请求体上带 `agent: "codex"` 和对应的 `operation`。仍发送旧路径的手机开发包会收到 404。
