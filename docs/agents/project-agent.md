# 项目 Agent：Claude Code、Codex 或 DeepSeek Harness 指挥 Codex 和 DeepSeek Harness Worker

项目 Agent 是一个由 AgentKib 运行的 Claude Code 或 Codex 会话，在终端里运行、经 AgentKib 插件（0.5.0 起）连接的 Claude Code 会话，或经 AgentKib 插件（0.8.0 起）连接的 DeepSeek Harness 会话。用户允许后，它可以在指定的工作区里开 Worker（由 AgentKib 运行的 Codex 会话，或经 AgentKib 插件连接的 DeepSeek Harness 会话）、给 Worker 派任务、读取 Worker 的状态和回复、停止 Worker 当前这一轮。Worker 的一轮结束、开始等用户处理或被用户直接操作时，AgentKib 把汇报作为新的一轮送回项目 Agent。

2026-11-15 用真实登录做了端到端验收（Claude Code 2.1.323 的 Haiku 5.5、Codex 0.167.0 的 gpt-6-luna 分别作项目 Agent，Worker 都是 gpt-6-luna），记录见 [`qa/project-agent-acceptance-2026-11-15.md`](../../qa/project-agent-acceptance-2026-11-15.md)。

用户继续在 AgentKib 的桌面、Web 或手机上（终端里的项目 Agent 也可以直接在终端里）和项目 Agent 对话。Worker 的审批和提问照常进入“等待你”，默认由用户处理；用户可以允许项目 Agent 替自己决定其中一部分（见“代批和代答”）。

## 设定

在一个 Claude Code、Codex 或 DeepSeek Harness 会话里打开“更多操作”（DSH 会话在“会话操作”里，DSH 连接设置的下面），选择“设为项目 Agent…”，确定：

- **Worker 可以使用的工作区**：默认只有这个会话所在的工作区。多个工作树放在同一个目录时，可以把那个目录登记为工作区并勾选，Worker 建在它的根目录，任务里写明用哪个工作树。
- **允许 Worker 使用 Codex 自动审核**：默认不允许，Worker 用“工作区可写、需要时询问”。完全访问不开放给项目 Agent，需要时由用户在那个 Worker 自己的设置里改。DeepSeek Harness Worker 不受这一项影响，用 DSH 自己的“工作区可写 · 需要时询问”（见下）。
- **项目 Agent 可以替你决定**：Worker 修改文件的审批、Worker 在沙箱外运行命令的审批、Worker 的提问，默认都不勾。
- **Worker 数量上限**（默认 4，最多 8）和**连续自动轮次上限**（默认 25）。

只有能当项目 Agent 的会话才显示这个入口：由 AgentKib 运行的 Claude Code 或 Codex 会话，已经连接、插件能为它添加工具的终端会话，或所在 DSH 装有 0.8.0 及以上插件的 DSH 会话（没有 DSH 在运行而 AgentKib 能在后台启动时也算，启动的 DSH 用 AgentKib 自带的插件）。

桌面在本机设定。Web 和手机上设定需要完全访问的设备，并有发送、管理会话和高级控制的权限，允许代批时还要有审批权限；Worker 的工作区也必须是这台设备能访问的。修改设定和设定要求相同。暂停、停止某个 Worker 的这一轮需要发送权限，移出 Worker、取消需要管理会话的权限，操作的 Worker 也必须是这台设备能访问的会话；只能读取的设备只看到状态。设定记下是哪台设备做的；这台设备的授权被撤销或变更时，委派暂停，在电脑上改动远程连接的设置（连接服务随之重启）也一样。退出 AgentKib 不算授权变更：下次启动和其他项目 Agent 一样，按重启暂停。经局域网直连时不提供这个面板，电脑上的 AgentKib 较旧时手机提示先更新。

同一个面板列出 Worker（名称、状态、当前任务、最近一次汇报），可以打开 Worker 的会话、暂停和恢复委派、修改设定、取消项目 Agent。取消后 Worker 会话保留为普通会话。

