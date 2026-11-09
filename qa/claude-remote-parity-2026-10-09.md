# Claude Remote 功能对齐验收 — 2026-10-09

## 记录状态

本记录对应 `codex/claude-remote-parity` 分支、基线 `b79fe48bf58616c03b6dbb0e64582a3024c99134` 上的实现。实现已整合到独立 worktree，各阶段验证结果依次记录，最新结果见末尾章节。历史原生验收继续保留在 [2026-09-30 QA](claude-managed-2026-09-30.md) 与 [2026-10-07 QA](typescript-stability-2026-10-07.md)，不外推为本次新增功能通过。

本轮使用隔离工作树、临时数据目录、合成历史和伪 CLI/协议帧。工具链为 Node `26.9.0`、仓库声明的 pnpm `12.10.1`；通过临时 PATH 包装调用 pnpm，没有修改全局安装。没有提交、推送、发布、部署、真实模型请求或实体手机操作。

## 功能范围

| 范围 | 实现与验收边界 |
| --- | --- |
| 远程入口 | 浏览器/手机 Web 与本机桌面共用托管执行服务，浏览器使用配对设备身份。原生桌面连接另一主机的配对流程不因本改动自动获得全部 Web 控制能力。 |
| 平台与版本 | 基础托管保留 macOS 兼容检查；新增高级控制要求 Claude Code `2.1.286` 或更新版本，并继续验证原生契约。Windows/Linux、未验证安装、控制开关关闭、权限不足及 LAN HTTP 传输门槛保持禁用。 |
| 原生操作 | 实际发现模型/effort；会话级 `set_model` / `apply_flag_settings` / `set_permission_mode`；`next` 插入；基于验证历史和截止点的 fork；原生日志标题。工具权限仅 `default` / `plan` / `acceptEdits`。 |
| AgentKib 状态 | 队列、归档、目标持久化与宿主调度，支持暂停/恢复、编辑/删除/重排及目标状态操作。取消归档、主机/Backend 重启不自动继续未知或暂停的任务。 |
| 自动派发 | 每一步重新核验设备、工作区、权限、控制开关和会话状态，共用单会话并发栅栏与请求回执；撤销/重启不能重放已经派发但结果未知的工作。 |
| 目标终态 | 绑定当前步骤的结构化 MCP 报告与对应原生成功终态共同决定推进/完成；缺失或冲突报告、未知/失败结果、缺少预算用量和无进展有独立暂停/阻塞路径。 |
| 用量与预算 | 目标累计原生结果的输入、输出、缓存创建和缓存读取 token。预算决定是否启动下一步，不按文本长度估算，也不承诺硬截断运行中的单轮。上下文占用沿用独立的原生报告契约。 |
| 数据与前端 | 保留历史、工作区文件、只读 Git diff、图片/文件、资源引用、审批和选择式问题。共享 UI 按 capabilities 读取和启用；当前设置与待生效选择值分开，inspect 为只读 GET。 |
| 传输 | 原 HTTP/SSE 保持兼容；可选 `/api/web/v1/socket` 仅适配受限 JSON 请求，复用 HTTP 鉴权/回执，每帧重新检查权限。握手必须带 Origin；禁止 frame headers/deviceId、任意 RPC、上传字节、历史长读及事件流。 |

详细产品语义与限制见 [Claude Code 托管执行](../docs/agents/claude-code-managed.md)。

## 阶段性自动化证据

以下是 2026-10-09 本地时间（UTC+08:00）取得的阶段结果，之后的整合修改需以下节最终结果为准。

| 阶段命令 / 范围 | 实际结果 | 能证明与不能证明的内容 |
| --- | --- | --- |
| Web 全套 `vitest run`，前端首轮实现后 | 36 文件、663 项通过；取得时间早于 14:32 定向补测 | 包含既有 Codex、阅读、授权、设置、会话恢复及首轮 Claude 前端回归。不是最终整合总数。 |
| 在 `apps/web` 执行 `vitest run src/features/sessions/claude-parity.test.tsx src/features/sessions/composer-layout.test.tsx src/web-client.test.ts`，14:32 | 3 文件、65 项通过 | 使用真实 Provider/controller/WebClient 与合成公共 HTTP 响应；覆盖 generic action、pending/current、队列手动恢复、目标恢复、资源发送、rename、capability gate 和 inspect GET。未调用真实 Backend 或模型。 |
| 在 `apps/desktop` 执行 `vitest run electron/main/web/managed-websocket.test.ts`，14:37 | 1 文件、48 项通过 | 真实 loopback HTTP/WebSocket 连接，覆盖握手授权、Origin、字段注入、路径白名单、单飞、载荷、错误脱敏和关闭竞态；dispatch 使用隔离替身，真实 service/backend 整合另列。 |
| Web 类型检查；Desktop `tsc -p tsconfig.node.json --noEmit --composite false --pretty false` | 阶段通过 | 后一命令用于隔离类型核对，不替代项目最终统一 typecheck/build。 |
| 两个 WebSocket 新文件的 oxlint；本轮前端/适配器 oxfmt；`git diff --check` | 阶段通过 | 仅表示执行时的范围通过，不代表后续整合源码已经复验。 |

