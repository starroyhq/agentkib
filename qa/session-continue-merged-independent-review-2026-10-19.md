# 合并后会话无感续接与 Codex 压缩记录：独立复审

日期：2026-10-19。用户要求使用 code-review 再独立审查合并后的实现，发现问题继续修复、补测试和验证，更新 QA，直到 no finding；不提交、不推送。

审查与验证完成后，用户另行授权将本轮修复、测试、文档及 QA 作一次本地提交，不推送。

## 固定范围与方法

- 固定起点 `bae578ef1eeabcf16bd34d1cb2ede9abb3fb7fa2`，审查开始时 HEAD 为 `ebe3bd3d5dbd539ce518e72c4e1a7e45893861e6`，累计 168 个文件。
- 固定命令 `git diff bae578ef1...HEAD`，提交列表 `git log bae578ef1..HEAD --oneline`。包含 `f762c7772`、`06b678020`、`683b0a427`、`ac3f8decb` 四阶段，压缩分支 `33fb8d1d3`、审查修复 `07bd4510b` 及合并 `ebe3bd3d5`。本轮修复另以 `git diff HEAD` 纳入最终复审，不通过提交改变审查起点。
- 使用 `code-review` 技能，Standards 与 Spec 由两位全新代理独立审查，另有全新运行时审查代理；主代理单独追踪压缩头、分页、文档、全文索引与 worker 入口。没有沿用上一轮 no finding 作为本轮证据。
- 规范：`AGENTS.md`、`CONTRIBUTING.md`、`docs/DEVELOPMENT.md`、`docs/development/ui-terminology.md`；规格：本机实施说明、技术前提、设计计划第 8 节及来源压缩提交的功能范围。仓库不使用 issue tracker。
- 用户已确认的覆盖决定继续有效：Web 仅提供复制续接命令与主机说明；Codex 最后订阅者离开时等当前轮次完成后释放。锁、指纹、版本、平台、权限、未知回执保护保留，跨 Agent 继续及 `handoff.*` 不改，follower 不删除、不接回主路由。
- 原有 `.agents/`、`prototypes/`、两份未跟踪实施/技术文档与设计文件保留。
- 额外按固定起点比较四语 JSON 的跨 Agent 键：每种语言 132 个 `handoff.*`、`sessions.*Handoff`、`sessions.continuation.*` 与 `sessions.continueWorkspace` 键值均未变化；follower 模块及跨 Agent 的 `SessionHandoffDialog`、`session-handoff-targets` 文件未变。

## 初轮发现及修复

### Spec：遗漏使用文档同步

实施说明 §3.5 明确列出也需同步的使用文档；原先仅更新术语表，其他文档仍指导用户寻找已删除的“执行管理”、勾选确认和手工交接，并把 Codex follower 描述为当前主流程。

- 同步 `docs/sessions/conversations.md`、`docs/agents/claude-code-managed.md`、`docs/remote/phone-access.md`、`docs/agents/claude-code-terminal.md` 及其直接链接的 `docs/agents/codex-managed.md`。
- 按真实实现说明直接发送、外部占用选择、自动结束与重启、连接终端入口、压缩历史读取及缓存边界；保留平台/版本/能力、原生占用和未知回执限制，不扩展跨 Agent 功能。
- 旧 follower 的保留代码与历史说明明确标为不接入主流程，没有删除模块或相关测试。没有给文档变更增加只复述文字的测试。

### 运行时：回收时在释放租约后写回旧状态

独立探针确认 `#retireIdleRunners` 原先先调用 `#closeManagedRunner` 释放 managed lease，再读取记录并写 `released=true/status=idle`。另一运行实例可能在租约转移后已续接为 running，旧回收者仍覆盖其新状态；`persistManagedSnapshot` 会拒绝已释放记录，导致新 runner 的后续事件持久化失败。显式 release 的相邻路径也需核对同一边界。

