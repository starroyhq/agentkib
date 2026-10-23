# v15 E2：工作区诊断与变更计划

E2 实现、四语真实 Electron 沙盒交互和截图已经完成；追加定位并修复合成 Claude 启动恢复夹具的就绪竞态后，完整相关组合 3042 项、默认并发桌面全量 8526 项通过，分别保留 2 / 3 项既有跳过。此前 Web 全量、两端构建及本次类型、lint、格式检查通过，最新结果见末尾“Claude 启动恢复测试超时定位与修复”

## 范围与基线

- 基线：最新 `main` 的 `f0d0329d7d39e13ab678ec04854926d364d5662c`；分支 `codex/v15-e2-workspace-plans`，独立工作树
- 先读本机 `designs/agentkib-v15-handoff.md` 的共同约束及 E2，设计依据为 3-3、3-4 预览和修订计划的诊断、配置修改流程；`designs/` 只读，不复制、不修改、不提交
- 只实施 E2：诊断页、普通工作区配置及诊断修复的变更计划，以及 E 合入后遗留的会话来源提示、重试样式、页头注意徽标和概览分隔点
- 保留原工作区及其他工作树的无关文件，本批没有新增依赖或修改锁文件
- 不改跨 Agent 继续、`handoff.*`、Codex follower、协议或权限；相关旧页面和入口保留

## 实施结果

### 诊断页

- 从上到下改为一行汇总、问题列表、默认折叠的各 Agent 检查结果；汇总显示警告、错误、自动修复数量和检查时间，右侧使用次要按钮“重新诊断”
- 非零警告使用 warning 色，零值使用次要文字；没有报告或读取失败时不伪造“0 个警告 / 0 个错误”，显示“未诊断”和原错误
- 问题标题优先列出真实文件名，保留 `CLAUDE.md`、`AGENTS.md` 大小写；完全重复的共享正文不再只挂在一个 Agent 名下
- 影响按已知诊断类型映射为当前语言，修复建议与“审查变更”进入原修复计划；手动项保留上下文、技能或 MCP 检查动作
- 相关文件用可信路径显示上下文缩写为 `~/…`；完整路径、后端原文、Agent 归属及校验依据置于可展开详情，未丢弃证据
- “打开所在文件夹”仅在证据路径位于当前工作区时显示，严格检查目录分隔符边界，支持 Windows 驱动器、大小写及反斜线，拒绝遍历和 NUL；实际操作将文件安全转换到所属目录，继续经原受控存储接口及后端目录校验，失败进入当前工作区的错误提示
- “只支持诊断”等信息项默认折叠；矩阵默认折叠并汇总 Agent、正常、需处理数量，展开后只给异常格着色，不再显示 `actual / expected` 数值比。不适用格按设计以浅色“正常”展示，原始状态保留在辅助属性和提示中
- 保留诊断成功摘要回传、加载 / 错误 / 重试、修复失败恢复及已应用提示逻辑

### 变更计划

- 顶部说明生成计划时草稿的实际共享指令增删及其他配置修改，不用当前可能已更新的草稿反推旧计划；诊断修复计划另用修复说明
- 文件按共享项目指令、各 Agent 配置同步、AgentKib 记录分组，默认展示第一个实际改动的非记录文件，长路径视觉截断并保留完整提示
- 保留原文件风险值、高风险说明、全局配置授权与 Claude 原生配置操作说明；“包含全局配置”保留现有操作，补充 OpenClaw、Hermes 需要的说明
- 差异只突出新增和删除行；仅折叠已可靠识别的 manifest 自动校验映射，用户内容、未知 Agent、结构含混或非生成字段保持可见
- 文件列表和差异区各自滚动，操作栏不随文件内容滚出页面；“拒绝”和“应用 N 个变更”保留原动作，实际 1360×860 首屏已验证应用按钮完全可见
- 生成中、计划失效、磁盘冲突、已应用互斥呈现；生成期间资产编辑只读，失效或冲突时禁用应用，保留重新生成及磁盘 / 草稿两种冲突处理
- 应用前及等待诊断后复核当前工作区、计划对象身份和失效状态，并继续由后端执行磁盘 manifest 与其他目标文件的原指纹、权限及备份检查；不把未知错误泛化成可安全应用
- 已应用提示整合文件数量、重新诊断及新增问题，固定保留当时草稿和基线快照，后续草稿编辑不改写历史摘要；文件区使用“本次变更的文件”，不再出现未来写入、拒绝或再次应用动作，保留返回、查看本次变更、关闭、开始新计划和离开工作区的生命周期

