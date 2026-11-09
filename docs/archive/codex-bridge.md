> Historical reference for the removed Rust bridge. Its `cargo` commands require an archived checkout and are not part of the current TypeScript application.

# Codex 原会话实验桥接

## 状态与边界

本模块是开发验证工具，不是已交付的远控功能。AgentKib 正式客户端和局域网接口仍然只读；Runtime 不依赖 `agentkib-codex-bridge`，没有新增导航、Renderer API、数据库或桌面协议字段。

目标是作为已有 Codex 客户端的 follower：发现原会话 owner、订阅内存状态、将有限操作定向转发给 owner。不会运行 Codex、恢复/分叉会话、修改 JSONL、创建 IPC 服务或读取认证凭据。无 owner 时停止，不进行独立 `thread/resume`。

已检查的安装代码版本：

| 组件 | 版本 | 已观察的机制 |
| --- | --- | --- |
| Codex 桌面端 | 26.901.51231 | owner discovery、following、状态流和 follower 操作 |
| VS Code Codex 插件 | 26.901.22334 | 同一套本地 IPC 路由；插件仍有自身 App Server |

这不是公开承诺的兼容契约。[公开 App Server 文档](https://learn.chatgpt.com/docs/app-server)不能代替该内部协议的真实客户端验证。

## 开发入口

只验证初始化，不读取会话：

```sh
cargo run -p agentkib-codex-bridge --example probe -- \
  --socket "$HOME/.codex/ipc/ipc.sock"
```

跟随用户明确指定的**合成测试会话**；默认只读，省略版本元数据也可以只读订阅：

```sh
cargo run -p agentkib-codex-bridge --example probe -- \
  --socket "$HOME/.codex/ipc/ipc.sock" \
  --desktop-asar /Applications/ChatGPT.app/Contents/Resources/app.asar \
  --extension-package "$HOME/.vscode/extensions/openai.chatgpt-26.901.22334-darwin-arm64/package.json" \
  --session "替换为测试会话 UUID"
```

需要验证操作时显式增加 `--allow-control`。仅 macOS 支持连接；初始化本身不会启用控制。首批控制校验限定上述标准安装路径、版本，以及 IPC peer 的可执行文件属于该桌面应用。若 IPC router 由其他程序（包括 VS Code）持有，或无法查到 peer PID/路径，则保持只读；不能用复制出来的 `package.json` 打开控制。

本机 socket 与父目录必须属于当前用户、无 group/other 权限且不经过符号链接；连接后校验 peer UID 和端点 inode。不会创建目录、修改权限或自动切换旧 socket。该 IPC 本质上信任同一操作系统用户，不应作为局域网授权边界，也不保证防御同 UID 的恶意程序。安装路径与版本校验不等同于官方对运行中 owner build 的证明。

交互命令：

| 命令 | 行为 |
| --- | --- |
| `status` | 显示状态、revision、执行轮次 ID、待审批数量；不输出正文 |
| `sync` | 重新发现 owner、订阅完整快照；不重发操作 |
| `approvals` | 按需显示当前支持的审批详情，不持续记录对话 |
| `send 测试文本` | 仅在已确认 idle 时发送纯文本，保留原 ID 与原端设置 |
| `stop TURN_ID` | 仅中断仍匹配的当前轮次；校验 owner 返回同一 interruptedTurnId，不保证工具子进程终止 |
| `approve {"requestId":42,"turnId":"TURN_ID","decision":"accept"}` | 仅允许 `accept` / `decline` / `cancel`，request ID 的字符串或数字类型必须保留 |
| `quit` / EOF | 取消 following、断开探针，不退出官方客户端 |

看到 owner acknowledged 只表示 owner 应答了请求，**不表示生成完成或某项审批由本探针成功处理**。结果不明时不重发；先 `sync` 检查原端状态。官方端已处理的审批可能返回无操作回执，因此必须观察 pending request 是否消失，不能据此声称某个决定已经生效。

所有命令仅用于临时项目和合成内容。不要将真实敏感信息复制进测试会话，不要重定向审批详情为公开日志。命令或 diff 不完整、网络/额外权限请求、目录授权及其他未知交互在原客户端处理；探针不会自动放行。

## 协议与保护

- 消息使用 little-endian 长度前缀加 JSON。独立身份 `agentkib-codex-bridge`；所有 owner discovery 请求的 `canHandle` 回答均为 false。
- 固定方法版本：initialize 0、owner discovery/following/审批 1、start-turn 2、interrupt 4、stream 11。不向本地 API 暴露任意 method/params 输入。
- following 使用 `conversationId + hostId: local`，目标为已发现的 owner client ID；恢复 following-status 请求时同样定向回复。
- snapshot 与 Immer array-path patches 按 revision 验证。错版本、丢帧、越界、身份不匹配或断开后清空状态并禁用操作；旧广播不得重新激活连接，必须重新发现与取得快照。
- 入站 frame/累计 snapshot 上限 8 MiB；出站请求 64 KiB；文本 16 KiB；单批 patches 4096 条、路径深度 64。超限只读失败，不降低校验或加载无限历史。
- 同一进程内按端点和会话串行化操作；持有端与轮次再次核对，消息无自动重试、排队或插话。发送异常后进入 outcome-unknown；IPC 超时关闭连接。
- 发送协议没有显式 revision CAS；不同官方客户端的同时提交最终依赖 owner/App Server 的处理。这项行为必须三端实测，不能以刷新后检查 idle 或本地锁替代证明。
- 审批按原会话、active turn、pending request 和方法匹配；仅允许单次决定。额外权限、缺少 command/diff 或未知交互不能 Accept。

## 验证记录（2026-09-07）

| 验证层级 | 结果 |
| --- | --- |
| 安装代码核对 | 已确认两套客户端存在 owner/follower 协调，并非仅共享历史文件 |
| 真实 IPC 初始化 | Node 最小探针及 Rust 开发入口均以独立身份成功初始化；没有读取会话 |
| 真实版本元数据 | 已读取上述两个版本，仅读取包元数据，不读取 Token |
| 不存在的合成会话 UUID | 真实 owner discovery 返回 no session owner found；无 fallback / resume |
| 单元与受控 socket 测试 | 覆盖编解码、版本、订阅、增量、隔离、权限、定向请求、审批失效、超时及重复操作；仅用于验证适配器逻辑 |
| 原会话发送及状态增量 | 用户指定“处理测试对话”；探针发送 AK-BRIDGE-001，官方端在同一 UUID 下新增且仅新增一个轮次，回复 `AK-BRIDGE-001 收到。`；后续执行中收到连续 revision 更新 |
| 原会话停止 | STOP-004 确认轮次 `interrupted`；**完整停止验收不通过**：后续 PROCESS-011 证实轮次中断后子进程仍运行至自然结束，不能将 interrupted/idle 当作命令已终止 |
| 执行中重复发送保护 | STOP-004 执行中再次发送被探针以 not idle 拒绝；官方该轮次未出现该测试消息 |
| VS Code 第三端同步 | **通过本机实时复测**：打开同一测试会话后，LIVE-005 的回复、STOP-006 的执行和停止实时可见；VSCODE-008 从插件发送后，官方记录与探针状态同步。本次无需重启或重载插件 |
| 真实命令与文件审批 | **有限场景通过**：APPROVAL-016 探针单次允许；017 原生拒绝后旧允许失效；018 探针 cancel 后旧允许失效；FILE-020 文件允许、021 原生拒绝不落盘及旧允许失效。更细竞争时序及额外权限未覆盖 |
| 跨客户端同时 start-turn | **未通过完整验收**：RACE-022 双进程 A/B 各出现一次并得到回复，但完成后 owner 快照残留无 turnId 的 inProgress 记录；修正后安全降级为状态未确认。官方 UI 与探针的同时提交仍未覆盖 |
| 局域网与 Windows/Linux | 本轮不实现、不验收 |

运行本地检查：

```sh
cargo fmt --all -- --check
cargo test -p agentkib-codex-bridge
cargo clippy -p agentkib-codex-bridge --all-targets -- -D warnings
git diff --check
```

三端验收顺序：先在官方客户端中打开同一合成会话，探针只读订阅；由桌面发起一次可观察执行，确认插件和探针状态一致且不可重复发送；执行结束后由探针发送一条明确测试文本，检查仍为同一 ID 且只启动一次；随后分别验证停止、两端抢先处理审批、owner 退出、连接重建和未知版本只读。审批涉及的命令和文件仅限临时测试项目。

### 三端实时复测（19:50–19:54）

目标始终为用户指定的“处理测试对话”，UUID `REDACTED_NATIVE_THREAD_ID`。沿用上述安装版本，没有改变权限设置，也没有修改业务代码。

| 场景 | 观察与结论 |
| --- | --- |
| 探针发送 LIVE-005 | 官方记录在原会话新增一个轮次 `REDACTED_TURN_ID_01`，约 4.2 秒完成，准确回复标记；VS Code 无需重启即显示消息和回复。未调用工具 |
| 官方桌面入口发起 STOP-006 | 原会话轮次 `REDACTED_TURN_ID_02` 在 `/tmp` 执行一次 `/bin/sleep 30`；VS Code 显示运行中及停止按钮，探针收到活动轮次与增量状态 |
| 执行中重复发送与停止 | DUP-006 被探针以 not idle 拒绝，未新增该消息或轮次。定向停止 STOP-006 后，VS Code 显示后台终端已停止；官方记录为 `interrupted`，持续 18.622 秒，没有自然结束回复。探针在回执后进入 outcome-unknown，显式 sync 后恢复 idle |
| 真实审批尝试 APPROVAL-007 | 仅在专用临时空目录 touch 一个零字节文件；当前实际权限直接允许执行，回复“已完成，无需审批”，探针 pendingApprovals 始终为 0。因此真实审批决定、跨端抢先审批及失效行为仍未验收；未改变权限或模拟审批 |
| VS Code 发送 VSCODE-008 | 从插件输入并发送纯文本；原会话轮次 `REDACTED_TURN_ID_03` 约 3.1 秒完成，准确回复标记。探针收到 revision 219–237 的运行到空闲变化，官方记录只有该用户消息和最终回复，无工具调用 |
| 探针断开与重连 | quit 控制探针后，以不带 allow-control 的只读探针重新连接，重新取得同一会话 revision 237、idle、无待审批的快照；随后正常退出。未退出或重启官方客户端 |

本次本地检查：桥接 crate 的 29 项测试通过，Clippy（all-targets、warnings as errors）、全工作区格式检查通过。此处仅验证本机实验探针，不等于 AgentKib 正式界面获得控制能力。跨客户端同时发送、owner 退出与真实审批仍待单独验收；用户此前重启 VS Code 后能看到历史，也不能单独证明缓存是根因。

### 进程级补充验收（22:34–22:37）

**结论：暂不通过正式控制能力验收。** 之前“停止通过”仅依据轮次状态和 UI，现收窄为“轮次中断通过”；不保证执行中的命令被终止。以下仍使用同一合成会话，无生产代码、权限或官方客户端生命周期改动。

- RECONNECT-009（轮次 `REDACTED_TURN_ID_04`）：执行中正常退出探针，再连接取得原轮次 running、revision 268；旧 STOP-006 轮次的停止被拒绝，正确停止后同步为 idle。官方轮次为 interrupted、26.470 秒，但命令后续记录 completed、退出码 0、29.865 秒。该实验是 follower 主动断开重连，不代表 owner 退出或异常网络断开已通过。
- PROCESS-011（轮次 `REDACTED_TURN_ID_05`）：停止前通过进程表确认 PID 28226 为 `/bin/sleep 30`；停止并同步到 idle 后同一 PID 仍存在，后续再次观察累计运行 22 秒。最终自然消失，官方命令记录 completed、退出码 0、29.862 秒，而轮次为 interrupted、19.143 秒。确认“轮次中断不等于子进程终止”，尚未定位到适配器、owner 或工具执行器中的具体原因；不能靠 UI 的已停止标签判断命令停止成功。
- 无 pending 的合成审批 ID 被真实探针拒绝（`approval no longer pending; nothing sent`）；这是负向保护验证，不是实际审批验证。
- 省略版本元数据且未启用控制的真实连接仍可读取快照，但发送、停止、审批均被 `experimental controls are disabled` 拒绝，官方未新增该负向测试消息。
- 重新运行 `cargo test -p agentkib-codex-bridge`：29 项通过。受控测试通过未覆盖上述真实子进程存活差异。探针均已正常退出，测试 sleep 已自然结束。

独立只读复核确认：进程内操作锁不是跨客户端 CAS；审批测试为合成 socket owner；owner 退出测试为注入 disconnected/reset 广播。真实审批允许/拒绝和抢先处理、跨客户端同时提交、真实 owner 退出仍未完成，不能用这些受控测试替代。应先定位并明确停止语义，再继续正式控制接入。

### 停止问题调查与安全修正

只读核对当前桌面安装包的 follower handler、`interruptConversationSelf` 和 `Dtn` 后确认：适配器的 `mode: user-stop`、`expectedTurnId`、版本 4 与当前实现一致。owner 将请求转为 `turn/interrupt`，并通过 `killNodeReplExecutions(sessionId, turnId)` 尝试工具清理；该流程与独立的 `thread/backgroundTerminals/clean` 不同。现有 follower 方法表没有暴露绑定预期轮次的独立终端清理请求。不能通过删除 expectedTurnId、无条件重复停止或按 PID 杀进程来绕开边界，这会扩大作用范围或引入新轮次竞态。

本仓库已补充可独立完成的安全修正：停止回执必须同时包含 `ok: true` 和匹配的 `interruptedTurnId`；空值、缺失、其他轮次以及 goalPauseError 不再作为正常完成返回。异常回执仍保持 outcome-unknown，禁止盲目重试。探针明确提示只确认轮次中断、没有确认进程终止；新增回执、无活动轮次与重复停止回归，并锁定完整停止参数及方法版本。

**这不是子进程残留的根治。** owner/工具清理为何未终止进程仍需上游执行器证据或具备轮次约束的清理接口；没有修改官方应用、增加网络方法或放宽保护。PROCESS-011 的不通过结论继续有效，不能据此次适配器安全修正宣布完整停止已修复。

### 修正后真实回归与原生对照（22:50–22:52）

- RECEIPT-012（`REDACTED_TURN_ID_06`）：修正后的探针接受匹配轮次的真实回执，明确输出“Tool subprocess termination is NOT guaranteed”，同步到 revision 334 idle。官方轮次 interrupted、12.903 秒；停止前后均观察到 PID 39816 的 `/bin/sleep 30`，后续 29 秒时仍存在，命令最终 completed、退出码 0、29.860 秒。回执修正通过真实兼容验证，完整进程终止仍不通过。
- NATIVE-013（`REDACTED_TURN_ID_07`）：直接在 VS Code 原生输入框发送同样的 sleep 测试，并点击当前轮次的原生停止按钮；适配器只观察，没有发送停止。UI 显示停止且官方轮次 interrupted、19.271 秒，但 PID 40552 仍存在（累计运行 20 秒），最终命令 completed、退出码 0、29.855 秒。确认相同行为也发生于原生 VS Code 入口，不是仅由桥接入口触发；尚不能进一步判定 owner 与工具执行器中的具体故障点。
- RACE-014：并行从探针发送 A、官方桌面 send_message_to_thread 入口发送 B；原会话轮次 `REDACTED_TURN_ID_08` 内 A、B 各出现一次回复，没有额外工具调用，最终 completed、8.587 秒，探针 revision 410 idle。但 B 实际作为 delegation functionCallOutput 注入同一轮次，并非第二个 start-turn；因此不将此结果视为跨客户端 start-turn 竞争保证。
- 本轮未修改生产代码、权限或官方应用；两次测试 sleep 均已自然退出，探针已正常退出。沿用上一轮已通过的 31 项单元/受控测试与 Clippy、格式检查，不宣称这些检查能代替进程级验收。

截至该次回归，验收门槛仍未全部满足，真实审批和可安全退出的 owner 环境仍待准备。后续已按用户授权在原测试会话局部切换受限权限并验证审批，见下文；无需另建会话。owner 生命周期仍不在有其他任务运行的日常工作端通过退出应用测试。当前实验只可按“有限轮次控制，不承诺命令终止”理解，不能作为完整停止能力交付。

### 原会话真实命令审批验收（22:57–23:00）

继续使用“处理测试对话”，不新建会话。APPROVAL-015（`REDACTED_TURN_ID_09`）要求仅通过正常工具审批机制申请 `/usr/bin/true`，实际没有调用工具。只读核对该轮次 turn_context 确认为 `approval_policy: never`、`sandbox_policy.type: danger-full-access`，不能用 VS Code 菜单显示的“请求批准”代替生效配置。

经用户明确同意继续使用该会话并局部设置权限后，在 VS Code 当前会话菜单重新选择“请求批准”。下一轮 turn_context 确认变为 `on-request`、`workspace-write`、network_access false；确实出现真实审批，而非伪造请求。没有编辑全局配置文件、改变其他会话、修改官方程序或绕过工具限制。测试结束保留此会话的受限模式，没有重新启用完全访问。

| 场景 | 真实结果 |
| --- | --- |
| APPROVAL-016 / `REDACTED_TURN_ID_10` | requestId 856，命令 `/bin/zsh -c /usr/bin/true`，cwd `/tmp`；VS Code 出现允许一次/拒绝，探针 pending=1。探针发送 accept 后 pending 消失，官方记录命令仅执行一次、退出码 0，轮次 completed |
| APPROVAL-017 / `REDACTED_TURN_ID_11` | requestId 857；探针 decline 被 `decision not offered by owner` 拒绝，未发送不受支持决定。随后 VS Code 原生拒绝，官方记录报告命令未执行且无 commandExecution 项。探针再提交同一请求 accept，被 `approval no longer pending; nothing sent` 拒绝 |
| APPROVAL-018 / `REDACTED_TURN_ID_12` | requestId 858；探针 cancel 后 pending 消失，官方轮次 interrupted，无 commandExecution 项。同步后再提交旧 accept 被拒绝；最终 revision 584 idle，探针正常退出 |

这些结果证明该安装版本下的单次命令允许、原生拒绝、探针取消，以及处理完成后的旧决定失效。**decline 与 cancel 不能擅自互换**：当前真实 owner 未提供 decline，cancel 的可观察结果是中断轮次。文件变更审批、不同类型额外权限、另一端恰在 refresh 与提交之间处理的窄竞态，以及 owner 实际退出仍未验收。完整进程停止的不通过结论保持不变。本轮无代码改动，`git diff --check` 通过。

### 受限停止与文件审批补充验收（2026-09-07）

继续使用同一“处理测试对话”，保留 `on-request + workspace-write`，不修改官方客户端或其他会话权限。

- SANDBOX-019（`REDACTED_TURN_ID_13`）：受限模式下仅执行 `/bin/sleep 30`。定向停止并同步为空闲后，原 PID 51773 仍存在；官方轮次 interrupted、18.041 秒，命令最终 completed、退出码 0、29.869 秒，随后进程自然退出。因此完整进程终止仍不通过，不能归因于完全访问模式。
- FILE-020（`REDACTED_TURN_ID_14`）：真实 `item/fileChange/requestApproval`，requestId 860。审批前确认专用缓存目录的 `approval-020.txt` 不存在；探针 accept 后，官方 fileChange completed，独立读取确认内容只有 `AK-BRIDGE-FILE-020`。最终回复对结果存疑，但文件与结构化记录共同确认成功，未仅凭回复判定。验收后已删除该一次性测试文件。
- FILE-021（`REDACTED_TURN_ID_15`）：真实文件审批 requestId 861，目标同一专用目录的 `approval-021.txt`；已确认审批前文件不存在。owner 未提供 availableDecisions，按探针提示转原生界面处理拒绝时，Mac 锁定，无法操作。因此仍待审批，**文件拒绝及该请求的过期决定验证未通过验收**；未批准、未以 cancel 冒充拒绝。保留空目录 `/Users/REDACTED_USER/Library/Caches/agentkib-file-qa.REDACTED` 供解锁后继续测试。

探针审批输出新增 owner 的 availableDecisions、networkApprovalContext、additionalPermissions、grantRoot，修正原先无条件建议 decline 的提示；资料或决定不明确时回原客户端处理，并明确 cancel 不等于 decline。新增受控 socket 回归覆盖“不支持的 decline 零 mutation、cancel 精确参数”和“内部刷新后审批已失效时 accept 零 mutation”。这些受控测试不代表真实 refresh 与提交之间窄竞态、双端 start-turn 竞争或 owner 退出已验收。

本轮复验：`cargo test -p agentkib-codex-bridge` 33 项通过；`cargo clippy -p agentkib-codex-bridge --all-targets -- -D warnings`、`cargo fmt --all --check`、`git diff --check` 均通过。探针已正常退出，不会代用户处理仍待决的 FILE-021。未创建提交。

### FILE-021 解锁后补验（2026-09-07）

重新连接原会话时仍为 revision 717、awaiting-approval、requestId 861；再次确认目标文件不存在。在 VS Code 当前会话点击原生“拒绝”后，pending 变为 0，官方 fileChange 明确为 `declined`，随后轮次 completed，最终回复确认拒绝且未重试。探针对相同 requestId/turnId 再尝试 accept，返回 `approval no longer pending; nothing sent`。结束后独立确认 `approval-021.txt` 仍不存在，已用 rmdir 删除该专用空目录，探针正常退出。

因此 FILE-021 的“原生拒绝不落盘、旧审批失效”补验通过，上一节锁屏阻塞已解除；不代表探针 decline 或实时窄竞态已通过。本轮仅补验与更新记录，沿用前轮 33 项测试、Clippy 和格式检查结果，重新运行 `git diff --check`。完整子进程停止、双端 start-turn 竞争、真实 owner 退出仍未通过完整验收，不升级为正式控制能力。

### 双进程并发与停止边界复核（2026-09-07）

RACE-022 使用两个独立探针进程，均先取得原会话 revision 744 idle，再并行发送只要求文字回复的 A/B 标记；两者实际经过 `thread-follower-start-turn`，没有使用消息注入工具。两端均获 owner 回执。官方记录轮次 `REDACTED_TURN_ID_16` completed、8.470 秒，内含 A 用户消息/最终回复、B 用户消息/最终回复，各一次，无工具调用。这证明本次双进程提交未丢失、未重复；owner 将两次输入合在同一轮次，不能宣称一个 start 请求必然对应一个独立轮次或具备跨客户端 CAS，也不能替代官方 UI 同时提交测试。

通过 OpenAI Docs 核对[公开 App Server 文档](https://learn.chatgpt.com/docs/app-server)：`turn/interrupt` 的成功结果是轮次 interrupted；后台终端另有实验性 clean/list/terminate 接口。公开 App Server 方法不等于当前安装版桌面 follower IPC 已暴露相同方法。独立只读审查再次确认仓库的版本 4 interrupt 已绑定 expectedTurnId，方法白名单没有终端清理接口，未找到现有接口内可安全根治子进程残留的代码缺陷。因此不盲目添加未经验证的方法、不直接杀 PID、不删除轮次保护；完整停止依旧受上游执行器或安全清理接口阻塞。

本次修正验收总表与过时待办，未更改控制协议或官方应用。真实 owner 退出测试仍需要不影响其他任务的环境；双探针结果不能代替该测试。

#### 并发后状态缺陷与安全修正

继续检查发现两端刷新仍为 revision 788、running、activeTurnId=null，尽管官方记录已完成。新增显式 `diagnostics` 命令只输出状态元数据，不输出会话正文、工具内容或凭据。重新连接取得的 owner 快照为 runtimeStatus=idle、liveTurns=[]、activeHistory=[{status:inProgress,turnId:null}]，证明不是仅靠重新连接能解决的探针增量丢失。

修正 `state.rs`：无法确定活动轮次的运行/审批状态降级为 outcome-unknown，空字符串轮次 ID 同样不用于控制；保留后续权威快照恢复能力，不擅自删除历史占位或制造 idle。新增空/null 轮次占位及后续恢复回归，更新冲突状态断言。真实原会话复验 revision 788 已显示 outcome-unknown；发送 BLOCK-023 和对旧轮次停止均被 `session state is not confirmed` 拒绝，无控制请求发送。此修正通过，但 owner 残留状态的恢复尚未解决，因此 RACE-022 不标为完整通过。

`cargo test -p agentkib-codex-bridge` 34 项通过；Clippy all-targets（-D warnings）、全工作区格式检查、`git diff --check` 通过。探针已退出，未修改官方应用、历史文件或创建提交。

### 用户重启后只读复验（2026-09-08）

用户提供的 RACE-022 截图显示 B 重复且界面持续“正在思考”，所以此前后台 A/B 各一次不能证明 UI 无重复。用户自行重启后，第一次读取原会话为 notLoaded，只读探针返回 no session owner found；通过宿主导航打开同一会话后，重新连接取得 revision 1、idle、activeTurnId=null、pendingApprovals=0。元数据诊断为 runtimeStatus=idle、liveTurns=[]、activeHistory=[]，此前无 turnId 的 inProgress 残留已消失。持久记录仍为同一轮次 completed，A/B 消息和回复各一次。

本次仅证明重启并重新打开后运行状态恢复，没有观测退出瞬间。电脑工具不允许读取官方 Codex 界面，因此未确认 UI 重复气泡是否消失，也未将持久记录视为视觉验收。没有发送消息、停止或审批请求，没有修改历史；只读探针已正常退出。并发根因及完整子进程终止仍未修复，不恢复真实并发测试。

### 真实测试发现并修复的差异

- IPC response 的方法字段在顶层 `method`，不是 `result.method`。首次发送已完成但探针曾误报不兼容；没有重发该消息，先通过官方端记录确认结果再修复解码及测试夹具。
- 客户端状态的轮次 ID 为 `turnId`，且真实执行轮次可能保存在 `turnHistory.kind=canonical` 的 indexed history 中，不在 `turns` live overlay 内。初次停止被安全拒绝，STOP-002/003 自然结束；补充 canonical history 解析后 STOP-004 中断成功。
- canonical 与 live overlay 的活动轮次不一致时，不猜测控制目标，停止及审批保持禁用。canonical entity 缺失时整个状态失效。
- 测试目标由用户指定，位于现有项目；早期临时零字节文件场景未触发审批，后续已通过受限模式完成真实命令和文件审批，详见 APPROVAL-016–018、FILE-020–021。没有让测试会话修改项目文件。

只有真实三端验证通过，才能继续设计局域网控制。未来控制授权覆盖全部已登记及新增项目，但发送、停止、审批须单独授予，不能将已有只读设备授权自动升级。