前端用例：[claude-parity.test.tsx](../apps/web/src/features/sessions/claude-parity.test.tsx)。传输边界用例：[managed-websocket.test.ts](../apps/desktop/electron/main/web/managed-websocket.test.ts)。

## 最终整合验证表

真实 `WebAccessService → TypeScript Backend → 合成 CLI` 集成已覆盖实际服务、SQLite、进程启动和本地网络。新建会话先握手发现模型但不发送用户轮次。合成回复不是原生 Claude 或真实模型验收。

| 实际命令 / 验收层 | 最终结果与数量 | 证据与限制 |
| --- | --- | --- |
| `pnpm --filter @agentkib/web test` | 36 文件、665 项通过 | Claude/Codex 共享前端、请求恢复、设置、队列、目标和资源回归。 |
| Desktop 宿主 / Backend 相关最终回归（命令如下） | 38 文件、704 项通过 | 含本轮 17 项真实链路集成、48 项 WebSocket 边界、原生协议/SQLite/MCP/调度、Codex、Antigravity ACP 与桌面本地 Claude 既有回归。 |
| `cd apps/desktop && vitest run test/claude-web-backend-integration.test.ts` | 17 项通过 | 实际 HTTP/WebSocket、Backend 和合成 CLI；新建/发送/停止/审批/问答、设置与丢失 ACK、next 追加、资源、改名、分叉、归档、队列/目标、回执与原设备授权。 |
| 同文件 WebSocket 链路；`electron/main/web/managed-websocket.test.ts` | 包含于上项；适配器另有 48 项通过 | 设置读取、排队/删除、发送、断开重连查回执、重试幂等和撤销；路径/字段/CSRF/载荷边界另由适配器与宿主测试覆盖。 |
| 既有宿主权限、LAN 与 Codex 回归 | 包含于上述 704 项 | `service.test.ts`、local/desktop conversation、remote capabilities、Codex live state、托管目录与锁等通过；原 context 测试仅更新为允许已授权 Claude，未放宽未知会话。 |
| `pnpm typecheck` | 通过 | Backend、Desktop 与 Web 全部通过。 |
| `pnpm --filter @agentkib/web build`、`pnpm --filter @agentkib/desktop build:web`、`pnpm --filter @agentkib/desktop electron:build` | 通过 | Web、桌面渲染器、Electron main/preload 与 Backend 打包、原生依赖 staging。未打包发布安装器。 |
| `pnpm lint`；`pnpm format:check`；新测试单独 `oxfmt --check`；`git diff --check` | 均退出 0 | 整仓 lint 仍输出旧文件中的 warning；本次 Backend/宿主生产文件的定向 lint 无警告。只读格式检查覆盖 688 文件。 |

最终宿主/Backend 回归实际命令（在 `apps/desktop` 执行）：

```sh
./node_modules/.bin/vitest run electron/main/web electron/main/ipc/conversation.test.ts electron/main/conversation-hub.test.ts test/claude-*.test.ts test/codex-*.test.ts test/managed-*.test.ts --maxWorkers=4
```

17 项链路和 48 项 WebSocket 边界已包含在 704 项中，不重复累计。Web 665 项为独立测试组。构建使用现有 `ws` 生产依赖，仅给 Desktop 补充已在锁文件内的开发类型依赖 `@types/ws@8.18.2`。

## 主要实现位置

- [Claude owner](../packages/backend/src/claude-managed-read.ts)、[原生 runner](../packages/backend/src/claude-managed-runner.ts)、[Claude 持久状态](../packages/backend/src/claude-host-state.ts)、[私有目标报告](../packages/backend/src/claude-goal-report.ts)。
- [统一 Backend 分派](../packages/backend/src/index.ts)、[宿主 HTTP/权限接口](../apps/desktop/electron/main/web/service.ts)、[共享调度器](../apps/desktop/electron/main/web/claude-scheduler.ts)、[WebSocket 适配器](../apps/desktop/electron/main/web/managed-websocket.ts)。
- [WebClient](../packages/web-client/src/index.ts)、[Desktop 设置控件](../apps/desktop/src/features/sessions/conversation/features/sessions/codex-session-controls.tsx)、[Web 设置控件](../apps/web/src/features/conversation/features/sessions/codex-session-controls.tsx)、[Desktop 会话操作](../apps/desktop/src/features/sessions/conversation/features/sessions/codex-tools.tsx)、[Web 会话操作](../apps/web/src/features/conversation/features/sessions/codex-tools.tsx)、[真实链路测试](../apps/desktop/test/claude-web-backend-integration.test.ts)。

