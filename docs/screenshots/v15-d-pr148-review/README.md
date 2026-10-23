# PR #148 独立复核画面

所有画面来自 macOS 真实 Electron 生产构建，逻辑窗口 1360×860，仅使用隔离合成 HOME、Agent 配置、应用数据、技能和会话；OS Seatbelt 的 TCP/IP 仅允许 loopback，另允许本机 Unix socket，拒绝脚本列明的个人配置/资料目录、Keychain 文件及 securityd 服务访问，不替换 IPC 或读取结果。启动使用外层 Seatbelt 和 `--no-sandbox`，本次未验证 Chromium renderer sandbox

- `zh-CN-native-visibility.png`：共享 `.agents/skills` 的正常 Agent 保留可见，Hermes 和 OpenClaw 加载异常单独显示四语短原因
- `zh-CN-menu.png`：普通工作区名称保持单行
- `zh-CN-long-menu.png`：194 字符合成工作区名称，菜单受视口约束，单行省略；完整名称保留在无障碍标签和 title，实际点击打开正确工作区
- `zh-CN-claude-usage.png`：缺失本机统计文件的可读原因，原始错误在折叠详情内，重试保留
- `zh-CN-pending-memory.png`：待审记忆计数恢复注意色；批准后实际恢复灰字
- `ja-JP-control-none.png`：日文不支持控制的分隔点
- `measurements.json`：四语实际布局、等待动画完成的菜单尺寸、待审与批准后文字颜色和原始详情保留结果

完整四语的原生技能、长菜单、用量及控制不支持画面共 16 张保存在本地忽略目录 `qa/screenshots/v15-d-pr148-review/`。公开画面及记录不包含真实用户名、凭据、私人路径或局域网地址

复现工具沿用 `qa/probes/v15-d-finalize-sandbox.mjs`：使用新隔离 root 并显式传入已有 Electron 二进制，依次 prepare、seed 和 launch-config；补充场景在隔离项目中增加最小有效 manifest，通过生产 `memories.propose` 创建待审记忆，通过 `backend.planWorkspace`、`backend.inspectWorkspaces`、`workspace.add` 加入长名称的合成目录。没有直接写数据库或替换前端状态

本次未重新测最小原生窗口；当前 Electron CDP 不支持 `Browser.getWindowForTarget`，没有以 viewport 模拟冒充系统窗口。之前 D 收尾的最小窗口记录仍仅作为之前构建的证据。未登录、运行模型或工具，也未覆盖 Windows/Linux、真手机及公开 relay
