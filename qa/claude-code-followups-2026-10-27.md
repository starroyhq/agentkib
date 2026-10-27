# Claude Code 后续改动验收（2026-10-27）

分支 `feat/claude-code-followups`，基于 `feat/conversation-tool-details`。三项改动各一个提交：

| 提交 | 内容 |
| --- | --- |
| `fccc8ed4a` | 托管 Claude 会话显示并保存轮次用时 |
| `448cb0099` | 托管 Claude 会话的认证失败可恢复并显示重试 |
| `a6d462bba` | 终端连接在 sec-default 下也能发现等待审批 |

本轮没有调用模型，也没有使用真实 API key：订阅额度不可用，用户也未提供 key。下面的 CLI 行为全部来自本机 CLI 2.1.311 对本地 API 桩的离线运行，数据都是桩和隔离目录里生成的合成内容。

## 方法：本地 API 桩

- 桩是一个 Node HTTP 服务，只监听 `127.0.0.1`，实现 `POST /v1/messages`（SSE 流式与非流式）、`GET /v1/models`、`POST /v1/messages/count_tokens`。`ok` 模式回一段固定文字，`unauthorized` 模式对所有请求回 401 `authentication_error`。日志只记方法、路径、认证方式（`x-api-key` 或 bearer）、模型名和工具数，不记 key 和请求体。
- CLI 运行环境：`HOME` 与 `CLAUDE_CONFIG_DIR` 指向空的临时目录，`ANTHROPIC_BASE_URL` 指向桩，`ANTHROPIC_API_KEY` 为假 key（`sk-ant-api03-stub-…`，或不设），`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`、`DISABLE_AUTOUPDATER=1`，`PATH` 只含系统目录。
- 进程放在 `sandbox-exec` 里，配置为 `(deny network-outbound)`，只放行 `localhost` 与 Unix socket。桩日志确认所有请求都到了桩。
- 参数与托管 runner 相同：`--print --input-format stream-json --output-format stream-json --verbose --include-partial-messages --permission-prompt-tool stdio --model claude-haiku-5-5`。

## CLI 2.1.311 的实际帧

| 情形 | 结果 |
| --- | --- |
| 环境变量里的 key，桩正常回复 | `system/init.apiKeySource` 为 `ANTHROPIC_API_KEY`；桩收到 `x-api-key`。`result` 带 `duration_ms`（365）、`api_error_status: null`、`terminal_reason: "completed"` |
| 不设 key、无登录 | `apiKeySource` 为 `none`；约 40 ms 内出现 `model: "<synthetic>"` 的 `assistant` 帧，带 `error: "authentication_failed"`、`is_api_error_message: true`，文字 `Not logged in · Please run /login`；随后 `result` 为 `subtype: "success"`、`is_error: true`、`terminal_reason: "api_error"`、`api_error_status: null`；关闭 stdin 后退出码 1 |
| 环境变量里的 key，桩回 401 | 10 个 `system/api_retry`，各带 `attempt`、`max_retries: 10`、`retry_delay_ms`（501 → 1137 → 2412 → 4321 → 8878 → 18961 → 37936 → 32039 → 39307 → 38817）、`error_status: 401`、`error: "authentication_failed"`；之后合成 `assistant` 帧带 `api_error_status: 401`，文字 `Invalid API key · Fix external API key`；`result` 同上但 `api_error_status: 401`，`duration_ms` 184500 |

会话记录（`projects/<cwd>/<id>.jsonl`）里有 `queue-operation`、`user`、`attachment`、`atis-latch`、`api-request-shape`、`api-request-blob`、`api-request`、`last-prompt`、`assistant`、`cost-state`，401 时另有每次失败的 `system/api_error`。没有 `system/turn_duration`；`cost-state` 只有整段会话的累计时长。实时 `assistant` 帧的 `uuid` 与记录里该行的 `uuid` 相同，现有历史读取器也用它作为 Agent 消息的 ID。合成的错误消息在历史里同样是一条 Agent 消息。

## 托管 runner 端到端（真实 CLI + 桩）

用正式的 `ClaudeManagedRunnerProcess` 启动上述沙箱里的 CLI，各跑一轮：