### E 合入后的四处收尾

- 会话总目录将同一批不可读来源合并到顶部一条完整提示，跨工作区不再重复；多个 Agent 合并点名，保留主机 / Agent 筛选语义及来源是否曾被使用的状态判断
- 重试使用 `text-primary-text` 链接色并保留刷新中禁重复点击；工作区自己的会话页仍保留现有一条来源提示
- 工作区页头需关注徽标沿用列表的图标大小和间距
- 概览共用资产各项尾部保留分隔点，换行时不让 `·` 独占新行行首；英文和日文实际窗口已验证第四项折行，分隔点留在上一项末尾

## 生成内容兼容性与后端修复

### 完全重复正文导入

原 `defaultManifest` 会将项目 `AGENTS.md` 的共享正文和完全相同的 `CLAUDE.md` 正文再次作为 Claude override 导入，之后生成文件时又把同一段内容接在共享引用后。本批仅在两者 `trim()` 后完全相同时省略该重复 override；独立 Claude 内容及只部分相同的正文完整保留，不做模糊删重

新增回归保留了未托管 Grok 完全重复诊断、原始备份内容和文件外部修改后的 `managed.drift`，没有通过关闭诊断来消除重复问题

### DeepSeek Harness 的显式兼容提示

本批选择交接文档允许的“应用前提前说明”路径，没有改变 DeepSeek Harness 的实际读取规则，也没有隐藏应用后的真实警告

- 计划根据本次将写入的项目 `CLAUDE.md` 是否含独立 `@AGENTS.md` 行，提前显示四语兼容说明
- 简体说明为“DeepSeek Harness 不解析 CLAUDE.md 中的 @AGENTS.md 引用，应用后仍会报告兼容性警告”
- 诊断仍保留 `context.warning`，原始证据为 `DeepSeek Harness reads @AGENTS.md in CLAUDE.md as literal text, not as a Claude Code import`
- 诊断主说明按四语解释“读取的是引用文字，不会导入指令”，英文证据仅放在详情；已应用提示如实列出复查中新出现或仍存在的问题
- 自动化已验证真实生成 → 应用 → 诊断后该警告仍存在，外部修改仍会产生漂移警告；真实应用窗口的干净流程已经复验，见最终截图与诊断前后证据

这表示兼容限制已经提前告知，**不表示 DeepSeek Harness 兼容问题已被消除**，也不表示本批改变了跨 Agent 继续

## 四语与桌面 / Web 边界

- 新增诊断、计划和已应用说明使用局部四语字典，覆盖 `zh-CN`、`zh-TW`、`en-US`、`ja-JP`；真实 locale 组件回归覆盖标题、建议、操作及兼容说明，不以键数量相同代替实际渲染
- 文件名、用户共享指令、Agent 正式名称、诊断原文、原始路径及协议字段保留真实内容，不参与术语替换
- 新增文案不带段尾句号，保留段内标点、说明中的独立命令和真实文件正文；本批复用的手动处理指引已按折叠详情的位置更新，见下节
- `docs/UI-TERMINOLOGY.md` 增补重新诊断、文件用途分组、互斥状态、风险 / 备份 / 复查含义，以及 DeepSeek 提前说明边界
- 桌面提供工作区管理、诊断和变更计划；现有 Web 没有对应管理页，本批不新增 Web 诊断或计划路由，不复制桌面管理操作。共用后端修复和原安全规则继续保留，Web 全量 1492 项及两种前端构建通过

## 安全与验收环境

- 不修改锁、指纹、版本、平台、权限、全局配置授权、发送前占用校验和未知结果保护；“可自动修复”只说明可生成计划，不表示跳过审查或直接写入
- 不修改跨 Agent 继续、交接文件、工作区续接、`handoff.*`、Codex follower 或 `designs/`
- 小套件通过统一工具包装器固定 pnpm 12.10.1，隔离 `HOME`、`CODEX_HOME`、`CLAUDE_CONFIG_DIR`、`AGENTKIB_BENCHMARK_DATA_DIR`、`AGENTKIB_BENCHMARK_USER_DATA` 及临时目录；没有新增依赖、放宽断言或延长测试预算
- 真实 UI 验收使用合成数据沙盒，不登录、不使用真实账户或真实会话；实际以 Seatbelt 阻断非回环外网、真实个人配置和密钥目录读取，Electron 额外禁止外部导航、外部应用和 Keychain 操作；对测试地址 `203.0.113.1` 的外连返回 `EPERM`，模型请求数为 0
- 截图前核对姓名、真实用户名、本机仓库路径、局域网地址和凭据均未出现；记录只使用示例工作区与 `~/projects/…` 展示路径

