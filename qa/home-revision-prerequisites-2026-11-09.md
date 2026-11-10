# 首页改版的技术前提（2026-11-09）

配合设计计划 `designs/agentkib-home-revision-plan.md`。这里只列实施前要用到或要补的数据与接口，核对到设计需要的程度为止；具体实现由实施者决定。

## 1. 诊断结果（批次 0，已完成）

分支 `home-performance`，与第 9 节的卡片同一个 PR。

- `workspace.doctorSummaries` 只读保存的结果，不再当场诊断。结果存在主数据库的私有表 `doctor_summaries` 里，不改共享 schema 版本。
- 刷新协调器新增 `doctor` 任务，调用 `workspace.refreshDoctorSummaries`：
  - 启动后和窗口显示时每 30 分钟检查一次，只查过期或缺失的工作区；
  - 发现跑完后补查新工作区；
  - 手动刷新时检查全部。
- 首页“维护”里的“N 个工作区有配置问题”“还有 N 个工作区未诊断”都从这里来。

## 2. 需要你处理

- 会话目录项的 `continuation.status` 为 `waiting-approval` 或 `waiting-input` 时，表示在等审批或回答。下列会话由 AgentKib 运行或连接，目录项都带这个状态：
  - Codex 托管
  - Claude 托管
  - 已连接的 Claude 终端
  - Antigravity
  - DeepSeek Harness
- `continuation.status` 为 `outcome-unknown`（原因 `control-outcome-unconfirmed`）时，表示控制结果不明，对应首页的“结果待核对”。
- Codex 桌面端自己运行的会话不带等待状态。手机 App 对最近的若干个可读会话逐个读实时状态来补这一块；桌面第一版可以不做，做的话沿用同样的上限。
- 行内要写出具体在等什么（例如审批哪条命令），需要读该会话的实时状态（`approvals`、`questions`）。手机 App 的 `InboxController` 是这样做的：
  - 只读状态，不开事件流；
  - 目录变化时重读；
  - 结果不明的控制留待核对，不自动重发。
- H3（就地作答）若采用，必须和会话页走同一条控制路径：请求 ID、运行实例、revision 都要校验，结果不明时不重发。

## 3. 待查看

- 会话目录项的 `readState` 已有：`status`、`latestResult.outcome`（completed、failed、cancelled、ended）、`firstUnread`。规则和会话页的铃铛筛选、手机 App 的“待查看”相同；已在运行的会话不列入。
- 从首页打开会话后，需要停在第一条未读。共享的 `@agentkib/session-ui` read-state 已经处理 `firstUnread`；从首页进入时能否直接定位，待实施时确认。

## 4. 进行中

- 用会话目录项的 `continuation.status` 和 `executionLocation` 判断，Codex 应用里正在跑的轮次看 `externalTurn`。
- Web 首页已在用共享函数 `sessionContinuationListState`（`@agentkib/session-ui`），它返回标签、是否运行中、是否在等待；桌面可以直接用它。
- “已运行多久”：`externalTurn.startedAt` 有现成值；AgentKib 运行的轮次，目录里有没有开始时间待确认。没有就只显示运行位置，不显示时长。

## 5. 最近会话

- 与 Web 首页相同：`sortSessions`、`isSessionVisible`、`sessionGroupLabels`。
- 排除已出现在前三组里的会话。

## 6. 新建会话

- 复用会话页的新建流程（`creatingConversation`）。首页需要能带着预选的工作区和 Agent 进入；DeepSeek Harness 还有预设，规则和会话页一样，会话开始后不能改。
- 首条消息是在首页直接发出，还是带进会话页作为草稿再发，实施时定。用户看到的结果要一样：进入新会话时首条消息已发出；失败时回到首页，草稿还在。
- Agent 列表只列能在 AgentKib 中开始新会话的 Agent，并沿用会话页的平台和版本限制。

## 7. 右栏

| 项 | 来源 | 注意 |
|---|---|---|
| 额度 | `useQuotaSnapshot` 的缓存 | 不在首页触发采集；未开启采集时整项隐藏 |
| 远程 | 远程连接页现有的状态接口 | 中继用量到 80% 和 95% 时提示；未开启时隐藏 |
| 配置问题、未诊断 | 第 1 节保存的诊断结果 | — |
| 待审批记忆 | `globalMemories`（只取 pending） | — |
| CLI 新版本 | Agent 工具状态的缓存 | 不在首页触发 CLI 探测 |
| 插件需要更新 | Claude 终端插件、DSH 插件的兼容状态（连接面板已有） | — |

## 8. 性能约束

