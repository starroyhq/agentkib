# Codex 托管执行

Codex 同 Agent 续接统一使用 AgentKib 自己启动的 `codex app-server`，`executionMode` 为 `codex-managed`，支持 macOS、Linux 和 Windows 的这条链路。会话的写锁被其他进程持有、且 Codex 桌面端的本地 IPC 报告了这条会话的 owner 时，改为跟随该 owner（`codex-follower`，仅 macOS，见下文“跟随 Codex 桌面端”）；无法跟随时保留普通输入框及占用提示，按能力禁用发送，跟随也不作为续接失败后的自动回退。打开页面只观察，空闲会话发送时自动续接，不再勾选交接。创建与管理仍须对应设备授权；发送继续检查实验控制、工作区和未知回执。Web/Electron 负责授权，TypeScript backend 在每次操作前复核 canonical 路径、会话身份和同一 CODEX_HOME。

## RPC

`codex.managed` 接受 camelCase 对象，拒绝未知字段：

| operation | 参数 | 结果 |
| --- | --- | --- |
| options | 无 | `available`, `models:[{id,name,isDefault,efforts}]`, `policies`，不可用附 `reason` |
| create | `workspaceId`, UUID `requestId`, 可选 `model`, `effort`, `policyId` | `sessionId`, `accepted`, `completed`, `runtimeBootId`, `live` |
| release | `sessionId`, UUID `requestId` | `released:true`, `accepted:true` |
| reconcile | `sessionId`, UUID `requestId` | `reconciled:true` 和 `live`，或 `false` 和原因 |

HTTP 另外携带 Electron `bootId`，由 Electron 验证，不直接传给 Runtime。托管 sessionId 为 64 位十六进制，对外不暴露原生路径。create 不接受首条消息；成功获取 sessionId 后再单独 send，避免创建回执丢失时重复执行首条消息。相同 requestId 和输入重试返回持久回执；同 ID 换输入会拒绝。

不再提供独立的 `adopt` 操作或 HTTP 接口。打开旧会话、把已有会话指派为 Worker 时，只读取和登记已验证身份。模型、权限与模式先保存设置，原生线程在原 `send` 请求中按需恢复。恢复与发送共用该次发送回执，仍检查原生身份、写锁和权限。初始化失败不会另留一条接管回执，也不会自动重发。旧版本已保存的接管回执继续只读核对。指派流程见[项目 Agent](project-agent.md)。

现有 `web.request` 对托管会话自动分派 `live`, `events`, `send`, `stop`, `approve`, `answer`。控制参数沿用 `runtimeBootId`, `expectedRevision`, UUID `requestId`, `experimentalEnabled:true`；审批/问答另外验证原生 `turnId` 和请求 ID。`events` 默认最新 50 条、页面内部按时间正序；`next_cursor` 向更早历史分页。catalog 合并持久托管记录，即使会话索引关闭或重建，托管任务仍可见。

`web.request {operation:"diff",workspaceId,kind,path?,oid?}` 返回既有 `GitDiff|null`；kind 为 `worktree`, `staged`, `commit`。只允许注册仓库根目录，commit 需要 oid。读 patch 前验证 Git 文件列表与 rename 两端；不指定 path 时，只要整个候选变更中有敏感路径就拒绝。`.env`、凭据、认证/token 文件、私钥、原生代理私有状态目录等拒绝；允许 `.codex/worktrees/<project>` 中的合法仓库。path 必须是精确变更文件，拒绝目录/pathspec magic。输出前再次复核元数据和工作区授权映射。

已授权浏览器打开单个 Codex 会话详情时，`GET /api/web/v1/managed/context?sessionId=…` 按该线程 ID 调用官方 `thread/read`，并设置 `includeTurns:false`。仅返回已授权执行目录、原生项目 ID 和 `gitInfo.branch`；后者是**创建时分支**，不代表当前 Git 分支。原生字段缺失或读取失败时界面显示未知或不可用。此查询不恢复线程、不获取 writer 锁、不持久化另一份工作树状态。Codex 当前协议没有正式的工作树创建、类型或起始分支接口，因此手机端不提供这些操作，也不会凭 `.codex/worktrees` 路径推断工作树类型。上文 Git diff 的 `worktree` 只表示工作区未暂存差异。

## 执行策略与版本适配

新建托管会话默认使用 `workspace-write-on-request`：`workspace-write`、`on-request`、人工 reviewer、sandbox network=false。完整授权浏览器可在主机返回的映射策略中显式切换为完全访问（不弹审批）或工作区写入／自动审核；新建时也可以直接选这三种映射策略之一，选默认以外的同样只限完整授权的设备（桌面按本机用户处理）。浏览器不能提交任意 sandbox 对象、cwd、CLI 参数、额外可写根或审核器参数。策略更新携带当前修订号。AgentKib 管理的轮次运行中也可保存。宿主把选择与回执一起写入账本，下一次发送通过 `turn/start` 使用新策略。旧记录缺少策略字段时仍使用原受限默认。

对于从 Codex 桌面版或 CLI 接手的线程，AgentKib 从已核验的原生 rollout 读取最近的执行策略。审批方式、审核器、沙盒、网络和可写目录等限制都能与现有策略对应时，直接显示并沿用该策略。存在无法对应的原生限制或近期配置无法核实时，「执行策略」照常显示为只读，悬停可查看原因，AgentKib 不会按另一种策略启动轮次。