## 已完成的针对性验证

以下结果是独立运行的小套件，存在相邻覆盖，不累加为全量测试通过数

| 验证                              | 实际命令 / 覆盖文件                                                                                                                                                                                                                                                                                   | 结果                                                                      |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 诊断 UI 与展示 helper             | `pnpm --filter @agentkib/desktop exec vitest run --project=desktop src/features/workspace/doctor-presentation.test.ts src/features/workspace/WorkspaceDoctorPage.e2.test.tsx src/features/workspace/WorkspaceDoctorPage.test.tsx`                                                                     | 3 文件，70/70 通过；31 项 helper、12 项新 UI、原有 27 项全部保留，1.20 秒 |
| 会话来源与概览完整相关组合        | `pnpm --filter @agentkib/desktop exec vitest run --project=desktop src/features/sessions/SessionSourceNotices.test.tsx src/features/sessions/SessionDirectory.test.tsx 'src/routes/(main)/workspace/$workspaceId/-overview-pending.test.tsx' src/features/workspace/WorkspaceSessionsPage.test.tsx`   | 4 文件，93/93 通过，2.45 秒；含工作区会话原有 39 项                       |
| 真实生成内容与原上下文 / 合并保护 | `pnpm --filter @agentkib/desktop exec vitest run --project=desktop test/workspace-plan-instructions.test.ts test/claude-context-resolution.test.ts test/config-merge.test.ts`                                                                                                                         | 3 文件，48/48 通过，5.89 秒；新文件 6 项                                  |
| 计划视图、术语和空计划边界        | `pnpm --filter @agentkib/desktop exec vitest run --project=desktop src/features/workspace/WorkspacePlanView.test.tsx src/features/workspace/WorkspaceTerminology.test.tsx 'src/routes/(main)/workspace/$workspaceId/-changes-empty.test.tsx' src/features/workspace/change-plan-presentation.test.ts` | 4 文件，37/37 通过，3.63 秒；View 14、术语 4、空计划 15、helper 4         |
| E2 计划路由安全                   | `pnpm --filter @agentkib/desktop exec vitest run --project=desktop 'src/routes/(main)/workspace/$workspaceId/-changes-e2.test.tsx'`                                                                                                                                                                   | 1 文件，14/14 通过，3.02 秒                                               |
| 诊断页 5 文件定向 lint            | `pnpm exec oxlint` 后接诊断页、两个页面测试及 `doctor-presentation.ts/.test.ts`                                                                                                                                                                                                                       | 0 warning、0 error                                                        |
| 诊断页 5 文件定向格式             | `pnpm exec oxfmt --check` 后接上述 5 文件                                                                                                                                                                                                                                                             | 通过                                                                      |
| 后端修复与新增测试格式            | `pnpm exec oxfmt --check packages/backend/src/default-manifest.ts apps/desktop/test/workspace-plan-instructions.test.ts`                                                                                                                                                                              | 通过                                                                      |
| 本批所核对 diff 的空白检查        | `git diff --check`                                                                                                                                                                                                                                                                                    | 整批通过                                                                  |

先红后绿证据：诊断最初 7 项 helper 通过、6 项新 UI 失败；无报告误报零问题、越界 reveal、文件优先标题和自动修复建议均先出现目标断言失败，再完成实现。后端新增 6 项首次 2 失败 / 4 通过，修复后相关 48 项全过。未通过删除原测试、调整预算或弱化安全断言获得通过

`WorkspaceChangeDiff.test.tsx` 的 5 项四语 / 校验信息折叠回归在此前 3 文件 21 项计划 UI 组合中通过；以上局部结果保留为实施过程证据，最终相关组合以源码冻结后的 705 项验证为准，不累加重复覆盖

### 四语手动指引补核（2026-10-24）

诊断手动处理的 12 个既有 `doctor.manual.*` 键在四语中同步更新，共 48 条。证据位置从“上方”改为实际可展开的“详情 / 詳細資料 / Details / 詳細”，后续动作与“重新诊断”一致，去掉段尾句号；段内标点、技术路径、`SKILL.md`、`targets`、MCP 及先审查资产草稿等安全指引保留。没有改键名或插值，没有向不含这些管理页的 Web 新增词条

新增 `doctor-manual-copy.test.ts` 使用实际 `initializeI18n()` / `tr()`，逐一核对手动动作与已加载 JSON 的当前语言解析、12 键完整性及插值一致性，并验证段尾句号已去掉、折叠证据引用正确。四语 8 项目标红测均先因旧句号或位置指引失败，修正后与原诊断和四语术语组合一起通过

