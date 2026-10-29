# Claude Code 桌面 / Web 一期 QA — 2026-09-30

> 提交整理说明：本页及文件哈希清单记录原实施工作树的验收证据。迁移到较新主线后的代码差异与重新验证结果另见 [提交整理 QA](claude-managed-commit-2026-09-30.md)，不能将本页的真实模型记录视为新提交二进制再次验收。

## 结论

实现与自动化检查、真实验收分开记录。本轮新增桌面和 Web 共用的 Claude 执行服务、新建/接管/释放、持久回执、图片文件转换及文件预览。真实文本/文件回复、Web 回读、重启恢复历史、同 UUID 接管续接、审批/问题，以及问题等待和前台 Bash 取消均取得通过证据。**图片字节传输与实际 Flash 路由验证通过；模型将纯蓝图片回答成紫色，颜色断言失败保留，按用户澄清不列为 AgentKib 代码阻塞。真实手机尚未验收**。此前 provider、映射、协议及清理失败证据全部保留。没有将模拟协议测试、浏览器模拟或旧 QA 当作本轮真实验收通过。

## 源码及环境

- 工作树：`/Users/user/.codex/worktrees/all-agent-continuation/agentkib`。
- HEAD：`057da8b81a3f3c9536a568287175af8e50c12176`，detached / dirty；原有互通、Antigravity、Codex、远控等改动全部保留。
- 本轮前 1151 文件 SHA256 基线：`/tmp/agentkib-claude-v1-2026-09-30/baseline.json`；原始 status 同目录 `status.txt`。本轮增量文件清单另存 `claude-managed-2026-09-30-files.json`，不能把整个 HEAD diff 当作本轮改动。
- macOS arm64；Node `22.23.2`、pnpm `10.8.1`、Cargo `1.92.0`；CLI `/Users/user/.local/bin/claude` = `2.1.285 (Claude Code)`。
- 无生产依赖新增、凭据复制、用户 CLI 更新、数据库表结构迁移、提交、推送、打 tag 或发布。

## 能力与兼容矩阵

| 平台 / 版本 | 实现及自动化 | 本轮真实结果 |
| --- | --- | --- |
| macOS Claude Code 2.1.285 | 精确版本门限、新建及原 UUID 接管、原生 stream-json、审批/提问、文本/四类图片/文件、取消及恢复 | DeepSeek Pro 文本/文件、外部会话同 UUID 接管、审批/问题、等待问题时取消、前台 Bash 取消及异常重启通过；图片字节和 Flash 路由通过，颜色回答错误单列为模型结果；手机未验收 |
| macOS Claude Code 2.1.263 | 保留精确版本协议回归 | 本轮未用该旧二进制重新调用模型 |
| 其他 Claude 版本 | 不自动开放控制 | 未验收 |
| Windows / Linux | 生产控制门限保持关闭；协议测试使用隔离模拟 CLI，非 macOS 不承诺原生控制 | 本轮未运行异机/CI；未验收 |
| Claude Desktop Chat/Cowork | 不在本轮范围 | 不适用 |

## 自动化与审查

实际日志位于 `/tmp/agentkib-claude-v1-2026-09-30/`。本轮实际执行以下命令，结果见下表，不沿用旧 QA：

- `cargo fmt --all --check`
- `cargo test --workspace`
- `cargo clippy --workspace --all-targets -- -D warnings`
- `pnpm format:check`、`pnpm lint`、`pnpm typecheck`
- `pnpm --filter @agentkib/desktop exec vitest run` 与 `node --test apps/desktop/scripts/*.test.mjs`
- `pnpm test:web`、`pnpm build`、`pnpm build:web:hosted`

| 检查 | 首阶段结果 / 日志（后续增量另记） |
| --- | --- |
| Rust fmt | 通过；`rust-fmt-delivery.log` |
| Rust workspace tests | 976 通过、6 ignored；`workspace-tests-delivery.log` |
| Clippy workspace/all-targets（`-D warnings`） | 通过；`clippy-delivery.log` |
| 前端 format / lint / typecheck | 全部退出 0；`format-delivery.log`、`lint-delivery.log`、`typecheck-delivery.log` |
| 桌面 Vitest | 875 通过、2 个真实模型脚本默认跳过；`test-delivery.log` |
| 桌面脚本测试 | 1 通过；包含在 `pnpm test` / `test-delivery.log` |
| Web Vitest（含共享客户端） | 207 通过；`test-delivery.log` |
| 完整桌面构建（含 release Runtime 和 bundled Web） | 通过；`build-delivery.log` |
| hosted Web 构建 | 通过；`hosted-delivery.log` |