用户在 AgentKib 明确改选的策略按会话保存，由下一轮使用，从输入框发送和项目 Agent 的 `worker_send` 都读取这份设置。AgentKib 继续用原生策略核对恢复回包，再在下一轮应用明确改选的策略。ChatGPT 再次打开线程时使用它自己的设置。 沿用原生的完全访问或自动审核策略来续跑时，发起续跑的设备需有完全访问权。

模型、思考强度和服务档位来自 `model/list`；Plan／执行模式来自实验协议 `collaborationMode/list`：runner 启动时读取一次，同时列出 `plan` 与 `default` 两个预设（按 `mode` 字段识别）才开放 Plan；读取失败或结构不符时 Plan 保持不可用，会话照常使用。0.163.0 与 0.147.0 都已对本地桩核对，见 [Codex 接入补齐验收](../../qa/codex-gaps-2026-10-28.md)。在 AgentKib 保存设置只改变 `selected`，不启动轮次；`current` 保留原生确认值，`applicationStatus` 区分 `pending`、`confirmed` 和 `unknown`。下一次显式发送在 `turn/start.collaborationMode` 传入选择，内外模型和强度一致，`developer_instructions:null` 由 Codex 加载内置指令。没有自定义计划提示词、隐藏空轮次或自动执行计划。实时链路里计划是原生 `plan` 项；原生记录里计划写在 Agent 回复的 `<proposed_plan>` 标签内，读历史时去掉这对标签，只显示计划正文。

新建选项和没有 runner 的会话设置要读模型目录时，每次都得临时启动一个 app-server；它可能还要先从网络刷新共享的 `models_cache.json`（ChatGPT 桌面版内置的 Codex 与 PATH 上的 CLI 版本不同时，几乎每次都会刷新，实测约 3–4 秒）。所以电脑端按 CLI 文件身份、CODEX_HOME 和工作目录缓存最近一次的模型和预设：有缓存时立即返回，超过 5 分钟才在后台重读。对于能从原生记录读到策略的外部线程，即使首次读取也会先返回可独立显示的执行策略，模型和预设在后台加载。后台加载失败时保留仍可验证的设置。缓存只用于显示；有 runner 时设置照常读实时目录，发送和保存设置前仍按实时目录核对模型、强度和档位。

分支从已验证身份的 `thread/read` 继承源模型与思考强度，不回退到 CLI 当前配置的默认值。原生未提供有效强度时，只接受模型匹配的已有托管值；仍无法核实时明确拒绝分支。`reasoningEffort:null` 不能当作“无思考”或覆盖配置默认值的证据。单纯恢复/分支可挂接保留已不在选项列表中的源模型，方便查看和修改下一轮设置；真正发起推理前及显式新建/选择模型时仍核对选项。模型或强度不受支持时，主机只透传白名单原因，两端保留草稿、说明具体原因并提供“更改下一轮模型”；源设置未确认则说明如何先核实源会话，不把它变成未知派发或虚构选模入口。

切换模型会重新校验 effort 与 service tier；恢复默认只在主机能给出明确默认模型时开放，且不改变计划模式或执行策略。重启保留选择但不把旧 mode 当作原生事实；恢复响应缺少模式时（0.147.0、0.155.1），等待下一轮原生事件确认。执行期间原生明确请求的额外权限，只有单独获扩展审批授权的浏览器才能按原生候选决定；完整浏览器授权不等于自动批准。一次最多持有 8 个托管进程，每个会话一个专用 app-server。

Goal 使用 `thread/goal/get/set/clear` 和原生事件。`goal-set` 的 `intent:update` 不传原生 status，保留暂停、阻塞或受限状态；`intent:start`（旧请求缺省值）仅创建不存在的目标并明确激活。已有目标的旧缺省请求拒绝，避免意外恢复。预算字段缺省保留、`null` 清空，修改不重置消耗。仅活动目标可暂停；暂停／阻塞可显式恢复，预算或用量受限可尝试恢复，仍以 Codex 返回的最终状态为准。完成目标须清除后新建。设置尚未原生确认时阻止目标启动／恢复；不发送隐藏消息补偿，不新增目标调度器。

用哪一份 Codex CLI：依次是 PATH 找到的、其他常见安装位置的、Codex 桌面端自带的（仅 macOS：`/Applications` 或 `~/Applications` 下 `ChatGPT.app`、`Codex.app` 包里的 `Contents/Resources/codex-cli/bin/codex`，旧版 Codex.app 的 `Contents/Resources/codex`）。逐个读 `--version`，取第一份不低于写锁起始版本 `0.147.0` 的；PATH 上那份能用时不运行其他的。首行提到 codex 并带三段版本号即可识别（`codex-cli 0.167.0`、`codex 1.0.0 (…)`、`Codex CLI v1.2.3`）。没有一份能确认可用、但有一份读不出版本号时，照常试用它：不带写锁的旧版本都打印 `codex-cli X.Y.Z`，读不出的只会是之后的格式；runner 启动后再按 app-server `initialize` 回包 `userAgent`（`agentkib/0.167.0 (…)`）里的版本核对一次，低于 `0.147.0` 就在第一轮之前停下，报 `codex-cli-version-too-old`。每一份都版本过低或运行失败时才保持只读，原因取排在最前那份的。读历史、技能、上下文、目标等不需要写锁的请求用最近一次检查选中的那份，还没有时用 PATH 找到的或桌面端那份，不为此运行 `--version`。最低版本实测及能力限制见[第 1 阶段 QA](../../qa/session-continue-stage-1-validation-2026-10-19.md)。官方 thread/start/resume 回包还必须确认 cwd、sandbox、reviewer、可写根及本地环境。版本门槛不表示每个版本或可选能力都已验收；模型、Plan、Goal 等仍分别核验原生能力。Plan 和原生待发队列在 runner 启动时探测：0.147.0 没有 `thread/queue/*`（0.148.0 加入），对 `thread/queue/list` 回 -32600 “unknown variant” 并保持连接，此时队列各项能力显示 `unsupported-codex-cli-version`，追加指令（`turn/steer`）不受影响。探测在 thread/resume 之后进行，因为 0.163.0 不能列出未加载线程的队列。CI 每天检查最低版本与最新版的协议，见下文“协议检查”。

