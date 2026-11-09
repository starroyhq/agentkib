# DeepSeek Harness 一期接入 QA — 2026-11-04

本文记录一期（接入运行中的 DSH）的源码、自动化结果和真实 DSH 沙箱验收。结论只适用于下列源码与版本。桌面端和手机端（Android 模拟器）各有一节真实 DSH 验收；Web 浏览器客户端与 iOS 只有自动化证据。方案与规则见[接入方案](../docs/agents/deepseek-harness.md)。

## 源码与边界

- AgentKib：基线 `main cd391c228608c8b814aa2289794c913a5ade5e69`（v0.26.0），工作树分支 `worktree-dsh-integration`，本轮修改未提交。
- agentkib-flutter：基线 `main 1269df2`，工作树分支 `dsh-integration`，本轮修改未提交。
- Node `v26.12.0`，pnpm `12.10.1`；Flutter `3.41.9`，Dart `3.11.5`。
- 没有新增生产依赖或持久化结构。构建多了一步 `dsh:stage`，把插件复制进应用资源（`electron-builder.yml` 增加 `dsh-bridge`）。
- DSH：本机 DeepSeek Harness Desktop `0.2.1-rc.5` 自带的 CLI，以沙箱 HOME 运行 `dsh --profile web --patch <补丁> --no-open --port 0 --host 127.0.0.1`。
- 插件：`agentkib-dsh-bridge 0.1.0`（bridge 协议 1）经 `--patch` 挂载。没有用 `dsh plugin add` 安装，也没有写入任何真实 profile。
- 模型：本机 OpenAI 兼容的合成 provider（127.0.0.1），按脚本返回文本、`bash` 工具调用、`ask_user_question` 和慢速流式回复。真实模型请求 **0**。
- AgentKib：本工作树构建的桌面开发版（Electron），HOME、`AGENTKIB_HOME`、数据目录和用户数据目录都是独立的。
- DSH 一侧：用 DSH 自带的 Web 界面作答，在独立 profile 的无头 Chrome 中驱动。
- 没有读取或修改用户真实的 `~/.dsh`、`~/.agentkib`、`~/.claude`、`~/.codex` 或 Chrome profile；没有部署、发布或替换已安装的应用。

## 实现范围

- Host：
  - DSH 会话来源，包括会话列表、历史分页、实时状态和能力投影；
  - 控制账本，结果未知时自动核对；
  - `/managed/*` 按来源路由；
  - 新增 `queue-steer` 操作。
- 插件：
  - 发现与注册；
  - 经 `sessionController` 派发控制；
  - 审批与问答重新派发，先答者生效；
  - 按 `rpcId` 核对结果。
- Desktop／Web：
  - 跟随状态；
  - DSH 审批与问答卡片；
  - 输入框上方的待发条；
  - DSH 未运行时仅可查看。
- 按用户要求一并调整的通用界面（所有 Agent）：
  - 删去“请求已接收，不代表执行完成”“轮次不完整 · 显示已载入记录”，以及 Codex 和 DSH 的输入区说明；
  - 输入框的临时提示改为浮在输入框上方。
- Flutter：见接入方案 §8.1 的“一期实现”。

## 自动化检查

根目录脚本里嵌套调用的 pnpm 在本机不可用。以下按脚本内容逐条用 `pnpm exec` 执行，路径与 `pnpm format:check`、`pnpm lint`、`pnpm typecheck` 相同。

| 命令 / 检查 | 实际结果 |
| --- | --- |
| `oxfmt --check …` | 通过，1185 个文件 |
| `oxlint apps/desktop/src apps/desktop/electron packages/backend/src` | 0 error，275 warning；本轮改动的文件里出现的 warning 所在行都不在改动范围内 |
| `tsc --noEmit`（packages/backend） | 通过 |
| `tsc -b --pretty false`（apps/desktop） | 通过 |
| `tsc --noEmit`（apps/web） | 通过 |
| `vitest run`（apps/web） | 85 文件、1785 项通过 |
| `vitest run --maxWorkers=4`（apps/desktop） | 502 文件通过、1 文件跳过；9808 项通过、3 项跳过 |
| `flutter analyze`（agentkib-flutter） | No issues found |
| `flutter test`（agentkib-flutter） | 1031 项通过、1 项跳过 |
| `dart test`（packages/agentkib_client） | 261 项通过（含手机验收后补的两项回归测试） |

