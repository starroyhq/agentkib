# 会话管理与网页预览 QA（2026-10-28）

分支 `feat/session-management`（叠在 `feat/codex-gaps` 上）。按用户决定：删除是永久删除；AgentKib 不再有自己的归档，归档只走对应 Desktop（Codex 的 `thread/archive`）；允许远程浏览器查看电脑上正在运行的网页。全部使用合成数据；真实 CLI 只在隔离 HOME/CODEX_HOME、sandbox-exec 禁网的环境里运行。

## 范围

提交号是 2026-10-29 rebase 到修正后的 `feat/codex-gaps` 之后的。

| 提交 | 内容 |
| --- | --- |
| `d3fe4cab4` | `compact`、`terminals-clean` 能送到后端（runtime-router 与 backend 的四张清单都缺） |
| `7462b6b37` | 电脑端的 `compact`、`terminals-clean` 能送到主机（第五张清单；在 `feat/codex-gaps` 上） |
| `bb28be1f0` | Codex 后端永久删除（`thread/delete`） |
| `f9c2a9fc9` | 删除需要整理权限，并移除会话的上传文件 |
| `2a7cc6c8c` | 会话操作里的删除与确认 |
| `c965a85b1` | Claude Code 会话永久删除 |
| `c4c78de28` | 去掉 AgentKib 自己的 Claude 归档 |
| `2fdc725cf` | 会话列表每行的会话菜单 |
| `4fa2565cb` | 电脑端网页预览 |
| `c31267ae3` | 远程浏览器的网页预览 |
| `f24d96d05` | 文档与本记录 |
| `76469953c`、`53fb82ed1`、`4a404d9c5`、`d942edcd3`、`2cf3b7979` | 真实程序里发现的问题的修复，见下节 |

## 在真实运行的 AgentKib 里核对（2026-10-29）

前面的核对都是单元测试和拼装的探针。这一轮把本分支构建出来的电脑端（web、renderer、backend、main 四个构建）在隔离环境里实际跑起来，按用户的操作走一遍：

- 环境：独立 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR 和 AgentKib 数据目录；sandbox-exec 只放行回环网络，个人目录一律拒绝。合成的 Claude 会话 3 个；Codex 会话 2 个，其中一个由真实的 Codex 0.163.0 `thread/start` 创建并用 `thread/name/set` 命名，另一个合成后由真实 app-server 建立索引。工作区里是真实的 Vite 8.3.4 项目（开发服务器在运行），另有一个发送 `X-Frame-Options: DENY` 的本地页面。
- 电脑端经 CDP 操作（playwright-core 的 `connectOverCDP`），远程浏览器是无头 Chrome 156（临时配置），用 AgentKib 生成的完整控制配对码连接 `http://127.0.0.1:<端口>`。

### 发现并修复的问题

| 提交 | 问题 | 怎么发现的 |
| --- | --- | --- |
| `76469953c` | 网页预览只扫描消息正文；开发服务器的地址只出现在终端工具的输出里，“网页预览”列不出它 | Vite 会话的地址列表是空的 |
| `53fb82ed1` | 主机按设备权限改写 Claude 能力时，对照表没有 `delete`，删除对任何设备都回 `permission_denied` | Claude 会话的“删除”不可用 |
| `7462b6b37`、`4a404d9c5` | 电脑端界面经 IPC 走 `localRequest`，先过 `isConversationPath`；这张清单没有 `delete`、`compact`、`terminals-clean`，都回 404 `not_found`（未发出），界面只说“这台电脑未提供或尚未验证此能力”。浏览器走 HTTP，不受影响 | Codex 会话菜单里“删除”可用，点了失败；同一通道发 rename、archive 能到主机 |
| `d942edcd3` | 网页的样式表没有 `data-horizontal`/`data-vertical` 变体（电脑端来自 `shadcn/tailwind.css`），“文件与产物”面板横向排列，内容被挤出窗口；main 上已经如此 | Chrome 截图与计算样式（`flex-direction: row`） |
| `2cf3b7979` | 未命名会话的“⋯”按钮没有说明（`title` 为空） | 电脑端与网页的无障碍树 |

每项修复都有对应测试（去掉修复后失败），修复后在同一个环境里重新构建、重新核对。

### 电脑端

- 网页预览：从 Bash 工具输出里识别出 `localhost:<Vite 端口>/`；点了才加载，Vite 页面正常显示；改源文件后页面自动热更新；前端路由 `/about` 正常。发送 `X-Frame-Options: DENY` 的页面能嵌入显示。“在浏览器中打开”调用系统浏览器打开同一地址。
- Claude 删除：会话菜单只有“重命名”（这台电脑未验证，不可用）和“删除”，没有归档；确认框说明从 Claude Code 中删除、不能恢复；确认后 `<id>.jsonl` 被删除，这一行从列表消失。
- Codex 删除（修复后）：菜单有重命名、归档、删除；确认后真实 Codex 删除了 rollout 文件、`state_5.sqlite` 的 `threads` 行和自己的 `session_index.jsonl` 条目，AgentKib 的索引行也删了，没有报错。
- 修复后，经电脑端通道发 `rename`、`archive`、`delete`、`compact`、`terminals-clean`（用不存在的会话）都到达主机，回 403 `workspace_not_authorized`，不再是 404。
- 回执：四次删除（两端各删一个 Claude、一个 Codex 会话）都记为 `resolved`、`deleted: true`；电脑端的记为 `desktop-local`，网页的记为配对浏览器的设备。