Lint 退出 0 但仍报告 85 条 warning，不描述为零警告。其中包含本轮 Claude 面板用于切换会话清理的 effect/ref 提示；没有关闭规则或降低测试断言。其余既有 warning 随本次日志保留。

独立子代理分别实现 Runtime、附件、两端 UI，随后交叉只读审查宿主、回执、附件与并发边界。发现并修复：

1. Claude 工作区授权遗漏、能力未按 LAN/设备权限投影。
2. release 缺失 revision/Runtime 身份，以及空会话释放后的 history 路由。
3. 派发前 pin 清理、删除附件后重复请求的持久指纹验证。
4. create/release 在副作用前没有标记 ledger dispatch。
5. 取消后旧初始化标志残留，第二次发送无法重新握手。
6. 精确关联完成事件到达后无法补齐丢失的发送回执。
7. 旧面板异步回执删除新 pending、HTML bundle hash 与文件 revision 混淆。
8. Runtime 排队拒绝不能凭异常认定成功或全请求未派发：宿主仅识别结构化 `web-busy`，有序查询原请求后，确认不存在才报告未派发；存在回执或查询失败时保持未知。

模拟协议测试覆盖请求指纹、UUID、重启未知状态、同会话锁、取消后重新握手、四种图片头/尺寸/容量、设备/会话/路径/哈希边界、附件引用持久化、迟到响应与旧表单失效。真实模型与设备用例的缺口列在下方，不把这些测试计作原生通过。

新增 `crates/agentkib-runtime/tests/claude_responsiveness.rs` 使用真实 Runtime 二进制及 stdio RPC：以 Unix socket 门闩阻塞 mock CLI 版本探测，再让其停止读取超过 5 MiB 的用户帧制造管道背压。两阶段 `runtime.info` 均限 1 秒，背压期间 `live` 返回执行中、第二 send 返回 `session-busy/not-dispatched`；取消后 mock 连接 EOF、仅启动一个进程。该用例不调用模型，不使用固定睡眠，不代表真实网络或跨平台性能验收。最后增量另由独立子代理复核，未发现明确 P1/P2。

## 真实 CLI 用例

唯一发送用例证据：[`results.json`](claude-managed-2026-09-30/results.json)、[`api-error-summary.json`](claude-managed-2026-09-30/api-error-summary.json)、[`readonly-restart-verified.json`](claude-managed-2026-09-30/readonly-restart-verified.json)。完整隔离目录为 `/private/tmp/agentkib-claude-v1-native-2026-09-30-isolated-port`。

```sh
AGENTKIB_CLAUDE_NATIVE_DIR=/private/tmp/agentkib-claude-v1-native-2026-09-30-isolated-port \
  pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-real.test.ts
```

测试以独立 `CLAUDE_CONFIG_DIR`、Runtime 数据、Web 数据、工作区和随机 MCP/HTTP 端口运行。测试 wrapper 引用原 settings 文件，使用 `--safe-mode --setting-sources '' --strict-mcp-config --max-budget-usd 0.50`，未复制凭据或更换模型。原 settings 文件哈希前后相同。

| 验收项 | 实际结果 |
| --- | --- |
| 本机 owner 创建空会话、原生 UUID 持久化 | 通过；首次读无模型进程 |
| Web 读取同一会话身份 | 通过 |
| 上传合成 PNG 与带随机标记的文件 | 通过 |
| 单次发送、CLI 原生协议初始化 | 通过 admission；Claude 2.1.285，claude-opus-5 |
| 正文随机标记 / 图片蓝色识别 / 文件决策引用 | 未通过验收：上游 503，未取得回复 |
| CLI / 请求次数 | AgentKib send = 1，CLI launch = 1；CLI 自身记录 8 次 503 内部重试，不能宣称上游零重试 |
| 用量 | 上游未返回，不记为 0 tokens 或零费用 |
| 90 秒退出清理 | Runtime 正常退出 code 0 |
| 失败后纯读取重启核对 | 通过：outcome-unknown、sendEnabled=false、旧审批/问题为空；原回执 accepted 但 completionObserved=false；launch 仍为 1 |
| 真实续接回复、双端审批/提问、取消后真实继续、目标原生历史完整回读 | 因首例上游阻塞未继续调用模型；未验收 |
| 真实手机 | 无本轮设备证据，未验收 |

