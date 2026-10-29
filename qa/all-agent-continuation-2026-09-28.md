# 全 Agent 互通增量验收：2026-09-28

## 源码与约束

工作树 `/Users/user/.codex/worktrees/all-agent-continuation/agentkib`，revision `057da8b81a3f3c9536a568287175af8e50c12176`，dirty。保留初始复制的全部用户改动；本日开始快照 `/tmp/agentkib-interop-2026-09-28/files.json`，最初基线 `/tmp/agentkib-all-agent-baseline/files.json`。未提交、推送、发布、升级用户 Agent 或迁移凭据。

[本日增量文件清单](all-agent-continuation-2026-09-28-files.json)按本日开始时的实际文件 SHA 比较；[全批清单](all-agent-continuation-2026-09-27-files.json)按最初复制的 dirty 基线比较，均排除清单自身。不能用相对 HEAD 的全部 diff 归因本次改动；基线文件缺失数为 0。

本轮修复质量门槛、增加真实解析矩阵、推进原生 UI/重启/真实回复；不能据此宣称整个计划完成。无需沿用旧 QA 的检查结果来证明本轮通过。

## 实际验证

Node 22.23.2 / pnpm 10.8.1 / cargo 1.92.0。下表本次整合日志在 `/tmp/agentkib-interop-2026-09-28/`；前端质量修复单独日志见[专项记录](quality-gates-2026-09-28.md)。

| 命令                                                    | 实际结果                                                                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --all -- --check`                            | 通过，`fmt-final.log`                                                                                                 |
| `cargo test --workspace`                                | 43 个结果段共 958 passed / 0 failed / 6 ignored，`workspace-tests-final.log`；包含显式 ignored 的真实验收载荷导出测试 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过，`clippy-final.log`                                                                                              |
| `pnpm --filter @agentkib/desktop test`                  | Node 测试 1/1；Vitest 830 passed / 1 既有 skipped，质量修复专项日志                                                   |
| `pnpm test:web`                                         | 22 文件 / 203 测试通过，`web-final.log`                                                                               |
| `pnpm format:check`、`pnpm lint`、`pnpm typecheck`      | 最终整合复核全部通过，既有 lint / 路由循环依赖 warning 保留，`frontend-{format,lint,typecheck}-final.log`             |
| `pnpm build`                                            | 桌面 renderer、Electron main/preload 构建通过，`build-final.log`                                                      |
| `pnpm build:web:hosted`                                 | 通过，`hosted-final.log`                                                                                              |

独立子代理审查质量修复与验收脚本，发现 Claude probe 在 `exit` 先于 stdout 关闭时会丢失回执。已改等待 `close`，超限停止积累并记录失败；无模型 fork 延迟输出和 3MB 输出用例复验通过。证据 `/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/agentkib-qa-probe-review-e1gzhoab/`。生产质量修复未发现其他确定回归。

## 新版 OpenClaw 来源到 Claude 的真实回复

生产来源解析及目标 renderer 生成合成原生记录，经隔离 `CLAUDE_CONFIG_DIR` 导入。Claude 2.1.282 通过原 settings 文件引用使用已有登录；没有复制凭据。`--safe-mode --setting-sources '' --strict-mcp-config --tools '' --permission-mode plan --max-turns 1 --max-budget-usd 0.50` 限制工具、扩展和轮次。

```sh
node qa/probes/claude-native-reply.mjs \
  /tmp/agentkib-live-matrix-2026-09-28/manifest.json \
  /private/tmp/agentkib-interop-2026-09-28/claude-reply-1 \
  /Users/user/.claude/settings.json /Users/user/.local/bin/claude
