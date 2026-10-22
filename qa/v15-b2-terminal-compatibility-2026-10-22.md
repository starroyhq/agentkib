# v15 B2：连接终端版本兼容实施与验证

日期：2026-10-22。从合入 B 的 main `296de6167c0a16ff41021f58563b0bc4b19c4e90` 开始，分支 `codex/v15-b2-terminal-compatibility`。前置证据见 [调研记录](v15-b2-terminal-compatibility-research-2026-10-22.md)。本记录只涉及 B2，不扩展 B 的其他界面修订、C/D 或后台续接行为。

## 兼容规则与改动

| 项目         | 实现与验证边界                                                                                                                                                                                                                                                          |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 单一策略来源 | `packages/claude-bridge-plugin/hooks/compatibility.js` 同时供插件、Runtime 和前端使用，随插件产物打包并计入 SHA256。最低稳定版 `2.1.301`；插件合约 `0.2.0`；私有协议仍为 1。                                                                                            |
| 已验证版本   | `verifiedCliVersions` 目前只有 `2.1.301`，依据既有原生只读验收。更高版本不再要求与它相等。                                                                                                                                                                              |
| 更高且未验证 | 完整能力检查通过后允许只读连接，桌面向导及桌面/Web 现有会话页显示中性灰字。未因静态或合成宿主测试把 307/308 加入已验证清单。                                                                                                                                            |
| 明确不兼容   | 低于最低版、无法识别的版本、旧插件/私有合约不匹配、缺少必需能力分别拒绝。界面区分更新 CLI、按第 1 步更新插件及继续在终端使用。拒绝时隐藏并清除旧连接命令；后续状态读取失败也不会恢复旧命令。                                                                            |
| 显式能力检查 | 每次配对及实际重连调用并检查 `session.id/cwd/version/messages/usage`、独立 `store.set/get` 往返、`fs.read` 读取插件自身 manifest。不使用 Mods 不支持的 host 反射。命令注册和计时器沿用实际调用，私有传输由真实握手验证；事件契约由官方静态校验及实际事件/快照校验保障。 |
| 报告和校验   | 五项必需能力为 `session-identity`、`session-messages`、`session-usage`、`credential-store`、`credential-read`。后端在配对或新 lease 前独立检查合约、最低版本及完整报告，快照再次与当前 lease 的真实版本、插件与能力报告匹配。                                           |
| 真实版本     | identity、snapshot、配对、凭据、重连和公开 live 状态保留观测的 CLI 版本。升级后使用原凭据重连仍重新探测；断开或来源失效显式清除公开兼容状态。                                                                                                                           |
| 探测开销     | 普通快照和无变化轮询不重复写探针 store 或读 manifest；没有已存凭据时，后台启动不做完整探测。探针键固定、值无敏感信息，不覆盖凭据路径。                                                                                                                                  |
| 并发回归     | 独立复核发现背景重连刷新 identity 后可能丢失并发配对成功的能力报告，首快照会被拒绝。确定性交错测试先红后绿；探测结束检查 generation/身份，并更新当前 identity 的报告。                                                                                                  |
| 旧插件更新   | 真实 301 的隔离 local marketplace 实验确认，重复 `plugin install` exit 0 但保留 0.1.0；`plugin update agentkib-bridge@agentkib-local` 才更新为 0.2.0。因此步骤 1 增加 update 指令，文档同步说明。                                                                       |

发送实验常量仍为 `false`，不探测 `prompt.submit` 或 `turn.abort`，不开放界面发送或停止。原有一次性连接码、120 秒期限、凭据权限、token/binding/lease/nativeId/cwd/instance、锁、指纹、来源权限、发送前占用及未知结果保护保留；不改跨 Agent 继续、`handoff.*` 或 Codex follower。连接失败不消费仍有效的连接码，不替换已存在的有效 lease。

### 如何更新已验证清单

1. 在独立五目录和受控测试账号中完成该版本的原生只读连接/同步/断开验收，记录版本、证据及缺口。
2. 只修改 `hooks/compatibility.js` 的 `verifiedCliVersions`，复跑兼容矩阵、打包一致性和界面测试；无需修改比较逻辑或后端/schema 中的版本常量。
3. 不因无登录检查通过自动更新清单或发布。非规范稳定版（预发布、含构建后缀或无法解析的版本）暂时拒绝，避免猜测兼容性。

## 四语及两端

- zh-CN / zh-TW / en-US / ja-JP 均补最低版本、旧 CLI、旧插件、能力缺失、无法识别版本及未验证版本文案；简体使用中文标点，遵循术语表。
- 桌面/Web 的 `claude-connection-copy.ts` 和新增 `claude-compatibility-note.tsx` 保持相同；实际 reader 四语渲染及文案插值均有回归。经现有 web-client 转导出策略，没有添加依赖或改锁文件。
- 桌面保留 B 的三步向导、状态互斥、过期处理、异步代际与撤销门禁；Web 只在已有会话页显示提示，不新增安装或连接管理入口。提示不覆盖权限、事件缺口或结果未知状态。
- `docs/CLAUDE-NATIVE-CONNECTION.md` 与 `docs/UI-TERMINOLOGY.md` 同步新规则。`designs/` 未修改。

