# DeepSeek Harness 三期（DSH 未运行时由 AgentKib 启动）QA — 2026-11-12

本文记录三期的实现范围、自动化结果和真实 DSH 沙箱验收，以及所有 Agent 共用的退出确认。开工前的技术验证见[三期技术验证](dsh-phase3-spike-2026-11-12.md)，方案见[接入方案](../docs/agents/deepseek-harness.md)的 §7 三期。结论只适用于下列源码与版本。

## 源码与边界

- AgentKib：`origin/main` `971e40f8b`（含 #215、#216）之上，分支 `dsh-phase3`；验收在提交前的同一份改动上进行。
- DSH：本机安装的 DeepSeek Harness `0.2.2-rc.1`，经它自带的命令行启动器启动。
- 决定（2026-11-12，用户）：
  - AgentKib 自己启动的进程随 AgentKib 退出，退出前先提醒还有进行中的任务，所有 Agent 一样；
  - 其余由实现方决定：空闲 3 分钟停止，叠加 Desktop 的设置，“需要时自动启动 DeepSeek Harness”默认打开，DSH 没开时打开会话即启动来读历史。
- 没有新增依赖。插件升到 0.6.0，桥接协议不变（Host 按进程 ID 认出自己启动的 DSH，不依赖插件自报）。新增偏好 `dsh_auto_start`（缺省为开）。

## 实现范围

- **后台启动**（`packages/backend/src/dsh-managed-runtime.ts`）：
  - 找 DSH Desktop 包里的启动器，再找 PATH 上的 `dsh`；
  - 用 `dsh --version` 对照插件的 `engines.dsh`；
  - 以 web profile 启动，叠加 Desktop 的设置文件和 AgentKib 写的叠加层（按路径挂插件，禁用 profile 里可能装着的那份）；
  - 去掉 `AGENTKIB_*`、`ELECTRON_*` 环境变量；stdout 的 token 不读不记；
  - 停止先 SIGTERM，8 秒后 SIGKILL；DSH 禁用插件时据 stderr 报 `dsh-version-unsupported`。
- **DSH 连接**（`packages/backend/src/dsh-bridge.ts`）：
  - 没有用户的可控制 runtime、设置打开、启动器可用时，会话显示为空闲、可以发送；
  - 发送、重命名、分叉、打开会话读历史、交接读取、读新建会话的选项时启动，等插件报告过一次且 DSH 的会话服务可用，并发请求共用一次启动；正文搜索不启动；
  - 控制按启动前的 revision 核对；
  - 控制目标与新建会话都先选用户自己的 DSH；
  - 空闲 3 分钟停止，DSH Desktop 的窗口开着时 1 分钟；用户自己装了插件的 DSH 注册上来或设置关掉时，一空闲就停；每条发往后台 DSH 的命令后 10 秒内算作忙碌（插件稍后才报告这条命令开始的一轮，避免在此间隙误停）；决定停止时先把它撤下，退出前不再接受它重新注册；AgentKib 关闭时停止；
  - 执行位置为 `agentkib`；DSH 的 `session/writer-held` 报为 `dsh-session-in-use`；新增原因 `dsh-start-failed`、`dsh-version-unsupported`、`dsh-launcher-unavailable`、`dsh-exited`，主进程 Web 服务的两份放行清单都已加入。
- **插件 0.6.0 托管模式**：只向启动它的 AgentKib 注册；标准输入关闭或 30 秒联系不上时经 `appExit` 正常退出。会话列表第一次读到时总会报告一次，空的也报告。
- **退出确认（所有 Agent）**：主进程退出前按会话目录列出执行位置为 AgentKib 的运行中与待答会话（`workStoppedByQuit`），随退出请求交给页面；有的话先确认“仍然退出”，最多列三个名字。读取最多等 2 秒，读不到就不列。
- **界面**：桌面“会话操作”里的 DSH 连接面板显示后台进程（“由 AgentKib 在后台启动”）、自动启动开关，先给 DSH Desktop“添加插件”要粘贴的目录，再给命令行写法；会话页两端新增上述原因的说明，四种语言。手机端（agentkib-flutter）同步认识这些原因。

