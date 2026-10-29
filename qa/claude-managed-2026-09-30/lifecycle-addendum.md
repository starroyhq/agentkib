# 原生取消与异常重启验收增量

源码 revision：`057da8b81a3f3c9536a568287175af8e50c12176`，dirty 工作树；本次仅新增验收脚本与增量证据，未修改生产代码。

所有用例使用 Claude Code 2.1.285、显式 `deepseek-v4-pro`、各自独立数据目录和随机端口；每例一个用户 turn，没有重试失败模型调用。全局 settings hash 不变，不覆盖 HOME，不复制凭据。Runtime 二进制 SHA 见各结果文件。

| 用例 | 实际结果 | 范围 |
| --- | --- | --- |
| 等待 AskUserQuestion 时取消 | 通过；idle + lastOutcome=cancelled，问题清空，旧答案返回 not-dispatched，自有 CLI 进程组退出，启动一次 | 验证交互等待中的取消；没有启动第二轮证明后续模型回复 |
| 已收到原生用户输入后 Runtime 异常终止 | 旧证据有覆盖缺口（未记录强杀前状态），不能单独证明强杀导致 unknown；观察到重启 outcome-unknown、sendDisabled，表单为空，原回执 accepted 但 completionObserved=false；只读 reconcile 不解锁，启动一次 | 确认执行结果未知，不将 accepted 当完成。崩溃不能执行 Drop，验收脚本按自己捕获的进程组清理孤立 CLI 后重启；没有声称强杀 Runtime 自带跨进程恢复 |
| 前台 Bash sleep 30 | 未通过；模型工具输入为 command=sleep 30，未包含 run_in_background，但收到 system task_started 后执行器按后台任务拒绝并进入 outcome-unknown | 保留失败，不重跑、不放宽协议。未取得完整 task_started 原始帧，不能断言是 CLI 自动后台化还是门限过严；长命令取消未验收 |

原始目录 `/private/tmp/agentkib-claude-lifecycle-2026-09-30-{cancel,crash,cancel-question}`，结果分别为 `cancel-bash-results.json`、`crash-results.json`、`cancel-question-results.json`。原生日志允许字段汇总见 `lifecycle-native-evidence.json`，其中被中断后无法取得完整计费用量的情况记录为 null。

实际命令（MODE 分别为 cancel、crash、cancel-question，DIR 与上文一一对应）：

```
PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH AGENTKIB_CLAUDE_LIFECYCLE_DIR=$DIR AGENTKIB_CLAUDE_LIFECYCLE_MODE=$MODE pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-lifecycle-real.test.ts
```

取消问题 1/1（5.88 秒），异常重启 1/1（3.72 秒），Bash 0/1（7.89 秒）。新增两个原生脚本的 oxfmt、oxlint 与 desktop `tsc -b --pretty false` 通过。没有启用环境变量时两脚本跳过，不调用模型。

## 前台 Bash 与进程回收修复后增量

本节后续修改了 Runtime 生产代码，不沿用上节“仅新增脚本”的范围说明。根据安装的 Claude Code 2.1.285 原生实现和实际 stdout 帧，只对当前 turn 已见 Bash tool_use_id、`task_type=local_bash`、`is_backgrounded=false` 开放前台任务事件；2.1.263、未知任务、缺失关联和后台升级继续拒绝。完整证据见 `task-started-local-contract.json`、`task-started-analysis.md` 和 Rust fixture。

| 新用例 | 结果及证据 |
| --- | --- |
| 前台 Bash 正常完成 | `complete-fixed` 单轮获得 task_started → task_notification(completed) → result，最终 idle，回复包含仅由命令输出的随机标记；用量见 `foreground-complete-results.json`。最后的旧进程观察函数 `kill(-pgid,0)` 返回 EPERM，Vitest 原失败保留；后续只读精确 PID/PGID 检查无存活进程，见 `foreground-complete-exit-observation.json`。没有重新调用模型。 |
| 前台 Bash 取消（旧进程组清理实现） | `cancel-fixed` 发现 stop 返回 idle/cancelled 后独立 PGID 的 sleep 子进程仍存活，保留失败 `cancel-foreground-leak-results.json`。此结果推动下面的进程树根因修复，不能计为取消通过。 |
| 强化异常重启 | `crash-strengthened` 1/1 通过；强杀前明确 running/revision=5，原生用户输入已落盘；重启 unknown/sendDisabled，旧表单为空；回执 found、requestId、sessionId、operation=send 精确匹配且 completionObserved=false。只读 reconcile 不解锁。证据 `crash-strengthened-results.json`，单次 CLI 启动、单次发送、配置 hash 不变。 |

