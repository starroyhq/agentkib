# 会话无感续接四阶段：独立审查与修复

日期：2026-10-19。原始审查范围：`bae578ef1eeabcf16bd34d1cb2ede9abb3fb7fa2...ac3f8decb`，共四个阶段提交、162 个文件。四阶段提交依次为 `f762c7772`、`06b678020`、`683b0a427`、`ac3f8decb`。审查与验证期间修复保留在工作区；用户随后授权将审查修复、相关测试与本记录作一次本地提交，不推送。

## 审查方法与约束

- 使用 `code-review` 技能，Standards 与 Spec 由未参与阶段实施的新代理分别只读审查，另设独立运行时并发审查。
- 原始固定命令为 `git diff bae578ef1...HEAD`，提交列表为 `git log bae578ef1..HEAD --oneline`。审查期间按用户要求不提交，复审额外检查 `git diff HEAD`，最终累积范围为 `git diff bae578ef1`；新增回归和本记录另列清单。
- 规范来自 `AGENTS.md` 与 `docs/development/ui-terminology.md`；规格来自实施说明、技术前提与本机设计第 8 节。项目不用 issue tracker，不为审查增加跟踪系统。
- 沿用用户已确认决定：Web 复制续接命令与主机说明；最后订阅者离开等待当前轮次完成后释放；跨 Agent 继续、`handoff.*`、交接文件与在工作区续接不改；Codex follower 暂不删除；内部锁、指纹、版本、平台、权限、未知结果校验保留。
- 原有 `.agents/`、`prototypes/`、两份本机实施/技术文档及设计文件保持原样。

## 初轮确认的问题

### Standards：二次分支遗漏未上传附件

工作区 `ClaudeSessionPanel` 首次分支上传失败或未知回执恢复后，文件留在 `unuploadedAttachments`；再次分支只快照/复制 `attachments`，导致切换时待上传文件消失。Standards 与 Spec 分别独立发现，主代理核对后实施。

- 修复：已上传附件对应的原始 `File` 与待上传文件组成完整快照；直接成功及未知回执恢复均用这一份快照，不按文件名去重。
- 回归：上传部分失败后二次成功、上传部分失败后二次未知回执、首次未知回执恢复后二次成功。三项先红后绿，验证同名不同文件字节、未知证明前不迁移/不上传/不重复分支。
- 工作区面板完整 125/125 通过；两端通用 composer 补相邻回归，Web 46/46、桌面 47/47 通过。通用 composer 原本已经保留失败上传的 `File`，没有为同步而改动正常实现。
- Standards 对此补丁独立复核：no finding。

### Spec：分支进程被误认成源会话写入者

实际 Claude 分支命令含 `--resume=源 --fork-session --session-id=子`，`ps` fallback 同时匹配源和子。即使 agents/registry 登记为子，探测源时仍误报占用；源 worker 的新巡检会因此停止它并暂停队列，违反“分支原会话不受影响”。独立探针与运行时复现均先失败。

- 修复：只有唯一有效 fork/resume/child 参数，且同一 PID 的 agents 或已验证 PID、procStart、平台与文件边界的 registry 一致证明实际 child 身份，才将源 resume 排除；不忽略 child PID，不缓存启动许可。
- 无身份佐证、矛盾或畸形参数继续保守拒绝，避免将 ps 文本中的伪参数作为安全许可。正常源 writer 与 child 占用均保留。
- 回归：4 个参数/身份来源用例与真实隔离双 worker 生命周期先红；最终 owner 与 auto-continue 两文件 70/70 通过。包括源/子跨两次巡检共存、另一个真实源 writer、缺失/重复/矛盾标志和身份、防 PID/出生时间/平台错误、prompt 伪参数等边界。
- Spec 对附件与此探针两项补丁独立复审 no finding；其独立测试启动被本机 pnpm 自动切换 ENOEXEC 阻塞，未把该调用记作测试通过。主代理与实施验证使用既有临时工具链配置，不修改依赖。

### 运行时补充：重初始化遗漏正在启动的 Codex runner