目录刷新共享已有的全局 CLI 版本探测与缓存，不逐条会话启动探针。已核实版本过低时，桌面和 Web 列表标记“仅可查看”；全局版本原因不携带原生路径，也不将未登记集合加入 Web 历史授权范围。“设置是否生效尚未确认”仅在当前页面确实发起过设置更改后显示，不将未更改设置的初始 unknown 状态作为失败提示。

### 跟随 Codex 桌面端（2026-11-02）

Codex 每条会话只允许一个进程写入。ChatGPT 桌面端用自己启动的 app-server 打开会话后会一直持有写锁（不显示的会话约 3 小时后才退订），AgentKib 的 `thread/resume` 因此被拒绝。为了不必分支或退出桌面端，AgentKib 像 VS Code 插件那样作为 follower 加入桌面端的本地 IPC：订阅 owner 的实时状态，把发送、停止和审批交给 owner 执行，写入的始终只有桌面端。

- **何时跟随**：仅在 `live`／`capabilities` 发现写锁被其他进程持有、且没有其他阻断原因时尝试。连接 `<CODEX_HOME>/ipc/ipc.sock`，按原生 ID 做 owner discovery；成功后 `live` 返回 `executionMode: "codex-follower"`、`executionLocation: "external"`、`ownershipReason: null` 和 `workspaceId`。非 macOS、找不到 owner（例如锁在 CLI 或其他进程手里）、版本或协议不符、连接失败时显示 `codex-owner-busy` 占用提示并保留可编辑草稿，5 秒内不重复尝试，不向界面透出跟随失败的细节。写锁空闲时照常走托管链路。
- **桌面端还占着、但没有窗口在用**：桌面端的页面离开一条会话后，app-server 仍然加载着它、持有写锁，可以长达数小时没有任何窗口应答 owner discovery。这时只要桌面端（ChatGPT.app 或 Codex.app 的主进程）正在运行，`live` 仍报 `ownershipReason: "codex-owner-busy"`，但 `sendEnabled: true` 并带 `ownerHandoff: true`，`capabilities` 只开放发送和附件；桌面与 Web 显示输入框和“在 Codex 中打开 · 发送时连接”。发送时 AgentKib 先照常尝试续接，被写锁挡住后用 `open -g codex://threads/<id>` 请桌面端在后台（不抢焦点）打开这条会话，最多等 8 秒（`AGENTKIB_CODEX_HANDOFF_TIMEOUT_MS` 可改）找到 owner，再按上面的跟随链路把消息交给它，回执与跟随发送相同（`executionMode: "codex-follower"`）。只有发送会请桌面端打开：在 AgentKib 里打开、浏览会话不会让桌面端的页面跳动。桌面端没在运行时不打开链接（打开会启动 App），也不抢写锁、不自己续接；桌面端没有接手时这条消息不发出，草稿保留，一分钟内不再提供“发送时连接”。
- **项目 Agent 派工**：`worker_send` 会重新检查写锁并主动发现 owner，空闲线程已由兼容桌面端接管时把消息交给该 owner。没有 owner、版本过低或连不上时分别返回 `codex-desktop-owner-missing`、`codex-desktop-version-too-old`、`codex-desktop-owner-unavailable`。派工不会替人打开桌面端会话。查活仍只在有活动轮次证据时主动连接。连接后，`worker_read` 会列出等待用户处理的问题和审批，主控会收到对应的等待汇报。
- **可用操作**：开放发送、停止和审批，命令与文件审批采用 owner 提供的决定。附件与发送条件相同，图片作为原生 `localImage`，其他文件作为文件引用文本。分支照常可用，删除受原生写锁约束。当前 owner 的模型、强度、目录及同一安装的模型表均已核实时，空闲或运行中都可以为下一轮修改模型和强度。写入后的回执需与 owner 的设置回读和会话快照一致。Fast、权限、Plan、追加、队列、压缩、目标、重命名、归档和问答在 Codex 中处理。继续执行使用这条会话的原生策略和沙箱设置。
- **状态与历史**：follower 只推送实时状态（运行状态、轮次、审批、流式文字）；对话内容仍以 250ms 快照从原生 rollout 读取，避免同一消息以两种身份重复出现。
- **生命周期**：最多同时跟随 8 条会话；有 follower 时桌面端不会退订这条会话，所以没有订阅者且闲置 30 秒后断开跟随。owner 变化或断开时关闭连接，重新核对写锁：锁已释放则回到托管链路，发送时自动续接；不会在两条链路之间自动重发消息。
- **授权与回执**：主机继续核对工作区、设备权限、LAN 范围和回执访问。设置变更携带当前 owner 的 `writeScope` 和状态修订号，派发时再次校验。owner 明确拒绝时，AgentKib 保留当前设置。owner 确认已应用后，AgentKib 从同一 owner 的新快照和模型读取接口核对模型与强度，再确认成功。应用结果未知时保留回执供复核。发送、停止和审批沿用各自已有的原生证据。
- **版本**：基础 follower 仍按 Desktop 最低版本 `26.917.62051` 和 IPC 方法契约校验。模型和强度写入依据已验证安装中的方法声明和实时回包，要求 `thread-follower-read-model-settings` v1 与 `thread-follower-update-thread-settings` v2。状态流按消息结构、增量顺序和会话身份判断兼容性。历史验收涵盖跟随发送、停止、审批与图片发送。见 [跟随 Codex 桌面端验收](../../qa/codex-desktop-follow-2026-11-02.md)及[二期 2b 验收](../../qa/dsh-integration-phase2b-2026-11-05.md)。
- **限制**：只支持 macOS；桌面端必须已经加载这条会话；两端同时发送的竞争（RACE-022）、桌面端中途退出后的真实切换尚未实机验收。旧的 `#reconcileCodexFollower` 等遗留辅助函数暂保留，待单独清理。

