# Claude 接入真机验收 QA — 2026-10-14

## 范围与环境
- 分支 `fix/claude-integration-gaps-20261013`，起点 `6496fb46a`。
- Claude Code `2.1.299`（任务书写的是 2.1.296，本机装的是 2.1.299，以实际版本为准）；macOS，Node `26.9.0`。
- 模型只用 Haiku 5.5，每次调用都显式传 `--model claude-haiku-5-5`，并设 `CLAUDE_CODE_SUBAGENT_MODEL=claude-haiku-5-5`。模型名依据官方 model-config 文档：Anthropic API 上 `haiku` 别名指 Haiku 5.5，完整名为 `claude-haiku-5-5`。
- 所有测试项目都在临时目录 `<sbx>`（`/private/tmp` 下的随机目录）里，不在仓库内；`<sbx>` 的上级目录没有 `CLAUDE.md`、`AGENTS.md`。用户自己的 `~/.claude/CLAUDE.md`、rules 和 hooks 照常加载，对照预览时两边都有。
- 没有读 `~/.claude/.credentials.json`、Keychain、`~/.claude.json`；`~/.claude/settings.json` 只看过键名。没有运行 AgentKib 桌面应用，后端模块在 Node 里直接驱动。

## 模型核对与费用
- 第一个会话（A 冒烟）的 `modelUsage` 只有 `claude-haiku-5-5`。之后每个会话的 `modelUsage` 都只出现这一个模型，包括子代理（`CLAUDE_CODE_SUBAGENT_MODEL` 生效）。
- 会调用模型的 `claude` 进程：启动 21 次，上限 30 次。其中 1 次因参数解析失败（`--tools ""` 吞掉了位置参数里的提示词）没有产生 API 请求，1 次（E，换了配置目录后认证失败）没有产生用量；实际产生用量的 19 次。
- 合计 `total_cost_usd` 约 0.043 美元；输入 58 个 token，输出 4486，缓存读取 414212，缓存写入 191101。
- 每个进程都带 `--max-budget-usd 0.5`；`--max-turns`：子代理用例 8，其余 3。

## 做法
- A、C、D、E 用 `claude -p`，`--permission-mode dontAsk --tools ""`，不给任何工具。
- B 用 AgentKib 自己的 `ClaudeManagedRunnerProcess`（`packages/backend/src/claude-managed-runner.ts`）在 Node 里驱动真实 `claude`。可执行文件是一个转发脚本：用 runner 传来的同一组参数启动真实 CLI，另外追加 `--max-turns`、`--max-budget-usd`、`--strict-mcp-config`（不启动用户自己的 MCP 服务器），并把每一行 stdin/stdout 带时间戳记录下来。runner 的租约目录指向临时 HOME，转发脚本在启动 CLI 前还原真实 HOME。
- 审批逻辑在 harness 里：只批准预先写好的命令（`echo agentkib-live-ok > agentkib-out.txt`、`echo agentkib-sub-ok > agentkib-sub.txt`）、测试用 MCP 服务器的 `ping` 工具，以及对 `<sbx>` 内文件的读取，其余一律拒绝。
  - 偏差：任务书写的是批准 `echo …` 命令。纯 `echo agentkib-live-ok` 被 CLI 自己判为只读而放行，不会发出 `can_use_tool`，所以改用带重定向的 `echo`（写 `<sbx>` 内的文件）来触发审批。
- D 在每个目录的 `.claude/settings.json` 里配 `InstructionsLoaded` hook 记录加载的文件；AGENTS.md 不触发该 hook，所以每个场景都另外用暗号问答。AgentKib 一侧用后端 `Context.resolve` 对同一目录出预览。
- C 用现有的预览、规划与应用流程（`prepareSessionHandoff`、`planSessionHandoff`、`applySessionHandoff`，`approveHome: true`）写入真实的 `~/.claude/projects/`。

## 结果

