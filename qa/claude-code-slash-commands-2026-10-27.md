# Claude Code 斜杠命令验收（2026-10-27）

分支 `feat/claude-code-followups`。三项改动各一个提交，本文档另成一个提交：

| 提交 | 内容 |
| --- | --- |
| `69ddc2359` | 后端按设备检查斜杠命令，capabilities 下发命令目录 |
| `cbafe2ca8` | 输入框的 `/` 命令菜单，发送前判断与 AgentKib 自己的操作 |
| `311a9c63f` | 会话记录与实时显示里的命令和本地命令输出 |

本轮没有调用模型，也没有使用真实 API key。下面的 CLI 行为全部来自本机 CLI 2.1.311 对本地 API 桩的离线运行，做法同 [2026-10-27 QA](claude-code-followups-2026-10-27.md)：桩只监听 `127.0.0.1`，CLI 在只放行 localhost 的 `sandbox-exec` 里运行，`HOME` 与 `CLAUDE_CONFIG_DIR` 指向空的临时目录，用假 key。项目命令 `/hello`、技能 `/probe-skill` 和所有对话内容都是合成的。

## 修复前的问题

- 远程设备能改这台电脑的 Claude Code 设置。CLI 不经审批执行内置命令：`/config permissionMode=auto` 写入 `~/.claude/settings.json` 的 `permissions.defaultMode: "auto"`，之后新开的会话（包括终端里的）以 auto 模式启动；`/autocompact 200000` 写用户设置的 `modelSettings.<model>.autoCompactWindow`；`/output-style Concise` 写项目的 `.claude/settings.local.json`；`/heapdump` 往 `~/Desktop` 写约 23 MB 的堆快照和诊断 JSON。以上都在隔离目录里实测。
- `/clear` 发出 `conversation_reset` 帧和新的 `session_id`，runner 报 `claude-protocol-violation`，会话变为只读。
- 重新读取历史后，命令和本地命令的输出（`system/local_command` 行）都消失；技能和自定义命令展开后的提示词（`isMeta` 行）显示成用户消息；`/compact` 实时显示压缩摘要和带标签的 `<local-command-stdout>Compacted </local-command-stdout>`。
- 输入框没有命令菜单；`/model X` 只改当前进程，AgentKib 的设置不知道。

## CLI 2.1.311 的实际行为

- initialize 的 `commands` 每项为 `{name, description, argumentHint, builtin?, aliases?}`。内置命令带 `builtin: true`，项目命令和技能没有，描述以 “(project)” 结尾。内置别名：`reset`、`new` → `clear`，`settings` → `config`，`name` → `rename`，`cost`、`stats` → `usage`，`peers` → `list-agents`，`proactive` → `loop`，`review` → `code-review`，`checkup` → `doctor`。
- 58 个命令逐一探测：print 模式下不提供的命令（`/help`、`/login`、`/permissions` 等）回复 “isn't available in this environment”；`/doctor`、`/init`、`/insights`、技能和自定义命令展开为给模型的提示词；`/loop 5m …` 交给模型去建周期任务；`/rename X` 写入原生标题；`/model X`、`/effort X` 只对本进程生效；不认识的名称和 `/private/tmp …` 这样的路径作为普通文字交给模型。
- 会话记录：命令写成只含 `<command-name>`、`<command-message>`、`<command-args>` 的用户行，标签顺序有两种（本地命令名称在前，提示词命令消息在前）；本地命令前有一条 `isMeta` 的 `<local-command-caveat>` 行；输出是 `system/local_command` 行，`/compact` 的输出是用户行；print 模式不提供的命令按输入写成 `system/local_command` 行（`/help`）。
- 实时：本地命令的输出是 `model: "<synthetic>"` 的 assistant 帧，uuid 与记录里的输出行相同。`/compact` 先发 `isSynthetic` 的摘要用户帧，再发 `isReplay` 的 `<local-command-stdout>Compacted </local-command-stdout>` 用户帧；此前的本地命令输出帧会以原 uuid 重发一次。

## 修复后：真实 CLI 与托管 runner

用正式的 `ClaudeManagedRunnerProcess` 依次发送 `hi`、`/context`、`/help`、`/hello world`、`/probe-skill tell me`、`/model claude-haiku-5-5`、`/compact`、`after compact`，再用现有历史读取器读这次的会话记录。这条测试直接驱动 runner，不经过后端的命令检查，所以 `/model X` 也到了 CLI。

- 8 轮都成功结束；实时的 8 条 Agent 回复（其中 `/context` 的用量表、`/help` 的说明、`Set model to …`、`Compacted` 来自 CLI 本身）都带 `turn_meta`，在历史里有同 ID 的 Agent 消息。
- 历史里的用户消息依次是 8 条原样输入，例如 `/hello world`、`/probe-skill tell me`。
- 实时和历史都没有标签、技能展开的提示词或压缩摘要；实时没有用户消息条目。