自动发送暂停在 app-server 初始化期间时，`WebReadRequests.closeAsync()` 仅扫描已登记 runner。`backend.initialize` 不走 shutdown 的上层 drain，旧启动可能在 reset 后继续 resume/登记，遗留无人管理的进程、lease 与写锁。真实 Backend RPC 的隔离复现确认重新初始化后旧 server 仍未关闭。正常 shutdown 的上层 drain 不能代替重初始化路径的资源收尾。

- 修复：同步阻止新操作，登记并等待在途操作；通过启动回调提前捕获初始化中的 runner，同时追踪临时查询进程。先关闭进程使未完成 I/O 退出，等操作保存真实回执，再清扫启动返回与登记之间的资源。
- 续接、发送与取消归档的实际派发边界再次检查关闭状态；已经派发而丢失回执的原生操作保留 unknown，尚未派发的用户消息保持 not-dispatched。关闭失败时保留 lease，直到真实 close 事件才释放。
- 新增 9 条回归，涵盖真实 Backend 的重初始化/关闭、resume/turn 派发后的未知回执、初始化关闭失败、启动登记微任务间隙、同步短订阅以及临时 queue reader 的成功/失败关闭。
- 修复初稿把 admission 延到微任务，主代理复核后补充先红回归；最终在登记 Promise 后同步调用操作，保留原先短订阅的观察顺序。没有调整 `index.ts`、follower、协议或依赖。
- 冻结前相关 5 文件 73 条通过。首次 6 文件组合有 1 条既有 Claude 原生引用发送用例在原 25 秒预算内超时，之后按原预算隔离复跑通过；没有延长超时或修改该测试。最终统一组合结果见下节。

## 复审与验证

冻结后由原两条独立审查轴再次检查累积工作区，而非仅看已提交的四阶段：

- **Standards：no finding。** 复核同步 admission、启动资源登记、关闭/重初始化 fence、operation drain、关闭失败 lease 和 Claude fork 的一致正面身份要求，未发现新的硬规范违反或需阻断的 smell。
- **Spec：no finding。** 三项原问题均已解决；回收后的 Claude 每次重启仍经过 `beforeStart` 的外部占用及指纹、版本等检查。未见跨 Agent、handoff、四语文案或 follower 保留边界发生额外变化。
- 两轴结论基于独立代码、调用链和测试设计审查。审查代理的定向测试因 pnpm 自动切换 `ENOEXEC` 未能启动，不计为通过；统一测试由主代理使用下述既有工具链配置运行。
- `pnpm typecheck`：通过，包含后端、桌面和 Web 路由生成/类型检查。
- `pnpm lint`：通过，0 错误、275 条警告，与第 4 阶段数量一致。
- `pnpm format:check`：通过，962 个匹配文件；额外对根脚本未覆盖的 4 个后端测试文件运行 `oxfmt --check`，通过。
- `git diff --check`：通过。
- 对比四阶段前基线，桌面四语各 123 个 `handoff.*`/`sessions.*Handoff` 键值保持不变；本轮没有修改四语文案、跨 Agent 实现或独立 follower 模块，`web-read.ts` 中的 follower 实现仍保留，暂存区为空。
- `pnpm test:web`：61 个文件、1244 条全部通过，166.77 秒。
- 桌面首轮 71 文件组合：69 文件通过、2 文件失败；1446 条通过、2 条失败、1 条按原配置跳过。权限报告保留用例触发原 5000ms 超时；面板焦点测试在轮询注册前读取回调，出现 `expected undefined to be type of function`。
- 补充 6 文件组合：5 文件通过、1 文件失败；352 条通过、1 条失败。面板 125 条在此运行均通过；权限文件另一个模式报告用例触发原 5000ms 超时。
- 面板焦点测试修正：只将立即读取回调改为 `waitFor` 等待 passive effect 注册，保留函数类型、实际轮询、草稿恢复和无自动发送/接管断言，不改产品实现或超时。修正后单文件 125/125 通过；两轴对这一最终增量分别复审 no finding。
- 权限文件按原 5000ms 预算完整隔离复跑：59/59 通过，13.18 秒。没有修改测试、fixture 或超时，当前证据说明组合中有间歇超时，未据此定位到产品缺陷，也不将之前失败改写为通过。

