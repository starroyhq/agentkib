# Claude 宿主队列暂停的界面接线

在桌面和 Web 的会话状态行显示宿主队列状态。收到 `live.schedule` 或当前会话的能力回包中的 `schedule` 时，使用最新状态。即使 `live.status` 是 `idle`，队列也可能待核对。项目 Agent 的委派暂停有自己的状态。

| 后台信号 | 状态词 | 原位操作 |
| --- | --- | --- |
| `schedule` 缺失，或 `paused` 为 `false` | 无 | 无 |
| `paused` 为 `true`，且 `requiresReconcile` 为 `true` | 待核对 | 「核对」走现有的 `managedAction("reconcile")` |
| `paused` 为 `true`，且 `requiresReconcile` 缺失 | 排队已暂停 | 「恢复」走现有的 `queue-resume` |

- 显示条件读队列状态。启用条件读当前会话经主机核权的 `features.reconcile` 或 `features["queue-resume"]`，以及目前的请求状态。不可用时置灰，原因放在 `title`。队列待核对时，`queue-resume` 返回能力原因 `control-outcome-unconfirmed`。
- 在共享会话页接入现有的 `ClaudeSessionReconcile`。如果轮次也待核对，只显示一个核对入口。队列单独待核对时用「待核对」，保留会话原有的轮次状态。
- 核对提交用现有的会话 ID、当前访问启动标识和新请求 ID。核对后读取最新 live 和能力；回执丢失时先重新读取状态。恢复提交用 `live.revision`，`schedule.revision` 只用于比较队列状态。
- 命令账本仍为 `prepared` 时，核对确认未派发后原队列项才回到待发。旧调度暂停可自动解除。若重启确认或其他暂停仍存在，状态切换到「排队已暂停」，再按能力显示「恢复」。已派发的未知项只核对原回执，不重发。
- 用量限制已安排续跑时继续显示现有倒计时。有待发的汇报或目标也显示队列状态。客户端用本地化状态词，固定原因码留给诊断和能力提示。