- **每个 Worker**：运行中的 Worker 可以在这里停止这一轮，以做这个操作的设备的名义，委派暂停时也可以；项目 Agent 照常收到“用户直接停止了它”的汇报。“移出”把一个 Worker 从这个项目 Agent 名下拿掉：它的会话保留为普通会话，正在跑的一轮照常跑完，之后不再汇报，也不再占名额。项目 Agent 也可以用 `worker_close` 自己放掉做完的 Worker。在 AgentKib 里删除一个 Worker 的会话，它自动移出；删除项目 Agent 自己的会话，项目 Agent 随之取消。
- **修改设定**：打开和设定时相同的表单，带着现在的设定，保存后替换原来的设定，已有的 Worker 保留。Worker 数量上限调低时已有的 Worker 不受影响，只是名额空出来之前不能再开新的；某个 Worker 所在的工作区不再允许时，项目 Agent 只能列出和移出它。修改设定的设备从此为这个项目 Agent 负责，和恢复委派一样。代批、代答的范围变了时工具随之变化：由 AgentKib 运行的 Claude Code 项目 Agent 在下一次发送、进程空闲时换新进程，Codex 项目 Agent 在线程空闲时重新启动，终端和 DSH 里的项目 Agent 马上换上新工具。

## 项目 Agent 拿到的工具

| 工具 | 作用 |
| --- | --- |
| `worker_list` | 列出 Worker 的 Agent、状态、当前任务和最近汇报，以及新 Worker 可用的工作区、Codex 模型和权限档、能否开 DeepSeek Harness Worker（DSH 在运行时附上它的模型；列出时不启动 DSH）；委派暂停时注明 |
| `worker_open` | 在允许的工作区新建一个 Codex 会话（默认）或 DeepSeek Harness 会话（`agent: "deepseek-harness"`）作为 Worker，或接管一个已有的 Codex 或 DeepSeek Harness 会话（Codex 沿用接管的现有检查）。已经由 AgentKib 运行的 Codex 会话、AgentKib 连得上的 DSH 会话直接登记 |
| `worker_send` | 给 Worker 派任务或跟进，立即返回回执；Worker 运行中时默认排到这一轮之后，也可以加入这一轮。结果未知时不自动重发 |
| `worker_read` | 读取 Worker 的状态、最近几条回复（每条最多 4,000 字符）和在等用户处理的事，并标出项目 Agent 能否替用户决定 |
| `worker_stop` | 停止 Worker 当前这一轮 |
| `worker_close` | 放掉一个做完或不再需要的 Worker：会话保留为普通会话，不再汇报，也不再占名额 |
| `worker_approve` | 只在允许代批时提供：对允许的审批“接受一次”或“拒绝” |
| `worker_answer` | 只在允许代答时提供：回答 Worker 的提问卡片 |

工具的回执和拒绝原因都是固定的代码，例如 `worker-limit-reached`、`workspace-not-allowed`、`policy-not-allowed`、`policy-is-codex-only`、`delegation-paused`、`approval-not-delegated`、`codex-owner-busy`（Worker 正被 Codex 应用占用）、`dsh-worker-preset-unavailable`。项目 Agent 只能操作自己名下的 Worker，不能选择授权范围以外的工作区和权限档；用户把某个工作区移出设定后，那里的 Worker 只能列出和放掉（`workspace-not-allowed`）。

**由 AgentKib 运行的项目 Agent**：AgentKib 为每个项目 Agent 开一个只在本机回环地址上的 MCP 端点，路径是随机生成的能力 URL，只存在于 AgentKib 进程和这个会话的启动参数里，不写入用户的 Claude Code 配置。会话每次启动时带上它（`--mcp-config`，服务名 `agentkib_workers`），与持续目标的汇报端点合并；同时用 `--allowedTools mcp__agentkib_workers` 让这些工具不必逐次审批：设为项目 Agent 本身就是授权，主机在每次调用时按授权范围检查（2.1.263、2.1.299、2.1.323 实测不再发出 `can_use_tool`）。设为项目 Agent 或取消后，下一次发送时如果进程空闲，会换一个带或不带这些工具的新进程。托管的 CLI 进程被结束时不会注销自己的 MCP 会话，端点满 4 个连接时让最久没用的连接让位，所以进程重启多少次都能连上（三个版本各重启 6 次实测）。