DSH 专项用例：

- `apps/desktop/test/dsh-bridge.test.ts`，13 项。Host 与插件都是真实代码，经本机 Unix socket 连接；DSH 进程用模拟对象（Cordis 事件与 waterfall、Agent、会话查询与会话服务）。覆盖：
  - 发现文件与会话列表；
  - 历史分页，注入上下文不外露；
  - 同一请求只发送一次；
  - 流式期间 revision 不变；
  - 待发队列过滤与 `queue-steer`；
  - 审批两边显示、先答者生效；
  - DSH 先答时撤回 AgentKib 的卡片；
  - 未知结果按 DSH 记录核对；
  - 无记录时放弃等待；
  - DSH 退出后保留已读历史，回来后重读；
  - AgentKib 启动时 DSH 未运行；
  - 版本与记录上限。
- Desktop 与 Web 各有：
  - `dsh-queue.test.tsx`（4 项）：待发条的引导、删除和编辑；只在队列变化时重新读取；
  - `session-dialogs-dsh.test.tsx`：审批只允许一次，“已在 DeepSeek Harness 中处理”的显示条件。
- `runtime-router.test.ts` 增加 `queue-steer` 的转发。
- Flutter：
  - `packages/agentkib_client/test/dsh_follower_contract_test.dart`（4 项）
  - `test/dsh_follower_test.dart`（5 项）
  - 使用合成 fixture `fixtures/dsh_follower.json`，按本工作树 Host 的实际投影整理，来源见 `fixtures/manifest.json`。

## 真实 DSH 沙箱验收（桌面端）

2026-11-04 12:09–17:41（本机时间），环境见上文。

| 场景 | 结果 |
| --- | --- |
| 列表与历史 | DSH 会话出现在 AgentKib 的会话列表，打开后显示 DSH 中的历史；页头显示“已连接” |
| 发送与停止 | 从 AgentKib 发送后 DSH 开始新一轮，回复流式显示；运行中停止会结束本轮 |
| 工具审批（`bash`） | AgentKib 先答：DSH 界面撤下卡片，工具继续执行。DSH 先答：AgentKib 撤下卡片，已打开的作答框说明已在 DeepSeek Harness 中处理 |
| 问答（`ask_user_question`） | 两边都可作答，先答者生效，另一边撤下 |
| 排队、引导、编辑、撤回 | 运行中按默认设置回车排队，消息出现在输入框上方的待发条；“引导”加入本轮、删除、“… → 编辑消息”都在 DSH 中生效，轮次进行中和轮次结束后各验证一次；流式期间不再出现 `rate_limited` |
| DSH 在会话打开时退出 | 保留已读历史，变为仅可查看，原因浮在输入框上方 |
| DSH 未运行时启动 AgentKib | 会话照常列出，打开时不再报“请求失败” |
| DSH 重新运行 | 自动重新连接；离线时打开过的会话重新读取历史 |
| DSH 运行中重启 AgentKib | 页头恢复“已连接”，没有错误提示 |
| 界面 | 删去的提示不再出现；待发条为实心背景；提示出现或消失时输入框位置不变 |

## 真实 DSH 沙箱验收（手机，Android 模拟器）

2026-11-04 22:10–22:32（本机时间）。Android 模拟器 `AgentKib_QA_API35`（API 35，无窗口模式）上安装 agentkib-flutter 工作树构建的 dev 版 debug 包，连接上面同一个沙箱桌面 Host：

- 连接：沙箱桌面 Host 的 Web 服务绑定本机回环端口，前面加一层只用于本次测试的 HTTPS 代理；证书为本次生成、两天有效的自签证书，只通过 dev 构建的 `AGENTKIB_TEST_CA_PEM_BASE64` 信任，`adb reverse` 转发端口。配对用桌面端生成的全权限八位码。
- 没有登录账号，没有使用中继，没有碰真机 iPhone（`flutter devices` 里有一台已连接的真机，全程没有选它）。
- 结束后：卸载模拟器里的 dev 包，移除端口转发，关闭模拟器，删除测试证书私钥。

