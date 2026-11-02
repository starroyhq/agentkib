# 跟随 Codex 桌面端：实施与验收（2026-11-02）

## 范围

D11 之后，Codex 会话被 ChatGPT 桌面端占着写锁时，AgentKib 只能分支或回 Codex 继续。本轮把保留的 follower 接回主流程：写锁被其他进程持有、且桌面端的本地 IPC 报告了这条会话的 owner 时，AgentKib 跟随 owner，把发送、停止和审批交给 owner 执行；其余情况保持 D11 行为。设计与边界见 [Codex 托管执行](../docs/CODEX-MANAGED.md)的“跟随 Codex 桌面端”。

改动均未提交。

## 环境

- macOS 27.0（arm64）。
- ChatGPT 桌面端 `26.1027.51404`（build 23880），内置 codex-cli `0.166.0-alpha.5.1`；PATH 上 codex-cli `0.163.0`。
- AgentKib 开发版：当前工作区源码，数据目录 `ai.agentkib.dev`。
- 测试会话：“处理测试对话”，原生 ID `01a07b7a-68a8-7113-832f-36d1ddd5594f`，cwd 为本仓库，`approval_mode: on-request`，受限沙箱；用户指定可追加测试轮次。

## 静态核对

当前桌面端安装包中的 IPC 方法版本与 AgentKib 固定的版本一致：`thread-owner-discovery` 1、`thread-follower-start-turn` 2、`thread-follower-interrupt-turn` 4、`thread-stream-state-changed` 11、`thread-follower-update-thread-settings` 2、`thread-follower-submit-user-input` 1。桌面端还提供 steer、队列、压缩、读取模型设置等跟随方法，本轮未接入。

## 自动化

均通过直接调用工作区内的 vitest、tsc、oxlint、oxfmt 运行（本机 pnpm 12.10.1 的原生二进制未安装完成，见“环境问题”）。

- `apps/desktop`：`vitest run test/codex-auto-continue.test.ts` 204/204；`electron/main/web/codex-actions.test.ts`、`service.test.ts`、`stream-backpressure.test.ts` 及 `codex-live-state`、`compaction-control`、`managed-session-catalog`、`codex-resume-command` 280/280；桌面会话输入区、展示状态和四语术语测试通过。
- `apps/web`：完整 `test:web` 1678/1678（重复显示修复之前）；输入区测试 49/49。
- backend、desktop、web 的 tsc 均无错误；oxlint 无新增问题；我们改动的行通过 oxfmt 检查。

新增后端用例覆盖：写锁被占且找到 owner 时跟随；找不到 owner 时保持选择条并 5 秒退避；平台不支持时不尝试；发送、停止、审批转交 owner；其他操作返回 `follower-operation-unverified`；修订号过期不派发；owner 消失后回到托管链路；跟随时的能力表；无人订阅 30 秒后断开；结果未知的发送和审批的核对；跟随时分支；提问显示为不支持；只推送状态、不推送对话条目。

## 真实验收

全程桌面端 app-server（PID 58514）持有这条会话的写锁；AgentKib 没有启动 `codex app-server`。

| 编号 | 操作 | 结果 |
| --- | --- | --- |
| 打开 | 在开发版中打开会话 | 页头“在 Codex 中執行 · 已連線”，输入框上方“訊息會交給 Codex 執行，模型和權限沿用 Codex 中的設定”，输入框可用。通过 |
| AK-FOLLOW-001 | 发送只要求回复标记的消息 | 轮次 `01a19b3d-3e19-7d00-90ba-f49f41aa1999` 在同一会话中执行，回复“AK-FOLLOW-001 收到”。通过；界面见问题 2 |
| AK-FOLLOW-002 | 发送 `sleep 30` 并准备停止 | 约 6 秒内显示用户消息和“停止目前輪次”；随后开发版因其他进程修改源码自动重启，未能停止，轮次 `01a19b49-cbd0-7dc1-914a-b02e1c5d37ed` 自然结束。运行中用户消息显示了两次，见问题 1 |
| AK-FOLLOW-003 | 执行 `sleep 30` 时点“停止目前輪次” | 原生记录为 “aborted by user after 25.3s”，轮次 `01a19b4d-1bdd-7bc3-9a84-9823e3cf8930` `turn_aborted: interrupted`；`sleep` 进程没有残留。通过 |
| AK-FOLLOW-004 | 申请提权执行 `/usr/bin/true` 并在 AgentKib 允许 | 显示“等待審批”，cwd `/tmp`，命令 `/bin/zsh -c /usr/bin/true`，按钮只有“允許一次”“取消輪次”（owner 未提供拒绝）。允许后执行一次，轮次 `01a19b4e-224e-7f23-b189-acf98c0aad7a` 回复“AK-FOLLOW-004 退出码 0”。通过 |

## 发现的问题

1. **运行中用户消息重复显示**：follower 推送桌面端内存中的条目，会话流同时每 250ms 读取原生 rollout，两者对同一消息使用不同身份，轮次结束后才去重。已改为 follower 只推送实时状态，对话内容只读 rollout，并补充单元测试；尚未在真实环境复验。
2. **第一次发送后需要手动刷新才显示新轮次**：发生时开发版窗口被其他窗口遮挡；窗口可见时的后两次发送约 6 秒内自动显示。怀疑是被遮挡窗口的渲染节流，尚未确认，需在窗口可见时复验。
3. **验收期间另一进程在同一工作区修改源码**：`apps/desktop/electron/main/web/service.ts`（16:04）、`packages/backend/src/web-read.ts`（16:09、16:13）及新增的 subagents 相关文件，导致开发版两次自动重启。本轮改动保留完好，但这两个文件现在同时包含双方改动，提交时需按改动块区分。上面的完整测试在这些修改之前运行。

## 环境问题（未修改仓库配置）

- `~/Library/pnpm/.tools/pnpm/12.10.1` 的安装脚本未运行，`pnpm` 仍是占位文本；验收时用 `/tmp/agentkib-pnpm/pnpm` 指向已安装的原生二进制。
- pnpm 安装时跳过了 electron 的 postinstall，开发版首次启动前运行了 electron 自带的 `install.js` 下载二进制。
- 代理环境带有 `ELECTRON_RUN_AS_NODE=1`，启动开发版前需 `unset`。

## 未覆盖

问题 1 修复后的真实复验和问题 2 的确认；桌面端真实退出后切回托管链路；两端同时发送；文件审批、提问和设置；Windows、Linux；LAN、手机和中继访问。
