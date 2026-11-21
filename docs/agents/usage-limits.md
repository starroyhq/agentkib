# 达到使用上限

AgentKib 运行的 Claude Code、Codex、DeepSeek Harness（DSH）和 Devin 会话，在账户达到使用上限时怎么提示、怎么继续。实现在 `packages/backend/src/usage-limit.ts`，Devin 的重置时间在 `packages/backend/src/devin-usage.ts`。

## 会话照常可用

这一轮按失败结束，结果是确定的。会话保持空闲、可以发送；之前 Claude Code 的这一轮被当作“结果待核对”，会话随之只读。

- **Claude Code**（2.1.299 起，2.1.323 实测于二进制）：被拒绝的请求变成一条 `error: "rate_limit"` 的 assistant 消息，带 `api_error: "usage_limit_reached"` 和 `api_error_params.rate_limit_info`（`resetsAt` 以秒计，`rateLimitType` 如 `five_hour`、`seven_day`、`seven_day_opus`），接着是 `is_error` 的 `result`（HTTP 429）。2.1.263 只在 `rate_limit_event` 里给出限额，AgentKib 两处都读。Claude Code 进程不退出，也不按登录失败那样换新进程。
- **Codex**（0.167.0）：`error` 通知和失败的 `turn/completed` 带 `codexErrorInfo: "usageLimitExceeded"`，不带重置时间。AgentKib 像 Codex 桌面端一样读 `account/rateLimits/read`：用完的窗口里最晚重置的那个决定重置时间；读不到就不说时间。
- **DSH**（0.2.2-rc.2）：一轮以错误码 `QUOTA` 或 `ACCOUNT_QUOTA` 结束（插件 0.8.1 起把错误码和原文带给 AgentKib）。DSH 自己不会重试这类错误，也没有重置时间。
- **Devin**（CLI 3000.12.59）：Devin 的服务以 JSON-RPC 错误 `-32011`（`cognition.ai/errorKind: resource_exhausted`）结束这一轮，原文如 “Your daily usage quota has been exhausted. Visit https://app.devin.ai/settings/usage to purchase on-demand usage or turn on auto-reload.”（也有 weekly）；CLI 自己的错误还有 “Quota exhausted”“Usage limit reached”“Organization usage limit reached”、每月上限、ChatGPT 订阅上限和 “Rate limited”。AgentKib 从 `devin -p` 打印的错误里认出这些说法（退出码为 0 时只看 stderr），原文去掉 “Error:” 前缀和 trace ID 后保存。`devin -p` 不给重置时间：账户的 `daily_quota_reset_at_unix`、`weekly_quota_reset_at_unix` 只在交互式 CLI 的 `/usage` 面板里显示。AgentKib 在后台的伪终端里启动一次交互式 `devin`（会话的工作区为当前目录，用户平常的登录），键入 `/usage` 读出面板，最多 20 秒，每次碰到上限至多一次；按原文说的窗口（daily、weekly）取重置时间，没说时取用完的窗口里最晚重置的那个。读不出就没有时间。AgentKib 不读 Devin 的登录，也不替用户回答 Devin 先问的问题。实现在 `packages/backend/src/devin-usage.ts`，见 [Devin](devin.md)。

## 提示

输入框上方一行，说是哪个上限（5 小时、每周、某个模型的、额度）、什么时候重置（当天只写时间，否则带日期），以及 AgentKib 会不会自己继续。措辞随各 Agent 自己的客户端：Codex 桌面端的“你已达到使用上限”“请稍后再试”，DSH 的“当前请求的额度已用尽”，Claude Code 的上限名称和 “Don't continue automatically”。Devin 的客户端没有对应的提示：每周额度用“已达到每周使用上限”，其他用“你已达到使用上限”；碰到上限时马上提示“请稍后再试”，读出重置时间后改为写出时间和会不会自动继续。四种语言，桌面、Web 和手机一致。