| 场景 | 结果 |
| --- | --- |
| 连接与列表 | 手机配对成功；会话列表显示 DSH 图标；页头“在 DeepSeek Harness 中运行 · 已连接” |
| 空闲时发送 | 消息经 Host 到 DSH，回复流式显示 |
| 运行中发送（手机默认是“加入本轮”） | **修复前失败**（见下表）；修复后 Host 接受，DSH 把消息收进当前轮次，手机没有错误提示，草稿清空 |
| 停止 | 点输入框右侧的停止键，轮次结束，回到已连接空闲 |
| 审批 | DSH 触发 `bash` 审批，手机出现卡片（命令、拒绝、允许一次）；允许一次后 DSH 执行工具，回复 `AK-TOOL-DONE` |
| 问答 | 手机出现问题卡片（Red、Blue、自定义回答）；选 Blue 提交后 DSH 收到 `selected:["Blue"]` |
| DSH 退出 | 手机显示“DeepSeek Harness isn't connected · Open DeepSeek Harness on the computer to continue”，历史保留，发送键不可用 |
| 冷启动 | 强制停止后重新打开：收件箱显示在线和进行中的会话，会话页正常打开 |

### 手机验收中发现并已修复

| 现象 | 原因与修复 |
| --- | --- |
| 运行中发送后，手机显示“请求无法完成，请刷新”和“结果未知”，之后发送键点了没有反应；强制停止再打开，会话页一直停在“正在连接” | 手机本地保存待确认控制时，名单里没有 `deepseek-harness`。Host 其实已接受，但手机读回本地记录时抛出 `Invalid pending identity`，所有后续控制和启动时的核对都被挡住。已把它加入名单，并加回归测试：客户端受控的每个 agent 都必须能写入并读回待确认记录 |
| 重复请求和回执里的状态是“结果未知” | Host 在把请求标为已完成之前就生成了回执，里面的实时状态是“登记未决时”的快照。已改为状态落定后用落定的状态重写，并在单元测试里断言 |

## 补充验收（2026-11-05）

同一个沙箱（AgentKib 桌面 dev 版、沙箱 DSH 0.2.1-rc.5、mock 模型）上补完一期剩下的项目。

| 场景 | 结果 |
| --- | --- |
| 插件安装流程 | 用 `dsh plugin add` 把打包目录装进沙箱 DSH 的 profile（链接方式），重启 DSH 后插件从 profile 加载并连上，兼容性为 verified |
| 两个 DSH 同时运行 | 会话页提示有多个 DeepSeek Harness 在运行；在其中一个打开该会话后恢复可控，消息发到了打开它的那个 DSH |
| Web 客户端（无头 Chrome，英文） | 配对、页头“Running in DeepSeek Harness · Connected”、发送与回复、待发条（引导、编辑、删除）、审批、DSH 先答后 Web 端提示 “This request was already handled in DeepSeek Harness.”、DSH 退出后仅可查看并保留历史（提示浮在输入框上方，输入框不移动）、重启 DSH 后 8 秒内恢复；其中待发条一项发现缺陷，见下表 |
| 手机：待发队列面板 | 长按发送键选“Add to queue”；队列面板每行有 “Insert into current turn”，点后该条进入当前轮次 |
| 手机：DSH 先答 | 已打开的作答面板显示 “Already handled in DeepSeek Harness”，选项和提交都不可用 |
| 手机：四种语言 | 页头分别为“在 DeepSeek Harness 中运行 · 已连接”“在 DeepSeek Harness 中執行 · 已連線”“DeepSeek Harness で実行中 · 接続済み”“Running in DeepSeek Harness · Connected” |

### 补充验收中发现并已修复（修复在二期 2a 的未提交改动里）

