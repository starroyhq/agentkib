# DeepSeek Harness 二期 2a 接入 QA — 2026-11-05

本文记录二期 2a（重命名、分叉、归档、模型与推理强度、新建会话）的源码、自动化结果和真实 DSH 沙箱验收。结论只适用于下列源码与版本。方案与规则见[接入方案](../docs/DEEPSEEK-HARNESS-INTEGRATION.md) §7，一期记录见[一期 QA](dsh-integration-phase1-2026-11-04.md)。

## 源码与边界

- AgentKib：一期提交 `b2a2e27e05239171eeb26c008f42398071a1f75b`（工作树分支 `worktree-dsh-integration`）之上，本轮修改未提交。
- agentkib-flutter：一期提交 `c309c03`（分支 `dsh-integration`）之上，本轮修改未提交。
- DSH 接口按 DeepSeek Harness 源码 `8bd0733`（0.2.2-alpha.3）核对；沙箱验收用本机安装的 DeepSeek Harness `0.2.1-rc.5`。两者有差异时以安装版的实际行为为准，见下文“模型读回”。
- 插件：`agentkib-dsh-bridge 0.2.0`，以 `dsh plugin add` 的链接方式装在沙箱 DSH 的 profile 里，打包目录随 AgentKib 构建更新；插件改动后重启 DSH 生效。
- 模型：本机 OpenAI 兼容的合成 provider，两个模型 `mock-model`（无推理强度）与 `mock-reasoner`（low、high），每次调用记录所用模型与强度。真实模型请求 **0**。
- 沙箱与一期相同：AgentKib 桌面开发版、独立 HOME 与数据目录；DSH 一侧用它自带的 Web 界面在独立 profile 的无头 Chrome 中操作；手机为 Android 模拟器 `AgentKib_QA_API35`。没有读取或修改用户真实的 `~/.dsh`、`~/.agentkib`、`~/.claude`、`~/.codex` 或 Chrome profile。
- 没有新增生产依赖或持久化结构；控制账本沿用一期的表，新建会话多记录两个证据字段（预留的会话 ID 与认领时间）。

## 实现范围

- 插件 0.2.0：重命名、分叉、新建（AgentKib 预留会话 ID）、归档与取消归档（跟随 DSH 的归档集合）、读取模型目录与会话当前模型、切换模型。
- Host／backend：
  - 按能力开放上述操作；运行中归档和改模型的原因为 `session-busy`；
  - 模型设置读取与切换，“恢复默认”；
  - 新建会话及其选项，多个 DSH 时原因为 `dsh-create-ambiguous`；
  - 结果未知的核对（标题、归档状态、模型选择、预留会话是否出现）；
  - 分叉与新建在回复前等待新会话出现在列表中（最多三秒）；
  - 目标读取返回“不可用”。
- Desktop／Web：会话操作对话框（重命名、分叉、归档）与 DSH 连接面板；对话设置只显示模型与推理强度；新建任务可选 DeepSeek Harness。
- Flutter：新建对话可选 DeepSeek Harness（无高级设置行，原因有本地化文字）；对话设置只显示模型与推理强度；收到队列变化通知时重读队列。

## 自动化检查

| 检查 | 结果 |
| --- | --- |
| AgentKib 类型检查（backend、desktop、web） | 通过 |
| oxfmt（改动文件）／oxlint | 通过；oxlint 0 错误 |
| Desktop：会话功能、Electron 主进程与 DSH bridge（133 个文件） | 2217 通过 |
| Web 全部（85 个文件） | 1790 通过 |
| `flutter analyze` | 无问题 |
| Flutter 应用测试 | 1037 通过，1 跳过 |
| `agentkib_client` 包测试 | 264 通过 |

除表单过期提示的文案和重命名按钮的悬停提示，每个修复都有回归测试；逐一撤掉修复后对应测试失败，恢复后通过。

## 真实 DSH 沙箱验收

2026-11-05 11:30–16:30（本机时间），分两轮：第一轮发现的问题修复后重建沙箱，失败和部分通过的项目在修复后的构建上复验。下表为最终结果。

### 桌面端（沙箱界面为繁体中文）

