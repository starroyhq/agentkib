# v15 E 合成数据截图

2026-10-23，正式 Electron 窗口内容尺寸 1360×860。全部项目、路径与会话为合成数据；截图来自实际窗口，无后期内容替换。实施、交互、验证结果及限制见 [QA 记录](../../../qa/v15-e-home-workspaces-2026-10-23.md)。

| 页面 / 交互 | 截图 |
| --- | --- |
| 新用户首页 | [zh-CN](zh-CN-home-new-user.png) |
| 发现 4 个工作区后的引导 | [zh-CN](zh-CN-home-onboarding.png) |
| 日常首页：1 个配置问题 + 2 条待审记忆 | [zh-CN](zh-CN-home-daily.png) |
| 工作区列表：同一状态口径 | [zh-CN](zh-CN-workspaces.png) |
| 警告概览 | [zh-CN](zh-CN-overview-warning.png) |
| 正常概览 | [zh-CN](zh-CN-overview-healthy.png) |
| 工作区侧栏会话列表 | [zh-CN](zh-CN-workspace-sessions.png) |
| 会话更多菜单打开原跨 Agent 对话框 | [zh-CN](zh-CN-cross-agent.png) |
| 列表更多菜单 | [zh-CN](zh-CN-workspace-menu.png) |
| 忽略合成工作区的确认 | [zh-CN](zh-CN-ignore-confirm.png) |
| 繁体中文首页 / 列表 | [首页](zh-TW-home-daily.png) · [列表](zh-TW-workspaces.png) |
| 英文首页 / 列表 | [首页](en-US-home-daily.png) · [列表](en-US-workspaces.png) |
| 日文首页 / 列表 | [首页](ja-JP-home-daily.png) · [列表](ja-JP-workspaces.png) |

待处理颜色、摘要计数与主按钮数量见 [首页测量](measurements.json)，三语视口与列表边界见 [布局测量](locale-measurements.json)。

概览/侧栏中的来源不可用提示来自已安装 Antigravity 的真实读取失败；未安装来源未被当作异常。跨 Agent 截图证明入口可达，未执行模型请求或真正交接。当前沙盒没有 Claude CLI，因此统一会话页保留只读守卫，实际 CLI 发送未实测。
