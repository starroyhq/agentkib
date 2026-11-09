# AgentKib UI/UX 与交互问题清单（2026-10-16）

- 基线：`main` @ `cb0828fc1`（v0.18.0）
- 范围：桌面端（`apps/desktop/src`）与 Web 端（`apps/web/src`）的界面、流程与交互；不含安全审计。
- 方法：源码阅读，未启动应用实机操作。问题现象与行号保留基线记录；当前修复状态见各条目及下方批次记录，定位代码时请重新核对行号。
- 路径约定：下文 `desktop/` 指 `apps/desktop/src/`，`web/` 指 `apps/web/src/`，`conv/` 指 `apps/desktop/src/features/sessions/conversation/`（Web 端 `apps/web/src/features/conversation/` 为同源副本，行号基本一致，修复时需两端同步）。
- 复核：2026-10-16 根据当前源码校正部分结论与分级，保留原 ID。“已确认缺陷”表示代码路径可证实；“增强”表示现有能力外的改进；“设计取舍”需保留已有产品约定；“待实机”表示视觉、设备或运行表现尚未复现。未单独标注的条目仍是原始静态候选，不代表已完成逐项验收。

- 当前剩余项目复核：本轮确认的 UX-23 窄屏 MCP 聚焦裁切、UX-30/31 实际缺译、UX-33 桌面宿主说明已修复，并补齐 File 导航、分包等待与 Skills 局部目录发现验证。新增 39 项针对性测试通过；Desktop 单次累计 99 文件、1493/1493 项与 Web 单次全量 55 文件、1074/1074 项通过，均保留默认 5 秒时限、显式 maxWorkers=4。三项独立增强、旧组件清理与真实宿主/设备覆盖仍按各自类别保留；当前证据与限制见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)，所有旧失败记录完整保留。

严重程度：

- **P1**：主流程断裂、数据丢失或失败无反馈，优先修复。
- **P2**：流程不闭环、操作层级混乱或明显影响效率。
- **P3**：一致性、文案与细节体验。

---

## P1

### UX-02 计划未绑定草稿版本，应用后可能丢失新编辑或恢复旧缓存

