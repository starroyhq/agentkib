> Historical Rust implementation notes. The current desktop runtime is TypeScript-only; the examples and Cargo checks below describe the retired backend.

# Codex 托管执行

本实现面向 macOS，将官方客户端 follower 与 AgentKib 自己持有的 app-server 分开。Follower 的 `executionMode` 为 `codex-follower`，托管为 `codex-managed`。创建和原 ID 交接须单独的设备管理授权；执行还须启用实验控制、允许对应工作区。Web/Electron 负责授权，Rust 只接受注册工作区 ID，并在每次操作前复核 canonical 路径和 CODEX_HOME。

## RPC

`codex.managed` 接受 camelCase 对象，拒绝未知字段：

| operation | 参数 | 结果 |
| --- | --- | --- |
| options | 无 | `available`, `models:[{id,name,isDefault,efforts}]`, `policies`，不可用附 `reason` |
| create | `workspaceId`, UUID `requestId`, 可选 `model`, `effort`, `policyId` | `sessionId`, `accepted`, `completed`, `runtimeBootId`, `live` |
| adopt | 原有 opaque `sessionId`, UUID `requestId`, `handoffConfirmed:true` | 同上；保留原生 thread ID |
| release | `sessionId`, UUID `requestId` | `released:true`, `accepted:true` |
| reconcile | `sessionId`, UUID `requestId` | `reconciled:true` 和 `live`，或 `false` 和原因 |

HTTP 另外携带 Electron `bootId`，由 Electron 验证，不直接传给 Rust。托管 sessionId 为 64 位十六进制，对外不暴露原生路径。create 不接受首条消息；成功获取 sessionId 后再单独 send，避免创建回执丢失时重复执行首条消息。相同 requestId 和输入重试返回持久回执；同 ID 换输入会拒绝。

现有 `web.request` 对托管会话自动分派 `live`, `events`, `send`, `stop`, `approve`, `answer`。控制参数沿用 `runtimeBootId`, `expectedRevision`, UUID `requestId`, `experimentalEnabled:true`；审批/问答另外验证原生 `turnId` 和请求 ID。`events` 默认最新 50 条、页面内部按时间正序；`next_cursor` 向更早历史分页。catalog 合并持久托管记录，即使会话索引关闭或重建，托管任务仍可见。

`web.request {operation:"diff",workspaceId,kind,path?,oid?}` 返回既有 `GitDiff|null`；kind 为 `worktree`, `staged`, `commit`。只允许注册仓库根目录，commit 需要 oid。读 patch 前验证 Git 文件列表与 rename 两端；不指定 path 时，只要整个候选变更中有敏感路径就拒绝。`.env`、凭据、认证/token 文件、私钥、原生代理私有状态目录等拒绝；允许 `.codex/worktrees/<project>` 中的合法仓库。path 必须是精确变更文件，拒绝目录/pathspec magic。输出前再次复核元数据和工作区授权映射。

已授权浏览器打开单个 Codex 会话详情时，`GET /api/web/v1/managed/context?sessionId=…` 按该线程 ID 调用官方 `thread/read`，并设置 `includeTurns:false`。仅返回已授权执行目录、原生项目 ID 和 `gitInfo.branch`；后者是**创建时分支**，不代表当前 Git 分支。原生字段缺失或读取失败时界面显示未知或不可用。此查询不恢复线程、不获取 writer 锁、不持久化另一份工作树状态。Codex 当前协议没有正式的工作树创建、类型或起始分支接口，因此手机端不提供这些操作，也不会凭 `.codex/worktrees` 路径推断工作树类型。上文 Git diff 的 `worktree` 只表示工作区未暂存差异。

## 执行策略与版本适配

新建托管会话默认使用 `workspace-write-on-request`：`workspace-write`、`on-request`、人工 reviewer、sandbox network=false。完整授权浏览器可在主机返回的映射策略中显式切换为完全访问（不弹审批）或工作区写入／自动审核；浏览器不能提交任意 sandbox 对象、cwd、CLI 参数、额外可写根或审核器参数。策略更新必须在空闲时携带当前 revision，由原生 settings 通知和 `thread/read` 回读确认后写入账本；后续 turn/start 从账本使用已确认策略，不再被固定默认值覆盖。旧记录缺少策略字段时仍使用原受限默认。

