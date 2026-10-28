# 对话工具详情：真实模型验收 — 2026-10-27

## 范围与隔离

- 源码：分支 `feat/conversation-tool-details` 第 1 步的 5 个提交（`fab99a2c1`）加本轮修复（见“发现与处理”）。未推送、未开 PR。
- 链路：真实 `WebAccessService`（HTTP）→ `TypeScriptBackend` → 真实 CLI。Codex CLI 0.163.0 走 app-server，Claude Code 2.1.311 走 stream-json。每个 Agent 只跑一轮，没有重试。
- 模型：
  - Codex 用 `gpt-6-luna`，effort low。指定的“luna 6.1”不在这个账号的模型列表里：app-server `model/list` 只返回 gpt-6.1-sol、gpt-6-astra、gpt-6.1-terra、gpt-6-sol、gpt-6-luna、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna，所以用了 6 系列里唯一的 Luna。
  - Claude 用 `claude-haiku-5-5`，由 assistant 消息的 `model` 字段确认。
- 工作区：临时目录里的合成 Node 项目，`sum([])` 会抛错，测试有一项失败。两个 Agent 各用一份。提示要求读 README、运行一次失败的 `node --test`、修复、新建 NOTES.md、再运行测试。
- Codex 隔离：
  - 使用独立的 CODEX_HOME，只放测试用的 config.toml。
  - 登录用个人 auth.json 的临时副本。副本里的 `last_refresh` 改成当前时间，避免隔离进程轮换刷新令牌、导致个人登录失效；access token 仍在有效期内。测试后整个 CODEX_HOME 已删除。
  - 策略是 AgentKib 默认的 workspace-write、按需审批、不联网。
- Claude 隔离：
  - 现有登录只能在默认配置目录下使用：设置 `CLAUDE_CONFIG_DIR` 后 `auth status` 显示未登录，即使指向默认路径也一样。因此 CLI 仍在默认配置目录下运行。
  - 启动参数：`--safe-mode --restricted --strict-mcp-config`；工具只开放 Bash、Read、Edit、Write、Glob、Grep；`--settings` 只允许 `node --test`；`--max-budget-usd 0.50`。
  - 运行后，本轮的会话记录和会话登记文件已移出个人目录，Bash 工具生成的 shell 快照已删除。CLI 启动时刷新了一个内置插件缓存文件，保留未动。
- 单轮保护：包装脚本只放行一次 Codex `turn/start` 和一条 Claude 用户消息。
- 个人的 `~/.codex/auth.json`、`~/.codex/config.toml`、`~/.claude.json`、`~/.claude/settings.json` 前后哈希一致。
- 环境问题：测试进程继承了 `ZDOTDIR`，Codex 沙箱里的命令读取了个人 zsh 启动文件，输出里多出两行“找不到 `.cargo/env`”的报错，家目录已脱敏为 `$HOME`。这是本次验收环境造成的，不是产品行为。

## 结果

| 检查 | Codex | Claude Code |
| --- | --- | --- |
| 轮次完成 | 39.6 秒（原生记录 38.6 秒），无审批 | 9.3 秒（CLI 报告 8.4 秒），无审批 |
| 历史中的工具详情 | 读取 README.md；`node --test` 失败、退出码 1；修改 src/sum.js +1 -1；新建 NOTES.md +1；`node --test` 通过 | 读取 README.md、src/sum.js；Bash 失败（没有退出码，按状态显示失败）；Edit src/sum.js +1 -1；Write 新建 NOTES.md +1；Bash 通过 |
| 实时与历史 | 5 个工具条目的 `tool` 逐字节相同 | 6 个工具条目逐字节相同；实时来自 stream-json，历史来自会话记录，是两个来源 |
| 显示路径 | 标题和 diff 路径都是工作区相对路径 | 同左 |
| 轮次用时 | 修复后实时与连接中的历史都是 38584 ms；重启后从原生记录读也是 38584 ms | 无，见下文第 3 条 |
| 代码模式包装 | 原生记录有 4 个 `exec` 包装，分别记 1、1、2、1 个子条目，界面隐藏 | 不适用 |
| 用量 | 输入 75402（缓存 67712）、输出 359 tokens | 0.00265 美元；输入 10、输出 936、缓存读 32948、缓存写 9281 tokens |