端点的说明（MCP `instructions`）控制在 2,000 字符以内：Claude Code 把它放进第一条用户消息，2.1.263 超过约 2,000 字符、2.1.299 和 2.1.323 超过约 4,000 字符时截断；`/compact` 之后会重新放入（三个版本实测）。具体用法写在各工具的描述里。

**由 AgentKib 运行的 Codex 项目 Agent**：AgentKib 启动这个会话的 Codex 线程时，把同一个回环端点作为这个线程的 `mcp_servers.agentkib_workers` 传给 Codex（`thread/start`、`thread/resume` 的 `config`），不写入用户的 Codex 配置。Codex 0.167.0 把它作为“延迟加载的工具命名空间”交给模型，说明就是端点的 MCP 说明；模型在 `exec` 代码里调用 `tools.mcp__agentkib_workers__worker_*`。在 AgentKib 设定的权限档下调用这些工具不弹审批（实测）。设为项目 Agent 或取消后，Codex 线程空闲时重新启动，带上或去掉这些工具；Codex 还没写入的新会话（一轮都没有）不能重新启动，所以它的第一轮还没有这些工具，这一轮结束后才有。会话在 Codex 应用里打开时用的是 Codex 应用的线程，没有这些工具。

**DeepSeek Harness 项目 Agent**：AgentKib 在 DSH 插件的轮询回复里列出全部 DSH 项目 Agent 和各自的工具，插件把工具注册在那个会话自己的 Agent 上（`agent.ctx.tools`），同一个 DSH 里的其他会话看不到；DSH 再次加载这个会话、换了 Agent 时重新注册。调用经插件的本地连接（`/v1/lead-call`）交给 AgentKib 执行，AgentKib 每次核对这个会话仍是项目 Agent、而且在这个 DSH 里。工具名就是 `worker_list` 等，守则放在 `worker_list` 的描述开头（DSH 没有 MCP 说明可用）。DSH 对插件注册的工具默认放行，不弹审批；用户在 DSH 里设的规则照常生效。设为项目 Agent、取消、暂停或恢复时，正在运行的 DSH 立即收到；AgentKib 刚启动的 DSH 第一次轮询就拿到，所以由汇报唤起的那一轮也带着工具。DSH 0.2.2-rc.2 在沙箱里实测：项目 Agent 用自己的工具开 DSH Worker、派任务，收到汇报后作答；Worker 的模型请求里没有这些工具。

**终端里的项目 Agent**：AgentKib 的连接插件用 Claude Code 的 `$.tool.register` 注册这些工具，名称是 `mcp__agentkib-bridge__worker_*`，调用经插件的本地连接交给 AgentKib 执行（2.1.301、2.1.323 实测）。插件没有 MCP 说明可用，守则放在 `worker_list` 的描述开头。设为项目 Agent 本身就是授权：会话当项目 Agent 期间，插件把这些工具默认的“询问”改为允许，和由 AgentKib 运行时一样不逐次审批；用户自己的规则、钩子、设置或组织策略要求询问或拒绝的，照它们办，插件不改这些规则。委派暂停或恢复时，终端里显示一行说明。连接协议见[终端连接](claude-code-terminal.md)。

**DeepSeek Harness Worker**：AgentKib 经 DSH 插件在用户正在运行的 DSH 里新建会话，没有可用的 DSH 时在后台启动一个，与新建 DSH 会话相同（见 [DeepSeek Harness](deepseek-harness.md)）。新会话先用用户给 DSH 设的默认权限预设，可能是完全访问；AgentKib 在发任何消息之前读它，不是“只读”或“工作区可写”时用 DSH 自己的 `/permission workspace-write` 换成“工作区可写 · 需要时询问”，再读一次确认。确认不了时这个会话不当 Worker，保留为普通会话，拒绝回执写明它（`dsh-worker-preset-unavailable`）。接管的已有 DSH 会话保留它自己的预设，和接管 Codex 会话一样。`model` 用 `worker_list` 列出的 DSH 模型 ID，`policy` 只用于 Codex。发送、排队、加入这一轮、停止和回答提问都走 DSH 插件的会话控制，与用户在 AgentKib 里操作 DSH 会话相同；用户直接操作这个 Worker 时同样汇报给项目 Agent。DSH 0.2.2-rc.2 在沙箱里实测（模拟模型，DSH 默认预设设为完全访问）。

