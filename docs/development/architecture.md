# 架构约定

## 进程与包

| 部分 | 位置 | 职责 |
| --- | --- | --- |
| 本机后台 | `packages/backend`，Electron 入口 `apps/desktop/electron/backend-entry.ts` | 管理工作区、会话发现和原生历史、设置、项目 Agent 编排、资源及本机数据。通过 Provider 实现会话读写。 |
| Electron 主进程 | `apps/desktop/electron/main` | 管理窗口、托盘、更新和其他系统集成，连接本机后台，提供 IPC 和远程传输，并在入口鉴权。 |
| Preload 与前端 | `apps/desktop/electron/preload`、`apps/desktop/src`、`apps/web/src` | Preload 提供收窄的桌面 IPC 接口。桌面和 Web 应用各自负责导航及平台接线，共用会话界面和主机客户端。 |
| 共享会话界面 | `packages/session-ui`、`packages/conversation-state`、`packages/session-catalog` | 共用会话组件、状态和目录。桌面和 Web 通过各自的 `session-platform` 注入组件、客户端及平台操作。 |
| 远程访问 | `apps/desktop/electron/main/web`、`apps/desktop/electron/main/push` | Web 和手机通过局域网或账号中继访问主机 HTTP API，使用配对设备凭据。主机在 HTTP 边界处理请求来源、CSRF、限流和 SSE，通知经中继投递。手机客户端位于独立 Flutter 仓库。 |
| 协议 | `packages/runtime-protocol`、`packages/web-client` | Runtime 协议包定义方法、数据结构及 Provider 声明。Web 客户端封装主机 HTTP API，供 Web 以及桌面会话适配层使用。 |

同一用户下，同版本的开发版和正式版通过已认证的本地 socket 或命名管道，以 JSON-RPC 连接单个共享后台 `backend.cjs --local-runtime`。后台持有独占锁，下一版本在旧后台退出后接手。隔离开发模式使用独立数据目录和运行时。

## 协议契约与版本

主机与客户端共用的协议版本、能力键、路由及错误码以 [`packages/runtime-protocol/remote-contract.json`](../../packages/runtime-protocol/remote-contract.json) 为准。改契约后运行 `node packages/runtime-protocol/scripts/generate-remote-contract.mjs`，更新 TypeScript 和 Dart 产物。CI 检查产物与契约一致。

主版本和最低版本的兼容范围、按能力启用功能的方式，以及旧版客户端的处理见[远程协议与版本兼容](../remote/protocol-compatibility.md)。

## 一条会话请求

1. 以发送消息为例，用户在共享会话界面提交 `/api/web/v1/managed/action` 请求。桌面经 preload 进入会话 IPC，主进程核验发送方，再由 `WebAccessService.localRequest` 用 `desktop-local` 身份调用主机路由。Web 和手机经主机 HTTP API 访问同一个路由。
2. 主机校验设备凭据和工作区权限，将会话请求交给 `runtime-router`，经 `session.request` 到后台。后台的会话路由选择 Provider，由它核对原生会话和执行环境，再通过 app-server、托管 CLI、桥接插件或 ACP 执行。
3. 控制结果经原请求返回。后台的会话事件通过 JSON-RPC 通知进入主进程，再由桌面会话事件订阅或远程 SSE 返回界面。

## 代码放置与入口

- **后台负责业务判断。** 会话准入、能力解析、控制回执、幂等和已提交结果的核对归后台。主进程负责窗口、系统集成、传输与鉴权。现有主机服务仍有历史业务逻辑，改动到这些路径时应复用后台已有实现。
- **新会话功能走统一入口。** 在 `session.request` 和 Provider 中扩展。远程会话扩展使用当前主机接口（托管控制为 `/api/web/v1/managed/*`）。`web.request`、`claude.managed`、`codex.managed` 和远程 `/api/web/v1/codex/*` 仅保留既有兼容行为。
- **Agent 差异由 Provider 声明。** 在 `packages/runtime-protocol/src/session-providers.ts` 声明能力，在 `packages/backend/src/agents/` 下实现。调用方读取能力和会话当前状态，据此选择控件与操作。Provider 声明和各 `agents/` 目录之外，禁止新增 Agent 名称字面量判断。
- **共享会话 UI 在 `packages/session-ui` 实现一次。** 桌面和 Web 通过 `session-platform` 接入客户端、导航、组件和原生操作。新增平台差异扩展注入接口，共用逻辑留在共享包。
- **新增兼容分支要登记。** 兼容、旧版和兜底分支都要注明位置、保留理由、支持版本和删除条件。提交前登记到[兼容代码登记表](compat-registry.md)。

