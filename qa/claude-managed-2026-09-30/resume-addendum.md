# 同 UUID 真实续接验收增量

源码 revision：`057da8b81a3f3c9536a568287175af8e50c12176`，dirty 工作树；本次仅新增验收脚本与增量证据，未修改生产代码。

- 模型：显式 `deepseek-v4-pro`，Claude Code `2.1.285`；独立 attempt `/private/tmp/agentkib-claude-resume-2026-09-30-once`。
- 复用之前合成会话的隔离数据。确认原 Runtime 正常退出、原 CLI 进程不存在后，通过 production Web HTTP release → inspect → fingerprint-confirmed adopt。
- 仅一个新用户 turn；新 prompt 未包含答案，模型准确回复旧历史的随机 marker 和项目决策 `cobalt-lake`。
- 首次发送及立即重复 RPC 均 accepted；原 JSONL prefix 不变，仅增加一条匹配的新用户消息，CLI 启动一次，未创建额外原生会话，也未重放工具。
- 首轮 Vitest 在模型完成后的测试证据统计中触发 `JSON.stringify(undefined).includes`，保留失败记录。已修正测试统计，不重跑模型。
- 用独立只读恢复脚本继续剩余验收：原回执确认已完成，再核对精确原请求指纹后重放同 requestId；跨 Runtime 重启后历史恢复、completionObserved=true、重放 accepted、JSONL 完全不变。恢复脚本禁止 native execution，新增模型调用 0。
- 用户全局 settings hash 未变化；没有复制凭据或覆盖 HOME。

执行命令：

```
PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH AGENTKIB_CLAUDE_RESUME_DIR=/private/tmp/agentkib-claude-resume-2026-09-30-once pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-resume-real.test.ts
python3 qa/probes/claude-resume-readonly-recovery.py
```

原始结果：`resume-results.json`；只读恢复补充：`resume-recovery-results.json`。首命令测试统计失败、第二命令退出 0；实际原生同 UUID 续接、历史保留及去重验收通过。