## 代批和代答

- **代批**：只限普通审批，即只有“接受”“拒绝”的那种。要联网、要更多权限、要授权目录或要改执行规则的审批，以及 MCP 和权限请求，一律留给用户。项目 Agent 只能“接受一次”或“拒绝”，不能“本会话都接受”。
- **代答**：Worker 用提问卡片提的问题，按问题给出一个答案；不允许自填时只能选给出的选项。Worker 在 Codex 应用里跟随时，AgentKib 回答不了提问，仍由用户处理。
- **DeepSeek Harness Worker**：它的审批一律由用户处理。只有固定选项、不能自填的提问卡片在 DSH 里是工具审批（选项里可能有“以后都允许”），也留给用户；可以自填的提问才能代答。
- 允许的事项，汇报会附上审批或提问的内容（命令和目录，或改动的文件和差异；问题和选项，经过与汇报相同的脱敏），并告诉项目 Agent 可以自己决定。用户在 AgentKib 里也能同时处理，以先到的为准。每次代批、代答都记录在项目 Agent 的记录里。

## 汇报

- **什么时候**：Worker 的一轮结束（完成、失败或被停止）；Worker 开始等用户审批或回答；用户直接给 Worker 发消息或停止它（同一个 Worker 一分钟内只报一次）。Worker 在 Codex 应用里跟随时，AgentKib 连着它就照常汇报一轮结束和等待；没连着它时（包括 AgentKib 没在运行），一轮结束按 Codex 的会话记录补报，晚 20 秒左右，用时按记录里的开始和结束时间算。只补报成为 Worker 之后开始的轮次；等待只在连着时汇报。DeepSeek Harness Worker：AgentKib 从 DSH 插件报来的会话状态看到一轮结束，再从 DSH 的会话记录读出这一轮怎样结束（完成、被停止、失败等）和用时；DSH 没在运行时结束的轮次，DSH 再次连上后按记录补报，规则同上。
- **内容**：以 `[AgentKib report] Worker "<名称>" (Codex) · <发生了什么>` 开头，DeepSeek Harness Worker 写 `(DeepSeek Harness)`；一轮结束时写明用时（Codex 自己的计时，例如 `turn ended: completed after 3m 12s`；DSH 按会话记录里这一轮的开始和结束时间，记录里找不到开始时不写用时），带上这一轮最后一条回复，经过与交接、正文搜索相同的脱敏，最多 4,000 字符，并注明它是 Worker 的工作结果，不是用户的指令。每一轮只报一次。
- **怎么送达**：由 AgentKib 运行的项目 Agent，汇报作为会话的自动待办，与排队消息、持续目标走同一套派发：空闲时才送，用户自己排的消息先送；还没送出的汇报合并成一条；派发前按设定项目 Agent 的设备重新授权。有后台任务在跑但不在一轮当中时照常送达。终端里的项目 Agent，汇报进入插件的发件箱，终端空闲时作为一轮提交；插件取走之前到的汇报合并成一条。由 AgentKib 运行的 Codex 项目 Agent，汇报是 AgentKib 以设定它的设备的名义发给它的消息：空闲时直接发送，正在运行时排进 Codex 的队列；还在队列里没开始的汇报合并成一条（改写队列里那条）。它在 Codex 应用里运行时排不进去，委派因“汇报送达不明”暂停。DeepSeek Harness 项目 Agent 一样，消息经 DSH 插件发送或排进 DSH 的队列，排队的汇报按发送它的请求认出并合并；没有 DSH 在运行时，发送会在后台启动一个（同新建 DSH 会话），启动不了时委派因“汇报送达不明”暂停。
- **暂停**：委派暂停时汇报先存着，恢复时合并送出。主机或后端重启后，委派处于暂停，用户在面板里恢复，或在项目 Agent 会话里发一条消息后继续。汇报送不出去时委派暂停。
- **自动轮次上限**：每送出一条需要新一轮的汇报计一次，合并进已有汇报不计；项目 Agent 自己开始的一轮也计一次：Claude Code 后台任务完成的通知、定时任务，Codex 自动继续进行中的目标，DSH 继续目标的下一轮或在子代理结束后开始一轮。
  - **怎么认出**：终端里的 Claude Code 由插件按 Claude Code 标注的来源区分，不是人输入的都算。AgentKib 发给 Codex 的每条消息都带着请求号，Codex 记在这一轮开头的用户消息上；一轮不是由这样的消息开头（目标自动继续的一轮直接是 Agent 的回复），就是 Codex 自己开始的。DSH 的会话记录写明一轮由什么开头：AgentKib 发的消息带请求号，人在 DSH 窗口里输入的不带，目标的下一轮和子代理结束后的一轮没有人写的消息。
  - **达到上限时**：委派暂停，以设定项目 Agent 的设备的名义停下自己开始的轮次。Claude Code 自己开始的这一轮被停止（进程和后台任务保留）。Codex 的目标暂停，正在跑的这一轮照常结束：中途停止可能正好碰上这一轮结束，会话就落入“结果待核对”（Codex 0.167.0 实测）。DSH 的这一轮被停止，DSH 随之暂停目标（DSH 0.2.2-rc.2 实测）。说明原因的地方：由 AgentKib 运行的 Claude Code 在输入框上方，终端里的在终端里，其余在面板和“需要你处理”里。
  - **清零**：用户在项目 Agent 会话里发一条消息即清零并继续，在 AgentKib 里发送、在终端里输入或在 DSH 自己的窗口里输入都算。

