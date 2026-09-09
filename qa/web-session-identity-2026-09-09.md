# Web 会话标识精简验收

- 桌面与 Web 共用 `packages/agent-identity` 的原有 SVG 资产、名称和主题适配，保留 NOTICE。
- Web 列表改为图标＋单行标题；UUID 仅出现在明确标注的详情中。未知 Agent 使用 Bot 图标与原名称兜底。
- Web Vitest：99 项通过；桌面 AgentIcon：3 项通过。
- Web build（含 typecheck）、桌面 typecheck、桌面 build:web、git diff --check 通过。
- Safari 本机 1421：已观察宽屏浅色/深色列表；响应式模式 390×844 的列表和已选会话标题栏正常。该模式不代表真实手机验证。
- 搜索、选择、返回、详情标签由自动化组件测试覆盖。原生 Safari 键盘焦点完整流程、真实手机触控未完成手动验收。
- 未发送消息、未提交审批、未调整授权；未提交或部署。