- 首页只读缓存和会话目录订阅。进入首页不触发全量诊断，不额外轮询。
- 三组会话列表来自同一份目录数据。
- 每个区块先显示缓存；没有缓存时只放占位行，不出现整块“载入中”。

## 9. 审批与问题卡片（设计稿 C-1、C-2）

已实施（分支 `home-performance`）：
- 共享组件在 `@agentkib/session-ui` 的 `interaction-card.tsx`（`InteractionDock`）和 `interaction-model.ts`（选项映射、文案、作答校验）。桌面与 Web 各有一个 `SessionInteractionDock`，只负责权限判断和调用 `control()`。
- 与下面的计划不同的地方：
  - 没有“跳过”。主机要求每个问题都有回答（`invalid_answers`），不想回答时用输入框的停止。
  - `cancel` 只在停止键不可用（`canStop` 为 false）时作为“拒绝并停止本轮”出现在卡片里。
  - DSH 先答时，卡片显示“这项请求已经在 DeepSeek Harness 中处理过了”，5 秒后撤下。
- 沙盒验收：Web 端用 QA 服务看过审批卡片（桌面宽度、手机宽度、收起）和问题卡片。桌面端没能走到审批：Codex 0.167.0 的沙盒里第一次接管（adopt）就停在 `dispatched`，发送返回 `control-outcome-unconfirmed`。账本只记下结果不明，真实错误没有保存，原因未查明。沙盒用 API key 登录，Codex 每秒记录一次 “waiting to resolve remote control preference until authentication is available”，可能与此有关，未确认。下面两个问题也还没在真实环境复现。

实施前的记录：
- 当时的实现：请求一到，`use-session-controller.ts` 里的 effect 自动 `setModal`。`session-dialogs.tsx` 用 `Dialog panel` 显示审批（`NativeDecisions`）和问题（`QuestionForm`）。输入框上方的琥珀色条目在 `session-reader.tsx`。Web 端 `apps/web/src/features/conversation` 下有同样的一份，两边要一起改。
- 选项映射：
  - `accept`（once）→“允许一次”
  - `acceptForSession`（session）→“允许此会话”
  - `acceptWithExecpolicyAmendment`（persistent）→“始终允许”，副标题写命令前缀
  - `applyNetworkPolicyAmendment` →“始终允许”（联网）
  - `decline` →“拒绝”
  - 权限请求：`grant-turn` / `grant-session` / `deny-permissions` →“允许本轮 / 允许此会话 / 拒绝”
  - `cancel` 不进卡片，由输入框的停止键负责。实施前确认等待审批时停止键可用（`live.stopEnabled`）。
- 去掉 session、persistent 选项的“确认操作”勾选（`native-decisions.tsx`），改为一次点击提交。提交失败、结果不明时沿用现有的不重发规则。
- “详情”里放原来弹窗里的原始数据：完整命令参数、各选项的原始 decision JSON、`requestContext`。
- 文案来源：本机 `/Applications/ChatGPT.app/Contents/Resources/app.asar` 的 zh-CN 语言包。键名前缀：`execApprovalRequest.*`、`approvalRequestCard.*`、`patchApprovalRequest.*`、`sendUserMessageQuestion.*`、`composer.mcpFormElicitation.*`。
- 问题卡片的“跳过”：先确认 Codex `request_user_input`、Claude Code AskUserQuestion、DSH 各自能接受什么样的“未回答”，再决定发什么。
- 两个只在沙盒里出现过的问题，实施前在真实环境复现一次：
  - 一个 Codex 会话在等审批时，另一个 Codex 会话发消息：adopt 停在 `dispatched`，发送返回 409 `control_preflight_rejected`（`control-outcome-unconfirmed`），界面显示“请求失败 / 已断线”。
  - 用“新建任务”建的 Codex 会话发不出第一条消息（`unverified-session-identity`，Codex 0.163.0 在第一条消息前不写 rollout）。
- C-3 里的请求和状态都对应现有代码路径，不需要新协议：
  - Claude Code 审批：`claude/can_use_tool`，只有 allow、deny。
  - DSH 审批：`dsh/approval`，选项按 `availableDecisions`。
  - ACP 权限请求：`session/request_permission`，选项用 `options[].name`。
  - MCP：`mcpServer/elicitation/request`，没有 accept 时只能拒绝（现有 `mcpDeclineOnly`）。
  - 敏感问题：`isSecret` / `secret`。
  - 提交中：`busy`。
  - 发送失败：notDispatched。
  - 结果不明：`control.priorUncertain` 和现有 `unknown` 文案，不重发。
  - 已在别处处理：`answeredInDsh`。
  - 没有审批权限：`access.device.approve` 为 false。
  - 暂时处理不了：`supported` 为 false。