| 情形 | runner 结果 |
| --- | --- |
| 正常回复 | 本轮最后一条 Agent 消息再次下发，带 `turn_meta: { outcome: "completed", duration_ms: 364 }`；用现有历史读取器解析这次的真实会话记录，该消息 ID 与之相同，记录本身不带 `turn_meta` |
| 无登录 | 状态 `idle`、`lastOutcome: "failed"`、`sendEnabled: true`，原因 `claude-auth-failed: Not logged in · Please run /login; key source: none`；错误消息带 `turn_meta: { outcome: "failed", duration_ms: 95 }` |
| key 被拒 | 快照依次带 `apiRetry` 1/10 到 10/10（`status: 401`、`error: "authentication_failed"`）；结束后 `idle`、`failed`、可发送，原因 `claude-auth-failed: Invalid API key · Fix external API key (HTTP 401); key source: ANTHROPIC_API_KEY`，`apiRetry` 清空；`turn_meta.duration_ms` 179741 |

## 终端插件：tool.check

- 从 2.1.311 二进制的 Zstd 帧只读提取内嵌的 Mods 类型声明（667704 字节，SHA256 `146b3b6b4b40fa5ed8a160c8451c346e8f58d4eca59b8d6167556100f5b99471`）。`tool.check` 在 `tool.call` 与 PreToolUse hook 之后、模式处理 ask 之前触发；`next(e)` 解析为 `{ decision: "allow" | "ask" | "deny", reason?, rule?, hook?, setting?, plugin?, ceiling? }`；输入有 `tool`、`input`，真实调用另有 `tool_use_id`、子代理的 `agentId`、`approver`（`host` 或 `person`）与 `isReadOnly`。
- sec-default 的说明确认它让 `classic.*` 越过用户层，所以用户安装插件的 `classic.PermissionRequest` 不会运行。
- 官方插件引擎（`compatibility` 脚本，CLI 拷到 `/private/tmp`，沙箱无网络、不可读个人目录）：`plugin validate --strict` 通过，`plugin test` 10 通过 / 0 失败。故意改坏新增的 `tool.check` 透传断言后 `plugin test` 失败，说明该测试确实在官方引擎里运行。

## 自动化测试

- 新增 `apps/desktop/test/claude-managed-turn-duration.test.ts`（8 项）、`apps/desktop/test/claude-auth-failure.test.ts`（7 项）、`apps/web/src/features/sessions/claude-turn-notice.test.tsx`（7 项）；`codex-copy.test.ts` 增加认证失败说明的 6 项，`claude-bridge-plugin.test.ts` 增加 5 项，插件自带测试增加 1 项。
- 变异检查：去掉 turn_meta 下发、历史补回、历史版本号、认证分类、`authentication_failed` 标记、回收请求、巡检回收、`api_retry` 的空闲过滤与清除、通知组件的状态判断与两半认证判断、插件的 `approver`/`agentId`/`ask` 判断、等待登记与结论透传，共 18 处，相关测试都失败。其中“只凭 HTTP 401 给认证提示”一处起初没有测试覆盖，补测试后才失败。
- 全量：桌面 444 个测试文件中 441 个通过、1 个跳过，8804 项通过；另有 2 项在全量负载下超过 5 秒超时（`McpAccessibleLabels` 的 ja-JP 用例、`claude-web-backend-integration` 的分叉用例），单独重跑这两个文件 44 项通过。Web 70 个文件 1506 项通过。后端、桌面、Web 类型检查，后端构建，`oxfmt --check`、`git diff --check` 通过；`oxlint` 警告数与基线提交相同（276）。

## 未验证

- 真实 Anthropic API key、第三方供应商和 `apiKeyHelper` 的实际刷新；401 之外的认证错误（如 403）不归为认证失败。
- 没有 Team/Enterprise 账号或托管设置，真实 sec-default 终端里的审批提示未验收；子代理调用的审批在 sec-default 下不提示。
- 已安装 0.3.0 插件的用户是否能通过 `claude plugin update` 拿到新 hook：插件合约版本没有改。
- 终端会话的远程审批仍未开放；Linux 只做了单元与进程测试。