```sh
pnpm --filter @agentkib/desktop exec vitest run --project=desktop \
  src/features/workspace/doctor-manual-copy.test.ts \
  src/features/workspace/doctor-presentation.test.ts \
  src/features/workspace/WorkspaceDoctorPage.e2.test.tsx \
  src/features/workspace/WorkspaceDoctorPage.test.tsx \
  src/features/workspace/WorkspaceTerminology.test.tsx
```

结果：5 文件、82/82 通过，1.05 秒。新增测试定向 oxlint 为 0 warning / 0 error；四语 JSON 和该测试的显式 `oxfmt --check` 通过。最终相关组合与完整桌面测试结果分别记录如下

## E2 首轮集成验证（2026-10-24，保留原始结果）

所有命令使用 pnpm 12.10.1 和临时 userconfig `manage-package-manager-versions=false`，目录变量隔离，不修改依赖或锁文件

| 命令 / 验收                                                         | 实际结果                                                                                                                                              |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                    | 后端、桌面、Web 均通过；最后 renderer 重建前再次通过                                                                                                  |
| `pnpm lint`                                                         | 退出 0，276 warnings / 0 errors；保留原规则，没有关掉检查                                                                                             |
| `pnpm format:check`                                                 | 通过，1054 个匹配文件                                                                                                                                 |
| `pnpm test:web`                                                     | 69 文件、1492/1492 通过，38.50 秒                                                                                                                     |
| 桌面完整相关组合                                                    | 45 文件、705/705 通过，6.76 秒；包括全部 workspace UI、路由、会话来源提示、工作区切换和 UI 原语约束                                                   |
| `pnpm --filter @agentkib/desktop test`                              | 首轮 422 文件通过 / 2 文件失败 / 1 文件跳过，8470 项通过 / 3 项失败 / 3 项跳过，201.47 秒；其中本轮 UI 原语违规已经修复，另两项为未改动的启动恢复测试 |
| `pnpm --filter @agentkib/desktop test --maxWorkers=1`               | 425 文件通过 / 1 文件失败 / 1 文件跳过，8490 项通过 / 1 项失败 / 3 项跳过，691.31 秒；**仍未全绿**，见下节                                            |
| `vitest run test/claude-startup-recovery.test.ts --maxWorkers=1`    | 单独运行 52/52 通过，9.16 秒；不能代替完整测试结果                                                                                                    |
| 修改过的桌面测试显式 `oxfmt --check`                                | 21 个测试文件通过                                                                                                                                     |
| `pnpm --filter @agentkib/desktop protocol:generate`、`cursor:stage` | 通过，恢复当前构建资源                                                                                                                                |
| `pnpm --filter @agentkib/desktop build:web`                         | 通过；真实窗口发现的计数与已应用只读问题修复后重新构建                                                                                                |
| `pnpm --filter @agentkib/desktop electron:build`                    | 后端、原生模块、Claude bridge、Electron main / preload 均通过                                                                                         |
| `pnpm --filter @agentkib/web build`、`build:hosted`                 | 两种前端构建均通过                                                                                                                                    |
| `node --test qa/probes/v15-e2-response-delay.test.cjs`              | 2/2 通过；只延迟原始 plan 响应对象，不替换结果                                                                                                        |
| 探针语法检查、`git diff --check`                                    | 通过                                                                                                                                                  |

完整相关组合命令：

```sh
pnpm --filter @agentkib/desktop exec vitest run \
  src/features/workspace \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/sessions/SessionDirectory.test.tsx \
  src/features/sessions/SessionSourceNotices.test.tsx \
  src/test/ui-source-constraints.test.ts \
  'src/routes/(main)/workspace/$workspaceId'
```

### 修复前的全量测试失败（历史记录）

以下保留首次集成时的失败与当时已知边界；追加定位、夹具修改和最终通过结果见本文末尾，不表示当前仍未完成定位

当时完整单 worker 复跑仍有一项失败：`test/claude-startup-recovery.test.ts` 的 “restores an undispatched initialize timeout after confirming worker cleanup, then permits a new send”，在恢复后的第二次正常 `send` 处（约第 469 行）报告 `Claude initialize timed out`