模型、思考强度和服务档位来自 `model/list`；Plan／执行模式来自实验协议 `collaborationMode/list`。新增托管模式仅对完成隔离验证的 `0.155.1` 开放。空闲时保存设置只改变 `selected`，不启动轮次；`current` 保留原生确认值，`applicationStatus` 区分 `pending`、`confirmed` 和 `unknown`。下一次显式发送在 `turn/start.collaborationMode` 传入选择，内外模型和强度一致，`developer_instructions:null` 由 Codex 加载内置指令。没有自定义计划提示词、隐藏空轮次或自动执行计划。

切换模型会重新校验 effort 与 service tier；恢复默认只在主机能给出明确默认模型时开放，且不改变计划模式或执行策略。重启保留选择但不把旧 mode 当作原生事实；`0.155.1` 恢复响应缺少模式时，等待下一轮原生事件确认。执行期间原生明确请求的额外权限，只有单独获扩展审批授权的浏览器才能按原生候选决定；完整浏览器授权不等于自动批准。一次最多持有 8 个托管进程，每个会话一个专用 app-server。

Goal 使用 `thread/goal/get/set/clear` 和原生事件。`goal-set` 的 `intent:update` 不传原生 status，保留暂停、阻塞或受限状态；`intent:start`（旧请求缺省值）仅创建不存在的目标并明确激活。已有目标的旧缺省请求拒绝，避免意外恢复。预算字段缺省保留、`null` 清空，修改不重置消耗。仅活动目标可暂停；暂停／阻塞可显式恢复，预算或用量受限可尝试恢复，仍以 Codex 返回的最终状态为准。完成目标须清除后新建。设置尚未原生确认时阻止目标启动／恢复；不发送隐藏消息补偿，不新增目标调度器。

托管只放行已核对的 `codex-cli 0.155.1` 与 `0.155.0-alpha.16.3`。通过已有平台发现解析 codex，再读取 `--version`；未知版本 fail closed。官方 thread/start/resume 回包还必须确认 cwd、sandbox、reviewer、可写根及本地环境。版本号不能替代运行时身份与策略验证。

Follower 连接 CODEX_HOME 下官方 IPC，使用操作系统核实的实际 peer executable 推导 app bundle，支持移动安装位置和用户 Applications；不再依赖固定 `/Applications/ChatGPT.app` 或必须安装 VS Code 扩展。当前 Desktop allowlist 为 `26.917.62051` 与 `26.924.22138`。后者精确开放 owner 的 `thread-follower-update-thread-settings` v2；由于 follower 快照没有目标主机的模型／服务档位目录，Web 只开放计划模式和三个固定策略，拒绝浏览器提交模型、effort 或服务档位字符串。主机默认、token usage、goal、技能／插件资源同样没有可靠 follower 读取路径，保持 unavailable。协议核对证据见 `crates/agentkib-codex-bridge/COMPATIBILITY.md`。

## 原 ID 交接与退出

交接要求用户明确确认，并先在原客户端停止任务、暂停 active goal、释放会话。AgentKib 不停止共享 daemon、不删除 native lock、不复制 CODEX_HOME，也不默认 fork。源索引与 rollout 元数据共同验证原始 thread ID 和工作区；专用 app-server 在同一 canonical CODEX_HOME 上调用官方 thread/resume，由 Codex 自己原子获取每线程 writer lock。原 writer 未退出时返回 `codex-owner-busy`；“找不到 owner”不能作为排他证明。active goal 会被拒绝以免恢复引起自动循环。

release 关闭且必要时终止仅由本服务创建的子进程组，等待进程退出释放原生锁。已交接的会话随后回到 follower 路由；新建会话保留托管历史、显示已释放只读状态。当前版本没有对已释放新建会话的隐式自动重启。关闭 Web 页面不结束任务；退出 AgentKib/runtime 会关闭专用子进程。没有独立常驻 daemon，也没有自动 goal 循环。

## 持久账本及恢复

账本在 `agentkib_store::default_data_dir()/codex-managed/executions.sqlite`，与可重建 conversation index 分离。专属目录权限 0700、主 DB 0600，WAL 文件在同一受限目录。SQLite WAL 和 3 秒 busy timeout；初始化在 IMMEDIATE 事务中建表，并按 table_info 对缺失的 evidence 列做添加式迁移，不删除旧行。

- `managed_sessions(id PRIMARY KEY,record)`：工作区映射、canonical HOME、原生 ID、选择的模型/effort、release 标记、最后快照。
- `managed_commands(request_id PRIMARY KEY,session_id,fingerprint,phase,result,evidence)`：请求 SHA256、prepared/dispatched/resolved 状态、回执与最小原生证据。不会持久化完整原始控制请求。
- `managed_events(sequence PRIMARY KEY,session_id,event_id,event)`：显示历史，按 `(session_id,event_id)` 去重。