macOS 进程回收改为直接自有 CLI 的出生身份及后代树：逐父冻结后枚举，封住采集之后继续 fork 的窗口；逐 PID 复核出生时间后终止，等待退出证据。根进程提前退出、枚举/身份/清理失败保持 unknown，不根据命令名或 PID=1 搜索外部进程。冻结和退出确认各最多 2 秒。macOS 没有 pidfd 式原子身份检查加发信号接口，仍明确保留两步间的系统边界，不声称跨进程原子保证或强杀恢复。无原生 interrupt 协议扩展。

stop/release/容量回收/退出均传播清理失败；容量回收和 Drop 在清理开始前保存 unknown fence，成功后保存实际终态。release 使用既有 ledger.dispatch 的持久 fence。失败取消回执不能被旧 send 的完成证据升级为成功。

实际定向检查：`cargo test -p agentkib-platform owned_tree -- --nocapture` 4 通过（detached 子孙清理、外部 sentinel 存活、采集后新增后代、根消失及出生身份不匹配）；`cargo test -p agentkib-runtime cleanup -- --nocapture` 5 通过；`cargo test -p agentkib-runtime failed_cancel_receipt -- --nocapture` 1 通过；`cargo fmt --all -- --check`、`cargo clippy -p agentkib-runtime -p agentkib-platform --all-targets -- -D warnings`、`cargo build -p agentkib-runtime --features dev-app` 均退出 0。独立子代理已二次只读复核进程归属、失败传播和持久 fence，无剩余确定缺陷。

### 进程树修复后的唯一 Bash 取消复验

`/private/tmp/agentkib-claude-lifecycle-2026-09-30-cancel-tree` 使用新 Runtime SHA `7c7512ea06ee732ea98a67ecc9f57d3afbec79104490bf0b9ae577cf2b9cf198`，2026-09-30 06:47 UTC 执行一次 `cancel` 用例，Vitest **1/1 通过（9.96 秒）**。CLI 2.1.285，显式 deepseek-v4-pro，原生 Bash 输入 `sleep 30`；观察到 sleep PID 20871 和匹配的 `task_started`（local_bash、is_backgrounded=false、同 tool_use_id）后才发 stop。最终 idle + lastOutcome=cancelled，精确自有 CLI/PGID 与 sleep PID 无执行中的进程，Runtime 正常退出。仅一次用户发送与一次 CLI 启动，settings hash 不变；中断无完整 result 用量，未虚构用量。

证据 `cancel-tree-results.json`、`cancel-tree-native-frames.jsonl`。该通过只替代旧清理实现的取消缺口，保留所有此前失败记录。长历史、真实手机、后台任务、其他操作系统不因此被标记通过。

实际命令：
```
PATH=/Users/user/Library/pnpm/nodejs/22.23.2/bin:$PATH AGENTKIB_CLAUDE_LIFECYCLE_DIR=/private/tmp/agentkib-claude-lifecycle-2026-09-30-cancel-tree AGENTKIB_CLAUDE_LIFECYCLE_MODE=cancel pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-lifecycle-real.test.ts
```

全量 workspace 随后发现退出观察竞态：libproc 已显示 root 为 zombie，但紧接的一次 `Child::try_wait` 尚无退出状态。已改为在同一 2 秒退出期限内同时确认“所有捕获身份已不执行”和“root 已可回收”，不降低任何退出证明。新增确定性注入首次 reap=false、第二次=true，以及期限到仍不可回收必须失败的回归；平台 owned_tree 现 5/5 通过，platform all-targets Clippy 通过，`git diff --check` 通过。该修改不改变进程身份、冻结或发信号范围，没有重新调用模型；上面的原生取消证据仍对应记录中的二进制 SHA，最终源码较该二进制多此等待竞态修复。