## 故障处理与未执行范围

- 设置原生 ACK 丢失或文件副作用后的回执提交失败保持 `unknown`；当前 `reconcile` 只读取证据，不会把未知结果改为成功，也不自动重试。没有新增跳过核对的恢复入口。
- 突然退出且无法证明进程树已完整清理时，关闭仍报告 `Claude managed runner shutdown failed` 并保留 unknown。集成故障注入明确断言该拒绝，不将它当成正常完成。
- 保持原工作区 `prototypes/`、`target/` 不变；改动位于独立 worktree `claude-remote-parity`，分支 `codex/claude-remote-parity`，未创建提交。精确本机路径仅在本次会话交付中提供。

未执行与边界：

- 未调用用户配置的 Claude CLI/模型完成新增高级功能的真实单轮；本地伪 CLI 的 usage 仅用于验证计量逻辑，不记为实际供应商消耗。
- 未在实体 iOS/Android 上验证触控、软键盘、后台恢复和连接切换；组件测试或桌面尺寸不能替代手机验收。
- 未部署或验证生产中继的 WebSocket 升级、公网配对、实际账号流程；没有修改独立服务端仓库。
- 未以 Windows/Linux 实机验证新增行为；平台禁用测试不等于跨平台托管支持。
- 未把未验证 CLI 版本、后台 Agent 任务、未知问题/审批格式或 Claude Desktop Chat/Cowork 纳入支持范围。
- 本记录属于开发实现与自动化验收，不声明发布版本已提供这些功能。


## origin/main 审查—修复循环

用户明确要求建立 goal，使用 `code-review` 技能的 Standards / Spec 子代理，以两个维度都 no findings 为结束条件。固定基准为任务开始时 `origin/main` 解析到的 `fb9c39469e4600f9a94e175adc1f06e75df4921d`；审查包含该基准后的两个 quota 提交、全部未提交修改和新增文件。共享远端跟踪引用后来变化，循环仍使用已固定的 SHA，不中途改变比较范围。

- 第一轮 Standards 1 项、Spec 3 项，另有 quota 专项 1 项并入 Spec：文件资源绕过既有敏感路径保护、缺失用量后可继续有限预算目标、纯文本队列更新可加入附件、队列状态丢失导致已派发项参与重排，以及嵌套 JSON 编码空白绕过凭据脱敏。
- 修复资源链路复用 ArtifactService，拒绝硬链接与祖先符号链接；持久记录预算缺口并仅在实际补账或明确移除预算后恢复；固定队列附件和原设备、透传状态并只操作 pending 项；完善 quota 字段分隔符脱敏。补测还修复了确定拒绝被当作 unknown 的回执边界，以及队列空响应造成的既有 Codex 恢复界面异常。
- 第二轮 Spec no findings；Standards 2 项：原生标题写入未拒绝硬链接目标，以及本记录保留真实本机路径。标题写入现于外部 claim 前检查单链接，打开后及写入后复验链接数和文件身份；硬链接回归先复现失败，再验证拒绝且备份字节不变。记录中的路径已脱敏。
- 第三轮 Standards / Spec 均为 **no findings（0 项）**，没有剩余最高严重度问题，满足循环结束条件。总计修复 7 项审查发现，另修复补测暴露的回执与空响应边界。

第一轮修复后的实际验证：Desktop 宿主/Backend/额度 43 文件、825 项通过（包含真实链路 21 项）；Web 36 文件、668 项通过。Web 首次全套运行发现 1 项队列空响应回归，修复后重跑全套通过。`pnpm typecheck`、Web / Desktop renderer / Electron main/preload/Backend 构建、`pnpm lint`、`pnpm format:check`、新增测试定向格式检查与 `git diff --check` 均退出 0；lint 保留既有 warning。第二轮标题保护后的验证单列，避免将旧结果当作最终源码验证。

本轮扩展宿主/Backend/额度命令（`apps/desktop`）：