### 原生状态与用量

实时快照以独立 `activity: compacting | null` 表示上下文压缩，不改写原生 turn 状态。托管侧跟踪匹配 thread、turn 和 item 的 `contextCompaction` 开始／完成；follower 从已验证快照的活动 turn 与 `completed:false` item 识别，包含官方手动压缩的无 turn ID 占位。压缩期间禁止即时发送、steer、设置、目标修改和执行转移；有已确认活动 turn 时仍可原生停止，已有原生排队及有效待处理请求按各自能力保留。无 turn ID 时不制造停止目标。压缩结束、失败或中断由匹配原生生命周期确认；断线及过期 hydrate 不得恢复旧运行态。

`usage` 仅投影最近原生报告的上下文占用与累计消费，保留兼容 `tokenUsage`。`reportGeneration` 区分原生观察实例，在当前 backend 进程内递增；`reportId` 只随真实 usage 事件或 follower usage 字段变化递增，普通 revision 或重复快照不算新报告。连接重建后可以重置 `reportId`，即使另一端持续订阅使传输 epoch 不变，两端仍能接受新实例的报告并拒绝旧实例晚到的报告。backend 重启仍通过运行实例作用域重置；没有原生观察实例的持久旧报告不沿用其代次。压缩开始使旧 Gauge 失效；期间到达的报告保留为 pending 候选，结束后同 turn 报告保持 stale，因为压缩调用输入可能仍是压缩前上下文。模型身份或托管模型选择变化也使旧报告失效；明确仍待应用的模型选择不得复用旧窗口。匹配后续新 turn 的报告可恢复 ready；无法归属、重连或恢复时不沿用旧百分比，不通过发送任务补刷新，控制恢复也不等待用量报告。

Web 的模型、服务档位、策略和资源能力取自当前 app-server 的已验证目录及权限，不从 follower 快照推测能力；跟随桌面端时这些操作关闭。

## 原 ID 自动续接与退出

没有本机活动 runner 时，发送自动准备并续接同一原生 thread ID；源索引与 rollout 元数据共同验证 ID 和工作区。专用 app-server 在同一 canonical CODEX_HOME 上调用官方 thread/resume，由 Codex 自己原子获取每线程 writer lock。原 writer 未退出时，若 Codex 桌面端报告了这条会话的 owner，打开页面即改为跟随（见上文）；若桌面端仍运行且明确没有窗口应答，发送时尝试连接。暂时无法跟随时返回 `codex-owner-busy`，输入框保留草稿并继续检查写锁。需要分支时可从会话操作菜单发起。AgentKib 不停止共享 daemon、不删除 native lock、不复制 CODEX_HOME，也不默认 fork。原生 active goal 等恢复风险及未知结果仍按内部规则阻断，不因省去用户确认而放行。

Codex 应用或 CLI 正在执行的轮次只用于显示。目录只看 `thread-writer-locks/` 里有锁文件的线程：锁被持有，并且 rollout 里最后开始的一轮还没有 `task_complete` 或 `turn_aborted`，才给会话加 `externalTurn: { status: "running", startedAt }`。只看最后开始的一轮，是因为分支和子代理线程的 rollout 开头带着父线程没有结束的轮次。锁未被持有，说明打开线程的客户端已经退出；锁文件比这一轮新，说明这一轮属于先前退出的客户端（Codex 释放时删除锁文件，新进程第一次取锁时清掉无人持有的旧文件）；rollout 超过 6 小时没有写入也不算运行。每条 rollout 第一次只读末尾 8 MiB，之后只读新增部分；末尾没有轮次事件时，用新版 Codex 自己的 `thread_history_*.sqlite` 轮次记录补齐，读不到就不显示。AgentKib 自己的 runner 在场时不显示这个字段；live 状态在 `codex-owner-busy` 时带同一字段。它不改变 `continuation`、发送、分支和占用裁决。

旧托管记录缺少执行 cwd 时，自动续接在持锁期间重新核实并保存原生工作目录，与登记工作区边界分开。续接后首条发送可接受迟到的纯用量更新及重复通知，不因观察版本变化误报“本次操作未执行”；身份、设置、目标或轮次发生真实变化时仍拒绝派发，即使字段随后恢复原值也不放行。普通控制继续使用原有 revision 校验。

登记工作区仅作为授权边界。恢复执行和分支的执行目录取 UUID 已核实的 rollout `session_meta.cwd`，经 canonical 路径确认仍在登记工作区内后，单独保存为托管记录的 `cwd`，用于 app-server、恢复、分支、下一轮与工作区写入策略的可写根。登记工作区为 `/` 或用户主目录时，也只允许经过核实的安全子目录；会话自身目录为文件系统根或用户主目录时按“仅可查看”处理。目录缺失、不是目录、无法核实或位于授权范围外时给出具体原因，不回退到登记工作区。旧台账没有 `cwd` 时重新核实原生头部，不能把旧 `workspace` 当成执行目录。原有 ID、HOME、锁、版本和策略回包校验继续生效。

