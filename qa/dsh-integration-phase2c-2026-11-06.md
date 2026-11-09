# DeepSeek Harness 二期 2c（目标、斜杠命令、压缩、权限预设、子代理）QA — 2026-11-06

本文记录二期 2c 的源码、自动化结果和真实 DSH 沙箱验收：目标、斜杠命令、压缩、权限预设（执行策略）、子代理浏览，以及本轮一并完成的两项通用改动：不再常驻显示未验证版本提示，桌面端 Claude 与 DSH 的模型选择改用输入框里的选择器（与 #200 中的 Codex 一致）。结论只适用于下列源码与版本。方案见[接入方案](../docs/agents/deepseek-harness.md) §7 的“2c 实现”，2b 记录见[二期 2b QA](dsh-integration-phase2b-2026-11-05.md)。

## 源码与边界

- AgentKib：`origin/main` `3035d5c80`（含 #200、#201、#202）之上，分支 `dsh-2c`，提交 `d53d35770`（运行时路由）、`38185c1f4`（2c）与本记录；验收在提交前的同一份改动上进行。
- agentkib-flutter：`origin/main` `e83d596`（含 #6）之上，分支 `dsh-2c`，提交 `9fcb624`（夹具只改格式）与 `467ca26`（2c，夹具清单指向 `38185c1f4`）。
- DSH：本机安装的 DeepSeek Harness `0.2.2-rc.1`（由 `0.2.1-rc.5` 自动升级，兼容状态为“未验证”）。所用接口在安装包 `app.asar` 中逐项核对：命令表 `list/find/execute`、目标服务（全部同步，以 `GoalError` 拒绝）、权限预设目录与 `permissions` 投影、`compaction/*` 事件、子代理投影，以及 DSH 聊天界面的可见性规则。插件 `agentkib-dsh-bridge 0.4.0`。
- 模型：本机 OpenAI 兼容的合成 provider，`mock-model` 与 `mock-reasoner`（low、high）。DSH 一侧真实模型请求 **0**。
- 沙箱与 2a、2b 相同：AgentKib 桌面开发版、独立 HOME 与数据目录；DSH 自己的 Web 界面在独立 profile 的无头 Chrome 中操作。桌面界面为简体中文，Web 为英文（新 profile 的无头 Chrome，以完整授权码配对），手机为 Android 模拟器 `AgentKib_QA_API35`（英文）。没有读取或修改用户真实的 `~/.dsh`、`~/.agentkib`、`~/.claude`、`~/.codex` 或 Chrome profile。
- 没有新增生产依赖，持久化结构不变（结果未知的核对记录多了可选的目标字段）。插件与 Host 的私有协议新增 `goal`、`goal-control`、`command`、`permissions`、`subagents` 命令，发送命令带 `fullAccess`；上报新增全局与各运行中 Agent 的命令表、目标与设置变化，会话状态新增 `activity` 与目标引用。设置中的模型选项新增可选的 `group`（提供方）。

## 实现范围

- 斜杠命令：消息以会话 Agent 的命令开头时由 DSH 的命令表执行，不交给模型，运行中也可以。插件按会话的 Agent 判断（0.2.2-rc.1 的 `/compact`、`/goal`、`/plan` 只在运行中 Agent 自己的命令表里）。插件与各端 `/` 菜单共用一份规则：`/export` 不替用户运行，带附件的命令不运行，`/goal`、`/permission` 和其他插件的命令要求完整访问的设备（Host 随消息带上 `commandAccess`）。成功的权限切换与 DSH 窗口一样不进会话记录，失败的保留原因。
- 目标：经目标服务设置、暂停、恢复、清除，修改带目标 ID 与 revision；按轮次限制，不显示 token 预算；DSH 恢复会话后未自动继续的目标显示为已暂停。
- 压缩：`/compact` 与 Web 的压缩按钮都运行 DSH 的命令，压缩期间各端显示正在压缩。
- 权限预设：作为执行策略，运行中也可以切换，模型与推理强度仍等本轮结束。
- 子代理：手机只读浏览。
- 通用改动：各 Agent 不再常驻显示未验证版本提示；桌面端 Claude 与 DSH 在输入框切换模型与推理强度，DSH 模型按提供方分组，Claude 与 DSH 未选强度显示为默认，没有服务档位时不显示 Fast；执行策略选择框显示选项名；目标面板只说明当前目标可用的操作为何不可用；输入框识别开头或空格后的 `/plan`，计划模式显示为可点击退出的“计划”标识。
- Flutter：DSH 斜杠命令菜单、目标轮次、运行中切换预设的说明、子代理入口与各拒绝原因的四语文字；目标表单未修改时跟随会话自动重新读取；DSH 夹具统一为标准 JSON 格式后补充 2c 数据。
- 桌面主进程：运行时路由转发子代理读取（此前所有 Agent 的手机子代理浏览都不可用）。

