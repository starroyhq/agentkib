# Devin 受控接入：实施与验收记录（2026-11-15）

分支 `devin-phase2`，基于 origin/main `9a0b04965`。设计见 `docs/agents/devin.md`。

## 方案取舍

- **不用 `devin acp`**：在临时会话目录（`DEVIN_SESSIONS_DIR`）里对 `devin acp` 发 `session/new`，Devin 返回 “ACP host has not authenticated … Local CLI credentials are intentionally not used in ACP mode”。ACP 只认宿主提供的 API Key 或每次的浏览器登录。Devin Desktop 用自己保存的 Key 经 `authenticate`（`windsurf-api-key`）交给它的子进程，AgentKib 拿不到也不去取。
- **用 `devin -p`**：CLI 作为自己的宿主，沿用 `devin auth login`。代价：权限按整轮选（`auto`/`accept-edits`/`smart`/`dangerous`），没有中途审批和提问；只收文字；进度从会话库读回。
- 用户决定：CLI 未登录时不主动提示，只在新建或发送时说明；允许使用 Devin Desktop 自带的 CLI；洞察只统计 token。

## 本机事实（Devin Desktop 自带 CLI 3000.12.59）

- `devin auth status` 未登录时输出 `Not logged in.`；`devin models list --format json` 需要登录。
- 会话锁：`~/.local/share/devin/cli/session_locks/<会话 ID>.lock`，内容是持有者 PID，退出后文件保留。
- Homebrew：cask `devin-cli`（Desktop 是 `devin-desktop`）。
- 探测时 `devin acp` 的初始化会启动用户配置的 MCP 服务，进程随探测结束；用户会话库前后都是 7 个会话，临时目录已删除。

## 验证

本机 pnpm 12.10.1 无法切换（ENOEXEC），沿用以往做法：pnpm 10.8.1 加临时 userconfig `manage-package-manager-versions=false`，未改依赖和锁文件。

- `pnpm format:check`、`pnpm typecheck`、`pnpm lint`（退出 0，267 条 warning，新改文件里没有）、`pnpm build` 通过。
- `pnpm --filter @agentkib/desktop test`：569 个文件中 562 个通过、6 个跳过、1 个失败：`claude-bridge-auto-continue.test.ts` 的一个用例在全量并发下超时（15 秒），单独重跑 16 个用例全部通过，与本次改动无关。
- `pnpm test:web`：1842 个用例全部通过。
- 新增 `apps/desktop/test/devin-managed.test.ts`，15 个用例（含去掉 `ACP_BACKEND`）：新建识别会话、继续带 `-r`、未登录不启动、失败原因映射、停止、修订号和忙碌、会话锁、CLI 回退、token 去重。

## 真实验收（登录后，Devin CLI 3000.12.59，模型 `swe-2`）

用临时测试直接驱动 `DevinManagedRunner` 和真实 CLI，会话写在临时的 `DEVIN_SESSIONS_DIR` 里，用户的会话库前后都是 7 个会话；测试和临时目录用完已删除。

- 未信任的临时工作区：`devin -p` 拒绝运行，原因映射为 `devin-workspace-untrusted`。之后的几轮通过只给测试用的包装脚本加 `--respect-workspace-trust false`，产品代码不传这个参数。
- 新建：约 1.5 秒从会话库识别出新会话，第一轮约 3 秒完成，历史里有这条用户消息和回复。
- 继续：`-r` 续上同一个会话（会话数仍为 1），历史里两轮都在。
- 会话锁：运行中 `cli/session_locks/<ID>.lock` 记着运行中的 CLI，判定为占用；停止后不再占用。
- 停止：约 0.25 秒结束。
- `devin models list --format json` 返回 51 个模型家族；新建时按家族列出，用 `--model <slug>` 传给 Devin。

验收中发现并已修正的问题：

- **`ACP_BACKEND`**：Devin 给 ACP 宿主下的进程设置这个变量，继承了它的 CLI 会无视自己的登录，报告未登录。AgentKib 启动 `devin` 时去掉它（`devinChildEnvironment`），否则从 Devin Desktop 的终端启动 AgentKib 时会误报未登录。
- **`DEVIN_SESSIONS_DIR`**：实测会话库在 `<目录>/cli/sessions.db`，锁在 `<目录>/cli/session_locks/`，不是一期按文档理解的 `<目录>/sessions.db`。一期的读取和测试一起改正。
- **停止**：`devin -p` 不因 SIGINT 退出。改为 1.5 秒后 SIGTERM、5 秒后 SIGKILL；之前第一次实测用了 5 秒才停下。