Codex 的 `workspace-write` 隐式允许 cwd，原生 `writableRoots` 仅列额外目录，空数组不表示 cwd 不可写。校验启动响应时，顶层与线程 cwd 必须匹配经过核实的执行目录，canonical 后的附加根不得扩大范围。两种工作区写入策略在启动配置和每轮请求中都显式排除 `/tmp` 与环境 `TMPDIR` 的默认额外授权，并要求原生响应的两个排除标记严格为 true；缺失或不确认时拒绝执行。该限制不改变用户显式选择完全访问策略的既有语义。

自动回收和兼容 release 路径只关闭本服务创建的子进程组，必要时终止，并等待实际退出后释放 lease 与原生锁。正常轮次完成后空闲约 1 分钟回收；最后订阅者离开时等待当前轮次完成后回收。关闭失败或存在未知回执时保留相应保护，不把超时当作已安全退出。回收后保留历史和原生身份，下次发送自动重新校验、启动，不回到 follower。退出 AgentKib/runtime 会关闭专用子进程，没有独立常驻 daemon 或新增 goal 调度器。

无活动 runner 时，只读历史从身份、HOME、canonical cwd 及登记边界均核实的原生记录读取，刷新可见终端后来新增的轮次，不启动 app-server。原生历史与活动 ledger 的分页游标分开，切换来源时要求重新读取，避免混页。目录仅凭已证明的原生身份和别名消重，不能按相同标题合并；托管行活动时间使用核实的原生时间，不以读取时刻伪造更新。

Codex 把闲置记录压缩为 `.jsonl.zst`、线程表仍登记原 `.jsonl` 时，原文件缺失才尝试压缩同名文件；直接登记 `.zst` 也支持。有限头部用于原生身份校验，私有解压副本供历史分页和文档读取，索引流式解压；不修改原始记录或源索引。单份副本上限 2 GiB，缓存按 4 GiB 目标淘汰旧副本，15 分钟内近期使用的副本保留以保护游标，因此总量可能暂时超过目标。缓存命中不改变副本 mtime，并发首次发布不替换已发布 inode；文件安全、头部和解压上限不放宽。

## 持久账本及恢复

账本在 `agentkib_store::default_data_dir()/codex-managed/executions.sqlite`，与可重建 conversation index 分离。专属目录权限 0700、主 DB 0600，WAL 文件在同一受限目录。SQLite WAL 和 3 秒 busy timeout；初始化在 IMMEDIATE 事务中建表，并按 table_info 对缺失的 evidence 列做添加式迁移，不删除旧行。

- `managed_sessions(id PRIMARY KEY,record)`：工作区授权映射、经核实的执行 `cwd`、canonical HOME、原生 ID、选择的模型/effort、release 标记、最后快照。
- `managed_commands(request_id PRIMARY KEY,session_id,fingerprint,phase,result,evidence)`：请求 SHA256、prepared/dispatched/resolved 状态、回执与最小原生证据。不会持久化完整原始控制请求。
- `managed_events(sequence PRIMARY KEY,session_id,event_id,event)`：显示历史，按 `(session_id,event_id)` 去重。

会话记录在 thread/start 之前写入；thread/started 通知也会尽早持久化 native ID，所以创建 HTTP 回执丢失后仍可在 catalog 找回任务。发送前先写 dispatched，再向原生 pipe 写入；超时/断开保持 unknown fence，不自动重发。runtime 重启不会自动恢复模型执行；没有未决回执且原生身份安全可恢复时，下次显式发送触发自动续接，有未知结果时仍先查询回执并核对证据。

reconcile 读取原生 thread/read。send/steer/queue-add 必须找到对应 `userMessage.clientId == requestId`；stop 必须找到其目标 turn 的明确终态；审批和问答必须确认原生 `serverRequest/resolved`，单纯轮次结束不能证明对应决定已执行；创建/交接须已获得并重新核实同一个 native ID。通过后才记账并返回 `reconciled:true`，供 Electron 清除不确定结果屏障。无法核对、native ID 缺失、原客户端仍持锁、原生历史未持久化，均返回 false，不允许手工跳过未知发送。实测官方零消息线程（包括 persistExtendedHistory 或设置名称）尚未生成可核实身份的 rollout；Codex 0.155.1 的只读探针仍可能读取或续接这类空线程，但这不能替代 AgentKib 的 rollout 身份校验。若在首条消息前退出 runtime，会保留可找到的账本任务，但 AgentKib 不能恢复这个空 native ID，须 release 后显式新建。

没有足够原生证据的任务会保持只读；不得用新请求 ID 重放猜测已执行的操作。

## 失败、重试与服务端请求（2026-10-28）

失败的轮次以 Codex 自己的错误文字结束：`turn/completed` 的 `turn.error`（缺失时取该轮最后一条 `error` 通知）成为该轮最后一行，ID 为 `codex-turn-error:<turnId>`，标记 `cli_output`，客户端按原样显示；读原生记录时，`task_complete.error` 得到同一行。`thread/status/changed` 的 `systemError` 只表示上一轮出错，直到下一轮开始，不再让会话进入错误状态，轮次结束后可以照常发送。