```sh
./node_modules/.bin/vitest run electron/main/web electron/main/ipc/conversation.test.ts electron/main/conversation-hub.test.ts test/claude-*.test.ts test/codex-*.test.ts test/managed-*.test.ts test/quota-owner.test.ts src/features/quota/QuotaDiagnostics.test.tsx src/features/quota/QuotaDisplay.test.tsx src/features/quota/QuotaPage.test.tsx src/features/quota/quota-query.test.tsx --maxWorkers=4
```


第二轮标题保护后的最终验证（`apps/desktop`）：

```sh
./node_modules/.bin/vitest run test/claude-managed-parity.test.ts test/claude-host-state.test.ts test/claude-web-backend-integration.test.ts --maxWorkers=3
```

结果 **3 文件、57 项通过**，包含新增标题硬链接保护回归和全部 21 项真实链路测试。最终 Backend typecheck、Backend build 与原生 staging、改动生产文件定向 oxlint、全仓 `format:check`（688 文件）、Claude/额度测试文件定向只读格式检查及 `git diff --check` 均通过。此前 Web 668 项及其构建不受最后两项标题保护/文档修复影响；测试数量分组保留，不将重叠用例重复累计为总数。原工作区仍仅有原来的 `prototypes/`、`target/` 未跟踪目录，HEAD 与创建 worktree 前一致；没有提交、推送或发布。

## 后续独立审查与三项修复

后续重新审查时，`origin/main` 固定为 `23677dacd01c117c4059cf1b037c3ca7fd281d0f`。该引用与当前 HEAD 的三点提交差异为空，实际审查范围为全部未提交修改和新增文件。本次独立审查发现 Spec 两项 P2 与 Standards 一项 P3 判断性建议；此前循环的 no findings 不代表后续不会发现问题。

- 设置：原实现会把未选择的权限模式补为 `default`，仅改模型也会覆盖 CLI 继承的 Plan 模式。现将显式选择与原生有效值分开，未回报字段保持未知；Backend 和共享前端只派发本次修改字段。恢复默认清除会话覆盖，重新继承 CLI 配置；显式选择 `default` 与未选择分开处理。
- 分叉：尚未首次发送的分叉在释放、重新接管后丢失来源和截止点。现保留父 UUID、截止点和子 UUID，并校验元数据、将分叉信息纳入接管指纹。新增同进程及跨 Backend 重启回归，检查首次发送的原生 fork 参数和准备阶段没有用户输入。
- 重命名：移除宿主状态写入时的重复名称校验，复用副作用之前已校验的标题。空白、控制字符和超长 UTF-8 标题均在宿主及原生日志写入前拒绝，回执保持 `not-dispatched`。

权限继承和分叉重新接管的新回归先复现失败，再验证修复。真实 `WebAccessService → TypeScript Backend → 合成 CLI` 链路增加 HTTP 设置、WebSocket 回读与分叉生命周期验证。两个独立子代理按 `code-review` 的 Standards / Spec 分别复核本轮三项修复及相邻路径，均为 **no findings（0 项）**；这是本轮修复范围的复核结果。

| 本轮最终验证 | 实际结果 |
| --- | --- |
| Desktop 宿主 / Backend 相关回归（上文 38 文件命令） | **38 文件、732 项通过**，包含实际服务到合成 CLI 的 **23 项**集成测试，以及 Codex、Antigravity、本地 Claude 相关回归。 |
| `pnpm --filter @agentkib/web test` | **36 文件、674 项通过**。首次运行有 1 项既有归档测试等待按钮超时；目标用例、所属完整文件 184 项和最终全套复测均通过，未修改该测试或相关会话壳。具体首次失败原因未确定。 |
| `pnpm typecheck` | Backend、Desktop、Web 均通过。 |
| Web `build`、Desktop `build:web`、Desktop `electron:build` | 全部通过，包含 Electron main/preload、Backend 构建和原生依赖 staging。 |
| `pnpm format:check`、三个变更 Desktop 测试文件 `oxfmt --check`、变更 Backend 生产文件 `oxlint`、`git diff --check` | 均通过；全仓只读格式检查覆盖 688 文件。 |

原工作区仍只有原有的 `prototypes/`、`target/` 未跟踪目录，HEAD 未变。本轮没有提交、推送、发布或调用真实模型；真实 Claude 模型与实体手机验收仍未执行。

## effort 设置链路复审与修复

随后以同一 `origin/main`（`23677dac…`）重新审查全部 WIP，Standards 为 0 项，Spec 新发现两项 P2：继承原生模型时单独设置 effort 被宿主拒绝，以及切换模型时界面清空的旧 effort 未传递到 Backend。真实 Service → Backend → 合成 CLI 的仓库外探针分别复现 HTTP 400 `unsupported_effort` 和 HTTP 409 `control_preflight_rejected`，之后将回归纳入仓库。

