# Claude 桌面 owner / Web 原生交互验收增量

日期：2026-09-30。独立增量记录，不替换主 QA。

## 环境与边界

- 源码 revision：`057da8b81a3f3c9536a568287175af8e50c12176`，工作树 dirty，包含此前全 Agent 互通与 Claude 一期改动；本子任务仅新增 opt-in 验收测试及本增量证据。
- 工作树：`/Users/user/.codex/worktrees/all-agent-continuation/agentkib`。
- Runtime debug SHA256：`864cd5ee26aa2e6dd1e54a242cccd1875d46bf57c8a7e00f895f860624e37830`。
- Claude Code `2.1.285`，显式模型 `deepseek-v4-pro`，max-budget-usd `0.50`。
- 原 settings 仅通过 `--settings /Users/user/.claude/settings.json` 读取，验收前后 SHA 一致；未复制凭据或修改 HOME、CODEX_HOME、用户安装。
- 隔离根目录：`/private/tmp/agentkib-claude-interaction-native-2026-09-30-pro-once`。数据保留，未清理；独立 CLAUDE_CONFIG_DIR、Runtime/Web 数据与工作区、随机本机端口。
- 测试专属约束：隔离工作区 `.claude/settings.local.json` 使用 `permissions.ask=[Write,Edit,Bash]`，CLI 使用 `--permission-mode default --setting-sources local --safe-mode --strict-mcp-config`。此约束只用于可靠触发合成写入审批，不是生产权限配置变更。Runtime 保持自身 stdio 审批协议。
- 真实 CLI、Runtime、WebAccessService.localClaude owner 服务、HTTP Web 入口共同参与。配对凭证由既有 legacy 测试 fixture 授予；不将本测试描述为真实手机、renderer 点击或正式配对 UI 验收。

## 实际命令

在上述工作树，使用 Node 22.23.2 / pnpm 10.8.1：

```sh
export PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH
pnpm --filter @agentkib/desktop typecheck
pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-interaction-real.test.ts
AGENTKIB_CLAUDE_INTERACTION_DIR=/private/tmp/agentkib-claude-interaction-native-2026-09-30-pro-once pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-interaction-real.test.ts
```

默认执行跳过，不会调用模型。显式运行单个测试通过（1/1），总测试耗时 9.26 秒，操作耗时 8.827 秒。目录 `attempt.json` 使用 wx 创建，阻止同目录再次运行。共 1 个 user turn、1 次 AgentKib send、1 次 CLI 启动；原生记录没有 API error。未失败重跑、未更换模型。

## 验收结果

| 项目 | 结果及证据 |
| --- | --- |
| 空会话不调用模型 | 通过，创建并读取空历史时无 CLI 启动记录 |
| owner 与 Web 同会话 | 通过，Web catalog/events 可见相同 sessionId，最终 4 条归一化事件 |
| 真实工具审批 | 通过，真实 Write 请求经 owner 批准，仅允许指定文件路径且内容必须匹配合成 UUID |
| Web 旧审批 | 通过，owner 批准后旧 revision 返回 HTTP 409、stale_state、not-dispatched |
| 真实问题表单 | 通过，CLI AskUserQuestion 产生受支持单选问题，Web 回答 cobalt-lake 后 accepted |
| owner 旧问题 | 通过，Web 回答后 owner 旧 revision 返回 accepted=false、stale_state、not-dispatched |
| 工具实际效果 | 通过，文件内容与随机 UUID 完全匹配；原生 Write 和 AskUserQuestion 均有对应非错误 tool_result |
| 最终回复 | 通过，包含随机 UUID 与 cobalt-lake；本轮终态 idle |
| 用户配置保护 | 通过，原 settings hash 不变；Runtime 正常退出 0 |

用量（CLI 返回值原样统计口径）：input_tokens=20548，cache_read_input_tokens=39680，output_tokens=306，cache_creation_input_tokens=0。未推断账单金额。

结果在 [安全结果 JSON](claude-managed-interaction-2026-09-30/results.json)；原生工具摘要在 [native-tools-summary.json](claude-managed-interaction-2026-09-30/native-tools-summary.json)。摘要只包含合成文件路径、工具标识和合成回答，不含请求凭据。stdout 日志：`/tmp/claude-interaction-real-pro.log`。

实际运行完成后，测试额外加入原生日志 tool_use/tool_result 关联断言；该断言对保留日志进行了独立只读核验（Write 与 AskUserQuestion 各一次、两个非错误结果、一个 user input、零 API error），并通过最终 typecheck。没有为了新增断言再次调用模型。

## 未覆盖

本增量没有测试真实手机、renderer 的点击与跨端弹窗视觉状态、图片、断线取消、重启后继续及原 UUID 接管。它证明真实 owner/Web 服务边界和原生工具语义通过，不能替代其余用例。

后续独立审查收紧了旧 Web 审批断言为 HTTP 409 + stale_state + not-dispatched，核对 HTTP 发送 requestId 及 owner 返回 requestId，并在 finally 验证 settingsUnchanged、成功用例 launchCount=1。Web 预派发错误响应当前不回显 requestId，不强加公共协议字段。既有证据已具备409/error/outcome及单次启动事实；仅修改测试并执行 typecheck，没有重跑交互模型。
