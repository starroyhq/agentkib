# v15 E 收尾实拍

2026-10-23，真实 Electron 1360×860 窗口，使用四个合成工作区、Claude 历史与两条待审记忆。所有图来自实际应用，没有替换截图内容。完整命令、功能验收和环境限制见 [QA 记录](../../../qa/v15-e-finalize-2026-10-23.md)。初版对比图见 [E 批截图](../v15-e/README.md)。

| 语言 | 首页 | 列表 | 警告概览 |
| --- | --- | --- | --- |
| 简体中文 | [首页](zh-CN-home-daily.png) | [列表](zh-CN-workspaces.png) | [概览](zh-CN-overview-warning.png) |
| 繁体中文 | [首頁](zh-TW-home-daily.png) | [清單](zh-TW-workspaces.png) | [概覽](zh-TW-overview-warning.png) |
| English | [Home](en-US-home-daily.png) | [Workspaces](en-US-workspaces.png) | [Overview](en-US-overview-warning.png) |
| 日本語 | [ホーム](ja-JP-home-daily.png) | [一覧](ja-JP-workspaces.png) | [概要](ja-JP-overview-warning.png) |

| 边界 / 交互 | 截图 |
| --- | --- |
| 诊断证据保留真实大写文件名 | [诊断页](zh-CN-doctor-evidence.png) |
| 正常诊断单行居中 | [正常概览](zh-CN-overview-healthy.png) |
| 零 Agent 资产浅色、无箭头 | [零资产](zh-CN-overview-empty-assets.png) |
| 未读到过的 Antigravity 来源使用灰字 | [工作区会话](zh-CN-workspace-sessions.png) · [统一目录](zh-CN-session-directory.png) |
| 原会话直接打开并关闭跨 Agent 对话框 | [打开](zh-CN-cross-agent-dialog.png) · [关闭后](zh-CN-session-after-close.png) |
| 本地预览成功进入原变更计划，未应用 | [变更计划](zh-CN-cross-agent-plan.png) |
| macOS 的 Finder 菜单 | [更多操作](zh-CN-workspace-menu.png) |

测量见 [JSON](measurements.json)：四语无横向溢出，英文最近工作区的来源行完整；15×15 徽标为实心 `#976500` 配白字，健康诊断文字与图标中心一致。

真实 Claude CLI 在隔离环境可读取版本，但系统 ps 被 Seatbelt 拒绝，原占用守卫保持只读。截图证明对话框入口、关闭后的原会话和本地计划可达；本轮不据此声称真人 CLI 输入/发送可用。输入框与草稿保留有自动化回归。图中绝对路径全部属于脚本生成的合成项目。
