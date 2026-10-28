# 会话管理与网页预览 QA（2026-10-28）

分支 `feat/session-management`（叠在 `feat/codex-gaps` 上）。按用户决定：删除是永久删除；AgentKib 不再有自己的归档，归档只走对应 Desktop（Codex 的 `thread/archive`）；允许远程浏览器查看电脑上正在运行的网页。全部使用合成数据；真实 CLI 只在隔离 HOME/CODEX_HOME、sandbox-exec 禁网的环境里运行。

## 范围

| 提交 | 内容 |
| --- | --- |
| `d3fe4cab4` | `compact`、`terminals-clean` 能送到后端（runtime-router 与 backend 的四张清单都缺） |
| `8e3a9279e` | Codex 后端永久删除（`thread/delete`） |
| `08ba6aaa3` | 删除需要整理权限，并移除会话的上传文件 |
| `8699f0e06` | 会话操作里的删除与确认 |
| `df8084ed5` | Claude Code 会话永久删除 |
| `71b3da863` | 去掉 AgentKib 自己的 Claude 归档 |
| `ea698b483` | 会话列表每行的会话菜单 |
| `618e9220d` | 电脑端网页预览 |
| `cd8a29a85` | 远程浏览器的网页预览 |

## 真实程序核对

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

在 `cd8a29a85` 上运行。期间这台电脑还跑着其他项目的负载（load average 350–900），几项超时与此有关，单独重跑记录在后。

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

## 已知的不稳定

- `claude-web-backend-integration` 的 “goal automation for missing-usage” 在基线上就要 3.5–4.7 秒，机器繁忙时会超过 5 秒默认超时，与本分支无关（已对比基线）。
- Web 的历史搜索测试在全量并发时偶尔超时，单独运行通过。

## 未验证

- Safari、Firefox 的网页预览（Service Worker 在第三方 iframe 中的分区、`resultingClientId`）；实体手机；生产中继。
- 删除 Codex 父线程时子代理线程是否一并删除（离线无法生成子代理）。
- Claude Desktop 记录只在 macOS 的 `~/Library/Application Support/Claude/claude-code-sessions` 检查；其他系统不做这项检查。Claude Desktop 2.37337 以外的版本未核对删除清单。
- 集合（collection）里的 Codex 会话没有注册工作区，删除与归档一样不可用。
- 用量统计（只有 token 数）不随会话删除。