## 自动化检查

| 检查 | 结果 |
| --- | --- |
| AgentKib 类型检查（backend、desktop、web） | 通过 |
| oxfmt（改动的代码文件）／oxlint | 通过；oxlint 0 错误，警告都在未改动的行上 |
| Web 全部 | 85 个文件，1793 通过 |
| Desktop 全部 | 518 个文件（1 个跳过）：10074 通过，3 跳过 |
| `flutter analyze` | 无问题 |
| Flutter 应用测试 | 1042 通过，1 跳过 |
| `agentkib_client` 包测试 | 269 通过 |

此前两次 Desktop 全量各有 `claude-web-backend-integration.test.ts` 的一个用例在负载下超过 5 秒上限（5208 毫秒等），该文件单独运行 39 通过、1 跳过，与 2b 记录的全量负载下 Claude 目标自动化用例超时相同；上表为最终一次全量结果。

修复都有回归测试，并逐一撤掉修复确认对应测试失败：执行策略显示选项名、历史中略去成功的权限切换、目标面板只说明可用操作、没有服务档位时不显示 Fast、运行时路由转发子代理读取、手机目标表单跟随会话。

## 真实 DSH 沙箱验收

2026-11-06 11:58 至 2026-11-07 10:50（本机时间）。验收中途以最新 `origin/main` 重建沙箱，插件改动后重启 DSH。

### 桌面端（简体中文）

| 场景 | 结果 |
| --- | --- |
| `/` 菜单 | 会话在 DSH 中运行时列出 `/compact`、`/feedback`、`/goal`、`/permission`、`/plan`，不含 `/export`；未运行时只有 `/feedback`、`/permission` |
| `/plan`、`/plan off` | 记录中显示命令与 DSH 的回答“Plan mode on. Use /plan off to leave.”“Plan mode off.”，模型调用 0 次 |
| `/export` | 未发送，显示“这个命令只能在 DeepSeek Harness 自己的窗口里使用，本次消息尚未发送。”，草稿保留 |
| 以路径开头的消息 | `/private/tmp is a path` 作为普通消息交给模型 |
| 目标（界面） | 开始后输入框上方显示“进行中”与目标内容，轮次按 1 / 256 计，没有 token 预算输入；之后显示已暂停（44 / 256，见“观察”），恢复后继续一轮，清除后目标条消失 |
| 目标（命令） | `/goal …` 创建并显示目标条；`/goal pause` 回答“Goal paused … Activation: disarmed”；`/goal clear` 回答“Goal cleared.” |
| 压缩 | `/compact` 后约 1 秒显示“正在压缩上下文”，DSH 随后报告“Compacted … history items”；发送约 4 秒返回（修复前 8 秒以上，见“发现的问题”3） |
| 执行策略 | 空闲时切到 Full access；运行中执行策略可改，模型与推理强度置灰并提示“当前轮次结束后才能修改模型和推理强度”，切到 read-only 后显示“设置已由这台电脑确认” |
| `/permission` | `/permission danger-full-access` 与 `/permission workspace-write` 生效；修复后会话记录不再出现这两条，失败的 `/permission root` 连同 DSH 的错误说明保留 |
| 未验证版本 | 会话页与 DSH 连接面板只显示“版本 0.2.2-rc.1”，没有未验证提示 |
| 计划模式 | 输入 `/plan` 回车：草稿清空，DSH 记录“/plan”与“Plan mode on. Use /plan off to leave.”，设置入口右侧出现“计划”标识，输入框提示“描述你的任务以生成计划…”；文字末尾输入 ` /pl` 时菜单只有“/plan 开启计划模式”，回车后草稿只剩前面的文字；点标识后 DSH 记录“/plan off”与“Plan mode off.”，标识消失 |
| DSH 自己的界面 | 显示 AgentKib 发出的 `/plan`、`/goal`、`/compact` 及回答；预设显示“工作区内修改”；在 DSH 中改为“仅可查看”后 AgentKib 的执行策略随之变为 read-only |

