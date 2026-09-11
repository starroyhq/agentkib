# 发布前 Web 修复验收摘要

## 修改范围

- Claude CLI 使用平台统一搜索规则解析路径，并以同一路径验证版本和启动；不修改全局 PATH，不跳过版本门槛。
- Web 区分安装验证失败、原客户端未打开、平台或 Agent 不支持及未知原因，不显示原始内部错误。
- 审批框固定标题和决定区，长正文独立滚动；上下文说明与完整 JSON 纵向展示。关闭只收起，不代表拒绝。
- Claude 索引命中时合并已发现 transcript 的文件修改时间，与索引及 history 取最新有效值；失败保留原时间，不新增正文扫描。
- 四语言工具详情明确为摘要；空内容提示历史未提供输入与输出，非空内容及截断提示保留。

没有新增 API、协议字段、数据库迁移、权限、停止能力或完整工具输入/输出读取能力。

## 自动验证

- `cargo test -p agentkib-conversations -p agentkib-runtime`：conversations 109 单测、4 集成测试；runtime 88 测试通过。
- `cargo clippy -p agentkib-conversations -p agentkib-runtime --all-targets -- -D warnings`：通过。
- `pnpm test`：桌面 673 通过、1 默认跳过；Web 161 通过。最终 Web 测试重复运行通过。
- `pnpm typecheck`、`pnpm format:check`、`cargo fmt --all -- --check`、`git diff --check`：通过。
- `pnpm --filter @agentkib/desktop build:electron`：通过，含协议生成、release runtime、桌面及内置 Web 构建；生成绑定无新增差异。
- 以更新后的 `origin/main` merge-base `70ffce26b68dbbf1033e44542ac57d822999627e` 审查完整源码差异与新增文件，未发现确定可操作的新缺陷。

## 本机候选包验证

- 独立未签名 macOS arm64 候选包通过 Finder 启动，runtime PATH 仅含系统目录时仍能定位已验证的 Claude CLI。
- 使用候选包内置的本机 Web 完成配对、历史和工具摘要读取。没有以正式域名未部署的页面代替新界面验收。
- 既有测试会话串行请求一次 `/usr/bin/true` 正常审批。审批自动出现，关闭后可恢复；Tab 可达正文与决定按钮。提交一次拒绝后，工具未执行，状态恢复空闲，没有重试。
- 桌面会话索引刷新后，Web 目录更新时间与 transcript mtime 一致，创建时间、标题和会话身份保持不变。工作区发现刷新与会话索引刷新不是同一操作。
- 独立浏览器加载候选包静态资源，模拟 80 行长审批上下文，在 390×844、768×1024、1440×920 的明暗主题下检查：标题、关闭和决定按钮可见，完整正文可滚动，键盘可达。模拟接口不向实际 Agent 提交。
- 撤销临时授权后真实网页清空内容；临时服务及测试浏览器已关闭，恢复原安装版，未覆盖安装应用。

## 验收限制

响应式检查不等于真实手机验收。跨设备、Windows、Safari、其他 Agent 版本及 Codex 无 owner 时的控制未通过真实验证；无 owner 时仍禁用控制。本轮没有再次验证允许决定，之前候选包的低风险允许测试通过，但不将其写作本轮新包的通过项。

未发布桌面版本或部署正式域名。个人路径、会话标识和现场完整记录保留在本地，不纳入此公开摘要。