- 该用例直接实例化 `ClaudeManagedRunnerProcess` 和合成 shell CLI，不走工作区计划、Doctor 或 `defaultManifest`；本批唯一后端修改不在其调用路径中，runner、启动恢复测试及 fixture 没有修改
- 原测试保持 `controlTimeoutMs: 300` 和 30 秒用例预算，以及未派发、进程清理和恢复后允许发送的安全断言
- 独立运行整个文件 52 项通过；但完整单 worker 复跑仍失败，不能据局部重跑声称问题已经解决
- 当前 fixture 已使用 `/bin/sh`，不能再归因于旧的 Node 冷启动问题；300ms 包含进程准备后的文件读写、管道响应和父进程处理等阶段，尚无本次分段计时，具体耗时根因未确认
- 本批按 E2 范围保留此限制，没有通过延长预算、放宽断言、修改 CLI 生产保护或盲目继续重跑来掩盖结果

### 独立复核和真实窗口发现后的补充修复

- 等待应用前诊断期间编辑、切换工作区、替换同 ID / 不同 ID 计划及旧回调点击均不能写入；使用计划对象身份校验，不能拿新 store 状态为旧闭包背书
- Doctor 加入全局配置仍以已审查磁盘快照生成，独立编辑草稿不混入修复
- 磁盘冲突的两种选择都先使旧计划失效；读取磁盘过程中仍显示同一种冲突状态，不能通过全局配置纳入绕过选择和重新审查
- 生成锁按操作版本释放，离开工作区后旧清理不能释放另一轮生成；生成时不伪造“0 个文件 / 没有变更”结论
- 有缓存时重新诊断失败，不回传旧摘要、不显示旧零问题或健康矩阵；恢复后才使用新报告
- 信息级条目仍可展开，但不进入“问题”计数，与页头和汇总口径相同
- 诊断证据文件取安全相对父目录，保留后端只允许工作区内目录的规则；打开失败不产生未处理 Promise，也不把错误写到后来切换的工作区
- 已应用结果固定草稿 / 基线快照，保持只读并移除未来写入与拒绝动作；诊断读取失败不丢失成功写入结果，也不编造已解决数量
- 业务页折叠使用现有 Button / Collapsible 原语，新增 Enter / Space 交互回归，没有增加源约束白名单

## 真实沙盒交互与截图

使用真实 Electron 44.9.1、生产 renderer、IPC 和后端，运行在合成数据沙盒；不替换生产 handler 或返回结果。最终保存 19 张 1360×860 截图及 11 份脱敏 JSON，完整清单见[探针记录](probes/v15-e2-inventory.md)，数值汇总见[实际 UI 验证](screenshots/v15-e2-2026-10-23/ui-validation.json)

| 页面 / 状态            | 实际核验                                                                                                      | 截图                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| zh-CN 诊断折叠         | 1 个警告、0 个错误，问题计数不包含信息，矩阵默认折叠，页头口径一致                                            | [折叠](screenshots/v15-e2-2026-10-23/zh-CN-doctor-collapsed.png)                                                                                   |
| zh-CN 诊断展开         | 本地化说明、可展开原始详情、只有异常格着色，无数值比                                                          | [展开](screenshots/v15-e2-2026-10-23/zh-CN-doctor-expanded.png)                                                                                    |
| zh-CN 计划首屏         | 默认 AGENTS.md，分组文件与独立滚动差异；应用按钮矩形 x=1210.30、y=728、w=108.70、h=36，首屏完整可见           | [首屏](screenshots/v15-e2-2026-10-23/zh-CN-plan-first-screen.png)                                                                                  |
| 生成中                 | 一个状态，应用不可用；真实点击编辑标签被禁用的祖先 fieldset 阻止                                              | [生成中](screenshots/v15-e2-2026-10-23/zh-CN-plan-generating.png)                                                                                  |
| 计划已失效             | 草稿保留，重新生成前不能应用旧计划                                                                            | [失效](screenshots/v15-e2-2026-10-23/zh-CN-plan-stale.png)                                                                                         |
| 与磁盘冲突             | 外部修改合成 manifest，显示两种选择，应用禁用；实际选择保留草稿后重新生成                                     | [冲突](screenshots/v15-e2-2026-10-23/zh-CN-plan-conflict.png)                                                                                      |
| 已应用，干净流程       | 写入 9 个文件、备份 3 个原文件，重新诊断解决 1 项，显示计划已提前说明的 DeepSeek 兼容问题；历史差异只读       | [已应用](screenshots/v15-e2-2026-10-23/zh-CN-plan-applied-clean.png)                                                                               |
| 已应用，故障注入流程   | 注入 manifest 冲突后应用前共 10 个警告，应用后解决 10 项；与干净流程单独记录                                  | [故障注入后](screenshots/v15-e2-2026-10-23/zh-CN-plan-applied-conflict.png)                                                                        |
| 会话目录和工作区会话页 | 两页均仅 1 条来源提示，目录提示可换行；真实重试完成且提示仍为 1 条，重试 computed color 为 `rgb(40, 90, 224)` | [总目录](screenshots/v15-e2-2026-10-23/zh-CN-catalog-source-notice.png)、[工作区](screenshots/v15-e2-2026-10-23/zh-CN-workspace-source-notice.png) |
| en-US / ja-JP 概览     | 第四项折行，分隔点跟随上一项，无行首点                                                                        | [英文](screenshots/v15-e2-2026-10-23/en-US-overview.png)、[日文](screenshots/v15-e2-2026-10-23/ja-JP-overview.png)                                 |
| zh-TW 诊断与计划       | 无页面横向溢出，底栏可见，详情外无后端英文原句                                                                | [诊断](screenshots/v15-e2-2026-10-23/zh-TW-doctor.png)、[计划](screenshots/v15-e2-2026-10-23/zh-TW-plan.png)                                       |
| en-US 诊断与计划       | 无溢出、底栏可见，新增 1 行用单数 `line`；应用按钮 x=1190.96、y=728、w=128.04、h=36                           | [诊断](screenshots/v15-e2-2026-10-23/en-US-doctor.png)、[计划](screenshots/v15-e2-2026-10-23/en-US-plan.png)                                       |
| ja-JP 诊断与计划       | 无溢出、底栏可见，使用“変更プラン”等既有术语，详情外无后端英文原句                                            | [诊断](screenshots/v15-e2-2026-10-23/ja-JP-doctor.png)、[计划](screenshots/v15-e2-2026-10-23/ja-JP-plan.png)                                       |