准备失败另外保留：首目录 `/tmp/agentkib-claude-v1-native-2026-09-30-single`、次目录 `/private/tmp/agentkib-claude-v1-native-2026-09-30-handshake`，均为 0 send / 0 CLI launch。补齐握手后，独立诊断确认现有 MCP 端口冲突；改用独立空闲端口后才执行上面的唯一模型用例。没有重复失败模型用例或自动换模型。

## 桌面实际操作及限制

使用隔离数据启动本工作树 Electron，不覆盖安装版。通过原生 UI 工具从工作区「继续工作」进入 Claude 面板；验证新建空会话、CLI 版本、发送/停止的初始禁用状态及释放。测试数据在 `/private/tmp/agentkib-claude-v1-ui-2026-09-30`。

修复后重启实际 Electron，选择原会话 `228dd5e2-31cd-489d-8c72-9f8e13e4742c`，确认原客户端未运行后重新接管；列表显示标题，状态为「空闲」。打开文件面板并读取合成文件 `claude-ui-preview.txt` 的 `JADE-7301` 标记，再释放后正常显示「已释放」，无历史刷新错误。截图：[文件正文](claude-managed-2026-09-30/desktop-files.png)、[释放状态](claude-managed-2026-09-30/desktop-released.png)。本次 UI 操作未发送模型请求，最后正常退出测试应用。

第一次接管点击遇到 worker `web-busy`，回执查询确认未派发后显示失败；人工再次点击成功。没有自动排队或重发。该现象也说明繁忙时仍可能需要用户重新操作，不能将所有本地操作描述为必然一次成功。

首次 UI 启动误以 `electron dist-electron/main.cjs` 加载打包资源，路径解析失败；改用 `electron .`。其次测试临时根 `/tmp` 是 macOS symlink，被 metadata 保护拒绝；改用真实绝对路径 `/private/tmp`，未放宽保护。实际 UI 操作还发现文件入口遗漏和释放后 history 路由问题，按根因修复并复验，不以孤立组件测试代替集成可用。

公开分发前的第三方接入许可、签名公证、正式更新、Windows/Linux 实机不在本次通过范围。当前本机 CLI 验证不能描述为已取得订阅额度接入许可。

## 用户调整模型后的再次验收（2026-09-30 13:00）

用户明确要求更换模型后再试，因此使用全新隔离目录执行一次新用例，未重用之前已尝试的操作或会话。命令：

```sh
AGENTKIB_CLAUDE_NATIVE_DIR=/private/tmp/agentkib-claude-v1-native-2026-09-30-user-model-retry \
  pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-real.test.ts
```

本次实际 CLI 仍报告 `claude-opus-5`；读取的 `~/.claude/settings.json` 为 `model=opus`、`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5`。未修改用户配置，待确认用户变更模型的位置。90 秒期限内上游记录 8 个 HTTP 502，未取得正文或用量；AgentKib send=1、CLI launch=1、Runtime 正常退出 code 0、settings 哈希未变化。测试失败原因 `native_timeout`，不计入原生通过，也没有自动重新发送或切换模型。

证据：[结果](claude-managed-2026-09-30/user-model-retry/results.json)、[上游状态](claude-managed-2026-09-30/user-model-retry/api-error-summary.json)。完整测试日志 `/tmp/agentkib-claude-v1-2026-09-30/native-user-model-retry.log`。

## CC Switch 映射核对与连接阻塞定位

用户说明通过 CC Switch 修改映射后，只读查询其本地 SQLite 当前 Claude provider。确认 `relay-provider` 的 Opus 映射已为 `claude-opus-5-5-medium`；因此此前仅根据 Claude settings 判定“模型未修改”不完整。Claude settings 仍保存 `claude-opus-5`，前次代理日志也确实以旧名转发，不能单凭 CLI 展示推断 CC Switch 中的配置。

在用户已选定的新映射下执行一次独立用例：

```sh
AGENTKIB_CLAUDE_NATIVE_DIR=/private/tmp/agentkib-claude-v1-native-2026-09-30-cc-switch-mapped \
AGENTKIB_CLAUDE_NATIVE_MODEL=claude-opus-5-5-medium \
  pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-real.test.ts
```