### 远程浏览器（Chrome）

- 配对后会话列表、会话菜单正常；Claude 会话菜单同样只有重命名（不可用）和删除。
- 面板修复后，网页预览列出同一个 Vite 地址；打开后 iframe 位于预览源，经引导页和 Service Worker 显示 Vite 页面；前端路由正常；“重新加载”显示改动后的内容。
- 这台测试机上热更新也生效了：Chrome 直接连上了开发服务器的 WebSocket（`lsof` 看到 Chrome 与 Vite 端口之间的连接，没有经过 AgentKib）。这正是文档里“同一台电脑上的浏览器有时能直连”的情况；另一台设备上的浏览器连不到，需要点“重新加载”。
- 代理（经手动输入端口打开回显请求头的本地页面）：浏览器存有 127.0.0.1 的 `ak_web_local`（HttpOnly），本地页面收到的 Cookie 里没有它；页面自己写的 `demo_cookie` 照常送达。`Host` 为 `localhost:<端口>`，页面内链接跳转到 `/next?x=1` 后 `Referer` 为 `http://localhost:<端口>/`。发送 `X-Frame-Options: DENY` 的页面能在面板里显示。
- 删除：网页菜单删除 Claude 会话后 `<id>.jsonl` 被删除；删除 Codex 会话后 rollout、`threads` 行和 `session_index.jsonl` 条目都没了，列表立即去掉这一行。

### 记录

- Claude 删除后，项目目录的 `sessions-index.json` 里仍有这条会话。Claude Desktop 2.37337 的 `app.asar` 里没有 `sessions-index` 字样，它的删除也不改这个文件；AgentKib 读取时丢掉没有记录文件的条目，删掉的会话不会再出现。
- Codex 删除后，`codex-managed/managed-<id>.lock` 留下一个空文件。会话租约释放时只解锁不删文件（删锁文件有竞争），所有被托管过的会话都是这样，与删除无关。
- `managed-websocket.ts` 的 Codex 操作清单与修复前的 IPC 清单相同，没有改：仓库里没有客户端用这个 socket，文档也写明它比 IPC 窄。
- 沙箱里 `/bin/ps` 是 setuid 程序，sandbox-exec 默认拒绝执行，Claude 的进程归属检查因此回 `claude-owner-check-unavailable`；测试时单独放行 `/bin/ps`。真实环境没有这个限制。

## 协议与平台核对（单独的探针）

- **Codex 0.163.0**（隔离 CODEX_HOME、禁网）：`thread/delete {threadId}` 返回 `{}`，已归档和未归档都能删，删除 rollout 与 `threads` 行，发出 `thread/deleted`。再删或删不存在的线程返回 -32600 `no rollout found for thread id <id>`；非法 ID 返回 `invalid thread id`；别的进程持有写入锁时返回 `thread <id> already has an active writer`。0.147.0 的 schema 也有 `thread/delete`（`node .github/scripts/codex-protocol-compatibility.mjs --version minimum` 的差异为空）。
- **Claude Desktop 2.37337**：静态分析 `app.asar` 的 `index.chunk-BolytlRP.js`（`fC`、`RR`、`mayReapTranscript`），得到它删除 Claude Code 会话时移除的文件清单，AgentKib 照此删除；Desktop 记录 `claude-code-sessions/**/local_*.json` 的 `cliSessionId` 指向该会话（含已归档）时拒绝。只读分析，没有运行 Claude Desktop。
- **Electron 44**（合成本地服务器）：`onHeadersReceived` 的过滤器 `http://localhost/*` 匹配所有端口；子框架响应的 `details.frame` 是被加载的框架；去掉 `X-Frame-Options` 和 `frame-ancestors` 后页面能嵌入，页面里再嵌的框架仍被拦；`localhost` 的 iframe 能连到只监听 127.0.0.1 的服务器。
- **Chrome（playwright-cli，无头）**：真实 `LivePreviewService` 加合成 SPA 开发服务器、合成 AgentKib 页面，全部在回环地址。
  - 首屏落在 `/start?x=1#frag`，`location.pathname` 为根路径；根相对的 `/api/hello` 和 `/assets/app.js` 到达开发服务器，`Host` 为 `localhost:<端口>`，`Sec-Fetch-Dest` 分别为 `iframe`、`script`、`empty`。
  - `pushState`、链接跳转（`/second?y=2`）、表单 POST（`q=posted`）都正常；iframe 地址不含票据。
  - 浏览器确实把 `ak_web_local` 发给预览端口（预览源的 404 请求里看得到），开发服务器收到的请求都没有它。
  - 票据地址在新标签页打开、再刷新都正常。
  - `[::1]` 上的另一个站点链接、POST 到预览源的 `/delete`：都落到预览源的 404，开发服务器没有收到；那个页面的图标请求也没有转过去。