## 自动化检查

- 以下为合并最新 main（`bed199da0`）并加上界面验收的修复之后的结果。类型检查（backend、desktop、web）：通过。oxfmt（CI 全范围）：通过。oxlint：0 错误，269 条警告，都不在本次改动的行上。CI 脚本测试、分片校验、`pnpm build`、`pnpm build:web:hosted`：通过。
- Desktop 全量：542 个文件通过（1 个跳过），10458 通过、3 跳过。Web 全量：87 个文件，1807 通过。
- 新增测试：
  - `dsh-managed-runtime.test.ts`（10）：启动器查找顺序、`engines.dsh` 与版本判断（含 DSH 按先后比较预发布版本）、命令参数与叠加层内容和权限、环境过滤、无 Desktop 设置时不加叠加、版本不符不启动、找不到启动器、SIGTERM 后升级 SIGKILL、按 stderr 区分插件被禁用与其他退出且不留 token、识别 DSH Desktop 窗口进程。
  - `dsh-bridge.test.ts` 新增 15：离线可发送并自动启动、执行位置、空闲停止后再次启动、用户的 DSH 优先且后台让出、Desktop 窗口开着时让出、设置关闭与版本不符的说明、启动失败的原因、打开会话启动而搜索不启动、`session/writer-held` 的说明、关闭时停止、没有会话的 DSH 也能就绪、不把请求交给正在停止的 DSH；插件托管模式：只连启动它的 AgentKib、标准输入关闭即退出、联系不上即退出、`managed.home` 校验。
  - `AppRuntimeBridge.test.tsx` 新增 3：列出将停止的工作并在确认后才退出、没有时直接退出、最多三个名字。`home-sessions.test.ts` 新增 1：`workStoppedByQuit` 只算 AgentKib 里运行与待答的会话。
  - Web `session-display-state.test.ts` 新增 1 组（四种语言）：后台 DSH 上的会话和下一条消息会启动 DSH 的会话，标题栏显示运行中、正在启动或不显示，不再是“仅可查看”；关掉自动启动时仍说明原因。

## 真实 DSH 沙箱验收

用真实的后端代码（`DshBridge` 与 `DshManagedRuntime`）、打包后的插件 0.6.0 和 DSH 自带的启动器（经 `sandbox-exec` 只允许连本机），独立的 HOME 与 DSH 数据目录，本机模拟模型。用户的 DSH Desktop 当时开着（在沙箱外，只被识别为“窗口在运行”）。

| 步骤                          | 结果                                                                                                                               |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 选 DSH 读新建选项             | 1.34 秒（含启动 DSH），4 个 Agent 预设；DSH 约 273 MB                                                                              |
| 新建会话                      | 0.9 秒，accepted                                                                                                                   |
| 第一条消息                    | 0.35 秒收到回复；执行位置 `agentkib`，管理状态标出 `managed: true`                                                                 |
| 一轮跑到一半时 AgentKib 关闭  | 关闭 75 毫秒，DSH 159 毫秒内退出；会话日志这一轮为 `aborted`／`disposed`                                                           |
| AgentKib 再次启动，打开该会话 | 读历史时启动 DSH，0.8 秒读到（含被中断那一轮已生成的部分），继续发送正常                                                           |
| 空闲（Desktop 窗口开着）      | 最后一次活动后 74.5 秒停止（1 分钟 + 10 秒保护 + 最多 5 秒的检查间隔），会话回到可发送                                             |
| 设置关闭                      | 状态为 `unsupported`／`dsh-runtime-offline`，打开会话不启动 DSH                                                                    |
| AgentKib 崩溃                 | 让启动 DSH 的进程直接退出（DSH 在独立进程组里）：DSH 0.1 秒内退出，靠插件读到标准输入结束；技术验证中普通 DSH 关闭标准输入后不退出 |

验收中发现并修复：

