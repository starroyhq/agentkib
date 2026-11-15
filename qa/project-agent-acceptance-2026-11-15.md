# 项目 Agent 与 Worker：验收记录（2026-11-14 至 11-15）

功能说明见 [项目 Agent](../docs/agents/project-agent.md)。这里记两轮验收：先用模拟模型把桌面、Web 和手机的界面走一遍，再用真实登录跑真实模型。

## 怎么做的

- 都在沙箱里运行这条分支构建出的 AgentKib：自己的 HOME、数据目录和调试端口，测试会话只放在临时项目目录里。
- 界面验收（11-14）用回环地址上的模拟模型，应用在只放行回环地址的 Seatbelt 配置里运行，读不到用户自己的 Agent 数据。DeepSeek Harness 0.2.2-rc.2 作项目 Agent 和 Worker。
- 真实模型（11-15）沿用本机 `claude` 和 `codex` 自己的登录：应用用沙箱 HOME，启动 CLI 时换回真实 HOME，凭据不复制、不读取。Claude Code 2.1.323、Codex CLI 0.167.0、macOS 27.0.1。项目 Agent 用 Haiku 5.5 或 gpt-6-luna（推理强度 low），Worker 都用 gpt-6-luna（low）。
- 手机用 iOS 18.6 模拟器里的开发版 App，经回环地址的 HTTPS（一次性测试 CA）与沙箱里的 AgentKib 配对。

## 界面验收（模拟模型）

| 位置 | 核对的内容 | 结果 |
| --- | --- | --- |
| 桌面 · 会话操作 | “设为项目 Agent…”的表单：默认只勾会话所在的工作区，自动审核和三项代批都不勾，Worker 上限 4、自动轮次上限 25；确定后显示“0 个 Worker”、暂停委派和取消 | 通过 |
| 桌面 · 项目 Agent 会话 | 项目 Agent 依次调用 `worker_list`、`worker_open`、`worker_send`；Worker 的一轮结束后汇报送回，项目 Agent 自动作答 | 通过 |
| 桌面 · 汇报 | 汇报按段落和分隔线显示，时间与“汇报”之间有空格 | 修正后通过（见下） |
| 桌面 · Worker 会话 | 顶部一行“Worker ds · 委派自 〈项目 Agent〉”；面板列出 Worker 的名称、状态、当前任务、最近一次汇报，可以打开 | 通过 |
| 桌面 · 退出再启动 | 委派按重启暂停，出现在“需要你处理”；发一条消息或在面板里恢复后继续 | 修正后通过（见下） |
| Web | 配对的浏览器看到同一个面板，可以暂停和恢复；恢复后设定设备记为这台浏览器 | 通过 |
| 手机 | 会话的“更多”里进入“项目 Agent…”页：Worker 数量、暂停原因、恢复和暂停；从这页打开 Worker，返回后回到会话列表；会话页顶部显示委派标识 | 修正后通过（见下） |
| 桌面与 Web · 会话操作对话框 | 改用设置页的分组卡片版式，三种 Agent 的会话都核对过 | 通过 |

## 真实模型端到端

| 场景 | 过程 | 结果 |
| --- | --- | --- |
| Claude Code（Haiku 5.5）作项目 Agent | 新建会话时在模型选择里选 Haiku；设为项目 Agent（Worker 上限 2、自动轮次上限 6）后，CLI 带着 `--mcp-config` 和 `--allowedTools mcp__agentkib_workers` 重新启动。让它开一个 Codex Worker（gpt-6-luna、low）新建 `hello.txt` | 一轮内开好 Worker 并派出任务，Worker 工具没有弹审批；Worker 8 秒后结束，汇报送回，项目 Agent 自动开始一轮并作答。文件内容正确 |
| Codex（gpt-6-luna）作项目 Agent | 新建会话并发一条消息后设为项目 Agent；让它开一个 Codex Worker 读 `hello.txt` | 13 秒派出，Worker 5 秒后结束，汇报送回，项目 Agent 答出文件内容 |
| Worker 等待审批 | 让 Worker 在工作区之外新建一个文件 | Worker 申请在沙箱外运行命令，会话列表的状态点变成“等待你”，汇报“waiting for the user's approval”送回，项目 Agent 转告用户；在 Worker 会话里点“允许一次”后文件写出，结束的汇报送回 |
| 项目 Agent 自己的审批 | 收到上一条汇报后，Haiku 想读工作区之外的那个文件 | 项目 Agent 的会话里出现“是否允许 Claude Code 使用 Read？”，由用户决定 |
| Worker 的设置 | 读 Codex 自己的线程记录 | 三条线程都是 gpt-6-luna、low、需要时询问；沙箱只允许写项目目录，网络受限 |

