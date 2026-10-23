# CI 质量检查并行化与保守文档快路

## 范围与基线

- 基于最新 `origin/main`：`f4c3e30a736e8ce8c5224982bfb55935bc21d54e`，已包含 PR #149
- 独立分支 `codex/ci-quality-parallel`，原工作区的文档和未跟踪文件不纳入本次修改
- 只调整 `.github/workflows/ci.yml` 及其本地辅助脚本／共享安装步骤，应用代码、依赖和生产构建命令不变
- Linux／Windows 工作流、原生后端验证、Windows 卸载／回滚、全部超时和安全断言不变
- 不涉及 UI、四语字典、跨 Agent 继续、Codex follower 或设计文件

## 原等待时间依据

样本为 PR #148 已成功的 CI；以下时间根据首次／末次日志时间估算，包含任务内部执行，不包含 GitHub 排队时间，不冒充精确步骤 API 计时

| 检查                 |  执行时间 | 证据                                                                                                                  |
| -------------------- | --------: | --------------------------------------------------------------------------------------------------------------------- |
| Test, lint and build | 713.95 秒 | [run 39878532555 / job 120170006766](https://github.com/starroyhq/agentkib/actions/runs/39878532555/job/120170006766) |
| Windows ARM64        | 398.61 秒 | run 39878532578 / job 120170006878                                                                                    |
| Windows x64          | 298.51 秒 | run 39878532578 / job 120170006998                                                                                    |
| Fedora x64           |  76.17 秒 | run 39878532556 / job 120170006573                                                                                    |
| Ubuntu ARM64         |  64.02 秒 | run 39878532556 / job 120170006529                                                                                    |

质量任务内 `pnpm test` 约 559.45 秒，占约 78%；Desktop Vitest 463.50 秒、Web Vitest 92.42 秒；Linux 系统依赖安装约 68.07 秒，pnpm 安装仅约 3.58 秒。因此先拆分串行测试关键路径，不以依赖缓存作为主要收益来源

原工作流已取消被新提交替代的旧运行，本次保留。原四项平台检查本来就与质量检查并行，不将原生验证误当作可删的重复类型检查

## 同源码基线与计时口径

另取本轮实施基线 `f4c3e30a736e8ce8c5224982bfb55935bc21d54e` 在 `main` 上的成功 push 检查作为主要对照，应用源码与本轮相同。以上约 12 分钟的历史样本实际 HEAD 为 `a1aefdb9cae4c44122184a8539f7c4148a81f77c`，不是本轮固定基线；两组的 runner 负载、依赖下载及测试执行波动不能全部归因于优化

以下数据直接使用 GitHub Actions REST API 的 `created_at`、`started_at`、`completed_at`，按整秒时间戳相减，不与前节的日志首末行小数计时混用

| 基线检查             | Job 创建 → 开始 → 完成（2026-10-23 UTC） | 可观测排队 | Job 执行 | 证据                                                                                                                  |
| -------------------- | ---------------------------------------- | ---------: | -------: | --------------------------------------------------------------------------------------------------------------------- |
| Test, lint and build | 02:40:29 → 02:40:30 → 02:46:58           |       1 秒 |   388 秒 | [run 39890851011 / job 120209985389](https://github.com/starroyhq/agentkib/actions/runs/39890851011/job/120209985389) |
| Windows ARM64        | 02:40:29 → 02:40:31 → 02:49:02           |       2 秒 |   511 秒 | [run 39890851133 / job 120209985868](https://github.com/starroyhq/agentkib/actions/runs/39890851133/job/120209985868) |
| Windows x64          | 02:40:29 → 02:40:31 → 02:46:09           |       2 秒 |   338 秒 | [run 39890851133 / job 120209986182](https://github.com/starroyhq/agentkib/actions/runs/39890851133/job/120209986182) |
| Fedora x64           | 02:40:29 → 02:40:30 → 02:41:52           |       1 秒 |    82 秒 | [run 39890850966 / job 120209985451](https://github.com/starroyhq/agentkib/actions/runs/39890850966/job/120209985451) |
| Ubuntu ARM64         | 02:40:29 → 02:40:33 → 02:41:37           |       4 秒 |    64 秒 | [run 39890850966 / job 120209985685](https://github.com/starroyhq/agentkib/actions/runs/39890850966/job/120209985685) |

三个 workflow run 均于 `02:40:28 UTC` 创建。质量工作流从创建到唯一 job 完成为 **390 秒（6 分 30 秒）**，该 job 自身执行 **388 秒（6 分 28 秒）**。全部五个检查从共同创建时间到最后一个 job 完成为 **514 秒（8 分 34 秒）**，最长为未改动的 Windows ARM64。Windows run 的 `updated_at` 为 `02:49:03`，多出的 1 秒属于状态同步，不加入执行耗时

同源码基线质量任务的主要步骤为：系统依赖 17 秒、pnpm 设置 6 秒、Node 设置 9 秒、依赖安装 3 秒、`pnpm test` 310 秒、辅助测试 15 秒、类型检查 7 秒、完整构建 10 秒、托管 Web 构建 3 秒。历史样本对应系统依赖约 68 秒、`pnpm test` 约 559 秒，说明单次样本存在明显环境波动，不能只拿约 12 分钟作为优化前固定值

后续远端复验采用以下统一规则：

- 固定完整 HEAD、workflow run ID、run attempt 与 job ID，只将该 HEAD 的明确 `completed/success` 算作通过，不将运行中的成功步骤或旧 HEAD 的成功替代最终检查
- 本轮完整路径预期 11 项检查：质量工作流 7 个展开 job（分类、静态检查／构建、桌面两片、串行安全组、Web、最终门禁），加原有四项 Linux／Windows 检查。Claude 兼容工作流的路径过滤未命中本轮文件，发布工作流也不触发
- 单 job 执行时间为 `completed_at - started_at`，可观测排队为 `started_at - created_at`；后者不代表 `needs` 依赖尚未满足期间的全部等待
- 新质量流程的耗时必须从 run 创建算到最终门禁完成，包含分类、分支调度和最终门禁等待；不能只用最终门禁这个短 job 的耗时，或把并行 job 时长相加当作用户等待时间
- 全部检查的端到端耗时为相关 run 最早创建时间到所有预期 job 最晚完成时间，单独列明排队与执行；状态同步延迟只作说明，不混入 job 执行时间
- 基线五个 job 执行时间之和为 **1383 runner 秒（23 分 03 秒）**，用于粗略观察资源用量；它不是 GitHub 计费分钟，未套用各平台费率、单 job 取整或其他计费规则
- 主要比较同源码基线与新流程，并保留历史样本作为波动参考；单轮远端结果只作为观测值，不能证明稳定百分比收益

原始 API 来源：[同源码质量 jobs](https://api.github.com/repos/starroyhq/agentkib/actions/runs/39890851011/jobs?filter=latest&per_page=100)、[同源码 Windows jobs](https://api.github.com/repos/starroyhq/agentkib/actions/runs/39890851133/jobs?filter=latest&per_page=100)、[同源码 Linux jobs](https://api.github.com/repos/starroyhq/agentkib/actions/runs/39890850966/jobs?filter=latest&per_page=100)

## 实施

| 任务      | 行为                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| `changes` | 完整检出 Git 历史，读取 PR 的 `base.sha...head.sha` 三点差异，输出 `full` 或 `docs`                              |
| `checks`  | 原格式、Lint、全部 Node 辅助测试、类型检查、完整应用构建、托管 Web 构建，增加桌面分片集合校验                    |
| `desktop` | 两个独立 runner，分别执行普通桌面项目 `--shard=1/2`、`--shard=2/2`；先构建各自的后端，任一分片失败不会取消另一片 |
| `safety`  | 独立 runner，先构建后端，再执行 `filesystem` 和 `mcp-latency`；保留原 `fileParallelism: false` 及组顺序          |
| `web`     | 独立 runner 执行原 `pnpm test:web`                                                                               |
| `quality` | 保持必需检查名 `Test, lint and build`，`always()` 等待以上全部任务，严格核对模式及完成状态                       |

桌面、串行组及构建任务保留原 Linux 系统依赖和 `diagnose-linux.sh --strict`，通过同一 composite action 安装。所有任务保持 `contents: read`，checkout 不保留 Git 凭据，不引入生产依赖、额外服务或新的缓存边界

不能在同一检出目录同时构建后端并运行使用它的测试：构建会清理并替换 chunk、Claude bridge 和 Koffi 目录。CI 通过独立 runner 隔离；本地验证按组顺序执行

### 文档快路边界

- 只对 PR 生效；推送到 `main` 始终完整执行
- 只允许四个根文档 `README.md`、`README.zh-CN.md`、`CONTRIBUTING.md`、`SECURITY.md`，以及 `docs/`、`qa/` 内第一层普通 Markdown 文件的新增／修改
- 只允许普通非可执行文件模式 `100644`；不放行删除、重命名、复制、符号链接、可执行／文件类型变化、嵌套文件、探针、截图／其他资源、脚本、工作流、配置或锁文件
- 完整 PR 中有代码改动时，即使最后一次提交只更新 QA，仍执行完整检查；目标分支前进时，以真实 merge base 判断 PR 自身改动
- 非法事件、缺失 SHA、Git 失败、空差异、异常 raw 记录／UTF-8／路径均回退 `full`，不打印事件、Git 错误内容或本机路径
- 不采用工作流级 `paths-ignore`，避免原必需检查一直 pending
- 文档快路只跳过本质量工作流的四个执行分支，四项 Linux／Windows 平台检查保持原行为
- 完整模式必须四分支全部 `success`；文档模式必须四分支全部 `skipped` 且分类成功；失败、取消、缺失、非法模式及非预期跳过均使最终门禁失败

## 回归测试与验证

先补测试再实现：旧工作流的 4 项拓扑测试全部失败，实现缺失时分类／门禁测试以 `ERR_MODULE_NOT_FOUND` 失败；实现后目标 18 项通过。补充异常 BOM 用例后曾复现 1 项失败，修正 UTF-8 解码不忽略 BOM 后全部通过

- 真实临时 Git 仓库验证文档 PR、代码后追加 QA、目标分支前进、重命名／复制及 Git／事件读取失败
- 严格门禁验证 full/docs 合法成功、每个依赖的失败／取消／缺失／空／未知状态及错误跳过
- YAML 解析与结构回归验证四执行分支、两个分片、串行安全组、完整原命令、构建先于测试、默认状态依赖及 composite 安装约束
- 使用 Vitest 实际 sequencer 核对分片：408 个文件 = 196＋195 个普通项目文件＋12 个文件系统文件＋5 个 MCP 文件，集合无重无漏
- 未使用 `vitest list --shard` 充当分片证据：当前版本的静态 list 不应用分片，校验脚本调用实际运行 sequencer 的 shard 实现

本地使用隔离的 HOME／CODEX_HOME／CLAUDE_CONFIG_DIR／应用和基准数据目录及每条命令独立 TMPDIR，仅合成测试数据；pnpm 临时 userconfig 禁用包管理器版本自动切换。首次 offline 安装缺少缓存元数据，改用冻结锁文件正常安装，953 项供应链校验通过，815 个包均复用，下载 0，未修改依赖或锁文件

本机 Node.js 26.12.0、pnpm 12.10.1，CI 继续使用既有 Node.js 22。依赖安装额外使用 `--ignore-scripts` 避免本机安装阶段下载 Electron；后端和应用均按原脚本实际构建，CI 的冻结安装方式不变

| 命令                                                                                         | 结果                                                                                              |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `pnpm --filter @agentkib/desktop backend:build`                                              | 通过，生成后端、Claude bridge 与 Koffi 运行产物                                                   |
| `pnpm --filter @agentkib/desktop exec vitest run --project=desktop --shard=1/2`              | 196 文件通过；3897 项通过、1 项既有跳过；40.72 秒                                                 |
| `pnpm --filter @agentkib/desktop exec vitest run --project=desktop --shard=2/2`              | 194 文件通过、1 文件既有跳过；3962 项通过、2 项既有跳过；29.38 秒                                 |
| `pnpm --filter @agentkib/desktop exec vitest run --project=filesystem --project=mcp-latency` | 17 文件、379 项全部通过；98.23 秒                                                                 |
| `pnpm test:web`                                                                              | 69 文件、1492 项全部通过；35.85 秒                                                                |
| `node --test .github/scripts/*.test.mjs`                                                     | 96 项：61 通过、35 项既有平台跳过、0 失败，包含新增 18 项回归；约 5.39 秒                         |
| `node .github/scripts/verify-ci-quality-partition.mjs`                                       | `totalFiles:408`，`desktopShards:[196,195]`，`filesystem:12`、`mcp-latency:5`，`exactlyOnce:true` |
| `pnpm format:check`                                                                          | 通过                                                                                              |
| `pnpm lint`                                                                                  | 通过，0 errors；275 项现有 warnings，对应应用源码本轮未修改                                       |
| `pnpm typecheck`                                                                             | backend／桌面／Web 全部通过                                                                       |
| `pnpm build`                                                                                 | 完整桌面及其内置 Web、renderer、Electron／后端构建通过，恢复测试可能清理的插件产物                |
| `pnpm build:web:hosted`                                                                      | 通过                                                                                              |
| `pnpm exec oxfmt --check`（本轮 8 个文件显式列表）                                           | 通过，补充根 `format:check` 未覆盖的 `.github/`、Markdown 范围                                    |
| `git diff --check`                                                                           | 通过                                                                                              |

桌面合计 408 个文件：407 通过、1 个既有跳过；8238 项通过、3 项既有跳过。跳过来自未开启的真实 Claude Relay 跨仓验收、真实 Claude bridge 原生验收及 Windows 专属 TLS 用例，没有新增或扩大跳过条件。辅助测试的平台跳过保持原 Windows／NSIS 条件，不以本机 Node 测试代替 Windows 原生验证

本机使用同一检出目录，测试组及构建顺序执行；分片／串行组的上述耗时仅用于确认新命令实际执行完成，不据此声称 CI 已缩短到某个时长。Web 与少量 Node 辅助用例有短暂重叠，未与后端构建重叠

独立 code-review：Standards 与 Spec 两轴均 no finding；额外核对原 Windows、Linux、发布、Claude 兼容工作流相对固定基线 diff 为空，未修改 package.json、锁文件或 Vitest 配置。远端完整成功路径与计时见下节；没有人为制造 GitHub 矩阵失败／取消运行，对应拒绝路径已由本地门禁回归覆盖

## 远端复验：固定实现提交

- 草稿 [PR #150](https://github.com/starroyhq/agentkib/pull/150)，目标 `main`，保持未合并
- 实现提交：`4b916da44d178c40b0340d3408627fe75fd0fe05`
- [质量 run 39894121432](https://github.com/starroyhq/agentkib/actions/runs/39894121432)、[Windows run 39894121302](https://github.com/starroyhq/agentkib/actions/runs/39894121302)、[Linux run 39894121252](https://github.com/starroyhq/agentkib/actions/runs/39894121252)
- 全部 run attempt 为 1，固定该完整 HEAD 经 Code Review 检查接口核对 **11 项全部 `completed/success`**，无失败、重跑或放宽断言
- 分类选择 `full`，五个执行分支均实际运行，最终原名门禁在它们全部完成后成功

以下为 GitHub REST API 的最终 job 元数据，全部为 `2026-10-23 UTC`，不使用排队时 `runner_id:0` 的临时开始时间推算执行耗时

| 检查                              | Job ID       | 创建 → 开始 → 完成             |   排队 |   执行 |
| --------------------------------- | ------------ | ------------------------------ | -----: | -----: |
| Classify quality scope            | 120220447680 | 03:16:25 → 03:29:17 → 03:29:26 | 772 秒 |   9 秒 |
| Format, lint, typecheck and build | 120224178013 | 03:29:26 → 03:29:28 → 03:31:48 |   2 秒 | 140 秒 |
| Desktop tests (1/2)               | 120224178016 | 03:29:26 → 03:31:04 → 03:33:24 |  98 秒 | 140 秒 |
| Desktop tests (2/2)               | 120224178098 | 03:29:26 → 03:30:39 → 03:33:06 |  73 秒 | 147 秒 |
| Serial filesystem and MCP tests   | 120224178125 | 03:29:26 → 03:31:17 → 03:33:30 | 111 秒 | 133 秒 |
| Web tests                         | 120224178023 | 03:29:26 → 03:29:53 → 03:31:21 |  27 秒 |  88 秒 |
| Test, lint and build              | 120225381402 | 03:33:30 → 03:33:32 → 03:33:43 |   2 秒 |  11 秒 |
| Windows x64                       | 120220447334 | 03:16:25 → 03:25:33 → 03:31:15 | 548 秒 | 342 秒 |
| Windows ARM64                     | 120220447571 | 03:16:25 → 03:22:00 → 03:30:37 | 335 秒 | 517 秒 |
| Ubuntu ARM64                      | 120220446985 | 03:16:25 → 03:24:46 → 03:25:42 | 501 秒 |  56 秒 |
| Fedora x64                        | 120220447167 | 03:16:25 → 03:26:49 → 03:28:26 | 624 秒 |  97 秒 |

质量流程及全部 11 项检查从共同创建时间到最后一个 job 完成为 **1038 秒（17 分 18 秒）**，比同源码基线全部检查的 514 秒更长；质量任务最初等待 runner 为 **772 秒（12 分 52 秒）**，该等待单独就超过基线的全部耗时，不能声称本轮用户总等待已缩短。GitHub 当时公开状态没有 Actions 事故，具体 runner 分配延迟原因未获进一步证据，不归因于应用或测试

从质量首个 runner 开始到最终门禁完成为 **266 秒（4 分 26 秒）**，包含后续叶子调度／排队；对照同源码基线 388 秒，本次观测减少 122 秒，约 **31.4%**。此口径排除首轮 runner 初始排队，不代表稳定百分比或用户端到端收益。五个执行分支在 `03:31:17–03:31:21` 同时运行，使用独立 runner，确认并行实际生效

质量 7 个 job 的执行时间合计 **668 runner 秒**，相对旧单 job 388 秒增加约 **72.2%**；全部 11 个 job 合计 **1680 runner 秒（28 分）**，相对基线 1383 秒增加约 **21.5%**。这些只表示原始执行秒，不等于计费分钟。质量／Windows／Linux run 的 `updated_at` 分别为 `03:33:44`、`03:31:16`、`03:28:27`，各比最后 job 完成晚 1 秒，属于状态同步

### 远端测试计数与覆盖对照

- 同源码基线 `f4c3e30a7` 的 Desktop 为 **8179 通过／62 跳过、408 文件**，Web 为 **1492 通过／69 文件**；不是历史 PR #148 的 8107 项
- 新流程 Desktop 1/2：3855 通过、43 既有跳过、196 文件；2/2：3945 通过、19 既有跳过、195 文件；串行组：379 全过、17 文件。合计与同源码基线完全一致，408 文件无重无漏
- 新流程 Web：69 文件、1492 项全过。Vitest 本身报告耗时分别为桌面 1/2 `104.81s`、2/2 `111.35s`、串行组 `74.88s`、Web `67.32s`，与表中包含安装／构建／收尾的 job 时间分开记录
- Linux 辅助测试：96 项中 84 通过、12 既有跳过；同源码基线为 78 项中 66 通过、12 跳过，差额恰好是本轮新增 18 项
- Windows x64／ARM64 各自辅助测试 86 通过、10 既有跳过；独立原生 NSIS 卸载／回滚策略各 **15/15** 通过；后端稳定性各 **950 通过／11 既有跳过**，原断言与超时不变
- 静态检查、实际分片集合校验、全部类型检查、完整桌面构建和托管 Web 构建均通过

原始来源：[质量 jobs](https://api.github.com/repos/starroyhq/agentkib/actions/runs/39894121432/jobs?filter=latest&per_page=100)、[Windows jobs](https://api.github.com/repos/starroyhq/agentkib/actions/runs/39894121302/jobs?filter=latest&per_page=100)、[Linux jobs](https://api.github.com/repos/starroyhq/agentkib/actions/runs/39894121252/jobs?filter=latest&per_page=100)、[GitHub 公开状态](https://www.githubstatus.com/)

本节保存固定实现提交的远端证据。提交本 QA 后，仍按累计 PR 差异执行完整检查，继续核对最终 HEAD 的 11 项状态与耗时；最终状态写入 PR 说明，避免为记录状态反复制造新 CI 提交

## 限制与上线观察

- 首轮本地验证阶段尚无新工作流的 GitHub runner 实测收益；本机分片耗时不能代替托管 runner 或排队时间，远端结果另行记录
- 新质量工作流展开为 7 个任务，包含分类与最终门禁，增加 runner 启动、依赖安装和 runner 分钟；实际收益取决于仓库并发额度及队列
- 四项平台检查不变，Windows ARM64 仍可能成为新的最长任务
- 不调整超时、worker 数、测试隔离或断言；不缓存／缩减 Windows 原生卸载验证；不改重复类型检查或生产构建脚本

依据：[GitHub needs / always 行为](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)、[needs 完成状态](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context)、[Vitest 性能与分片](https://vitest.dev/guide/improving-performance.html)
