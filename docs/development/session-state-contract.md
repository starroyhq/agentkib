# 会话状态契约 v1

后台的 `deriveSessionState` 将同一会话的事实整理成一个结论。目录、详情、设置和指派应使用同一结论。生产者先从 Claude 的执行租约、托管记录、原生轮次、回执和编排登记取得事实，再交给函数。函数是纯函数，只读取传入事实。首批提交只建立契约、推导和测试，后续接线时再向客户端声明能力。

## 状态与权限

- `execution` 描述写入归属及证据。断开的桥接、保留的绑定和未知的原生进程各有不同含义。确认没有写入者才用 `none`。校验失败用 `unknown`。托管 runner 回收后，已核验的托管归属仍可为 `agentkib`。旧归属中的 `native-app` 在 v1 归为 `external`。
- `lease` 单独记录写入权为 `none`、`held`、`returned` 或 `pending`。终端恢复一条仍被 AgentKib 接管的会话时，租约保留，冲突投影为 `pending` 和 `contested`。本机可以在宿主核验安全后交还。仅在独立核实自动交还政策及当前写入者时，才给出 `lease-change` 自动恢复。首批契约只建模这些结论和对应事件。
- `turn` 描述原生轮次，`cause` 记录结果未确认的依据。等待审批和提问分别使用 `awaiting-approval` 和 `awaiting-answer`。原生完成后可为 `idle`，旧插件补发结束事件前，普通发送仍可因 `awaiting-send-ack` 暂停。发送和停止分别等自己的写入路径就绪，只有确定更新会送达时才声明 `control-readiness` 自动恢复。
- `queue` 独立记录队列的运行、暂停和原因。手动暂停可显式恢复。系统暂停随事由的观察结果更新，已核实事由消失后恢复运行。
- `controls` 分别给出普通发送、插话、排队、停止、设置、指派、接管、交还、核对、恢复队列、送达汇报、审批和作答。Provider 未声明的操作使用 `hidden`，远端的交还操作也隐藏。已声明但当前权限不足的操作使用 `disabled`。接管可用须由原生准入核实，包括写入租约、在途输入、已投递的汇报及原生控件占用。设备权限和工作区范围仍在入口重新核验。
- `controls.assign` 是候选会话自身的准入结论。角色未知时暂停指派，已是项目 Agent、已是 Worker 或 Provider 拒绝时保留原有 `detail` 原因。执行指派时仍须核验负责人、候选会话及工作区组合。`projectAgentToolsReady` 单独描述主控工具是否就绪。
- `modelEntry` 决定模型入口。`agentkib` 使用应用内设置，`terminal` 要求本机终端仍连接且原生菜单可用，`display-only` 只展示当前值。操作的具体可用性仍使用 `controls`。
- 被禁用的操作带有固定原因和恢复状态。有已启用的解决操作就给操作，有可依赖的更新就给自动恢复。永久性限制只使用封闭的 `terminal` 原因集合。其余缺少明确恢复路径的组合在后台可诊断，`retry` 只重读状态。
- 编排登记或已读读取失败时分别使用 `role.kind: "unknown"`、`read.status: "unknown"`。状态无需携带命令 ID、原生路径、原始回执或设备授权材料。

## 未确认回执

`unknownCommands` 只汇总仍需保护的回执。已核对退役、但无法确认原结果的回执仍可在原回执查询中返回未知。`knowledge: "unknown"` 表示账本读不到。`unclassified` 表示实际查到回执，但无法确定它改变了什么。两种情况都会暂停写入，直至取得相应证据。

| 未确认的操作 | 仍可能有写入者时暂停的控制 |
| --- | --- |
| `send`，包含宿主已派发的队列输入 | 普通发送、指派、接管、送达汇报 |
| `steer`，包含终端队列增删 | 空闲后普通发送、指派、接管 |
| `stop` | 停止、指派 |
| `settings` | 设置 |
| `lease`，包含接管和交还 | 核对以外的所有操作 |
| `report` | 接管及同一汇报的送达 |
| `interaction`，包含审批和作答 | 接管、审批、作答 |
| `other`，已知不影响上述控制 | 无 |
| `unclassified`，无法判断影响 | 核对以外的所有操作 |