| 场景 | 结果 |
| --- | --- |
| 会话操作 | 重命名、归档、分叉可用；DeepSeek Harness 连接面板显示已连接 1 个 DSH、版本 0.2.1-rc.5 |
| 重命名 | 页头与侧栏 0.2 秒内更新，DSH 自己的界面显示同一标题；运行中也可重命名 |
| 模型与推理强度 | 设置只有模型和推理强度两行；选 mock-reasoner／高并套用后不再变回，显示已确认，输入框的模型显示为 mock-reasoner；模型日志为 `model=mock-reasoner effort=high`，切回后为 `model=mock-model` |
| 运行中 | 归档与改模型不可用，提示“此操作需要對話閒置，請等待目前輪次結束。”；重命名与分叉可用；连接面板始终显示已连接 |
| 归档 | 从 AgentKib 归档和取消归档，DSH 两边同步；在 DSH 自己的界面归档和取消归档，AgentKib 0.3 秒内跟上 |
| 分叉 | 0.34 秒打开副本，副本历史到最后一个完整轮次，源会话不变，DSH 列出副本 |
| 新建会话 | “新增任務”的执行工具有 DeepSeek Harness，选中后只有工作区；建立后打开新会话，没有“结果未确认”，发消息正常回复 |

### Web 客户端（无头 Chrome，全新 profile，英文）

| 场景 | 结果 |
| --- | --- |
| 全新浏览器的第一条排队消息 | 显示在待发条上（一期缺陷已修复）；出现在排队请求返回之后，约 3.4 秒 |
| 会话操作 | Rename、Fork session、Archive；运行中 Archive 不可用，提示 “This operation requires an idle session. Wait for the current turn to finish.” |
| 模型与推理强度 | 只有模型和推理强度两行；mock-reasoner／Low 套用后不再变回，显示 “The computer confirmed these settings”；模型日志为 `model=mock-reasoner effort=low` |
| 新建会话 | New task → DeepSeek Harness → Create，0.2 秒打开新会话，没有 “Connection lost” 或结果未确认，发消息正常回复 |
| 网络 | 全程没有 `/codex/*` 请求，没有 403 或 500；非 2xx 只有发送或套用瞬间的 409 `operation_busy`（Host 的既有行为，客户端会重读） |

### 手机（Android 模拟器，英文）

agentkib-flutter 工作树（含本轮未提交改动）构建的 dev 版 debug 包，连接方式与一期相同（本机回环 + 本次生成的自签证书 + `adb reverse`），结束后卸载、移除转发、关闭模拟器、删除私钥。

| 场景 | 结果 |
| --- | --- |
| 打开 DSH 会话 | 页头 “Running in DeepSeek Harness · Connected”，输入框的模型显示 `mock/mock-model`；`GET /managed/settings` 返回 200（一期为 500） |
| 会话菜单 | Conversation settings、Goal、Queue、Rename、Archive、Fork conversation；Take control 不可用 |
| 重命名 | Host 接受，会话列表、电脑端目录和 DSH 自己的界面都显示新标题；已打开页面的页头当时没有更新，见下表 |
| 模型与推理强度 | 设置只有 Model 与 Reasoning effort；mock-reasoner／High 保存后不变回，重新打开仍是 mock-reasoner／High；模型日志 `model=mock-reasoner effort=high`；切回 mock-model 后读回正确 |
| 目标 | 打开后显示 “This host does not support this operation”，没有错误；`GET /managed/goals` 返回 200 |
| 队列删除 | 删除后面板自动变为 “Queue · 0 / Nothing here yet”，不再出现 “The conversation changed” 提示（一期缺陷已修复） |
| 分叉 | 打开副本（不同会话 ID），DSH 会话数加一，源会话不变 |
| 归档 | 确认后回到列表，副本出现在 Archived 筛选中，菜单改为 Unarchive；取消归档后恢复 |
| 新建对话 | Agent 分段控件为 Codex／Claude Code／DeepSeek Harness（第三个标签折成两行，没有截断）；选 DeepSeek Harness 时没有 Advanced settings 行；首条消息自动发送并收到回复 |

全程代理日志里非 2xx 只有打开会话页时的 `GET /read-state` 404（一期已有，界面无提示）；`/managed/*` 没有 403 或 500。

手机验收中发现并已修复，重新构建后在模拟器上复验通过：