### Web 客户端（英文，无头 Chrome 新 profile）

| 场景 | 结果 |
| --- | --- |
| `/` 菜单 | 会话未运行时只有 `/feedback`、`/permission`；发一条消息后为 `/compact`、`/feedback`、`/goal`、`/permission`、`/plan`，没有 `/export` |
| `/plan`、`/export` | `/plan` 由 DSH 执行；`/export` 显示“This command only works in DeepSeek Harness's own window, so the message was not sent.”，`POST /send` 409 `dsh-command-window-only` |
| 目标 | 从输入框“+”打开 Persistent goal：Rounds 1 / 256，没有 Token budget；暂停后本轮立即结束；恢复后 Rounds 2 / 256；停止本轮后目标为 Paused；清除后目标条消失 |
| 执行策略 | 运行中可改，模型与推理强度提示“The model and reasoning effort can be changed after the current turn finishes”；切换后会话里没有 `/permission` 消息 |
| 压缩 | 上下文用量未上报，没有压缩按钮，改发 `/compact`：显示“Compacting context”，DSH 回答“Compacted 19 history items (~4793 tokens).” |

### 手机（Android 模拟器，英文）

2026-11-06 23:50 至 2026-11-07 00:30，Flutter 分支 `dsh-2c` 的调试包，经本机 TLS 代理连接沙箱 Host。

| 场景 | 结果 |
| --- | --- |
| `/` 菜单 | 列出 `/compact`、`/feedback`、`/goal`、`/permission`、`/plan`，没有 `/export`；分组名“DeepSeek Harness commands”只作为无障碍标签 |
| `/plan`、`/export` | `/plan`、`/plan off` 由 DSH 回答，模型调用 0 次；`/export` 未发送，显示“This command only works in DeepSeek Harness's own window, so the message was not sent”，草稿保留，`/send` 409 `dsh-command-window-only` |
| 目标 | 会话控制 → Goal：开始后“Active”“1 of 256 rounds started”，没有 token 预算；暂停、恢复、停止本轮（之后为 Paused）、清除均生效。首轮每次操作后都要求重新加载（见“发现的问题”7），修复后开始、暂停、清除都不再出现该提示 |
| 执行策略 | 运行中可改（手机上标为“Permissions”），模型与推理强度提示“The model and reasoning effort can be changed when the conversation is idle”；改为 read-only 后会话里没有 `/permission` 消息；空闲时改回 workspace-write |
| 子代理 | 首轮 `GET /subagents` 一直 500、没有入口（见“发现的问题”6）；修复后会话上方显示“Subagents”，列表为“AK child probe · Completed”，打开是只读面板，显示子代理收到的提示与回复 |
| 压缩 | `/compact` 后 DSH 回答“Compacted 16 history items (~3968 tokens).” |

## 发现的问题

均已修复并在真实 DSH 上复验，修复都有回归测试，并逐一撤掉修复确认对应测试失败。