## 列表、会话页和通知

- 会话列表里，项目 Agent 和它的 Worker 各有一个小标识，在标题旁边，和行尾的状态（未读、运行中、等待你）分开显示；悬停标识、打开这一行的详情卡片或读屏时，Worker 的标识写明“Worker api · 委派自 〈项目 Agent〉”。会话页顶部有同样的一行说明。其他电脑的会话列表和手机 App 也一样。
- **达到使用上限**：Claude Code 项目 Agent 的汇报在它的队列里等，重置后先送汇报；Codex 项目 Agent 等待重置期间委派暂停（`usage-limit`），AgentKib 自动继续成功或用户发消息后委派继续、送出汇报。见[达到使用上限](usage-limits.md)。
- 委派因自动轮次上限、汇报送达不明或重启而暂停时，项目 Agent 出现在“需要你处理”里（“委派已暂停”，手机在收件箱里单列一组），手机照常收到通知；用户自己暂停或设备授权变更引起的暂停不算。较早版本的手机 App 不认识这种通知，显示通用的“需要你处理”。
- 手机 App 在会话的“更多”菜单里提供“项目 Agent…”页面：查看 Worker、暂停和恢复、取消，或按设备权限设定。
- 手机通知：Worker 一轮结束不单独通知，由项目 Agent 汇总；项目 Agent 一轮结束时，名下还有 Worker 在运行或等你处理、有汇报正在送去、或它自己有后台任务在跑，就先不通知，全部停下来时通知一次。Worker 和项目 Agent 的“等待你”照常通知。

## 没有做的

- 由 AgentKib 运行的 Claude Code 项目 Agent，一轮以错误结束时（例如账号额度用尽，CLI 以“You've hit your 5-hour limit”结束这一轮），和其他托管会话一样进入“结果待核对”，在 AgentKib 里只读，没有应用内恢复入口（见 [Claude Code 托管执行](claude-code-managed.md)）。它出现在“需要你处理”里；此后到的汇报留着不送，不会开始新的一轮，Worker 不受影响。要继续委派，取消这个项目 Agent（只读时也可以取消），再把另一个会话设为项目 Agent；这个会话本身照托管会话的规则，可以在 Claude Code 终端里继续。认证失败不在此列，会话保持可用。