- 复现先使用 `/tmp` 隔离测试和真实 lease，在释放后立即让第二实例持有租约并写入新 running 记录，确认旧回收者覆盖它。正式回归保留真实 lease，只在释放边界注入另一个持有者，验证转交时的记录及转交后不覆盖继任者。
- 自动回收和显式 release 改为实际进程关闭后、仍持有 lease 时同步落盘，再删除本代 runner 并转交租约；启动失败的 create/adopt/resume/fork 同样在持锁边界完成状态更新，迟到 catch 不得覆盖已转交后的新代记录。
- 取消归档的临时 app-server 不在真实 close 通知时提前释放 lease，而在记录及命令回执完成后释放；关闭失败保留到真实 close。未改请求身份、派发判断、unknown fencing 或原 test/hook 超时预算。
- 新增 10 条：idle/leave/release 各一条，create/adopt/resume/fork 派发前失败各一条，unarchive 成功与关闭失败各一条，以及 shutdown 已转交 lease 后旧启动延迟收尾一条。其中 9 条在旧实现均能复现失败，unarchive 关闭失败用例为原本通过的保护；没有把已绿防退化用例写成先红。自动续接由 38 条增至 48 条。

### Standards：QA 中的真实本机路径

独立增量复审指出 QA 写入了带个人目录的技能路径，不符合 `CONTRIBUTING.md` 的隐私要求。新记录改为技能名称；同时去除本轮范围内两份既有 QA 中的相同个人路径，保留 worktree 名、分支、SHA 和验证证据，不改用户未跟踪文档。

## 本轮修改清单

- `packages/backend/src/web-read.ts`：修复租约转交前的持久化顺序、启动失败及迟到收尾的代际保护、取消归档的临时进程释放边界。桌面与 Web 使用同一后端，没有新增 UI 或文案，四语保持现状。
- `apps/desktop/test/codex-auto-continue.test.ts`：新增 10 条竞态及关闭失败回归，保留原 38 条和所有超时、安全断言。
- 上述 5 份使用文档：补齐当前同 Agent 流程、平台/版本/能力及压缩读取说明。
- `qa/session-continue-independent-review-2026-10-19.md`、`qa/session-continue-zst-merge-validation-2026-10-19.md`：只去除个人路径并从合并记录链接本次复审，保留历史结果。
- 本记录：固定范围、发现、复现、修复、独立复审、验证与实机限制。

## 规格差异与保留限制

- 实施说明 §1.4 的“新建会话从一开始就在 AgentKib 中运行”与 Claude 创建只预留身份、不启动进程的行为存在字面差异。继续按真实进程显示状态，未把没有 worker 的会话伪装成运行中；本轮不改变创建和模型请求语义。
- 已连接 Claude 终端的生产插件仍保留 `SEND_CONTRACT_EXPERIMENT=false`：原生 `prompt.submit` 没有已验证的原子空闲门禁，生产发送能力保持关闭。连接状态不代表可发送；终端审批/问题仍在终端处理。没有为了符合界面规格而放宽内部能力校验。
- 本轮不新增真实 CLI、Windows 或手机人工验收证据。原技术前提的 8 项产品验收仍按各阶段 QA 区分；真实模型往返、实际闲置回收、外部终端冲突、跨客户端写锁、Windows/Linux 和实体手机流程尚未由本轮完整手工验证。

## 最终复审与验证