`error` 通知带 `willRetry:true` 时，实时状态的 `apiRetry` 记录第几次（取自 “Reconnecting... 1/2”）、HTTP 状态、错误类别和 Codex 的附加说明；输入区显示“Codex 的请求失败了，正在重试（第 1/2 次，HTTP 401）”，401 时附认证提示，可以随时停止本轮。Codex 有新输出、报出最终错误或轮次结束时清除。

`mcpServer/elicitation/request` 显示为审批。非只读 MCP 工具的审批（`_meta.codex_approval_kind` 为 `mcp_tool_call`，空表单）可以允许、拒绝或取消本轮，CLI 提供 `persist: "session"` 时另有“本会话内允许”；不提供“始终允许”，因为它会写入用户的 Codex 配置。其他确认只有允许和拒绝；带字段的表单、URL 和其他类型目前只能拒绝。与当前轮次不符的请求自动回复 `decline`。其他没有处理的服务端请求回 JSON-RPC -32601 `AgentKib does not handle <method>`，轮次不再停在等待输入。

附件与发送使用同一条件开放：图片作为原生 `localImage`，其他文件作为文件引用文本。附件按钮不可用时说明原因。

## 压缩、后台终端与斜杠命令（2026-10-28）

桌面和 Web 输入框的 `/compact` 调用 `thread/compact/start`，只在空闲且可发送时开放。Codex 先回 `{}`，再开始压缩自己的轮次；主机最多等 5 秒，看到该轮开始后返回，之后按 `activity: compacting` 处理。

`/stop` 调用 `thread/backgroundTerminals/clean`，结束仍在后台运行的命令。停止按钮仍只中断当前轮次（`turn/interrupt`），与终端里按 Esc 一致。后台终端随 runner 进程结束，所以 `terminals-clean` 只在 runner 运行时开放。

app-server 没有斜杠命令：`/compact` 这样的文字只会作为消息交给模型。Codex 会话的输入区输入 `/` 时列出 AgentKib 能代为执行的命令：`/compact`、`/review`、`/plan`、`/model`、`/permissions`、`/status`、`/rename`、`/goal`、`/fork`、`/stop`、`/archive`、`/diff`、`/init`。`/plan <提示>`、`/model <模型>`、`/rename <名称>`、`/goal <目标>` 直接执行，`/plan` 切换后把提示留在输入框；不带参数时打开对应界面；当前不可用时保留草稿并说明原因。运行中追加指令或加入队列时不执行这些命令，同样保留草稿并说明原因，与带附件的消息一样。其余 Codex 终端命令（按 0.163.0 的 `SlashCommand`，含别名）不发送，说明只能在终端使用；`/new`、`/clear` 提示新建会话。其他 `/名称` 照常作为文字发送。规则只在客户端：这些文字交给模型不会造成损害，主机不拦截。命令表在 `packages/runtime-protocol/src/codex-commands.ts`。

`/review [分支]` 和 `/init` 发出 AgentKib 写好的一条普通消息，和 Codex Desktop 的做法一样，不调用 `review/start`：0.163.0 的 `review/start` 返回的轮次 ID 与 `turn/started` 通知里的不同，项目和 `turn/completed` 用前者，按现有状态机会停在运行中。

- `/review` 审查未提交的改动（已暂存、未暂存和未跟踪的文件）。`/review <分支>` 让 Codex 先用 `git merge-base HEAD <分支>` 找到分叉点，再看与它的差异。分支只接受一个修订名，例如 `main`、`origin/main`、`HEAD~3`：不含空白和 shell 会特殊处理的字符，不以 `-`、`.`、`/` 开头，最长 200 个字符；其他写法保留草稿并说明用法。两种都要求只读不改，只报告值得修改的问题。
- `/init` 让 Codex 在当前目录写 AGENTS.md，已经存在时不改动。是否存在由 Codex 自己检查；Desktop 是发出前先查。
- 消息按界面语言书写，原样显示在会话里，并按当前的下一轮设置运行，包括 Plan 模式。说明文字是 AgentKib 自己写的，没有沿用 Desktop 的提示词。

暂不支持：

- `!命令`（`thread/shellCommand`）。
- MCP 表单与 URL 请求只能拒绝；不提供“始终允许”。

## 会话标题（2026-11-16）

Codex 的 app-server 不会自己给会话起名，终端客户端是自己起的（0.167.0 `tui/src/app/thread_title.rs`）。AgentKib 照同样的做法给它运行的 Codex 会话（包括项目 Agent 的 Worker）起标题：这次运行中会话第一次出现用户消息（发送、追加或排队）时，如果 `thread/read` 说这条会话没有名称（`name` 为 `null`；没有这个字段时不起），就在这条会话的 app-server 上另开一个临时线程跑一轮，得到标题后用 `thread/name/set` 设给会话，并通知目录刷新。实现在 `packages/backend/src/codex-thread-title.ts`。