| 编号 | 项目 | 结论 | 观察（只写帧类型、字段名和受控值） |
| --- | --- | --- | --- |
| A | 冒烟 | 通过 | `modelUsage` 只有 `claude-haiku-5-5`，回答 `OK`。 |
| B1 | 启动（P1-7、P1-6） | 通过 | `system/init` 带 `permissionMode: "default"`，出现在对 `initialize` 的控制响应之后，也晚于首条用户帧的写入；`claude_code_version` 为 `2.1.299`。`init` 里没有每个工具的参数表，无法直接看 `run_in_background`；让模型自查 Bash 工具定义，它回答没有（间接证据，一次）。runner 取到了 `default`。 |
| B2 | 一轮后空闲 20 秒（P17、P8） | 通过 | `result` 之后只有一个 `command_lifecycle`，空闲 20 秒内没有任何帧；runner 保持 `idle`，没有终止。所有会话里都没有出现 `background_tasks_changed`，`ambient` 任务没有观察到（只跑了短会话）。 |
| B3 | Bash 审批 | 通过 | 真实 `can_use_tool` 字段：`tool_name`、`display_name`、`input`、`description`、`permission_suggestions`、`blocked_path`、`tool_use_id`；没有 `decision_reason`。harness 批准后文件写入成功，模型回答 `done`。只读的 `echo` 不发请求。 |
| B4 | 前台子代理（P0-3、P1-6） | 通过 | 子代理工具名是 `Agent`；`task_started` 的 `task_type` 为 `local_agent`，`is_backgrounded` 为 `false`；会话没有被终止，状态回到 `idle`，`modelUsage` 只有 Haiku 5.5。带 `parent_tool_use_id` 的是子代理的 `assistant`、`user` 帧；`system` 任务帧和 `control_request` 不带。子代理的 `can_use_tool` 多一个 `agent_id`。之后是 `task_updated`、`task_notification`（runner 按“未跟踪”计数）。没有 `background_tasks_changed`。 |
| B5 | 释放与同 UUID 续接 | 通过 | `retireIfInactive` 后进程退出；同一 runner 再发一轮，以 `--resume=<同一 UUID>` 启动，模型答出前一个进程里记下的暗号。 |
| B6 | MCP 工具审批带 `mcp_server` | 通过 | 用 `--mcp-config` 指向测试目录里的一个无依赖 stdio 服务器（只返回固定字符串）。`can_use_tool` 带 `mcp_server: {name, source}` 与 `server_policy_ask_only`；runner 作为未知字段有界展示，批准后工具调用成功。 |
| C | 原生导入后 `--resume`（P0-1、P1-8、P1-9） | 通过 | 目标工作区目录名含 `.`、`_` 和空格；会话写入 `projects/` 下按“非字母数字全替换成 `-`”算出的目录；`claude -p --resume <UUID>` 找到会话并答出暗号，`version: 2.1.233` 没有报错，会话 ID 不变。 |
| D1 | 只有 AGENTS.md（P0-4） | 通过 | Claude 读到暗号；AgentKib 预览列出该文件。 |
| D2 | AGENTS.md 加 CLAUDE.md | 通过 | 只读 CLAUDE.md；预览一致。 |
| D3 | `.claude/rules`：嵌套与 `paths` | 通过（有 P2） | 启动时加载无 `paths` 的两个规则（含子目录），带 `paths` 的不加载；预览一致。规则的先后顺序真机里和预览（按名字顺序）不同，且另做的一次对照里也不是字母序，见下文 P2。 |
| D4 | 上级目录的 CLAUDE.md 与 rules | 失败，已修复 | CLAUDE.md 一致；Claude 启动时还加载了上级目录的 `.claude/rules`，顺序在该目录的 CLAUDE.md 之后、下一级目录之前，AgentKib 预览此前不读。 |
| D5 | `claudeMdExcludes`（P2-1） | 失败，已修复 | 写在 `settings.local.json` 的绝对路径同时排除了上级目录的 CLAUDE.md 和一个规则文件；预览此前只排除 CLAUDE.md，仍把规则列为已加载。 |
| D6 | Project instructions 经 `--settings` | 通过 | `claude-md-and-agents-md` 下 CLAUDE.md 在前、AGENTS.md 在后，两者都读；AgentKib 对同样设置（放在隔离的 HOME 里，因为命令行设置不可见）给出同样顺序。 |
| D7 | 块级 HTML 注释 | 通过 | 单行与多行块级注释里的暗号没被读到；行内注释和代码块里的注释保留；预览完全一致。 |
| D8 | 自动记忆 | 通过 | `MEMORY.md` 里的暗号被读到（本机自动记忆开启）；预览列出该文件。 |
| E | `CLAUDE_CONFIG_DIR`（P1-4） | 未做 | 换成空的配置目录后认证失败（`terminal_reason: api_error`，无用量），按任务书整项跳过。顺带观察到：即使认证失败，会话文件仍落在 `<配置目录>/projects/<目录键>/<UUID>.jsonl`。 |

范围外、未做：P1-5（运行中的 Claude 写回 `~/.claude.json`，需要写用户真实全局配置）、P1-3（local 作用域 MCP，需要改全局配置并启动用户的 MCP 服务器）、Windows、Linux、Node 22。

计数（范围内 17 项）：通过 14，失败 2（均已修复并复验），未做 1。