会话记录在 thread/start 之前写入；thread/started 通知也会尽早持久化 native ID，所以创建 HTTP 回执丢失后仍可在 catalog 找回任务。发送前先写 dispatched，再向原生 pipe 写入；超时/断开保持 unknown fence，不自动重发。runtime 重启不会自动恢复模型执行，显示 recovery-required，由管理操作 reconcile 尝试同 ID 恢复。

reconcile 读取原生 thread/read。send/steer/queue-add 必须找到对应 `userMessage.clientId == requestId`；stop 必须找到其目标 turn 的明确终态；审批和问答必须确认原生 `serverRequest/resolved`，单纯轮次结束不能证明对应决定已执行；创建/交接须已获得并重新核实同一个 native ID。通过后才记账并返回 `reconciled:true`，供 Electron 清除不确定结果屏障。无法核对、native ID 缺失、原客户端仍持锁、原生历史未持久化，均返回 false，不允许手工跳过未知发送。实测官方零消息线程（包括 persistExtendedHistory 或设置名称）尚未生成可恢复 rollout；若在首条消息前退出 runtime，会保留可找到的账本任务，但不能恢复这个空 native ID，须 release 后显式新建。

没有足够原生证据的任务会保持只读；不得用新请求 ID 重放猜测已执行的操作。

## 验证

隔离 Rust mock 覆盖创建、发送、精确审批/问答、停止、模型与权限拒绝、重启恢复、丢失发送回执的原生核对、账本去重与分页、帧大小约束，以及 diff 私有路径规则：

```sh
cargo test -p agentkib-codex-bridge -p agentkib-runtime
```

可显式运行真正官方 CLI 的离线互斥验收；脚本使用临时 HOME/CODEX_HOME/workspace、白名单环境变量、loopback fake Responses SSE，不读取用户 token、不调用付费模型、不操作已有会话：

```sh
python3 crates/agentkib-runtime/tests/fixtures/codex_native_writer_lock.py \
  /Applications/ChatGPT.app/Contents/Resources/codex /opt/homebrew/bin/codex
```

2026-09-24 本机上述双版本实测输出：

```json
{"nativeFixedPolicy":true,"nativeUserMessageIdPreserved":true,"nativeWriterConflict":true,"sameIdResumeAfterRelease":true,"historyPreserved":true,"mockOnly":true}
```

这是原生策略、跨进程 writer 互斥、同 ID 释放恢复和 clientId 历史证据的验收；不等同于公网手机、真实账户审批或付费模型的完整生产验收。协议 TS 可由 `cargo run -p agentkib-protocol --bin generate-typescript` 生成，生成器含 `codexManaged` 常量。

## 持久控制回执与本机 CSR

Codex follower 的 send/stop/approve/answer 现在复用 `executions.sqlite` 命令账本。SQLite 成功记录 dispatched 后，桥接才可发送原生请求；无法写账本时不发送。收到匹配的原生回执才写 resolved。释放会话前也检查未确认记录；存在已派发但结果未知的审批、问答或其他控制时，release 明确返回未派发，保留执行进程及其原生 resolved 证据。应先 inspect 核对，确认后再以新 requestId 显式释放，不自动重试旧 release。runtime 重启后，任何设备对同一 session 的后续控制仍受未确认记录阻挡；idle 快照、页面刷新和重新连接均不能清除此屏障。

本机 `control.receipt {requestId,deviceId}` 查询通常返回 `{found:false,requestId}`，或包含 sessionId、workspaceId、operation、executionMode、原 runtimeBootId/expectedRevision/turnId、status、ack 的记录。status 为 not-dispatched / accepted / unknown。deviceId 必须与原命令一致，设备权限与 workspace 授权由 Electron 再验证；跨设备同 UUID 不会返回他人回执。旧账本添加 device_id 列，旧记录保留但不自动分配给任何新设备。UUID 保留全局唯一约束，跨设备 UUID 碰撞拒绝。`completionObserved:false` 明确表示 accepted 仅确认请求回执，不表示审批、工具或轮次已经结束，UI 必须继续显示原生 pending 事项。

新命令的认领、device_id 和操作证据在同一 SQLite 事务中提交；`claim_version=1` 标识完整认领，旧记录迁移为 0。任务创建也在产生原生副作用前保存 workspace 与操作信息，重启后可直接查到归属正确的未派发回执。