为验收脚本增加显式模型参数，仅用于此次用户选择的模型，校验后传入隔离 wrapper 的 `--model`；未改生产选模行为、全局配置或凭据，未自动选择其他模型。文件 format 和 desktop typecheck 通过。

真实 CLI 与 CC Switch 代理记录均确认 `claude-opus-5-5-medium`。仍未取得回复：代理返回 502，具体为 `client error (Connect)`；当前 provider 上游指向本机 HTTP 3003 端口，TCP 探测返回 `ConnectionRefusedError / errno 61`，`lsof -iTCP:3003 -sTCP:LISTEN` 无监听。该连接失败发生在模型推理之前，不能归因为新模型不可用。AgentKib 单次 send、单次 CLI launch，90 秒后正常清理；未继续重试模型，原生验收仍阻塞于本机上游服务。

证据：[结果](claude-managed-2026-09-30/cc-switch-mapped/results.json)、[映射](claude-managed-2026-09-30/cc-switch-mapped/mapping-diagnostic.json)、[代理请求摘要](claude-managed-2026-09-30/cc-switch-mapped/proxy-summary.json)、[TCP 探测](claude-managed-2026-09-30/cc-switch-mapped/connectivity.json)。

## 用户再次切换 provider 后验收：cpa

用户再次授权重试。只读核对 CC Switch 当前 provider 为 `cpa`，Opus 映射为 `relay/claude-opus-5-5`，本机 HTTP 8317 端口 TCP 连通。使用新隔离目录，验收脚本显式采用这一用户选定模型；仅放宽测试模型名字符集以接受 provider/model 形式，仍拒绝 shell 元字符，不修改生产逻辑或用户配置。

```sh
AGENTKIB_CLAUDE_NATIVE_DIR=/private/tmp/agentkib-claude-v1-native-2026-09-30-cpa \
AGENTKIB_CLAUDE_NATIVE_MODEL=relay/claude-opus-5-5 \
  pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-real.test.ts
```

CLI 与代理日志均确认新模型。代理首条 HTTP 200 不代表取得模型正文；随后上游报告 `permission_denied`（内容策略拒绝），并以 `auth_unavailable: no auth available` 返回 503。合成文本/图片用例未获得正文、用量或审批，90 秒后 `native_timeout`，本轮原生验收仍未通过。未尝试绕过上游策略、自动换模型或重新发送。AgentKib send=1、CLI launch=1，Runtime 正常退出，settings 哈希未变。

证据：[结果](claude-managed-2026-09-30/cpa/results.json)、[代理摘要](claude-managed-2026-09-30/cpa/proxy-summary.json)、[连通性](claude-managed-2026-09-30/cpa/connectivity.json)。日志 `/tmp/agentkib-claude-v1-2026-09-30/native-cpa.log`。针对测试脚本的 format 和 desktop typecheck 均通过。

## DeepSeek 再次验收：文本/文件通过，图片识别失败

用户明确切换为 DeepSeek 并授权再试。CC Switch 当前模型映射为 `deepseek-v4-pro`；仍通过隔离 wrapper 显式指定该用户选定模型，不修改全局设置。

```sh
AGENTKIB_CLAUDE_NATIVE_DIR=/private/tmp/agentkib-claude-v1-native-2026-09-30-deepseek \
AGENTKIB_CLAUDE_NATIVE_MODEL=deepseek-v4-pro \
  pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-real.test.ts
```

| 检查 | 结果 |
| --- | --- |
| CLI/实际模型 | 2.1.285 / deepseek-v4-pro |
| 空会话不启动模型，Web 同身份读取 | 通过 |
| 原生发送与终态 | 单次发送，正常回到 idle，约 11 秒 |
| 文件随机标记、项目决策 | 正确引用 `d40dfa4b-1e47-431c-a8bf-6079953652b9` 和 `cobalt-lake` |
| 图片蓝色识别 | 失败；模型回复图片为 `[Unsupported Image]`，不能识别颜色 |
| 图片进入 CLI 历史 | image/png 原生块存在，95 bytes、PNG magic 正确；没有被宿主静默丢弃 |
| Web 历史与 Runtime 重启回读 | 通过，Web 5 个事件，重启后仍存在随机标记 |
| 审批 | 无审批请求；CLI 自动允许 Read，不能据此标记人工审批通过 |
| 请求数量 | AgentKib send=1、CLI launch=1；一轮工具交互包含 3 个上游 HTTP 200 |
| CLI 报告用量 | input_tokens=20185、cache_read_input_tokens=40192、output_tokens=615，按原始字段记录，不推算账单 |
| 退出/用户设置 | Runtime code 0；settings 哈希未变 |

