# Claude Code 托管续接

Web 的 Claude 控制使用本机 Claude CLI 的原生 `stream-json` 协议，而不是 Codex bridge。
历史目录仍由现有 Claude provider 发现；仅可续接有可验证 UUID、原工作目录及主会话记录的会话。

## 使用与边界

- 本次适配版本为 macOS Claude Code `2.1.263`。用户需自行安装并完成 Claude 登录或供应商配置；AgentKib 不读取、复制或下发登录凭据。
- 在桌面开启 Web 与实验控制，再分别授予浏览器发送、审批权限。默认关闭，读取授权不包含工具审批。
- 首次发送才启动 `claude --resume=<UUID>`；查看历史/状态不会启动模型。进程沿用真实会话 cwd，不把父工作区当成执行目录，不创建新会话或分叉。
- 这是 **AgentKib 托管的续接执行**，不是控制已有终端。使用前应关闭同一会话的其他 Claude 终端；私有操作锁只约束 AgentKib 实例，无法约束官方 CLI。
- CLI 会加载其正常配置、CLAUDE.md、MCP 与 hooks；只对可信项目启用托管执行。明确使用 manual 权限模式，不启用跳过权限或自动批准。
- 浏览器断线不等于终止模型执行；重连只同步快照，不重发请求。退出 AgentKib 会清理自有 Claude 进程组。已自行脱离进程组的外部服务不在清理保证内。

## 审批行为

按 Claude 的 `can_use_tool` 请求展示工具名称、完整输入及权限上下文。支持本次 `allow` / `deny`；允许时回传原始 `updatedInput`，不发送 `updatedPermissions`，不持久保存建议规则。
拒绝不冒充取消整轮：Claude 会接收到拒绝并决定如何回应。已取消、过期、重复或 revision/轮次不匹配的审批不能提交。

已接入适配版本的选择式 `AskUserQuestion`：问题独立展示，通过 `/answer` 回传原生答案，要求浏览器发送权限而不是审批权限。支持单选、多选和自定义回答；关闭问题框只是收起，不会拒绝或取消请求。新式 text/number/preview 等未验证契约、后台 Agent 任务及未知权限契约仍保持控制禁用并报告限制；不能用“允许工具”代替回答问题。
“请求已接收”仅代表进入本机执行队列；只有 Claude 的成功 result 才表示该轮完成。

## 开发验收

- 自动测试不调用真实模型；`claude-real.test.ts` 默认跳过。
- 本机指定 test 会话的真实测试需显式设置 `AGENTKIB_CLAUDE_REAL_SESSION` 为该测试 UUID。测试使用隔离 runtime 数据与随机 loopback 端口，临时配对浏览器仅授予所需权限。
- 不要在结果未确认后反复重跑真实测试。先检查记录与失败原因，不自动恢复旧控制请求。
- 真实验收结果与限制记录在 `qa/claude-web-2026-09-09.md`；代码测试通过不能替代真实发送和审批验收。

参考：[Claude 官方 SDK 控制协议](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py)。`/tmp/cc-switch` 仅作为扫描和外部终端续接的参考，没有复用其代码或引入其依赖。