- **Standards：no finding。** 未参与修复的独立代理复核本轮 `git diff HEAD` 的持 lease finalizer、代际守卫、并发关闭、迟到 startup catch、unarchive 释放和失败 fence；个人路径规范问题已修复，无未解决硬规范问题或需阻断的 smell。
- **Spec：no finding。** 未参与修复的另一代理独立核对相同冻结增量；原生占用、unknown、派发检查及分支原会话边界未放宽，文档遗漏已补齐，未回退 follower。两轴均为代码及测试设计复审，不将主代理测试结果冒充审查代理亲自执行。
- 压缩读取与历史补充组合本轮重新执行：8 个文件、260 条全部通过，49.69 秒，覆盖压缩头/分页/cache、历史分页、分类缓存及全文索引 source/worker/runtime/lifecycle。
- 修复作者冻结前定向组合：5 个文件、97 条全部通过，含自动续接 48 条、原生派发、版本、managed lease 和压缩期间控制保护；backend typecheck、两文件局部 lint/format/diff 检查通过。作者写过补丁，不把此处验证当作独立审查。
- 主代理冻结后 `backend:build`、全项目 `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 已通过；lint 0 错误、275 条既有警告，格式检查匹配 963 个文件；根脚本未覆盖的后端测试文件另行 lint 与 format 检查通过。
- 主代理冻结后完整桌面组合：76 个文件、1646 条通过、1 条按原配置跳过，231.95 秒。保留原 76 文件的所有测试与超时预算；跳过项仍为未启用 Relay fixture 的跨仓库 broker/frp WSS 集成，不计为已验收。
- `pnpm test:web`：61 个文件、1244 条全部通过，118.05 秒。以上均为本轮实际执行，先前合并记录中的测试结果不计作本轮重新执行。
- `git diff --check`、新 QA 文件的空白/EOF 检查及最终清单核对通过。未运行全仓库 `pnpm test`，不把相关组合通过写成全仓库通过。
- 最终代码复审 **Standards 0 项、Spec 0 项，no finding**。审查冻结时 HEAD 为 `ebe3bd3d5`，暂存区为空，本轮改动尚未提交。用户随后授权本轮本地提交；无关改动保留，不推送。


工具链沿用既有本机 pnpm 10.8.1，临时 userconfig `/tmp/agentkib-pnpm-session-continue.npmrc` 为 `manage-package-manager-versions=false`，同时设置 `npm_config_manage_package_manager_versions=false`、`npm_config_userconfig`、`NPM_CONFIG_USERCONFIG`。未改依赖、锁文件或仓库包管理器配置，Vitest 使用 `VITEST_MAX_WORKERS=1`。

本轮复现命令（仓库根目录，带上述环境变量）：

```sh
pnpm --filter @agentkib/desktop exec vitest run test/codex-compressed-rollouts.test.ts src/core/session-history.test.ts test/codex-session-classification.test.ts test/session-classification-cache.test.ts test/history-search-source.test.ts test/history-search-worker.test.ts test/history-search-runtime.test.ts test/history-search-lifecycle.test.ts
pnpm --filter @agentkib/desktop backend:build
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec oxlint apps/desktop/test/codex-auto-continue.test.ts
pnpm exec oxfmt --check apps/desktop/test/codex-auto-continue.test.ts
pnpm --filter @agentkib/desktop exec vitest run \
  src/features/sessions \
  src/features/workspace/ClaudeSessionPanel.test.tsx \
  src/features/workspace/WorkspaceSessionsPage.test.tsx \
  src/features/workspace/SessionHandoffDialog.test.tsx \
  test/codex-auto-continue.test.ts \
  test/codex-runtime-preflight.test.ts \
  test/codex-app-server-dispatch.test.ts \
  test/codex-resume-command.test.ts \
  test/compaction-control.test.ts \
  test/history-search-native-send.test.ts \
  test/session-observation.test.ts \
  test/claude-session-owner.test.ts \
  test/claude-auto-continue.test.ts \
  test/claude-bridge-auto-continue.test.ts \
  test/claude-managed-parity.test.ts \
  test/claude-retirement-usage.test.ts \
  test/claude-runner-status.test.ts \
  test/claude-resume-command.test.ts \
  test/claude-bridge.test.ts \
  test/claude-bridge-runtime.test.ts \
  test/claude-web-backend-integration.test.ts \
  test/claude-permission-mode.test.ts \
  test/claude-acp-live-state.test.ts \
  test/claude-config-writes.test.ts \
  test/claude-frame-drift-process.test.ts \
  electron/main/runtime-router.test.ts \
  electron/main/web/codex-resume-command.test.ts \
  electron/main/web/codex-actions.test.ts \
  electron/main/web/remote-capabilities.test.ts \
  electron/main/web/local-claude.test.ts \
  electron/main/web/claude-host.test.ts \
  electron/main/web/history-search-lan.test.ts \
  test/codex-live-state.test.ts \
  test/codex-shared-server.test.ts \
  test/managed-session-lock.test.ts \
  electron/main/web/service.test.ts \
  test/codex-compressed-rollouts.test.ts
pnpm test:web
git diff --check
```

主代理日志：`/tmp/agentkib-merged-review-{readers,build,typecheck,lint,format,testlint,testformat,desktop,web}.log`。作者先红复现及冻结前定向组合由工具输出记录，不冒称为主代理日志。