- **与终端客户端相同**：临时线程 `ephemeral`（不写磁盘，不出现在 Codex 的会话列表里）、只读沙箱（`default_permissions` 为内置的 `:read-only`）、审批 `never`、工作目录与会话相同、`threadSource: "thread_title"`。和终端客户端一样用 `thread/start` 的 `config` 关掉这个线程能用的一切：`features.*` 里的 shell、unified exec、hooks、apps、插件、记忆、多代理、图片等 22 项，skills 说明、update_plan、提问工具和网页搜索；用户的 MCP 服务器先用 `config/read`（带会话的 cwd）读出名字，再逐个设 `enabled: false`，读不到就不起标题。提示词用终端客户端的原文，后面是会话的第一条消息（Codex 的 `preview`；新会话还没有时取刚出现的这条），截到 960 字节；`outputSchema` 只有 `title`（1–36 个字符）。回复按终端客户端的规则解析：必须是只含 `title` 的 JSON 对象，去掉两端引号、合并空白和句末的 `.?!`，截到 36 个字符。结束后 `thread/unsubscribe`；30 秒内没结束先 `turn/interrupt`。
- **模型与用量**：`model/list` 里有 `gpt-5.6-luna` 时用它，思考强度 low，与终端客户端相同；没有时用会话自己的模型和它支持的最低思考强度。每条新会话因此多一次很小的模型请求，计入账户的 Codex 用量。
- **不覆盖名称**：只在 Codex 说没有名称时起；设名前再读一次，期间用户或其他 Codex 客户端起了名、或在 AgentKib 里重命名过，就不设。同一条会话在 AgentKib 每次运行期间最多试一次。
- **失败不提示**：模型出错、达到使用上限、超时、回复不是标题、runner 被回收或 AgentKib 正在退出，都不显示，会话保留 Codex 自己的标题（第一条消息）。退出时不再开始新的。
- **不算会话的轮次**：临时线程的通知和服务端请求不进入会话的实时状态、历史、已读记录、项目 Agent 的自发轮次计数、Worker 汇报和使用上限处理；它的服务端请求一律拒绝（MCP 表单回 `decline`）。标题在后台生成，不延迟用户的这一轮。

2026-11-16 用 0.167.0 的 app-server 在隔离的 CODEX_HOME 里（无登录、沙箱禁网）核对：`model/list` 列出 `gpt-5.6-luna`（思考强度 low 到 max 五档）；上面的 `thread/start` 回 `ephemeral: true`、`path: null`、只读沙箱，`thread/list` 不含它，`thread/unsubscribe` 回 `unsubscribed`。config.toml 里配一个启动时会留下标记文件的 MCP 服务器：不带这些设置时临时线程启动了它，带上后没有启动。再用 AgentKib 的实际代码跑完整流程：`config/read`、`thread/start`、`turn/start`（含 `outputSchema` 和 `effort`）都被接受，没有网络时这一轮一直重连，30 秒的上限（测试里设 20 秒）到了先 `turn/interrupt` 再 `thread/unsubscribe`，不设名称。真实模型下的一轮未实机验收。

## 协议检查（CI）

`.github/workflows/codex-protocol-compatibility.yml` 每天、手动或相关文件改动的 PR 时，在 macos-15 上分别检查最低版本（`MINIMUM_CODEX_WRITER_VERSION`）与最新版。脚本从 npm 官方源安装 `@openai/codex`，在 `sandbox-exec` 里运行 `codex app-server generate-json-schema --experimental`（无网络、不读个人目录、不登录、不调模型），核对 AgentKib 调用、处理和读取的方法与字段。`required` 层是每个受支持版本都必须有的，两端都查；`current` 层是缺了会降级的功能（Plan、待发队列、MCP 请求、设置与目标通知、会话标题等），只查最新版。输出只有固定标签，不转发 CLI 输出。脚本的单元测试也在 Linux 与 Windows 的辅助任务里运行。

## 验证

本轮的真实 CLI 核对、变异检查与未验证项见 [Codex 接入补齐验收](../../qa/codex-gaps-2026-10-28.md)。

运行桌面验证套件：

```sh
pnpm --filter @agentkib/desktop exec vitest run electron/main/web/codex-actions.test.ts
```

上游 Rust 分支保存的真实 Codex 双版本验收结果属于历史证据；它不表示这轮 TypeScript backend 已重复通过同一 CLI 实机验收。Runtime 协议类型由桌面端 `pnpm protocol:generate` 从 `packages/runtime-protocol` 生成。

## 持久控制回执与本机 CSR

当前 managed 控制和保留的旧 follower 账本都使用 `executions.sqlite` 的持久去重与 unknown 保护；旧账本仍需可核对，不表示主路由重新调用 follower。SQLite 成功记录 dispatched 后才发送原生请求；无法写账本时不发送。收到匹配的原生回执才写 resolved。释放会话前也检查未确认记录；存在已派发但结果未知的审批、问答或其他控制时，release 明确返回未派发，保留执行进程及其原生 resolved 证据。应先 inspect 核对，不自动重试旧命令。runtime 重启后，任何设备对同一 session 的后续控制仍受未确认记录阻挡；idle 快照、页面刷新和重新连接均不能清除此屏障。

本机 `control.receipt {requestId,deviceId}` 查询通常返回 `{found:false,requestId}`，或包含 sessionId、workspaceId、operation、executionMode、原 runtimeBootId/expectedRevision/turnId、status、ack 的记录。status 为 not-dispatched / accepted / unknown。deviceId 必须与原命令一致，设备权限与 workspace 授权由 Electron 再验证；跨设备同 UUID 不会返回他人回执。旧账本添加 device_id 列，旧记录保留但不自动分配给任何新设备。UUID 保留全局唯一约束，跨设备 UUID 碰撞拒绝。`completionObserved:false` 明确表示 accepted 仅确认请求回执，不表示审批、工具或轮次已经结束，UI 必须继续显示原生 pending 事项。

新命令的认领、device_id 和操作证据在同一 SQLite 事务中提交；`claim_version=1` 标识完整认领，旧记录迁移为 0。任务创建也在产生原生副作用前保存 workspace 与操作信息，重启后可直接查到归属正确的未派发回执。