## 自动化

新增测试：`codex-auto-continue.test.ts`（Codex delete 与控制路由）、`session-forget.test.ts`、`claude-delete.test.ts`、`claude-host-state.test.ts`（旧归档迁移）、`codex-actions.test.ts`、`attachments.test.ts`、`codex-tools-delete.test.tsx`、`fork-completion-controller.test.tsx`、`SessionRowMenu.test.tsx`、Web 的 `codex-features.test.tsx`、`session-row-menu.test.tsx`、`claude-parity.test.tsx`，以及网页预览的 `live-preview-frames.test.ts`、`live-preview.test.ts`（代理、票据、Service Worker）、`live-preview-route.test.ts`、电脑端与 Web 的 `live-preview.test.tsx`。

变异测试（每次只改一处，跑对应测试）：

| 部分 | 变异体 | 结果 |
| --- | --- | --- |
| Codex 删除后端 | 15 | 14 杀死；1 个等价（后端对运行中轮次的重复检查） |
| 主机权限与上传清理 | 5 | 全部杀死 |
| 删除界面 | 6 | 全部杀死 |
| Claude 删除 | 12 | 全部杀死 |
| 去掉 Claude 归档 | 5 | 全部杀死 |
| 会话菜单 | 6 | 全部杀死 |
| 电脑端网页预览 | 20 | 全部杀死 |
| 远程网页预览 | 51 | 全部杀死（首轮 3 个存活，补测试后杀死：引导页防循环、只读浏览器不探测端口、迟到的票据） |

全量结果见下节。

## 全量验证

在 rebase 前的远程网页预览提交（内容与 `c31267ae3` 相同）上运行。期间这台电脑还跑着其他项目的负载（load average 350–900），几项超时与此有关，单独重跑记录在后。上一节的修复之后重跑了格式、lint、tsc 和相关测试，见本节末尾。

| 检查 | 结果 |
| --- | --- |
| `pnpm format:check` 的范围（oxfmt） | 通过 |
| `pnpm lint` 的范围（oxlint） | 0 错误，276 个警告，与基线相同 |
| backend、desktop、web 的 `tsc` | 通过 |
| `node --test .github/scripts/*.test.mjs` | 通过 |
| Web 全量 | 1662/1663；`history-search-display` 的一项等待超时，单独重跑 12/12 通过 |
| desktop 项目（`--maxWorkers=6`） | 8758 通过、3 跳过、1 失败：`claude-web-backend-integration` 的 “goal automation for missing-usage” 超过 5 秒；`--testTimeout=30000` 重跑该文件 38 通过、1 跳过 |
| filesystem 项目 | 默认超时下 9 个技能同步文件的 37 项超时（5 秒测试、10 秒钩子）；`--testTimeout=60000 --hookTimeout=60000` 重跑 391/391 通过。这些文件不涉及本分支的改动 |
| mcp-latency 项目 | 62/62 通过 |
| `electron/main/web` 全部（改动 service.ts 后） | 26 个文件、587 项通过 |

修复之后（`2cf3b7979`）：

| 检查 | 结果 |
| --- | --- |
| oxfmt、oxlint | 通过；0 错误，276 个警告（与基线相同） |
| desktop、web 的 `tsc` | 通过 |
| Web 全量 | 76 个文件、1664/1664 通过 |
| desktop 相关部分（`electron/main/web`、`electron/main/ipc`、`runtime-router`、`src/features/sessions`、`claude-delete`、`session-forget`、`codex-auto-continue`） | 104 个文件，2027 通过、1 失败：`relay/manager.test.ts` 的 “kills an frpc that ignores SIGTERM” 在机器繁忙时偶发，单独重跑 63/63 通过；本分支没有改动 relay |

## 已知的不稳定

- `claude-web-backend-integration` 的 “goal automation for missing-usage” 在基线上就要 3.5–4.7 秒，机器繁忙时会超过 5 秒默认超时，与本分支无关（已对比基线）。
- Web 的历史搜索测试在全量并发时偶尔超时，单独运行通过。
- `relay/manager.test.ts` 的 “kills an frpc that ignores SIGTERM”：假 frpc 启动后 300 毫秒内若还没装上忽略 SIGTERM 的处理，就会被 SIGTERM 结束，断言失败。机器繁忙时出现过两次，单独重跑都通过。

## 未验证

- Safari、Firefox 的网页预览（Service Worker 在第三方 iframe 中的分区、`resultingClientId`）；实体手机；生产中继。
- 删除 Codex 父线程时子代理线程是否一并删除（离线无法生成子代理）。
- Claude Desktop 记录只在 macOS 的 `~/Library/Application Support/Claude/claude-code-sessions` 检查；其他系统不做这项检查。Claude Desktop 2.37337 以外的版本未核对删除清单。
- 集合（collection）里的 Codex 会话没有注册工作区，删除与归档一样不可用。
- 用量统计（只有 token 数）不随会话删除。