## 发现与修复
| 级别 | 问题 | 处理 |
| --- | --- | --- |
| P1 | D5：`claudeMdExcludes` 不作用于规则文件，预览把被排除的规则列为已加载 | `ddc9c18df`：项目与上级目录的规则文件按书写路径或链接真实路径命中即排除（官方文档对链接的说法；书写路径命中已真机确认），用户级规则保持列出（未核对）。先确认测试在修复前失败，再做 3 处变异检查（改成对用户规则也排除、只比较书写路径、把 MCP 模式的隐藏计数记成列出），都被测试抓到。 |
| P1 | D4：预览不读上级目录的 `.claude/rules`，并在固定提示里写明“没有读取” | `b691a5714`：默认读取（顺序同真机：该目录的 CLAUDE.md、其 rules、下一级目录），删去提示里那句话（四种语言、界面和 5 个测试同步）。先确认测试在修复前失败，再做 2 处变异检查（忽略开关、开关取反）。 |
| P2 | D3：规则文件夹内的加载顺序 | 不改代码。第一次（`a.md`、`sub/b.md`）里 Claude 先载子目录文件；另做一次对照（`m.md`、`a.md`、`sub/q.md`、`0sub/r.md`）模型报告的顺序是 m、r、q、a，hook 记录顺序（异步，不可靠）又是 m、a、r、q，既不是字母序也不是“目录优先”。无法归纳出规则，预览维持名字顺序。 |
| P2 | 版本常量 | `CLAUDE_MANAGED_VERIFIED_THROUGH` 由 `2.1.285` 改为 `2.1.299`（`831387b33`），只用于解释失败原因，不影响任何门槛。 |
| 说明 | 只读命令（如 `echo`）由 CLI 自己放行，不会出现在 AgentKib 的审批里 | 与文档“CLI 自动允许的操作可能不会弹出审批”一致，不改。 |

修复后的复验：对同一批目录重新运行 AgentKib 预览（不再调用模型），D4、D5 与真机观察到的加载结果一致；Claude 一侧没有变化，所以没有重跑模型。

## 文档改动
`docs/agents/claude-code-managed.md`（版本记录、`permissionMode` 时机、子代理行为、`can_use_tool` 字段、仍待确认的清单）、`docs/sessions/conversations.md`、`docs/FEATURES.md`（验证版本、上级目录规则、`claudeMdExcludes` 对规则的作用）、`docs/sessions/interoperability.md`（导入后 `--resume` 的真机结果，限定为 2.1.299 与这一种目录名组合）。

## 副作用与清理
1. `~/.claude/projects/<测试目录键>/`：12 个目录（B、C、D 各场景、ORD、冒烟）。删除前逐个核对了其中每个会话文件的 `cwd` 字段都在 `<sbx>` 之下，然后整目录删除；`projects/` 的目录数回到测试前的 24。
2. 以测试会话 UUID 命名的条目：`~/.claude/session-env/` 下 18 个，已删除；`todos/`、`file-history/`、`shell-snapshots/`、`tasks/`、`sessions/` 等下没有以本次会话 UUID 命名的条目。另外 CLI 在 `/private/tmp/claude-<uid>/` 下为子代理输出建了一个以测试目录键命名的目录，已删除。`/tmp/cc-socks/` 里留有按进程号命名的失效套接字（本次进程的），名字不含会话 UUID，按规则没有删。
3. `~/.claude/history.jsonl`：测试前后都是 13751 行，没有变化，未读取内容。
4. `~/.claude.json`：没有读，没有改。Claude 可能为测试目录添加了项目条目，保留原样。
5. 进程：harness 启动的 `claude` 进程按记录的进程号核对，全部已退出；没有动用户自己的 Claude 进程。
6. AgentKib 没有写 `~/.claude.json`；唯一的 Agent Home 写入是 C 项的原生导入，在上面第 1 条的目录里，已随之删除。runner 的租约文件写在临时 HOME 里，随 `<sbx>` 一起处理。

## 仍未验证
- `ambient` 类后台任务是否会出现在更长的会话里（本次只跑了短会话）。
- CLI 对 `error` 类型控制响应的反应；`requires_user_interaction` 的工具被拒绝之后的表现；后台任务完成后的自发轮次。
- `run_in_background` 是否真的不在 Bash 工具参数里（只有模型自述）。
- `CLAUDE_CONFIG_DIR`（P1-4）、运行中的 Claude 写回 `~/.claude.json`（P1-5）、local 作用域 MCP（P1-3）。
- 其他 Claude Code 版本、provider、Windows、Linux、Node 22。
- `claudeMdExcludes` 是否作用于用户自己的 `~/.claude/rules`。