完整测试因图片颜色断言失败退出 1，没有降低断言或把 HTTP 200 等同于全项通过。原生历史证明图片块存在，但仅凭模型回复不能定位是 CLI 的非原生模型处理、代理还是供应商转换导致不支持；当前 DeepSeek 链路尚不能满足图片验收。独立 Python TLS 预探测曾报证书校验错误，但实际 CC Switch 请求已成功，此探测不能作为真实渠道连接失败结论，未关闭证书校验。

证据：[结果与回复](claude-managed-2026-09-30/deepseek/results.json)、[原生块摘要](claude-managed-2026-09-30/deepseek/native-blocks.json)、[代理响应](claude-managed-2026-09-30/deepseek/proxy-summary.json)。实际日志 `/tmp/agentkib-claude-v1-2026-09-30/native-deepseek.log`。本次未修改生产代码或重新执行模型用例。

## 继续验收汇总与桌面入口修复

- [真实审批/问题增量](../qa/claude-managed-interaction-2026-09-30.md)：owner 批准精确合成 Write 后 Web 旧审批拒绝；Web 回答真实 AskUserQuestion 后 owner 旧问题拒绝；工具结果、实际文件及最终答案一致。这里验证真实服务/HTTP 边界，不冒充手机点击。
- [原 UUID 续接与重复请求](claude-managed-2026-09-30/resume-addendum.md)：仅一个新用户 turn 回忆历史随机标记，原日志前缀不变；立即及重启后重复请求不增加模型执行。模型后的测试统计错误保留，用只读恢复补完证据。
- [外部官方 CLI 首次接管](../qa/claude-external-adopt-2026-09-30.md)：原生 CLI 独立创建，AgentKib 尚无管理元数据；确认原进程退出后按指纹接管，从 Web 按原 UUID 续接。仅用新增原生助手文本验证旧上下文，源工具无重放。源创建与续接各一轮；测试准备阶段空附件数组被拒绝，未派发模型，修正后完成原定续接。
- [取消与异常重启证据](claude-managed-2026-09-30/lifecycle-addendum.md)：等待问题时取消已通过；前台 Bash 协议及独立进程组清理修复后，唯一新取消用例通过。首次 crash 用例缺少强杀前状态，已补充强杀前明确 running 的新用例并通过；旧证据不单独用作充分证明。

实际 Electron 只读验收发现历史页传入的是 index ID，而 catalog 对同一已托管会话返回 managed ID，导致打开面板报 `claude_session_unavailable`。新增可选 `indexedSessionId`（Runtime 使用既有 Store.conversation_id 计算），面板只接受同工作区、Claude Code、唯一精确映射；不按标题/最新会话猜测，不改已有 pending 请求身份。新增三项前端回归和 Rust catalog 字段断言，并经独立子代理复核。

重建后的真实 Electron 从历史页进入托管面板，正确显示 DeepSeek 实际回复、Write/AskUserQuestion 完成记录、模型/CLI 版本及空闲状态，无会话不可用错误。截图 [desktop-native-history.png](claude-managed-2026-09-30/desktop-native-history.png)。本次 UI 复验只读，未启动模型，测试应用正常退出。

## Flash 图片用例：代理改写导致未实际验收视觉模型

用户明确允许仅图片用例使用 `deepseek-flash` 后执行一次独立合成文本/图片用例，目录 `/private/tmp/agentkib-claude-v1-native-2026-09-30-flash-vision`。原生 CLI 显示请求 Flash，但 CC Switch 日志明确 `requestModel=deepseek-flash`、`upstreamModel=deepseek-v4-pro`；因此不得将它描述为实际 Flash 视觉能力失败。文件内容/重启回读通过，图片仍为 `[Unsupported Image]`，原完整图片断言保持失败，没有降低要求或再次发送。