- 最后一次 75 文件组合：74 文件通过、1 文件失败；1615 条通过、2 条失败、1 条按原配置跳过，288.21 秒。前三处产品修复及面板等待修正的回归、四语渲染、权限文件均通过；失败集中在 `claude-bridge-runtime.test.ts`：首例在 5000ms 超时且清理 hook 在 10000ms 超时，下一例随后报临时目录 ENOENT。
- 该终端连接文件在首轮组合全部通过；此次失败后保留原 test/hook 预算完整隔离复跑，3/3 通过，5.76 秒。没有放宽超时或删除断言，未将组合失败改写为全绿。
- 对该失败额外只读核查：Claude live/events/controls 直接进入 ClaudeManaged/Bridge；只有 catalog 经过 WebRead 的只读 operation，该 fixture 无 Codex 托管记录，也没有索引待分类任务，不存在等待 close/bridge 控制的反向边。各 owner 在 Backend 关闭时并行收尾，未发现本轮 fence/drain 造成死锁的可达链。首次 live 的 CLI 版本/agents/ps 实测本身有独立上限，总时长可能超过测试 5 秒；日志没有步骤采样，首例超时原因仍未确定，不声称环境负载是唯一原因。
- ENOENT 的级联机制已确认并修复：超时未取消的旧 `afterEach` 读取被下一 `beforeEach` 覆盖的共享 fixture 变量，可能关闭或删除下一例资源。改为进入清理时同步固定 service/backend/目录及历史快照，只清理本例实例；mock 恢复也同步前移，避免恢复下一例已建立的 spy。不改产品、原 test/hook 预算或历史/CLI 安全断言。最终局部 3/3 通过，3.40 秒；Standards、Spec 分别独立增量复审 no finding。
- 原配置跳过的 1 条是未启用 Relay fixture 的跨仓库 broker/frp WSS 集成，不作为本轮已验收证据。

自动化结果不替代真实 CLI 产品验收；未重跑整个仓库的 `pnpm test`，不声称全仓库通过。

上轮代码审查结论：Standards 0 项、Spec 0 项。首例组合超时当时仍是验证限制，不将隔离通过解释为组合全绿；清理补丁后当时仅复跑受影响文件，没有再次重复 75 文件组合。用户随后要求继续定位，见本记录末尾的超时追查。暂存区为空，HEAD 保持 `ac3f8decb`，没有提交或推送。

工具链沿用前四阶段：本机 pnpm 10.8.1，临时 userconfig `/tmp/agentkib-pnpm-session-continue.npmrc` 内容为 `manage-package-manager-versions=false`；同时设置 `npm_config_manage_package_manager_versions=false`、`npm_config_userconfig`、`NPM_CONFIG_USERCONFIG`，Vitest 使用 `VITEST_MAX_WORKERS=1`。未安装、升级依赖或改变仓库包管理器配置。

主代理最终验证命令（均在仓库根目录、带上述环境变量运行）：

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm exec oxfmt --check apps/desktop/test/claude-auto-continue.test.ts apps/desktop/test/claude-session-owner.test.ts apps/desktop/test/codex-auto-continue.test.ts apps/desktop/test/claude-bridge-runtime.test.ts
pnpm test:web
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
  electron/main/web/service.test.ts