1. **执行策略选择框显示原始 ID**：桌面端收起时显示 `danger-full-access` 等 ID（与 `origin/main` 上 Codex 的同一控件相同）。改为显示选项名。
2. **切换执行策略留下“/permission …”消息**：设置对话框与 DSH 自己的预设菜单都通过 `/permission` 切换，AgentKib 把每次切换显示为一条用户消息和“preset …”回答；DSH 的聊天界面按其可见性规则不显示权限命令。插件读取历史时同样略去成功的切换，失败的保留原因。
3. **命令等待占住 Host 的读取**：插件为等命令结果最多等 8 秒，Host 在控制进行中不回答任何读取，`/compact` 期间 Web 收到 28 个 409 `operation_busy`（其中 `/catalog` 约每秒 4 次）。等待改为 2 秒：DSH 自己的命令毫秒级完成，压缩在后台继续。
4. **目标面板在没有目标时列出三行原因**：桌面与 Web 都显示三行“目标当前的状态不能这样操作”。改为只说明当前目标可用的操作为何不可用。
5. **模型选择仍是旧方式**（用户指出）：#200 已让 Codex 在输入框切换模型与推理强度，DSH 与 Claude 仍在设置对话框中切换。改为三者都用输入框选择器，DSH 按提供方分组。真实 DSH 上 mock-model（无推理等级）显示“默认”，切到 mock-reasoner 后显示两档滑块与“默认”，没有 Fast。
6. **手机子代理浏览对所有 Agent 都不可用**：桌面主进程的运行时路由按操作名分派 `web.request`，名单里没有 `subagents` 与 `subagent-events`，两者都报“没有后端处理者”，HTTP 500。该功能（2026-11-02）的测试都替换了运行时，没有经过这层路由，此前也未做真实端到端验收。已加入只读读取名单并补路由测试；Codex 与 Claude 走同一路由，尚未单独真实验收。
7. **手机目标面板在自己的操作后要求重新加载**：DSH 的一次目标操作会接连改变几次会话 revision（目标、自动继续、轮次），手机表单把读取后的变化都当作别处的修改，提示“The conversation changed. Reload this form before submitting”并禁用按钮。改为与 Web、桌面一致：未修改的表单自动跟随会话重新读取，改过的表单保留草稿并提示（手机端对所有 Agent 生效）。
8. **计划模式没有状态标识**（用户指出）：#200 让设置入口只显示图标后，Codex 的“计划”标记随之消失，Claude 与 DSH 改用输入框选择器后也一样。按 Codex 与 DSH 自己的输入框统一：识别开头或空格后的 `/plan`，选中即开启计划模式并显示可点击退出的“计划”标识（Codex 协作模式、Claude plan 权限模式、DSH 自己的 `/plan`）；DSH 的计划模式同时作为协作模式出现在设置中。

## 观察（非本轮问题）

- DSH 刚启动时插件已向 Host 注册，但会话服务可能晚几秒就绪，此时打开会话读历史失败（`dsh-history-unavailable`），桌面客户端不自动重试，点“重新连接”后正常。一期起即如此；三期由 AgentKib 启动 DSH 后会立即读取历史，届时需等待或重试（已写入接入方案三期）。
- Web 收到 409 `operation_busy` 后没有退避地重读，是 Host 在控制进行中拒绝读取的既有行为；问题 3 修复后持续时间缩短。
- 执行策略的选项名是 Host 下发的英文，与 Codex 相同。
- 目标对话框标题下的“已选: N”是 Codex 目标对话框既有的资源计数。
- 诊断区对不可用能力使用通用文案“这台电脑未提供或尚未验证此能力”，与版本无关。
- 验收子代理在目标运行中因额度中断，DSH 按设计自动继续了 44 轮（每轮约 2 分钟），之后已暂停并清除。

## 已知限制

- 子代理只能在手机浏览，Desktop 与 Web 暂无视图。
- Agent preset 的切换未纳入 2c。
- 输入框模型选择器只在桌面端；Web 与手机仍在设置中切换模型（Codex 也是）。