### 真实写入与诊断前后结果

- 干净流程：初始 CLAUDE.md 与 AGENTS.md 完全相同，实际 1 个重复警告；编辑共享指令后审查并应用 9 个文件，备份已有 AGENTS.md、CLAUDE.md 和 manifest 共 3 个文件；重新诊断解决 1 个重复问题，出现 1 个提前说明的 DeepSeek 兼容警告。见[初始](screenshots/v15-e2-2026-10-23/clean-initial-diagnosis.json)、[应用前](screenshots/v15-e2-2026-10-23/clean-before-apply.json)、[应用后](screenshots/v15-e2-2026-10-23/clean-after-apply.json)
- 故障注入流程：外部修改合成 manifest 后，应用前有重复警告 1 项和 9 个 Agent 的 `expected-content-missing`，合计 10 项；应用后解决 10 项，保留预告的兼容警告。见[注入前](screenshots/v15-e2-2026-10-23/conflict-pre-injection-diagnosis.json)、[应用前](screenshots/v15-e2-2026-10-23/conflict-before-apply.json)、[重新诊断](screenshots/v15-e2-2026-10-23/conflict-after-diagnosis.json)。10 项仅属于故障注入场景，不能当成正常流程结果
- 生成中截图只将原始真实 `changes.plan` 响应延迟 3500ms，资产只读交互另延迟 5000ms；没有替换请求或结果。探针有独立 2 项测试，退出时清除延迟控制，不改变生产计时或测试预算
- 英文 / 日文概览分别保存实际折行坐标；其他三语页面 `scrollWidth` 均为 1360，无页面错误。四语均不翻译示例用户正文或原始文件名
- 截图前逐张核对示例路径、工作区和会话，不含真实用户名、本机仓库、账号或局域网地址；复制后的 JSON 再检查个人路径标记，不保存私有 fixture 配置或启动参数

### 清理

[清理证据](screenshots/v15-e2-2026-10-23/cleanup-evidence.json) 核对 5 个本轮自有 fixture root，剩余自有进程为 0，本轮未创建 tmux；不把键盘退出动作本身当作进程已退出的证明。已重建当前协议、插件及 Electron / renderer 资源，没有触碰真实 CLI 或 Codex 系统技能

## 与设计的差异及保留功能