- 全新的 DSH（一个会话都没有）一直等不到“已列出会话”：插件只在列表变化时报告，空列表从不报告，启动等满 30 秒失败，客户端得到 504。改为等插件报告过一次且会话服务可用，插件也改为第一次读到列表时总报告一次。
- 后台 DSH 正在停止时，新请求仍交给了它：它退出前还算在线，新建会话的选项就拿不到预设。改为决定停止时先撤下，退出前拒绝它重新注册，新请求另起一个。
- 命令刚派发、插件还没报告这一轮开始时，空闲检查可能把它当成空闲而停掉：每条命令后 10 秒内算作忙碌。全量测试中一次偶发失败暴露了这个问题。
- DSH Desktop 窗口开着时一空闲就停，每次操作都要重启 DSH：改为空闲 1 分钟。

## 界面验收

沙箱开发版（`electron-vite dev`）：独立的 HOME、数据目录和钥匙串，Codex 与 DSH 只连本机的模拟模型。沙箱 HOME 里放了一个空密码的钥匙串：没有它时，macOS 在假 HOME 下找不到默认钥匙串，开发版启动时账号服务经 `safeStorage` 保存密钥，会弹出系统的创建或解锁询问。用户的 DSH Desktop 当时开着。

| 步骤                                           | 结果                                                                                                                                       |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 首页新建会话选 DeepSeek Harness                | 在后台启动 DSH（约 273 MB），输入框出现 DSH 的预设“标准模式”                                                                               |
| 发送第一条消息                                 | 新建会话并打开，回复逐字到达，侧栏显示运行中                                                                                               |
| 会话标题栏                                     | 运行时“在 AgentKib 中运行”，空闲时不显示状态（见下方修复）                                                                                 |
| 会话操作 → DeepSeek Harness 连接               | “已连接 1 个正在运行的 DeepSeek Harness”“版本 0.2.2-rc.1 · 由 AgentKib 在后台启动”，自动启动开关；先给 Desktop“添加插件”的目录，再给命令行 |
| 空闲                                           | 最后一轮结束后约 1 分钟，后台 DSH 停止（DSH Desktop 开着）                                                                                 |
| 有任务时退出（Codex 与 DSH 各一个在运行）      | 确认框列出两个会话名，默认焦点在“取消”；取消后两个任务都继续运行                                                                           |
| 确认“仍然退出”（Codex 在运行，DSH 已空闲停止） | AgentKib 和 Codex 进程几秒内退出                                                                                                           |
| 重新打开 AgentKib，在 DSH 会话再发一条         | 后台 DSH 重新启动，标题栏回到“在 AgentKib 中运行”                                                                                          |
| 这一轮运行中退出，确认“仍然退出”               | 确认框列出这个会话；DSH 2 秒内退出，会话记录里这一轮为 `aborted`／`disposed`                                                               |

验收中发现并修复：会话标题栏对 DSH 只认“接在用户自己的 DSH 上”，其余都显示“仅可查看”。后台 DSH 上的会话（执行位置 `agentkib`），以及 DSH 还没启动、下一条消息会启动它的会话，因此都显示“仅可查看”，而输入框其实可以发送。改为和 Codex 一样：

- 运行时显示“在 AgentKib 中运行”；
- 发出消息、等待 DSH 启动时显示“正在启动”；
- 可以发送时不显示；
- 提问、审批和压缩上下文照常提示。

桌面和 Web 两份同时改，Web 新增四种语言的测试。手机端的状态条按通用规则显示，没有这个问题。

截图：`qa/screenshots/dsh-phase3/`。连接面板里的目录在开发版是源码目录，截图前换成了安装版会显示的路径。

- `p3-01-new-session.png`：首页新建会话选了 DeepSeek Harness，预设来自后台启动的 DSH。
- `p3-02-running.png`：后台 DSH 上的会话正在运行。
- `p3-03-panel.png`：会话操作里的 DeepSeek Harness 连接。
- `p3-04-quit.png`：退出确认框。