## 自动化测试

| 文件 | 内容 |
| --- | --- |
| `apps/desktop/test/claude-commands.test.ts`（95 项） | 共享规则：解析、别名、所有设备都拒绝的命令、本机与远程设备、目录里才有的内置命令、同名项目命令、多文字块、菜单 |
| `apps/desktop/test/claude-managed-commands.test.ts`（7 项） | 后端与脚本化 CLI：`/clear` 不启动进程且回执可重放；远程不能 `/config`、桌面可以；新进程报告目录后在写入前再拒绝；steer；queue-add、queue-update、goal-set；排队后被拒的条目不发出；目录随 capabilities 下发并在下一个宿主沿用 |
| `apps/desktop/test/claude-command-history.test.ts`（13 项） | 按 2.1.311 记录形状读历史；实时 `/compact`；未流式输出的文字只出现一次 |
| `electron/main/web/claude-host.test.ts`（+7 项） | 六个原因码传到浏览器；不能发送的设备拿不到目录 |
| Web `session-composer-commands.test.tsx`（25 项）、`slash-commands.test.ts`（26 项），桌面 `session-composer-commands.test.tsx`（3 项） | 菜单内容与键盘、ARIA、拒绝说明、AgentKib 操作、带附件时不改为操作、桌面按本机用户处理 |
| `codex-continuation-controller.test.tsx`（+1 项）、`session-reader.test.tsx`（+2 项） | 后端拒绝时会话页显示具体原因 |

- 变异检查：后端与共享规则 24 处、输入框 17 处、记录读取 11 处，每处单独改坏后相关测试都失败。
- 实时测试发现一个原有问题并已修复：未流式发送的 assistant 帧（本地命令的输出）在后面再来一帧 assistant 时，文字会重复一遍。原因是先记下条目文字再追加，追加会同时延长条目文字。
- 全量（`311a9c63f` 的代码）：后端构建，后端、桌面、Web 类型检查，`oxfmt --check`、`git diff --check` 通过；`oxlint` 警告数与基线相同（276）；Web 72 个文件 1560 项通过；桌面 448 个文件中 446 个通过、1 个跳过，8925 项通过。没通过的是 `skill-sync-manager.test.ts` 的 6 项，均为 5 秒超时。当时机器负载约 55（本仓库之外的 6 个游戏客户端和一台虚拟机），单独重跑该文件在默认超时下同样超时，把超时放宽到 60 秒后 17 项全部通过。这个文件只涉及技能同步，本轮没有改动相关代码。

## 视觉检查

用 playwright-cli 打开 Chromium，加载一个临时页面：Web 生产 `SessionComposer` 加 `style.css`，会话数据为合成内容（按 2.1.311 的目录形状），不启动 Backend 或模型，临时页面用后已删除。

- 900 px 浅色（zh-CN）和 390 px 深色（en-US）：菜单在输入框上方，与输入框同宽；当前项高亮；方向键移动后 `aria-activedescendant` 指向新的选项；长参数提示和描述以省略号截断；390 px 时页面宽度保持 390 px。
- 发送 `/config permissionMode=auto` 后草稿保留，输入框下方显示 Web 措辞的说明；会话还没有命令目录时，菜单显示“命令稍后出现”的说明。
- 检查中发现并修复了两处：菜单起初贴着文本框定位，盖住了输入框的边框；`/clear` 显示了 CLI 的 `[name]` 参数提示，而 AgentKib 并不发送它。

## 未验证

- 真实模型、真实账号和 claude.ai 登录下的行为；本轮只有本地桩。
- 远程浏览器经 HTTP 到 CLI 的完整链路没有用真实 CLI 跑通，各层分别验证：WebAccessService 用模拟的 Runtime，后端用脚本化 CLI，runner 用真实 CLI。
- CLI 从多个文字块中的哪一块读取命令未验证，所以每块都检查，可能多拒绝；项目命令与内置命令同名时 CLI 执行哪一个也未验证，按更严格的规则处理。
- 2.1.311 之后新增的内置命令依靠目录的 `builtin` 拦截；不报告 `builtin` 的版本只能依靠内置列表。
- 允许远程使用的 `/color`、`/focus`、`/fast` 依据的是 print 模式下的回复（只改会话或不可用），没有核对以后的版本是否写设置文件。
- `/list-agents` 的描述说可以给同一台电脑上的其他 Claude 会话发消息。远程设备不能运行这条命令，但模型仍可能通过工具发消息；工具调用照常经过 CLI 的审批，这条路径本轮没有核对。
- 排队后在派发时被拒绝的条目会让宿主暂停队列，界面没有专门显示原因。
- `/clear` 只给说明，没有在说明旁加“新建会话”按钮；桌面工具栏已有新建按钮。