原生轮次不明时，恢复路径必须覆盖该轮以及操作涉及的回执。原生结果缺少插话 UUID，或启动帧缺失而后续流继续到达，均为待核对的结果。旧投影里的通用 `outcome-unknown` 无法证明原生轮次已完成。缺失证据时保持原回执结果未知。

核对要求实时证据确认没有托管或终端写入者，且可读取回执账本。有明确安排的自动核对才声明 `receipt-reconciled`，其余情况提供可用的手动核对。已准备而未派发的回执收为 `not-dispatched`。已派发的回执凭匹配的证据收为 `completed`，缺证据保留 `unknown`。核对和交还都不会重发输入。交还还须核实会话版本及托管写入者已退出，退出未确认时保留待处理租约。

## 版本协商

主机通过 `/access` 一起声明 `sessionStateVersion: 1` 和 `sessionStateProviders`。列表使用 Provider 的协议标识，只列出本设备、授权范围内确实为每条可读会话提供完整 v1 的 Provider。例如只接线 Claude 时，列表为 `["claude-code"]`，同一主机的 Codex 会话仍走已有字段。主机开始发送符合契约的状态后才公告。首批契约仅定义这两个可选字段，协议主版本沿用现值。

客户端在快照和整个 `live.state` 替换到达时，用当前 `/access` 和所选会话自己的 Provider 调用 `negotiateSessionState`。TypeScript 和生成的 Dart 提供同样的三种结论。

| 结论 | 条件 | 客户端使用的数据 |
| --- | --- | --- |
| `v1` | 已声明 v1，覆盖列表包含本 Provider，且整个状态通过校验 | 整个 v1 状态，包括 `unknown` 和 `disabled` |
| `legacy` | 宿主未声明受支持的版本，或有效覆盖列表没有本 Provider | 既有的实时状态和能力字段 |
| `unavailable` | 声明 v1 后覆盖列表格式错误或缺失，或覆盖本 Provider 后整份状态无效或缺失 | 写入保持停用，重新读取当前授权和会话状态 |

列表中的新 Provider 名称不改变已知 Provider 的覆盖范围。v1 发布后，封闭结构、枚举或合法组合发生变化时使用新的结构版本。版本和覆盖列表只用于选择读取方式，授权和工作区范围仍由宿主分别核验。

## 接线与验收

1. Claude 适配层先统一详情、目录、设置和指派的事实。执行归属复用后台现有的归属核验，回执结论来自按操作分类后的账本。只有当前调用方有权读取的结论可进投影。已有完整 v1 投影的 Provider 才加入 `sessionStateProviders`。
2. HTTP 快照、SSE 快照及增量共享授权投影。消费者按会话、宿主运行代和可见权限范围接受整份状态，避免迟到的快照覆盖更新的结论。`version` 是结构版本。生产者在同一发布范围内为状态变化推进 `revision`。断开、重启或授权换代时重建该范围的版本基线。
3. 桌面与 Web 从共享 `session-ui` 迁移 `session-display-state.ts`、`use-session-controller.ts`、`session-composer.tsx`。优先收拢 Claude 的模型与权限选择、审批和交接面板、目录行和托盘的归属判断。模型入口遵循 `modelEntry`。独立的 `SessionWorkerAssignmentDialog.tsx` 使用宿主返回的候选结论。
4. 手机把协商字段接入 `packages/agentkib_client/lib/src/models.dart` 的 `Access`，用生成的 `negotiateSessionState` 读取快照和增量。迁移 `LiveState.isTerminalClaude`、`ConversationController.canSend/canStop`、`conversation_controls.dart` 和 `conversation_status.dart`，同步核对设置、提问卡和接管入口。远端只展示授权投影给出的实际操作。
5. 用同一个案例核对宿主准入、目录、详情、发消息及指派，包含设置孤儿回执、重启和旧插件结束事件迟到。协商夹具覆盖同一主机的已覆盖和未覆盖 Provider，以及覆盖内状态丢失或无效。界面上的核对入口继续使用现有按钮文案。