## 发现与处理

1. **已修复：连接中的托管 Codex 会话没有轮次用时。** `turn/completed` 自带 `turn.durationMs`，但实时投影没有使用。会话连接期间，历史就是这些实时条目，所以只有断开或重启后读原生记录时才有“用时”。现在 `turn/completed` 把时长和结果加到该轮最后一条，`thread/read` 恢复时同样处理；台账中已存的条目只补 `turn_meta` 一个键，其余内容不变。
2. **已修复：连接中的托管 Codex 会话的 Agent 消息没有 `message_phase`。** app-server 的 agentMessage 带 `phase`，原生记录也有。缺了它，过程分组会把一轮的工具拆成两段：真实数据显示为 4 次加 1 次，修复后与原生记录一致，是一段 5 次。
3. **待决定：Claude Code 以 stream-json 运行时没有可保存的轮次用时。** 会话记录里没有 `system/turn_duration`，只有实时 `result` 帧带 `duration_ms`（8397 ms）。会话记录首尾时间戳之差是 8378 ms。可选做法：
   - 按时间戳推算：历史可用，误差约几十毫秒；
   - 保存实时 `result` 的时长：精确，但只覆盖经 AgentKib 运行的轮次；
   - 保持不显示。
4. **已确认：Claude stream-json 的 user 帧带结构化 `tool_use_result`**（6/6），关闭此前的未验证项。
5. 观察：命令输出里的绝对路径（例如 node 测试的堆栈）不改写，家目录按规则脱敏为 `$HOME`。
6. 观察（与本轮无关）：用户消息气泡里的行内代码对比度很低，浅色主题是白底浅字，深色主题是深底深字。补充（2026-10-28）：已修复，见[用户消息气泡里的代码、引用和链接](user-message-contrast-2026-10-28.md)。

## 零模型复核

- 重启：用新的 Backend 读取同一份数据。Codex 历史切换为原生记录，结果见上表；Claude 历史与运行时一致。
- 回放：把真实的 app-server 帧送进修复后的投影。最后一条是 `final_answer`，带 38584 ms；工具条目与运行时记录相同。
- 界面：用真实事件渲染 Web 生产 `SessionTranscript`，900 px 浅色、390 px 深色。包装行隐藏；显示“用时 39 秒 5 次工具调用 · 1 失败”和轮末“已修改 2 个文件 +2 -1”；页面没有横向溢出。

## 自动化

| 检查 | 结果 |
| --- | --- |
| `test/live-tool-details.test.ts`：新增 `turn/completed` 时长、`thread/read` 恢复时长、台账只补 `turn_meta` 三项，并断言 `message_phase` | 6/6 通过；分别去掉台账合并、`turn/completed` 返回后，对应用例失败 |
| 桌面全量 `vitest run`（先重新构建 backend） | 441 个文件通过、1 个跳过；8786 项通过、3 项跳过 |
| backend、desktop、web 类型检查 | 通过 |
| `oxfmt --check`（仓库格式范围）、`oxlint`、`git diff --check` | 通过；oxlint 0 个错误，改动文件没有新警告 |

Web 代码本轮没有改动，未重跑 Web 全量。

## 证据

本机私有临时目录 `/private/tmp/agentkib-tool-details-real-20261027/`（evidence、runner），可能被系统清理。日志中的账号信息和邮箱已替换。截图保存在任务目录，不入库。

没有覆盖：审批与提问的真实流程（本轮没有触发）、Windows/Linux、手机实机、打包安装。