本轮修复：

- 宿主按字段回退到原生当前模型；从 CLI 初始化目录保留并校验 `resolvedModel`，用于实际模型 ID 与可选别名的匹配。仅修改 effort 不额外提交模型或权限选择。
- Claude 的 `effort:null` 明确清除单项覆盖，省略字段仍表示保留。共享前端在用户选择 effort 默认值、或切换模型后旧 effort 不兼容且没有合法默认值时提交清除意图。Codex 保持原有协议，并拒绝误传该 Claude 专用空值。
- 静态核对本机 CLI `2.1.286` 确认原生 `effortLevel:null` 进入 native default，不能等同于继承项目/用户配置。因此 Backend 在空闲状态以保留的模型、权限选择重新准备 runner，移除 effort 启动覆盖；准备过程不发送模型输入，确认失败保持 unknown。当前行为与后续重启一致。
- UI 只在更大的 revision、原生确认且该项覆盖已移除后显示设置成功。故障回归还发现失败清理与宿主关闭可同时冻结同一进程树，现共享一次进行中的清理操作，保留原有失败、进程身份校验和 unknown 语义。

新增测试包含直接模型 ID/别名下的 effort-only、切换到仅支持低 effort 或不支持 effort 的模型、单项清除及保留权限、重启参数、初始化 ACK 失败、并发关闭、WebSocket 幂等重放与同请求不同输入冲突。新增用例先复现失败，再验证修复；另对 UI 旧 revision 保护做了反向验证。

本轮 Spec 复核还通过仓库外 React/WebClient 探针确认：多个模型别名解析到同一实际 ID 时，按首个别名反查会导致已成功的设置一直待确认。现按用户选定的别名精确匹配，原生模型未知或为空时仍不确认；新增永久回归先红后绿，原失败探针也复测通过。本轮修复及相邻边界的最终 Standards / Spec 复核均为 **no findings（0 项）**。

本轮最终验证（测试组重叠，不重复累计）：

- Desktop 宿主/Backend：上文 38 文件回归命令，**38 文件、742 项通过**，包括真实链路 **28 项**。
- `pnpm --filter @agentkib/web test`：**36 文件、683 项通过**，为最后的多别名确认修复后全套结果。
- 定向 runner/owner/retirement/ACP：**4 文件、105 项通过**；共享 UI/布局/WebClient：**3 文件、83 项通过**。
- `pnpm typecheck`；Web `build`、Desktop `build:web`、Desktop `electron:build` 全部通过。
- `pnpm format:check`（688 文件）、三个变更 Desktop 测试文件 `oxfmt --check`、变更 Backend/宿主生产文件 `oxlint`、`git diff --check` 均通过。

原工作区及 HEAD 保持不变；没有提交、推送或发布。本轮 CLI 契约核验仅静态读取安装文件，未启动真实 CLI 或调用模型，手机与生产中继验收仍未执行。

## PR 前完整只读复审

在上述修复完成后，再以 `origin/main`（`23677dacd01c117c4059cf1b037c3ca7fd281d0f`）固定基准，使用独立 Standards / Spec 子代理检查全部 27 个已修改文件和 14 个新增文件。两轴均为 **no findings（0 项）**；审查前后文件内容快照一致，没有修改代码。

本次复审额外执行以下离线测试，测试组互不重叠，合计 **8 文件、178 项通过**：

- 在 `apps/desktop` 执行 `./node_modules/.bin/vitest run test/claude-host-state.test.ts test/claude-managed-parity.test.ts test/claude-runner-parity.test.ts test/claude-goal-report.test.ts`：4 文件、70 项通过。
- 在 `apps/desktop` 执行 `./node_modules/.bin/vitest run electron/main/web/claude-scheduler.test.ts electron/main/web/managed-websocket.test.ts test/claude-web-backend-integration.test.ts`：3 文件、82 项通过。
- 在 `apps/web` 执行 `./node_modules/.bin/vitest run src/features/sessions/claude-parity.test.tsx`：1 文件、26 项通过。

`git diff --check` 通过。此前 742 项 Desktop 回归、683 项 Web 回归、类型检查与构建的结果仍对应本次提交的生产代码。本轮没有真实模型、实体手机、生产中继或手动 UI 截图验收。

用户随后授权提交 PR。交付采用独立的 Claude Remote 功能提交及额度诊断脱敏修复提交；前文“未提交、推送”的说明仅描述各阶段当时状态，不表示 PR 交付阶段仍禁止 Git 操作。
