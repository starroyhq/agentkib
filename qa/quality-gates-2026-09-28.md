# 2026-09-28 本地质量门槛修复

## 源码与范围

- 工作树：`/Users/user/.codex/worktrees/all-agent-continuation/agentkib`。
- revision：`057da8b81a3f3c9536a568287175af8e50c12176`，dirty；保留前轮互通实现及所有原有改动。本记录只覆盖本批门槛修复，不代表全部互通方向已完成原生验收。
- Node：`22.23.2`（`/Users/user/Library/pnpm/nodejs/22.23.2/bin`），pnpm：`10.8.1`。
- 未修改依赖及锁文件，未提交、推送或发布。

## 修改

1. `codex_managed/completion.rs`、`state.rs`、`transport.rs`、`codex_managed.rs`：等价合并条件、使用 `then_some`、将帧读取循环改为 `while let`，解决已有 8 条 Clippy 诊断；保留失败退出、回执及状态转换语义。
2. `RemoteConnectionPanel.tsx`、`WebAccessSettings.tsx`：原生 details/textarea 换为现有 Collapsible/Textarea；保留面板挂载、草稿及管理按钮展开后聚焦行为。测试以 `aria-expanded` 和可见性验证行为，并补充折叠/展开后多行目录草稿不变且尚未提交。
3. `apps/desktop/vite.config.ts`、`package.json`：Vitest 收集 src/electron 下的标准 test/spec 文件；scripts 下的 Node 测试通过 `node --test scripts/*.test.mjs` 作为同一 `test` 命令的独立步骤运行。现存脚本测试仅 `stage-frpc.test.mjs`，没有移除断言或跳过执行。最终收集清单为 99 个 Vitest 文件。
4. `apps/web/src/features/catalog/catalog-copy.ts`、`session-details-dialog.tsx`：仅项目 oxfmt 格式修正。

## 实际验证

日志均位于 `/tmp/agentkib-quality-*.log`。

| 命令                                                                                             | 结果                                                                                                    | 日志              |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | ----------------- |
| `pnpm --filter @agentkib/desktop test`                                                           | 通过。Runtime dev 构建成功；Node 测试 1/1；Vitest 98 文件通过、1 个既有跳过，830 测试通过、1 个既有跳过 | `desktop.log`     |
| `pnpm --filter @agentkib/desktop exec vitest run src/features/remote/WebAccessSettings.test.tsx` | 通过，20/20，含新增折叠/展开草稿检查                                                                    | `webaccess.log`   |
| `pnpm --filter @agentkib/desktop exec vitest list --filesOnly`                                   | 99 文件；Node 脚本没有混入 Vitest                                                                       | `collection.log`  |
| `cargo test -p agentkib-runtime codex_managed -- --test-threads=1`                               | 通过，34/34                                                                                             | `codex-tests.log` |
| `pnpm format:check`                                                                              | 通过，388 文件                                                                                          | `format.log`      |
| `pnpm typecheck`                                                                                 | Desktop 与 Web 均通过；路由生成有既有循环依赖 warning                                                   | `typecheck.log`   |
| `pnpm lint`                                                                                      | 退出码 0，有既有 warning                                                                                | `lint.log`        |
| `git diff --check`                                                                               | 通过                                                                                                    | 终端输出          |

第一次定向前端检查发现新增 matcher 缺少 jest-dom 注册，已补现有 `@testing-library/jest-dom/vitest` 导入后通过，没有新增依赖。

全仓 Clippy/Rustfmt 曾遇到并行中的来源×目标矩阵代码尚未完整落盘、helper 放在 test module 后方及格式未整理；这些中途结果不能视为最终通过。最终整合后的结果追加如下。

最终整合：`cargo fmt --all -- --check`、`cargo test --workspace`（958 passed / 6 ignored）、`cargo clippy --workspace --all-targets -- -D warnings` 通过；Web 203 测试、桌面构建及 hosted 构建通过。日志 `/tmp/agentkib-interop-2026-09-28/*-final.log`，详情见[增量 QA](all-agent-continuation-2026-09-28.md)。独立子代理审查上述生产变更未发现确定回归。