验收后按名称核对，用户的 Claude Code 设置和 Codex 配置里都没有 Worker 工具的端点。Codex 自己会在配置里给新项目目录记一条信任记录，与 AgentKib 无关。

## 发现并已修正的问题

| 问题 | 原因 | 修正 |
| --- | --- | --- |
| 汇报在会话里被渲染成标题，时间和“汇报”连在一起 | 汇报正文按 Markdown 显示，`---` 紧跟在一行文字后面被当成标题 | 各部分之间加空行；时间后加空格 |
| 退出 AgentKib 后，从 Web 或手机设定的项目 Agent 被记成“设备授权已变更” | 退出时关闭远程服务，走了与改动远程设置相同的失效路径 | 随退出关闭时不作失效处理，下次启动按重启暂停 |
| 手机上从项目 Agent 页打开 Worker 后，返回时原会话不再更新，还报一次绘制期间的状态修改 | 两个会话页叠在一起，新页在构建期间关掉了旧页的事件流 | 手机 App：打开 Worker 时替换当前会话页，事件流在一帧之后交接 |
| 新建 Claude Code 会话时没有模型可选（工作区是 Git 仓库时必现） | macOS 对已退出、尚未回收的子进程返回 ESRCH，结束 CLI 时把它当成中途消失，清理记为未确认；CLI 启动时运行的 `git` 正好落在这个时刻。实测 6 次全部失败，修正后 6 次全部正常 | 冻结进程树时跳过已经退出的子进程 |
| 桌面的会话目录里看不到项目 Agent 和 Worker 的标识 | 目录把行内标识放在只给读屏用的容器里，行尾的状态图标不包含委派标识 | 标识固定显示在标题旁边，详情卡片也写明 |
| “等待审批”的汇报两句话连成一段 | 说明与正文之间只隔一个换行 | 各占一段，代批内容放进代码块 |

## 看到但没有改的

这些不属于项目 Agent 本身，或者是既有的设计，留给以后决定。

- **额度用尽后项目 Agent 只读。** Haiku 的一轮遇到账号的 5 小时额度上限，CLI 以“You've hit your 5-hour limit”结束这一轮（`assistant` 帧 `error: "rate_limit"`）。按托管会话现在的规则，带错误的 `result` 都进入“结果待核对”，会话只读，“核对执行结果”也恢复不了；认证失败是唯一的例外。项目 Agent 往往长时间运行，遇到这种情况就不能再接收汇报。把额度用尽也当作已知失败、保持会话可用，是值得单独做的一项。
- **AgentKib 新建的 Codex 会话在列表里叫“Codex”。** 由 AgentKib 运行期间，列表用的是 AgentKib 自己记录里的标题，默认就是“Codex”，改名才会变；Codex 自己记的标题是第一条消息。几个 Worker 排在一起时分不出来，只能靠悬停。
- **Codex 会话的“待发队列”读不出来。** 会话操作里一直显示“无法读取队列”：宿主读队列时带了一个 `experimentalEnabled` 字段，后端这一项的参数不接受多余字段，返回 500。
- **Codex 应用接管线程。** 用户在 Codex 应用里点开这些线程后，写锁归 Codex 应用，AgentKib 显示“这条会话正在 Codex 中使用”，Worker 此时回执 `codex-owner-busy`。这是既有的交接规则。
- Codex 的权限档名称（“Workspace write · ask when needed”）在中文界面里是英文；额度用尽的那句话在会话里出现两次（一次是 Agent 消息，一次是这一轮的结果）。

## 自动测试

- `apps/desktop/test/mac-owned-process-tree.test.ts`：根进程有一个已退出、没被回收的子进程时照常结束；同时还有在运行的子进程时，一并结束。
- `apps/desktop/src/features/sessions/SessionDirectory.test.tsx`、`SessionDirectoryTrailing.test.tsx`：目录里的委派标识不在只给读屏用的容器里，行尾仍显示未读；Worker 的详情卡片写明它属于哪个项目 Agent。
- `apps/desktop/test/orchestration.test.ts`：等待审批的汇报各部分分段，代批的内容放在代码块里；汇报正文的分隔线前后有空行。
- `apps/desktop/test/claude-web-backend-integration.test.ts`、`apps/desktop/electron/main/web/project-agent-route.test.ts`：设备授权变更时暂停，随应用退出关闭远程服务时不暂停。
