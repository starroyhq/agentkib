# D 收尾复验截图

真实 macOS Electron，默认原生窗口 1360 × 860 CSS px，屏幕比例 2，VTRON 浅色主题

| 场景 | 截图 |
| --- | --- |
| 112 字符工作区名，来源与路径同排 | [简体中文](zh-CN-skills-long-source.png) |
| 限宽菜单，工作区名保持单行 | [简体中文](zh-CN-skills-long-menu.png)、[日文](ja-JP-skills-long-menu.png) |
| `.agents/skills` 项目技能的可见 Agent、诊断与无错预览 | [简体中文](zh-CN-skills-project-detail.png) |
| 个人技能与两个具名项目关联 | [简体中文](zh-CN-skills-personal-detail.png) |
| Claude 用量缺失时的主提示与具体原因 | [简体中文](zh-CN-usage-error-hierarchy.png) |

四语对应五种状态均已实际渲染并检查，其他三语完整本地截图保存在 `qa/screenshots/v15-d-revalidation/`，遵循仓库忽略 QA PNG 的现有约定。实测见 [computed-style.json](computed-style.json)，过程、测试结果及覆盖限制见 [QA 记录](../../../qa/v15-d-revalidation-2026-10-23.md)

截图前使用合成个人技能、两个合成工作区和合成历史，经生产接口登记并由真实后端读取，没有替换 IPC 响应。所有 `~/…` 和 `/private/tmp/agentkib-v15-d-finalize-d-revalidation/…` 均为合成沙盒路径。截图未登录、未连接服务，已核验没有真实用户名、账号或凭据

本次使用既有 Seatbelt 启动器，仅允许回环网络，隔离 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、应用数据与应用用户目录；不读取真实 Agent 配置。详细隔离边界以探针源码为准，不将外层 Seatbelt 误称为 Chromium 渲染器沙盒

覆盖默认窗口和 VTRON 浅色；未在本轮重新验收其他主题、窄窗口、Windows 或真实 CLI。交互与无障碍完整名称另有自动化和真实窗口 DOM 检查，不能单凭截图证明
