# 达到使用上限

AgentKib 运行的 Claude Code、Codex 和 DeepSeek Harness（DSH）会话，在账户达到使用上限时怎么提示、怎么继续。实现在 `packages/backend/src/usage-limit.ts`。

## 会话照常可用

这一轮按失败结束，结果是确定的。会话保持空闲、可以发送；之前 Claude Code 的这一轮被当作“结果待核对”，会话随之只读。

- **Claude Code**（2.1.299 起，2.1.323 实测于二进制）：被拒绝的请求变成一条 `error: "rate_limit"` 的 assistant 消息，带 `api_error: "usage_limit_reached"` 和 `api_error_params.rate_limit_info`（`resetsAt` 以秒计，`rateLimitType` 如 `five_hour`、`seven_day`、`seven_day_opus`），接着是 `is_error` 的 `result`（HTTP 429）。2.1.263 只在 `rate_limit_event` 里给出限额，AgentKib 两处都读。Claude Code 进程不退出，也不按登录失败那样换新进程。
- **Codex**（0.167.0）：`error` 通知和失败的 `turn/completed` 带 `codexErrorInfo: "usageLimitExceeded"`，不带重置时间。AgentKib 像 Codex 桌面端一样读 `account/rateLimits/read`：用完的窗口里最晚重置的那个决定重置时间；读不到就不说时间。
- **DSH**（0.2.2-rc.2）：一轮以错误码 `QUOTA` 或 `ACCOUNT_QUOTA` 结束（插件 0.8.1 起把错误码和原文带给 AgentKib）。DSH 自己不会重试这类错误，也没有重置时间。

## 提示

输入框上方一行，说是哪个上限（5 小时、每周、某个模型的、额度）、什么时候重置（当天只写时间，否则带日期），以及 AgentKib 会不会自己继续。措辞随各 Agent 自己的客户端：Codex 桌面端的“你已达到使用上限”“请稍后再试”，DSH 的“当前请求的额度已用尽”，Claude Code 的上限名称和 “Don't continue automatically”。四种语言，桌面、Web 和手机一致。

## 重置后自动继续

按 Claude Code 2.1.323 的 “Continue automatically at usage limit”（订阅账户默认开启，只在交互界面里有，`claude -p` 由宿主自己做）：

- 重置在 24 小时之内才自动继续；在重置后 30 到 90 秒之间发出。
- 发出的是 Claude Code 自己的那句话（Codex 用同样的话，去掉 claude.ai）。它是给模型的，不是用户写的，所以和 Claude Code 一样不出现在对话记录里。
- 有排队的消息或 Worker 汇报时，先发它们，不再另发这句话。Claude Code 会话的目标、Codex 因上限暂停的目标（`usageLimited`）随之恢复。
- 继续之后又碰到上限：时间已过还没恢复的，60 秒、再 300 秒后再试；用户没有发消息的情况下最多连续 3 次，之后停下，由用户继续。
- 等待期间用户发消息就按用户的消息来（立即发送），不再自动继续。
- **由用户选择，默认自动继续**：桌面设置里的“达到使用上限时，重置后自动继续”对这台电脑上的所有会话生效，默认开启，和 Claude Code 自己的选项一样。每次提示上也能单独选：已排上自动继续时显示“不自动继续”；没有排上（设置关了、点过不自动继续、重置在 24 小时之后、连续三次后停下、AgentKib 重启过）而重置时间还没到时，显示“重置后自动继续”，点了就从零计次重新排上。能发消息的设备都可以点。
- 不自动继续的情况：设置关了；不知道重置时间；重置在 24 小时之后；AgentKib 重启过（Claude Code 退出时也就不再等了）。重置还没到时，提示上可以选“重置后自动继续”。电脑睡眠或 AgentKib 关着、错过时间 30 分钟以上的，不再补发，提示改为“使用上限已重置，发送消息即可继续”。
- 以那一轮发送消息的设备的名义发出。Claude Code 会话走计划任务，发送前按这台设备当时的权限检查；Codex 会话在这台设备的授权变化时不再自动继续。DSH 会话不自动继续。

## 项目 Agent

- Claude Code 项目 Agent：Worker 的汇报在它自己的队列里等，重置后先送汇报。
- Codex 项目 Agent：等待重置期间委派暂停（`usage-limit`），汇报留着；自动继续成功，或用户在这个会话里发消息，委派就继续并送出汇报。

## 没有做的

- 接近上限的预警（Claude Code 的 `allowed_warning`、Codex 的用量百分比）不在会话里提示，额度页面照旧显示。
- 连接终端的 Claude Code 会话由终端里的 Claude Code 自己处理上限。
- Devin 会话不在此列。