## 界面走查（桌面开发版，computer-use）

开发版用隔离的数据目录启动（`AGENTKIB_BENCHMARK_USER_DATA` / `AGENTKIB_BENCHMARK_DATA_DIR`），Devin 会话写在临时的 `DEVIN_SESSIONS_DIR` 里；工作区用 agentkib 仓库，经只给测试用的 PATH 包装脚本跳过 Devin 的信任检查。用户的 Devin 会话库前后都是 7 个会话，临时数据和截图已删除。

- 首页新建：Agent 列表里有 Devin；四档权限文案正确；模型列表是 Devin 的 51 个模型家族；添加附件按钮不可用；首条消息随新建发出，打开的会话页显示用户消息和 Devin 的回复。
- 继续：第二条消息的回复出现在同一会话里。
- 停止：运行中显示“停止目前轮次”，点击后回到“可传送”，`devin -p` 进程结束。
- 发现并修正：Devin 会话的输入框一直显示“模型待确认”。原因是 `codex-session-controls.tsx`（桌面和 Web）只把 Claude Code 和 DeepSeek Harness 当作受控 Agent，其余都按 Codex 读设置；Devin 会话没有 Codex 的设置记录，模型就成了“待确认”。现在把 Devin 也按受控 Agent 处理，设置是否可读由它的能力决定；Devin 不提供会话设置，所以不再显示 Codex 的模型选择和上下文入口。
- 未走查：Web 端（另一个开发实例占用了开发版端口），以及未登录、未信任时的提示文案在界面上的显示。

## 第 2 步：会话内的模型和权限（同日）

- 默认权限改为 `accept-edits`（用户决定）：新建输入框默认显示并发送它；不是在 AgentKib 里新建的会话也按它运行。
- 会话页：输入框显示这个会话的模型（未选时是 Devin 保存的模型），“会话设置”里有 Devin 的四档权限（文案取自新建会话），“套用至下一轮”。选择存在 `devin-session-settings.json`，重启后仍有效；`smart`、`dangerous` 只接受完全访问的设备。
- 走查中发现并修正：
  - `/managed/capabilities` 不认 `agent=devin`（返回 `invalid_agent`），会话页拿不到能力，设置入口不出现；
  - 设置的投影只放行 Claude 的权限值，Devin 的当前权限显示为“待确认”；
  - 桌面和 Web 的会话控制只给 Claude Code 和 DSH 走 `/managed/action`，Devin 的设置请求走了 Codex 路由，被拒为“本次操作未执行”。
- 界面走查（桌面开发版，隔离数据，swe-2）：新建时默认“自動接受編輯”；会话页显示 SWE-2；设置里把权限改成“唯讀自動”并套用，保存文件和受控命令台账都记下了；下一轮 CLI 收到的参数是 `-r <ID> --model swe-2 --permission-mode auto`。没有验证 `auto` 是否真的拒绝了修改（那需要让 Devin 去改仓库里的文件）。

## 下一轮：未登录、未信任时的说明和一键处理（同日）

- 会话页：发送被拒的原因（未登录、会话被占用、不能带附件等）和这一轮没运行的原因（工作区未信任、运行失败），都在输入框上方用 Devin 自己的说法解释，不再是笼统的“本次操作未执行”。桌面和 Web 都有。
- 桌面端在“未登录”“未信任”旁提供按钮，打开终端运行 `devin auth login`，或在工作区里运行 `devin`；新建会话失败时同样提供。终端启动复用交接所用的启动器（抽成 `openTerminal`），并去掉 `ACP_BACKEND`。
- `/devin/terminal` 只接受桌面端自己的请求（`trustedLocal`），已配对的浏览器和手机请求返回 403；信任只针对已登记的工作区。
- 验证：`devin-terminal-host.test.ts`（桌面可用、远程设备 403、只信任已登记的工作区、拒绝未知动作）、`devin-turn-notice.test.tsx`（说明文案、按钮、请求内容），交接相关 4 个测试文件 82 个用例。没有在界面上实际点过按钮：点了会在本机屏幕上打开终端。

## 留待以后

- “在终端登录”的一键入口没有做，目前提示用户在终端运行 `devin auth login`。PATH 上没有 `devin` 时，用户要用 Desktop 自带 CLI 的完整路径。
- 没有在 AgentKib 界面里走查（桌面、Web、手机）；上面的验收直接驱动后端 runner。
- Windows 和 Linux 未实测；Windows 上停止只结束 CLI 进程本身。
