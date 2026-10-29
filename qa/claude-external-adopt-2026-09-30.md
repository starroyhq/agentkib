# Claude 外部原生会话首次接管验收增量

日期：2026-09-30。独立记录，不修改主 QA。

## 范围和环境

工作树 `/Users/user/.codex/worktrees/all-agent-continuation/agentkib`，源码 revision `057da8b81a3f3c9536a568287175af8e50c12176`、dirty。新增 opt-in 测试 `apps/desktop/electron/main/web/claude-managed-external-adopt-real.test.ts`，不修改已有 resume-real 测试。

Claude Code `2.1.285`，模型 `deepseek-v4-pro`。源创建和接管续接各最多一次模型 user turn，单 CLI `--max-budget-usd 0.50`。原 settings 通过路径只读引用，前后 hash 一致，不复制凭据、不修改用户安装、HOME 或 CODEX_HOME。

隔离根目录 `/private/tmp/agentkib-claude-external-adopt-2026-09-30-pro-once`，独立 Claude 配置、工作区、Runtime/Web 数据和随机本机端口。数据保留。源 CLI 使用 `--tools=Read` 限定仅 Read；default 权限、safe-mode、空 setting-sources、strict-mcp-config，未跳过权限。

初始 source/discovery/adopt 时 Runtime SHA256：`864cd5ee26aa2e6dd1e54a242cccd1875d46bf57c8a7e00f895f860624e37830`。
完成原定 Web 续接时 Runtime 已由主任务重建，SHA256：`305718fcf4623cf19ebc32b3091d8453965bcd47dfab7cc2b7c2453d5b6c1bda`。不把分段验收描述为同一二进制全过程一次运行。

## 实际过程及结果

1. 官方 CLI 独立 `--session-id` 创建原生 UUID `ea5a4977-73b4-4c02-a05a-4108cd6678fe`，未调用 AgentKib create。源 turn 使用 Read 读取合成 fixture 并回复随机 marker 和 decision，退出码 0。原生工具记录确有一次 Read。
2. 源进程退出后，真实 Runtime `workspace.add`、`workspace.refreshSessions`，production catalog 发现对应历史；该时刻没有此会话的 claude-managed 元数据。owner 读取历史、inspect 获取指纹、显式确认后 adopt，accepted 且 UUID 不变。
3. 首次 Web send 测试错误地传 `attachmentIds:[]`，宿主附件校验拒绝为 HTTP 400。没有模型派发，CLI 启动计数仍为 1；ledger 只有 adopt，无 send。原测试未捕获此 HTTP 错误 body 和 requestId，不能声称已保存该请求的 not-dispatched 回执。其原因由代码中的空数组 `invalid_attachments` 校验及只读 ledger/启动计数核验。准备失败原结果完整保留。
4. 获得继续授权后修正测试，纯文本省略 attachmentIds。从同一已接管会话使用新 requestId，执行原定尚未派发的 Web turn；不重建源会话、不重发任何模型输入。续接只询问历史中的标记和决策，不提供答案，不调用工具。
5. HTTP 200 accepted，模型完成 idle；原生 JSONL 的原始 23990 字节前缀 SHA 不变。对原前缀之后的新增记录进行独立只读验证：新增 assistant text **1 条**，精确包含原 marker/decision，新增 tool_use **0 条**。不是从全量历史中旧 assistant 回复取得通过。
6. 完整目录只有原 UUID 会话日志，合计原生 user input **2 条**、CLI launch **2 次**、原生 API error **0**。Read 工具 ID/数量未变，无历史工具重放。原 settings hash 不变，Runtime 正常退出 0。

最终结论：**真实官方 CLI 外部会话首次发现、确认接管、按原 UUID 从 Web 续接通过**。中间测试准备失败与分段执行如上保留，不标记原始整文件首次运行通过。

## 用量

- 源创建：input_tokens 1887，cache_read_input_tokens 1792，output_tokens 154。
- Web 续接：input_tokens 20049，cache_read_input_tokens 0，output_tokens 58。

以上为 CLI 原始口径；不按其未知 costBasis 推断实际账单。

## 实际命令

```sh
export PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH
pnpm --filter @agentkib/desktop typecheck
pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-external-adopt-real.test.ts electron/main/web/claude-managed-interaction-real.test.ts
AGENTKIB_CLAUDE_EXTERNAL_ADOPT_DIR=/private/tmp/agentkib-claude-external-adopt-2026-09-30-pro-once pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-external-adopt-real.test.ts
AGENTKIB_CLAUDE_EXTERNAL_ADOPT_CONTINUE=1 AGENTKIB_CLAUDE_EXTERNAL_ADOPT_DIR=/private/tmp/agentkib-claude-external-adopt-2026-09-30-pro-once pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-external-adopt-real.test.ts
```

默认执行跳过，不调用模型。首次显式测试失败（上述空附件准备问题，4.95 秒）；授权的继续执行 **1/1 通过**（3.99 秒）。最终新增助手来源断言通过保留日志只读核验及 TypeScript 检查，没有为强化断言再次调用模型。

日志：`/tmp/claude-external-adopt-real-pro.log`、`/tmp/claude-external-adopt-continue-pro.log`、`/tmp/claude-external-adopt-typecheck.log`。

证据：

- [初始过程及准备失败](claude-external-adopt-2026-09-30/results.json)
- [预派发只读证据](claude-external-adopt-2026-09-30/predispatch-evidence.json)
- [续接成功结果](claude-external-adopt-2026-09-30/continuation-results.json)
- [仅新增助手文本核验](claude-external-adopt-2026-09-30/new-assistant-readonly-verification.json)

本测试覆盖真实 CLI/Runtime/owner 服务及 HTTP Web 边界；配对使用既有 legacy fixture。未宣称真实手机、桌面或浏览器界面点击验收。