旧版在认领与补写元数据之间中断的记录，仅当 `claim_version=0`、仍为 prepared 且缺设备归属或操作信息时，回执查询才可在写事务内将其终结为未派发。返回最小证明 `{found:true,requestId,status:"not-dispatched",recovery:"legacy-prepared",completionObserved:false}`，不含 session、workspace、operation 或原始结果；不猜测或补绑设备。仍有设备归属的旧记录只能由原设备查询；无归属的记录仅允许已授权浏览器取得该最小证明，不开放普通回执内容。终结与 dispatch 互斥，保留原 requestId 去重记录。浏览器仅清除同一 requestId 的待确认标识并提示未发送，不自动重试、不按成功处理。已 dispatched、已正常 resolved、完整的旧记录及新版记录不走此恢复路径；无法证明未派发的孤立记录保持阻塞，需在电脑端核查原生状态，不能靠清空账本解锁。

Web 将 Codex 控制和管理操作的 requestId、sessionId/workspaceId、kind 保存到按 host + device 隔离的 sessionStorage，不保存正文、答案、token 或审批详情。刷新/重连只查询回执，不自动重发。found:false 和 unknown 保留屏障；accepted/not-dispatched 才收敛。创建回执可用返回 sessionId 导航找回任务。不同设备授权不加载旧设备 pending。浏览器存储不可写时，Codex 新控制在发送前被拒绝。其他 agent 沿用原行为。同源 HTTP 请求默认 25 秒超时，LAN 默认 15 秒。

`relay.createCsr {privateKeyDer,hosts}` 是仅本机 runtime stdio 的 RPC，不属于 web.request 或 remote.request 操作。privateKeyDer 为 base64 编码的 PKCS#8 P-256 私钥，hosts 为 1–16 个 DNS 主机名；返回 `{csrPem}`。实现复用既有 rcgen/ring，未新增 OpenSSL、外部进程或网络依赖，不落盘私钥。私钥由桌面本地生成保管，给 ACME/broker 的只有签名 CSR。

## 扩展控制与能力查询（2026-09-26）

`GET /api/web/v1/codex/capabilities?sessionId=…` 返回每项原生能力的可用性与禁用原因，桌面服务再次与设备权限、工作区、实验执行开关求交集。官方 follower 与托管 app-server 不共享未经验证的高级操作；已验证的基本发送/停止/审批/问答保持兼容。工作树创建、分支切换继续不可用，不能以自行运行 Git 替代官方语义。

`POST /api/web/v1/codex/<action>` 扩展 `inspect`、`resume`、`steer`、原生 `queue-add/update/delete/reorder`、`rename/archive/unarchive/fork/settings`。写操作携带唯一 requestId、bootId 和适用的 expectedRevision。inspect 只读核对，不启动执行、不重新发送。resume 要求明确交接确认，仍由官方 writer 锁决定是否成功。

原生队列在空闲时添加消息会立即执行，任务完成后自动消费下一条。因此网页只在运行中开放加入队列；不提供自建离线发送队列，也不自动重放未确认队列操作。`queue-start` 的成功路径尚未验证，能力保持关闭。含附件的原生队列消息暂不支持正文编辑，避免替换输入时静默丢失附件；可删除后重新添加。只读队列投影不返回本机绝对附件路径。

归档使用官方 thread/archive；取消归档仅恢复历史可见性，原生引擎不会自动持有该线程。需明确恢复后才能继续发送。fork 创建新的官方 thread ID，不能作为同 ID 交接失败的自动回退。下一轮模型、思考强度和计划/普通模式使用官方 settings 更新；省略字段表示保持当前设置。

扩展审批保留原生提供的完整决定与作用范围。结构化决定必须精确匹配当前请求的候选，包括拟议命令规则、网络规则及权限配置；未知作用域关闭操作。基本浏览器授权不会获得会话级或持久权限决定。秘密问答以密码输入显示，只按请求 ID 和 turn ID 向原生引擎回答；本地命令账本和浏览器回执不保存答案正文。

离线原生协议验收（临时目录、本地模拟模型、真实 Codex 进程）：

```sh
python3 crates/agentkib-runtime/tests/fixtures/codex_native_completion.py /opt/homebrew/bin/codex /Applications/ChatGPT.app/Contents/Resources/codex
python3 crates/agentkib-runtime/tests/fixtures/codex_native_questions.py /opt/homebrew/bin/codex /Applications/ChatGPT.app/Contents/Resources/codex
```

这些测试不等同于真实公网手机验收。功能启用情况以实际频道的能力响应为准。

本轮扩展的操作/权限、原生双版本验证、构建及界面验收记录见 [Codex 远控补全验收](../qa/codex-completion-2026-09-26.md)。官方 follower 尚未验证的高级操作不会因托管 app-server 测试通过而开启。
