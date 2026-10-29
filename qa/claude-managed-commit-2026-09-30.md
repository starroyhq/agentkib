# Claude 桌面 / Web 提交整理 QA — 2026-09-30

## 来源与提交范围

- 实施来源：`all-agent-continuation/agentkib`，HEAD `057da8b81a3f3c9536a568287175af8e50c12176`，detached / dirty。来源有全 Agent 互通、Codex 和远控等已有改动，不能整体提交。
- 本次提交工作树：`/Users/user/.codex/worktrees/claude-managed-commit/agentkib`；分支 `codex/claude-managed-desktop-web`；从本机已存在的 `origin/main` `b366d18` 创建，创建时 clean。
- 依据本轮 116 文件清单及起始 SHA256 基线提取 Claude 增量：新增文件直接迁移；21 个修改文件的起始内容匹配历史 `9b585d3`，以三方补丁应用；其余 11 个混合文件仅提取 Claude 入口、类型及文档。不复制全 Agent 来源/目标适配、导入 worker 或旧 Codex ledger。
- `claude-managed-2026-09-30-files.json` 保留为来源工作树历史证据，**不是本提交内容的哈希清单**。本提交的实际文件由 Git diff / commit 确定。
- 新主线将 ledger claim 升级为一次性写入设备身份和恢复证据。本轮四条 Claude claim 路径适配该接口，并测试回执丢失后仍保留操作身份、工作区和执行模式，其他设备无法读取。Codex ledger 及其生产实现无改动。
- Web 合并保留主线已有 legacy prepared receipt 行为与 Codex 回归。桌面只增加 Claude 入口，不带入全 Agent 能力/恢复面板。
- 原工作树保持不变；无依赖升级、凭据或安装修改；本次仅创建本地提交，不推送。

## 验证环境与命令

macOS arm64，Node 22.23.2、pnpm 10.8.1、Cargo 1.92.0；`pnpm install --frozen-lockfile` 成功，锁文件无变化。日志目录 `/tmp/agentkib-claude-commit-2026-09-30/`。

Rust 检查使用 `CARGO_TARGET_DIR=/private/tmp/agentkib-claude-commit-target`；前端测试和桌面构建使用新工作树自己的 `target`（宿主脚本按该路径查找二进制）。

| 检查 | 结果与日志 |
| --- | --- |
| `cargo fmt --all --check` | 通过；`fmt.log` |
| `cargo test --workspace` | 952 通过、0 failed、0 ignored；`rust-tests.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过；`clippy.log` |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck` | 退出 0；`format.log`、`lint.log`、`typecheck.log` |
| `pnpm test` | 桌面 898 通过、6 个真实脚本跳过；Web 230 通过；`test.log` |
| `pnpm build` / `pnpm build:web:hosted` | 退出 0；`build.log`、`hosted.log` |
| 脚本测试 | 当前主线 `stage-frpc.test.mjs` 已使用 Vitest；误用 `node --test` 失败后，改用 `pnpm --filter @agentkib/desktop exec vitest run scripts/stage-frpc.test.mjs`，1 通过；`script-tests.log` 保留误调用，`script-tests-corrected.log` 记录正确结果 |

测试数量相对原实施工作树变化来自主线已提交的回归和未迁移的其他 Agent 功能，不能用旧测试数量替代本次结果。Lint 仍有 warnings，构建保留 React Compiler 对部分 try/finally 代码不优化的提示，没有禁用规则。

提交前交叉审查发现宿主重放边界：同请求 ID 的附件/前置校验冲突可能被标为 `not-dispatched`，使两端丢弃原来结果未知的 pending 回执。现已修复：Web managed/control 与 desktop owner 入口在前置校验之前按设备查询原回执；查询失败或已存在同 ID 时保留 unknown，只有匹配请求身份的明确不存在或严格核对原输入后的确定回执才能返回未派发。未知附件冲突保持原引用 pin，拒绝再次发送。独立子代理已只读复核，确认原问题关闭。

最终增量检查：`pnpm format:check`、`pnpm typecheck`、`pnpm lint` 和 `pnpm build` 全部退出 0，见 `format-final.log`、`typecheck-final.log`、`lint-final.log`、`build-final.log`。`pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-host.test.ts electron/main/web/local-claude.test.ts electron/main/web/claude-dispatch.test.ts electron/main/web/service.test.ts electron/main/web/conversation-controls.test.ts`：5 个文件、110 项全部通过，见 `replay-final-tests.log`。

来源保护复核：原工作树 116 个清单文件 SHA256 全部仍匹配，来源 Git index 为空。

## 原生验收证据与边界

[原实施 QA](claude-managed-2026-09-30.md) 保留真实桌面、Web、同 UUID 续接、工具审批/问题、取消和恢复记录。本次提交整理没有再次调用模型或改变用户模型配置，不能把旧工作树二进制的原生记录表述为新基线重新实测。

图片实际字节和 Flash 路由已有证据；蓝色被回答成紫色的断言仍失败，按现有证据与用户澄清归为模型结果，不改断言以取得通过。真实手机仍未验收；Windows/Linux 原生控制门限关闭。本次不创建安装包、不签名、不发布。