- DeepSeek Harness 使用设计允许的提前说明方案；不会伪造应用后无警告，后端原诊断语义保留
- 既有未托管 AGENTS.md 前缀和托管块生成规则保留，不为视觉上只剩一份正文而静默删除或接管用户原文；本批只消除导入时完全相同的 Claude override，不进行模糊删重或更改其他 Agent 的读取规则
- 风险按真实计划保留“高”及全局配置额外确认，未把设计举例的“中 / 低”当作删除原安全信息的理由；低风险但被 Agent 读取的文件使用对应说明
- 原文件定位复用现有受控工作区存储操作，只覆盖工作区内证据；全局路径保留详情和上下文入口，没有为了与预览图一致而新增任意路径 IPC 权限。实际打开所属文件夹，不承诺在 Finder 中选中文件
- 旧跨 Agent 变更、恢复和启动流程保留原入口及行为，不接入 E2 的普通配置计划重排
- 其他保留项：错误 / 空态 / 重试、原修复入口、全局配置复核、Claude 原生配置提示、只读已应用差异及备份目录，不因预览未展开而删除
- 文案复核已修正：新计划日语状态使用现有术语“変更プラン”；E2 已应用标题采用无段尾句号的局部四语文案，保留旧流程的词条；四语 `doctor.manual.*` 与折叠“详情”的证据位置一致。四语真实窗口的换行、底栏与英文单数均已核验
- Web 没有工作区管理 / 诊断 / 计划页面，本批保留现有页面边界；验证共用后端及 Web 全量和两种构建，没有为与桌面截图对应而新增 Web 管理页

Windows、Linux 原生窗口及真实 CLI 发送不属于当前已完成证据；本批不据合成数据单测声称这些平台和运行环境已经实测

## Claude 启动恢复测试超时定位与修复（2026-10-24）

### 与 E2 的关系与根因

修复前核对的 `claude-startup-recovery.test.ts`、`fixtures/claude-startup-cli.ts`、`claude-managed-runner.ts` 均与 `f0d0329d7` 基线一致；runner 及其依赖不经过本批唯一生产后端修改 `default-manifest.ts`。本次修复仅涉及测试准备，不改变 E2 页面或生产 CLI 的启动行为

旧合成 shell 没有就绪握手：`spawn()` 返回并不等于解释器已经开始读协议。runner 在 spawn 和进程树附加后立即启动 300ms 初始化计时，测试因而把“合成子进程尚未进入循环”和“已经进入循环但故意不回复 initialize”混在一起。恢复后再启动一代正常 shell 时，也可能在处理 initialize 前消耗掉同一个 300ms 窗口

使用只记录白名单阶段的临时探针：父端记录 spawn、stdin 写回调、stdout 和 send 结束；合成 shell 用内建 `printf` 写独立阶段文件，不额外启动计时解释器。12 次精确样本的第一代 shell 从 spawn 返回到进入协议循环为 50.620～262.265ms，随后读取模式和生成响应的耗时远小于此准备时间。该采样没有再次触发原失败，不能作为稳定性通过或声称捕获了原全量失败的精确现场；完整脱敏数据见[阶段证据](probes/v15-e2-claude-startup-timing.json)

为验证因果，在恢复后的合成 CLI 进入循环前受控延迟 350ms，原 `send` 与 `prepare` 两条路径确定出现同样的 `Claude initialize timed out`，2 项回归先红；父端 stdin 写回调已完成，第二代 shell 尚未就绪，没有 initialize 回复。加入前置就绪同步后，同样的受控场景通过。实际 OS 调度 / 加载为何在上一轮全量中特别慢没有内核级证据，本记录不将它归因于特定 macOS 服务、冷 Node 或 E2 代码

### 修复及不变的保护

- 合成 shell 先写入当前真实 PID 的 ready 标记，再等待 stdin；每次生成计划或启动前清除旧标记，只接受本次 ChildProcess 的 PID
- `createStartupClaudeSpawn()` 仅匹配该合成 fixture 的可执行文件及完整 marker 路径，在原 runner 300ms 协议计时开始前完成准备；最多等待 2000ms，沿用原 Linux 独立子进程测试已有的准备上限，外层单例仍为 30 秒
- 准备失败不重试 spawn，不伪造进程、协议帧或 stdout；始终返回原 ChildProcess 给 runner 进行原有身份捕获及清理，清理后统一断言准备失败列表为空，不能把设置失败当成预期协议超时而通过
- Linux 自定义独立进程组 fixture 保留原有子进程 ready 同步、PGID / 存活 / 未知 / 零证明 / 零用户帧断言；无解释器用例保留真实 spawn 失败路径，不等待本来就不可能出现的 shell ready
- 测试结束同时恢复 spawn spy 与 Node 内建 ESM 导出，避免跨用例污染；嵌套 Linux spy 保存实际包装实现，避免复用 mock 对象而递归
- 原 `controlTimeoutMs: 300`、各 30 秒用例、生产默认 30 秒计时、锁 / 所有权 / 清理证明 / 未派发与未知结果规则均未修改。修复的是测试前置条件竞态，不是生产 CLI 启动性能优化

