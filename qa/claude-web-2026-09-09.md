# Claude Code Web 接入验收 · 2026-09-09

## 实现与边界

- macOS Claude Code 2.1.263；托管 `--resume=<UUID>`，不接管已有终端。
- 原生 stdio initialize、stream-json、can_use_tool 的 allow/deny；不发送 updatedPermissions，不增加持久规则。
- 按已登记会话映射校验 UUID、真实 cwd 和非 sidechain；父工作区不会替代实际 cwd。
- 只读不启动模型；首次 live 的版本探测仅运行有界 `--version`。未知平台/版本保持只读。
- 每个托管会话串行执行；AgentKib 跨进程文件锁、请求 ID、revision、轮次和审批 ID 检查。
- 有界输出、协议错误禁用控制、自有进程组清理。CLI 之外的同会话终端无法由私有锁约束，使用前须关闭。
- 宿主 Claude-only gate 不启用 Codex；浏览器不能传 provider 绕过资格。

## 真实本机 HTTP 验收：通过

目标 `/Users/kouzen/Documents/data/test` 的 Claude 会话 `3121ec99-e4cb-465b-8056-0d653212b113`。
使用真实 runtime + WebAccessService + 隔离数据库/随机 loopback 端口，完成配对及独立权限授权，通过 `/api/web/v1/send` 和 `/approve` 发送，而非直接 CLI 冒充 Web。

| 测试 | 标记 | 结果 |
| --- | --- | --- |
| 无工具消息 | AK-CLAUDE-WEB-1788941321983 | 回复“收到”，原会话历史读取成功；测试约 8.28 秒 |
| 原生拒绝 | AK-CLAUDE-WEB-1788941378015 | Web 收到 Bash `/usr/bin/true` 审批，提交 deny；Claude 报告未执行，tool_result 为错误拒绝；约 8.50 秒 |
| 原生允许一次 | AK-CLAUDE-WEB-1788941407636 | Web 提交 allow；命令成功，tool_result 非错误，Claude 报告退出码 0；约 7.92 秒 |

每次仅一条低风险消息，无并发提交；临时浏览器撤销、HTTP 关闭、runtime 与其自有 CLI 清理。真实测试默认跳过，必须显式提供指定 UUID 环境变量才能运行。

### 实际发现并处理的问题

1. `command_lifecycle` 被误判未知协议。对照本机内嵌 SDK 核实五类纯通知后精确兼容；通知不改变审批资格或完成状态。
2. Claude 现有配置依赖本机 CC Switch 代理端口 15721，但应用未运行。首次可发送的轮次等候 90 秒未回；检查确认 ECONNREFUSED。启动已安装 CC Switch 后恢复；未修改供应商、模型、密钥或权限配置。此前未完成轮次不自动重放。
3. 审查修复了 cwd 错位、sidechain 身份验证、只读耗尽实例额度、预检错误误标结果不确定、自有子进程清理和 Claude-only 资格投影。

## 自动化验证

- Web 96 项测试、Web 类型检查及构建通过，包含 Claude 原生审批/元数据/四语言和流式内容清空。
- WebAccessService 48 项测试通过，包含原生决定与 Claude-only gate 对 Codex/未知 provider 的拒绝。
- Runtime 68 项测试通过；runner 11 项覆盖原生协议、取消/重复、身份、通知、权限、进程组与锁。
- Conversations 108 项单元测试通过；额外身份验证测试涵盖 UUID、cwd、sidechain 与缺失元数据。
- Desktop 类型检查及 Electron 主进程/preload 构建通过；相关 Clippy 通过。
- Rust 全工作区测试通过；Desktop 全量 646 项通过（真实模型测试默认跳过 1 项）。

## 尚未作为通过项

- 此处真实测试是本机 HTTP 端到端，不是 Chromium UI 或跨设备/正式托管域名验收；软键盘、实际手机与跨设备 LAN 仍待验证。
- 未验证其他 Claude 版本/操作系统；结构化 AskUserQuestion、后台任务与未知权限请求不支持，保持保守失败。
- 不是对官方终端的并发接管方案；不承诺私有锁能排除外部 CLI 写入。
- 无发布、commit、push 或 Cloudflare 部署；线上静态页需后续部署才包含新界面。
