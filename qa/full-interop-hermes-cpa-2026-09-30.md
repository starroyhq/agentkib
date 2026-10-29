# Hermes CPA/Opus 单轮验收准备 — 2026-09-30

已使用归档旧 Runtime（二进制 SHA256 `18f225c179dfc891553a182fd1e922b363ff0a5b4414d809738106236489de16`）从公共 `prepareHandoff → planHandoff → continueHandoff` 流程新建 `full-interop/claude-to-hermes-cpa`。重复请求及 Runtime 重启后仍是同 operation/目标会话 `20260930_224229_202641`。独立原生 SQLite 完整投影、来源 SHA、目标唯一性通过。后续新 v2 用例实际请求被上游拒绝，见文末；不提升原生真实回复等级。

Hermes 固定 `0.21.5` / release `v2026.9.24`。产品 plan 固定版本、home/profile 和目标历史，**不固定 Hermes 的 provider/model 配置**（`native_import.rs::target_settings` 的 Hermes 分支 model=None）。本轮模型 `relay/claude-opus-5-5` 属于用户选定的独立验收配置，不宣称预览已绑定模型。启动前已经核对完整命令和工作目录，只停止本例 TUI PID 39133。

## 原生接入与单次上游请求

正式 Hermes `providers.agentkib-cpa` 使用 `base_url`、`key_env`、`default_model` 与 `api_mode: chat_completions`。隔离配置只保存进程环境变量名称，不保存凭据；关闭工具、MCP、附加记忆、压缩与更新。`agent.api_max_retries=1` 表示一次初始尝试，`auto_recovery_cycles=0` 关闭恢复循环，但官方仍有网络错误后重建客户端再尝试的分支，因此不能单凭两个配置声称完全关闭重试。

验收专用 `cpa_once_relay.py` 将正式 custom baseURL 绑定到 `/session/<native-ID>/v1` 的本机随机端口。只允许精确目标模型、历史全文和唯一新提示。持久 token 以排他创建并 fsync 后才能向已有 CPA 的精确 `127.0.0.1:8317/v1/chat/completions` 派发；重试、并发或进程重启后不再转发。原生 Authorization/User-Agent 保持，禁止免费层接口或身份伪装；上游重定向转成本地 502，去除 Location，防止客户端绕过守卫。

派发前核对监督窗口 journal 的版本、私有 regular 文件、状态、期限、endpoint/model、八项重试/自动切换策略；并复用 `temporary-retry-window.check_overrides` 只读核对当前实际 CPA/CC Switch 配置。连接前后的窗口变化都拒绝请求，已消耗 token 不删除。清理不等待长连接锁，停止接收并关闭本例拥有的上游 socket。

## 本地证据

- `hermes-cpa-relay-mock.py`：官方未修改 CLI + 隔离 SQLite 副本 + 正式 custom provider。500、429、307、网络断开、SSE 中断均只有 **1 次**上游 mock 请求；原生额外尝试被守卫拒绝。所有用例没有真实 CPA 流量，原始数据库哈希不变，假测试凭据未落盘。
- 正式客户端启动会向本机 `/api/show` 做模型元数据探测，该路径被拒绝，不被转发到 CPA，不消费模型 token；不能将这一探测与模型调用混为一谈。
- `cpa_once_relay_selftest.py`：5 种故障、重启重复、6 个并发实例、4 个独立进程竞争、角色/正文及 session 路由漂移、关闭活跃上游连接。9 类通过，持久 token 保留。
- `cpa_relay_boundary_selftest.py`：6 个窗口证据负例，以及 connect 延迟期间关闭 relay / 窗口，均为 0 次上游请求。延迟连接在清理锁之外，关闭有界返回。
- 首个 mock runner 曾在 `/api/show` 被拒绝时提前结束，模型上游 0 次；保留 `hermes-cpa-mock-v1`。调整为只在 token 已消费后的额外请求才停止监督，没有放宽实际模型正文比较。

证据根：`~/Documents/AgentKib-archives/2026-09-30/native-interop/`，目录 `hermes-cpa-mock-{v2,429,redirect,network,stream}`、`cpa-relay-selftest-final`、`cpa-relay-boundary-selftest`。

准备阶段的 `hermes-cpa-native-once-live.py` 随后通过独立审查并由主代理调度，实际结果见文末。它复用经三种信号及退出竞态验证的 `qa_owned_cli`，独立 finally 恢复隔离配置并关闭 relay；严格核对真实回复、用量、原始消息前缀、来源、唯一目标和重启回执。准备通过不等于真实回复通过。

## 首个窗口的模型前失败

`retry-window-hermes-cpa-1` 已恢复。最初 live runner 在序列化原生完整行时遇到两个 `display_identity` BLOB（各 32 字节），`json.dumps(before)` 抛出 TypeError；发生在 relay 初始化、读取 CPA key、写隔离配置和启动 CLI **之前**，所以模型请求为 0。保留旧 `claude-to-hermes-cpa/cpa-opus-once-2026-09-30` attempt 和窗口 trace，不删除 token 或复用该 attempt。

修复只涉及 QA：`qa_native_sqlite.py` 为 BLOB 写带类型的 base64，并在写快照前验证 encode→JSON→decode 与完整原始行相等；实际验收仍直接比较 raw before/after 所有列。使用该真实数据库验证两个 BLOB 精确回读，并确认改变 BLOB 能检测到；没有启动模型。新 `claude-to-hermes-cpa-v2` 必须先完成相同纯预检，再由主代理调度一次新的模型用例。

## v2 真实用例结果：上游拒绝，未通过

新 `full-interop/claude-to-hermes-cpa-v2` 先完成公开 RPC 导入、完整原生回读与实际 BLOB 编码预检；停止同 UUID 的自有 TUI PID 93495 后，经独立审查和 `retry-window-hermes-cpa-2` 单独监督窗口执行一次。

- 原生 session `20260930_225301_1d8200`；选定模型仍为 `relay/claude-opus-5-5`，未换模型。
- relay **1 次**上游派发，HTTP **503**。CPA 返回 `auth_unavailable: no auth available`，provider 为 relay，并记录最近上游 `permission_denied` / content policy 拒绝。该错误不能被当作目标上下文成功续接；没有按错误文案重试或自动换模型。
- CLI exit 1，input/output/total/cache tokens 均为 0。原生历史追加了“请求未处理”的失败说明；这是客户端失败记录，不是模型继承上下文的证明。`realReplyPassed=false`。
- 原有原生消息（包括两个 BLOB 所有字节）前缀完全不变；来源 SHA 不变、目标仍 1 个。正常重启 Runtime 核对同 operation，重复恢复没有新增消息或会话。
- `ownedCliCleanupCompleted=true`、`isolatedConfigRestored=true`，relay 已关闭，监督窗口已恢复。独立子代理再次只读核对当前 SQLite 与 after 快照完全一致、dispatch/status、源 SHA 与所有恢复字段；未新增模型请求。

证据：`~/Documents/AgentKib-archives/2026-09-30/full-interop/claude-to-hermes-cpa-v2/cpa-opus-once-2026-09-30/`，含 `result.json`、精确 BLOB 快照、契约、原请求、stdout/stderr、relay events 与 `independent-live-evidence-review.json`。本轮只确认链路的安全派发与失败恢复，真实回复仍未通过；其后的 CPA 真实验收暂缓，不通过改身份、修改上下文或反复调用规避上游拒绝。

最新决定：用户选择保留未通过，继续离线验收。已停止后续真实模型和登录请求；503 不重试。