### 回归与独立复核

- 新增 9 项夹具回归：真实 shell 先就绪后初始化、旧 PID 不接受、缺 marker 有限失败仍持有 child、无 PID 原样返回、非 fixture 透传、切换计划清旧代等
- 原 send / prepare 恢复用例各扩充一项 350ms 受控慢准备场景；原 0ms 场景和所有安全断言保留，发送路径额外确认首轮确实收到 initialize 且没有用户帧
- 先红：两项 350ms 场景均在原 runner 超时；修复后两文件 63/63 通过（9.70 秒），不以此代替最终完整组合和全量结果
- 独立只读复核上述三文件：no finding；确认未放宽预算、未跳过真实进程清理、未伪造协议或改变生产规则
- 临时分段探针已移除，不加入常规测试；阶段数据仅含相对耗时、阶段名和合成帧类型，无正文、真实配置、账户或凭据

### 最终验证结果

沿用 pnpm 12.10.1、临时 userconfig `manage-package-manager-versions=false` 及独立目录变量，不改依赖、锁文件、测试分组配置或默认并发配置。测试与类型 / 构建检查依次执行，没有并行制造额外负载

| 命令 / 覆盖                                                                                          | 结果                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 两个受控慢重启用例，未接入 ready 包装前                                                              | send / prepare 均出现 `Claude initialize timed out`，2 失败，1.52 秒；非验收通过结果                                                      |
| `vitest run test/claude-startup-recovery.test.ts test/claude-startup-fixture.test.ts --maxWorkers=1` | 两文件 63/63 通过，9.70 秒；其中原恢复 52 项、新增慢准备 2 项、ready 回归 9 项                                                            |
| E2 全 workspace / 路由 / 会话来源 / UI 原语，加生成 / 合并及全部 66 份 `claude-*.test.ts`            | 112 文件通过 / 1 文件跳过，3042 项通过 / 2 项既有跳过，199.71 秒；单 worker 完整相关组合                                                  |
| `pnpm --filter @agentkib/desktop test`                                                               | **427 文件通过 / 1 文件跳过，8526 项通过 / 3 项既有跳过，165.79 秒，退出 0**；默认并发，全项目分组完成，启动恢复 54 项和新夹具 9 项均通过 |
| `pnpm typecheck`                                                                                     | 后端、桌面、Web 均通过                                                                                                                    |
| `pnpm lint`                                                                                          | 276 warnings / 0 errors，退出 0，原规则不变                                                                                               |
| 三个改动夹具 / 恢复测试显式 `pnpm exec oxlint`                                                       | 1 warning / 0 errors，退出 0；warning 是原恢复测试既有的 `activeRunner = this`，未因测试通过而屏蔽规则                                    |
| `pnpm format:check`                                                                                  | 1054 个匹配文件通过                                                                                                                       |
| 本批全部 24 个改动桌面测试 / 夹具显式 `pnpm exec oxfmt --check`                                      | 通过，包含原 E2 测试及本次三文件                                                                                                          |
| `protocol:generate`、`cursor:stage`、`backend:build`                                                 | 全量结束后依次通过，包含 Claude 插件重新暂存及后端 / 原生构建资源恢复                                                                     |
| QA / 阶段 JSON 格式、`git diff --check`                                                              | 通过                                                                                                                                      |

完整相关组合的可复现命令（在 `apps/desktop` 目录运行；实际执行时将 glob 展开为 66 个文件后传给 vitest）：

```sh
pnpm exec vitest run \
  src/features/workspace \
  src/features/app/useWorkspaceTransitions.test.tsx \
  src/features/sessions/SessionDirectory.test.tsx \
  src/features/sessions/SessionSourceNotices.test.tsx \
  src/test/ui-source-constraints.test.ts \
  'src/routes/(main)/workspace/$workspaceId' \
  test/workspace-plan-instructions.test.ts \
  test/config-merge.test.ts \
  test/claude-*.test.ts \
  --maxWorkers=1
```

本次测试修复没有新增用户文案或改变桌面 / Web 行为，无需新增翻译；原 E2 四语与安全边界保持不变。没有运行真实 CLI、访问真实会话或系统技能；临时分段测试已删除，合成子进程由原 runner / fixture 清理，进程匹配复查未发现剩余的 startup 夹具进程，本轮未创建 tmux。本节为提交前的本地验证结果，后续 CI 以 PR 检查为准
