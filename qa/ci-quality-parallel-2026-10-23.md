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

独立 code-review：Standards 与 Spec 两轴均 no finding；额外核对原 Windows、Linux、发布、Claude 兼容工作流相对固定基线 diff 为空，未修改 package.json、锁文件或 Vitest 配置。远端的矩阵失败汇总、队列及端到端耗时仍需首次 GitHub CI 验证

## 限制与上线观察

- 首轮本地验证阶段尚无新工作流的 GitHub runner 实测收益；本机分片耗时不能代替托管 runner 或排队时间，远端结果另行记录
- 新质量工作流展开为 7 个任务，包含分类与最终门禁，增加 runner 启动、依赖安装和 runner 分钟；实际收益取决于仓库并发额度及队列
- 四项平台检查不变，Windows ARM64 仍可能成为新的最长任务
- 不调整超时、worker 数、测试隔离或断言；不缓存／缩减 Windows 原生卸载验证；不改重复类型检查或生产构建脚本

依据：[GitHub needs / always 行为](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds)、[needs 完成状态](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#needs-context)、[Vitest 性能与分片](https://vitest.dev/guide/improving-performance.html)