- 判定：已确认缺陷，P1；包括 Doctor、交接和普通变更计划的生命周期。
- 状态：第一批已修复，见[第一批修复节](#第一批修复2026-10-16)。下述根因与场景为基线行为。
- 位置：`desktop/features/workspace/workspace-store.ts:59`；`desktop/routes/(main)/workspace/$workspaceId/doctor.tsx:73`；`desktop/routes/(main)/workspace/$workspaceId/changes.tsx:496-505`；`desktop/features/app/useWorkspaceTransitions.ts:31-45`；`desktop/routes/(main)/workspace/$workspaceId/route.tsx:213`
- 根因：Doctor 使用磁盘 manifest 生成修复，忽略 store 中的草稿；普通计划生成后继续编辑 Assets 也不会使旧计划失效。应用后的 reload 无条件用磁盘内容替换 manifest 与 baseline，可能覆盖计划生成之后的编辑。
- 新增场景：切换工作区会保存草稿缓存，成功应用后未同步清理该缓存，再次进入工作区可能恢复已经过时的草稿；当前内容已恢复到 baseline 时，切换也不会删除此前缓存。
- 建议：计划绑定生成时的工作区与草稿版本，生成、应用及回读时校验；Doctor 明确保留或包含已有草稿；成功应用后同步清理该工作区缓存，干净草稿不保留旧缓存。
- 验收：覆盖 Doctor 带草稿生成、普通计划生成后继续编辑、生成期间修改草稿、应用期间修改草稿，以及应用后切换离开再返回，均不会静默覆盖或复活旧草稿。

### UX-03 工作区扫描失败后一直显示加载骨架屏

- 位置：`desktop/routes/(main)/workspace/$workspaceId/route.tsx:169-171, 297`
- 判定：已确认缺陷，限定为没有可用旧数据的首次加载失败。
- 状态：本轮已修复首次本地扫描及 Runtime 错误的展示与重试，并通过针对性测试；见[第二批修复节](#第二批修复2026-10-16)。下述现象为基线行为。
- 现状：首次 scan 被 reject 后只设置全局 message 就返回，`scan` 保持为空；除 Doctor 外的页面一直渲染骨架屏。已有 `scan` 与 manifest 时，刷新失败会保留旧数据，不能概括成每次扫描失败都会持续加载。
- 影响：看起来像"还在加载"；重试入口只有头部一个不带文字的刷新图标。
- 建议：在内容区显示错误状态（原因 + "重新扫描"按钮）。
- 验收：模拟扫描失败时，内容区显示错误和重试按钮，点击后可以恢复。

### UX-04 首页三步引导的后两步永远不可见；空状态出现两个重复的入口

- 判定：已确认缺陷。
- 状态：第三批已修复并通过针对性测试，见[第三批修复节](#第三批修复2026-10-16)。下述现象为基线行为。
- 位置：`desktop/features/home/GlobalHome.tsx:177`（`!workspaces.length && <GettingStartedCard/>`）；`desktop/features/home/GettingStartedCard.tsx`
- 现状：引导卡片包含"添加工作区 → 运行诊断 → 审查修复"三步，但只在没有工作区时渲染，一旦添加了工作区就消失，后两步永远不出现。没有工作区时，它又和下方的空状态卡片（`GlobalHome.tsx:196-205`）同时显示，两个按钮都是"添加扫描目录"。
- 建议：引导卡片的显示条件改为按 onboarding 状态判断（`acknowledged_version < version`）；与空状态卡片二选一，或合并成一个。
- 验收：新用户添加工作区后，引导卡片推进到"运行诊断"；首屏只有一个主操作。

### UX-06 MCP 与记忆的若干操作失败时无提示，可重复点击

- 位置：`desktop/routes/(main)/catalog.tsx:781-791`（卸载）、`:851-854`（停止全部实例）、`:726`（安装按钮不受 busy 控制）、`:338-345` 与 `desktop/features/catalog/MemoryCard.tsx:57,71,81`（记忆审核）
- 判定：上述具体入口有已确认缺陷，不能推广到全部 MCP 管理操作。
- 状态：本轮已修复并通过针对性测试，见[第二批修复节](#第二批修复2026-10-16)。下述现象为基线行为。
- 现状：高级区域的卸载、停止全部实例，以及全局记忆审核未就地捕获请求失败，也没有进行中禁用；Registry 安装按钮未绑定已有 busy 状态。卸载已有确认框，不能视为完全无保护。
- 附带：`McpHubPage` 的错误条位于默认折叠的"高级"区域（`catalog.tsx:634`）；但主列表 `McpManagementPanel` 已有请求锁、busy 禁用和可见错误条（`:80-92, 204-208`），安装等部分操作也已有错误捕获。
- 建议：为缺失入口复用已有锁和错误处理模式，补齐进行中状态；相关错误显示在操作附近或页面顶部的可见区域，保持现有确认与管理面板保护。
- 验收：模拟接口失败时有可见的错误；请求进行中按钮处于禁用或 loading 状态。

### UX-12 "包含 Home 配置"提前结束进行中状态，可能与应用旧计划并发

- 判定：已确认缺陷，P1；包含异步状态与计划应用互斥问题。
- 状态：第一批已修复，见[第一批修复节](#第一批修复2026-10-16)。下述根因为基线行为。
- 位置：`changes.tsx:513`（`onPlanHome={() => void planHome()}` 丢弃 Promise，导致 `:228` 的 planningHome 提前复位）
- 根因：子组件无法等待真实计划请求完成，请求尚未返回时按钮恢复，且缺少生成计划与应用旧计划之间的完整互斥约束；错误写入全局横幅。
- 建议：传递真实 Promise，锁覆盖整个请求周期，同时在处理函数中阻止重复生成和在途应用；计划返回时核对工作区及草稿版本，失败在本页显示。
- 验收：延迟计划响应时持续显示进行中状态，重复点击只发送一次请求，期间不能应用旧计划；失败后可见报错并恢复操作，过期响应不能替换新计划。

---

## P2

### 流程闭环与反馈

#### UX-01 桌面会话输入框没有发送快捷键

- 状态：第四批已修复并通过针对性及综合自动化验证，见[第四批修复节](#第四批修复2026-10-16)。下述现象为基线行为。

- 判定：增强，P2；缺少输入框发送快捷键成立，但仍可用 Tab 聚焦发送按钮后提交，并非只能使用鼠标。
- 位置：`conv/features/sessions/session-composer.tsx:365-381`；只读来源 `session-reader.tsx:217`；全局快捷键在可编辑元素中跳过 `desktop/features/app/useAppShortcuts.ts:51`
- 现状：Textarea 没有发送用的 `onKeyDown`，高频发送需要切换焦点或点击按钮。
- 建议：Enter 发送、Shift+Enter 换行（或 ⌘/Ctrl+Enter 发送，并在设置中可选）；处理 IME 组字状态（`isComposing`）；不可发送时不触发。
- 验收：中文输入法组字时按 Enter 不会发送；Web 与桌面行为一致。

#### UX-05 历史搜索结果缺少打开原会话的入口

- 后续核对（本轮）：已补充真实 File、草稿与引用在取消或确认跨会话导航时的两端验证；自动定位命中消息仍属于独立增强，见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。

- 状态：第四批已修复并通过针对性及综合自动化验证，见[第四批修复节](#第四批修复2026-10-16)。下述现象为基线行为。

- 判定：增强，P2；当前引用行为有明确设计约定。
- 位置：`conv/features/history/history-search.tsx:509-592`（Web 端 :458-540）；`docs/sessions/content-search.md:11`
- 现状：结果详情提供"上一条 / 下一条 / 引用到当前会话"；会话内引用按设计保留当前目标与草稿，不切换来源会话。
- 建议：另增显式的"打开会话"入口并尽量定位命中消息，导航按已有草稿保护流程执行；保留现有引用行为。
- 验收：显式打开可进入来源会话；仅引用时当前目标和草稿保持不变。

#### UX-07 "交给 AgentKib"部分禁用条件缺少就近解释；术语不统一

- 状态：第四批已修复并通过针对性及综合自动化验证，见[第四批修复节](#第四批修复2026-10-16)。下述现象为基线行为。

- 判定：局部反馈缺口与文案改进，P2；交接门控属于应保留的设计约束。
- 位置：`conv/features/sessions/managed-tasks.tsx:556-569`；门控逻辑在 `claude-handoff.ts`（`canConfirmClaudeHandoff`）
- 现状：已有加载、错误、结果待核对、执行工具不可用原因和交接确认说明；但压缩中、Claude 交接资格或 fingerprint 等部分禁用条件没有就近的对应说明。同一概念仍出现"确认续接 / 执行归属 / 交给 AgentKib / 托管续接"等名称。
- 建议：统一术语（见 UX-30），为尚未说明的禁用条件补充原因和下一步，保留既有门控，勿通过放宽条件使按钮可用。
- 验收：各禁用原因均能找到对应解释，已有交接约束不变。

#### UX-08 应用 ChangeSet 后没有成功反馈，也没有撤销入口

- 后续核对（本轮）：当前成功反馈与本次 Diff 查看已完成；通用撤销缺少现有协议和持久历史支持，继续作为独立增强，见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。

- 判定：本轮范围为成功反馈与“查看本次变更”；撤销仍需单独评估。
- 状态：第三批已修复并通过针对性及综合测试，见[第三批修复节](#第三批修复2026-10-16)。下述现象为基线行为。
- 位置：`desktop/routes/(main)/workspace/$workspaceId/changes.tsx:541-545`
- 现状：只有 Doctor 来源的应用会带上复检横幅；普通流程应用后直接跳到概览，没有任何提示。界面上也没有 ChangeSet 历史或撤销功能。
- 建议：显示成功 toast（写了哪些文件）；提供"查看本次变更"入口，后续评估是否支持撤销。

#### UX-09 草稿缺少持续标记与就地放弃入口

- 位置：`desktop/routes/(main)/workspace/$workspaceId/assets.tsx:162-170`；`route.tsx:292`
- 判定：已确认缺陷，范围为当前 Assets 编辑流程。
- 状态：第三批已修复并通过针对性及综合测试，见[第三批修复节](#第三批修复2026-10-16)。下述现象为基线行为。
- 现状：编辑后"审查变更"按钮变为可用，但没有持续的未保存标记或就地放弃入口，按钮禁用也缺少原因。离开工作区已有确认后丢弃草稿流程（`useWorkspaceTransitions.ts:48-99`），因此不能说完全不能放弃；切换到另一工作区则会缓存草稿。
- 建议：显示草稿徽标和数量，在 Assets 提供"放弃草稿"，给禁用的按钮加 tooltip 说明原因；放弃时同步清理对应缓存和失效计划。

#### UX-10 待审变更的入口只在有变更时出现在侧栏

- 状态：第五批已完成修复并通过针对性及综合自动化验证，见[第五批修复节](#第五批修复2026-10-16)。原现象与位置保留为基线记录。

- 位置：`desktop/components/AppSidebar.tsx:485`；概览页只对 Doctor 来源显示待审提示 `workspace/$workspaceId/index.tsx:196`
- 建议：概览页对所有来源的待审变更都显示提示条和入口。

#### UX-11 扫描或生成计划时整个内容区被替换成骨架屏

- 状态：第五批已完成修复并通过针对性及综合自动化验证，见[第五批修复节](#第五批修复2026-10-16)。原现象与位置保留为基线记录。

- 位置：`workspace/$workspaceId/route.tsx:297`
- 影响：当前页面被卸载，Git 页的选中项和滚动位置都会丢失。
- 建议：busy 时保留原内容，只在按钮或局部显示 loading。

#### UX-13 启用会话索引失败时没有提示，也没有进行中状态

- 位置：`desktop/features/workspace/WorkspaceSessionsPage.tsx:410`；`workspace/$workspaceId/sessions.tsx:29-31`
- 判定：已确认缺陷，限定为工作区会话页的索引启用面板；全局会话页已有独立的启用锁与错误反馈。
- 状态：本轮已修复并通过针对性测试，见[第二批修复节](#第二批修复2026-10-16)。标题描述为基线行为。
- 当前行为：同步请求锁覆盖完整启用请求，按钮显示“启用中”并禁用；失败在当前面板显示本地化错误，按钮恢复后可重试。以 Runtime 实际的索引状态决定何时读取会话，不在请求返回前提前启用。
- 验收：延迟响应和同一批次的重复点击只调用一次启用；失败后原位显示错误，重试清除旧错误，启用成功后正常读取会话。

#### UX-14 Skill 操作的成功提示引用了一个通常不存在的按钮

- 状态：第三批已修复并通过针对性测试，见[第三批修复节](#第三批修复2026-10-16)。下述现象为基线行为。
- 位置：`desktop/features/skills/SkillHubPage.tsx:489-497`；文案 `skills.manager.libraryChanged`（`desktop/locales/zh-CN.json:1204`）
- 现状：提示让用户"使用「同步库中版本」"，但这个按钮只在特定状态下出现（`SkillManagerPanels.tsx:1260`）；常见情况下对应的按钮叫"分发库版本"（`:1147-1155`）。加入资源库、回滚、移入回收区、恢复四种操作都显示同一句提示。
- 建议：按操作类型分别写提示；下一步直接给可点击的入口。

#### UX-15 首页"最近活动 → 查看全部"跳到了没有活动列表的洞察页

- 状态：第五批已完成修复并通过针对性及综合自动化验证，见[第五批修复节](#第五批修复2026-10-16)。原现象与位置保留为基线记录。

- 位置：`desktop/features/home/HomeRecentSections.tsx:24`（跳到 `onShowInsights`）
- 建议：跳到真正的活动列表，或者去掉"查看全部"。

#### UX-16 首页"创建工作区"实际执行的是"添加扫描目录"

- 状态：第三批已修复并通过针对性测试，见[第三批修复节](#第三批修复2026-10-16)。原位置和调用关系保留为基线记录；首页单工作区添加复用现有菜单的安全添加与导航流程。
- 位置：`desktop/features/home/HomeRecentSections.tsx:89`（调用 `onAddRoot`，即 `routes/(main)/index.tsx:190` 的 `addScanRoot`）；而菜单 ⌘O "添加工作区"是另一个动作（`desktop/features/app/useAppNavigation.ts:394-395`）
- 建议：按钮文案与行为一致；在首页同时提供"添加单个工作区"和"添加扫描目录"，并说明两者的区别。

#### UX-17 只读会话的"续接"缺少直接入口

- 状态：第三批已修复并通过针对性测试，见[第三批修复节](#第三批修复2026-10-16)。下述现象为基线行为；续接能力与来源校验门控保持不变。
- 位置：`desktop/features/sessions/SessionHistoryContent.tsx:95`；`desktop/features/sessions/SessionWindowToolbar.tsx:99,111`
- 现状：引导文案放在默认折叠的"历史详情"里；续接按钮只有图标，窗口宽度 ≤1050px 时收进"…"菜单；不可续接时直接隐藏，不说明原因。
- 建议：在只读提示条上直接放"续接"按钮；不可用时说明原因。

#### UX-18 "去设置开启"类提示没有跳转按钮

- 状态：第五批已完成修复并通过针对性及综合自动化验证，见[第五批修复节](#第五批修复2026-10-16)。原现象与位置保留为基线记录。

- 位置：历史正文索引未开启 `conv/features/history/history-search.tsx:493`
- 建议：在桌面端提供"前往设置"按钮；Web 端说明需要在主机上操作。

#### UX-19 需要交接的会话也被标成"仅可查看"

- 状态：第五批已完成修复并通过针对性及综合自动化验证，见[第五批修复节](#第五批修复2026-10-16)。原现象与位置保留为基线记录。

- 位置：`conv/.../session-display-state.ts:52-53`
- 建议：区分"只读来源"和"可交接后控制"，后者给出操作入口。

#### UX-20 Doctor 中只能手动处理的问题没有下一步入口

- 状态：第三批已修复并通过针对性测试，见[第三批修复节](#第三批修复2026-10-16)。下述现象为基线行为；具体处理入口按问题代码与实际能力提供，不能统一跳到 Assets。
- 位置：`desktop/features/workspace/WorkspaceDoctorPage.tsx:134`
- 现状：没有跳转到 Assets 或 Context 的链接；没有可修复项时按钮仍显示"审查 0 项修复"。
- 建议：每条问题提供"去处理"链接；没有可修复项时隐藏按钮或更换文案。

#### UX-21 Web 端配对错误只显示通用提示，输入还会被清空

- 位置：`web/` 下 `use-session-controller.ts:1159-1162`、`session-layout.tsx:78-89`
- 判定：已确认缺陷；原调用方未等待配对请求结果即清空授权码，通用错误横幅又未包含在配对页中。
- 状态：本轮已修复并通过针对性测试，见[第二批修复节](#第二批修复2026-10-16)。标题描述为基线行为。
- 当前行为：配对页就地显示已知错误码对应的四语言说明与重新连接入口；请求期间禁用表单并显示进度，失败保留授权码和浏览器名，配对请求被接受后才清空授权码。未知错误显示可操作的通用说明，保留原有访问结束与协议不兼容处理。
- 建议：映射 `invalid_pairing_code`、`device_limit` 等错误码（桌面已有 `remote.error.pairing` 等文案可以复用）；失败时保留输入。

#### UX-22 Web 端"结束访问"没有确认

- 状态：已完成（第八批），当前行为、综合验证与覆盖边界见[第八批修复节](#第八批修复2026-10-16)。以下位置与现象保留为基线记录。
- 位置：`web/features/sessions/session-workspace.tsx:229-236`
- 建议：增加确认，并说明结束后需要重新配对。

### 操作层级与信息架构

#### UX-23 按钮多且没有主次

- 后续核对（本轮）：隔离浏览器另复现窄屏 MCP 键盘聚焦后操作部分裁切，已补聚焦时就近滚动及 Portal 边界保护，针对性和浏览器复核通过；完整应用与设备边界见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。

- 状态：已完成（第七批），实现范围、综合验证与实机覆盖限制见[第七批修复节](#第七批修复2026-10-16)。以下位置与静态分支数量保留为基线记录，不表示这些按钮会同时出现。
- 判定：操作层级候选；按钮数量来自静态分支汇总，同时可见数量待按状态实机确认。
- Skill 部署卡片：`desktop/features/skills/SkillManagerPanels.tsx:1131-1320`，最多约 10 个 outline 或 ghost 按钮；状态为"待确认共同基线"时，"收回"和"分发"同时出现。
- MCP 列表每行有 6 个同级按钮：`desktop/features/mcp/McpManagementPanel.tsx:362-433`；"移除"不是危险样式，确认框里没有服务名，也没设 destructive tone（`:420`）。
- Assets 页的删除按钮使用实心 primary 样式：`workspace/$workspaceId/assets.tsx:187, 235`。
- 建议：每种状态只突出一个推荐操作，其余收进"更多"菜单；危险操作统一使用 destructive 样式，确认框中写明对象名称。

#### UX-24 部署对话框的恢复重试文案与撤销文案需要区分

- 状态：已完成（第七批），实现范围、综合验证与实机覆盖限制见[第七批修复节](#第七批修复2026-10-16)。以下现象与位置保留为基线记录。
- 判定：原“全部成功后主按钮仍是重新审查”的结论撤回；剩余为文案与操作层级改进。
- 位置：`SkillManagerPanels.tsx:458-470, 781-786`（结果后的恢复状态回查）；`:836`（撤销部署仍复用应用文案）
- 现状：正常回查得到 `pendingRecovery` 对象（即使 targets 为空）后，不显示“重新审查”；该按钮主要用于回查失败、恢复状态尚未得到的分支，不能直接删除或改成只关闭对话框。撤销预览确认仍复用“应用无冲突位置”，未体现撤销语义。
- 建议：将恢复状态回查入口改成准确的重试文案并保留其能力；撤销流程使用独立文案，结合实际影响选择危险样式。

#### UX-25 MCP 页的反馈问题

- 后续核对（本轮）：实际 Registry 更新与生产 MCP 连接路径仍存在；独立自动检查属于增强，旧组件清理属于维护取舍，见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。

- 状态：已完成第八批范围内的结果对象识别与搜索反馈修复，综合验证通过；独立自动更新检查仍作为独立增强。当前行为见[第八批修复节](#第八批修复2026-10-16)，以下现象与位置保留为基线记录。
- 位置：`desktop/routes/(main)/catalog.tsx:751-756`；`desktop/features/mcp/McpManagementPanel.tsx:270-273, 450`
- 判定：结果对象识别与空状态文案有缺口；自动更新检查属于独立增强。
- 现状：
  - "更新"按钮由当前 Registry 搜索结果匹配安装项得出，尚无独立自动更新检查；
  - 批量启停结果显示 id，难以识别对应服务；虽然内部复用了 `import_*` key，实际界面文案为"成功 / 跳过 / 失败"，不能据此认定显示了错误的"收录"文案；
  - 搜索没有结果时，显示的是"当前作用域还没有 MCP Server"。
- 建议：结果显示服务名，区分搜索无结果与真正为空；自动更新检查单独估算与设计，不能视为文案修复。

#### UX-26 MCP、Hub 与设置的入口分散且互不链接

- 状态：已完成（第七批），实现范围、综合验证与实机覆盖限制见[第七批修复节](#第七批修复2026-10-16)。以下入口与位置保留为基线记录。
- 位置：
  - 设置 → 集成只显示 Hub 状态：`desktop/features/settings/GlobalSettings.tsx:294-305`；
  - 端口和局域网开关在 资产 → MCP → 高级：`catalog.tsx:660-684`。
- 其他：设置里的"发现"和 Skills 里的"发现"同名，但指的是两件事；Agent 资产面板只能看，不能跳转到对应的管理页。
- 建议：Hub 配置集中放在一处，另一处给出跳转链接；给其中一个"发现"改名。

#### UX-27 资产目录侧栏的计数与页面内容来源不一致

- 状态：已完成（第八批），当前行为、综合验证与覆盖边界见[第八批修复节](#第八批修复2026-10-16)。以下位置与现象保留为基线记录。
- 位置：`catalog.tsx:248-249`（Skills 和 MCP 的数字来自工作区扫描）；`SkillHubPage.tsx:138`（没有使用传进来的 workspaceAssets）
- 影响：侧栏数字和点进去看到的列表对不上。

#### UX-28 Web 访问设置信息过载，生效条件不明显

- 状态：已完成（第七批），实现范围、综合验证与实机覆盖限制见[第七批修复节](#第七批修复2026-10-16)。以下现象与位置保留为基线记录；保留显式保存流程，不改为切换开关即写入。
- 位置：`desktop/features/remote/WebAccessSettings.tsx:232-241, 413-423, 521-570`
- 现状：
  - "启用 Web 服务"开关还要再点"保存设置"才生效；
  - "生成授权码"在服务未运行时置灰，没有提示；
  - 中继区直接展示 frpc 退出码、信号等工程信息；
  - "配对码 / 授权码 / 邀请码"三种码同时出现，没说明区别。
- 建议：开关立即生效，或明确标出"有未保存的更改"；工程信息收进"诊断"折叠区；用一句话分别说明三种码的用途。

#### UX-29 桌面端会话的"文件与产物 / 会话操作"入口比 Web 端更难找

- 状态：已完成（第八批），当前行为、综合验证与覆盖边界见[第八批修复节](#第八批修复2026-10-16)。以下位置与现象保留为基线记录。
- 位置：`desktop/features/sessions/DesktopConversationPane.tsx:81-82`（用 CSS 隐藏了会话工具栏按钮），入口只剩 `SessionWindowToolbar.tsx:142-152` 的"…"菜单
- 建议：与 Web 端一致，在页头直接显示。

---

## P3

### 术语与文案

#### UX-30 术语不统一，工程用语直接展示给用户

- 后续核对（本轮）：继续修复本次确认可达的 MCP 控件与资源库说明缺译；保留技术对象、用户数据和协议原名，见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。

- 状态：已完成本轮主要入口与已确认路径修复，自动化验证通过，见[第六批修复节](#第六批修复2026-10-16)；不代表全仓文案或所有实机状态已审计。以下现象与位置保留为基线记录。

- 现状：
  - ChangeSet / 资产变更 / 审查变更：`changes.tsx:242` 写死了英文 "ChangeSet"，`nav.changes` 是"资产变更"，头部按钮是"审查变更"；
  - 受管 / 托管 / 受管理 / 未托管；
  - 部署 / 分发；
  - 资源库 / 库 / 技能库；Skill / 技能 / 技能包（Skills 的 sync 和 manager 两个区段各用一套）；
  - 会话 / 对话；
  - 确认续接 / 执行归属 / 托管续接（见 UX-07）；
  - "原生、主机、回执、核对"等工程用语出现在面向用户的文案中（`codex-copy.ts`、`composer-layout-copy.ts:17`）；
  - 中文界面里 `assets.skills` 显示为英文 "Skills"；ChangeSet、Hub 首次出现时没有任何解释。
- 建议：先出一份术语表（中 / 英 / 解释），再统一替换各语言文案；必要的专业名词首次出现时加 tooltip 说明。

#### UX-31 部分局部文案缺译，原“约 170 处缺翻译”统计不成立

- 后续核对（本轮）：已修复 MCP 编辑、导入、资源库额外 Agent 说明及 Web 执行管理默认关闭控件的实际缺译，新增针对性测试通过；全仓或所有实机状态仍不作完成声明，见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。

- 状态：已完成本轮主要入口与已确认路径修复，自动化验证通过，见[第六批修复节](#第六批修复2026-10-16)；不代表全仓文案或所有实机状态已审计。以下现象与位置保留为基线记录。

- 判定：部分缺译有代码依据，原数量及列举范围撤回；局部字典与 JSON 的组织方式属于设计取舍。
- 基线已确认位置：`desktop/features/workspace/ClaudeSessionPanel.tsx:92`、`ClaudeFilesPanel.tsx:16` 使用 `locale === "en-US" ? en : zh`，会让繁体和日文 locale 回退到简体。
- 核对结果：`conv/features/interactions/native-scope.tsx`、`question-form.tsx`、`native-decisions.tsx` 已有四语言字典；`managed-copy.ts:71` 的 `managedText` 也支持繁体和日文。绕过 `locales/*.json` 不等于未国际化，不能将这些组件整体计为缺译。
- 基线已确认遗漏：`managed-tasks.tsx:521` 的中文键比 `managed-copy.ts:57` 多了"默认"二字，无法匹配繁体与日文翻译；`desktop/features/remote/web-settings-copy.ts:46` 的简体文案中混入“停止僅表示中斷目前輪次…”等繁体文字。
- 建议：按实际运行路径重统计缺译，补齐二语回退和字典键遗漏；是否统一迁移 JSON 另行按维护成本评估。
- 验收：用 zh-TW、ja-JP 检查实际缺译入口，分别验证二语回退与动态键匹配；四语言 key 数量一致不能代替界面翻译验证。

#### UX-32 有少量文案没有走 i18n，或中英文意思不一致

- 状态：已完成（第九批），当前行为、综合验证与覆盖边界见[第九批修复节](#第九批修复2026-10-16)。以下列项与位置保留为基线记录。
- 基线记录：第六批 UX-30 已解决下列 Changes 裸 `ChangeSet` 与 catalog 裸 `STREAMABLE HTTP MCP HUB` 两处；本次修复前，其余 aria 标签、中英文语义不一致及用错 key 尚未处理。
- 硬编码：
  - `changes.tsx:242` 的 "ChangeSet"；
  - `catalog.tsx:643` 的 "STREAMABLE HTTP MCP HUB"；
  - `McpManagementPanel.tsx:316` 的 aria 标签 `select ${name}`。
- 不一致：`workspace.ignoreConfirm` 中文说去"资产中心"恢复，英文说去 "Settings"。
- 用错 key：`dialog.quit.changesApplying`（"请等待完成后再退出"）也被用在页面内切换时（`workspace/$workspaceId/route.tsx:63`），语义不对。

#### UX-33 桌面端显示了面向手机的文案

- 后续核对（本轮）：另确认桌面嵌入会话可打开的待处理中心仍称“本浏览器”，已改四语宿主中性说明并经真实入口验证，见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。

- 状态：已完成（第九批），当前行为、综合验证与覆盖边界见[第九批修复节](#第九批修复2026-10-16)。以下列项与位置保留为基线记录。
- 位置：`conv/.../codex-session-controls.tsx:1255`（"上传手机文件"）；`composer-layout-copy.ts:5`（"添加手机附件"）、`:27`（"当前浏览器未获发送授权"）
- 判定：共享组件中存在宿主相关文案；具体桌面可见状态待实机确认。
- 证据边界：桌面复用这些组件，本地设备 `accessMode` 为 `"full"`，但文案展示还受能力与状态分支控制。源码能证明存在误展示可能，不能据此认定所有桌面会话均会显示，尤其“未获发送授权”是否可达仍需逐状态验证。
- 建议：按宿主环境（桌面 / Web）选择文案；先验证附件入口与权限提示的实际可达条件。

### 导航与一致性

#### UX-34 导航快捷键顺序与侧栏顺序不一致，"会话"没有快捷键

- 状态：已完成（第九批），当前行为、综合验证与覆盖边界见[第九批修复节](#第九批修复2026-10-16)。以下列项与位置保留为基线记录。
- 位置：`desktop/core/keyboard-shortcuts.ts:38-62`；`desktop/features/app/global-navigation.ts`
- 现状：侧栏顺序为 首页 / 工作区 / Agent / 会话 / 资产目录 / 额度 / 洞察；快捷键 ⌘1–6 为 首页 / 工作区 / 资产 / Agent / 额度 / 洞察。资产目录在快捷键帮助中显示为"资产"（`labelKey: nav.assets`），侧栏叫"全局资产目录"。
- 建议：按侧栏顺序分配 ⌘1–7，标签使用同一个 key。

#### UX-35 Skills 子 Tab 的状态没有写入 URL

- 状态：已完成（第九批），当前行为、综合验证与覆盖边界见[第九批修复节](#第九批修复2026-10-16)。以下列项与位置保留为基线记录。
- 位置：`SkillHubPage.tsx:141`（外层分区写入了 URL，内层没有），离开页面再回来时子 Tab 状态丢失。

#### UX-36 "待同步 N 个"徽标不能点击

- 状态：已完成（第十批），当前行为、综合验证与覆盖边界见[第十批修复节](#第十批修复2026-10-16)。
- 当前行为：点击或通过键盘进入“使用位置”的待同步列表并聚焦对应区域；沿用原待同步状态与原审查入口，进入列表不执行同步。
- 基线位置：`SkillHubPage.tsx:455-459`；原建议为点击后定位到对应项目。

#### UX-37 Context 页默认 Agent 写死为 codex

- 状态：已完成（第十批），当前行为、综合验证与覆盖边界见[第十批修复节](#第十批修复2026-10-16)。
- 当前行为：默认使用当前工作区扫描中首个已检测到的受支持 Agent；有效 URL 参数与手动选择优先，无匹配时沿用 Codex 默认。扫描来源未匹配当前工作区时不提前请求，切换后不串用旧目录、选择或结果。
- 基线位置：`workspace/$workspaceId/context.tsx:93`；原建议为默认使用当前工作区检测到的第一个 Agent。

### 状态与细节

#### UX-38 空状态与错误状态

- 状态：已完成（第十批），本轮工作区与资源库查询状态、综合验证与覆盖边界见[第十批修复节](#第十批修复2026-10-16)。
- 基线复核：完全没有工作区时，列表复用了“没有匹配的工作区”说明；原“整页没有添加按钮”的判断不成立，页面顶部已有真实可用的“手动添加”入口。本批空态明确指向该入口，不增加第二个添加按钮。原位置：`desktop/features/workspace/WorkspaceListPanel.tsx:145`。
- 资产目录查询出错时显示为空：`catalog.tsx:116`（只判断了 isPending）。该基线问题现已区分首次加载、具名读取失败及有缓存的刷新失败，并保留重试入口和已有内容。
- 与 UX-25 重叠的 MCP 搜索无结果与真正为空问题已在第八批处理，当前行为与验证见[第八批修复节](#第八批修复2026-10-16)；第八批当时未将本条其他空态与错误态标记完成，本批继续处理上述工作区与资源库路径。

#### UX-39 全局错误横幅不能关闭，切换页面后仍然保留

- 状态：已完成（第十批），当前行为、综合验证与覆盖边界见[第十批修复节](#第十批修复2026-10-16)。
- 当前行为：全局操作提示可关闭，切换页面只收起上页已观察到的消息版本；保留原始错误状态，目的页新错误及同文本的新发布仍显示。Runtime 与查询专属失败条继续使用各自状态，不概括为所有错误都可关闭。
- 基线位置：`desktop/routes/(main)/route.tsx:159-164`

#### UX-40 变更数为 0 时仍显示"拒绝变更"，新计划可能沿用旧选择

- 状态：已完成（第十一批），当前行为、最终验证与覆盖边界见[第十一批修复节](#第十一批修复2026-10-16)。下述位置与原现象保留为基线。
- 当前行为：实际文件变更为 0 时提供“返回”，不显示应用、拒绝或无意义授权；标准计划仍可继续规划 Home。文件按钮仍是单个 Diff 浏览，越界索引回退实际首文件，不新增多选或“全取消”模型。

- 位置：`changes.tsx:335, 353`；无变更时应用按钮存在但禁用，仍显示"拒绝变更"，建议改成"返回"等更符合空计划的文案。
- 基线另有：生成 Home 变更后 `selected` 没有重置，可能越界，被误显示成"配置已同步"；本次已修复选择状态部分，见下方修复记录。

#### UX-41 Assets 添加 Skill / MCP 时缺少校验反馈

- 状态：已完成（第十一批），当前行为、最终验证与覆盖边界见[第十一批修复节](#第十一批修复2026-10-16)。下述位置与原现象保留为基线。

- 位置：`assets.tsx:65, 87`
- 现状：字段为空时点添加没有反应；同名项会被静默覆盖；输入框只有 placeholder，没有 label；列表为空时没有空状态。

#### UX-42 工具批量更新的结果只有成功和失败的数量

- 状态：已完成（第十一批），当前行为、最终验证与覆盖边界见[第十一批修复节](#第十一批修复2026-10-16)。下述位置与原现象保留为基线。
- 当前行为：沿原串行执行 API 显示逐 Agent/action 的实际状态、输出、退出码和版本；请求抛错标记为结果未确认，保留原因并提示先检测，不自动重试。

- 位置：`desktop/features/settings/AgentToolsSettings.tsx:277-285`
- 建议：与 Skill 部署一致，逐项列出每个 Agent 的结果和失败原因。

#### UX-43 端口输入框不随状态同步，非法值被静默忽略

- 状态：已完成（第十一批），当前行为、最终验证与覆盖边界见[第十一批修复节](#第十一批修复2026-10-16)。下述位置与原现象保留为基线。

- 位置：`catalog.tsx:572, 672`（使用 `defaultValue`）

#### UX-44 会话细节

- 状态：已完成（第十二批），当前行为、最终自动化验证与覆盖边界见[第十二批修复节](#第十二批修复2026-10-16)。下述位置与原现象保留为基线。
- 当前：审批显示工具/操作名称及请求 ID；历史搜索使用本地化时间和 Agent 名称；两端离线可继续编辑未提交草稿，保留在途锁与严格发送门控。移动端键盘表现仍待实机。

- 审批列表不显示工具名，多条审批分不清：`conv/.../session-reader.tsx:159-169`。
- 搜索结果直接显示原始 ISO 时间和 agent id（如 `claude-code`）：`history-search.tsx:612, 619`。
- 断线时 `session-composer.tsx:373` 会禁用输入框，阻止继续编辑草稿，这一点已由源码确认；移动端是否因此收起键盘属于设备与浏览器行为，待实机验证。建议评估只禁用提交是否符合其他在途状态约束，避免连带放宽 busy/submitted 时的保护。

#### UX-45 Web 端部分触控目标小于 44px

- 状态：已完成（第十二批），当前行为、最终自动化与隔离 Chromium 尺寸验证、覆盖边界见[第十二批修复节](#第十二批修复2026-10-16)。下述位置与尺寸保留为基线。
- 当前：刷新、工作区折叠与 Info 三个目标均至少 44×44，保持原请求、路由与原生路径披露行为；完整应用与手机实机仍未验收。

- 位置：`web/features/sessions/session-workspace.tsx:194-201`（刷新按钮 32px）；`session-catalog.tsx:109, 123`（工作区行高 36px，Info 按钮约 30px）

---

## 疑点核对（保留原始描述）

部分源码事实已确认，仍需区分产品取舍与缺陷，不据此直接扩大本次修复范围。

| ID | 描述 | 位置 |
|---|---|---|
| Q-01 | 预览读取磁盘、不包含 Assets 草稿的事实成立，也可能有意展示“当前生效配置”；是否加入草稿预览属于产品取舍，应先明确当前展示范围与页面说明。 | `context.tsx:102` |
| Q-02 | 切换工作区会清空所有来源的待审计划，并非 Doctor 特例；是否跨工作区保留待审计划属于设计取舍。应用期间已有阻止切换的保护，本次继续保持。 | `desktop/features/app/useWorkspaceTransitions.ts:122` |
| Q-03 | Web 会话列表组件没有 loading 状态，首次加载时可能先闪现"暂无可读会话"。 | `web/` 下 `session-catalog.tsx:163-166` |
| Q-04 | 桌面打开可交互会话时只保留 catalogNotice，远程主机离线、部分扫描失败等提醒可能不再显示。 | `desktop/features/sessions/SessionHubPage.tsx:105-114` |
| Q-05 | `McpConnectionCard` 只有组件自身与测试引用，未发现生产入口；两条旧说明 key 也未发现使用。不能据此认定连接功能已消失：主列表通过 `McpBatchConnectionPanel` 提供连接入口。是否清理旧组件、测试和未使用文案需单独决定。 | `desktop/features/mcp/McpConnectionCard.tsx`；`McpManagementPanel.tsx:211`；`zh-CN.json:442-443` |

本轮核对状态（上表保留原始观察与基线位置，当前实现和验证边界见[疑点核对与修复](#疑点核对与修复2026-10-16)）：

| ID | 判定与当前状态 |
|---|---|
| Q-01 | 读取磁盘是现有预览边界，不新增草稿预览模式；页面缺少范围说明属于已确认缺陷，已修复并通过针对性测试。 |
| Q-02 | 跨工作区失效待审计划是工作区范围约束；另复现异步检查返回前开始应用仍能切换的竞态，已修复并通过针对性测试。 |
| Q-03 | 已确认缺陷：首次目录请求未完成时误显示缺少目录/升级提示，且慢请求可能被无选中会话的离开动作错误丢弃；已修复，新增 14 项及相关 8 文件回归通过。 |
| Q-04 | 已确认缺陷：嵌入可交互会话时遗漏目录级提醒；已统一提醒展示并通过针对性测试。 |
| Q-05 | 未发现生产连接功能缺陷；保留旧组件、测试与未使用文案，已通过实际连接入口的四语审查和授权验证。 |

---

## 第一批修复（2026-10-16）

状态：UX-02、UX-12 与旧草稿缓存问题已修复并通过针对性自动化验证。上文保留基线问题与原位置，以下记录本次修改后的行为；尚未启动应用实机验收。

| 范围 | 实现后的行为 | 相关实现 |
|---|---|---|
| UX-02：计划与草稿 | 记录计划实际使用的 manifest 输入；草稿编辑会使旧计划失效，生成响应返回前校验工作区与草稿。Doctor 保持磁盘修复计划的含义，应用后保留未被该计划消费的 Assets 草稿。 | `desktop/features/workspace/workspace-store.ts`；`desktop/routes/(main)/workspace/$workspaceId/doctor.tsx`、`route.tsx`、`changes.tsx` |
| UX-02：应用后回读与缓存 | 回读更新磁盘 baseline，同时保留在应用或回读期间继续编辑的草稿，包括编辑回旧 baseline 的情况；已消费且干净的草稿删除缓存，仍有未保存编辑则刷新缓存。切换工作区时，当前草稿已干净也会移除旧缓存，避免再次进入时恢复旧内容。 | `desktop/features/workspace/workspace-store.ts`；`desktop/features/app/useWorkspaceTransitions.ts` |
| UX-12：Home 计划状态 | 传递完整 Promise，同步请求锁覆盖 Home 计划生成和应用流程，阻止重复生成、生成期间应用旧计划或拒绝离开；失败在审查页面显示并可重试，过期响应不安装到 store。 | `desktop/routes/(main)/workspace/$workspaceId/changes.tsx` |
| 应用期间刷新 | 工作区父页的扫描、审查，以及全局工具栏和原生刷新入口遵守应用锁，避免卸载审查页面后丢失成功处理。 | `desktop/routes/(main)/workspace/$workspaceId/route.tsx`；`desktop/features/app/useAppNavigation.ts` |
| UX-40：新计划的选择状态 | 新计划会重置选中文件及 Home 授权，修复选中项可能越界、误显示“配置已同步”的部分；零项时应用按钮禁用但仍显示“拒绝变更”，该文案仍待处理。 | `desktop/routes/(main)/workspace/$workspaceId/changes.tsx` |

针对性测试新增于 `workspace-store.test.ts`、`useWorkspaceTransitions.test.tsx`、`-changes-route.test.tsx`，并扩展 `useAppNavigation.test.tsx`，覆盖草稿版本失效、Doctor 草稿保留、生成请求竞态、应用后缓存消费/保留、干净草稿切换、Home 进行中状态与互斥、本页失败重试和应用期间刷新入口。

实际验证（工作目录 `apps/desktop`；本机 pnpm shim 报 `ENOEXEC`，使用项目已安装的 `.bin`，未安装依赖）：

```sh
./node_modules/.bin/vitest run \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  src/features/workspace/workspace-store.test.ts \
  src/features/workspace/workspace-flow.test.ts \
  src/features/workspace/WorkspaceDoctorPage.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/app/useAppNavigation.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx
./node_modules/.bin/tsc -b --pretty false
```

- Vitest：8 个文件、79 项测试通过。
- 桌面 TypeScript 构建检查：通过。
- 根目录对本次 10 个 TS/TSX 文件的 `oxfmt --check`：通过；定向 `oxlint`：0 错误、12 项警告（未使用导入、Hook 依赖等）。
- `git diff --check`：通过；文档检查确认原 45 个 UX ID 均保留且无重复。

---

## 第二批修复（2026-10-16）

状态：UX-03、UX-06、UX-13、UX-21 已修复并通过针对性及综合自动化验证。上文保留各问题的基线现象，以下记录本轮修改后的行为；尚未启动应用实机验收。第二批当时仅保证刷新失败结束后保留已有内容，未覆盖在途刷新时保留页面；这一当批范围限制的后续处理见[第五批修复节](#第五批修复2026-10-16)。

| 范围 | 实现后的行为 | 相关实现 |
|---|---|---|
| UX-03：工作区首次加载失败 | 本地扫描或 Runtime 状态请求失败后，在当前内容区显示错误与重试入口；重试重新请求，已有内容不因刷新失败被替换成永久骨架屏。扫描返回时隔离旧工作区响应，避免错误或结果写入后来选中的工作区。 | `desktop/routes/(main)/workspace/$workspaceId/route.tsx` |
| UX-06：MCP 与记忆操作 | MCP 高级操作使用同步锁覆盖确认、密钥输入、请求和刷新；卸载、停止实例等失败显示可重试的可见错误，安装等按钮遵守 busy 状态。错误移到高级折叠区之外；切换作用域后不再提交尚未开始的旧操作，已提交操作仍写入并刷新原作用域，旧作用域错误不显示到新作用域；卸载、端口、网络设置及停止全部作用域实例等全局操作的失败仍保持可见。记忆批准、拒绝、作废均显示进行中和错误，失败可重试并保留编辑内容。 | `desktop/routes/(main)/catalog.tsx`；`desktop/features/catalog/MemoryCard.tsx` |
| UX-13：启用会话索引 | 复用现有异步清理模式与翻译 key，同步 ref 锁防止重复请求，持续显示“启用中”并禁用按钮；失败在启用面板显示错误，释放锁后可以重试。实际索引状态仍由 Runtime 返回值控制，启用后正常读取会话。 | `desktop/features/workspace/WorkspaceSessionsPage.tsx` |
| UX-21：Web 配对反馈 | 配对页就地显示授权码失效、设备上限、待确认请求上限、限流、已有配对、输入非法、连接验证失效七类错误的四语言说明；未知错误使用通用重试说明。配对请求有同步锁及进行中反馈，失败保留授权码和浏览器名，请求被接受后清空授权码，即使后续状态刷新失败也不恢复已使用的码。保留访问结束和协议不兼容分支，错误区提供重新连接入口。 | `web/features/connection/pairing-page.tsx`、`pairing-error-copy.ts`；`web/features/conversation/features/sessions/use-session-controller.ts`（配对控制逻辑同步到桌面镜像） |

针对性测试与实际验证：

- UX-03：新增 `desktop/routes/(main)/workspace/$workspaceId/-workspace-load.test.tsx`，9 项测试通过，覆盖首次扫描失败、Runtime 失败、重试成功与进行中保护、刷新失败保留已有草稿、旧工作区的在途或已显示错误隔离、Doctor 可访问、应用期间禁止重试，以及另一刷新入口成功后清除旧错误、先发请求的迟到失败不覆盖新成功。
- UX-06：扩展 `desktop/features/mcp/McpHubPage.test.tsx`，新增 `desktop/features/catalog/MemoryCard.test.tsx`，覆盖查询错误在高级区折叠时可见、确认/密钥/请求期间互斥、安装/更新/卸载/实例操作失败重试、取消释放锁、作用域切换前后异步隔离，以及三类记忆审核和编辑内容保留；新增全局卸载、端口、LAN 和停止全部实例跨作用域失败仍可见的回归。两个文件共 28 项测试通过（24 + 4）。
- UX-13：扩展 `desktop/features/workspace/WorkspaceSessionsPage.test.tsx`，新增两项测试，覆盖延迟请求、同步重复点击、失败显示、重试清除错误，以及 Runtime 实际启用后读取会话；该文件 31 项测试通过。
- UX-21：新增 `web/features/connection/pairing-controller.test.tsx`，扩展 `pairing-page.test.tsx`。覆盖七类真实错误码、网络与未知错误、异常响应、延迟请求与重复提交、失败保留输入及成功重试、配对成功后刷新失败、手动重连、原有访问结束与协议不兼容分支；界面测试覆盖四语言映射、未知/原型属性名回退、原位错误与进行中禁用。

实际验证（均使用已安装的工具，未安装依赖）：

```sh
# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-workspace-load.test.tsx' \
  src/features/workspace/workspace-store.test.ts \
  src/features/workspace/workspace-flow.test.ts \
  src/features/workspace/WorkspaceDoctorPage.test.tsx \
  src/features/workspace/WorkspaceSessionsPage.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/app/useAppNavigation.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx \
  src/features/mcp/McpHubPage.test.tsx \
  src/features/catalog/MemoryCard.test.tsx \
  src/core/i18n.test.ts \
  src/features/sessions/DesktopCatalog.integration.test.tsx
./node_modules/.bin/tsc -b --pretty false

# 工作目录 apps/web
./node_modules/.bin/vitest run \
  src/features/connection/pairing-controller.test.tsx \
  src/features/connection/pairing-page.test.tsx \
  src/conversation.test.tsx \
  src/catalog-recovery.test.tsx \
  src/web-client.test.ts
./node_modules/.bin/tsc -b --pretty false
```

- 桌面综合 Vitest：14 个文件、169 项测试通过。
- Web Vitest：5 个文件、251 项测试通过；桌面会话目录集成的 13 项测试也包含在上方桌面回归中。
- 桌面与 Web TypeScript 构建检查：通过。
- 根目录对 18 个文件的 `oxfmt --check`：通过；定向 `oxlint`：0 错误、31 项警告（包括本轮新增的 `enableError` effect 状态更新告警）。
- `git diff --check`：通过；文档检查确认原 45 个 UX ID 均保留且无重复。
- 静态核对：桌面四种 locale 的 2229 个 key 完全对齐；桌面与 Web 的配对函数保持镜像。

---

## 第三批修复（2026-10-16）

状态：UX-04、UX-08、UX-09、UX-14、UX-16、UX-17、UX-20 已修复并通过针对性及综合自动化验证。上文保留基线现象与原位置，以下记录本轮修改后的行为。UX-08 的撤销能力仍待单独评估。尚未启动应用实机验收，也未进行真实窄屏验收。

| 范围 | 本轮实现行为 | 相关实现 |
|---|---|---|
| UX-04：首页引导推进 | 按 `acknowledged_version < version` 显示引导，已有工作区后仍保留诊断、审查修复步骤；未确认引导与无工作区空状态二选一，避免重复同一主操作。确认当前版本后隐藏引导，新版本可重新展示。 | `desktop/features/home/GlobalHome.tsx`、`GettingStartedCard.tsx` |
| UX-16：添加入口语义 | 首页分别提供“添加单个工作区”与“添加扫描目录”，说明前者选择现有项目并直接打开、后者扫描父目录发现工作区。单工作区复用现有安全添加与导航流程，保留应用期间保护；扫描目录仍通过授权目录选择、登记与发现刷新执行，成功后使扫描目录缓存失效。添加操作共享同步锁、禁用状态与可见错误，失败可重试，取消目录选择不写入。 | `desktop/features/home/GlobalHome.tsx`、`GettingStartedCard.tsx`、`HomeRecentSections.tsx`；`desktop/routes/(main)/index.tsx` |
| UX-08：成功反馈与本次回看 | 记录当前运行期间最近一次普通应用成功后的实际写入文件与备份目录，在对应工作区提供成功提示和“查看本次变更”；成功写入后的刷新失败仍保留该结果。回看只显示本次已写入文件的只读 Diff 与备份路径，不沿用可执行的待审计划，不提供持久历史。备份路径只是恢复线索，本轮没有新增撤销或写盘恢复入口，撤销仍待后续单独评估。 | `desktop/features/workspace/workspace-store.ts`、`AppliedChangesNotice.tsx`、`WorkspaceChangeDiff.tsx`；`desktop/routes/(main)/workspace/$workspaceId/changes.tsx`、`route.tsx` |
| UX-09：持续草稿提示与就地放弃 | 工作区持续显示存在草稿及发生变化的分区数量；Assets 提供确认后放弃草稿的入口，恢复基线并原子清理对应缓存、失效计划及其关联交接；没有计划的导入恢复请求保留。确认期间若切换工作区或草稿继续变化，不丢弃新内容；应用、加载或放弃期间受互斥保护。“审查变更”不可用时给出对应原因。 | `desktop/features/workspace/manifest-draft.ts`、`workspace-store.ts`；`desktop/routes/(main)/workspace/$workspaceId/route.tsx` |
| UX-14：Skill 操作结果与下一步 | 加入、更新、回滚、移入回收区、恢复分别显示准确结果及对象名称，批量加入显示数量；只有相关本库部署仍存在时提示已部署副本未变并提供“查看部署”。单项结果且刷新后资源库仍包含该 Skill 才显示“分发”入口；移入回收区或批量多项不提供含糊的分发按钮，刷新失败不掩盖已完成的操作。 | `desktop/features/skills/SkillHubPage.tsx`；`desktop/locales/*.json` |
| UX-17：只读条直接续接 | 在始终可见的只读提示条提供带文字的续接入口，与工具栏复用同一来源验证和导航逻辑，目标使用已验证的历史索引 ID。能力核对中、远程来源、仅元数据、没有可用历史索引、缺少实际工作区、聚合集合及不支持的格式分别解释；原有可读性、能力和真实工作区门控保持不变。 | `desktop/features/sessions/SessionHistoryContent.tsx`、`SessionWindowToolbar.tsx`、`useHistoryContinuation.ts`；`desktop/locales/*.json` |
| UX-20：Doctor 手动处理路径 | 根据问题代码提供 Context、Skills 或 MCP 对应入口；跳转保持当前工作区并选择真实资产分区。Context 仍需用户手动选择对应 Agent 与目录，不自动定位问题来源；MCP 入口用于查看现有连接，若需修改配置 targets，按问题说明到外部处理。配置损坏、托管文件或只读来源等问题提供外部修正说明，不生成无效跳转；未知问题有通用指导。没有自动修复项时隐藏“审查修复”按钮，仍保留检查与手动处理说明。 | `desktop/features/workspace/WorkspaceDoctorPage.tsx`、`doctor-manual-actions.ts`；`desktop/routes/(main)/workspace/$workspaceId/doctor.tsx`；`desktop/locales/*.json` |

分组针对性验证（工作目录 `apps/desktop`；使用项目已安装的工具，未新增依赖）：

- UX-04、UX-16：扩展 `GlobalHome.test.tsx`、`GettingStartedCard.test.tsx`，新增路由集成 `-home-actions.test.tsx`，同时回归 `useAppNavigation.test.tsx`、`useWorkspaceTransitions.test.tsx`。5 个文件、43 项测试通过；四语文案合并后按同一命令再次通过。覆盖引导版本、添加后推进、空状态互斥、真实回调对应的 API 与导航、取消、应用锁及失败重试。
- UX-14：`SkillHubPage.test.tsx`、`SkillManagerPanels.test.tsx`、`SkillImportDialog.test.tsx` 3 个文件、75 项测试通过，四语文案合并后再次通过；覆盖不同操作结果、单项与批量下一步、相关部署筛选和刷新后的按钮有效性。
- UX-17、UX-20：`SessionHubPage.test.tsx`、`useSessionSourceCapability.test.tsx`、`WorkspaceDoctorPage.test.tsx`、`-doctor-actions.test.tsx` 4 个文件、60 项测试通过，四语文案合并后再次通过；会话用例覆盖始终可见的文字入口、未核对时不提前启用、索引身份导航及不可续接原因；Doctor 用例覆盖真实问题映射、外部处理说明、零项隐藏及当前工作区的实际目标跳转。
- UX-08、UX-09：6 个文件、69 项测试通过，覆盖应用成功结果和只读回看、成功写入后刷新失败仍保留结果、草稿分区计数、确认取消、确认期间新增编辑或工作区切换、应用锁、原子清理及无计划导入恢复请求的保留。上述分组全部包含在下方综合回归中，不累加为独立总数。

上述已执行的分组命令：

```sh
./node_modules/.bin/vitest run \
  src/features/home/GlobalHome.test.tsx \
  src/features/home/GettingStartedCard.test.tsx \
  'src/routes/(main)/-home-actions.test.tsx' \
  src/features/app/useAppNavigation.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx

./node_modules/.bin/vitest run \
  src/features/skills/SkillHubPage.test.tsx \
  src/features/skills/SkillManagerPanels.test.tsx \
  src/features/skills/SkillImportDialog.test.tsx

./node_modules/.bin/vitest run \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/sessions/useSessionSourceCapability.test.tsx \
  src/features/workspace/WorkspaceDoctorPage.test.tsx \
  'src/routes/(main)/workspace/$workspaceId/-doctor-actions.test.tsx'
```


本轮综合验证（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run \
  src/features/home/GlobalHome.test.tsx \
  src/features/home/GettingStartedCard.test.tsx \
  'src/routes/(main)/-home-actions.test.tsx' \
  src/features/app/useAppNavigation.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/skills/SkillHubPage.test.tsx \
  src/features/skills/SkillManagerPanels.test.tsx \
  src/features/skills/SkillImportDialog.test.tsx \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/sessions/useSessionSourceCapability.test.tsx \
  src/features/workspace/WorkspaceDoctorPage.test.tsx \
  'src/routes/(main)/workspace/$workspaceId/-doctor-actions.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-draft-actions.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-workspace-load.test.tsx' \
  src/features/workspace/workspace-store.test.ts \
  src/core/i18n.test.ts \
  src/features/workspace/WorkspaceSessionsPage.test.tsx \
  src/features/mcp/McpHubPage.test.tsx \
  src/features/catalog/MemoryCard.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx \
  src/features/workspace/workspace-flow.test.ts \
  src/features/sessions/DesktopCatalog.integration.test.tsx
./node_modules/.bin/tsc -b --pretty false
```

- 桌面综合 Vitest：24 个文件、331 项测试通过，包含本轮全部分组与前两批相关回归。
- 桌面 TypeScript 构建检查：通过。
- 根目录对本轮 32 个代码与 locale 文件的 `oxfmt --check`：通过；定向 `oxlint` 退出码为 0，保留 3 条既有告警：工作区 `route.tsx` 的加载 effect 依赖，以及 `changes.tsx` 的计划 effect 依赖、effect 内状态更新。HEAD 中已有对应 effect。
- `git diff --check`：通过；文档检查确认原 45 个 UX ID 全部保留且无重复。
- 静态核对：桌面四种 locale 各 2272 个 key，集合完全对齐。
- 覆盖限制：以上为自动化与静态验证，未启动应用实机操作，尚未进行真实窄屏与键盘交互验收。UX-08 只保留当前运行期间最近一次普通应用结果的回看，不提供持久历史或撤销。

---

## 第四批修复（2026-10-16）

状态：UX-01、UX-05、UX-07 已完成本轮范围的修复并通过针对性及综合自动化验证。上文保留原问题、分级和基线位置；UX-05 只打开来源会话，当前不自动跳到命中消息。尚未进行真实输入法、键盘、手机及携带真实上传附件跨会话导航的实机验收。

| 范围 | 本轮实现行为 | 相关实现 |
|---|---|---|
| UX-01：输入框发送快捷键 | 桌面和 Web 使用普通 Enter 发送、Shift+Enter 换行，并在输入框旁显示四语言提示。快捷键调用现有表单提交路径，保持发送能力、请求中、文本/附件有效性及压缩状态限制；IME 组字标志、组合事件与浏览器 `keyCode=229` 不触发发送，重复按键不重发，Ctrl、Meta、Alt 组合不拦截。同步锁防止同一批次 Enter 与表单提交重复发送，迟到响应不清理另一会话的新草稿。steer 与加入队列继续使用原操作入口，压缩期间已有队列能力保持。 | `conv/features/sessions/session-composer.tsx`、`composer-layout-copy.ts`（Web 同步） |
| UX-05：显式打开来源会话 | 搜索命中原文详情另增“打开会话”；会话内跨会话打开前确认清理未发送的草稿、历史引用和附件，取消保留当前内容。打开前重新核对命中原文、正文索引状态、当前访问范围和目录中的实际会话及别名，失效、不可读或范围变化的来源不导航。打开锁绑定请求代次和中止信号；返回结果后，未结束的旧传输不阻止重试，旧响应也不释放新请求的锁。只打开来源会话并沿用正常历史读取流程，当前不能自动跳到命中消息；命中原文仍在搜索定位窗口中查看。原有“引用到当前会话”保持当前目标与草稿，只有显式打开才执行导航。 | `conv/features/history/history-search.tsx`、`history-search-controls.tsx`、`history-session-target.ts`、`history-copy.ts`（Web 同步）；`desktop/features/sessions/DesktopHistorySearch.tsx` |
| UX-07：交接禁用原因与术语 | “执行管理”面板在交接/交还按钮附近显示当前禁用原因与真实下一步，覆盖进行中、未知结果、压缩、工具不可用、Claude 资格、当前来源/控制状态、访问与权限、确认及历史核验。历史核验未完成时保持禁用；失败后说明关闭再打开面板重试。Claude 原门控逐项等价，按钮原限制不放宽，未知结果继续走已有回执核对。转交执行权统一称“交给 AgentKib”，相关面板称“执行管理”；原生 resume 和“在工作区续接”保留各自语义。局部四语言字典与两端组件同步。 | `conv/features/sessions/managed-tasks.tsx`、`claude-handoff.ts`、`managed-control-copy.ts`、`managed-copy.ts` 及相关展示字典（Web 同步）；桌面/ Web 共享会话文案 |

文档同步：`docs/sessions/conversations.md` 记录发送规则、交接术语与能力边界；`docs/sessions/content-search.md` 记录显式打开的确认、重核对与当前无法自动定位命中消息的限制。没有新增大 JSON locale key；局部发送提示和禁用原因均有四语言文案。

已完成的分组验证：

- UX-01：桌面新增 `session-composer.test.tsx`，1 个文件、28 项测试通过；Web 对应组件测试与既有 `conversation.test.tsx` 共 2 个文件、212 项通过。覆盖 Enter 与发送按钮路径一致、Shift/修饰键、IME 及 229、重复按键、不可发送、上传中/失败/附件单独发送、资源引用有效性、steer/队列、未知结果保护、切换会话的迟到响应和四语言提示。
- UX-07：桌面真实组件反馈用例 1 个文件、22 项通过；Web 门控矩阵、组件反馈与原执行管理回归 3 个文件、87 项通过。覆盖 28 种禁用与 4 种允许情况、核验中/缺失/失败、确认、工具状态、两种 Agent 的压缩交接与交还、在途防重及四语言原因关联。
- UX-05：桌面 3 个文件、27 项通过，Web 2 个文件、26 项通过。覆盖打开前重核对、权限/范围变化、不可读与目录别名、重复请求和四语文案；真实会话 Provider 与路由用例实际输入草稿并引用，验证引用保持当前会话/草稿、取消打开保留、确认后进入来源历史、同源打开保留草稿。另覆盖旧传输忽略中止或永不结束时仍可重新打开，以及旧请求结束不释放新锁。此处未包含完整真实附件上传后跨会话导航验收。
- 下方综合回归包含本轮分组与相关既有用例；各分组与综合数字有重叠，不累加为独立总数。

已执行的分组命令：

```sh
# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx

# 工作目录 apps/web
./node_modules/.bin/vitest run \
  src/features/conversation/features/sessions/session-composer.test.tsx \
  src/conversation.test.tsx

# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx

# 工作目录 apps/web
./node_modules/.bin/vitest run \
  src/features/sessions/claude-handoff.test.ts \
  src/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/managed-tasks.test.tsx

# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  src/features/sessions/conversation/features/history/history-search-open.test.tsx \
  src/features/sessions/conversation/features/history/history-search-navigation.test.tsx \
  src/features/sessions/DesktopHistorySearch.test.tsx

# 工作目录 apps/web
./node_modules/.bin/vitest run \
  src/features/conversation/features/history/history-search-open.test.tsx \
  src/features/conversation/features/history/history-search-navigation.test.tsx
```

最终综合验证：

```sh
# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  src/core/i18n.test.ts \
  src/features/sessions/DesktopConversation.integration.test.tsx \
  src/features/sessions/DesktopCatalog.integration.test.tsx \
  src/features/sessions/DesktopHistorySearch.test.tsx \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/app/GlobalSearchDialog.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/conversation/features/history/history-search-open.test.tsx \
  src/features/sessions/conversation/features/history/history-search-navigation.test.tsx \
  src/features/sessions/conversation/features/sessions/session-transcript.test.tsx
./node_modules/.bin/tsc -b --pretty false

# 工作目录 apps/web
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit --pretty false
```

- 桌面综合 Vitest：12 个文件、175 项测试通过。
- Web 全量 Vitest：43 个文件、900 项测试通过。
- 两端 TypeScript 检查：通过。
- 根目录对本轮 40 个代码与 locale 文件的 `oxfmt --check`：通过；定向 `oxlint` 退出码为 0，保留 28 条既有 Hook 告警（18 条 effect 内状态更新、10 条依赖检查）。对修改前六个组件快照使用相同配置检查，同样得到这 28 条告警。
- 静态核对：四语大 JSON 各 2272 个 key、集合完全对齐；桌面与 Web 的三条共享交接文案四语值一致；`composer-layout-copy`、`managed-control-copy`、`history-copy`、`history-session-target` 的两端镜像除类型导入外一致。
- `git diff --check`：通过；文档检查确认原 45 个 UX ID 全部保留且无重复。
- 覆盖限制：未进行真实输入法、硬件键盘或手机实机验收；导航测试使用真实组件、Provider 和路由验证文本草稿/引用，未完整验收真实附件上传后跨会话导航。UX-05 的打开入口沿用普通历史读取流程，不自动跳到命中消息。

---

## 第五批修复（2026-10-16）

状态：UX-10、UX-11、UX-15、UX-18、UX-19 已完成修复并通过针对性及综合自动化验证。下表记录本轮实现后的行为，上文继续保留各问题的基线现象与位置，前四批验证记录保持原批次含义。尚未进行应用实机验收。

| 范围 | 本轮修复行为 | 相关实现 |
|---|---|---|
| UX-10：概览中的待审计划 | 对有效且有实际变更的非 Doctor 计划，在工作区概览提供待审提示与审查入口；Doctor 保留现有专门卡片。空计划、其他工作区计划不显示；仅对普通 standard 计划检查其绑定草稿版本并过滤失效计划，Doctor 可以合法针对磁盘生成计划并保留编辑器草稿。 | `desktop/routes/(main)/workspace/$workspaceId/index.tsx` 及待审计划判定 |
| UX-11：在途保留页面与草稿 | 扫描刷新或生成计划期间保留已经加载的 Outlet 与局部状态，只显示局部进行中反馈；依赖扫描数据的页面首次没有可用内容时仍显示骨架，失败保留内容并提供原位重试。保留内容后，路由刷新与全局刷新均核对请求开始时的草稿快照，避免回读覆盖期间新增编辑；两类用户刷新入口通过共享忙碌状态防重，工作区初次加载不被旧工作区忙碌状态阻挡。已挂载的审查页在全局忙碌期间禁止应用、生成 Home 计划及拒绝计划；仍遵守应用锁与工作区响应隔离。 | `desktop/routes/(main)/workspace/$workspaceId/route.tsx`；`desktop/features/app/useAppNavigation.ts` |
| UX-15：最近活动的正确目标 | 首页“最近活动 → 查看全部”改为打开现有「设置 → 诊断 → 活动记录」，路由为 `/settings`，`settingsSection=diagnostics`、`settingsTarget=diagnostics-activity`。复用现有 ActivityPage，不新增活动系统；该列表范围沿用活动 API 默认最近 200 条记录，不是无限历史。首页保留最近三条、加载与空态说明；独立侧栏洞察入口与快捷键保持。 | `desktop/features/home/HomeRecentSections.tsx`、`GlobalHome.tsx`；`desktop/routes/(main)/index.tsx`；目标为 `desktop/features/settings/GlobalSettings.tsx` 既有 `diagnostics-activity` 锚点 |
| UX-18：设置开启入口 | 桌面正文索引关闭时，在提示下提供“前往设置”，通过主应用导航打开隐私设置；嵌入会话子路由与独立目录共用该能力；全局搜索仅在确认已打开设置后关闭，应用期间导航被阻止时保留搜索窗口。没有主应用导航上下文的宿主只显示明确路径，不提供无效按钮。Web 的四语说明引导联系主机所有者，在主机桌面「设置 → 隐私 → 会话正文搜索」启用，不跳转到浏览器不存在的本地设置，也不直接修改开关；索引门控保持。 | `desktop/features/app/AppNavigationContext.tsx`、`GlobalSearchDialog.tsx`；`conv/features/history/history-search.tsx`、`history-copy.ts`；Web 的 `history-copy.ts` |
| UX-19：待交接状态的可识别性 | 在当前会话身份、来源可读性、访问权限、控制状态和真实能力均满足时，分别显示“待交接”或原生“待恢复”，提供打开既有确认/管理面板的入口。正在核对、尚未验证、结果未知、待授权、权限不足、控制未启用或协议不可用分别说明；远程、元数据、辅助来源、审批/问题未处理、压缩及离线等情况不冒充可交接。Claude 复用原交接门控与已有输入区入口；Codex 在正文区提供真实入口，原生恢复审查自动展开，仍走原确认与执行路径。展示变更不启用发送，也不直接发送或交接；Codex 原生恢复与交给 AgentKib 保留区别。 | `conv/features/sessions/session-display-state.ts`、`session-reader.tsx`、`codex-tools.tsx`、`web-layout-copy.ts`（Web 同步） |

文档同步：`docs/sessions/content-search.md` 记录桌面设置入口与 Web 的主机操作路径；`docs/sessions/conversations.md` 记录待交接与待原生恢复的区别。

已完成的分组验证：

- UX-15：6 个文件、33 项测试通过。新增 `HomeRecentSections.test.tsx`，覆盖专用活动回调、加载不冒充空态、空态解释、前三条活动的本地化标题与详情；扩展 `-home-actions.test.tsx`，通过实际 HomeRoute 验证导航到设置诊断的活动锚点，回归已有引导、添加操作、设置列表与搜索参数。
- UX-18：桌面设置入口单文件 6 项通过，Web 4 个文件、40 项通过；覆盖桌面前往主应用隐私设置、嵌入子路由穿透、无导航上下文的路径说明，以及 Web 四语言的主机操作说明与无本地设置按钮。新增全局正文搜索真实回调用例，验证允许跳转后关闭、应用锁阻止后保留窗口；这些用例在最终桌面综合中通过。
- UX-19：桌面 4 个文件、82 项通过，Web 9 个文件、203 项通过；新增两端各 40 项展示状态矩阵与各 10 项真实入口用例，覆盖当前会话、能力与权限条件、真实只读/待交接/待恢复及原因、两种入口的原确认路径、native 恢复审查和禁用时不发送。
- UX-11 跨入口补充回归：新增 `-workspace-refresh.test.tsx`，1 个文件、6 项通过。真实调用局部扫描与全局 `refreshCurrentView`，覆盖两种先后顺序均只发起一次扫描、忙碌状态完整保持、完成后再次刷新、失败后另一入口重试、新工作区首次加载不被旧忙碌状态阻挡，以及旧响应先/后返回均不污染新工作区。
- UX-10、UX-11：最终桌面综合包含概览待审计划、工作区加载、草稿放弃、Changes、全局导航及真实双刷新入口回归，验证非 Doctor 提示/入口、Doctor 原卡片、空计划/异工作区/普通草稿失效过滤、刷新及规划期间保留 Outlet、期间新增草稿保护，以及全局忙碌时禁止应用/Home 规划/拒绝。页面局部状态验证使用有状态 Outlet 替身，覆盖挂载、选择、输入和 scroll；真实 `WorkspaceGitPage.test.tsx` 作为相关既有回归，不等同于真实 Git 界面的完整滚动实机验收。

首次综合检查发现的问题与恢复条件：

- 桌面与 Web、类型检查并行运行时，一条草稿路由用例在首次懒加载导入等待的 1 秒期限内超时；该文件独立运行 5 项通过，没有修改测试或实现来放宽断言。相同 31 文件原始命令单独重跑后，370 项全部通过。
- Web 的两条既有输入区布局用例没有提供授权 `status`、协议 `protocolVersion` 与当前会话 `current`，新增展示门控因此正确进入未授权状态。仅补齐测试场景数据，保留原有精确原因与不派发请求断言；该文件独立运行 35 项通过，Web 全量重跑 954 项全部通过，没有放宽生产门控来匹配旧测试。


已执行的分组命令：

```sh
# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  src/features/home/HomeRecentSections.test.tsx \
  src/features/home/GlobalHome.test.tsx \
  src/features/home/GettingStartedCard.test.tsx \
  'src/routes/(main)/-home-actions.test.tsx' \
  src/features/settings/GlobalSettings.test.tsx \
  src/features/app/app-search-schema.test.ts

# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  src/features/sessions/conversation/features/history/history-search-settings.test.tsx

# 工作目录 apps/web
./node_modules/.bin/vitest run \
  src/features/conversation/features/history/history-search-settings.test.tsx \
  src/features/conversation/features/history/history-search-open.test.tsx \
  src/features/conversation/features/history/history-search-navigation.test.tsx \
  src/history-search-launcher.test.tsx

# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  src/features/sessions/conversation/features/sessions/session-handoff-display.test.ts \
  src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/DesktopConversation.integration.test.tsx

# 工作目录 apps/web
./node_modules/.bin/vitest run \
  src/features/sessions/session-handoff-display.test.ts \
  src/features/sessions/session-handoff-entry.test.tsx \
  src/features/sessions/session-display-state.test.ts \
  src/features/sessions/claude-handoff.test.ts \
  src/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/managed-tasks.test.tsx \
  src/features/sessions/session-reader.test.tsx \
  src/features/sessions/codex-features.test.tsx \
  src/features/sessions/claude-parity.test.tsx

# 工作目录 apps/desktop
./node_modules/.bin/vitest run \
  'src/routes/(main)/workspace/$workspaceId/-workspace-refresh.test.tsx'
```

最终综合验证：

```sh
# 工作目录 apps/desktop
./node_modules/.bin/vitest run --maxWorkers=6 \
  'src/routes/(main)/workspace/$workspaceId/-workspace-load.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-overview-pending.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-draft-actions.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-workspace-refresh.test.tsx' \
  src/features/app/useAppNavigation.test.tsx \
  src/features/workspace/workspace-store.test.ts \
  src/core/i18n.test.ts \
  src/features/home/HomeRecentSections.test.tsx \
  src/features/home/GlobalHome.test.tsx \
  src/features/home/GettingStartedCard.test.tsx \
  'src/routes/(main)/-home-actions.test.tsx' \
  src/features/settings/GlobalSettings.test.tsx \
  src/features/app/app-search-schema.test.ts \
  src/features/sessions/conversation/features/history/history-search-settings.test.tsx \
  src/features/sessions/conversation/features/history/history-search-open.test.tsx \
  src/features/sessions/conversation/features/history/history-search-navigation.test.tsx \
  src/features/sessions/DesktopHistorySearch.test.tsx \
  src/features/app/GlobalSearchDialog.test.tsx \
  src/features/sessions/conversation/features/sessions/session-handoff-display.test.ts \
  src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/DesktopConversation.integration.test.tsx \
  src/features/workspace/WorkspaceGitPage.test.tsx \
  src/features/workspace/WorkspaceContextHealthCard.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx \
  src/features/sessions/DesktopCatalog.integration.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx
./node_modules/.bin/tsc -b --pretty false

# 工作目录 apps/web
./node_modules/.bin/vitest run --maxWorkers=6
./node_modules/.bin/tsc --noEmit --pretty false
```

- 桌面综合 Vitest：31 个文件、370 项测试通过；使用上方原始命令单独重跑，未修改超时用例。
- Web 全量 Vitest：46 个文件、954 项测试通过。
- 两端 TypeScript 检查：通过，Web 测试场景数据修正后已再次验证。
- 根目录对本轮 40 个代码与 locale 文件的 `oxfmt --check`：通过；定向 `oxlint` 退出码为 0，共 31 条告警，新增 0 条。对 10 个告警文件使用第五批修改前快照（`useAppNavigation`、工作区 `route.tsx`）或 HEAD（其余文件），在相同配置下逐条比对路径、规则、完整诊断和标注原文，31/31 均为既有告警；分类为 11 条 `exhaustive-deps`、10 条 `immutability`、9 条 `set-state-in-effect`、1 条 `no-unused-vars`。
- 静态核对：四语大 JSON 各 2275 个 key、集合完全对齐；本轮新增 `workspace.updating`、`overview.pendingChangesTitle`、`overview.pendingChangesText` 三个 key。正文搜索的桌面设置入口与 Web 主机操作说明按宿主分别维护，交接展示说明有四语言文案。
- `git diff --check`：通过；原 45 个 UX ID 全部保留且无重复。
- 覆盖限制：未进行应用实机验收。UX-11 的挂载、选择、输入及 scroll 验证来自有状态 Outlet 父路由回归，真实 Git 测试只作为相关既有回归，未声称完成真实 Git 界面滚动验收；会话交接/原生恢复仍沿用已有确认与能力门控。活动列表继续使用默认最近 200 条，不提供无限历史。

---

## 第六批修复（2026-10-16）

状态：UX-30、UX-31 已完成本轮主要入口与已确认路径修复，自动化验证通过。桌面相关综合回归 39 个文件、602 项，Web 全量 47 个文件、971 项全部通过；两端类型、42 个代码/locale 文件的格式检查通过，lint 0 错误、25 条既有告警，新增 0。保留前五批记录及原 45 个 UX ID；未进行应用实机验收。

| 范围 | 本轮实现行为与边界 | 相关实现 |
|---|---|---|
| UX-30：按概念定义四语术语 | 新增四语概念表，区分变更计划、待审状态、审查动作与应用写入；区分全局资源库与技能库、技能与完整技能包、MCP 服务中心与资源库。资产“由 AgentKib 管理”不等于会话已交给 AgentKib；API、类型、存储字段、诊断码、真实文件和用户内容保持原名。 | `docs/development/ui-terminology.md`；桌面四语 `locales/*.json` 主要入口 |
| UX-30：变更计划与 MCP 说明 | Changes 标题不再裸露 `ChangeSet`，常驻说明只有应用才会写入目标文件。MCP 页面常驻解释服务中心通过统一连接提供已启用服务与获准工具，高级区域的裸 Hub 标题本地化；保留 MCP、Streamable HTTP、地址与配置键的精确含义，不混同资源库。 | `desktop/routes/(main)/workspace/$workspaceId/changes.tsx`、`desktop/routes/(main)/catalog.tsx` 内的 `McpHubPage` 及四语文案 |
| UX-30：技能库与部署方向 | 简中、繁中、日文使用对应的技能库名称；以“部署到…”表示首次选择位置建立部署，以“更新部署”表示将技能库版本写入已有位置，以“保存到技能库”表示从部署位置反向保存。保留部署/同步预览、冲突选择、版本、基线和确认行为，不将保存到库写成已更新其他位置。 | 桌面技能管理相关四语 JSON；`desktop/features/skills/SkillHubPage.tsx`、`SkillManagerPanels.tsx` 的现有动作与测试；术语表的 API 行为依据 |
| UX-30：会话、主机与结果语义 | 实体名称按简中“会话”、英文 Session、繁中“對話”、日文“会話”统一；执行管理与交给 AgentKib、交还原客户端分别表达。未交接只说明“尚未交给 AgentKib”，不推测原客户端正在运行；原生恢复保留独立含义。主机指运行 Agent/AgentKib 的电脑；已保存请求处理状态、结果待确认和“已接受不代表执行完成”的含义保留，不暗示自动重发。 | 两端会话局部字典与桌面/Web 共享会话词条；`docs/development/ui-terminology.md` |
| UX-31：Claude 面板与混合字形 | 两个工作区 Claude 面板原有 45 + 6 处局部文案改为必传四语，补齐繁中、日文真实分支，保留原简中与英文；繁中实体使用“對話”。Web 设置简中警告中的繁体混字修正为简体，其余语言现有内容保持。语言切换保留未发送草稿和文件预览，不改变发送、接管或审批门控。 | `desktop/features/workspace/ClaudeSessionPanel.tsx`、`ClaudeFilesPanel.tsx`；`desktop/features/remote/web-settings-copy.ts` |
| UX-31：动态键与审计口径 | 两端各检查 30 处实际 `managedText` 调用，仅确认 Claude 默认设置说明因“默认”二字导致键不匹配；修正调用键使既有四语词条实际命中，并补真实组件渲染验证。继续撤回“约 170 处缺翻译”的旧统计；`native-scope`、`question-form`、`native-decisions` 等已有四语分支不计为缺译，局部字典不等于缺少国际化。 | `conv/features/sessions/managed-copy.ts`、`managed-tasks.tsx` 及 Web 对应文件、真实组件测试 |

范围限制：本轮按确认路径和主要入口实施，没有声称全仓所有硬编码或所有实机状态已审计，也没有迁移到单一 JSON 字典架构。四语言 key 数量一致只能辅助检查，不能替代真实语言分支、动态键和组件渲染验证；UX-32 等其他文案候选仍按各自范围处理。

最终验证结果：

- UX-31 Claude/远程设置分组：桌面 3 个文件、110 项测试通过。真实组件覆盖四语普通会话控件、接管确认、审批与自定义回答、文件列表加载/空态、挂载中切换语言仍保留草稿/预览，以及 Web 设置四语警告的实际展示。静态检查确认两面板 45 + 6 处调用均有四语且原简中/英文逐对保留。
- UX-30：Skills、MCP、Changes 主要入口各四语实际组件与语言隔离回归通过。旧测试的精确标签及 receipt 句子断言随文案同步，原 pending 状态保存、无 send 派发等行为断言保留；旧字面断言失配不作为产品缺陷。
- UX-30/31 会话分组：Web 10 个文件、247 项，桌面 5 个文件、117 项定向回归通过。每端检查 30 处实际动态调用，修复后无字典键不匹配；各新增 12 个四语真实管理控件渲染用例与 5 个动态调用验证。繁简同形的“模型”属于有效翻译，5 个未使用旧键不计为界面缺译。组件通过 mock transport 验证，不代表实机验收。
- 综合回归：桌面 39 个文件、602 项全部通过；Web 全量 47 个文件、971 项全部通过。不将分组与综合结果重复累加。
- 两端类型检查通过；42 个代码/locale 文件的 `oxfmt --check` 通过。四语大 JSON 各 2279 个 key、集合完全对齐，既有 2275 个 key 和占位符完整保留；新增 `changes.title`、`changes.explanation`、`mcp.hubLabel`、`mcp.hubExplanation` 四个 key。
- 批次 lint 与本批前快照核对：42 个代码/locale 文件清单含 38 个 JS/TS 与 4 个 JSON；lint 0 错误、25 条告警。相同版本和配置下，与 35 个既有文件的本批前快照按规则、诊断及标注源码逐项匹配 25/25；3 个新增测试文件均无告警，新增 0、消失 0。分类为 9 条 unused、8 条 set-state-in-effect、8 条 exhaustive-deps；证据位于 `/tmp/agentkib-ux-sixth-warning-audit/comparison.json`。

已执行的桌面综合命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  'src/routes/(main)/workspace/$workspaceId/-workspace-load.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-overview-pending.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-draft-actions.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-workspace-refresh.test.tsx' \
  src/features/app/useAppNavigation.test.tsx \
  src/features/workspace/workspace-store.test.ts \
  src/core/i18n.test.ts \
  src/features/home/HomeRecentSections.test.tsx \
  src/features/home/GlobalHome.test.tsx \
  src/features/home/GettingStartedCard.test.tsx \
  'src/routes/(main)/-home-actions.test.tsx' \
  src/features/settings/GlobalSettings.test.tsx \
  src/features/app/app-search-schema.test.ts \
  src/features/sessions/conversation/features/history/history-search-settings.test.tsx \
  src/features/sessions/conversation/features/history/history-search-open.test.tsx \
  src/features/sessions/conversation/features/history/history-search-navigation.test.tsx \
  src/features/sessions/DesktopHistorySearch.test.tsx \
  src/features/app/GlobalSearchDialog.test.tsx \
  src/features/sessions/conversation/features/sessions/session-handoff-display.test.ts \
  src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/DesktopConversation.integration.test.tsx \
  src/features/workspace/WorkspaceGitPage.test.tsx \
  src/features/workspace/WorkspaceContextHealthCard.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx \
  src/features/sessions/DesktopCatalog.integration.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx \
  src/features/skills/SkillHubPage.test.tsx \
  src/features/skills/SkillManagerPanels.test.tsx \
  src/features/mcp/McpHubPage.test.tsx \
  src/features/workspace/ClaudeSessionPanel.test.tsx \
  src/features/workspace/ClaudeFilesPanel.test.tsx \
  src/features/remote/WebAccessSettings.test.tsx \
  src/features/workspace/WorkspaceTerminology.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-copy.test.ts \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-sixth-desktop-tests-result.json
./node_modules/.bin/tsc -b --pretty false
```

已执行的 Web 全量命令（工作目录 `apps/web`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-sixth-web-tests-result.json
./node_modules/.bin/tsc --noEmit --pretty false
```

`git diff --check` 通过，45 个唯一 UX ID 保留齐全。未进行 Electron、浏览器或真实设备实机验收；组件回归采用 mock transport，不代表主机配置、原客户端控制、手机输入或所有语言状态的完整实机覆盖。

---

## 第七批修复（2026-10-16）

状态：UX-23、UX-24、UX-26、UX-28 已完成本轮范围内的实现与自动化验证。Desktop 53 个文件、757 项测试与 Web 全量 47 个文件、971 项测试全部通过，两端类型检查、29 个本批代码/locale 文件格式检查及 diff 检查通过；静态检查 18 条告警全部与本批前快照一致，新增 0。前六批修复与验证记录保持原批次含义，原 45 个 UX ID 保留。尚未进行应用实机验收。

| 范围 | 当前实现行为与边界 | 相关实现 |
|---|---|---|
| UX-23：技能使用位置的操作层级 | 各状态保留一个推荐直接操作，其余已有操作收进更多菜单。需要处理本地修改、技能库更新、缺失、共同基线、冲突或恢复时，分别指向对应的已有预览或恢复流程；比较冲突不预选保留哪一份版本。撤销部署在菜单中使用危险样式。保留外部来源、作用域、基线、冲突、恢复与 busy 门控；不将原先静态分支中的按钮数视为同时可见数量。 | `desktop/features/skills/SkillManagerPanels.tsx` 及其定向测试 |
| UX-23：MCP 与资产草稿操作 | 已启用的 MCP 服务行保留探测，停用行保留编辑或创建工作区覆盖；复制公开配置、具体工具分配、OAuth、编辑等次要入口进入更多菜单。移除项使用危险样式，确认标题及正文带服务名并设 destructive tone；仍只移除所选作用域定义与私密值，原应用配置保持不变。继承项、在途锁、revision 与卸载后不派发保护保持。Assets 的技能与 MCP 移除按钮使用具名危险样式，但仍只编辑草稿，由后续审查与应用写入，不新增第二次确认。 | `desktop/features/mcp/McpManagementPanel.tsx`；`desktop/routes/(main)/workspace/$workspaceId/assets.tsx`；新增 `McpManagementActions.test.tsx`、`-assets-actions.test.tsx` |
| UX-24：恢复回查与撤销语义 | 操作结果已保存但无法读取恢复状态时显示“重新检查恢复状态”，重试只读取当前部署状态，不重发部署。确认仍有待恢复目标后进入原恢复流程；恢复状态已确认且无目标时不再展示回查重试。“重新生成计划”与“更换部署位置”分别表示重新准备预览、返回位置选择。撤销部署预览增加对象名及文件删除影响说明，最终确认使用独立撤销文案与危险样式，仍须完整预览、无冲突目标及个人目录授权。 | `desktop/features/skills/SkillManagerPanels.tsx`；四语技能部署文案与测试 |
| UX-26：管理入口互相连通 | 设置集成页说明 MCP 配置位置，并通过应用导航打开资源库 MCP 的网络区域；`catalogTarget=mcp-network` 经 schema 与真实路由参数传递，展开高级区域、滚动并在区域外定位焦点；焦点已在区域内时保持原控件焦点。MCP 页面可返回设置集成的 `integrations-mcp` 锚点。Agent 资产仅对技能和连接提供现有管理页入口，无导航上下文或加载/错误时不显示无效入口；不声称直接定位到具体资产或增加新的写入能力。设置工作区发现与技能浏览在四语中明确区分。定位目标切换使用受控展开状态，不重挂端口输入，保留未提交值和正在编辑的焦点，避免定位导致 blur 写入；原导航与应用中保护继续生效。 | `desktop/features/settings/GlobalSettings.tsx`、`desktop/features/agents/AgentAssetsPanel.tsx`、`desktop/features/app/useAppNavigation.ts`、`app-route.ts`、`app-search-schema.ts`；`desktop/routes/(main)/catalog.tsx`、`desktop/features/mcp/McpControls.tsx` |
| UX-28：保存、授权码与连接状态 | 保留显式保存：开关等普通设置明确说明保存后生效，并显示未保存、保存中、保存成功与失败重试。初次读取失败可重试；保存失败及用户输入不因轮询恢复而消失。生成码入口说明服务未运行或远程连接尚未就绪的原因；分别解释浏览器配对码、按档位授权的授权码与主机登记邀请码。连接阶段、重试与证书引导保持可见，退出码、信号等细节收进键盘可展开的诊断区。轮询和远程连接操作合并服务端已变字段，同时保留普通设置与目录草稿；主动清空的连接程序路径不被轮询还原，登记失败保留邀请码。保存、连接及授权仍受原权限、实验控制和在途锁约束。 | `desktop/features/remote/WebAccessSettings.tsx`、`web-settings-copy.ts` 及对应定向测试 |

最终验证结果（分组用例均已纳入综合结果，不重复累加）：

- Desktop 综合回归：53 个文件、757/757 项通过，覆盖本批操作与管理入口，也回归前六批的草稿、在途导航、搜索、交接、状态反馈和术语。Skills 管理面板 68 项、同步面板 30 项、真实后端集成 12 项均在本次综合运行中通过；集成仅替代桌面 IPC，后端预览、token、读写及旧快照拒绝在临时文件目录执行。
- Web 全量：47 个文件、971/971 项通过，源码未因本批桌面交互调整而扩展修改。
- MCP/Assets 定向组此前为 4 个文件、32 项通过，最终综合再次通过。覆盖菜单前后的操作可达性、探测在途不因菜单开关卸载、继承只读与工作区覆盖、在途禁用、四语具名危险确认与取消、原作用域和 revision、原面板卸载后不移除，以及资产只改选定草稿条目、不触发 plan/apply。
- 管理导航覆盖设置到 MCP 的真实目标参数接线、设置返回锚点、支持的 Agent 资产类型与应用中导航保护；同页 `true→false→true` 定位变化保持同一个端口 DOM、已输入的 `49000` 和原焦点，不触发网络设置写入。
- Web 访问设置与 LAN 回归合计 2 个文件、48 项通过，包含新增 17 项；最终综合再次通过。覆盖高级区域收起仍显示未保存状态、保存失败后轮询不清除草稿和错误、首次加载重试、远程启停与轮询保留普通草稿、连接状态与生成码门控、诊断键盘展开以及邀请码重试。
- 两端类型检查通过；本批 29 个代码/locale 文件 `oxfmt --check` 与 `git diff --check` 通过。四语主 JSON 各 2295 个 key 完全对齐，本批新增 16 个，既有 2279 个 key 保留。已有 `mcp.manage.removeConfirm` 唯一新增的 `{{name}}` 占位符为具名确认所需，唯一调用方已传入服务名，其余既有占位符保持。
- 静态基线审计：29 个文件中有 25 个 JS/TS，21 个存在精确的本批前快照，4 个为新测试，无缺失基线。相同 `.oxlintrc.json` 与 oxlint 1.79.0 下，当前和基线均为 18 warning、0 error；逐路径、规则、文案与源码片段对应一致，新增 0、消失 0。10 条未使用标识符告警来自 `catalog.tsx`（8）和 `assets.tsx`（2），8 条 hook 依赖告警来自 `useAppNavigation.ts`；四个新测试无告警。证据保存于 `/tmp/agentkib-ux-seventh-warning-audit/{sources,metadata,current,previous,comparison}.json`，本批文件清单为 `/tmp/agentkib-ux-seventh-files.json`。

已执行的 Desktop 综合命令（工作目录 `apps/desktop`，原命令同时保存在 `/tmp/agentkib-ux-seventh-desktop-command.txt`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  'src/routes/(main)/workspace/$workspaceId/-workspace-load.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-overview-pending.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-draft-actions.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-workspace-refresh.test.tsx' \
  src/features/app/useAppNavigation.test.tsx \
  src/features/workspace/workspace-store.test.ts \
  src/core/i18n.test.ts \
  src/features/home/HomeRecentSections.test.tsx \
  src/features/home/GlobalHome.test.tsx \
  src/features/home/GettingStartedCard.test.tsx \
  'src/routes/(main)/-home-actions.test.tsx' \
  src/features/settings/GlobalSettings.test.tsx \
  src/features/app/app-search-schema.test.ts \
  src/features/sessions/conversation/features/history/history-search-settings.test.tsx \
  src/features/sessions/conversation/features/history/history-search-open.test.tsx \
  src/features/sessions/conversation/features/history/history-search-navigation.test.tsx \
  src/features/sessions/DesktopHistorySearch.test.tsx \
  src/features/app/GlobalSearchDialog.test.tsx \
  src/features/sessions/conversation/features/sessions/session-handoff-display.test.ts \
  src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/DesktopConversation.integration.test.tsx \
  src/features/workspace/WorkspaceGitPage.test.tsx \
  src/features/workspace/WorkspaceContextHealthCard.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx \
  src/features/sessions/DesktopCatalog.integration.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx \
  src/features/skills/SkillHubPage.test.tsx \
  src/features/skills/SkillManagerPanels.test.tsx \
  src/features/mcp/McpHubPage.test.tsx \
  src/features/workspace/ClaudeSessionPanel.test.tsx \
  src/features/workspace/ClaudeFilesPanel.test.tsx \
  src/features/remote/WebAccessSettings.test.tsx \
  src/features/workspace/WorkspaceTerminology.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-copy.test.ts \
  src/features/app/ManagementNavigation.test.tsx \
  'src/routes/(main)/-catalog-management.test.tsx' \
  src/features/app/app-route.test.ts \
  src/features/settings/SettingsSidebar.test.tsx \
  src/features/settings/useSettingsTargetFocus.test.tsx \
  src/features/agents/AgentsPage.test.tsx \
  src/features/mcp/McpManagementActions.test.tsx \
  'src/routes/(main)/workspace/$workspaceId/-assets-actions.test.tsx' \
  src/features/mcp/McpManagementRaces.test.tsx \
  src/features/mcp/McpRuntimeProbe.test.tsx \
  src/features/mcp/McpManagementLocalization.test.tsx \
  src/features/skills/SkillSyncPanels.test.tsx \
  src/features/skills/SkillSyncFlows.integration.test.tsx \
  src/features/remote/LanWebAccessSettings.test.tsx \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-seventh-desktop-tests-result.json
./node_modules/.bin/tsc -b --pretty false
```

已执行的 Web 全量命令（工作目录 `apps/web`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-seventh-web-tests-result.json
./node_modules/.bin/tsc --noEmit --pretty false
```

已执行的静态基线审计命令（工作目录仓库根目录；脚本分别以相同配置检查当前副本与精确的本批前快照，不使用 HEAD 替代缺失快照）：

```sh
python3 /tmp/agentkib-ux-seventh-warning-audit/audit.py /tmp/agentkib-ux-seventh-files.json
```

本轮不处理 UX-25 的批量结果对象识别、搜索空态与独立自动更新检查，也不处理 UX-27 的侧栏计数来源。术语与导航调整不改变 MCP/技能的权限、预览或写入规则；组件中的动作可达与状态验证不代表真实设备上的同时可见数量、布局或完整键盘/手机验收。

---

## 第八批修复（2026-10-16）

状态：UX-22、UX-25、UX-27、UX-29 已完成本轮范围内的实现与自动化验证。Desktop 累计 56 个文件、808/808 项测试与 Web 全量 48 个文件、981/981 项测试通过，两端最终类型检查、本批 18 个代码/locale 文件格式及空白检查通过；静态 23 条告警全部与本批前快照一致，新增 0。UX-25 的独立自动更新检查仍为独立增强；UX-38 仅更新与本批 MCP 搜索反馈重叠的部分。原 45 个 UX ID 与前七批历史保留；第七批中“不处理 UX-25/27”的描述表示当时范围，当前修复见本节。

| 范围 | 当前实现行为与边界 | 相关实现 |
|---|---|---|
| UX-22：结束浏览器访问前确认 | 结束访问先显示四语确认，明确此浏览器之后需要重新配对。默认焦点在“保留访问”，取消与 Escape 只关闭确认，不调用 logout，保留当前历史与草稿。确认后沿原控制器发送 logout，在途禁用确认与关闭并阻止重复提交。请求失败或请求返回后授权仍未确认结束时保留内容、显示可重试说明；成功由访问状态边界卸载当前工作区，不把请求 resolve 当作成功。原只读访问仍可结束，不增加控制权限。 | `web/features/sessions/session-workspace.tsx`、`session-access-copy.ts`、新增 `session-workspace-logout.test.tsx` |
| UX-25：具名结果与准确搜索反馈 | MCP 批量启停在开始时保存服务名、id 与目标启停值；结果以服务名和 id 识别对象，缺名回退 id，同名服务仍可区分。刷新后改名、删除或失败重试不会借用其他对象名称。保留部分成功/失败/跳过/未执行结果，只重试失败项并沿用目标状态，成功重试清除旧错误；实际写入仍读取最新状态与 revision，保留继承只读、在途与切换作用域保护。管理列表区分当前作用域确实为空与查询无匹配，首次加载和读取失败不冒充空结果；缓存后的刷新失败单独展示。Registry 区分搜索前提示、搜索中、搜索失败、成功但无匹配四态，原有有结果列表继续使用。独立自动更新检查未实现，也未按文案修复宣称完成。 | `desktop/features/mcp/McpManagementPanel.tsx`、新增 `McpManagementFeedback.test.tsx`；`desktop/routes/(main)/catalog.tsx` 与 Registry 定向测试 |
| UX-27：计数与内容来源一致 | 删除资源库侧栏 Skills/MCP 来自工作区扫描的数字，避免与技能库、使用位置或当前 MCP 管理范围的内容混淆；其他真实对应内容的侧栏计数保持。技能库与使用位置标签继续分别使用其实际列表数量，MCP 已安装等页内计数保持原来源。去掉 `SkillHubPage` 从未使用的 `workspaceAssets` prop 与调用传参，不改变扫描、过滤、分页或目录内容。 | `desktop/routes/(main)/catalog.tsx`、`desktop/features/skills/SkillHubPage.tsx` 及四语定向测试 |
| UX-29：会话页头直接操作 | 恢复 embedded 会话页头的“文件与产物 / 会话操作”直接入口，移除顶层窗口更多菜单中的重复入口；使用原会话上下文切换面板。文件入口仍由 `SessionProvider` 的文件能力决定，会话操作内部沿原控制、原生查看、交接与只读边界，不因入口移位放宽能力。选择变化关闭旧面板，全局确认弹窗与面板互斥等已有行为保持。 | `desktop/features/sessions/DesktopConversationPane.tsx`、`SessionWindowToolbar.tsx`、`desktop/features/sessions/conversation/conversation.tsx`、新增 `DesktopConversationTools.test.tsx`；原 `DesktopConversationPane.test.tsx` 导航套件保留 |

最终验证结果（以下分组与综合用例有重叠，不重复累加）：

- MCP 反馈及相邻回归：4 个文件、85/85 项通过。其中新增反馈测试 19 项，旧行操作 12 项、竞态 15 项，以及本批增加 Registry 分支后的 Hub 39 项。覆盖对象名快照、同名 id 与缺名回退、部分结果及失败重试、读取与写入在途切作用域、四语实际查询插值、真实空范围、加载及缓存刷新失败。
- Web 结束访问与相邻布局/弹窗回归：3 个文件、15/15 项通过，其中新增 10 项结束访问用例。使用真实 `SessionProvider`、控制器和 `WebClient`，通过模拟 bridge 与薄授权 Shell 验证 access 从 approved 变为 unpaired 后卸载工作区；不是完整 `SessionLayout`/浏览器端到端测试，原 `SessionShell` 授权条件未修改。
- Desktop 会话工具入口及相邻回归：4 个文件、57/57 项通过，包含新增直接入口测试 12 项、原 Pane 导航/竞态 4 项及 SessionHub/嵌入会话集成 41 项。通过真实 embedded 面板与模拟 bridge 验证四语直接入口、Tab/Enter/Space/Escape 和焦点返回、草稿保留、顶层菜单不重复、Codex/Claude/Antigravity 分支、文件权限与只读写入禁用，以及 remote/metadata/不支持 Agent/无桌面能力/无选择不注册本地工具。390px 为 jsdom 视口/媒体条件模拟，不代表实机布局或截图验收。
- Desktop 累计 56 个文件、808/808 项与 Web 全量 48 个文件、981/981 项全部通过；两端最终类型检查通过。Desktop 综合包含前七批关键路径、原 Pane 导航套件，以及本批新增 Registry 四态/失败重试 8 项、侧栏错源计数 4 项和技能库/使用位置实际来源计数 4 项。
- 本批 18 个代码/locale 文件 `oxfmt --check` 与 tracked diff 检查通过，4 个新文件的独立空白检查无诊断；恢复后的原 `DesktopConversationPane.test.tsx` 与本批前字节相同，未计入修改清单。四语主 JSON 各 2299 个 key 完全对齐，本批新增 4 个搜索词条，已有 key 保留。
- 静态基线审计：18 文件中有 14 个 JS/TS，10 个存在精确的本批前快照，4 个是新文件；无缺失快照，也未使用 HEAD 替代。相同 `.oxlintrc.json` 与 oxlint 1.79.0 下，当前和基线均 23 warning、0 error，逐路径、规则、完整诊断及标注源码对应一致，新增 0、消失 0。其中未使用标识符 8 条、hook 依赖 6 条、effect 中设置状态 4 条、refs 3 条、immutability 2 条；4 个新文件全部无告警。证据为 `/tmp/agentkib-ux-eighth-warning-audit/{comparison,sources,metadata,current,previous}.json`，格式日志为同目录 `format.log`，最终文件清单为 `/tmp/agentkib-ux-eighth-files.json`。

已执行的 Desktop 综合命令（工作目录 `apps/desktop`；56 个测试文件记录在 `/tmp/agentkib-ux-eighth-desktop-tests.json`，原命令记录在 `/tmp/agentkib-ux-eighth-desktop-command.txt`）：

```sh
python3 - <<'PY' > /tmp/agentkib-ux-eighth-desktop-tests.log 2>&1
import json, subprocess
from pathlib import Path
files=json.loads(Path('/tmp/agentkib-ux-eighth-desktop-tests.json').read_text())
raise SystemExit(subprocess.run(['./node_modules/.bin/vitest','run','--maxWorkers=4',*files,'--reporter=json','--outputFile=/tmp/agentkib-ux-eighth-desktop-tests-result.json']).returncode)
PY
./node_modules/.bin/tsc -b --pretty false
```

已执行的 MCP 分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  src/features/mcp/McpManagementFeedback.test.tsx \
  src/features/mcp/McpManagementRaces.test.tsx \
  src/features/mcp/McpManagementActions.test.tsx \
  src/features/mcp/McpHubPage.test.tsx \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-eighth-mcp-tests-result.json
```

已执行的 Desktop 会话工具分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  src/features/sessions/DesktopConversationTools.test.tsx \
  src/features/sessions/DesktopConversationPane.test.tsx \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/sessions/DesktopConversation.integration.test.tsx
./node_modules/.bin/tsc -b --pretty false
```

已执行的 Web 结束访问分组命令（工作目录 `apps/web`）：

```sh
./node_modules/.bin/vitest run \
  src/features/sessions/session-workspace-logout.test.tsx \
  src/features/sessions/session-workspace-layout.test.tsx \
  src/components/dialog-navigation.test.tsx
./node_modules/.bin/tsc --noEmit --pretty false
```

已执行的 Web 全量命令（工作目录 `apps/web`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-eighth-web-tests-result.json
./node_modules/.bin/tsc --noEmit --pretty false
```

未进行 Electron、真实浏览器或手机设备验收；上述状态与能力验证不代表完整实机布局、触屏或网络故障演练。未修改权限、scope 写入语义、协议或依赖，也未实施独立 MCP 自动更新检查与其他尚未授权的评审项。

---

## 第九批修复（2026-10-16）

状态：UX-32、UX-33、UX-34、UX-35 已完成本轮范围内的实现与自动化验证。Desktop 累计 63 个文件、901/901 项与 Web 全量 49 个文件、997/997 项测试通过，两端最终类型检查、本批 40 个代码/locale 文件格式和空白检查通过；静态 18 条告警全部与本批前快照一致，新增 0。保留原 45 个 UX ID 与前八批完整修复记录；本节不扩展到其他尚未修复项或完整实机验收。

| 范围 | 当前实现行为与边界 | 相关实现 |
|---|---|---|
| UX-32：实际调用路径的本地化与语义 | MCP 单行选择 aria 标签使用四语 `mcp.manage.selectService`，保留服务名插值。忽略工作区的确认文字统一指向实际“设置 → 工作区发现 → 已排除工作区”恢复入口。页面内切换、打开设置、工作区操作等 8 个同源应用中保护调用使用新的通用操作提示 `workspace.changesApplying`，不再要求用户“退出”；真正退出应用的 `AppRuntimeBridge` 继续使用 `dialog.quit.changesApplying`。只调整文字，不改变应用中门控、取消、导航或写入行为。Changes 与 MCP 页裸技术标题已在第六批处理，本轮保留其结果。 | `desktop/features/mcp/McpManagementPanel.tsx`、`desktop/features/app/useWorkspaceTransitions.ts`、`useAppNavigation.ts`、`desktop/routes/(main)/route.tsx`、`workspaces.tsx`、四语 JSON 与定向测试 |
| UX-33：宿主中性的附件与权限文案 | 两端附件入口统一为“选择附件文件”等四语中性文案，资源引用提示去掉“手机”限定；实际无发送权限提示使用“当前访问”，保留到运行 AgentKib 的电脑检查权限的方向。未用 `same-origin` 或 `embedded` 猜测宿主，也未新增宿主字段。桌面本地凭据 send/attachments 固定 true：附件入口可达且仍受能力、在线与在途状态约束；桌面发送授权缺失不宣称为实际可达状态。Web 的真实只读 send=false 分支与旧凭据附件权限 fallback 已四语验证；无生产调用的 `composerLayoutCopy.permission` 同步清理措辞，但不将其当作实际发送提示的验证路径。保留内部技术键、原上传与发送权限。 | 两端 `codex-copy.ts`、`composer-layout-copy.ts`、`managed-control-copy.ts`，新增两端 `composer-host-copy.test.tsx`；Web `codex-features.test.tsx` 只同步精确文案断言 |
| UX-34：快捷键与侧栏一致 | 导航键按侧栏统一为 1 首页、2 工作区、3 Agent、4 会话、5 全局资产目录、6 额度、7 洞察，标签复用相同字典 key。renderer、快捷键帮助、设置列表、侧栏提示与 macOS 原生菜单保持同一映射，仍沿原平台分派，保留输入框、IME、repeat、帮助打开及修饰键保护。`AppNavigationRequest` 只补原本存在的 sessions 导航目标联合类型，不改 IPC 对象形状或其他动作。 | `desktop/core/keyboard-shortcuts.ts`、`desktop/features/app/useAppShortcuts.ts`、`global-navigation.ts`、`desktop/electron/main/native-shell.ts`、`desktop/core/types.ts` 与五个定向测试文件 |
| UX-35：Skills 子页签写入 URL | 新增经 schema 校验的 `skillSection=library|workspace|discover`，例如 `/catalog?assetSection=skills&skillSection=discover`；缺失或非法值安全回到技能库。Catalog 用 URL 控制页签，子页签与原“查看部署”成功反馈入口仅合并该 search 字段，保留 `assetSection`、`catalogTarget`、工作区及其他已验证参数。刷新、前进后退、离开返回恢复选中页签；既有全局导航能直接保存完整 search，无需改导航控制器。子页签变化不重挂 SkillHub，保留地址草稿、库筛选和在途请求；独立调用仍支持原本地默认，不要求 Router。外层分区切换清除 MCP 定位目标的原逻辑保持；URL 不新增其他临时草稿的跨页面持久化能力。 | `desktop/features/skills/SkillHubPage.tsx`、`desktop/routes/(main)/catalog.tsx`、`desktop/features/app/app-search-schema.ts`、`app-route.ts`；新增真实路由测试 `-catalog-skills-navigation.test.tsx` 与已有组件/schema 测试 |

最终验证结果（以下定向与综合分组有重叠，不重复累加）：

- UX-32：7 个文件、104/104 项通过，新增 15 项，覆盖 MCP 四语 aria 4 项、真实忽略恢复路径与通用提示字典 4 项、工作区切换门控 4 项、原导航用例扩成四语后净增 3 项；原退出保护、竞态与首页旧断言继续回归。
- UX-33：Desktop 相邻 4 文件、80/80 项及 Web 相邻 5 文件、108/108 项通过；最终 fixture/断言补齐后，两端新增测试又分别 8/8、16/16 通过。使用真实 SessionProvider、控制器、WebClient 和 composer，通过模拟 bridge 验证四语附件选择、hidden input、普通文件上传结果、发送可用状态与能力拒绝；Web 另验证只读发送提示和旧凭据附件权限 fallback，不模拟桌面不存在的 send=false 凭据来宣称实际可达。
- UX-34：5 个文件、51/51 项通过，其中原 28 项、新增 23 项。验证数字映射、平台分派、renderer 导航、帮助/设置/侧栏标签和原生菜单发送目标，保留全部旧快捷键与输入防护覆盖。
- UX-35：5 个文件、67/67 项通过，其中新增 19 项（独立受控组件 1、schema 4、真实 Router 集成 14）。覆盖三个深链及刷新、非法/缺失值默认、四语恢复、前进后退、其他 search 保留、在途请求/草稿/筛选保持、外层分区及离开返回、成功反馈 CTA 写 URL。原 Catalog 管理入口 7 项与 app-route 5 项回归通过；旧 `-catalog-management.test.tsx` 未修改。
- Desktop 累计 63 文件、901/901 项与 Web 全量 49 文件、997/997 项全部通过；Desktop `tsc -b --pretty false` 与 Web `tsc --noEmit --pretty false` 最终通过。四语主 JSON 各 2301 个 key 完全一致，本批仅新增 2 个 key，已有值仅 `workspace.ignoreConfirm` 的四语恢复方向按实际界面修正。
- 本批 40 文件为 36 个 JS/TS 与 4 个 JSON。`oxfmt --check`、tracked diff 检查和 4 个新文件的独立空白检查通过；QA 不计入该源文件清单。相同配置与 oxlint 1.79.0 下，当前和精确本批前快照均 18 warning、0 error，逐路径/规则/完整诊断及源码标注对应，新增 0、消失 0；其中未使用标识符 9 条、hook 依赖 9 条。36 源码为 32 个精确快照与 4 个新文件，无缺失基线、无 HEAD 替代，新文件均零告警。证据位于 `/tmp/agentkib-ux-ninth-warning-audit/{comparison,sources,metadata,current,previous}.json`，格式日志为同目录 `format.log`，清单为 `/tmp/agentkib-ux-ninth-files.json`。

已执行的 Desktop 综合命令（工作目录 `apps/desktop`；63 个测试文件记录在 `/tmp/agentkib-ux-ninth-desktop-tests.json`，原命令记录在 `/tmp/agentkib-ux-ninth-desktop-command.txt`）：

```sh
python3 - <<'PY' > /tmp/agentkib-ux-ninth-desktop-tests.log 2>&1
import json, subprocess
from pathlib import Path
files=json.loads(Path('/tmp/agentkib-ux-ninth-desktop-tests.json').read_text())
raise SystemExit(subprocess.run(['./node_modules/.bin/vitest','run','--maxWorkers=4',*files,'--reporter=json','--outputFile=/tmp/agentkib-ux-ninth-desktop-tests-result.json']).returncode)
PY
./node_modules/.bin/tsc -b --pretty false
```

已执行的 UX-35 分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  src/features/skills/SkillHubPage.test.tsx \
  src/features/app/app-search-schema.test.ts \
  src/features/app/app-route.test.ts \
  'src/routes/(main)/-catalog-skills-navigation.test.tsx' \
  'src/routes/(main)/-catalog-management.test.tsx' \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-ninth-skills-tests-result.json
```

已执行的 UX-34 分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run \
  src/core/keyboard-shortcuts.test.ts \
  src/features/app/useAppShortcuts.test.tsx \
  src/features/app/ShortcutHelpDialog.test.tsx \
  electron/main/native-shell.test.ts \
  src/components/AppSidebar.test.tsx
```

已执行的附件最终定向命令与 Web 全量命令（分别在对应工作目录）：

```sh
# apps/desktop
./node_modules/.bin/vitest run --maxWorkers=4 src/features/sessions/conversation/features/sessions/composer-host-copy.test.tsx
./node_modules/.bin/tsc -b --pretty false
# apps/web
./node_modules/.bin/vitest run --maxWorkers=4 src/features/sessions/composer-host-copy.test.tsx
./node_modules/.bin/vitest run --maxWorkers=4 \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-ninth-web-tests-result.json
./node_modules/.bin/tsc --noEmit --pretty false
```

尚未进行 Electron 原生菜单、OS 文件选择框、真实键盘或手机/浏览器实机验收。组件、memoryRouter 与协议 fixture 验证不代表像素布局、实际宿主上传链路或所有运行状态的完整覆盖；没有新增依赖、放宽权限、改变 IPC/持久化结构或提交代码。

---

## 第十批修复（2026-10-16）

状态：UX-36、UX-37、UX-38、UX-39 已完成本轮范围内的实现与自动化验证。Desktop 累计 70 个文件、992/992 项测试通过，0 失败，最终 `tsc -b --pretty false` 通过。本批 23 个代码/locale 文件格式与空白检查通过；静态 20 条告警均与精确的本批前快照一致，新增 0。四语主 JSON 各 2313 个 key，新增 12 个 key，已有值未改。本批仅修改 Desktop，未重跑 Web 或公共包，也不将前九批的 Web 结果计作本批验证；原 45 个 UX ID 顺序及前九批完整修复记录保留。

| 范围 | 当前实现行为与边界 | 相关实现 |
|---|---|---|
| UX-36：待同步入口与对应列表 | 原徽标改为可点击、支持 Tab/Enter/Space 的按钮，沿用受控页签切到“使用位置”，父级接受切换后再滚动并聚焦待同步区域。保留原非 inactive 的 incoming/conflict/missing/blocked/unverified 计数，不加入 outgoing/current/converged；仅展示身份一致的实际部署，缺失或变化的元数据保留说明与刷新，不附加错误操作控件。旧查询/作用域/Agent 筛选不遮挡待同步列表，“查看所有使用位置”恢复原筛选，已解决时明确显示无待同步位置。进入列表不调用 prepare/apply，原审查、恢复、绑定及个人目录授权保持；该筛选仅为本地视图状态，未新增 URL 参数或持久化。 | `desktop/features/skills/SkillHubPage.tsx`、`SkillManagerPanels.tsx`，新增 `SkillPendingSync.test.tsx` |
| UX-37：Context 按检测结果默认选择 | 匹配当前工作区 id、路径与扫描根目录后，按扫描顺序取首个 detected=true 的受支持 Agent；未知检测项跳过，无匹配沿用 Codex 默认。有效 URL agent 优先，手动选择写入该字段并保留其他参数，不因扫描列表变化被覆盖，前进后退按 URL 恢复。工作区或项目变化重置工作目录、手动状态及防抖，旧结果不投射到新范围；跨 Agent 不沿用旧预览，同 Agent 的目录编辑保留原防抖和已有结果。独立组件仍可本地选择，不要求 Router。检测表示发现资产，不等于安装、在线或控制权限。 | `desktop/routes/(main)/workspace/$workspaceId/context.tsx`，新增 `-context-agent.test.tsx`；原 `-context.test.tsx` 保留 |
| UX-38：准确空态、读取失败与缓存刷新 | 真实空工作区列表指向顶部既有“手动添加”，搜索或 Agent 筛选无匹配保持原语义。资源库资产、工作区、记忆依赖首次读取失败显示具名说明与重试，不冒充空列表或零计数；缓存刷新失败保留页面、筛选、条目及真实记忆编辑草稿，只重试失败依赖并防重。工作区页保留缓存列表、搜索和选中项；资产计数未知时显示“—”，有缓存时保留计数并显示具名刷新警示。直接工作区地址的列表查询失败显示实际错误，不误报为不存在。第八批 MCP 搜索四态与重试修复保持，本批未重写其实现或历史范围。 | `desktop/features/workspace/WorkspaceListPanel.tsx`、`WorkspacesPage.tsx`；`desktop/routes/(main)/catalog.tsx`、`workspaces.tsx`；`desktop/features/app/useAppNavigation.ts`；新增 `-catalog-query-states.test.tsx`、`-workspace-list-states.test.tsx` |
| UX-39：可收起且不混淆版本的操作提示 | 新全局横幅提供四语关闭按钮，只收起显示，原 message 留给失败判断。每次显式发布更新版本，包括同文；返回原值的条件更新不重开。路由 href 变化只收起上页已观察版本，陈旧关闭回调不能隐藏新消息，目的页提交中新错误与同文新发布保留；设置往返不会复活旧提示。不存在工作区提示按 href、查询结果版本和消息去重：同页关闭不立即重开，另一个缺失工作区、完成重试或经设置返回的新结果可重新显示。关闭不改变草稿、应用锁、权限或 Runtime 恢复判断。 | `desktop/features/workspace/workspace-store.ts`；新增 `desktop/features/app/AppMessageBanner.tsx`、`usePageMessageScope.ts`、`AppMessageBanner.test.tsx`；`useAppNavigation.ts`、`desktop/routes/(main)/route.tsx` 与原 store/navigation 测试 |

最终验证结果（以下定向与累计分组有重叠，不重复累加）：

- UX-36：5 个文件、163/163 项通过，新增 16 项；最终 fixture 补齐后新文件又单独 16/16 通过。覆盖四语文案与键盘/焦点、五状态和生命周期计数、原恢复/绑定、旧筛选恢复、受控页签、元数据不一致、已解决列表、busy/地址草稿、加载/错误重试及真实原审查与个人目录授权。
- UX-37：2 个文件、29/29 项通过，新增 15 项、原有 14 项。真实 memory Router、store、React Query 与 ContextPage 覆盖非 Codex 工作区、顺序与空/未知回退、有效/非法 URL、手动选择和参数保留、前进后退、扫描未到/失败/来源不符、列表变更、Context 错误、工作区切换及旧结果晚到、目录防抖清理和独立宿主。
- UX-38：6 个文件、88/88 项通过，新增 24 项、既有 64 项。真实 QueryClient 与页面组件覆盖首次 pending/具名错误、各失败依赖重试、缓存刷新保留筛选/选择/实际记忆草稿、未知与缓存计数、防重复重试、四语实际执行原顶部添加流程、搜索/Agent 过滤与原应用锁；Skills URL、MCP 定位和旧 Hub 搜索回归保留。
- UX-39 与同源直接地址反馈：4 个文件、80/80 项通过，净新增 18 项。覆盖四语键盘关闭且保留草稿和锁、同文发布、陈旧关闭回调、路由及设置往返、目的页提交中新错误、条件 noop、reset 后旧回调失效、同页 not-found 关闭不重开、不同缺失工作区同文重新显示、查询失败实际错误及重试结果版本。
- Desktop 最终累计 70 个文件、992/992 项、0 失败，结果 `success=true`；清单 `/tmp/agentkib-ux-tenth-desktop-tests.json`，原命令 `/tmp/agentkib-ux-tenth-desktop-command.txt`，结果 `/tmp/agentkib-ux-tenth-desktop-tests-result.json`。最终类型检查退出 0，日志 `/tmp/agentkib-ux-tenth-desktop-types.log` 为空。本批没有新的 Web 测试或类型检查结果。
- 本批 23 文件为 19 个 TS/TSX 与 4 个 JSON：12 个既有 source 有精确本批前快照，7 个为新增 source，4 个 JSON 也有精确快照，未用 HEAD 替代。23 文件 `oxfmt --check`、16 个 tracked 文件及 7 个新文件的空白检查通过；QA 不计入源清单。四语 2313 个 key 与插值集合保持一致，12 个新 key 仅补本批空态、读取反馈与待同步说明，原值未改。
- 相同 `.oxlintrc.json` 与 oxlint 1.79.0 下，当前和精确基线均 20 warning、0 error；逐路径、规则、完整诊断与标注源码匹配 20 条，新增 0、消失 0。未使用标识符 9 条、effect 设置状态 2 条、hook 依赖 9 条；7 个新文件均零告警。清单 `/tmp/agentkib-ux-tenth-files.json`，审计证据 `/tmp/agentkib-ux-tenth-warning-audit/{comparison,sources,metadata,current,previous}.json`，格式命令和结果在同目录 `format-command.txt`、`format.log`。

已执行的 Desktop 累计命令（工作目录 `apps/desktop`）：

```sh
python3 - <<'PY' > /tmp/agentkib-ux-tenth-desktop-tests.log 2>&1
import json, subprocess
from pathlib import Path
files=json.loads(Path('/tmp/agentkib-ux-tenth-desktop-tests.json').read_text())
raise SystemExit(subprocess.run(['./node_modules/.bin/vitest','run','--maxWorkers=4',*files,'--reporter=json','--outputFile=/tmp/agentkib-ux-tenth-desktop-tests-result.json']).returncode)
PY
./node_modules/.bin/tsc -b --pretty false
```

已执行的精确静态基线审计命令（工作目录仓库根目录）：

```sh
python3 /tmp/agentkib-ux-tenth-warning-audit/audit.py /tmp/agentkib-ux-tenth-files.json
```

未进行 Electron、OS 键盘/滚动或真实磁盘与网络失败验收。真实 React 控件、Router 与 QueryClient 测试使用模拟 API，不代表完整实机体验；待同步入口不代替原审查与授权，Context 检测不授予权限，缓存失败和关闭横幅不清理原错误、草稿或应用锁。Runtime 独立失败条、查询专属错误与其他局部提示仍由各自状态控制，不宣称全部可关闭。未新增依赖、公共协议、持久化结构或本批 Web 行为，也未执行 commit。

---

## 第十一批修复（2026-10-16）

状态：UX-40、UX-41、UX-42、UX-43 已完成本轮范围内的实现与自动化验证。Desktop 累计 76 个文件、1102/1102 项测试通过，0 失败、0 pending，最终类型检查通过。本批 14 个代码/locale 文件格式与空白检查通过；静态 13 条告警全部与精确本批前快照一致，新增 0、消失 0。四语主 JSON 各 2341 个 key，新增 28 个，既有值仅调整批量更新汇总的成功含义。本批仅修改 Desktop，没有新的 Web 或公共包验证结果；保留前十批完整修复记录、原 45 个 UX ID 顺序与其他 41 条原文。

| 范围 | 当前实现行为与边界 | 相关实现 |
|---|---|---|
| UX-40：空计划与 Diff 浏览 | 仅实际 `changes.length === 0` 显示“本计划没有文件变更”和返回，隐藏拒绝、应用、Home 授权和 hash 校验提示；标准空计划仍可规划 Home，继续受原在途锁与返回保护。返回沿原来源流程清理待审计划与关联交接，不修改 manifest、草稿或缓存。非空文件按钮仍浏览单个 Diff，应用完整计划；新计划重置浏览索引及 Home 授权的既有修复保留，旧索引越界立即回退真实首文件，不再误报同步。无计划但保留 native-import request 的回查恢复分支优先保留；实际原生导入计划含独立审查文件，不将无文件计划新增为可写入路径。 | `desktop/routes/(main)/workspace/$workspaceId/changes.tsx`；新增 `-changes-empty.test.tsx` |
| UX-41：Assets 草稿表单反馈 | Skill/MCP 表单提供关联 label、就地错误与无效字段描述，提交空字段聚焦首个无效项；保留合法输入，trim 后同名条目阻止覆盖，并可滚动聚焦现有条目。Skill 名称和 HTTP 前缀遵循现有 manifest 校验边界，不额外探测本地路径、命令或服务端；真正空的 Skill/MCP 草稿列表显示说明。合法添加仍只编辑 manifest 草稿，既有审查与应用、原具名草稿移除语义保持。 | `desktop/routes/(main)/workspace/$workspaceId/assets.tsx`；新增 `-assets-validation.test.tsx` |
| UX-42：批量工具更新逐项结果 | 复用原串行 `executeAgentTool(agent, action.id)`，常驻展示此次每个 Agent/action 的真实返回状态、输出、退出码及版本，保留渠道与目标身份，同一 Agent 的多个 action 分开显示。原 API 类型保留 succeeded、failed、timed-out、busy、unchanged、verification-failed，不虚构 skipped；等待项显示尚未执行，busy 明确本项未执行，请求抛错则标记结果未确认并保留原因，提示先检测，不能据此断言命令未运行。保留原成功/非成功数量，汇总文字使用“未确认成功”而非把未知当确定失败。确认前复制本批目标，刷新不改变在途对象；取消或门控未取得保留上一报告，刷新失败保留实际结果与原设置反馈，检测重试只检测，不自动重试成功或未知项。原执行门控、模式、权限和 API 保持，报告只保留于当前组件挂载期间。 | `desktop/features/settings/AgentToolsSettings.tsx`；新增 `AgentToolsBatchResults.test.tsx` |
| UX-43：端口草稿与实际状态 | MCP 高级设置使用关联标签的受控端口输入，显示最近确认端口及失焦/Enter 保存说明；无编辑时同步运行状态，存在未保存输入时保留草稿，Escape 返回最近确认值。仅接受 1–65535 的整数，无效值就地解释且不写入；在途锁防止 Enter 与 blur 重复提交。保存或回读未核实目标值时保留输入并明确尚未确认，不冒充成功；具体原因沿原页面反馈，运行状态后续确认相同目标时消除未确认提示；保存前及发布回读前取消同键旧查询，防止陈旧响应撤回已确认状态。保持原 MCP 配置 API、服务开关与权限，不扩展到其他端口页面。 | 新增 `desktop/features/mcp/McpPortField.tsx`、`McpPortField.test.tsx`；`desktop/routes/(main)/catalog.tsx`、原 `McpHubPage.test.tsx` |

最终验证结果（分组与累计存在重叠，不重复累加）：

- UX-40：4 个文件、42/42 项通过，新增 15 项与原有 27 项。实际四语、真实路由返回覆盖四来源与交接返回参数、草稿保留、空计划无写入、标准 Home 规划的在途/错误重试、Home 新计划重置浏览与授权、同 ID 缩短后的索引回退、重复点击仍应用完整计划、父级忙状态与无计划原生导入回查。原三个套件未修改。首次新测试没有等待既有懒加载路由，补齐与原测试一致的 Suspense 与等待后通过，未放宽断言。
- UX-41：3 个文件、43/43 项通过，新增 36 项与原草稿操作 2 项、草稿生命周期 5 项。覆盖四语真实表单/空态、label 与错误关联、纯空白校验及聚焦、trim 后同名阻止覆盖并定位、Enter 合法追加且保留其他草稿、大小写及两个命名空间兼容、stdio/HTTP 切换与原前缀规则、Skill 名称约束和移除现有项后重试。使用真实路由与 store，断言不调用计划或应用 API；不将 HTTP 前缀校验概括为完整 URL、命令或路径有效性验证。
- UX-42：3 个文件、34/34 项通过，新增 14 项与原组件 18 项、协调器 2 项。覆盖六种真实状态与抛错混合、无输出失败、退出码与版本、等待/运行进度、确认计划身份稳定、同 Agent 多渠道、获取锁及执行防重、取消、门控占用、卸载停止后续项、检测失败后保留结果与仅检测重试、原手动/安装/文档排除范围，以及四语实际渲染与切换语言不重新执行。合入真实新词典后同三文件通过；原组件测试逐字保留。

- UX-43：2 个文件、64/64 项通过，新增端口组件 18 项、Hub 新增 7 项与原有 39 项。覆盖四语说明与错误关联、空值/越界/非整数、合法边界、Enter/blur 防重、相同控件与焦点、运行状态更新、未保存输入与 Escape、写入/回读失败或不符、失败后的手动重试、后续状态确认、卸载，以及保存前及写入期间启动的旧 runtime query 晚到结果均不会撤回已确认端口；保留原 LAN flags 和主页面忙状态。

- 本批新增 90 项（UX-40 15、UX-41 36、UX-42 14、UX-43 25）；Desktop 累计从上批 992 项增至 1102 项，其中另 20 项为本批加入累计清单的既有工具设置 18 项与协调器 2 项，不计作新增用例。76 个文件全部通过，0 失败、0 pending，结果 `success=true`；清单 `/tmp/agentkib-ux-eleventh-desktop-tests.json`、完整原命令 `/tmp/agentkib-ux-eleventh-desktop-command.txt`、结果 `/tmp/agentkib-ux-eleventh-desktop-tests-result.json`。最终 `./node_modules/.bin/tsc -b --pretty false` 退出 0，日志 `/tmp/agentkib-ux-eleventh-desktop-types.log` 为空。
- 本批 14 文件为 10 个 TS/TSX 与 4 个 JSON：5 个既有 source 与 4 个 JSON 均有精确本批前快照，另外 5 个 source 为新增；没有用 HEAD 补缺失快照。14 文件 `oxfmt --check`、9 个 tracked 文件和 5 个新文件的空白检查通过，QA 不计入源清单。相同 `.oxlintrc.json` 与 oxlint 1.79.0 下，当前与精确基线均 13 warning、0 error；按路径、规则、完整诊断与标注源码匹配 13 条，新增 0、消失 0，分类为未使用标识符 10 条、effect 设置状态 2 条、hook 依赖 1 条，5 个新文件零告警。清单 `/tmp/agentkib-ux-eleventh-files.json`，证据 `/tmp/agentkib-ux-eleventh-warning-audit/{comparison,sources,metadata,current,previous}.json`。
- 四语 key 集合与插值核对一致，各从 2313 增至 2341；新增 28 个（Changes 2、Assets 13、工具结果 9、端口 4），既有 key 未删除，既有值只调整 `settings.tools.batchResult`，计数插值保持。证据 `/tmp/agentkib-ux-eleventh-locale-validation.json`。旧套件精确行为断言保留；新增路由等待与返回类型 fixture 修正后最终分组、累计和类型均通过，不将 fixture 修正视为产品缺陷。

已执行的 UX-40 分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  'src/routes/(main)/workspace/$workspaceId/-changes-empty.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  src/features/workspace/WorkspaceTerminology.test.tsx
```

已执行的 UX-41 分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  'src/routes/(main)/workspace/$workspaceId/-assets-validation.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-assets-actions.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-draft-actions.test.tsx' \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-eleventh-assets-tests-result.json
```

已执行的 UX-42 分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=3 \
  src/features/settings/AgentToolsSettings.test.tsx \
  src/features/settings/AgentToolsBatchResults.test.tsx \
  src/features/settings/agent-tools-query.test.ts \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux42-tests-result.json
```

已执行的 UX-43 分组命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  src/features/mcp/McpPortField.test.tsx \
  src/features/mcp/McpHubPage.test.tsx \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-eleventh-port-tests-result.json
```

已执行的 Desktop 累计命令（工作目录 `apps/desktop`，与保存的完整原命令参数及文件顺序一致）：

```sh
./node_modules/.bin/vitest run --maxWorkers=4 \
  'src/routes/(main)/workspace/$workspaceId/-workspace-load.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-overview-pending.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes-route.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-draft-actions.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-changes.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-workspace-refresh.test.tsx' \
  src/features/app/useAppNavigation.test.tsx \
  src/features/workspace/workspace-store.test.ts \
  src/core/i18n.test.ts \
  src/features/home/HomeRecentSections.test.tsx \
  src/features/home/GlobalHome.test.tsx \
  src/features/home/GettingStartedCard.test.tsx \
  'src/routes/(main)/-home-actions.test.tsx' \
  src/features/settings/GlobalSettings.test.tsx \
  src/features/app/app-search-schema.test.ts \
  src/features/sessions/conversation/features/history/history-search-settings.test.tsx \
  src/features/sessions/conversation/features/history/history-search-open.test.tsx \
  src/features/sessions/conversation/features/history/history-search-navigation.test.tsx \
  src/features/sessions/DesktopHistorySearch.test.tsx \
  src/features/app/GlobalSearchDialog.test.tsx \
  src/features/sessions/conversation/features/sessions/session-handoff-display.test.ts \
  src/features/sessions/conversation/features/sessions/session-handoff-entry.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx \
  src/features/sessions/DesktopConversation.integration.test.tsx \
  src/features/workspace/WorkspaceGitPage.test.tsx \
  src/features/workspace/WorkspaceContextHealthCard.test.tsx \
  src/features/app/AppRuntimeBridge.test.tsx \
  src/features/sessions/DesktopCatalog.integration.test.tsx \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/sessions/SessionHubPage.test.tsx \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx \
  src/features/skills/SkillHubPage.test.tsx \
  src/features/skills/SkillManagerPanels.test.tsx \
  src/features/mcp/McpHubPage.test.tsx \
  src/features/workspace/ClaudeSessionPanel.test.tsx \
  src/features/workspace/ClaudeFilesPanel.test.tsx \
  src/features/remote/WebAccessSettings.test.tsx \
  src/features/workspace/WorkspaceTerminology.test.tsx \
  src/features/sessions/conversation/features/sessions/managed-copy.test.ts \
  src/features/app/ManagementNavigation.test.tsx \
  'src/routes/(main)/-catalog-management.test.tsx' \
  src/features/app/app-route.test.ts \
  src/features/settings/SettingsSidebar.test.tsx \
  src/features/settings/useSettingsTargetFocus.test.tsx \
  src/features/agents/AgentsPage.test.tsx \
  src/features/mcp/McpManagementActions.test.tsx \
  'src/routes/(main)/workspace/$workspaceId/-assets-actions.test.tsx' \
  src/features/mcp/McpManagementRaces.test.tsx \
  src/features/mcp/McpRuntimeProbe.test.tsx \
  src/features/mcp/McpManagementLocalization.test.tsx \
  src/features/skills/SkillSyncPanels.test.tsx \
  src/features/skills/SkillSyncFlows.integration.test.tsx \
  src/features/remote/LanWebAccessSettings.test.tsx \
  src/features/mcp/McpManagementFeedback.test.tsx \
  src/features/sessions/DesktopConversationPane.test.tsx \
  src/features/sessions/DesktopConversationTools.test.tsx \
  src/features/sessions/conversation/features/sessions/composer-host-copy.test.tsx \
  electron/main/native-shell.test.ts \
  src/core/keyboard-shortcuts.test.ts \
  src/features/app/useAppShortcuts.test.tsx \
  src/features/app/ShortcutHelpDialog.test.tsx \
  src/components/AppSidebar.test.tsx \
  'src/routes/(main)/-catalog-skills-navigation.test.tsx' \
  src/features/app/AppMessageBanner.test.tsx \
  src/features/skills/SkillPendingSync.test.tsx \
  'src/routes/(main)/workspace/$workspaceId/-context-agent.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-context.test.tsx' \
  'src/routes/(main)/-catalog-query-states.test.tsx' \
  'src/routes/(main)/-workspace-list-states.test.tsx' \
  'src/routes/(main)/-workspaces.test.ts' \
  'src/routes/(main)/workspace/$workspaceId/-changes-empty.test.tsx' \
  'src/routes/(main)/workspace/$workspaceId/-assets-validation.test.tsx' \
  src/features/settings/AgentToolsSettings.test.tsx \
  src/features/settings/AgentToolsBatchResults.test.tsx \
  src/features/settings/agent-tools-query.test.ts \
  src/features/mcp/McpPortField.test.tsx \
  --reporter=json \
  --outputFile=/tmp/agentkib-ux-eleventh-desktop-tests-result.json
./node_modules/.bin/tsc -b --pretty false
```

已执行的精确静态基线审计命令（工作目录仓库根目录）：

```sh
python3 /tmp/agentkib-ux-eleventh-warning-audit/audit.py /tmp/agentkib-ux-eleventh-files.json
```

未运行真实工具安装或更新、Electron、OS 键盘/滚动、MCP 网络服务与文件写入验收。上述真实 React 控件、Dialog、Router 与 QueryClient 测试使用模拟 API；表单预检不证明命令/路径可用，结果报告不等于持久历史，端口未确认不等于保存失败或成功。保留原权限、协议、默认值、生产依赖、草稿与写入流程；没有本批 Web 行为或测试结论，也未执行 commit。

---

## 第十二批修复（2026-10-16）

状态：UX-44、UX-45 已完成本轮范围内的实现与自动化验证。Desktop 累计 80 个文件、1161/1161 项通过；Web 本轮全量 53 个文件、1048/1048 项通过，均 0 失败、0 pending、`success=true`。两端最终类型检查通过；最终 21 个 TS/TSX 文件格式与空白检查通过；当前 28 条静态告警全部与精确本批前快照一致，新增 0、消失 0。四语主 JSON 本批未改，各仍为 2341 个 key，与第十一批逐值相同且插值对齐；新增操作名称和未知时间仅位于四语局部字典。保留前十一批完整修复记录、原 45 个 UX ID 顺序及其他 43 条原文。

| 范围 | 当前实现行为与边界 | 相关实现 |
|---|---|---|
| UX-44：审批身份 | Desktop/Web 审批列表显示原 `toolName`，缺失时使用 ACP `toolCall.title`，再按已知 Codex 命令执行、文件变更、权限请求方法显示四语操作名；未知方法显示既有未知工具文案。每条附原请求 ID，同工具多条可区分，长文本可换行；名称只作为纯文本。点击仍将原审批对象交给既有详情弹窗，不执行审批，不改变 supported、设备审批权限、原生决策、在线及控制就绪、当前请求精确匹配等门控。 | 两端 `features/sessions/session-reader.tsx`；新增 `approval-summary.ts`、`session-approvals.test.tsx` |
| UX-44：历史结果元数据 | 搜索命中时间及索引时间使用当前语言的既有日期格式，合法值用 `<time dateTime>` 保留原时间字符串；缺失或无效时间显示四语“时间未知”。复用 `agentName` 显示 Agent 名称，覆盖来源状态、筛选项、结果标题兜底与元数据、详情标题兜底；筛选 API、原 Agent ID、消息位置和引用数据保持。原高亮、节选引用与显式打开来源会话流程保持；不新增自动定位命中消息。 | 两端 `features/history/history-search.tsx`、`history-copy.ts`；新增 `history-search-display.test.tsx` |
| UX-44：断线草稿 | Codex/Claude 输入框在离线时保留同一控件及本地草稿，可继续编辑；仅移除因 offline 禁用编辑的条件，保留 busy、submitted、在途与结果未确认的锁定。按钮、Enter、form 和动作函数仍受在线与控制就绪状态限制，原 canSend、压缩、队列/插话能力、附件就绪、只读及权限检查保留。ACP 备用输入沿用原发送权限，仅去掉离线禁用编辑，保留 busy，并在按钮与 form 显式检查在线。恢复连接不自动发送；已接收才清稿，明确未分派后才解除提交锁。 | 两端 `features/sessions/session-composer.tsx`、`session-reader.tsx`；新增 `session-composer-offline.test.tsx`，ACP 场景位于 `session-approvals.test.tsx` |
| UX-45：Web 触控目标 | 会话页刷新按钮改为 44×44；目录工作区折叠按钮至少 44×44；Info 保留原生 `details/summary` 并扩大到 44×44，图标居中。只调整这三个实际目标，不修改全局按钮默认值；刷新参数、防重与加载、折叠/展开、会话选择和路由、路径披露和权限保持。 | `web/features/sessions/session-workspace.tsx`；`web/features/conversation/features/catalog/session-catalog.tsx`；新增 `web/features/sessions/session-touch-targets.test.tsx` |

针对性验证结果（各分组与累计存在重叠，不重复累加）：

- 审批与 ACP：Desktop 新文件 22/22，Web 新文件 22 项与原 reader 6 项，共 2 个文件 28/28 通过。覆盖四语同工具请求 ID（含数字 0）、真实 toolName、三个 Codex 方法、ACP title 与异常形状、纯文本转义、请求/语言变化、点击原对象且不调用 control，以及 ACP 离线保留草稿与焦点、恢复无重放、busy/压缩与无发送权限。结果 `/tmp/agentkib-ux-twelfth-{desktop,web}-approvals-result.json`。
- Composer：Desktop/Web 各 2 个文件 39/39，通过原 28 项与新增 11 项。新增覆盖 Codex/Claude 离线编辑与焦点、恢复后显式发送、过时 canSend 仍受在线/控制就绪限制、busy、在途和结果未确认防重、未分派后离线编辑、已接收清稿、只读、running/compacting 高级动作及上传就绪门禁；原快捷键、IME、引用与资源、附件及跨会话保护测试逐字保留。最终结果 `/tmp/agentkib-ux-twelfth-composer-{desktop,web}-tests.json`。
- 历史搜索：Desktop/Web 各 3 个文件 38/38，新增显示用例各 12 项与原搜索/打开 26 项。覆盖四语消息/索引时间、原 `dateTime`、多 Agent 显示与未知名称兜底、空值/非法时间、切换语言、原高亮及精确节选引用、打开原会话和筛选提交原 ID。补齐 Access fixture 必填字段后两端新 12 项再次通过；未降低类型或行为断言。结果 `/tmp/agentkib-ux-twelfth-history-{desktop,web}.json`、最终新套件结果 `/tmp/agentkib-ux-twelfth-history-{desktop,web}-fixture.json`。
- Web 触控：4 个文件 25/25，新增 6 项与原布局/退出/目录 19 项；四语刷新仍调用 `refresh(true)`，Info 独立披露路径，工作区折叠、已选状态、准确路由、搜索保持展开及路由变化不重挂按钮均通过。结果 `/tmp/agentkib-ux45-tests-result.json`，完整命令与边界 `/tmp/agentkib-ux45-validation.md`。
- 本批新增合计 96 项：两端审批/ACP 各 22、Composer 各 11、历史显示各 12，另 Web 触控 6；各分组既有用例不计作新增。最初新增 fixture 缺少 Live/Access 必填字段，补齐真实字段后类型与专项重跑通过，未使用二次 unknown 转换或放宽生产类型。

累计验证：Desktop 80 个文件、1161/1161 项全部通过，`success=true`，0 失败、0 pending；结果文件与清单路径核对一致。相较第十一批 1102 项增加 59 项，其中本批 Desktop 新增 45 项（审批/ACP 22、Composer 11、历史显示 12），另 14 项为本次加入累计清单的既有 transcript 用例，不计作新增。清单 `/tmp/agentkib-ux-twelfth-desktop-tests.json`、完整已执行命令 `/tmp/agentkib-ux-twelfth-desktop-command.txt`、结果 `/tmp/agentkib-ux-twelfth-desktop-tests-result.json`。Web 本轮全量 53 个文件、1048/1048 项通过，`success=true`，0 失败、0 pending，命令退出 0；本轮新增 51 项，完整结果与实际文件清单一致。结果 `/tmp/agentkib-ux-twelfth-web-tests-result.json`、日志 `/tmp/agentkib-ux-twelfth-web-tests.log`、完整已执行命令 `/tmp/agentkib-ux-twelfth-web-command.txt`、清单 `/tmp/agentkib-ux-twelfth-web-tests.json`。

Web 首次全量共 53 个文件、1048 项，1042 通过、6 项旧显示断言失败：`conversation.test.tsx` 的 5 个实际用例仍断言原 Agent ID `cursor`，`session-stability.test.tsx` 的 1 项仍按旧的审批通用名称查找按钮。对应更新为友好 Agent 名称与含工具/请求 ID 的完整审批名称，并将同一引用集成用例后续原 ISO 显示断言更新为本地化时间、原 `dateTime` 属性与索引标签。原 Cursor 覆盖状态、只读引用与发送、审批对象变化后失效等完整流程断言保留。两文件最终定向 208/208 通过，结果 `/tmp/agentkib-ux-twelfth-web-compatibility-result.json`；首轮失败记录另存 `/tmp/agentkib-ux-twelfth-web-first-tests-result.json` 与 `-web-first-tests.log`，最终完整 Web 回归 1048/1048 通过。

Chromium 尺寸与原生交互验证：从真实 React 组件测试捕获实际 DOM，使用实际 Vite 编译的 Web 生产 CSS，在四语 × 320/390/768/1280 共 16 组隔离页面验证。刷新与 Info 均 44×44；工作区按钮高 44、宽 211/251/321，均至少 44×44；相邻目标无重叠，页面无水平溢出。鼠标点击 Info 扩大后的左边缘可打开，获得焦点后 Space 关闭、Enter 打开，工作区仍保持展开。证据 `/tmp/agentkib-ux45-browser-metrics.json`、`/tmp/agentkib-ux45-browser-metrics.log`、`/tmp/agentkib-ux45-browser-native.log`。浏览器检查覆盖真实 DOM、编译 CSS 与原生披露交互；隔离页面不带 React 事件监听，刷新、折叠、选择和导航由组件测试验证，不能当作完整已配对应用端到端测试。

静态与类型验证：

- 最终清单含 21 个源文件：12 个既有文件使用精确本批前快照、9 个为新增，没有用 HEAD 替代前十一批工作区。最终 `oxfmt --check`、tracked 与新增文件空白检查通过；清单 `/tmp/agentkib-ux-twelfth-files.json`。
- 最终 21 文件相同 oxlint 配置下当前与基线均 28 warning、0 error；按路径、规则、完整诊断与标注源码匹配 28 条，新增 0、消失 0，分类为 effect 设置状态 14 条、immutability 10 条、hook 依赖 4 条，9 个新文件零告警。证据 `/tmp/agentkib-ux-twelfth-warning-audit/{comparison,sources,metadata,current,previous}.json`。
- Desktop `./node_modules/.bin/tsc -b --pretty false` 与 Web `./node_modules/.bin/tsc --noEmit --pretty false` 最终均退出 0，日志 `/tmp/agentkib-ux-twelfth-{desktop,web}-types.log` 为空；Web 旧显示断言调整后再次检查通过。主 locale 逐值及 key 核对证据 `/tmp/agentkib-ux-twelfth-locale-validation.json`。

已执行的 Composer 分组命令（分别在 `apps/desktop` 与 `apps/web`；两端原命令中的路径分别如下）：

```sh
# apps/desktop
./node_modules/.bin/vitest run \
  src/features/sessions/conversation/features/sessions/session-composer.test.tsx \
  src/features/sessions/conversation/features/sessions/session-composer-offline.test.tsx \
  --maxWorkers=2 --reporter=json \
  --outputFile=/tmp/agentkib-ux-twelfth-composer-desktop-tests.json
# apps/web
./node_modules/.bin/vitest run \
  src/features/conversation/features/sessions/session-composer.test.tsx \
  src/features/conversation/features/sessions/session-composer-offline.test.tsx \
  --maxWorkers=2 --reporter=json \
  --outputFile=/tmp/agentkib-ux-twelfth-composer-web-tests.json
```

已执行的 Web 触控分组命令（工作目录 `apps/web`）：

```sh
./node_modules/.bin/vitest run \
  src/features/sessions/session-touch-targets.test.tsx \
  src/features/sessions/session-workspace-layout.test.tsx \
  src/features/sessions/session-workspace-logout.test.tsx \
  src/features/catalog/session-catalog.test.tsx \
  --maxWorkers=2 --reporter=json \
  --outputFile=/tmp/agentkib-ux45-tests-result.json
```

已执行的精确静态基线审计命令（工作目录仓库根目录）：

```sh
python3 /tmp/agentkib-ux-twelfth-warning-audit/audit.py /tmp/agentkib-ux-twelfth-files.json
```

本批未启动 Electron、连接真实 Agent 处理审批或真实断线重连，也未进行手机/软键盘实机验证。保留原协议、权限、持久化、依赖、请求与草稿生命周期；本地 DOM 焦点保留不证明手机键盘始终展开。QA 的源码修复与自动化完成状态仅适用于上述范围，之前各批注明的未实现能力与实机覆盖限制继续保留；未执行 commit。

---

## 疑点核对与修复（2026-10-16）

状态：Q-01—Q-05 已完成核对与处理，区分既有范围约束、确认缺陷与未发现功能缺陷的候选；确认缺陷已修复并通过针对性验证。新增 55 项全部通过；Desktop 累计分组功能验证 84 个文件、1202/1202 项通过，其中既有磁盘集成套件独立采用 15 秒整项上限，默认 5 秒失败记录及条件见下文；Web 本轮单次全量 54 个文件、1062/1062 项通过。两端类型、15 文件格式和空白检查通过，7 条既有静态告警逐项匹配、新增 0。原 45 个 UX 条目、前十二批完整修复记录与前十二项建议保持原文；本轮不另称第十三批 UX 修复。

后续验证状态：旧 Skills 磁盘集成套件的默认 5 秒超时已继续定位并修复，原 12 项在不覆盖 worker 或超时配置的独立运行中全部通过；新增 8 项回归也通过。保留默认 5 秒时限、显式 `maxWorkers=4` 的累计单次运行 85 个文件、1210/1210 项通过；该累计清单不包括另行扩展后仍超时的完整 manager 与 lifecycle 套件。根因、修复边界与各组实际结果见[旧 Skills 磁盘集成测试默认超时修复](#旧-skills-磁盘集成测试默认超时修复2026-10-16)。下方默认时限失败与 15 秒补验记录保留为本轮当时的历史证据。

最新验证状态：后端完整 manager 与 lifecycle 套件已继续修复，原 17+100 项在同一默认命令中 117/117 通过，无探针、名称筛选、worker 数或超时覆盖；新增 9 项回归与原发现回归合计 17/17 通过。保留默认 5 秒时限、显式 `maxWorkers=4` 的累计单次运行 94 个文件、1462/1462 项通过，其中 Skills 完整安全子集 11 个文件、272/272 项，包含原两个套件及磁盘 UI 原 12 项。当前根因、默认验收与边界见[后端 manager 与 lifecycle 完整套件默认时限修复](#后端-manager-与-lifecycle-完整套件默认时限修复2026-10-16)。此前失败及条件化补验记录保留为历史。

| 范围 | 核对结论、修复与边界 | 相关实现 |
|---|---|---|
| Q-01：Context 展示范围 | `api.context` 仍只提交 project、cwd、agent；后端 `Context.request` 自行读取磁盘 Manifest、指令文件与配置，并沿用批准记忆等既有来源。读取磁盘本身是现有预览边界，页面遗漏范围说明会让未应用草稿被误认为已包含。增加四语常驻说明，首次解析、错误和结果状态均可见：不包含未应用资产草稿，应先审阅并应用，再重新解析；这里的解析不会让 Agent 重新加载配置，也不表示完整客户端运行快照。保持草稿、请求协议、Agent 选择和目录防抖/竞态保护。 | `desktop/routes/(main)/workspace/$workspaceId/context.tsx`；`desktop/core/api.ts`；`packages/backend/src/context.ts`；`desktop/locales/*.json` |
| Q-02：计划范围与应用锁 | standard、Doctor、handoff、handoff-setup 待审计划都绑定当前工作区；切换工作区时失效并保留编辑草稿，属于既有范围约束，同工作区导航仍保留计划。新增测试另确认缺陷：首个应用锁检查即使立即返回，也会在 await 处让出执行，此时新开始的应用可能被后续切换越过。恢复后重读当前 store 并再次检查应用锁；阻断时保持工作区、计划、来源、交接请求、草稿与缓存，不导航、不清理。未引入跨工作区待审计划持久化。 | `desktop/features/app/useWorkspaceTransitions.ts`；新增 `useWorkspacePlanScope.test.tsx` |
| Q-03：Web 首次目录状态 | 原描述“闪现暂无可读会话”需按实际分支校正：首次请求期间 `workspaces` 尚未到达，实际先显示缺少目录/旧宿主升级提示；完成且确实为空后才能显示真实空态。另有初次目录慢请求被无选中会话的 `leaveSession` 增加世代而丢弃的问题。目录增加 loading/ready/error 状态，由真实控制器通过 SessionWorkspace 传入；无选中会话时离开目录不再使其请求失效。首次错误保持错误和既有重试；已接受的目录在刷新和失败时保留行、搜索与选中状态；成功旧宿主响应才显示升级提示，索引明确禁用保持独立状态。权限或世代改变后的迟到结果仍不得发布，不新增写请求。 | `web/features/conversation/features/catalog/session-catalog.tsx`；`web/features/conversation/features/sessions/use-session-controller.ts`；`web/features/sessions/session-workspace.tsx`；新增 `web/features/catalog/session-catalog-loading.test.tsx` |
| Q-04：嵌入会话中的目录提醒 | 提取并共享既有目录提醒，使可交互会话、新建会话、目录和历史分支均保留目录失败、具名离线/断开远程主机、远程扫描错误、工作区列表失败与部分扫描失败计数。嵌入会话上方使用有名称、可键盘聚焦的限高滚动区域；提醒变化不重挂会话、不丢草稿，目录扫描问题不误归因到当前会话。拒绝记录提示仍只显示在原目录/历史分支；保留既有目录与工作区重试动作，以及 Runtime、索引、首次工作区加载和远程只读边界。 | `desktop/features/sessions/SessionHubPage.tsx`；新增 `SessionCatalogNotices.test.tsx` |
| Q-05：实际 MCP 连接入口 | 当前 `catalog.tsx` 的 McpHubPage 挂载 `McpManagementPanel`，其中连接按钮打开 `McpBatchConnectionPanel`；实际功能包含工作区选择、目标 Agent、Diff、Home 显式批准、计划 token 提交与连接验证。旧 `McpConnectionCard` 仅自身/测试引用，以及 `mcp.editorDescription`、`mcp.wrapperUnsupported` 未发现使用，不构成生产连接功能丢失的证据。本轮不删除旧组件、测试或文案，不改变连接协议或授权；补实际管理入口的四语验证，避免只由旧组件测试推断主流程可用。 | `desktop/routes/(main)/catalog.tsx`；`desktop/features/mcp/McpManagementPanel.tsx`、`McpBatchConnectionPanel.tsx`；新增 `McpConnectionEntry.test.tsx` |

已完成的针对性验证（分组可能与累计重叠，不重复累加）：

- Q-01：3 个文件、35/35 项通过，其中新增 `-context-scope.test.tsx` 6 项、既有 Context/Agent 选择 29 项。新增覆盖四语磁盘/草稿/Agent 重载边界，首次加载、错误与重试空态，脏草稿保留、刷新仍只传三项参数及空态进入指令编辑。结果 `/tmp/agentkib-q01-targeted.json`；2 个文件格式通过，既有文件精确修改前及当前静态检查均零告警。
- Q-02/Q-05：`useWorkspacePlanScope.test.tsx` 新增 12 项，四种计划来源分别覆盖跨工作区失效且缓存草稿、同工作区保留计划、首个异步检查让出期间开始应用则阻止切换。修改前 8 通过、4 个应用锁场景失败，修复后 12 项均通过；原失败证据 `/tmp/agentkib-q02-red-result.json`。`McpConnectionEntry.test.tsx` 新增四语 4 项，从实际 McpManagementPanel 入口选择工作区、审查 Diff、显式 Home 批准、单次提交原 token、验证原 Agent 并显示工具结果；无工作区或未批准时不调用应用。加上原 Transitions 9 项、原 McpHubPage 46 项，最终 4 个文件、71/71 项通过，结果 `/tmp/agentkib-q02-q05-tests-result.json`；完整命令与说明 `/tmp/agentkib-q02-q05-validation.md`。首轮新增入口测试把实际带 `+ ` 的 Diff 行按无前缀文本查找，4 项断言失败；改为核对真实完整 Diff 行后通过，未更改生产逻辑或降低审查断言。
- Q-03：新增 `session-catalog-loading.test.tsx` 14/14 通过，经真实 WebApplication、Router、SessionProvider 与控制器验证四语首次等待→真实空态、旧宿主缺目录、索引禁用、慢目录后的会话深链、首次错误重试、缓存刷新失败、更新请求优先、切换会话使旧刷新失效、新授权 boot 结果隔离，以及无选中会话仍清临时面板/接受目录、离开已选会话仍屏蔽迟到历史。与原会话、配对、目录、执行管理、稳定性、布局与退出相关测试共 8 个文件、290/290 项通过，结果 `/tmp/agentkib-q03-web-targeted.json`、`/tmp/agentkib-q03-web-regression.json`；核对记录 `/tmp/agentkib-q03-result.json`。沿用既有控制、授权、原生动作与请求顺序保护；未增加写请求，未把已接受缓存目录在刷新时替换成加载空白。
- Q-04：`SessionCatalogNotices.test.tsx` 新增 19 项，与原 `SessionHubPage.test.tsx` 31 项，共 2 个文件、50/50 项通过。覆盖三类本地可交互 Agent、新建/目录/历史分支、具名远程提醒及按需诊断、分别重试、恢复后会话与草稿不重挂、跨会话提醒更新、远程离线缓存和既有启动门控。结果 `/tmp/agentkib-q04-tests.json`；精确修改前及当前 2 文件静态检查均零告警，证据 `/tmp/agentkib-q04-warning-audit/comparison.json`。

本轮新增合计 55 项：Desktop 41 项（Context 6、计划范围 12、目录提醒 19、实际 MCP 入口 4），Web 目录状态 14 项。上述旧测试只计入回归，不计作新增。

Desktop 累计分组功能验证 84 个文件、1202/1202 项通过：首轮中除 `SkillSyncFlows.integration.test.tsx` 外的 83 个文件、1190 项在默认 5 秒整项上限内全部通过，源码随后未再修改；既有 Skills 磁盘集成套件的 12 项以 `maxWorkers=1`、`testTimeout=15000` 独立补验全部通过，实测每项约 1.2–3.8 秒。两个实际运行的文件并集与累计 84 文件清单一致，0 待处理用例；相较第十二批新增 4 个文件、41 项。可审计派生汇总 `/tmp/agentkib-q-review-desktop-verified-summary.json` 明确列出两个结果来源及条件，累计清单 `/tmp/agentkib-q-review-desktop-tests.json`。这是两个真实运行分组的功能验证汇总，不是一次默认时限 Vitest 运行的 `success=true`。

默认时限限制保留：首轮 84 文件使用原默认 5 秒上限，1195/1202 通过、7 项旧 Skills 集成用例超时，原报告仍为 `success=false`，未覆盖或改写；结果 `/tmp/agentkib-q-review-desktop-tests-result.json`，完整已执行命令 `/tmp/agentkib-q-review-desktop-command.txt`，日志 `/tmp/agentkib-q-review-desktop-tests.log`。在没有其他测试并行时独立使用默认时限复核，该旧套件 11/12 通过、1 项约 5065ms 后超时，结果 `/tmp/agentkib-q-review-skills-isolated-result.json` 与日志 `/tmp/agentkib-q-review-skills-isolated.log`。最终仅对该真实磁盘/后端套件使用命令行 15 秒整项上限做功能补验；未修改其源码、测试、断言、waitFor 时限或仓库配置，默认 5 秒时限问题未在本轮根治。功能补验退出 0、12/12 通过，结果 `/tmp/agentkib-q-review-skills-functional-result.json`，日志 `/tmp/agentkib-q-review-skills-functional.log`。

已执行的独立功能补验命令（工作目录 `apps/desktop`）：

```sh
./node_modules/.bin/vitest run --maxWorkers=1 --testTimeout=15000 \
  src/features/skills/SkillSyncFlows.integration.test.tsx \
  --reporter=json --outputFile=/tmp/agentkib-q-review-skills-functional-result.json
```

Web 本轮单次全量 54 个文件、1062/1062 项通过，`success=true`、0 失败、0 pending，命令退出 0；比第十二批增加 1 个文件、14 项。结果 `/tmp/agentkib-q-review-web-tests-result.json`，实际文件清单 `/tmp/agentkib-q-review-web-tests.json`，完整已执行命令 `/tmp/agentkib-q-review-web-command.txt`，日志 `/tmp/agentkib-q-review-web-tests.log`。

静态、类型与文案核对：

- 最终代码与语言文件清单共 15 个：11 个 TS/TSX、4 个主 JSON，其中 10 个既有文件、5 个新增测试文件；6 个既有 TS/TSX 使用本轮修改前工作区精确快照，未用 HEAD 替代前十二批工作。15 文件格式与 tracked/新增文件空白检查通过，清单 `/tmp/agentkib-q-review-files.json`，证据 `/tmp/agentkib-q-review-warning-audit/{format.log,whitespace.json}`。
- 同一 oxlint 配置下当前与精确基线均 7 warning、0 error，按路径、规则、完整诊断与标注源码匹配 7 条，新增 0、消失 0：unused 1、effect 设置状态 4、immutability 1、preserve-manual-memoization 1；5 个新增文件零告警。证据 `/tmp/agentkib-q-review-warning-audit/{comparison,sources,metadata,current,previous}.json`。
- Desktop `./node_modules/.bin/tsc -b --pretty false` 与 Web `./node_modules/.bin/tsc --noEmit --pretty false` 均通过；日志 `/tmp/agentkib-q-review-{desktop,web}-types.log`。四语主 JSON 各由 2341 增为 2342 个 key，仅新增 `context.previewScope`，没有修改旧 key 的值。

本轮新增界面验证使用模拟 API、宿主响应与远程状态；累计中的既有 Skills 集成套件另使用临时磁盘与真实后端。未启动 Electron、连接真实远程主机或 Agent，也未写入用户真实 MCP 配置。未将目录错误视为当前会话内容故障，未增加跨工作区计划持久化或草稿预览模式，旧 MCP 组件与文案清理仍未纳入。之前各批的实机覆盖与未实现能力边界继续有效；未执行 commit。

---

## 旧 Skills 磁盘集成测试默认超时修复（2026-10-16）

状态：已修复旧 `SkillSyncFlows.integration.test.tsx` 的默认 5 秒整项超时问题。原 12 项在未覆盖 worker 数、整项时限或 `waitFor` 时限的独立运行中 12/12 通过，`success=true`，各项约 788–1800ms；新增后端回归 8/8 通过。Desktop 累计在默认 5 秒时限、显式 `maxWorkers=4` 下单次运行 85 个文件、1210/1210 项通过，`success=true`。没有提高仓库、测试或命令行的超时上限，原 12 项未跳过用例或削弱既有断言。扩展后端安全与生命周期整组仍有默认时限超时，根因尚未确定，具体失败及隔离复核条件见下文，不能据此宣称整个后端测试集通过。

后续状态：本节描述上轮修复及当时仍存在的扩展超时。完整 manager 与 lifecycle 原 117 项已在后续同一次默认配置运行中全部通过；累计 94 文件在默认 5 秒时限、显式 `maxWorkers=4` 下单次 1462/1462 通过，包含 Skills 安全 11 文件、272/272 项。详见[后端完整套件修复记录](#后端-manager-与-lifecycle-完整套件默认时限修复2026-10-16)；本节原失败、过滤对照与验证条件均不改写。

根因与修复：

- `SkillManager.inventory()` 与 `listDeployments()` 的只读聚合内部多次重新发现相同 native targets；收集 receipt、reservation、恢复目标和 journal 时各自重复扫描，`inventory` 每次读发现 4 次、`listDeployments` 每次读发现 8 次。改为每次聚合入口发现一次，并把本次结果显式传给内部只读收集函数；附加只读 inventory roots 使用数组副本，不污染可写 targets。
- 发现结果仅在这一次读取内复用，不跨请求缓存。下一次请求仍重新发现工作区、环境配置与路径状态，receipt、包内容 hash 和损坏 receipt 仍重新读取；写入前后的目标、工作区、快照和符号链接检查，以及 journal 与 `fsync` 持久化步骤保持原有行为。
- 集成测试的确认辅助函数原先只等待 `applySync` 返回，随后真实的四路读取刷新仍可能在后台运行。辅助函数现在继续等待 `onChanged` 完成，并在 React `act` 内结算状态，再进行磁盘断言或清理临时目录；保留原 12 项、双击防重复、真实后端预览/token/receipt/写入及磁盘内容断言。

相关文件：`packages/backend/src/skill-manager.ts`、`desktop/features/skills/SkillSyncFlows.integration.test.tsx`，以及新增 `apps/desktop/test/skill-target-discovery.test.ts`。

已完成的针对性验证：

- 原磁盘集成套件：默认配置独立运行 12/12 通过；结果 `/tmp/agentkib-skills-timeout-default-tests-result.json`。与上一轮独立默认运行 11/12、1 项 5065ms 超时的报告分别保留，未覆盖旧失败结果。
- Desktop 累计：沿用 Q 核对原 84 文件清单并加入新增发现回归，共 85 个文件、1210/1210 项在一次运行中全部通过，0 失败、0 pending、`success=true`、命令退出 0；保留原默认 5 秒时限，显式设置 `maxWorkers=4`。其中原磁盘集成套件 12/12 通过，各项约 842–2346ms。实际结果文件集合与清单完全一致，不再使用 15 秒补验与其他运行拼接累计通过数。清单 `/tmp/agentkib-skills-timeout-desktop-tests.json`，原结果 `/tmp/agentkib-skills-timeout-desktop-tests-result.json`，校核摘要 `/tmp/agentkib-skills-timeout-desktop-verified-summary.json`，完整实际命令 `/tmp/agentkib-skills-timeout-desktop-command.txt`，日志 `/tmp/agentkib-skills-timeout-desktop-tests.log`，退出与请求文件数 `/tmp/agentkib-skills-timeout-desktop-exit.json`。下文超时的完整 manager 与 lifecycle 套件不在此 85 文件清单中；新发现回归与扩展安全回归有重叠，不重复累加。
- 新增 8 项：以 `maxWorkers=1`、默认 5 秒整项时限验证两个只读聚合各只发现一次且不把只读 roots 加入可写 targets；后续请求重新发现工作区、native Home 配置和替换后的符号链接；receipt、包 hash 与坏 receipt 保持新鲜；预览后的工作区变化或目标链接变化仍拒绝过期同步且不改写文件。结果 `/tmp/agentkib-skills-timeout-target-discovery.json`；完整命令 `/tmp/agentkib-skills-timeout-backend-commands.txt`。
- 同一新增套件在精确修改前实现上 4/8 通过、4 项次数断言失败：`inventory` 实际发现 4 次而非 1 次，`listDeployments` 为 8 次而非 1 次，两次路径安全读取为 16 次而非 2 次，三次 receipt/包读取为 24 次而非 3 次；工作区/环境刷新与两类过期写入拒绝的 4 项保持通过。当前实现 8/8 通过，直接覆盖重复发现根因与相邻安全边界；修改前结果 `/tmp/agentkib-skills-timeout-discovery-before.json` 保留为失败证据。
- 使用同一真实后端场景单次采样，targets 总发现次数从 237 降到 126，`fsync` 均为 50 次；该次壁钟约 3663ms → 2674ms，仅作重复发现减少的辅助证据，不视为稳定性能基准。证据 `/tmp/agentkib-skills-timeout-backend-profile-{before,after}.json`；测量脚本仅在临时目录，未加入产品代码。
- Desktop `./node_modules/.bin/tsc -b --pretty false` 退出 0，日志 `/tmp/agentkib-skills-timeout-desktop-types.log`；Backend 在 `packages/backend` 执行 `./node_modules/.bin/tsc --noEmit --pretty false` 退出 0、输出为空，原工具执行未重定向日志，实际命令及结果说明保存在 `/tmp/agentkib-skills-timeout-backend-commands.txt`。3 个代码/测试文件格式与空白检查通过；精确修改前及当前静态检查均为 0 告警、0 错误，新增 0。文件清单 `/tmp/agentkib-skills-timeout-files.json`；证据 `/tmp/agentkib-skills-timeout-warning-audit/{comparison.json,format.log,whitespace.json,sources.json,current.json,previous.json}`。

扩展回归中的失败及对照条件另行保留，不计作通过：

- manager 与同步安全回归首轮 9 个文件、150/151 项通过，`skill-sync-manager.test.ts` 的 `release-reservation` 中断恢复用例约 5037ms 后超时，原报告 `/tmp/agentkib-skills-timeout-backend-safety.json` 为 `success=false`。对同一用例使用精确修改前实现、默认 5 秒时限过滤复核，也约 5088ms 超时；报告 `/tmp/agentkib-skills-timeout-manager-before.json` 的其余 16 项因名称过滤而未运行，不能计作通过。
- 生命周期套件首轮 98/100 项通过：健康源配合旧 linked-resource 快照的导入，以及跳过项在预览后源变化的两项分别约 5071ms、5087ms 超时，随后清理出现 `ENOTEMPTY`；原失败报告 `/tmp/agentkib-skills-timeout-lifecycle.json` 保留。按名称过滤这两项，在精确修改前与当前实现中独立复核均 2/2 通过，其余 98 项未运行；结果 `/tmp/agentkib-skills-timeout-lifecycle-{before,current}.json`。因此仅确认隔离运行未复现，不能据此把首轮失败定性为既有问题、环境问题或本次回归，也不把 100 项宣称为全量通过。
- 当前完整 manager 套件再次以 `maxWorkers=1`、默认 5 秒时限运行，11/17 项通过、6 项约 5017–5368ms 超时，其中一项伴随 `ENOTEMPTY` 清理错误；结果 `/tmp/agentkib-skills-timeout-manager-current.json` 为 `success=false`。完整组超时根因尚未确定，修改前单项对照不能替代完整修改前后对照，也不能据此证明 manager 整组稳定。所有扩展、过滤对照与复核的实际命令见 `/tmp/agentkib-skills-timeout-backend-commands.txt`；用于精确基线对照的临时源码与测试已移出仓库，没有残留到累计清单。

已执行的默认配置独立验证命令（工作目录 `apps/desktop`，命令退出 0；完整命令另存 `/tmp/agentkib-skills-timeout-default-command.txt`）：

```sh
./node_modules/.bin/vitest run \
  src/features/skills/SkillSyncFlows.integration.test.tsx \
  --reporter=json \
  --outputFile=/tmp/agentkib-skills-timeout-default-tests-result.json
```

此前 Q-01—Q-05 核对、前十二批 UX 修复和 Web 验证记录不因本次替换或重新计数。此次默认配置通过记录适用于临时磁盘与真实后端测试，未扩大为 Electron、真实 Agent 或用户实际磁盘配置的实机验收；未执行 commit。

---

## 后端 manager 与 lifecycle 完整套件默认时限修复（2026-10-16）

状态：`skill-sync-manager.test.ts` 原 17 项与 `skills-lifecycle.test.ts` 原 100 项在同一默认命令中 117/117 通过，`success=true`、0 失败、0 pending、命令退出 0；无诊断探针、名称筛选、worker 数、测试/Hook 时限或重试覆盖。两份原测试源码与本轮精确修改前快照逐字相同，未提高默认 5 秒上限，未删除或改弱其断言。manager 最慢项约 1933ms，lifecycle 最慢项约 2032ms。发现回归由原 8 项增为 17 项，新增 9 项及原 8 项全部通过。累计回归在默认 5 秒时限、显式 `maxWorkers=4` 下单次 94 文件、1462/1462 项通过，Skills 完整安全子集 11 文件、272/272 项通过，包含两个原完整套件与原磁盘 UI 12 项。

根因与修复：

- 上轮仅消除了 `inventory` 与 `listDeployments` 聚合中的重复发现；`syncLocation` 解析 observation/deployment 时仍发现 6/5 次相同 targets，`assertSyncOperationAvailable` 内部收集 reservation、journal 与恢复目标时发现 3 次，`prepareDeployment` 在同一准备读取阶段发现 4 次。各入口现在只发现一次，并显式传入本次内部收集函数，减少同步与中断恢复完整流程的重复磁盘扫描。
- 复用只限本次读取/准备调用的局部结果，不跨请求、跨锁或跨写入阶段缓存。后续请求仍重新读取包内容、reservation、工作区与目标路径状态；原写入前后、锁、暂存、快照、目标/符号链接检查与 journal、`fsync` 持久化保持。
- `vite.config.ts` 仅把真实磁盘 `skills-lifecycle.test.ts` 与 `skill-target-discovery.test.ts` 加入已有 filesystem 项目的串行组，沿用其 `fileParallelism: false` 和组顺序，使其不与其他组争用磁盘。没有新增或修改测试、Hook 的时限配置。

相关文件：`packages/backend/src/skill-manager.ts`、`apps/desktop/test/skill-target-discovery.test.ts`、`apps/desktop/vite.config.ts`。本轮精确基线 `/tmp/agentkib-manager-lifecycle-baseline` 保留上轮全部修改；未用 HEAD 代替，未修改原 manager/lifecycle 两份测试。

已完成的验证与证据：

- 两个完整原套件：单次默认运行 117/117 通过；结果 `/tmp/agentkib-manager-lifecycle-core-result.json`，核对摘要 `/tmp/agentkib-manager-lifecycle-core-summary.json`，命令 `/tmp/agentkib-manager-lifecycle-core-command.txt`，日志 `/tmp/agentkib-manager-lifecycle-core.log`，退出记录 `/tmp/agentkib-manager-lifecycle-core-exit.json`。所有原用例实际执行，没有通过名称过滤或分组拼接通过数。
- 累计单次回归：原 85 文件清单加入 8 个既有安全套件及 lifecycle，共 94 文件、1462/1462 项通过，`success=true`、0 失败、0 pending、命令退出 0；实际文件集合与清单完全一致。此命令显式使用 `maxWorkers=4`，沿用默认 5 秒时限，没有探针、筛选或重试覆盖。结果 `/tmp/agentkib-manager-lifecycle-desktop-result.json`，摘要 `/tmp/agentkib-manager-lifecycle-desktop-summary.json`，完整实际命令 `/tmp/agentkib-manager-lifecycle-desktop-command.txt`，日志 `/tmp/agentkib-manager-lifecycle-desktop.log`，退出记录 `/tmp/agentkib-manager-lifecycle-desktop-exit.json`，清单 `/tmp/agentkib-manager-lifecycle-desktop-tests.json`。
- 同一次累计中的 Skills 完整安全子集：11 文件、272/272 项通过，0 pending，清单 `/tmp/agentkib-manager-lifecycle-safety-tests.json`。其中两个原完整套件再次 117/117 通过，最慢项约 2398ms；原 `SkillSyncFlows.integration.test.tsx` 12/12 通过，最慢项约 1316ms。子集由该次 94 文件原报告逐项核对得出，没有额外拼接过滤复核或重复累计计数。
- 发现回归：默认配置单次 17/17 通过。新增 9 项覆盖 observation/deployment 单次发现、并行读取各自发现、下次请求重新读取包与 reservation、部署准备单次发现，以及工作区/目标链接变化后重新准备并拒绝旧预览；过期部署预览严格断言实际错误 `Skill target changed after preview`。结果 `/tmp/agentkib-manager-lifecycle-target-discovery-final-errors.json`。
- 同一最终 17 项在本轮精确修改前实现上 8/17 通过、9 项次数断言失败；原 8 项全部保持通过。新增场景的实际发现次数为 6/5/12/10/3/5/4/8/8，对应期望 1/1/2/2/1/1/1/2/2，直接复现本轮重复发现缺陷。报告 `/tmp/agentkib-manager-lifecycle-target-discovery-before-final.json`；仅临时替换模块导入用于对照，没有切换生产源码。完整命令和临时对照文件移出仓库记录 `/tmp/agentkib-manager-lifecycle-target-discovery-commands.txt`。
- 首轮扩展发现回归 16/17 通过、1 项新增 fixture 断言失败：原目录列表断言只计入 `sentinel.txt`，漏计既有跨进程 lease 自动创建的 `.agentkib-skill.lock`。修正为预先创建带标记内容的普通锁文件，并严格核对锁文件标记、外部 sentinel 与完整目录列表不变，未更改生产 lease 行为。之后加强过期预览的精确错误断言并重新执行完整 17 项通过，失败与修正过程保留在同一命令记录中。
- 同一真实后端场景辅助采样中，targets 发现总数由 126 降到 45，`fsync` 均为 50 次，操作均成功；采样壁钟约 2674ms → 1625ms。此数据只说明该次调用工作量减少，不视为稳定性能基准；证据 `/tmp/agentkib-manager-lifecycle-backend-profile-{before,after,comparison}.json`。
- 诊断探针运行记录为 99/117 通过、18 项超时，报告 `/tmp/agentkib-manager-lifecycle-profile-result.json`；调用与 I/O 数据 `/tmp/agentkib-manager-lifecycle-profile.jsonl`，摘要 `/tmp/agentkib-manager-lifecycle-profile-summary.json`。manager 首项在超时前已有 55 次 targets 发现、3314 次 `lstat`，当时用例尚未完成；lifecycle 首个超时是 sync-upstream 的 `records accepted library edits...`，有 29 次 targets 发现，扫描累计约 1.8 秒。随后 `retains GitHub baseline...` 记录到 47 次、约 2 秒，属于可能受前项在途操作影响的后续诊断。探针有额外开销，超时后的在途操作还会影响后续清理，仅把各套件首次超时前的数据作为主要定位依据；不能用该结果替代无探针默认验收，不能与无探针耗时作严格性能前后对比，也不把嵌套调用时间相加当作独立耗时。该证据未证明上轮两个普通导入项超时具有同一直接调用链；它们的历史隔离复核事实保留，本轮则由完整 100 项默认验收覆盖。
- Backend 在 `packages/backend` 执行 `./node_modules/.bin/tsc --noEmit --pretty false`，Desktop 在 `apps/desktop` 执行 `./node_modules/.bin/tsc -b --pretty false`，均退出 0；日志 `/tmp/agentkib-manager-lifecycle-{backend,desktop}-types.log`。3 个代码/测试/配置文件格式与空白检查通过；精确基线与当前静态检查均 0 告警、0 错误。文件清单 `/tmp/agentkib-manager-lifecycle-files.json`，证据 `/tmp/agentkib-manager-lifecycle-warning-audit/`。最终源码核对 `/tmp/agentkib-manager-lifecycle-final-code-validation.json` 确认原 17/100 项测试及 `skills.ts`、`skill-sync.ts`、`skill-state.ts` 逐字未变，3 文件仍匹配已验证哈希，默认命令无覆盖项，`git diff --check` 通过。

已执行的两个完整原套件默认验收命令（工作目录 `apps/desktop`，命令退出 0）：

```sh
./node_modules/.bin/vitest run \
  test/skill-sync-manager.test.ts test/skills-lifecycle.test.ts \
  --reporter=json \
  --outputFile=/tmp/agentkib-manager-lifecycle-core-result.json
```

上轮完整安全组、manager 与 lifecycle 的失败原文及各次失败报告继续保留，当前默认通过只使用本轮无探针的真实运行。此前 UX、Q 核对与 Web 验证记录保持各自原有范围；未重新验证 Web，未扩大为真实 Agent、Electron 或用户磁盘配置的实机验收；未执行 commit。

---

## 剩余项目核对与修复（2026-10-16）

状态：本轮剩余项核对、确认缺陷修复与验证已完成，新增 39 项全部通过：Desktop 27 项、Web 12 项。Desktop 最终单次无探针累计 99 文件、1493/1493 项通过，Web 单次全量 55 文件、1074/1074 项通过；均为默认 5 秒时限、显式 `maxWorkers=4`，0 失败、0 pending、命令退出 0。UX-23 窄屏 MCP 聚焦、UX-30/31 可达缺译、UX-33 桌面待处理说明，以及验证中暴露的测试等待与 Skills 局部重复发现均已处理。三个既有契约外增强、旧组件清理取舍与真实宿主/设备验证继续保留，不作本轮完成声明。首轮 98 文件与后续 99 文件失败事实仍见下文；最终累计来自独立的同一次 `final2` 运行，没有拼接旧报告。

| 类别与范围 | 当前核对、修复或保留的边界 | 证据与实现 |
|---|---|---|
| 历史未完成，后续已处理 | UX-02/12 草稿版本、计划与旧缓存问题，历批 UX/Q 已确认缺陷，以及旧 Skills 默认 5 秒超时，均按后续相应修复节判断当前状态。此前“未覆盖”“本轮未根治”与失败报告继续作为当时事实保留；不重复统计其用例，也不改写失败为通过。 | 前十二批、疑点核对与修复、两轮 Skills 默认时限根治记录 |
| UX-30/31：Desktop 实际缺译 | MCP 服务编辑中的私密值动作、值、键名可访问名称，导入动作可访问名称，以及资源库额外 Agent 数量提示仍有硬编码或未翻译部分。改用四语 key，按实际 env/header 组名与真实键名生成标签；数量提示同时本地化可见 title 与可访问名称并处理单复数。原密钥操作、来源 key、token、revision、保存请求和用户数据保持。 | `desktop/features/mcp/McpServiceEditor.tsx`、`McpImportPanel.tsx`；`desktop/features/catalog/AssetCatalogPage.tsx`；四语 `locales/*.json` |
| UX-31：Web 默认关闭控件 | 实际执行管理与新建任务的 Dialog 使用基础组件默认关闭控件，原硬编码 `Close` 会在非英语界面继续暴露。基础组件不再提供硬编码名称；显示默认关闭控件时类型要求传入 `closeLabel`，ManagedTasks 传入既有四语词典。关闭、Escape、焦点恢复、打开表单和选择保持。 | `web/features/conversation/components/ui/dialog.tsx`；`web/features/conversation/features/sessions/managed-tasks.tsx`；新增 `web/features/sessions/managed-dialog-localization.test.tsx` |
| UX-33：桌面待处理中心 | 桌面 EmbeddedShell 实际挂载 PendingCenter，本地 approved 凭据可打开其说明；该处四语原文仍把当前访问称为浏览器。仅将 Desktop `pendingInfo` 改为“当前访问”等中性说明，保留原待处理查询、请求身份与不自动重发行为。不把尚未证实本地可达的其他 browser 文案一起替换。 | `desktop/features/sessions/conversation/conversation.tsx`、`features/sessions/pending-center.tsx`、`codex-copy.ts`；新增 `pending-center-host-copy.test.tsx` |
| UX-23：窄屏 MCP 焦点可见 | 390px 隔离浏览器中，键盘 Tab 到表格操作时，浏览器默认滚动仍可能使按钮右缘超出局部滚动容器。实际操作容器现在在其内部控件获得焦点时使用 nearest 滚动，使聚焦按钮完整进入视口；以 DOM contains 排除 React Portal 菜单的冒泡焦点，避免菜单导航拖动表格。原按钮层级、继承保护、菜单项及请求保持。 | `desktop/features/mcp/McpManagementPanel.tsx`；新增 `McpManagementFocus.test.tsx`；隔离浏览器修复前后几何与键盘记录 |
| UX-05：补充 File 导航覆盖 | 使用真实 File、实际上传输入、Composer、引用面板与 Router，验证取消跨会话打开时保留同一草稿输入、附件行与引用；确认后才切换来源并清除原编辑状态。测试上传 transport 仍为模拟响应，不表示真实主机上传或 OS 文件选择框验收。 | 两端 `features/history/history-search-navigation.test.tsx`，各新增 2 项 |
| UX-05/08/25：独立增强 | 自动定位到历史命中消息、通用撤销、独立 MCP 自动更新检查均未实现。当前打开来源会话、应用后只读查看 Diff、手动搜索 Registry 并显式更新均有既有路径；不存在仅补文案即可安全实现的通用撤销或独立更新接口。继续保留为独立能力，不能将备份目录等同于撤销入口，或把 Registry 搜索结果匹配当成独立更新检查。 | `AppliedChangesNotice.tsx`；协议 `changes.plan` / `changes.apply`；`catalog.tsx` 与 `packages/backend/src/mcp.ts` |
| 扩展 Skills 磁盘验证：读放大 | 诊断确认 writer 在同一锁内、暂存前重复发现目标目录；现仅在该局部复用首次 targets，把暂存前 3 次降为 1 次。健康实际 apply 总调用由 4 次降为 2 次，暂存后的独立发现仍执行；receipt、reservation、可用性仍读真实磁盘，锁、暂存后身份/hash/source 复核和 fsync 保留。该优化减少已证实的重复工作，不将其称为全部间歇超时的唯一根因。 | `packages/backend/src/skill-manager.ts`；`desktop/test/skill-target-discovery.test.ts` 新增 5 项 |
| Q-05：维护取舍 | 旧 McpConnectionCard 及 `mcp.editorDescription`、`mcp.wrapperUnsupported` 仍未发现生产引用；清理与否不影响当前连接入口。实际链路为 McpHubPage → McpManagementPanel → McpBatchConnectionPanel，保留工作区选择、Diff、Home 显式批准、token 提交和连接验证。不据旧组件失去引用认定连接功能消失，本轮不删除旧组件、测试或 key。 | 既有 `McpConnectionEntry.test.tsx` 与本轮源码引用核对 |
| 真实宿主与设备边界 | 原生 OS 菜单、系统快捷键、文件选择框、真实 Agent 审批和断线重连、真实主机上传及手机软键盘仍需相应环境实机验证。React、Router、临时磁盘或隔离浏览器证据分别按其范围描述，不作为完整 Electron 或手机端到端验收。 | 各批原覆盖限制继续有效 |

已完成的针对性验证（各组与累计可能重叠，不重复累加）：

- Desktop 可达缺译：5 个文件、34/34 项通过，其中新增可访问标签 8 项、资源库数量提示 4 项，共 12 项。覆盖四语实际控件、私密替换请求、导入来源 key 与 token、单复数及打开期间切换语言；原来源与管理竞态/本地化测试作为回归。实际命令 `/tmp/agentkib-remaining-locale-command.txt`，结果 `/tmp/agentkib-remaining-locale-targeted.json`。
- Desktop 待处理中心：3 个文件、22/22 项通过，其中新增四语 4 项，既有附件 8 项与嵌入会话 10 项。经真实 EmbeddedConversation、SessionProvider 与 DesktopConversationAdapter，点击实际待处理入口，核对四语完整说明、不出现浏览器限定、原未确认请求身份保持且不发写请求或上传。修改前原文 4/4 因说明不符失败，结果 `/tmp/agentkib-remaining-pending-red-result.json`；修复后首轮新增 fixture 误将正常空会话目录观察订阅判为不应存在，补真实异步订阅并严格核对其原观察参数后通过，未修改生产订阅逻辑或删除说明断言。最终结果 `/tmp/agentkib-remaining-pending-tests-final-result.json`；所有实际命令与中间结果说明 `/tmp/agentkib-remaining-pending-commands.txt`。
- File 跨会话导航：Desktop、Web 各 1 个文件、6/6 项通过，各新增 2 项；真实 File 对象经原上传输入传给模拟 transport，并核对取消保留与确认清除的具体 DOM、草稿、引用及导航结果，不只检查引用数量。两端均不额外发送消息或删除请求。fixture 的能力响应修正记录保留；结果 `/tmp/agentkib-remaining-review-history-{desktop,web}-result.json`，早期 Web fixture 结果 `/tmp/agentkib-remaining-review-history-web-{first,second}-result.json`。
- Web 执行管理关闭控件：4 个文件、77/77 项通过，其中新增 10 项，覆盖四语实际执行管理与新建任务、打开期间切换语言且保留表单/工作区选择、原 Escape 和焦点恢复，不发执行写请求。修改前真实 10 项为 3 通过、7 失败，均对应非英语关闭名称或动态语言，结果 `/tmp/agentkib-remaining-web-dialog-before-result.json`；首次收集因项目没有 user-event 依赖而未执行测试，随后改用项目已有 fireEvent，未新增依赖，原结果 `/tmp/agentkib-remaining-web-dialog-red-result.json` 保留。最终结果 `/tmp/agentkib-remaining-web-dialog-targeted-result.json`。

- MCP 表格聚焦：新增 4 项，连同原操作回归共 2 个文件、16/16 项通过。覆盖启用、停用与继承服务，实际 Tab 到主操作和更多按钮时就近滚动、不派发操作；Portal 菜单焦点不调用表格滚动，ArrowDown/Escape 后返回原触发器。精确基线的首轮 4 项中，前三项暴露缺少可见性滚动，第四项初版测试误要求菜单项完全不调用滚动，而 Base UI 本来会主动滚动聚焦的菜单项；随后改为对 Portal popup 根节点合成 focus，严格核对其不触发表格滚动，不改变原菜单导航。首轮与最终报告分别为 `/tmp/agentkib-remaining-review-mcp-focus-before-result.json`、`/tmp/agentkib-remaining-review-mcp-focus-result.json`；真实裁切与修复后几何另由下述隔离浏览器证据复核。

- Skills apply 局部目录发现：原 17 项加新增 5 项，共 1 文件、22/22 项在默认配置下通过，最长约 531ms。新增健康 apply 次数断言在精确基线下得到 4、预期 2，名称过滤对照为 1 失败、其余 21 未运行，不将未运行用例计为失败或通过；原报告 `/tmp/agentkib-remaining-review-apply-discovery-before-result.json`。另验证预览后新 ownership/reservation 仍拒绝，以及真实 copyFile 暂存期间 workspace/target-link 漂移仍由后置复核拒绝、下个请求重新发现。最终结果 `/tmp/agentkib-remaining-review-apply-discovery-result.json`；未削弱磁盘、锁或写入断言。

本轮新增共 39 项：Desktop 可达缺译 12、待处理中心 4、File 导航 2、MCP 聚焦 4、Skills apply 发现 5；Web File 导航 2、执行管理关闭控件 10。其余既有用例只计回归，不计新增。

累计验证与过程记录（保留失败事实，最终以单次 final2 报告为准）：

- Web 单次全量 55 文件、1074/1074 项通过，`success=true`、0 失败、0 pending，退出 0；使用默认 5 秒时限及显式 `maxWorkers=4`。结果 `/tmp/agentkib-remaining-review-web-result.json`，摘要 `/tmp/agentkib-remaining-review-web-summary.json`，实际清单 `/tmp/agentkib-remaining-review-web-tests.json`，完整命令 `/tmp/agentkib-remaining-review-web-command.txt`，日志与退出码 `/tmp/agentkib-remaining-review-web.log`、`/tmp/agentkib-remaining-review-web-exit.json`。
- Desktop 首轮累计 98 文件、1482/1484 项，2 失败、0 pending，退出 1，原报告 `success=false`。`-draft-actions.test.tsx` 的放弃草稿用例未等到 Assets 编辑器，失败时 DOM 仍为空 Suspense fallback；`composer-host-copy.test.tsx` 的英语附件用例在实际能力响应就绪前立即断言 input 可用。两项均不是整项 5 秒超时。原结果 `/tmp/agentkib-remaining-review-desktop-result.json`、清单 `/tmp/agentkib-remaining-review-desktop-tests.json`、命令 `/tmp/agentkib-remaining-review-desktop-command.txt`、日志与退出码 `/tmp/agentkib-remaining-review-desktop.log`、`/tmp/agentkib-remaining-review-desktop-exit.json` 保留，不能计为完整通过。
- 第二次 99 文件累计当时未通过：1477/1488 项、11 失败、0 pending，退出 1，`success=false`；默认 5 秒时限及显式 `maxWorkers=4` 未变。新增 34 项与上述两处等待修正对应场景通过，但不能替代整个累计。4 个路由失败为首页动作 2 项、工作区首次加载 1 项和刷新 1 项，均未等到真实分包内容，当时继续核对原加载等待；Skills 另有 boundary 1 项、recovery 5 项、discovery 1 项约 5.07–5.18 秒超时，当时继续定位，不将其预判为环境问题或当前修复回归，也不把后续读放大优化当成已证明的唯一根因。原报告 `/tmp/agentkib-remaining-review-desktop-final-result.json`、实际清单 `/tmp/agentkib-remaining-review-desktop-final-tests.json`、命令 `/tmp/agentkib-remaining-review-desktop-final-command.txt`、退出码 `/tmp/agentkib-remaining-review-desktop-final-exit.json` 永久保留；后续已使用新的报告路径，此失败结果未覆盖。
- 草稿测试使用的 `Route.options.component` 已由现有 TanStack 自动分包转换为 lazyRouteComponent；首次动态 import 在累计并行运行时可能超过 Testing Library 默认 1 秒等待。原测试独立运行 5/5 通过、最长约 479ms；现在在 renderRoute 前等待该真实组件已有 `preload?.()`，不改变生产分包或任何时限，修正后 5/5 通过，报告 `/tmp/agentkib-remaining-review-draft-{first,fixed}-result.json`。附件测试改为等待实际异步能力使原 input 就绪，8/8 通过；保留真实输入和上传断言，不将立即渲染等同于能力已到达。这些定向结果没有用来拼接最终累计，最终单次结果见下文。

- 后续已对另外三份路由测试采用同一真实分包预加载等待：首页动作 6 项、首次加载 14 项、刷新 6 项，共 3 文件、26/26 通过；不修改生产路由、查询等待上限或测试时限。实际命令 `/tmp/agentkib-remaining-route-preload-command.txt`，结果 `/tmp/agentkib-remaining-route-preload-result.json`。这些定向结果只计专项，完整验证另见最终单次累计。
- 对出现超时的三份磁盘文件独立加入只读诊断探针，默认 5 秒下 3 文件、43/43 项通过，最长约 3.09 秒，未观察到结束后的在途操作。探针观察到 writer 同一锁内、暂存前重复发现目标目录，但没有证明它是全部间歇超时的唯一根因；已完成上述局部去重和 22 项安全/发现回归，暂存后独立复核、锁与 fsync 保留。诊断结果 `/tmp/agentkib-remaining-filesystem-profile-result.json`，调用记录 `/tmp/agentkib-remaining-filesystem-profile.jsonl`，实际临时配置与日志 `/tmp/agentkib-remaining-filesystem-profile.config.mts`、`/tmp/agentkib-remaining-filesystem-profile.log`。首次临时 `.ts` 配置因 CJS/ESM 加载方式启动失败、未执行测试，原 `/tmp/agentkib-remaining-filesystem-profile-startup.log` 保留；诊断运行不替代无探针累计验收。

- 继续核对相同分包等待写法，在另 5 份既有路由测试中补真实组件预加载，共 52/52 通过，无新增用例；其余已预加载或使用真实 Router 的路径没有机械修改。清单、实际命令和结果 `/tmp/agentkib-remaining-route-preload-sweep-{files.json,command.txt,result.json}`。后续使用独立 `desktop-final2` 路径执行无探针 99 文件累计，完整实际结果如下。

最终单次累计验证：

- Desktop：同一次 `final2` 运行实际 99 文件、1493/1493 项，`success=true`、0 失败、0 pending、退出 0；实际文件集合与清单完全匹配。使用默认 5000ms 测试时限及显式 `maxWorkers=4`，未附加诊断探针、名称筛选、重试或超时覆盖，壁钟约 192.50 秒。结果 `/tmp/agentkib-remaining-review-desktop-final2-result.json`，摘要 `/tmp/agentkib-remaining-review-desktop-final2-summary.json`，实际清单 `/tmp/agentkib-remaining-review-desktop-final2-tests.json`，完整实际命令 `/tmp/agentkib-remaining-review-desktop-final2-command.txt`，日志 `/tmp/agentkib-remaining-review-desktop-final2.log`，退出码 `/tmp/agentkib-remaining-review-desktop-final2-exit.json`。前两份失败报告仍保留原值，不与本报告拼接。
- 该同次运行中的 manager/lifecycle 原 117 项为 117/117，最长约 3463ms；Skills 完整安全子集 11 文件、277/277 项，包含原 UI 12 项，不再另加。安全子集最慢约 4992.91ms，接近默认 5 秒上限；此次实际通过不能证明任意 I/O 负载下不再抖动，也没有证明此前 7 个超时均由同一原因引起。保留复核条件、独立目标发现与真实磁盘安全断言，不提高上限。
- 最终 31 个代码/语言文件在整个累计运行期间哈希未变，证据 `/tmp/agentkib-remaining-review-final2-code-validation.json`；Web 最终类型和 55 文件、1074/1074 项报告对应源码未再改变。上述两端各自均使用真实单次报告，不把专项或诊断结果额外累加。

已完成的类型、静态与文案验证：

- Desktop `./node_modules/.bin/tsc -b --pretty false` 与 Web `./node_modules/.bin/tsc --noEmit --pretty false` 均退出 0；日志 `/tmp/agentkib-remaining-review-desktop-types-final2.log`、`/tmp/agentkib-remaining-review-web-types.log`。Web 首次类型检查发现新增测试三处误传 ByRoleOptions 不支持的 `exact` 属性；删除该无效属性后使用字符串 name 的默认精确匹配并重新通过，原日志 `/tmp/agentkib-remaining-review-web-types-first.log` 保留，未放宽断言或生产类型。
- 最终代码与语言文件共 31 个：27 个 TS/TSX、4 个 JSON；22 个既有 TS/TSX 和四语 JSON 均有精确修改前快照，5 个 TS/TSX 为新增测试。未用 HEAD 替代已有未提交工作。31 文件格式及 13 个 tracked、18 个 untracked 文件空白检查通过，清单 `/tmp/agentkib-remaining-review-files.json`，证据 `/tmp/agentkib-remaining-review-warning-audit/{format.log,whitespace.json,sources.json}`。
- Backend 使用项目已有 Desktop TypeScript 二进制执行 `./apps/desktop/node_modules/.bin/tsc --noEmit -p packages/backend/tsconfig.json --pretty false`，退出 0，日志 `/tmp/agentkib-remaining-review-backend-types.log`。首次使用根目录不存在的 tsc 路径退出 127、未执行编译，原 `/tmp/agentkib-remaining-review-backend-types-first.log` 保留；随后修正工具路径，没有编译错误或依赖变更。
- 相同配置下当前与精确基线均 7 warning、0 error；按路径、规则、完整诊断和标注源码逐条匹配，新增 0、消失 0，其中 effect 中设置状态 4 条、hook 依赖 3 条；五个新增文件零告警。证据 `/tmp/agentkib-remaining-review-warning-audit/{comparison,current,previous,metadata}.json`。
- 收尾源码核对另扫描 554 条生产 TSX aria/title 候选与 locale 分支；两端各 30 处实际 managedText 调用、27 个唯一 key 均能命中字典，未发现新的确定缺译。证据 `/tmp/agentkib-remaining-locale-{aria-title,branch}-scan.txt`、`/tmp/agentkib-remaining-locale-managed-key-summary.json`。该口径不覆盖所有动态路径、第三方错误或全应用翻译，不能扩大为全仓国际化验收。
- 四语主 JSON 各 2342 → 2348 个 key，新增集合相同：私密动作、值、键名、导入动作与额外 Agent 数量单复数共 6 个；旧 key 值逐项保持。证据 `/tmp/agentkib-remaining-review-locale-validation.json`。实际控件测试另验证翻译和参数，key 对齐不代替渲染验证。

隔离浏览器复核（实际 React、CSS 与原生键盘事件，不是实际设备验收）：

- 使用真实 SkillUsageList、McpManagementPanel、McpDisclosure 和 Base UI 组件；Vite 编译实际 Desktop styles.css，并以实际源码为 CSS 扫描范围，API alias 仅返回 fixture。四语 × 390/1280 宽度：9 种部署状态共 72 张 Skill 卡、3 种服务状态共 24 行 MCP，各保留 2 个直接按钮（推荐操作与更多），无卡片/页面水平溢出或操作重叠。390px MCP 表格使用局部横滚，不能将其等同于页面溢出；手动滚到右端时每行两个操作完整可见。原布局记录 `/tmp/agentkib-remaining-browser/layout-metrics.json`。
- MCP 键盘焦点修复前后使用同一窄屏场景：容器横向范围约 16–374，启用项更多按钮由 361.17–393.17 改为 341.17–373.17，右缘进入容器；停用项修复后约 341.10–373.10。390/1280 × 启用/停用/继承共 6 条流程均复核；菜单 ArrowDown 前后表格 scrollLeft 不变，Escape 回到原触发器，继承项没有移除动作。结果 `/tmp/agentkib-remaining-browser/mcp-keyboard-after-metrics.json`，修复前证据继续保留；只调用 fixture 读取，不执行真实探测、保存、移除或 OAuth。
- Skills 仅对 incoming 状态在两种宽度执行 Tab → Enter → ArrowDown → Escape，核对更多菜单中的危险撤销部署项及焦点返回；其余 8 种状态只验证布局，没有逐项执行。UX-26 只验证共享 McpDisclosure 的 Enter/Space 展开收起与受控端口输入 1422 保留，不代表完整 catalog 路由定位、主机网络设置或 Electron 验收。脚本、截图和几何保存在 `/tmp/agentkib-remaining-browser/`，完整方法与前后状态见 `/tmp/agentkib-remaining-browser/validation.md`；真实 Agent/MCP、主机上传和手机软键盘继续保留为实机边界。

文档保护核对：45 个 UX ID 唯一且顺序保持；前十二批、Q 原始与修复两节、两轮 Skills 根治整节逐字保留。移除本轮新增总览、7 条状态指针和新节，并还原建议第 14 项后，全文精确等于本轮修改前快照。检查脚本与结果 `/tmp/agentkib-remaining-review-doc-preservation.py`、`/tmp/agentkib-remaining-review-doc-preservation.json`。

本轮没有改变公共协议、权限、持久化结构、生产依赖或测试时限，也未写入用户真实 MCP 配置或执行 commit。历史 45 个 UX 条目、前十二批、Q 核对与两轮 Skills 根治记录继续按各自原有范围保留。

---

## 建议修复顺序

1. **第一批（已完成）**：UX-02、UX-12，以及计划失效和旧草稿缓存清理；验证见第一批修复记录。
2. **第二批（已完成：失败可见与恢复）**：UX-03、UX-06、UX-13、UX-21；区分首次加载、刷新和失败，刷新失败后保留已有内容，验证见第二批修复记录。第二批当时未覆盖在途页面保留；UX-11 当前处理状态见第五批修复记录。
3. **第三批（已完成：流程与效率）**：UX-04、UX-08、UX-09、UX-14、UX-16、UX-17、UX-20；实现与验证状态见第三批修复记录。UX-08 的撤销能力继续保留为后续评估，不把备份路径等同于撤销入口。后续状态见第四批修复记录。
4. **第四批（已完成：输入、搜索与交接反馈）**：UX-01、UX-05、UX-07；验证与剩余限制见第四批修复记录。UX-05 当前只打开来源会话，自动跳到命中消息仍未实现。
5. **第五批（已完成：待审入口、页面保留与状态反馈）**：UX-10、UX-11、UX-15、UX-18、UX-19；实现范围、验证与实机覆盖限制见第五批修复记录。
6. **第六批（已完成：术语与实际缺译）**：UX-30、UX-31；主要入口和已确认路径修复与自动化验证通过，范围与审计边界见第六批修复记录。
7. **第七批（已完成：操作层级与管理入口）**：UX-23、UX-24、UX-26、UX-28；实现、综合验证与实机覆盖限制见第七批修复记录。
8. **第八批（已完成：访问确认、反馈与入口）**：UX-22、UX-25、UX-27、UX-29；当前实现与验证范围见第八批修复记录。UX-25 独立自动更新检查不包含在本轮完成范围。
9. **第九批（已完成：本地化、快捷键与路由状态）**：UX-32、UX-33、UX-34、UX-35；实现、综合验证与实机覆盖限制见第九批修复记录。
10. **第十批（已完成：待同步定位、Context 默认与状态反馈）**：UX-36、UX-37、UX-38、UX-39；实现、Desktop 累计验证与实机覆盖限制见第十批修复记录，原第八批 MCP 搜索反馈历史保留。
11. **第十一批（已完成：空计划、草稿校验与工具反馈）**：UX-40、UX-41、UX-42、UX-43；实现、Desktop 累计与静态验证、实机覆盖限制见第十一批修复记录。
12. **第十二批（已完成：会话细节与 Web 触控目标）**：UX-44、UX-45；审批身份、历史结果本地化、离线草稿及 Web 触控目标的实现，Desktop 累计、Web 本轮全量、静态与类型验证，以及实机覆盖边界见第十二批修复记录。
13. **疑点核对（已完成）**：Q-01—Q-05 已区分既有范围、确认缺陷与未发现功能缺陷的候选；说明缺失、应用锁竞态、首次目录状态与嵌入会话提醒已修复，55 项新增测试通过。旧 Skills 集成与当时 85 文件累计记录保留；后端完整 manager/lifecycle 原 117 项已在同一次默认配置运行中全部通过，新增 9 项回归通过。累计 94 文件在默认 5 秒时限、显式 `maxWorkers=4` 下单次 1462/1462 通过，包含 Skills 完整安全 272/272 与原磁盘 UI 12/12。根因、验证条件及当前状态见[后端完整套件修复记录](#后端-manager-与-lifecycle-完整套件默认时限修复2026-10-16)，旧失败事实仍见此前记录。
14. **剩余项目复核（本轮已完成）**：UX-23 窄屏聚焦、UX-30/31 可达缺译与 UX-33 桌面宿主说明已修复，39 项新增与两端单次累计/全量验证通过，实际条件见[剩余项目核对与修复](#剩余项目核对与修复2026-10-16)。UX-05 自动定位命中消息、UX-08 通用撤销与 UX-25 独立 MCP 自动更新检查保留为独立增强；Q-05 旧组件与未用 key 为维护取舍；原生菜单/快捷键/文件框、真实 Agent 审批/重连、真实宿主上传和手机软键盘为实机覆盖边界。旧失败记录继续保留，全仓文案和未复现状态仍依证据处理。

## 已有的优点（修复时请保持）

- 写入前先预览完整 Diff，结果按项展示，可以只重试失败项（Skill 部署 / 导入、MCP 批量启停）。
- 多处已有异步保护：requestId 加工作区双重校验、应用变更期间锁定导航、`runLocked` 防止重复提交。应保留并补齐 UX-02、UX-12 的草稿版本与生成/应用互斥缺口，不能概括为全部竞态已处理。
- Doctor → 审查 Diff → 应用 → 复检，这条闭环完整。
- 结果不确定时不会自动重发；压缩上下文期间仍可编辑草稿、加入队列。
- Web 移动端：列表和详情分屏，有返回按钮，页头按钮 44px，使用 dvh；配对时显示双端校验数字。
- 基线四种语言 JSON locale 的 key 对齐（各 2227 个）；局部字典与动态键匹配仍需单独核查，见 UX-31。

## 合并后 CI 验证补充（2026-10-16）

原会话 PR #125 合并前检查通过，但 `main 44bc25a60` 的 Windows ARM64 稳定性套件随后在历史引用原生发送测试的目录清理阶段报 `EBUSY`（933 通过、11 跳过、1 失败）。已修复 Backend 未等待托管 Codex CLI 退出的关闭竞态，补齐 8 项生命周期与 1 项真实进程回归；旧构建上的新增集成测试失败，修复后通过。完整稳定性列表在本机 Node 22、默认 5000ms、`maxWorkers=2` 下 33 文件、958 通过、1 条件跳过、0 失败，相邻会话测试 83/83 通过。Windows 生命周期单测已纳入 CI，未提高测试时限或增加重试。

失败记录、根因、实际命令条件与远程验证边界见 [原会话集成验证补充](native-session-main-integration-2026-10-16.md#合并后-windows-ci-关闭竞态修复)。保留此前各轮验证结果，不将合并前 CI 或 macOS 本地结果当作 Windows 合并后验证。