官方 [模型能力](https://api-docs.deepseek.com/api/list-models/) 明确 Pro 仅文本，Flash 支持图片；上传副本和原生 PNG 字节完全相同。CC Switch 3.20.4 内包含相应图片占位替换机制，但本次没有逐跳请求体抓包，具体主动或响应式分支不作确定结论。详见 [图片独立调查](claude-managed-2026-09-30/image-review-evidence.md)、[Flash 代理证据](claude-managed-2026-09-30/flash-vision/proxy-summary.json)。

完成图片项还需要 CC Switch 实际转发到视觉模型；已经向用户说明映射覆盖并请求调整，未修改其全局代理配置或凭据。真实手机是否可配合的询问仍待回复；不以桌面浏览器模拟替代。

## 增量质量门（桌面历史入口修复后）

以下是在历史 ID 映射修复及新增原生验收脚本后重新执行的检查。它们早于随后发现的 Bash 生命周期修复，不能作为后者的最终验证。

| 实际命令 | 结果 | 日志（同本轮临时日志目录） |
| --- | --- | --- |
| `cargo fmt --all --check` | 通过 | `rust-fmt-acceptance.log` |
| `cargo test --workspace` | 976 通过，6 ignored | `rust-test-acceptance.log` |
| `cargo clippy --workspace --all-targets -- -D warnings` | 通过 | `clippy-acceptance.log` |
| `pnpm format:check`、`pnpm lint`、`pnpm typecheck` | 全部退出 0；lint 仍有 warning | `format-acceptance.log`、`lint-acceptance.log`、`typecheck-acceptance.log` |
| `pnpm test` | 桌面 878 通过、6 个 opt-in 原生脚本跳过；脚本 1 通过；Web 207 通过 | `test-acceptance.log` |
| `pnpm build` | 完整桌面构建通过 | `build-acceptance.log` |
| `pnpm build:web:hosted` | 通过 | `hosted-acceptance.log` |

截至此阶段，实际 Electron 操作覆盖空新建、接管、文件预览、释放和原生回复展示；真实回复、两端互斥审批/问答和续接证据来自同一生产宿主服务及 HTTP 边界。尚未证明真实手机上的完整交互，不将服务测试描述为设备验收。

## 问答表单补充复核

独立复核发现桌面单选题填过自定义答案后点击预设选项，会残留两项答案导致提交一直禁用。`ClaudeSessionPanel` 现按单选规则双向清理互斥答案；多选仍保留预设和自定义组合。新增真实组件交互先复现失败，再验证两个方向及多选语义；没有调用模型。

修复后重新执行 `pnpm format:check`、`pnpm lint`、`pnpm typecheck`、`pnpm test`，均退出 0。桌面 880 通过、6 个 opt-in 用例跳过，桌面脚本 1 通过，Web 207 通过。日志为本轮临时目录中的 `{format,lint,typecheck,test}-final-lifecycle.log`。Bash 生命周期 Rust 改动仍在独立验证，不能用此处前端结果代替其最终验收。

## 生命周期最终修复与全量回归

前台 Bash 协议、独立进程组后代清理、清理失败状态传播，以及隐式回收/退出前持久化待核对状态已完成，详见 [生命周期增量](claude-managed-2026-09-30/lifecycle-addendum.md)。新取消用例先观察真实 `sleep 30` 与匹配的前台任务通知，取消后确认 CLI 和 sleep 均不再执行，再报告 idle/cancelled。强化崩溃用例确认强杀前确实 running，重启后同请求回执保持结果未知。

首次全量检查发现另一项退出观测竞态：libproc 已报告 zombie，而单次 `try_wait` 尚未返回退出，产生 `owned root exit unconfirmed`。失败原日志 `rust-test-final-lifecycle.log` 保留。修复为同一 2 秒期限内同时取得“捕获成员均停止执行”和“自有根进程可回收”证据；增加确定性延迟回收及期限失败测试，未删断言或扩大可终止进程范围。独立代理再次复核后，`cargo fmt --all --check`、`cargo test --workspace`、`cargo clippy --workspace --all-targets -- -D warnings` 全部退出 0：**991 通过、6 ignored**。日志 `{rust-fmt,rust-test,clippy}-final-reap.log`。

原生取消使用的 binary SHA 为 `7c7512ea06ee732ea98a67ecc9f57d3afbec79104490bf0b9ae577cf2b9cf198`；随后退出观测修正由自动化验证，未重复付费模型用例。各原生用例保存各自实际二进制 SHA，不能把分阶段证据描述为同一最终二进制上的整套模型重跑。

最终 `pnpm build`（含 release Runtime、桌面与 bundled Web）和 `pnpm build:web:hosted` 均退出 0，日志 `build-final-lifecycle.log`、`hosted-final-lifecycle.log`。未安装、覆盖已安装应用、提交或发布。前端脚本后续只收紧 opt-in 原生用例的事件顺序，并单独通过格式与类型检查；没有修改已通过的生产前端代码。

## 通过既有 Haiku 映射实际调用 Flash：图片答案仍不符合

继续只读核对发现现有 DeepSeek provider 的 Haiku 档为 `deepseek-v4-flash`。CC Switch 3.20.4 的 [映射实现](https://github.com/farion1231/cc-switch/blob/v3.20.4/src-tauri/src/proxy/model_mapper.rs) 优先匹配 Haiku，再回退默认模型；[DeepSeek 官方说明](https://api-docs.deepseek.com/quick_start/pricing/) 确认旧 Flash 名称由新版视觉 Flash 承接。因此无需修改全局配置，沿用用户“仅图片使用 Flash”的明确授权执行一次新隔离用例：

```sh
AGENTKIB_CLAUDE_NATIVE_DIR=/private/tmp/agentkib-claude-v1-native-2026-09-30-flash-haiku-vision \
AGENTKIB_CLAUDE_NATIVE_MODEL=claude-haiku-4-5 \
  pnpm --filter @agentkib/desktop exec vitest run electron/main/web/claude-managed-real.test.ts
```

代理证据为 `claude-haiku-4-5 → deepseek-v4-flash`，两条 HTTP 200；实际已到达 Flash，不能再归因为默认 Pro 映射。本次回复正确引用文件随机标记及项目决策，但把全像素 `RGB(0,0,255)` 图片回答成 **purple (violet)**。图片为有效 PNG，上传副本与原生图片哈希完全一致；保留蓝色断言失败，不将颜色近似或无 `[Unsupported Image]` 当作通过。

本次单次发送、单次 CLI 启动，Web 同会话及 Runtime 重启历史通过，退出 code 0，用户 settings 与 provider 配置哈希未变。此调用在退出观测竞态修正前已启动，仍使用上节 `7c7512ea…` 二进制；没有取消、重发或切换其他模型。用量、配置哈希及命令见 [run-summary.json](claude-managed-2026-09-30/flash-haiku-vision/run-summary.json)，原始结果、代理与像素证据同目录保存。

用户随后指出颜色错误更可能是模型能力问题。结合图片哈希、像素与真实路由证据，本轮将“宿主至 CLI 的图片字节传输及上游模型路由验证通过”和“模型颜色回答错误”分开记录；未发现 AgentKib 传图缺陷，不因该颜色回答修改实现、放宽原断言或继续重试。尚未逐跳抓取代理后的请求体，故不将该推断扩展为每一跳均有字节校验。

当前剩余设备验收：真实手机无操作证据。实际 Electron 审批/问题点击已由下节补齐。Windows/Linux 实机、签名、公证、正式发布及第三方订阅接入许可仍不在本轮通过范围。代码修复、本机工作流和模型答案质量分别记录，不将手机项描述为已完成。

## 最终构建的实际 Electron 原生交互

使用退出观测修复后的 Runtime SHA `66fa91d437dd36f4532017a3a3bb32303002b7f1f02a6edcfb8469c738c24895`，在新隔离目录 `/private/tmp/agentkib-claude-desktop-interaction-ui-2026-09-30` 完成一个全新的实际桌面交互用例。CUA 在真实 Electron 窗口新建空会话、输入并发送一次合成提示，核对 Write 的隔离路径及 UUID 后点击允许；真实 AskUserQuestion 先填自定义答案，再选 `cobalt-lake` 验证单选互斥修复，并点击提交。最终界面显示 idle、两个工具 completed，真实回复包含随机标记和所选答案。

只读核验确认一条原生会话、一个用户 turn、一次 CLI 启动，两个成功 tool result，合成文件内容正确，settings hash 不变；模型、用量和具体截图见[本项独立 QA](claude-desktop-ui-interaction-2026-09-30.md)。测试应用通过 Cmd+Q 正常退出，进程 exit 0。没有以脚本代替 UI 的发送、审批或回答，也没有重复模型用例。

截图：[Write 审批](claude-desktop-ui-interaction-2026-09-30/write-approval.png)、[问题选项](claude-desktop-ui-interaction-2026-09-30/question-selected.png)、[完成回复](claude-desktop-ui-interaction-2026-09-30/completed-reply.png)。该用例补齐本机桌面实际点击，Web 的真实服务/HTTP 证据见上文；仍不代表真实手机验收。