| 现象 | 原因与修复 |
| --- | --- |
| 新配对的浏览器第一次排队的消息不出现在待发条上，消息本身照常执行；之后的排队都正常 | DSH 在回复排队请求之前就上报了队列变化，此时 Host 仍在处理这次控制，会以 `operation_busy` 拒绝所有读取，待发条读队列失败后不再重试。待发条改为遇到 `operation_busy` 稍后重读，并在本会话的控制落定（receipts）时再读一次；桌面端与 Web 端同改，加回归测试 |
| DSH 重启后的第一次发送，页面短暂出现“结果未确认” | 请求已送达、DSH 尚未回复时，实时状态把这条仍在等待的请求算作结果未知；DSH 恢复会话较慢时，期间的状态上报就会带出这个提示。等待中的请求现在只让会话显示为忙，不算未确认；加回归测试 |
| 手机：队列面板里删除一条后显示 “The conversation changed. Reload this form before submitting”，点重新加载后才更新 | DSH 在删除完成后才上报队列变化并推进 revision，手机只在自己的操作之后读队列。手机改为收到 Host 的队列变化通知时重新读取；加回归测试 |
| 手机：每次打开 DSH 会话，`/managed/settings` 返回 500 | 一期 DSH 不提供设置读取。二期 2a 起提供模型设置；目标读取也改为返回“不可用”而不是报错 |

另有两处与 DSH 无关、没有处理：Web 客户端在无头 Chrome 中每次重新加载页面后界面语言回到简体中文；控制进行中读取会话事件会收到 409 `operation_busy`（Host 的既有行为，客户端会重读，界面上没有提示）。

## 桌面端沙箱验收截图与日志位置

截图与日志在本次会话的临时目录 `$SCRATCH/acceptance/run/`（手机部分在 `$SCRATCH/phone/`），没有纳入仓库：

- AgentKib 截图 `s1.png`–`s27.png`，DSH 界面截图 `d1.png`–`d4.png`；
- `mock-calls.log`、`electron.log`；
- `dsh.log` 含沙箱 DSH 的本机访问 token，不摘录。

## 验收与测试中发现并已修复

| 现象 | 原因与修复 |
| --- | --- |
| AgentKib 启动后打开 DSH 会话报“请求失败” | DSH 未运行时历史读取抛错，而列表仍标为可读。改为始终可读：DSH 未运行时返回本次已读的分页或空的最新页，更早的分页不伪造 |
| DSH 未运行时会话从默认列表消失 | 同上，会话不再被归入“无历史内容” |
| 流式期间出现 `rate_limited` | 待发条在每次实时更新时都重新读取队列。改为只在 Host 发出队列变化时读取 |
| 引导后结果一直待确认 | Electron 路由的操作白名单缺少 `queue-steer`。已补上，并加测试 |
| 认领前被拒绝的请求显示为结果未知 | 预检拒绝改为返回 not-dispatched 并附原因 |
| 流式期间排队显示“未执行”（`stale_state`） | 每段流式文字都推进 revision。改为只随控制相关状态变化 |
| 自动核对抢先结算了仍在等待的请求 | 核对跳过仍在等待结果的请求 |

## 未覆盖

- 手机（Flutter）只在 Android 模拟器上验收过，没有 iOS 模拟器或真机；经 HTTPS 代理直连，没有走中继。手机上没有覆盖会话被其他进程占用或有多个 DSH 时的提示。
- AgentKib Web 客户端只在本机无头 Chrome 上验收过，没有经中继访问。
- 没有验证 DSH 升级后插件未加载的提示。
- DSH Desktop 应用及其保留的 `desktop` profile。
- 会话被其他进程占用。
- 以下只有自动化测试：
  - 权限撤销；
  - 多设备状态一致；
  - 断网后结果未知的核对。
- 计时问题、可继续的问题、plan-review，以及带 `approval` intent 的问题。
- 真实模型；Windows／Linux（DSH 接入只支持 macOS）。

## 已知问题

- 已修复：每设备每分钟 600 次的限流原先排在控制分类之前，拦下控制请求时 429 响应里没有 `controlOutcome`，客户端只能当作结果未知，所有 Agent 都受影响。现在先分类再限流，被拦下的控制返回 `not-dispatched`；`service.test.ts` 新增回归测试，撤掉修复时该测试失败。
- 手机端没有改动以下两处：
  - 运行中排队仍用原队列面板，不是输入框上方的待发条；
  - 发送后的“已接收”提示仍保留。