## 自动无登录检查

新增 `.github/workflows/claude-bridge-compatibility.yml`：相关 PR 自动触发，也支持手动触发。macOS 矩阵为最低版本和 npm registry latest，权限仅 `contents: read`，不持久化 checkout 凭据。不会合并、改已验证清单或发布。

脚本 `.github/scripts/claude-bridge-compatibility.mjs`：临时安装官方包，`--ignore-scripts`；执行时采用白名单环境，五个目录与 AGENTKIB_HOME 独立。CLI 用 Seatbelt 禁网、拒绝个人目录和 Keychain；桥接测试仅允许 loopback/Unix socket。负向探针实际确认网络/个人目录被拒绝，正向探针确认桥接 loopback 可用。原始输出不上传，只输出版本、结果、计数与白名单能力名；超时或测试未执行不能报告通过。

| 官方 CLI | 最终插件 strict validate | 官方 plugin test | 实际覆盖                                                                  |
| -------- | ------------------------ | ---------------- | ------------------------------------------------------------------------- |
| 2.1.301  | 通过                     | 8/8              | 原生插件引擎 + 合成能力 host，包含必需能力成功/失败契约及真实 hook 元数据 |
| 2.1.307  | 通过                     | 8/8              | 同上，不是 307 的真实 TUI 配对证据                                        |
| 2.1.308  | 通过                     | 8/8              | 实施时 registry latest 已更新为 308；全新隔离安装成功                     |

调研时 latest 为 307，实施时检查在 05:51 UTC 前已为 308，最终三版 8 项检查于 06:09 UTC 完成，时间差与调研记录不矛盾。三个版本使用同一最终插件源码，没有替换生产发送常量或伪装版本。

## 自动测试与检查

使用项目 pnpm 12.10.1，临时 userconfig 设置 `manage-package-manager-versions=false`，未改依赖。全量测试采用隔离目录。新增用例先观察失败，再实现；保留原安全断言，旧“拒绝更高版”用例改为拒绝低于最低版，另测高版本放行。

| 命令/检查                                                          | 本轮结果                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                                   | backend、desktop、Web 通过；Web 仅既有路由生成循环依赖警告                                           |
| `pnpm lint`                                                        | exit 0，无错误；既有警告保留，未放宽规则                                                             |
| `pnpm format:check`                                                | 通过（最终以格式检查输出为准）                                                                       |
| `pnpm test:web`                                                    | 全量 69 文件、1475/1475 通过；null 状态清除另有定向验证                                              |
| `pnpm --filter @agentkib/desktop test`                             | 最终 393 文件通过、1 文件跳过；7723 项通过、3 项按既有条件跳过                                       |
| 五个桥接文件 Vitest                                                | 最终 156/156 通过，含版本分类、全部必需能力、旧插件、凭据/身份/lease、快照元数据不匹配和兼容状态清除 |
| 原生 Seatbelt 中五个桥接文件                                       | 冻结时 152/152 通过；随后增加 4 项快照/清除断言，本机最终组合为 156/156                              |
| 桌面界面                                                           | 四语实际渲染、错误插值、旧命令永久清除、显式 null；原 B 状态/撤销竞态定向验证通过                    |
| Web 界面                                                           | 四语渲染、镜像、非法元数据与 null 清除定向验证通过                                                   |
| `node --test .github/scripts/claude-bridge-compatibility.test.mjs` | 8/8 通过，含原生 Seatbelt 边界及“测试确实执行”的计数检查                                             |
| 修改过的 `apps/desktop/test` 额外 `oxfmt --check`                  | 五个文件通过                                                                                         |
| `pnpm --filter @agentkib/desktop build:electron`                   | Web、renderer、backend、main/preload 和 staging 构建通过                                             |
| `pnpm build:web:hosted`                                            | 通过                                                                                                 |
| QA probe 语法/格式、镜像和 `git diff --check`                      | 通过                                                                                                 |

首次桌面全量与其他检查并行时，`claude-startup-recovery` 的协议失败证据断言和 `skills-worker` 的 deadline 用例失败。原预算、单 worker 隔离复跑两文件 **66/66** 通过，随后完整桌面组合通过；没有延长超时、删用例或放宽断言。开发期间一次无登录脚本的桥接组合失败未保留精确用例名，不能断言其根因就是并行开发中的红测；冻结后整个组合已通过。

## 合成界面验收与截图

使用现有 B 沙盒，补合成 CLI 版本/错误字段，保留五目录隔离、个人配置拒绝及非测试外网阻断。可重放：`prepare → seed → state --state connected --cli-version 2.1.307 → start`；其他错误通过 `--state failed --connection-error` 白名单切换。结束使用 `stop`。