git diff --check
```

日志：静态/Web 为 `/tmp/agentkib-review-{typecheck,lint,format,web}-final.log`，桌面首轮 `/tmp/agentkib-review-desktop-final.log`、补充 `/tmp/agentkib-review-desktop-supplement.log`、权限隔离 `/tmp/agentkib-review-permission-isolated.log`、面板修正 `/tmp/agentkib-review-panel-focus-waitfor.log`、最后组合 `/tmp/agentkib-review-desktop-verified.log`、终端连接隔离 `/tmp/agentkib-review-bridge-runtime-isolated.log`、终端连接清理修正 `/tmp/agentkib-review-bridge-fixture-final.log`。冻结前的 5 文件 73 条和原预算隔离重跑证据仅保存在工具输出，未声称存在磁盘日志。

## 本轮文件清单

生产修复共 3 个文件：

- `apps/desktop/src/features/workspace/ClaudeSessionPanel.tsx`：完整迁移分支草稿中的待上传文件。
- `packages/backend/src/claude-session-owner.ts`：在可信且一致的 child 身份佐证下识别 fork 源，保留保守占用判断。
- `packages/backend/src/web-read.ts`：关闭/重初始化时覆盖在途、启动中和临时进程资源。

回归共 7 个文件：

- `apps/desktop/src/features/workspace/ClaudeSessionPanel.test.tsx`：重复分支、上传失败与未知回执恢复。
- `apps/desktop/src/features/sessions/conversation/features/sessions/session-composer.test.tsx`：桌面 Codex/Claude 同名文件失败后再次分支。
- `apps/web/src/features/conversation/features/sessions/session-composer.test.tsx`：对应 Web 回归。
- `apps/desktop/test/claude-session-owner.test.ts`：fork 参数、身份佐证与安全拒绝边界。
- `apps/desktop/test/claude-auto-continue.test.ts`：源/子 worker 共存且巡检不误停。
- `apps/desktop/test/codex-auto-continue.test.ts`：关闭与重新初始化的 9 条回归。
- `apps/desktop/test/claude-bridge-runtime.test.ts`：固定异步清理所属 fixture，避免超时级联误删下一例资源。

另新增本 QA 记录，共 11 个本轮文件。共享后端修复同时服务桌面/Web；桌面专有工作区面板无需新增 Web 功能。本轮没有新增或修改用户文案，沿用四阶段已同步的四语并继续运行四语渲染回归。

## 桌面 75 文件组合超时追查（续办）

用户要求继续定位超时、保留原预算和安全断言，修复后完整重跑并再次独立审查，不提交或推送。本轮开始时保存工作区补丁和目标文件到 `/tmp/agentkib-timeout-20261019.RABbGo/`，核对其他 9 个已跟踪文件的既有 diff 完全未变；临时诊断文件均恢复，不修改生产逻辑。

### 复现与确定根因

- 在原 75 文件组合上仅增加临时步骤/命令计时，未改变预算：73 个文件通过、2 个文件失败；1615 条通过、2 条失败、1 条原配置跳过，总 264.02 秒。失败为终端连接首例与 Web 后端的文件引用/改名/分支/归档复合场景。日志 `desktop-diagnostic.log`。
- 终端连接首例的计时见 `bridge-trace.jsonl`：测试开始于 857.28ms；版本命令 969.06–1729.36ms（760.30ms），`agents --json` 1739.20–1924.09ms（184.89ms），全机 `/bin/ps` 的 `Commands.run` 调用 1924.41–8824.63ms（6900.23ms，含启动和退出等待）。原 5 秒测试在 5867.89ms 开始清理，计时正常。
- `service.dispose` 仅约 1.5ms；后端在 `ps` 调用结束后约 6ms 完成收尾。源码中 `Commands.run` 在同步 spawn 返回后才安装 3 秒定时器，超时请求终止子进程后 Promise 仍等待真实 `close`，所以 3 秒配置不是整个调用的硬上限。该 trace 未单独采样 spawn/kill，不能进一步断定耗时发生在启动还是 kill 后；已经确定阻塞来自全机 `ps` 调用，而非本轮 WebRead drain 的循环等待。保留生产等待真实退出的语义。
- 当时机器负载较高（`uptime` 为 183.29 / 179.48 / 206.39，另一快照为 228.21 / 186.23 / 209.64），单 Vitest worker 已生效。这只是背景证据；不把它当作替代命令计时的唯一归因，也未干预其他进程。

### 最小修复与验证边界

- 仅调整 `claude-bridge-runtime.test.ts` 的合成环境：精确匹配 `/bin/ps` 和两个固定参数 `-axo`、`pid=,lstart=,command=`，返回该 fixture 没有执行 CLI 的空进程表。其他命令继续走原 supervisor，临时 CLI 的 `--version` 与 `agents --json` 仍实际执行。
- 新增断言确认扫描确实发生，仍传入 3000ms、4 MiB、严格输出、UTC/C 环境选项；初次 live 后 CLI 日志严格等于两次允许调用，避免白名单 `every([])` 空真。原完整历史字节、禁止其他执行 CLI、终端真实 Unix socket/Web/Backend 通信、安全门控及原 5 秒测试/10 秒 hook 预算均保留。
- 此文件不再承担全机 `ps` 的执行时长测试。所有权解析、不可用/截断、身份矛盾与外部占用继续由 owner/生命周期专项覆盖；生产探针、每次重启前的两次安全检查、锁、指纹、版本、平台、权限和未知回执均未修改。
- 修复后的终端连接文件 3/3 通过，总 2.74 秒，日志 `bridge-fixed.log`。最终完整组合还会验证新增的输出限制断言。

### 复合场景的额外分段诊断

- Web 后端复合场景隔离一次通过；整个文件原预算 29 通过、1 原跳过，总 32.92 秒。目标测试 2248.56ms，其中 19 次 HTTP 合计 2241.68ms，清理约 17.34ms。
- 创建约 373ms、父发送约 401ms、改名约 188ms、分支约 336ms、子发送约 382ms、归档约 104ms、取消归档约 100ms；父 runner 回收 33.34ms（进程树终止 11.59ms）。没有本次初始化、回收或悬空 await 停滞的证据，不将它归为相同 `ps` 根因，也不据猜测优化持久化或拆测试来扩大实际预算。
- 计时记录 `web-backend-reference-events.json`，日志 `web-backend-file-diagnostic.log`。该文件已恢复到诊断前备份，diff 为空；没有留下临时 trace 或环境依赖。

### 最终检查与独立复审

Standards、Spec 已分别对最终测试补丁静态增量复审，均 no finding；不把作者自测当成独立审查证据。主代理验证：

- `pnpm typecheck`：通过，包含后端、桌面和 Web。
- `pnpm lint`：通过，0 错误、275 条既有警告。
- `pnpm format:check`：通过，962 个匹配文件；额外 4 个后端测试文件 `oxfmt --check` 通过。
- `git diff --check`：通过。
- 去除所有临时计时后的完整相关组合：**75/75 文件通过，1617 条通过、1 条原配置跳过，0 失败**，总 188.07 秒（19:09:55 开始）。日志 `desktop-final.log`。没有 `testTimeout`/`hookTimeout` 覆盖或调整，没有拆分原用例增加实际预算。
- 跳过项仍仅为未启用 Relay fixture 的跨仓库 broker/frp WSS 集成；其余包含 bridge 首例、Web 后端复合场景、权限/回收、owner 安全专项及桌面四语回归的完整组合均已验证。

本次仅增量修改 bridge 测试与本 QA；先前 9 个其他已跟踪文件的 diff 均未变化，Web 后端诊断文件已按字节恢复，未重新运行无改动的 Web 套件（上一轮 1244/1244 通过）。

本轮交付结论：全机 `ps` 调用导致的桥接合成测试超时已通过限定 fixture 的进程表输入消除，生产等待真实退出及所有安全门控保留。复合场景未发现可复现的初始化/回收缺陷，不编造额外生产修复；该场景已在最终完整组合通过。独立 Standards 0 项、Spec 0 项。验证冻结时 HEAD 为 `ac3f8decb`，暂存区为空，尚未提交或推送；后续本地提交授权见下节。

本节日志均位于 `/tmp/agentkib-timeout-20261019.RABbGo/`。最终组合使用前文同一 75 文件命令与临时 pnpm 配置，不覆盖原日志，不延长预算或改变安全断言。

## 本地提交范围

用户在完整组合验证与独立复审完成后授权本地提交，仍禁止推送。本次提交仅包含前述 3 个生产文件、7 个回归测试和本 QA，共 11 个文件，父提交为 `ac3f8decb`。提交前只更新本记录的授权与提交状态，没有改变已验证的代码或测试预算。

原有 `.agents/`、`prototypes/`、`qa/claude-session-continue-2026-10-18.md`、`qa/session-continue-implementation-2026-10-19.md` 及本机设计文件继续保留在工作区，不纳入提交。提交范围审计未发现无关修改、临时诊断、敏感内容、依赖或跨 Agent/follower/i18n 意外改动。

## 已知覆盖限制

前置 CLI 实测与技术前提沿用各阶段记录；本轮隔离 fake CLI、受控时钟与组件测试不算真实模型往返。Claude 实际空闲十分钟、终端/插件真实收发与分支、运行中外部打开后的历史无交错，Codex 真正模型轮次/约一分钟释放/交互 CLI 互斥，以及 Windows、旧版 CLI 完整界面、真手机端到端仍需实机验收。完整清单见第 4 阶段 QA；本轮不据代码审查声称这八项已全部完成。