旧版在认领与补写元数据之间中断的记录，仅当 `claim_version=0`、仍为 prepared 且缺设备归属或操作信息时，回执查询才可在写事务内将其终结为未派发。返回最小证明 `{found:true,requestId,status:"not-dispatched",recovery:"legacy-prepared",completionObserved:false}`，不含 session、workspace、operation 或原始结果；不猜测或补绑设备。仍有设备归属的旧记录只能由原设备查询；无归属的记录仅允许已授权浏览器取得该最小证明，不开放普通回执内容。终结与 dispatch 互斥，保留原 requestId 去重记录。浏览器仅清除同一 requestId 的待确认标识并提示未发送，不自动重试、不按成功处理。已 dispatched、已正常 resolved、完整的旧记录及新版记录不走此恢复路径；无法证明未派发的孤立记录保持阻塞，需在电脑端核查原生状态，不能靠清空账本解锁。

Web 将 Codex 控制和管理操作的 requestId、sessionId/workspaceId、kind 保存到按 host + device 隔离的 sessionStorage，不保存正文、答案、token 或审批详情。刷新/重连只查询回执，不自动重发。found:false 和 unknown 保留屏障；accepted/not-dispatched 才收敛。创建回执可用返回 sessionId 导航找回任务。不同设备授权不加载旧设备 pending。浏览器存储不可写时，Codex 新控制在发送前被拒绝。其他 agent 沿用原行为。同源 HTTP 请求默认 25 秒超时，LAN 默认 15 秒。

`relay.createCsr {privateKeyDer,hosts}` 是仅本机 runtime stdio 的 RPC，不属于 web.request 或 remote.request 操作。privateKeyDer 为 base64 编码的 PKCS#8 P-256 私钥，hosts 为 1–16 个 DNS 主机名；返回 `{csrPem}`。实现复用既有 rcgen/ring，未新增 OpenSSL、外部进程或网络依赖，不落盘私钥。私钥由桌面本地生成保管，给 ACME/broker 的只有签名 CSR。

## 扩展控制与能力查询（2026-09-26）

`GET /api/web/v1/codex/capabilities?sessionId=…` 返回每项原生能力的可用性与禁用原因，桌面服务再次与设备权限、工作区、实验执行开关求交集。app-server 各项能力独立核验，不从保留的 follower 继承未经验证的操作。工作树创建、Git 分支切换继续不可用，不能以自行运行 Git 替代官方语义。

`POST /api/web/v1/codex/<action>` 保留兼容 `inspect`、`resume`、`steer`、原生 `queue-add/update/delete/reorder`、`rename/archive/unarchive/fork/settings`，另有 `compact`（`thread/compact/start`）和 `terminals-clean`（`thread/backgroundTerminals/clean`），两者按发送权限授权；`delete`（`thread/delete`）与重命名、归档一样按整理权限授权。写操作携带唯一 requestId、bootId 和适用的 expectedRevision。inspect 只读核对，不发送模型消息；内部 resume 不要求用户勾选，仍由官方 writer 锁决定是否成功。正常输入区不再提供手动 resume 入口。

原生队列在空闲时添加消息会立即执行，任务完成后自动消费下一条。因此网页只在运行中开放加入队列；CLI 没有原生队列时（0.147.0）队列操作全部关闭；不提供自建离线发送队列，也不自动重放未确认队列操作。`queue-start` 的成功路径尚未验证，能力保持关闭。含附件的原生队列消息暂不支持正文编辑，避免替换输入时静默丢失附件；可删除后重新添加。只读队列投影不返回本机绝对附件路径。

归档使用官方 thread/archive；取消归档恢复历史可见性，下次发送仍须通过自动续接校验。AgentKib 没有自己的归档，归档的会话出现在 Codex Desktop 的归档里。

删除使用官方 thread/delete（0.147.0 起就有），永久删除 rollout 和线程记录，已归档的会话也能删；0.163.0 在隔离 CODEX_HOME 里实测返回 `{}` 并发出 `thread/deleted`。删除前检查 `thread-writer-locks/<id>.lock`，别的进程持有时返回 `codex-owner-busy`；AgentKib 自己的 runner 持有时要求空闲，先关闭 runner（进程退出即释放锁），再由临时 app-server 删除。Codex 回复 `no rollout found` 视为已删除，此前结果未知的删除可以重试；还没有原生 ID 的草稿只删本地记录。删除后从执行账本、会话索引和目录里去掉它，主机移除它的上传文件；用量统计只有 token 数，保留。子代理线程是否随父线程删除尚未验证。fork 创建新的官方 thread ID，只在用户明确分支时执行，不能作为同 ID 续接失败的自动回退。下一轮模型、思考强度和计划/普通模式使用官方 settings 更新；省略字段表示保持当前设置。

扩展审批保留原生提供的完整决定与作用范围。结构化决定必须精确匹配当前请求的候选，包括拟议命令规则、网络规则及权限配置；未知作用域关闭操作。基本浏览器授权不会获得会话级或持久权限决定。秘密问答以密码输入显示，只按请求 ID 和 turn ID 向原生引擎回答；本地命令账本和浏览器回执不保存答案正文。

本地自动化覆盖：

```sh
pnpm --filter @agentkib/desktop exec vitest run electron/main/web/codex-actions.test.ts
```

这些自动化测试不等同于真实 Codex 账户或公网手机验收。功能启用情况以实际频道的能力响应为准。

本轮扩展的操作/权限、原生双版本验证、构建及界面验收记录见 [Codex 远控补全验收](../../qa/codex-completion-2026-09-26.md)。官方 follower 尚未验证的高级操作不会因托管 app-server 测试通过而开启。