| 现象 | 原因与修复 | 复验 |
| --- | --- | --- |
| 每轮结束后输入框的模型变成 “Model not reported”，重新打开会话才恢复 | DSH 的实时状态不带设置，而手机只在打开页面和保存设置后读取设置，轮次推进 revision 后旧读数不再算当前。改为会话空闲且 revision 变新时重读一次（与 Web 相同，流式期间不读）；加回归测试 | 两轮结束后都显示 `mock/mock-model`，代理日志里每轮结束后各有一次 `GET /managed/settings` 200 |
| 重命名后已打开页面的页头和设置、队列等面板的副标题仍是旧标题 | 它们用的是打开页面时带入的会话摘要。改为：目录里这条会话的标题变化后改用目录的标题（所有 Agent）；加回归测试 | 不离开页面，4 秒内页头变为新标题，设置和队列面板的副标题也是新标题；改回后同样 |
| 没有推理强度的模型仍显示 “Reasoning effort · Unknown” 一行 | 所选模型没有可选强度时不显示这一行；加回归测试 | mock-model 时没有这一行，切到 mock-reasoner 后出现 Low／High |

复验时还看到：轮次运行期间输入框的模型仍显示 “Model not reported”，轮次结束后恢复。原因是运行中 revision 前进，旧读数不再算当前。已改为对实时状态不带设置的 Agent，运行中继续显示上一次读到的模型（运行中不能改设置；“待生效”标记不沿用）；只有单元测试覆盖，没有再上模拟器复验。

### 没有处理的观察

- 桌面窗口在后台时 Chromium 把页面定时器限到约每秒一次，桌面上测得的点击到跳转时间因此偏长（Web 同样的操作 0.2 秒）。
- 验收脚本自己以约 150 毫秒一次的频率读取时触发了每设备限流（429），页面停在“已斷線”，点“重新連線”后恢复。正常使用不会有这个频率；页面遇到 429 后不会自动恢复，属于所有 Agent 共有的行为，没有在本期处理。

## 验收中发现并已修复

| 现象 | 原因与修复 |
| --- | --- |
| 新建 DSH 会话后，桌面端和 Web 的新建对话框一直显示“结果尚未确认”，之后打开任何会话都停在“正在载入” | 浏览器本地保存待确认控制时，名单只有 `codex` 和 `claude-code`；DSH 会话其实已建好，但清除这条记录时读取失败，之后每次读取都失败。名单改为按 Agent 类型穷举（新增 Agent 漏写时类型检查不通过），加回归测试 |
| 改模型后，对话框和输入框里的模型又变回默认，DSH 自己的界面里已是新模型 | 0.2.1-rc.5 上从运行中的 agent 读取当前模型一直得到默认模型。改为读取会话的 `modelSelection` 投影，与 DSH 自己的模型选择器一致；在沙箱中经 Host 切换后读回为新模型并显示已确认 |
| 新建会话的回复丢失时会打开不存在的会话，且结果无法确认（自查发现） | 新会话的 ID 改由 AgentKib 预先生成并交给 DSH，回执直接指向新会话；结果未知时按该会话是否出现在列表判定 |
| 分叉或新建后立即打开新会话，可能遇到会话尚未列出（自查发现） | DSH 先回复、下一次上报才列出新会话。回复客户端前最多等三秒 |
| 对话设置里出现 Codex 的协作模式、服务等级和执行策略，显示原始占位值 | DSH 只提供模型与推理强度，三端都不再显示这几行 |
| 运行中模型和强度下方显示“这台电脑未提供或尚未验证此能力” | 运行中改为 `session-busy`，提示等本轮结束 |
| 运行中设置里同一句“请等待当前轮次结束”出现四次（模型、强度、整体各一条，加底部说明） | 设置区只保留底部的一条（所有 Agent）；目标面板等其他位置照常显示原因 |
| 设置表单过期提示写着“Codex 状态已变化” | 改为不指名的“会话状态已变化”（所有 Agent） |
| 重命名进行中，DSH 连接面板短暂显示“AgentKib 的连接服务没有启动” | Host 在控制进行中拒绝读取（`operation_busy`），面板把它当成服务未启动。忙时保留上一次的状态 |
| 重命名按钮可用时也显示“这台电脑未提供或尚未验证此能力”的悬停提示 | 与其他操作按钮一致，只在不可用时显示原因 |

## 已知问题与限制

- 分叉在原会话上没有证据：结果未知且超过两分钟时判为未执行；若实际已分叉，副本仍会出现在列表中。
- DSH 若对标题做规范化，结果未知时的重命名核对可能误判为未执行（重命名可重复执行，不会造成损失）。
- 置顶未接入；目标、子代理、附件、交接属于 2b–2d。
- 两个 DSH 同时运行时不能从 AgentKib 新建会话，需在要用的那个 DSH 里新建。