## 界面状态反馈

1. 等待 300 毫秒以内完成时，保持原有界面。超过 300 毫秒再显示无文字反馈。
2. 局部读取或提交在控件原位转圈、置灰，保持尺寸和原标签。
3. 区域首次加载使用与内容结构一致的骨架屏。预计超过 3 秒且阶段可说明的长任务才显示简短进度文字。
4. 触发器只显示一个当前值。历史值和生效说明放在悬停提示或展开后的副标签。
5. 内部协议状态留给诊断和核对界面。需要防止重复提交时，保留明确的阻塞说明和核对入口。
6. 对话框先呈现标题、内容区域和操作栏。未就绪的操作置灰，取消保持可用。
7. 用界面更新确认结果。复制等缺少可见结果的操作可在原控件短暂切换为对勾。
8. 文字用于标签、可恢复的错误、危险确认及需要用户处理的阻塞。会话交接的显式操作放在连接面板，远程界面只显示能远程完成的操作。

界面用词和语言分支见[界面术语约定](ui-terminology.md)。

## 会话记录读取

- 同一原生文件按文件身份共享读取器，并合并同时发起的读取。校验大小、修改时间及续读位置，追加时从上次位置读增量并接上未完成的行。截断、替换或改写时重建窗口。
- 首屏从尾部读取，最多 20 轮和 4 MiB。更早的记录用游标分页。目录元数据可以使用既有的开头和尾部小窗口。先识别记录类型，只解析需要的行，跳过未知类型和坏行。工具输出和长内容按需取用，单次最多读 64 KiB 并标注截断。
- 以 64 KiB 为块异步读取并让出事件循环。单次主线程工作不超过 50 ms，实时追加通常不超过 5 ms。单个读取器内存控制在 32 MiB 以内，缓存总量有上限并淘汰最久未用的条目。重启可从已校验的派生状态快照续读。以 1 GiB 合成记录核对读取字节、主线程延迟和内存峰值。
- 订阅和读取故障按会话隔离，前端重连使用有上限、带抖动的指数退避。操作回执只核对该次写入的字节范围。原生子进程按会话或工作区复用，限制并发数，空闲或失败后回收并确认退出，再归还进程名额。
- 诊断记录读取字节、解析耗时、缓存命中及事件循环卡顿的来源。诊断只包含元数据，未知记录类型同类最多记一次。

## 自动检查

从仓库根目录执行 `node scripts/check-architecture.mjs`。CI 在同一质量任务的 Lint 步骤后运行架构检查。

| 检查 | 规则 |
| --- | --- |
| Agent 名称判断 | 在 TS/TSX 的比较和 `switch` 分支中，统计 Agent 名称字面量。既有文件不得超过各自基线，新文件不得新增；Provider 声明和 `agents/` 目录豁免。 |
| 产品代码文件行数 | 统计 `apps/` 和 `packages/` 下的产品源文件实际行数。新文件最多 1500 行，已有超限文件只减不增，测试和测试夹具不计。 |
| 兼容代码登记 | 自动检查 `apps/` 和 `packages/` 中新增含 `legacy`、`compat`、`fallback` 的 TS 和 JS 标识符及注释。登记使用相同文件路径和源码标识符或注释片段。 |

远程契约的生成物 `packages/runtime-protocol/src/generated/remote-contract.ts` 和 `packages/runtime-protocol/generated/remote_protocol.g.dart` 不纳入 Agent 名称判断与产品代码行数检查。生成的 TypeScript 仍参与兼容代码登记检查。

删除存量判断、缩短超限文件或清理兼容代码后，用 `node scripts/check-architecture.mjs --tighten` 更新基线。此命令只能减少既有记录。CI 还对照变更前的基线，防止手工提高限额。
