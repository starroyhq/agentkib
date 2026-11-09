# AgentKib UI/UX 复查问题清单（2026-10-17）

- 基线：`main` @ `0e02f6a49`，包含 PR #123（上一轮问题的修复）、PR #125（连接原 Claude 终端）和 PR #126（后端退出流程）。对比上一轮基线 `cb0828fc1`。
- 范围：桌面端（`apps/desktop/src`）与 Web 端（`apps/web/src`）的界面、流程与交互；PR #125 涉及的后端状态和终端插件文案一并核对。不含安全审计。
- 方法：阅读源码，对比 `cb0828fc1..0e02f6a49` 的改动；未启动应用、未运行测试、未实机操作。[上一轮清单](ui-ux-review-2026-10-16.md)中的修复记录只作线索，结论以源码为准。PR #126 只改了后端退出流程和测试，不影响本文结论。
- 路径约定：沿用上一轮。`desktop/` 指 `apps/desktop/src/`，`web/` 指 `apps/web/src/`，`conv/` 指 `apps/desktop/src/features/sessions/conversation/`（Web 端 `web/features/conversation/` 是同源副本，行号基本一致，修复时两端同步）。本文另用 `ws/` 指 `desktop/routes/(main)/workspace/$workspaceId/`。
- 编号：上一轮的条目沿用原编号；本轮新问题从 UX-46 起续编。
- 判定沿用上一轮的标签："已确认缺陷"表示代码路径可以证实；"待实机"表示视觉、设备或运行表现还没有复现；"待确认"表示依据不足，修复前需要先核实。
- 术语：建议文案以 `docs/development/ui-terminology.md` 为准。

严重程度：

- **P1**：主流程断裂、数据丢失或失败无反馈，优先修复。
- **P2**：流程不闭环、操作层级混乱或明显影响效率。
- **P3**：一致性、文案与细节体验。

---

## 复查结论

上一轮 50 项（UX-01–45、Q-01–05）的状态：