```

仅一轮，模型 `claude-sonnet-5`，输入 4322 / 输出 446 tokens，报告费用 USD 0.013104。回复准确包含历史中的随机 marker `bcfda855-8982-4e6d-926f-4a9c134811d5` 及决策 namespace `56c7e90f-d85f-4c94-aeec-2f83d5884ed1`。问句没有包含这两个值。原探针 `decision_present` 按完整自然语言句子比较为 false，因为模型改变了标签措辞；不改写该回执为 true，决策 UUID 精确一致单独记为人工语义核验。

目标原生 TUI 恢复可见导入历史及回复；两个全新 AgentKib Runtime 进程重新扫描同一隔离目录，均获得同一 conversation ID、5 个事件及上述两个值，目标文件 SHA 不变。结果分别 `claude-reply-1/results.json`、`runtime-restart.json`，原生 TUI 记录见[矩阵 QA](interop-matrix-2026-09-28.md)。

边界：首个 case 的源临时 DB 已在生成 fixture 后清理，SHA 核验只覆盖逐字节快照，不冒充原 DB 在模型调用后仍保留；后续 fixture 已保留实际原文件。该实验未从 AgentKib 预览/Changes UI 执行完整交接操作，因此暂不标记完整方向通过。其他六来源已产出带随机标记的真实解析载荷，未发模型请求。

## 免费模型验收

用户明确原 moka 凭据已失效，后续使用官方免费模型。未使用该凭据，也未自动切换收费模型。

官方 [Zen 文档](https://opencode.ai/docs/zen) 标记 Big Pickle 免费；固定 OpenCode 1.18.32 在全新 HOME/XDG、无用户凭据时，`opencode models opencode` 返回 `opencode/big-pickle` 等免费模型。源码该版本的 provider 为无 key 的免费模型使用公开 `public` 标记。

```sh
node qa/probes/opencode-native-free.mjs \
  /tmp/agentkib-opencode-free-rendered-2026-09-28/openclaw \
  /tmp/agentkib-interop-2026-09-28/opencode-free-reply-fixed-probe \
  /tmp/agentkib-interop-tools/opencode/node_modules/opencode-darwin-arm64/bin/opencode
```

生产载荷 → 官方导入 → 精确回读通过。一次上游请求返回 HTTP 403 / `FreeTierError`：`OpenCode's free tier can only be used from within OpenCode`。没有真实回复、没有工具调用，原始源 DB、快照及导入历史未变。请求由真实 CLI 经本地单请求限额转发器发出，原 headers 转发，不伪造客户端；自定义 baseURL 可能影响官方客户端识别，因此本结果仅证明这一受测路径失败，不能推断官方 CLI 直连也不可用。未重试上游或切换模型。

第一次探针误以为用户消息必定在请求末尾，本地拒绝了请求（forwarded=0），没有模型网络调用。修正为查找用户消息后使用新隔离目录执行以上唯一上游请求；保留两次回执，不把本地探针错误当产品失败。

Hermes 0.21.5 与 OpenClaw 2026.9.6 各通过真实原生恢复向同一官方免费模型发起一次请求，也均返回 HTTP 403 / `FreeTierError`。没有伪造 OpenCode 身份、换模型或自动重试；没有真实回复。两例的源 SHA、已导入历史及唯一目标身份保持不变，工具调用为 0。供应商未返回 usage，不能以本地默认 0 冒充供应商用量报告。具体隔离配置、命令及失败证据见[免费模型专项 QA](free-model-native-2026-09-28.md)。

## 其余证据与未完成项

- [40 组合及 TUI QA](interop-matrix-2026-09-28.md)：8 真实来源 × 5 转换器；OpenCode/Hermes 生产转换载荷经官方导入，两次独立 TUI 恢复、全文回读、源文件保护通过。40 格式组合不等于 40 次真实模型验收。
- [Cursor QA](cursor-interop-2026-09-28.md)：当前 3.22.7 官方批量导入及原生普通窗口重启可读；运行中同工作区窗口导致 0/0，普通窗口精确 ID 恢复契约未建立；保持目标关闭。
- [Codex 隔离 QA](codex-native-isolation-2026-09-28.md)：本机已登录，不能笼统写作缺登录。CLI 0.155.1 与现有 0.146 写入门限不匹配，且认证/rollout 存储隔离尚未建立。
- Grok Build 权威日志写入契约、Antigravity 外来历史导入仍受前轮实测限制；没有用上下文文件冒充原生互通。
- 全部已实现方向的完整交接 UI、目标及 AgentKib 重启、真实单轮回复尚未逐方向完成。Windows/Linux 实机、签名公证、正式更新不在本机验收通过范围。
