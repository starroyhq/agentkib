# v15 B3 终端重连状态与恢复（2026-10-22）

基线：最新 `main` 的 `54b30806b202b727dd589301f3a4b1b82d4c0147`，已合入 B 收尾与其审查修复。分支 `codex/v15-b3-terminal-reconnect`。依据本机只读交接文件的共同约束、B3 实测结论与要求；不修改或复制设计文件。原工作区及其他工作树的无关修改保留。

## 实测依据与根因

交接记录中的 Claude Code 2.1.308 真实终端结果由用户提供，本轮不声称重复真实验收：终端退出后绑定还在，恢复会话能自动连接；AgentKib 重启后现存终端不能重连；旧界面误显示首次连接步骤或要求重用已消费的连接命令，离线清除入口随之消失。

已在合成宿主复现插件问题：连接中断后的重连请求失败会留下 `reconnecting` 临时 lease，后续 pump 提前退出，无法再重试；发终端事件也不能解除。恢复网络/服务后仍保持未连接。无账号、无模型请求、无真实配置读取。

前置能力调研确认可以使用现有宿主契约修复：官方 [后台计时器](https://code.claude.com/docs/en/plugins/mods/api#run-work-in-the-background) 支持事件间运行，现有 `$.clock.every` 已被 B2 检查；[事件参考](https://code.claude.com/docs/en/plugins/mods/reference#prompts-and-what-claude-reads) 提供现有 prompt/turn 生命周期事件。实现不增加私有宿主接口，不扩展最低版本、已验证清单、能力集合或生产发送能力。静态契约、原生插件引擎中的合成测试和真实终端验收分别记录。

## 验收清单

| 行为 | 回归与交互检查 | 视觉证据 |
| --- | --- | --- |
| 终端退出或桌面重启后，保留可恢复绑定 | 后端持久化状态、无在线 lease 的状态；UI 不依赖 follower 推断 | 四语等待重连 |
| 已安装步骤折叠、未连接中性徽标、中性图标 | 状态渲染、computed style、无瞬时警告文案 | 四语等待重连 |
| 复制继续命令 | 复用已验证的命令接口，工作目录/配置目录/UUID 按既有规则引号处理；完整复制与晚到响应 | 等待重连操作区 |
| 重新生成与清除入口保留 | 原地确认焦点、取消往返、ACK 及代际保护 | 四语清除确认 |
| 清除后不再自动连回 | 持久撤销、凭据失效、旧 lease/晚到重连不能复活 | 清除后首次连接步骤 |
| 桌面重启后插件可重试 | 离线请求失败、服务恢复、事件唤醒、并发/持续失败/身份变化 | 无视觉结论 |
| 连接码小时不补零 | 四语实际渲染、英文/繁体小时格式 | 四语等待连接 |
| 不支持平台不重复平台说明 | 无头部版本提示，卡片只保留平台原因 | 四语不支持平台 |

先补回归再实现。视觉验收隔离 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、运行数据、Electron profile，使用合成工作区和会话，不登录，不调用模型；非测试外网由沙盒阻断。默认视口和较小视口均检查边界，截图前核对个人信息已替换。探索场景包含清除确认时状态变化、复制中切换会话、重新生成后返回等待与清除。

## 实施与验证结果

### 修改范围与安全边界

- 后端 `bridge-status` 增加本地只读 `hasBinding`，仅当前目标与原绑定身份一致、未撤销且通过原校验时为 true；不把它作为在线、发送或停止权限。目标不可验证、坏注册表等错误保持原拒绝语义；UI 不把这种错误中的 false 当作撤销证明。没有修改私有传输协议、版本政策、持久化结构、能力清单或设备权限。
- 桌面向导保留独立的已验证绑定展示依据；lease 更换时保持中性等待，新的状态读取完成前仍禁用依赖新状态的动作。错误和结果未知保持原提示，清除入口不会因普通读取失败丢失。旧代际的连接码响应失效，撤销回执仍按原事务和代际处理；新的权威绑定能解除已经完成清除的本地屏蔽。
- 两端四语字典同步等待重连、复制继续和备用生成文案，删除要求重用已消费连接命令的提示。继续命令复用已有的身份/目录校验与 shell 引号逻辑，不在 Renderer 拼接。Web 保持原能力，没有新增本机安装/管理入口。修改时间格式及不支持平台重复行，不改变其他批次布局。
- 插件回收失败握手占位，合并并发重连；既有 250ms timer 按约 1/2/4/8 秒的跳过预算退避，终端 prompt/主轮次事件可后台唤醒。每次真实重连仍重读凭据并重做身份/版本/能力检查；原操作不等待重连，未知回执不重放 native send/stop，生产发送常量仍为 false。撤销、会话结束和晚到响应的代际保护保留。
- 更新终端连接文档、术语说明及插件 README。截图夹具补无在线 lease 的持久绑定状态，且生成连接码只改挑战，不伪造 lease 更换；生产代际断言未放宽。

### 自动化与独立核对

后端绑定状态先红 15 项，再全部转绿，覆盖历史增长、退出/租约过期、重启、首快照前状态、撤销后的 410 与未知账本。插件新增 10 项先红后绿，覆盖服务离线与恢复、定时/事件唤醒、退避、并发、凭据删除/410、身份变化和晚到响应。UI 针对读取失败、代际切换、复制、清除 ACK 和新绑定等边界先补回归再实现。

官方隔离检查：最低版 **2.1.301** 与 registry 最新版 **2.1.308** 均通过 strict validate 和原生插件引擎 **9/9** 测试；最新版另通过 6 组桥接安全套件 **240/240**。最低版使用 `--skip-bridge-tests`，桥接套件由最新版与桌面全量覆盖。网络与个人目录屏障通过；原生引擎中的新增重连用例仍使用合成 clock/http/store/fs，没有登录、真实配对或模型请求，不能据此新增已验证版本。

独立只读核对另以纯内存挑战验证旧 lease 晚到 410、撤销代际后晚到成功握手、未知回执恢复 3/3 保持安全。第一次桌面全量为 7859 通过、3 跳过；补充边界用例后的全量发现复制请求在按钮刚启用时可能被旧 passive cleanup 误取消（7861 通过、1 失败、3 跳过）。确定性提交阶段用例确认按钮为 enabled、请求发出后 signal 被误 abort、剪贴板未写入。将该取消 effect 改为 layout effect，在按钮可以接收输入前完成旧请求清理；原成功断言、取消条件和超时预算均保留。原用例与新增原生 click 回归连续 5 轮 10/10 通过，相关 UI 5 文件 157/157 通过；独立复核另重放 2/2 通过，当前无未解决 finding。

### 截图与交互

隔离 Electron **44.9.1 / Chromium 152.0.7977.167**，VTRON 浅色，默认原生渲染视口 **1360×860**。四语 × 4 个要求状态共 **16 张**：

| 状态 | zh-CN | zh-TW | en-US | ja-JP |
| --- | --- | --- | --- | --- |
| 等待重连 | [图](screenshots/v15-b3/zh-CN/reconnecting.png) | [图](screenshots/v15-b3/zh-TW/reconnecting.png) | [图](screenshots/v15-b3/en-US/reconnecting.png) | [图](screenshots/v15-b3/ja-JP/reconnecting.png) |
| 清除确认 | [图](screenshots/v15-b3/zh-CN/clear-confirm.png) | [图](screenshots/v15-b3/zh-TW/clear-confirm.png) | [图](screenshots/v15-b3/en-US/clear-confirm.png) | [图](screenshots/v15-b3/ja-JP/clear-confirm.png) |
| 不支持平台 | [图](screenshots/v15-b3/zh-CN/unsupported.png) | [图](screenshots/v15-b3/zh-TW/unsupported.png) | [图](screenshots/v15-b3/en-US/unsupported.png) | [图](screenshots/v15-b3/ja-JP/unsupported.png) |
| 等待连接 | [图](screenshots/v15-b3/zh-CN/waiting.png) | [图](screenshots/v15-b3/zh-TW/waiting.png) | [图](screenshots/v15-b3/en-US/waiting.png) | [图](screenshots/v15-b3/ja-JP/waiting.png) |

均宽 672px、高 214～644px，没有横向溢出、文字裁切或控件遮挡。英文长操作行自然换行，所有操作可见。等待图标实际为中性 `rgb(98,106,126)`，不使用 warning 色。英文实测 `6:13 PM`、繁体 `下午6:13`，没有补零；不支持平台的 macOS 说明只出现一次。

四语原地确认初始焦点在取消，Tab/Shift+Tab 及 Escape 返回正常。简体实际复制受校验的继续命令（核对工作目录和原 UUID），并将完整 **296 字符**连接命令写入合成复制接收器逐字比较，没有读取或覆盖系统剪贴板。清除后回到首次生成步骤的[合成截图](screenshots/v15-b3/zh-CN/cleared.png)不替代后端撤销或真实终端验证。

日文另以 **1024×720 渲染视口模拟**检查[顶部](screenshots/v15-b3/ja-JP/waiting-small-top.png)和[滚动后底部](screenshots/v15-b3/ja-JP/waiting-small-bottom.png)，检查连接按钮可达，没有横向溢出；这是 renderer emulation，不是原生窗口 resize。复制竞态修复后，重建最终 Electron 并重新打开独立简体沙盒，确认[完整复制及“已复制”反馈](screenshots/v15-b3/zh-CN/resume-copied-final.png)。共 20 张 PNG，按仓库既有 ignore 规则保留本机，不把相对链接当成 PR 已上传附件。没有重做真实 VoiceOver 或其他主题截图。

### 验证与清理

测试使用临时 userconfig 关闭 pnpm 自动版本切换，未修改依赖或锁文件；独立测试 HOME 和数据目录隔离真实配置。

| 命令/检查 | 结果 |
| --- | --- |
| `pnpm typecheck` | 通过；Web 路由仍有既有循环依赖提示 |
| `pnpm lint` | 通过，0 错误、277 警告；本轮新增 1 条代际清理 effect 的 set-state-in-effect 提示，其余沿用原项目警告 |
| `pnpm format:check` | 通过，1008 文件 |
| `pnpm test:web` | 69 文件、1484 测试通过 |
| `pnpm --filter @agentkib/desktop test --maxWorkers=2` | 最终全量通过：394 文件通过、1 跳过；7863 测试通过、3 跳过，393.03 秒 |
| `pnpm --filter @agentkib/desktop build:electron` | 最终构建通过，用于复制反馈复验；保留既有 chunk 大小提示 |
| `pnpm build:web:hosted` | 通过 |
| 改动的 3 个 `apps/desktop/test` 文件 `oxfmt --check` | 通过 |
| 兼容 workflow 检查 | 9/9 通过 |
| 最低版/最新版插件引擎与桥接套件 | 2.1.301、2.1.308 引擎各 9/9；最新版桥接套件 240/240 |
| 字典镜像、probe 语法与 `git diff --check` | 通过 |
| `pnpm --filter @agentkib/desktop claude:stage` | 全量结束后重建通过 |

4 个语言沙盒及最终复制复验沙盒已正常停止，原进程均不存在，目录经所有权核对后删除；简体为修正夹具正常重启过一次。没有启动 tmux，没有修改真实配置或 Codex 系统技能。兼容检查临时目录由脚本 finally 清理，插件构建目录已在测试结束后重新生成。

### 与设计的差异

没有采用“退出并重新打开”的降级方案：正式宿主契约已足够，且最低版/最新版原生引擎合成测试通过。仍保持 Web 原有能力，未增加桌面向导；该端四语镜像与测试同步。真实终端生命周期由用户验收，不把合成画面或 native JS engine 当作完成此项。

## 真实终端待验收

由用户按交接路径验收：连接后 `/exit`；直接关闭终端；恢复原会话；保持终端打开并重启 AgentKib 后再发一条消息；清除连接后恢复原会话。检查各次等待状态、自动重连及清除后的拒绝重连。合成截图、单元测试和无登录插件测试不替代这些真实操作。

## PR #144 独立审查与修复

固定审查基线 `54b30806b202b727dd589301f3a4b1b82d4c0147`、初始 HEAD `c38f4f47cfb0264f42a8f82cb1b9582daf93ba5e`，按 code-review 的 Standards、Spec 两轴及额外插件对抗性检查独立审查，不沿用上一轮无 finding 的结论。

首轮 Standards 无 finding；Spec 与对抗性检查共同确认一项 P2：有效旧绑定自动恢复期间执行过期或无效的新连接码，配对开始时清除 `needsReconnect`，HTTP 409 失败后没有恢复；`connection` 也为空，定时器和终端事件均提前退出。旧凭据仍有效，却必须重新启动终端或成功配对才能恢复，违反 B3 的自动重连与备用生成要求。

纯内存生产公共钩子探针对固定基线与初始 HEAD 做同序列对照：先连接 → lease 过期 → Runtime 短暂离线 → 执行过期/无效备用码 → 服务恢复。基线自动重连 1 次并成功，初始 HEAD 重连 0 次；100 次 timer 检查及一次终端提示事件均不能恢复。401/410 撤销与身份变化对照均不重连，未放宽保守规则。探针不读取真实配置、不打开 socket、不登录、不发送模型请求。

修复保留配对开始前的恢复意图，握手期间暂停后台恢复；仅当失败响应仍属于当前代际、会话未关闭且没有新的有效连接时恢复该意图。之后仍进入原 `reconnectOnce`，重新读取凭据并执行身份、版本、能力等全部检查。没有复用缓存 token、重放发送/停止，或将失败配对视为授权。新增 `connectOnce` 与既有 `reconnect/reconnectOnce` 采用相同的生命周期边界，避免扩大握手逻辑的修改。

最终独立复审进一步发现同一问题的并发变体：两次备用配对重叠且均失败，后一次可能只读到配对期间临时为 false 的恢复标志。两种响应顺序 × timer/prompt 的 4 项回归在第一版补丁中全部失败。最终以当前代际标记传递已有恢复意图，只有当前代际可继承或清理自己的标记；失效时立即清除。4 项转绿，纯内存三方对照也确认固定基线及最终补丁恢复成功，初始 HEAD 不恢复。该标记只存在插件内存，不改持久化结构或私有协议。

首版修复的桌面全量为 7875 通过、3 跳过（362.59 秒）；发现并发变体后，对最终冻结代码重新完整运行，不把前一次结果作为最终验收。最终独立 Standards 与 Spec 均为 no finding；Spec 额外以另一份纯内存公共钩子探针覆盖两种失败顺序及会话结束、401、410、身份变化共 6 组：前 2 组恢复，后 4 组经过 200 次 timer 与 prompt/turn 唤醒仍不恢复。静态复核和合成反证不替代真实 TUI 验收。

新增共 20 项回归：过期码失败后的 timer、prompt、turn 三种唤醒；配对进行中暂停和失败后继续有限退避；会话结束、新配对代际及 401/410/身份变化后的拒绝恢复；旧后台握手晚到成功/410；原凭据删除后拒绝使用缓存；并发失败的两种顺序、并发期间失效及无原恢复意图。第一组 9 项先红（4 失败、5 通过），修复后 9/9；双失败 4 项先红后绿，补齐边界后插件整文件 116/116 通过。保留原超时、断言和生产 `send: false`。

| 复验命令/检查 | 本轮结果 |
| --- | --- |
| 审查前相关桌面 7 文件 / Web 字典 | 350/350、21/21 通过 |
| 插件回归单文件，`vitest run test/claude-bridge-plugin.test.ts --maxWorkers=1` | 最终 116/116 通过 |
| `pnpm typecheck` | 通过，保留既有 Web 路由循环依赖提示 |
| `pnpm lint` | 通过，277 警告、0 错误；相对初始 PR 无新增警告 |
| `pnpm format:check` | 通过，1008 文件 |
| `pnpm exec oxfmt --check apps/desktop/test/claude-bridge-plugin.test.ts` | 通过 |
| `pnpm test:web` | 69 文件、1484 测试通过 |
| `node .github/scripts/claude-bridge-compatibility.mjs --version minimum --skip-bridge-tests` | 最终 2.1.301 strict validate、原生插件引擎 9/9 通过 |
| `node .github/scripts/claude-bridge-compatibility.mjs --version latest` | 最终 2.1.308 strict validate、原生插件引擎 9/9、6 文件桥接安全 260/260 通过 |
| `pnpm --filter @agentkib/desktop test --maxWorkers=2` | 最终 394 文件通过、1 跳过；7883 测试通过、3 跳过，378.68 秒 |
| `pnpm build:web:hosted` | 通过 |
| `pnpm --filter @agentkib/desktop build:electron` | 最终构建通过，保留既有 chunk 大小提示；全量结束后重建插件构建目录 |
| 最终独立两轴复审、字典镜像、插件语法及 diff 检查 | Standards 0 finding、Spec 0 finding；其余检查通过 |

两端用户文案不变，字典逐字镜像检查通过；不改兼容规则、发送关闭、跨 Agent 继续、Codex follower、C/D 或设计文件。复用本记录的合成截图，界面没有新增视觉变化；真实终端生命周期仍由用户验收。官方兼容检查继续隔离五类目录并通过网络/个人目录屏障，无登录或模型请求，临时目录在 finally 清理。
