# 审批记录与自动允许规则

桌面入口在「设置 → 会话 → 安全与审批」。桌面和配对设备通过同一主机接口读取数据。本机存储独立于会话历史。未经过 AgentKib 的原生决定没有记录。

## 配对设备接口

`GET /api/web/v1/access` 对已配对设备新增两个可选能力字段。主机返回 `approvalAuditVersion: 1` 时可读取审批记录，返回 `approvalRulesVersion: 1` 时可读取自动允许规则。旧主机省略这些字段，客户端可据此禁用对应入口。旧客户端的配对、审批和提问接口仍沿用原协议。

| 方法和路径                               | 输入与响应                                                                                                                                                            |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/web/v1/approval-audit`         | 可选 `limit` 为 1–100，默认 30。可选 `before` 填上一页的 `nextCursor`。返回 `{ entries, nextCursor? }`，从最近的决定开始。                                            |
| `GET /api/web/v1/approval-rules`         | 不带查询参数时列全局规则，需要完全访问。带 `workspaceId` 时列该工作区的规则。返回 `{ providers, rules }`。                                                            |
| `POST /api/web/v1/approval-rules/revoke` | 用户明确确认后提交 `{ agent, ruleId, workspaceId? }`。沿用协议 2 和 CSRF 校验，仅限完全访问设备。成功返回 `{ revoked: true }`。遇到规则过期应刷新列表，再由用户决定。 |

主机用当前配对授权和已注册工作区过滤记录，再做分页。分页令牌只标记位置，每次读取都重新核对授权。规则响应中的 `providers` 给出各 Provider 的原生读写能力，`rules[].revocable` 还包含当前设备和该条来源的限制。

## 记录字段

每条记录包含会话 ID、Agent、可解析的工作区 ID、审批或提问类型、脱敏摘要、风险、决定类型与作用域、来源、时间和结果。一次决定的同设备回执重放不会重复记账。原生响应无法确认时标为 `unknown`，已获确认的拒绝标为 `denied`，已失效的请求标为 `expired`。`executed` 表示原生端已接收并确认该决定，后续工具运行结果需在会话里查看。

来源包括桌面、配对 Web、手机和项目 Agent。带手机绑定的配对被识别为手机。手机也可在决定请求上发送 `X-AgentKib-Client: mobile` 标记其界面来源，设备身份仍来自已有配对凭据。其余配对来源记为 Web。记录留在电脑上，最多 1,000 条。摘要由结构化风险原因生成。日志不保存命令、参数、回答、输出、文件内容和明文绝对路径。

## 原生自动允许规则

| Provider         | 已确认的来源                                                          | 列出 | 撤销                                                 |
| ---------------- | --------------------------------------------------------------------- | ---- | ---------------------------------------------------- |
| Claude Code      | 用户、项目和本地项目设置中的 `permissions.allow`，以及受管设置        | 支持 | 用户和项目中可安全定位的 JSON 数组支持，受管设置只读 |
| Codex            | `rules/*.rules` 中可静态识别的 `prefix_rule(..., decision = "allow")` | 支持 | 只读                                                 |
| DeepSeek Harness | 桥接和原生审批提供一次性许可                                          | —    | —                                                    |
| Devin            | 用户和项目配置中的 JSONC `permissions.allow`                          | 支持 | 只读                                                 |
| Antigravity      | 公开记录的 CLI 全局 `permissions.allow`                               | 支持 | 只读                                                 |

来源随每条规则返回。多处规则仍可能匹配同一请求，撤销只针对选中的设置项。主机从规则 ID 重新定位并校验当前文件，写前备份到应用数据目录，写后读回确认。验证失败时按备份回退。已知格式目前不提供最后使用时间。临时会话许可和无法可靠读取的原生格式不显示。

原生格式可查阅 [Claude Code 设置](https://code.claude.com/docs/en/settings)、[Codex 规则](https://learn.chatgpt.com/docs/agent-configuration/rules)、[Devin 权限](https://docs.devin.ai/cli/reference/permissions)、[Antigravity CLI 权限](https://antigravity.google/docs/permissions/?tab=cli) 和 [DSH 一次性审批](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/interaction/user-approval/README.md)。