| 结果 | 数量 | 条目 |
|---|---|---|
| 已修复 | 42 | UX-01–06、UX-09–18、UX-20–24、UX-26–29、UX-31–44、Q-01、Q-03、Q-04 |
| 部分修复 | 6 | UX-07、UX-08、UX-19、UX-25、UX-30、UX-45，剩余部分见[部分修复的条目](#部分修复的条目) |
| 按设计保留 | 2 | Q-02（切换工作区时清空待审计划）、Q-05（未使用的旧组件与文案） |

开发者已把三项改进列为后续增强：UX-05 的自动定位命中消息、UX-08 的撤销、UX-25 的独立检查 MCP 更新。UX-05 的其余部分已经修好，计为已修复；UX-08 另有交接路径缺少成功反馈；UX-25 的剩余部分就是这项增强，本文只建议在做之前先加一句说明。详见下文。

本轮新问题：

| ID | 级别 | 问题 | 来源 |
|---|---|---|---|
| UX-46 | P1 | 触屏设备上按回车会直接发送消息 | UX-01 的修复引入 |
| UX-47 | P2 | 编辑草稿会静默作废 Doctor 和交接生成的计划 | UX-02 的修复引入 |
| UX-48 | P2 | 外部修改 manifest 后重新扫描，出现"假草稿" | 基线已有，新加的草稿标记让它暴露出来 |
| UX-49 | P2 | 生成计划期间仍可编辑，生成结果被静默丢弃 | UX-11 的修复引入 |
| UX-50 | P2 | "已应用"横幅不会失效 | UX-08 的修复引入 |
| UX-51 | P2 | MCP 网络设置的跳转参数一直保留，之后每次回到资源库都会抢焦点 | UX-26 的修复引入 |
| UX-52 | P2 | 资源库任一查询首次失败，整页被挡住 | UX-38 的修复引入 |
| UX-53 | P2 | 记忆"保存并批准"后编辑框不退出 | 基线已有 |
| UX-54 | P2 | 默认主题下错误文字对比度不足 | 基线已有 |
| UX-55 | P2 | 连接原终端：连接码不能复制，"检查连接"会清掉连接码 | PR #125 |
| UX-56 | P2 | 连接原终端：连接失败时桌面端没有反馈 | PR #125 |
| UX-57 | P2 | 连接原终端：不支持的平台或桥接启动失败时不给原因 | PR #125 |
| UX-58 | P2 | Claude 会话横幅与实际状态不符 | PR #125 |
| UX-59 | P2 | Web 访问权限文案只写 Codex，实际也控制 Claude | 基线已有 |
| UX-60–63 | P3 | 工作区、资源库、会话与 Web、连接原终端的细节 | 混合 |
| UX-64 | P3 | 首页残留的旧叫法（2026-10-17 补充，不在"本轮实施记录"范围内） | 基线已有 |

---

## 对上一轮结论的更正

| ID | 上一轮写法 | 复查结论 | 依据 |
|---|---|---|---|
| UX-24 | 部署全部成功后，主按钮仍是"重新审查" | **不成立**。基线中"重新审查"只在后台复查进行中（按钮禁用）或复查失败时出现 | `git show cb0828fc1:apps/desktop/src/features/skills/SkillManagerPanels.tsx`，第 306-321、468、781-786 行 |
| UX-31 | 约 170 处文案绕过 i18n | **数量夸大约 3 倍**。真正只有中英两种语言的约 50 处（`ClaudeSessionPanel` 44 处、`ClaudeFilesPanel` 6 处），其余是已带四种语言的局部字典。问题本身成立：该面板在基线中可以从工作区会话页打开 | 基线 `desktop/features/workspace/WorkspaceSessionsPage.tsx:456` 的按钮打开 `:933` 的面板 |
| UX-38 | 没有工作区时也没有添加按钮 | **不成立**。页头一直有"添加"按钮，问题只在空状态文案 | 基线 `desktop/routes/(main)/workspaces.tsx:168`（`onAddWorkspace`）；空状态用的是 `workspace.noMatch` |
| UX-01 | 定为 P1 | **定级偏高**，可以用 Tab 移到发送按钮提交。当前清单已放在 P2，同意 | — |

UX-03、UX-06、UX-13 的判定已由开发者收窄（见上一轮清单各条的"判定"），复查同意。

---

## 部分修复的条目

### UX-07 交接相关的术语仍不统一（剩余部分）

- 判定：已确认缺陷，P2。
- 已修复：执行管理里的禁用条件已就近说明原因（`conv/features/sessions/managed-tasks.tsx:280-296, 605-609`）。
- 剩余：工作区 Claude 面板仍写"准备接管"（`desktop/features/workspace/ClaudeSessionPanel.tsx:660`）、"释放给原客户端"（`:703`）和状态"已释放"（`:498`）。执行管理里同一动作叫"交还原客户端"（`conv/features/sessions/managed-tasks.tsx:602`）。
- 建议：按 `docs/development/ui-terminology.md` 改为"交给 AgentKib""交还原客户端""已交还"，四种语言同步。
- 验收：工作区 Claude 面板与执行管理对同一动作用同一叫法。

### UX-08 应用后的反馈（剩余部分）

- 判定：已确认缺陷，P2。撤销按开发者计划作为增强另做。
- 已修复：普通计划和 Doctor 修复应用后，显示成功横幅、本次 Diff 快照和备份目录（`desktop/features/workspace/AppliedChangesNotice.tsx:20-57`）。
- 剩余：会话交接的"应用并继续"成功时调用 `onApplied(false)`，不带应用结果（`ws/changes.tsx:223-224`），而横幅只在有结果时写入（`ws/changes.tsx:556-564`），所以这条路径没有成功反馈。
- 建议：交接成功路径也传入应用结果，或在会话页提示"已应用 N 个文件的变更"。
- 验收：交接"应用并继续"成功后，能看到已写入的文件。

### UX-19 未交接的会话被标为"仅查看历史"（被 PR #125 部分回退）

- 判定：已确认缺陷，P2。
- 已修复：页头状态已能区分"待交接"和"仅可查看"（`conv/features/sessions/session-display-state.ts:168-178`）。
- 回退：PR #125 在会话正文上方新增的 Claude 横幅（`conv/features/sessions/session-reader.tsx:118-141`）里，只要执行模式不是 `claude-follower` 或 `claude-managed`，标题就写"仅查看历史"，正文写"尚未连接原终端……"。还没交接的 Claude 会话，后端返回的执行模式正是 `managed-resume`、原因是 `handoff-required`（`packages/backend/src/claude-managed-read.ts:2615-2632`）。结果是页头写"待交接"，横幅写"仅查看历史"，并把用户引向"连接原终端"，而不是"交给 AgentKib"。
- 建议：横幅按执行模式和原因分支；`managed-resume` 显示"待交接"，并说明两条路径（交给 AgentKib，或连接原终端只做同步观察）。Web 同源副本同步修改。
- 验收：未交接的 Claude 会话，页头和横幅的状态一致。

### UX-25 MCP 更新只能靠手动搜索发现（剩余部分）

- 判定：增强，P2。开发者已列为后续工作。
- 已修复：操作结果具名、空状态、Registry 的四种状态。
- 剩余："更新"按钮只在 Registry 搜索结果里找到同一包的不同版本时出现（`desktop/routes/(main)/catalog.tsx:925-930`），而 Registry 查询只在手动搜索后启用（`:590-597`，`enabled: registryRequest !== undefined`）。
- 建议：在独立检查做好之前，已安装列表加一句"搜索 Registry 后可检查更新"，避免用户误以为没有更新。

### UX-30 术语不统一（剩余部分）

- 判定：已确认缺陷，P3。
- 剩余（简体中文，`desktop/locales/zh-CN.json`）：
  - "MCP Server"（`:1339, 1343, 1351`）与"MCP 服务"（`:1345, 1347`）混用。
  - 已安装包的按钮叫"移除"（`desktop/routes/(main)/catalog.tsx:956`，`common.remove`），确认框写"卸载"（`:1354`）。
  - "收录服务"（`:2011`）与"导入操作"（`:2349`）指同一动作。
  - 引导卡仍写"Context Doctor"（`:814, 817`），导航叫"诊断"（`:1589`）。
  - "应用无冲突位置"（`:1238`）偏工程用语。
  - 同一个概念有三种叫法："扫描目录"（`:750, 802`）、"授权扫描目录"（`:728, 927`）、"授权目录"（`:801`，首页空状态）。
- 剩余（PR #125）：
  - 接管、交给、交还、释放、续接、连接几种说法并存，界面上没有区分说明。
  - 繁体中文写"原會話"（`conv/features/sessions/claude-connection-copy.ts:33, 45` 等），术语表规定繁中用"對話"。
- 建议：按 `docs/development/ui-terminology.md` 逐条统一；"连接原终端"（只同步观察、可取消当前轮次）与"交给 AgentKib"（接管执行）在首次出现处各用一句话说明区别。

### UX-45 Web 端部分触控目标小于 44px（剩余部分）

- 判定：已确认缺陷，P3。
- 已修复：会话列表、页头按钮已到 44px。
- 剩余：输入区的停止、发送、高级选项、附件按钮仍是 36px（`web/features/conversation/features/sessions/session-composer.tsx:300, 309, 324, 532-536`，`size-9`）；侧栏底部的登出按钮用 `size="icon"`（`web/features/sessions/session-workspace.tsx:277-283`），也是 36px（`web/features/conversation/components/ui/button.tsx:25`）。
- 建议：触屏或窄屏下改为 44px。

---

## P1

### UX-46 触屏设备上按回车会直接发送消息

- 判定：已确认缺陷（代码路径）；手机实际表现待实机。
- 位置：`conv/features/sessions/session-composer.tsx:404-427`（Enter 发送处理），Web 同源副本相同位置。
- 现状：UX-01 修复后，Enter 发送、Shift+Enter 换行，并已排除输入法组合输入（`isComposing`、`keyCode === 229`）。但没有区分触屏或粗指针设备。手机软键盘上的回车键会直接发送，无法换行。
- 影响：在手机上写多行指令时，按一下回车就会把写了一半的内容发给 Agent，Agent 可能据此开始执行。
- 建议：在 `(pointer: coarse)` 或没有物理键盘的环境下，Enter 只换行，用发送按钮提交；"Enter 发送"的提示只在桌面显示（`:436-438`）。
- 验收：iOS Safari、Android Chrome 上回车换行、按钮发送；桌面端 Enter 发送、Shift+Enter 换行，输入法组合中按 Enter 不发送。

---

## P2

### 工作区：计划与草稿的生命周期

#### UX-47 编辑草稿会静默作废 Doctor 和交接生成的计划

- 判定：已确认缺陷。
- 位置：`desktop/features/workspace/workspace-store.ts:80-92`（`setManifest`）、`:166-177`（`discardWorkspaceDraft`）；对照 `ws/index.tsx:217-226`、`workspace-store.ts:102-103` 的注释。
- 现状：只要存在 `changeSet`，manifest 的任何变化都会清空 `changeSet`、`changeSetManifest` 和 `handoffLaunchRequest`，不区分计划来源。概览（`ws/index.tsx:222`）和应用后的回读注释，都把 Doctor 与交接计划视为不依赖草稿，两处设计互相矛盾。"放弃草稿"的确认文案（`workspace.leaveDraftConfirm`："放弃当前工作区中尚未保存的草稿吗？"）也没有提到计划会一起丢弃。
- 影响：生成 Doctor 修复计划或会话交接计划后，在资产页改一个字，侧栏和概览的待审入口就消失，交接请求也被清空，没有任何提示。用户只能重新诊断或重新发起交接。
- 建议：只让普通（standard）计划随草稿失效；Doctor 与交接计划保留，或在作废时提示并给出"重新生成"入口。"放弃草稿"的确认文案说明对计划的影响。
- 验收：存在 Doctor 或交接计划时编辑草稿，计划保留，或有明确提示和重新生成入口；普通计划仍按现有逻辑失效。

#### UX-48 外部修改 manifest 后重新扫描，出现"假草稿"

- 判定：已确认缺陷。逻辑基线就有，PR #123 新增的"未保存"标记让它直接暴露出来。
- 位置：`ws/route.tsx:198-251`（`loadWorkspace`，关键在 `:205` 和 `:242-251`）；`desktop/features/app/useAppNavigation.ts:146-177` 的 `load` 是同样的逻辑，需要一起改。
- 现状：重新扫描时，`targetDraft = initialState.manifest ?? draft`。只要内存里已有 manifest，即使它和旧的磁盘基线完全一样，也优先于磁盘上的新内容；基线却更新成磁盘版本。
- 影响：`git pull` 或在编辑器里改了 manifest 后点"重新扫描"，页头出现"未保存"，内容仍是旧的。如果接着审查并应用变更，就会用旧内容覆盖外部修改。Diff 里能看到差异，但用户很难意识到自己是在撤销外部修改。
- 建议：内存内容等于旧基线（没有真实草稿）时，直接采用磁盘版本；确实有草稿、磁盘也变了时，提示冲突并让用户选择。
- 验收：外部修改后重新扫描，没有草稿时显示磁盘新内容、不出现"未保存"；有草稿时出现冲突提示。

#### UX-49 生成计划期间仍可编辑，生成结果被静默丢弃

- 判定：已确认缺陷。
- 位置：`ws/route.tsx:309-314`（结果返回时 manifest 已变化就直接返回）、`:462-467`（进行中文案复用 `workspace.updating`："正在更新工作区…"）；`ws/assets.tsx:556-575`（资产页不读 `busy`，生成期间照常可编辑）；测试 `ws/-workspace-load.test.tsx:345` 断言了"忽略被新编辑取代的计划"。
- 现状：在资产页点"审查变更"后继续输入，计划返回时发现草稿已变，就不跳转、不提示，计划被丢弃。
- 影响：用户等来的是"什么都没发生"，不知道需要再点一次。
- 建议：保留"丢弃过时计划"的行为，但在被取代时就地提示"草稿已修改，请重新审查变更"；或生成期间资产页只读。进行中文案改为"正在生成变更计划…"。
- 验收：生成期间编辑草稿，结果返回后有明确提示；不会应用过时的计划。

#### UX-50 "已应用"横幅不会失效

- 判定：已确认缺陷。
- 位置：`ws/route.tsx:445-451`；`ws/changes.tsx:556-564`；`desktop/features/app/useWorkspaceTransitions.ts:72-89`（离开工作区）、`:118-131`（切换工作区），这两处都不清除 `appliedChanges`。
- 现状：`appliedChanges` 只在手动关闭或下一次应用时替换。生成新计划后，变更页同时显示旧的"已应用 N 个文件的变更"和新计划的"应用变更"按钮；离开工作区再回来，旧横幅仍在。
- 影响：容易误以为新计划已经应用，或把旧结果当成本次结果。
- 建议：生成新计划、离开或切换工作区时清除横幅。
- 验收：应用后生成新计划，旧横幅消失；离开工作区再回来，不再显示旧横幅。

### 资源库

#### UX-51 MCP 网络设置的跳转参数一直保留，之后每次回到资源库都会抢焦点

- 判定：已确认缺陷。
- 位置：`desktop/features/settings/GlobalSettings.tsx:310-318`（写入 `catalogTarget: "mcp-network"`）；`desktop/routes/(main)/catalog.tsx:118-124`（只有切换分区时才清除）；`desktop/features/app/useAppNavigation.ts:95-107`（导航记忆保存完整 search）、`:288-294`（侧栏导航时恢复）；`catalog.tsx:536-552`（挂载时展开高级区、滚动并聚焦）。
- 现状：从设置跳到 MCP 网络设置后，`catalogTarget` 一直留在 URL 和导航记忆里。之后每次从侧栏回到资源库，页面都会重新展开高级区、滚动过去并移走焦点。
- 影响：用户回到资源库时视图被拉走，键盘焦点丢失。
- 建议：定位完成后用 replace 导航移除 `catalogTarget`；或导航记忆不保存这类一次性参数。
- 验收：从设置跳转一次后，再从侧栏回到资源库，停在上次的位置，不展开、不抢焦点。

#### UX-52 资源库任一查询首次失败，整页被挡住

- 判定：已确认缺陷。
- 位置：`desktop/routes/(main)/catalog.tsx:134-158`。
- 现状：资产目录、工作区、记忆三个查询中，任何一个首次加载失败（没有缓存数据），页面就只渲染错误提示，连分区导航都没有。技能和 MCP 分区并不依赖记忆查询，也一起被挡住。
- 影响：一个次要数据源出错，用户就无法使用整个资源库。
- 建议：按分区依赖拦截：失败的分区内显示错误和重试，其他分区照常可用。
- 验收：模拟记忆查询失败时，技能和 MCP 分区仍可使用，记忆分区显示错误和重试。

#### UX-53 记忆"保存并批准"后编辑框不退出

- 判定：已确认缺陷。
- 位置：`desktop/features/catalog/MemoryCard.tsx:21, 33-46`（成功后不重置 `editing`）、`:67-76`（编辑框）、`:116-126`（已批准状态只有"作废"）；`desktop/routes/(main)/catalog.tsx:488-498`（按 `record.id` 复用组件）。
- 现状：在待审批记忆上点"编辑"再点"保存并批准"，成功后记录变为已批准，组件按 id 复用，仍显示可编辑的文本框；保存和取消按钮只在待审批状态才有，这时只剩"作废"。
- 影响：用户看到一个能编辑却无法保存或取消的文本框。
- 建议：批准成功后退出编辑；非待审批状态不渲染编辑框。
- 验收：保存并批准后，卡片显示只读内容。

### 视觉

#### UX-54 默认主题下错误文字对比度不足

- 判定：已确认缺陷（按色值计算），视觉效果待实机。
- 位置：`desktop/styles.css:129`（VTRON 浅色 `--destructive: #ff6c35`）；`text-destructive` 在桌面与 Web 源码中共 139 处、82 个文件（不含测试）。错误横幅多用 `bg-destructive/5`（25 处）或 `bg-destructive/10`（16 处）作底色。
- 现状：`#ff6c35` 对页面背景 `#fcfcfc` 的对比度为 2.75:1，对 `/5` 底色为 2.62:1，`/10` 底色更低。WCAG AA 要求正文至少 4.5:1。
- 影响：几乎所有错误提示和危险按钮的文字都偏浅，在强光或视力不好时难以辨认。
- 建议：错误文字和危险按钮改用更深的红色，`#ff6c35` 可以只留给图标。候选值 `#bd3a48`：对背景 5.30:1，对 `/5` 底 4.92:1，对 `/10` 底 4.60:1，作为按钮底色配白字 5.44:1。最终色值由设计确认，见[待设计确认](#待设计确认暂不处理)。
- 验收：VTRON 浅色主题下，错误横幅、表单错误和危险按钮文字的对比度都不低于 4.5:1；其他主题回归。

### 连接原 Claude 终端（PR #125）

#### UX-55 连接码和安装命令不能复制，"检查连接"会清掉连接码

- 判定：已确认缺陷。
- 位置：`conv/features/sessions/claude-bridge-panel.tsx:171-173`（安装命令）、`:206-209`（连接命令与连接码），都只是可选中的文本；`:77-101`（状态检查的 effect 一开始就执行 `setChallenge(undefined)`）、`:191-197`（"检查连接"通过 `revision` 触发该 effect）、`:69-76`（`canManage` 依赖 `busy`、`controlReady`、`notice`、`live.status`，这些状态一变也会触发）。
- 现状：连接码和多行安装命令只能手动选中复制。生成连接码后点"检查连接"，或会话忙闲状态变化，连接码都会消失，需要重新生成。
- 影响：用户在终端和桌面之间来回操作时，连接码容易丢；手动复制多行命令容易出错。
- 建议：给安装命令、连接命令和连接码加复制按钮；"检查连接"只刷新状态；连接码只在过期、断开或连接成功时清除。
- 验收：生成连接码后点"检查连接"，连接码仍在；复制按钮可用，并有"已复制"反馈。

#### UX-56 连接失败时桌面端没有反馈

- 判定：已确认缺陷。
- 位置：`packages/claude-bridge-plugin/hooks/register.js:771-781`（失败时只在终端返回英文 "AgentKib could not connect. Generate a new ticket and check the CLI version and workspace."）、`:749-750`（命令说明里叫 "one-time ticket"）；桌面面板只在 `revision` 或 `connectionGeneration` 变化时刷新（`conv/features/sessions/claude-bridge-panel.tsx:77-101`）。
- 现状：在终端执行连接命令失败时（连接码过期、版本不符等），桌面面板没有任何变化。终端只有一句英文，而且把桌面上的"连接码"叫作 "ticket"。
- 影响：用户不知道失败原因，也不知道终端里说的 ticket 就是桌面上的连接码。
- 建议：桌面在连接码有效期内获取连接结果，失败时显示原因；终端文案和桌面用对应的叫法（如 connection code），并按失败类型给出下一步。
- 验收：用过期连接码连接时，桌面面板和终端都显示可理解的原因。

#### UX-57 不支持的平台或桥接启动失败时，面板不给原因

- 判定：已确认缺陷（缺少文案）；入口在 Linux、Windows 上是否出现待实机。
- 位置：
  - `packages/backend/src/claude-bridge.ts:202-203`：连接原终端只支持 macOS。
  - `packages/backend/src/claude-managed-read.ts:99-100`：Claude 托管支持 macOS 和 Linux。
  - `packages/backend/src/claude-bridge.ts:280-299`：状态原因可能是 `platform-unsupported` 或 `claude-bridge-unavailable`。
  - `conv/features/sessions/claude-connection-copy.ts:120-143`：这两个原因都没有对应文案。
  - `conv/features/sessions/claude-bridge-panel.tsx:158, 176-183`：面板本身没有平台判断，`supported` 为 false 时"生成一次性连接码"直接置灰。
  - `conv/features/sessions/session-composer.tsx:572-584`：输入区的入口按钮同样没有平台判断。
- 现状：在 Linux 上，Claude 托管可用，连接原终端不可用，但入口照常显示；打开后生成按钮置灰，没有任何说明。桥接启动失败时同样没有说明。
- 影响：用户不知道为什么不能用，也不知道该怎么办。
- 建议：不支持的平台上隐藏入口，或明确写"仅支持 macOS"；为 `platform-unsupported`、`claude-bridge-unavailable` 补文案。
- 验收：非 macOS 上不出现入口，或入口说明不可用原因；桥接启动失败时面板显示原因。

#### UX-58 Claude 会话横幅与实际状态不符

- 判定：已确认缺陷。
- 位置：`conv/features/sessions/session-reader.tsx:118-141`；`conv/features/sessions/claude-connection-copy.ts:6-10`；`packages/backend/src/claude-managed-read.ts:2682-2690`。
- 现状：
  - 交还原客户端后，后端状态是 `released`，执行模式仍是 `claude-managed`，横幅标题仍写"由 AgentKib 执行"。
  - 原终端断线时，标题写"仅查看历史"，正文却是"同步观察原 Claude Code 会话，可取消当前轮次……"。
- 影响：用户会误以为 AgentKib 仍在执行，或以为断线后还能取消当前轮次。
- 建议：横幅标题和正文按执行模式、状态、原因组合给出：`released` 显示"已交还原客户端"；断线时用已有的 `lost` 文案（"原终端连接已断开……"）。Web 同源副本同步修改。
- 验收：交还后、断线后，横幅文字和页头状态一致。

### 权限文案

#### UX-59 Web 访问权限文案只写 Codex，实际也控制 Claude

- 判定：已确认缺陷，基线已有。
- 位置：`desktop/features/remote/web-settings-copy.ts:43`（"允许新建与交接 Codex 任务"）；`conv/features/sessions/claude-handoff.ts:61`（Claude 交接同样要求 `device.manage`）。
- 影响：用户按字面理解只放开了 Codex，实际也允许远程设备交接 Claude 会话。
- 建议：改为"允许新建与交接任务（Codex、Claude Code）"，或按 Agent 分别说明；四种语言同步。

---

## P3

### UX-60 工作区细节

1. Doctor 修复应用后，"已应用 N 个文件的变更"（`ws/route.tsx:445-451`）和"修复已应用并重新检查……"（`desktop/features/workspace/WorkspaceDoctorPage.tsx:81-98`）两条提示叠在一起。建议合并。
2. 诊断里"目标 Agent 缺失"（`skill.target-missing`、`mcp.target-missing`）的处理入口跳到资产页（`desktop/features/workspace/doctor-manual-actions.ts:8, 23`；`ws/doctor.tsx:94-102`），但资产页既不显示也不能编辑目标 Agent（`ws/assets.tsx:112, 129, 242-245`）。指引文案只写"刷新诊断"，没提资产草稿要先审查并应用。建议指向能改目标 Agent 的位置，或改写指引。
3. "审查变更"禁用时，原因只在鼠标悬停的 `title` 里可见（`ws/route.tsx:96-111`）。按钮禁用后无法聚焦，键盘用户看不到原因（读屏有 `sr-only` 描述）。建议在按钮旁直接显示原因。
4. 生成过 Home 计划后，"包含 Home 配置"按钮没有"已包含"状态，仍可再次点击（`ws/changes.tsx:310-323`）。
5. 生成计划失败时只写全局横幅（`ws/route.tsx:323`、`ws/doctor.tsx:85`），和变更页内的就地错误不一致。
6. 会话交接启动失败后，侧栏显示"待审变更 1"（`desktop/routes/(main)/route.tsx:99-101`），概览却没有对应提示（`ws/index.tsx:217-226`）。
7. 变更页仍显示变更计划 ID 的前 8 位（`ws/changes.tsx:263-265`），对用户没有意义（UX-32 遗留）。
8. 工作区列表的空状态文案"选择上方'添加'，添加已有的本地项目目录。"读起来重复（`workspace.emptyText`，UX-38 遗留）。
9. Context 页的说明常驻（`ws/context.tsx:136-147`），没有草稿时也提示"请先审阅并应用变更"（`context.previewScope`，Q-01 遗留）。建议只在有草稿时显示后半句。
10. 待实机："查看现有条目"只把焦点移到一个没有焦点样式的行（`ws/assets.tsx:91-94, 236`），可能看不出反馈。
11. 待确认：Context 页要求 `scan.root` 与 `project` 严格相等（`ws/context.tsx:371-377`），不相等时一直显示骨架、不报错。后端两处都做了路径规范化，出现概率低。

### UX-61 资源库与 MCP 细节

1. 已安装包的卸载按钮没有指定变体，落到默认的实心主色底，再叠加红色图标（`desktop/routes/(main)/catalog.tsx:953-973`；默认变体见 `desktop/components/ui/button.tsx:11`）。建议改为危险样式的图标按钮，并加悬停提示。
2. "停止该服务的全部实例"会跨作用域停止，没有确认（`catalog.tsx:1028-1039`）。
3. MCP 列表中，停用的服务"编辑 / 创建覆盖"是实心主按钮（`desktop/features/mcp/McpManagementPanel.tsx:407-419`，基线是描边），比启用行的"探测"还重；编辑入口随启停在按钮和菜单之间移动（`:430-443`）。
4. 技能库卡片最多 6 个同级按钮；有更新时，"部署到…"和"更新"两个实心主按钮并列（`desktop/features/skills/SkillHubPage.tsx:861-934`）。
5. 部署处于冲突或共同基线状态时，菜单里的"更新部署"和主操作"审查冲突 / 确认基线"发出同一个请求（`desktop/features/skills/SkillManagerPanels.tsx:1191-1198` 与 `:1234-1244`），两个入口名字不同、效果相同。
6. "待同步 N 个"按钮带 `aria-pressed`，但再次点击不能取消筛选（`SkillHubPage.tsx:206-214, 528-538`）。
7. MCP 服务中心的"返回集成设置"按钮总是显示（`catalog.tsx:762-770`）。不是从设置进来的用户，"返回"说不通。建议改为"打开集成设置"。
8. Agent 页资产行的"打开技能管理"只打开资源库的技能页，不定位到对应技能或使用位置（`desktop/features/agents/AgentAssetsPanel.tsx:107-124`），aria-label 却带资产名。
9. Registry 搜索失败时，顶部错误条（`catalog.tsx:602-604, 778-786`）和列表内（`:895-909`）重复显示同一错误。
10. 待实机：MCP 错误条在高级区上方（`catalog.tsx:778-786`），卸载、停止、端口等操作在下方较远处，失败提示可能在视口外。

### UX-62 会话与 Web 细节

1. 不能发送时（包括已连接原终端的会话）仍显示"Enter 发送"提示（`conv/features/sessions/session-composer.tsx:436-438`），按 Enter 没有反应。建议不能发送时隐藏，或改为显示原因。
2. Antigravity 会话的输入框不支持 Enter 发送（`conv/features/sessions/session-reader.tsx:267-276`），和主输入框不一致（UX-01 遗留）。
3. 执行管理直接显示原始错误码（`conv/features/sessions/managed-tasks.tsx:234, 245, 386`，渲染在 `:421-424`）；工作区 Claude 面板也一样（`desktop/features/workspace/ClaudeSessionPanel.tsx:445, 616-618`）。建议映射成可读原因，错误码放进详情。
4. 恢复提示让用户"关闭并重新打开执行管理"（`conv/features/sessions/managed-control-copy.ts:60-61`），但执行管理只是"会话操作"对话框里的一节，没有单独入口。建议改为"重新打开会话操作"。
5. Web 配对码模式下，错误提示仍称"授权码"（`web/features/connection/pairing-error-copy.ts:5, 10`），配对页称"配对码"（`web/features/conversation/i18n/index.ts:20-21`）（UX-21 遗留）。
6. Web 访问设置有未保存的更改时，同一句保存提示出现两次（`desktop/features/remote/WebAccessSettings.tsx:325` 与 `:523-527`）（UX-28 遗留）。

### UX-63 连接原 Claude 终端的细节

1. 已连接原终端后，输入区按钮仍叫"连接原 Claude 终端"（`conv/features/sessions/session-composer.tsx:572-584`，条件只排除了 `claude-managed`）。
2. 面板显示的"Claude Code 2.1.301"是要求的版本常量（`packages/runtime-protocol/src/claude-bridge.ts:4`，经 `packages/backend/src/claude-bridge.ts:285` 返回），不是本机安装的版本（`conv/features/sessions/claude-bridge-panel.tsx:166`）。建议写成"需要 Claude Code 2.1.301"。
3. 没有"连接码只用于自己的终端，不要发给他人"之类的提示（`claude-bridge-panel.tsx:201-214`）。
4. 未连接时"断开"也能点，断开前没有确认（`claude-bridge-panel.tsx:59-68, 184-190`）。建议未连接时禁用，并说明断开后原终端照常运行、AgentKib 停止同步。
5. 已连接原终端时，执行管理整段隐藏交接操作（`conv/features/sessions/managed-tasks.tsx:574, 587`），只显示"此会话尚未交给 AgentKib"，不提示需要先断开连接。
6. 已连接原终端的会话，页头状态是"仅可查看"（`conv/features/sessions/session-display-state.ts:192-197`），横幅却写"可取消当前轮次"。`docs/development/ui-terminology.md` 也要求不要把这类状态统一写成"仅可查看"。

### UX-64 首页残留的旧叫法（2026-10-17 补充）

- 实施状态：已修复，见文末“UX-64 补充实施记录”。

设计稿对比时发现，补充在"本轮实施记录"之后，那批修改没有覆盖这两处；补充时工作区里四种语言仍是原文案。

1. 待处理事项为空时，按钮叫"查看上下文健康"（`desktop/features/home/HomeTaskCards.tsx:185-190`，`home.openDoctor`），导航和术语表都叫"诊断"。这个按钮只打开第一个工作区（有警告的优先）的诊断页，有多个工作区时看不出是哪一个。建议改为"查看诊断"；有多个工作区时写出工作区名称。
2. 最近活动为空时提示"例行发现记录已收纳到'设置 > 审计记录'"（`desktop/features/home/HomeRecentSections.tsx:42-45`，`home.noImportantActivityText`），但设置里没有叫"审计记录"的入口：这份记录在 设置 → 诊断，标题是"本地审计活动"（`activity.title`）。建议写成实际路径"设置 > 诊断 > 本地审计活动"，四种语言同步（英文现为 "Settings > Audit records"，标题是 "Local Audit Activity"）。

---

## 待设计确认（暂不处理）

以下来自设计稿评审，等设计确认后另行通知，现在不需要改：

| 项 | 现状 | 位置 |
|---|---|---|
| 首页面包屑 | 显示"工作区 / 今日任务"，但今日任务不属于工作区 | `desktop/routes/(main)/route.tsx:116-120` |
| 首页"立即修复" | 实际只打开诊断页，不会修复 | `desktop/features/home/HomeTaskCards.tsx:149` |
| 首页"刷新" | 摘要条里的"刷新"是蓝色主按钮 | `desktop/features/home/HomeSummaryBar.tsx:62` |
| 次要文字颜色 | VTRON 的 `--muted-foreground` 与正文同为 `#0e142b`，次要文字没有层级 | `desktop/styles.css:126` |
| 错误色取值 | 见 UX-54 | `desktop/styles.css:129` |

---

## 本轮确认有效的改进（修复时请保持）

- 全局错误横幅可以关闭，换页后旧消息失效（`desktop/features/app/AppMessageBanner.tsx`、`usePageMessageScope.ts`）。
- 首页引导卡按引导状态推进，不再在添加工作区后消失；设置里可以重新显示。
- 计划与草稿绑定，应用后回读会保留应用期间的新编辑（`desktop/features/workspace/workspace-store.ts:98-116`）。
- Enter 发送已排除输入法组合输入。
- 应用成功后能看到本次 Diff 快照和备份目录。
- Doctor 中只能手动处理的问题有说明和处理入口。

---

## 建议修复顺序

1. **UX-46**：改动小、风险高，改完需要在手机上验证。
2. **UX-47、UX-48、UX-49、UX-50**：都在工作区计划的生命周期里（`workspace-store.ts`、`ws/route.tsx`），建议一起改、一起补测试。
3. **UX-55–UX-58 与 UX-19 剩余部分**：连接原终端的状态与反馈。建议先列出"执行模式 × 状态 × 原因"对应的标题和正文，再改横幅和面板。
4. **UX-51、UX-52、UX-53**：资源库，三项相互独立。
5. **UX-59、UX-07、UX-30**：文案，按 `docs/development/ui-terminology.md` 统一。
6. **UX-54**：等设计确认色值后，统一改主题变量。
7. **UX-08、UX-25、UX-45 剩余部分**，以及 P3 细节。

---

## 覆盖范围与限制

- 只读源码，没有启动应用、运行测试或实机操作。视觉、焦点、手机键盘和 Windows/Linux 上的行为都标为"待实机"。
- 上一轮 50 项逐条复查。新问题集中在这批改动涉及的页面和 PR #125 的连接流程；Git 页内部、额度和洞察页只做了抽查。
- 繁体中文和日文只用脚本核对了键和占位符是否一致，没有逐条审译文。
- 对比度按 WCAG 2.x 的相对亮度公式计算；横幅底色按 `bg-destructive/5`、`/10` 叠加在 `#fcfcfc` 上估算。

---

## 本轮实施记录（2026-10-17）

以上问题描述保留复查时的基线事实，本节记录随后实施的修改。

| 范围 | 实施结果 |
|---|---|
| UX-46、UX-62.1–2 | 两端粗指针设备 Enter 换行；桌面 Enter 发送并保留 IME 保护；不可发送时隐藏快捷键提示；Antigravity 输入区同步快捷键及会话隔离的提交锁。 |
| UX-47–50 | 仅普通计划随草稿编辑/放弃而失效，保留 Doctor 和交接计划；重扫采用无草稿时的磁盘新版本，真实草稿与磁盘冲突时提供选择，并保护确认期间的新编辑；过时计划就地提示重新审查；新计划及离开/切换工作区清除旧应用反馈。 |
| UX-55–58、UX-19、UX-63.1–6 | 连接命令、连接码可复制；检查及忙闲转换保留连接码；轮询连接结果并展示具体失败原因；不支持的平台和桥接启动失败有说明；按执行模式、状态、原因区分待交接、观察连接、断线和交还；明确版本要求、连接码用途、断开后果及先断开再交接。已有连接先断开后才能生成新码。 |
| UX-51–53 | 消费一次性定位参数；按资源库分区处理数据源失败并保留分区导航；记忆批准成功后退出编辑。 |
| UX-59、UX-07、UX-30、UX-62.3–6 | 四语统一交接、MCP、诊断、授权扫描目录等术语；权限说明覆盖 Codex/Claude；错误原因改为可读文案，技术码折叠展示；恢复入口和配对码文案匹配真实操作；移除重复保存提示。 |
| UX-08、UX-25、UX-45 | 交接应用成功也保留已写入文件的查看入口；已安装 MCP 列表说明通过 Registry 搜索检查更新；两端输入区和 Web 登出按钮达到 44px。 |
| UX-60.1–9 | 合并 Doctor 应用与复查提示；缺失目标 Agent 指引手动修改 manifest；就近显示禁用原因；Home 计划显示已包含；计划失败就地反馈；概览提供交接恢复入口，结果未知时不声称已应用；移除计划 ID；精简空状态文案；仅有草稿时显示 Context 应用提醒。 |
| UX-61.1–9 | 危险操作样式及停止全部作用域确认；固定 MCP 编辑入口；技能次要操作收进菜单，去掉重复部署动作；待同步筛选可取消；设置及技能库入口名称与实际目的匹配；Registry 错误去重。 |

有对应组件的会话行为、状态及文案已同步桌面和 Web；资源库、工作区配置管理及本机终端桥接没有对应的 Web 管理页面。

保持未处理：UX-54 及“待设计确认”表内全部事项；UX-60.10–11、UX-61.10 的待实机/待确认部分；撤销和独立 MCP 更新检查仍按原计划作为后续增强。没有修改主题颜色、权限策略、依赖或持久化结构。

验证记录：

- 新增/更新回归测试覆盖粗指针 Enter、IME、Antigravity 跨会话异步提交、四语 Claude 状态矩阵、桥接复制及失败轮询、工作区刷新冲突/计划生命周期、资源库分区失败、记忆审批编辑状态、危险操作确认和技能菜单交互。
- 工作区及相邻导航：18 个文件、274 个用例通过；资源库相关：30 个文件、411 个用例通过。
- 最后一次桌面集成、Claude 面板、错误详情及源码约束回归：4 个文件、140 个用例通过。
- 桌面定稿全量（包括后端测试）：`cd apps/desktop && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，349 个文件通过、1 个文件跳过；6486 个用例通过、3 个用例跳过，退出码 0。首轮的 4 个文件系统持久化超时用例在默认 5 秒预算下独立复测通过，本次完整复跑也全部通过，未修改超时配置。
- Web 定稿全量：`cd apps/web && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，57 个文件、1108 个用例通过。
- 桌面 `tsc -b`、Web `tsc --noEmit`、后端 `tsc --noEmit` 通过；桌面和 Web 的 Vite 生产构建、后端构建及原生依赖 staging 通过。
- `oxfmt --check`、`git diff --check`、四语键/占位符一致性检查通过；项目 `oxlint` 退出码为 0，有 warning、无 error。
- 本机配置的 pnpm 12.10.1 启动文件损坏，因此测试和构建直接调用现有安装中的 Vitest、TypeScript、Vite 与脚本，未安装或升级依赖。
- 没有执行 iOS Safari、Android Chrome 或其他操作系统的实机验收；手机软键盘、视觉和真实设备表现仍需按原验收条件确认。

## UX-64 补充实施记录（2026-10-17）

- 首页空待办入口统一为“查看诊断”；有多个工作区时，按钮正文包含实际目标工作区名称。显示名称与点击回调共用同一个目标，保持原有的优先选择及导航逻辑。
- 最近活动空状态改为实际路径“设置 > 诊断 > 本地审计活动”；简体中文、繁体中文、日文、英文同步。
- 新增四语单/多工作区按钮、目标优先级、无工作区、即时切换语言的行为测试；补充四语空活动说明与真实设置导航、诊断页审计标题一致性的渲染测试，并更新首页集成测试。
- 验证命令（`apps/desktop`）：`node node_modules/vitest/vitest.mjs run src/features/home src/core/i18n.test.ts src/core/useI18n.test.tsx src/test/ui-source-constraints.test.ts 'src/routes/(main)/-home-actions.test.tsx'`；10 个文件、66 个用例全部通过。
- `node node_modules/typescript/bin/tsc -b --pretty false`、本次文件的 `oxfmt --check` 与 `oxlint`、`git diff --check` 通过；定向 lint 无 warning、无 error。
- 本次未修改“待设计确认”事项。

提交前复核：以 `0e02f6a49` 为比较基线，项目约定、QA 需求以及 Claude 连接流程的只读检查未发现阻止提交的明确问题；再次运行上述 66 个首页相关用例、桌面 TypeScript、格式、lint 和差异检查均通过。本轮仅提交 UI/UX 修复（包括 UX-64）、相关测试与本 QA 记录；已有的 `.agents/`、`prototypes/` 不纳入，不推送。

## PR #127 审查修复记录（2026-10-17）

用户随后授权推送并创建 PR #127，并要求按 Standards / Spec 两轴独立审查，修复后复查至无可操作发现。比较基线为 `0e02f6a49ceaa70dd913de144194f1d77eba9e6c`。

第一轮审查及修复过程中确认并修复 6 处问题：

- UX-48：缓存工作区草稿时同时缓存原磁盘基线；切换后返回、从资源库打开及全局刷新均使用该基线检查外部冲突。读取失败保留基线，应用、放弃及清理草稿时同步更新缓存。回归覆盖加载磁盘/保留草稿、磁盘未变以及旧确认晚到。
- UX-08：未知结果的交接保留原差异快照，后端核对成功后显示已应用文件与 Diff。离开页面后返回仍可恢复；核对失败不会提前显示成功，也不会重发原应用请求；新请求、新计划及切换工作区清除过期快照。
- UX-57：旧配对请求在换码、撤销或新配对成功后失败时，不再覆盖当前连接反馈。错误归属于当前 challenge，现有身份、过期及核对校验保持有效。
- UX-63.4–5：主机可访问、原终端已离线但仍有 follower 绑定时，可以撤销绑定后交接；没有绑定或属于其他会话时仍不可撤销。
- UX-58、UX-63.6：区分客户端到主机断线与原终端断线；结果未知优先提示待确认，避免误报原终端已断开。桌面和 Web 的简中、繁中、英文、日文同步。
- UX-55：复制操作按会话代次及请求顺序校验反馈，旧复制结果不再污染切换后的会话或覆盖后续复制。成功/失败、切换会话/重叠请求 4 条回归先复现失败，再通过修复验证。

定向验证：工作区及导航 4 文件 / 111 用例；交接应用及恢复 3 文件 / 42 用例；Claude 桥接及桌面状态 3 文件 / 68 用例；Web 横幅及 Claude 同源校验 2 文件 / 45 用例；资源库入口 1 文件 / 17 用例，均通过。

修复后的完整验证（包含 UX-64 及本次审查修改）：

- 桌面：`cd apps/desktop && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，350 个文件通过、1 个文件跳过；6527 个用例通过、3 个用例跳过，退出码 0。
- Web：`cd apps/web && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，57 个文件、1108 个用例全部通过，退出码 0。
- 桌面：`node node_modules/typescript/bin/tsc -b --pretty false`；Web 和后端：`node node_modules/typescript/bin/tsc --noEmit --pretty false`，均通过。
- 桌面和 Web：`node node_modules/vite/bin/vite.js build`，均通过；桌面后端构建及 staging：`node scripts/stage-claude-bridge.mjs && node node_modules/vite/bin/vite.js build --config vite.backend.config.ts && node scripts/stage-backend-native.mjs`，通过。
- 本次 22 个源码/测试文件的 `oxfmt --check`、`git diff --check` 通过；`node_modules/.bin/oxlint apps/desktop/src apps/desktop/electron packages/backend/src` 退出码 0，有 warning、无 error。
- 第二轮两轴独立审查覆盖原 PR 和本次修复，最终 Standards：0 finding；Spec：0 finding。审查为源码及测试只读检查，自动化执行结果由上述完整验证提供。

待设计确认项及原有实机验收限制保持原状态；没有新增依赖或持久化结构变更，未纳入 `.agents/`、`prototypes/`。

## PR #127 再次查漏与修复记录（2026-10-17）

对 `0e02f6a49…d0aa43642` 再次独立审查确认 3 处遗漏，用户授权修复、补测并更新同一 PR。本节补充上一轮检查的覆盖盲点。

- UX-52 部分漏修：工作区列表首次失败或挂起时，技能库、发现及 MCP 全局管理仍被阻断。现将查询错误提示与正文必需数据分别处理；独立功能保持可用，保留工作区错误、真实重试和四语提示，工作区选项随数据恢复。依赖工作区或目录的其他分区仍保留原门控。新增真实路由测试使用实际技能/MCP 组件，覆盖个人部署、全局 MCP、四语重试恢复、缓存刷新失败及交互状态保持。
- Claude 交接回归：取得检查指纹后，唯一的检查入口被隐藏，原终端更新历史后只能反复提交过期指纹。现保留四语“重新检查原会话”入口；重新检查清除原确认、串行读取新指纹，检查期间不能提交交接。检查失败可重试，未知结果的 pending、权限、连接及压缩门控保持有效。测试覆盖历史变化、普通刷新、重新检查与新指纹交接，以及失败恢复和未知结果保护。
- Claude 换码反馈竞态：生成新码/断开开始时，使此前状态查询失效；旧成功、连接错误、请求异常及加载收尾均不能改写新操作的状态。失效旧查询尚未返回时，后续轮询仍可继续。新增 10 条真实面板回归，覆盖旧状态在新码响应之前/之后到达等顺序。

平台与语言：这三个本机管理入口没有对应的 Web 管理页面；Web 和桌面会话操作已有关闭重开后重新获取指纹的流程，两端均补四语回归，验证新指纹、确认重置及未知结果门禁。新增面板按钮同步简中、繁中、英文、日文；资源库复用现有四语查询反馈；轮询修复没有新增文案。

定向验证：资源库及相邻组件 6 文件 / 137 用例；本地 Claude 面板 1 文件 / 84 用例；原终端桥接及相邻行为 6 文件 / 169 用例；桌面与 Web 共享交接反馈各 1 文件 / 48 用例，均通过。资源库、面板指纹和旧轮询反例均先在修复前复现，再验证修复；没有放宽断言或超时。

最终验证：

- 桌面：`cd apps/desktop && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，351 个文件通过、1 个文件跳过；6564 个用例通过、3 个用例跳过，退出码 0。
- Web：`cd apps/web && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，57 个文件、1116 个用例全部通过，退出码 0。
- 桌面 `node node_modules/typescript/bin/tsc -b --pretty false`；Web 和后端 `node node_modules/typescript/bin/tsc --noEmit --pretty false`，均通过。桌面和 Web 的 `node node_modules/vite/bin/vite.js build` 均通过。本次未修改后端生产代码，未重复后端打包与原生 staging。
- 本次 9 个源码/测试文件的 `oxfmt --check`、定向 `oxlint`、`git diff --check` 通过；项目 `node_modules/.bin/oxlint apps/desktop/src apps/desktop/electron packages/backend/src` 退出码 0，有既有 warning、无 error。
- 修复后两轴独立审查完整 PR 与本次改动，Standards：0 finding；Spec：0 finding。Spec 审查另外独立运行桌面 5 个目标文件，196 个用例全部通过。

本次继续不处理待设计确认项、待实机/待确认部分及后续增强，不新增依赖、公共协议或持久化结构，不合并 PR。

## PR #127 继续 goal 查漏记录（2026-10-17）

用户要求继续防遗漏审查。本轮以 `0e02f6a49` 为固定比较基线，重新审查完整 PR，并对 `bcbb7bb78` 之后的修复进行独立 Standards / Spec 复核，补齐两类交接边界：

- UX-63.5、UX-07：工作区本地 Claude 面板此前把原终端 follower 当作可交接会话；实际检查只返回连接状态、不返回交接指纹，反复点击也没有下一步提示。现显示四语“先断开连接”，指向会话页实际的“管理原终端连接”及“断开”操作，隐藏并阻止交接/交还入口，保留已验证的发送与停止能力。本机工作区面板没有对应 Web 页面；共享会话面板的四语断开前提保持一致。
- Claude 交接证明的所有权边界：本地面板以及桌面/Web 共享会话操作在执行模式、连接代次或交还状态变化后清除旧指纹和确认，旧只读检查晚到也不能重新生效。尤其 `claude-managed` 在接管/交还时模式不变、没有连接代次，现单独跟踪 `released` 边界。共享面板拆开工具选项加载和只读检查，重新核验历史不会重置工具选项；已发出的命令、未知结果及持久化回执继续使用原有生命周期，不会因所有权变化解锁或重发。

回归证据：本地 follower 相关新增 11 例先失败后通过；共享面板每端 7 条旧证明/重新取证明反例先失败，另补未知结果锁定保护；独立终审进一步确认本地同模式交还状态的 3 条反例先失败，并补连接代次保护。最终本地面板 99 例、桌面与 Web 共享交接反馈各 56 例通过，覆盖四语前提、真实新指纹、迟到成功/失败、发送/停止能力及未知结果门禁。

最终验证：

- 桌面最终快照：`cd apps/desktop && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，351 个文件通过、1 个文件跳过；6587 个用例通过、3 个用例跳过，退出码 0。此前首轮全量 6583 例通过；本次完整复跑包含终审最后补充的 4 条本地边界回归。
- Web：`cd apps/web && node node_modules/vitest/vitest.mjs run --maxWorkers=2`，57 个文件、1124 个用例通过，退出码 0。
- 桌面 `node node_modules/typescript/bin/tsc -b --pretty false`；Web 和后端 `node node_modules/typescript/bin/tsc --noEmit --pretty false`，均通过。桌面和 Web 的 `node node_modules/vite/bin/vite.js build` 均通过。本轮未修改后端生产代码，未重复后端打包与原生 staging。
- 最终 6 个源码/测试文件的 `oxfmt --check`、`git diff --check` 通过；定向 `oxlint` 及项目 `node_modules/.bin/oxlint apps/desktop/src apps/desktop/electron apps/web/src packages/backend/src` 退出码 0，有 warning、无 error。
- 两轴独立终审覆盖完整 PR 及本轮修复，包含最后补充的本地交还状态边界；最终 Standards：0 finding，Spec：0 finding。Spec 终审独立执行 11 个测试文件、345 个用例全部通过。

本轮继续不处理待设计确认项、待实机/待确认部分及后续增强；不新增依赖，不修改后端执行权校验、公共协议或持久化结构，不合并 PR。

## PR #127 新一轮独立审查记录（2026-10-17）

以 `main@0e02f6a49` 到 `e8b44b4e4` 的完整 98 文件差异重新开展 Standards / Spec 独立审查，另行深查连接与会话异步边界。本轮没有沿用上次的无发现结论；确认并修复 1 项遗漏：

- UX-50：从侧栏进入设置时，按现有约定保留工作区选择、草稿与计划；返回同一工作区又走提前返回分支，因此旧的“已应用”反馈没有失效。现于实际路由离开工作区视图时清除 `appliedChanges`，覆盖设置往返及直接进入资源库/会话页；同一工作区内部导航仍保留反馈。不调用放弃草稿流程，不清除计划和交接恢复请求。
- 平台与语言：工作区管理及应用反馈没有对应的 Web 页面，没有新增用户文案；新增四语设置往返回归验证语言无关的状态失效逻辑，原有 Web 会话功能继续回归验证。
- 新增 7 条回归：四语设置往返 4 条、直接离开工作区 2 条、工作区内导航保持 1 条。旧实现先出现 6 例失败、1 例通过；修复后导航及相邻工作区流程 4 个文件、77 个用例通过。
- 修复后两轴独立终审，Standards：0 finding；Spec：0 finding。Spec 终审另独立执行导航、工作区加载与应用恢复 5 个文件、102 个用例，全部通过；连接边界独立执行桌面 7 文件 / 281 用例和 Web 4 文件 / 108 用例，全部通过。

最终验证：

- 桌面：`cd apps/desktop && node node_modules/vitest/vitest.mjs run --maxWorkers=4`，351 个文件通过、1 个文件跳过；6594 个用例通过、3 个用例跳过，退出码 0。
- Web：`cd apps/web && node node_modules/vitest/vitest.mjs run --maxWorkers=2`，57 个文件、1124 个用例通过，退出码 0。
- 桌面 `node node_modules/typescript/bin/tsc -b --pretty false`；Web 与后端 `node node_modules/typescript/bin/tsc --noEmit --pretty false`，均通过。桌面和 Web 的 `node node_modules/vite/bin/vite.js build` 均通过；本轮未改后端生产代码，未重复后端打包与原生 staging。
- 本轮 2 个源码/测试文件的 `oxfmt --check`、`git diff --check` 通过；定向 `oxlint` 和项目 `node_modules/.bin/oxlint apps/desktop/src apps/desktop/electron apps/web/src packages/backend/src` 退出码 0，有 warning、无 error。

本轮继续不处理待设计确认项、待实机/待确认部分及后续增强；不新增依赖、公共协议或持久化结构，不合并 PR。