## 重置后自动继续

按 Claude Code 2.1.323 的 “Continue automatically at usage limit”（订阅账户默认开启，只在交互界面里有，`claude -p` 由宿主自己做）：

- 重置在 24 小时之内才自动继续；在重置后 30 到 90 秒之间发出。
- 发出的是 Claude Code 自己的那句话（Codex 用同样的话，去掉 claude.ai；Devin 的说的是 Devin 的额度，“Your Devin usage quota has reset…”）。它是给模型的，不是用户写的，所以和 Claude Code 一样不出现在对话记录里。
- 有排队的消息或 Worker 汇报时，先发它们，不再另发这句话。Claude Code 会话的目标、Codex 因上限暂停的目标（`usageLimited`）随之恢复。
- 继续之后又碰到上限：时间已过还没恢复的，60 秒、再 300 秒后再试；用户没有发消息的情况下最多连续 3 次，之后停下，由用户继续。
- 等待期间用户发消息就按用户的消息来（立即发送），不再自动继续。
- **由用户选择，默认自动继续**：桌面设置里的“达到使用上限时，重置后自动继续”对这台电脑上的所有会话生效，默认开启，和 Claude Code 自己的选项一样。每次提示上也能单独选：已排上自动继续时显示“不自动继续”；没有排上（设置关了、点过不自动继续、重置在 24 小时之后、连续三次后停下、AgentKib 重启过）而重置时间还没到时，显示“重置后自动继续”，点了就从零计次重新排上。能发消息的设备都可以点。
- 不自动继续的情况：设置关了；不知道重置时间；重置在 24 小时之后；AgentKib 重启过（Claude Code 退出时也就不再等了）。重置还没到时，提示上可以选“重置后自动继续”。电脑睡眠或 AgentKib 关着、错过时间 30 分钟以上的，不再补发，提示改为“使用上限已重置，发送消息即可继续”。
- 以那一轮发送消息的设备的名义发出。Claude Code 会话走计划任务，发送前按这台设备当时的权限检查；Codex 和 Devin 会话在这台设备的授权变化时不再自动继续，Devin 会话重新排上时以点选的设备的名义发出。DSH 会话不知道重置时间，不自动继续，提示上也没有“重置后自动继续”；Devin 会话的 `/usage` 读不出时间时也一样。
- **重启之后**：Claude Code 会话的提示随会话状态保存；Devin 会话的提示存在受控命令台账里（保留 7 天），下一轮开始时清除。已排上的自动继续随退出结束，重启后改为由用户继续（`manual: "restarted"`），重置还没到时可以再排上；其他提示照旧。Codex 会话的提示只在内存里，随 AgentKib 退出结束。

## 项目 Agent

- 由 AgentKib 运行的 Claude Code 项目 Agent：Worker 汇报在会话自己的队列里等，重置后按原有规则派发。
- Codex 项目 Agent：等待期间委派暂停（`usage-limit`）。自动继续成功、查活确认限额解除，或用户在这个会话里发消息后，委派继续，暂存的汇报合成一条送出。
- DSH 项目 Agent：DSH 没有重置时间，暂存的汇报等用户在项目 Agent 会话里发消息，或在面板里恢复委派后再送出。
- Worker：项目 Agent 收到限额类型和已知的重置、续跑时间。限额仍生效时，`worker_send` 返回 `worker-usage-limited`。缺少重置时间时，等会话解除限额。需要手动继续时，复用手机的“需要你处理”提醒。

## 没有做的

- 接近上限的预警（Claude Code 的 `allowed_warning`、Codex 的用量百分比）不在会话里提示，额度页面照旧显示。
- 连接终端的 Claude Code 会话由终端里的 Claude Code 自己处理上限，插件和桥接目前没有传递限额状态。
- Windows 上读不出 Devin 的重置时间（没有 `script(1)`），Devin 会话只有提示。