Electron fixture 只替换唯一合成会话的展示 payload；原 handler 先检查 owner/来源/权限，真实 bridge-challenge/disconnect 不执行。为 Web 视觉验证，仅允许在该沙盒生成一个 **read** 档位的本机授权码，仍由真实 handler 校验和消费；拒绝 full 授权、配置及其他写操作。授权码只在内存流转，不输出、不截屏。Web 通过真实只读授权，浏览器 fixture 只替换该合成会话已通过权限校验的 live/SSE 展示字段，保留原 envelope、cursor/ACK 及错误路径；不能据此宣称真实插件或模型验收。

| 画面                     | 观察                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| 桌面现有会话，未验证版本 | 灰字正常显示，原终端只读说明保留，无发送/停止入口                                                |
| 桌面连接对话框           | 最低版本与未验证版灰字同时清楚，安装块含 update；1360×860 下对话框 672×530，无裁切或页面横向滚动 |
| 旧 CLI                   | 显示真实 2.1.300 与最低 2.1.301，提示更新；连接命令数量为 0                                      |
| 能力缺失/旧插件          | 分别说明继续在终端使用、按第 1 步更新；不显示连接命令                                            |
| Web 现有会话，只读授权   | 灰字与“当前浏览器仅可读取”并存，不提升控制权限；1280×800 无横向溢出                              |

真实 computed style：Electron 44.9.1 / Chromium 152 的 VTRON 浅色提示为 `rgb(98, 106, 126)`，opacity 1；Web 现有浅色主题为 `rgb(107, 107, 116)`，opacity 1，均使用 `text-muted-foreground`，不是警告色。四语由实际 React 渲染回归覆盖；本机截图为简体浅色，不宣称覆盖全部主题/语言截图。

截图前检查正文不含个人路径/用户名/局域网地址，只有示例工作区、示例安装路径和合成内容。本机截图位于 `qa/screenshots/v15-b2/`：`desktop-connected.png`、`desktop-dialog-unverified.png`、`desktop-too-old.png`、`desktop-missing-capability.png`、`desktop-old-plugin.png`、`web-connected.png`。按仓库现有 ignore 规则不入库，不作为远端 PR 已有截图附件。

## 与设计的差异、未覆盖项及清理

- **真实 TUI 的“生成码 → 粘贴 → 已连接 → 一轮回复 → 断开”尚未覆盖。** 现有原生验收夹具会把挑战码写入 CLI 历史/debug，不能直接在本轮“不记录凭据”的约束下运行；又没有受控测试账号，不能借用个人登录或假称真实模型成功。已检查的 CLI 帮助说明 `--no-session-persistence` 仅支持 print，不能据此保证 TUI 不落盘。
- 临时最小插件在 301/307 上 strict validate、`--init-only` 均成功，但没有产生 `session.start` 白名单结果。禁止历史/debug 写入的无登录 TUI 小探针也没有产生结果，不能把它当作真实 host 的文件/会话 API 成功或失败证据。未输入挑战或模型消息，进程均回收，禁止的目录没有产生。
- 提交前另通过真实插件 hook 核实 301/307 的 `$.plugin.root` 为插件外层根目录，当前自带 manifest 路径选择成立；该无 stub 的元数据断言已作为正式第 8 项测试，最终 301/307/308 都通过。官方测试宿主的 `fs.read` 没有默认实现，未把合成文件读取误称为真实文件 IO 验证。
- 307/308 的真实文件/会话 host 与原生完整同步仍需后续受控验收，因此它们继续归类“尚未验证”，不自动提升发送、停止或其他能力。
- 版本无法解析/预发布版保守拒绝；目前没有可替代 CLI 的官方独立 Mods API 版本，使用明确的私有合约与能力报告，不猜测所有未来事件语义。
- 由于实际证实重复 install 不升级旧插件，步骤 1 比原设计多一条 update 命令；这是使“重新安装”指引可执行所必需的修正，不调整布局或其他功能。
- 自动检查采用相关 PR 和手动触发，没有定时任务，也不自动更新清单或发布。GitHub 原生执行结果应以新 PR 固定 HEAD 的检查为准，不能用本机结果冒充。
- 没有 Windows/Linux 终端连接或真实模型验收；平台限制保持 macOS。没有改 designs、真实配置、账号或 Codex 系统技能。临时 CLI 安装/探针目录与进程已清理；视觉 Electron/Chromium 已退出，沙盒及其中的只读测试授权已删除，没有启动 tmux。最终插件重新 staging，6 个产物文件与源码逐字节一致，manifest 0.2.0 和 SHA256 校验通过。

独立只读复核覆盖 backend/protocol/policy、插件异步身份报告及两端文案/状态；发现的报告缓存竞态已补回归修复，最终未发现其他确定缺陷。该结论不覆盖上述未完成的真实 TUI/模型验收。
