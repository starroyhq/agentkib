# OpenCode 单次派发验收守卫 — 2026-09-30

## 范围与结论

基线 `0440d04`；固定官方 OpenCode `1.18.32`，macOS arm64。没有修改第三方 CLI、生产适配器、版本门限或用户安装。已完成正式插件扩展下的单次派发安全验证，并对既有 Claude → OpenCode 目标发送 **1 次**真实模型请求。官方返回 HTTP 403，未生成回复；**没有新增完整原生互通通过方向**。

固定版本未提供已核验的关闭会话重试配置。官方 `session/llm.ts` 的 SDK `maxRetries` 默认为 0，但 `session/processor.ts` 调用 `SessionRetry.policy`，外层最多 5 次重试；实验性 native LLM 还有独立传输重试。因此仅传 SDK 参数或在收到 SSE retry 后杀进程不能保证一次网络派发。

采用 [OpenCode 正式本地插件接口](https://opencode.ai/docs/plugins/) 的 `config()` hook 注入 provider `options.fetch`：官方 [`provider.ts`](https://github.com/anomalyco/opencode/blob/v1.18.32/packages/opencode/src/provider/provider.ts) 明确在读取 provider 配置前执行插件，随后将该 fetch 交给原生 SDK。此处是验收专用守卫，**不声称 CLI 原生具有关闭全部重试的开关**。

## 守卫约束

- 三个文件：`qa/probes/opencode-once-guard.mjs`、`opencode-once-plugin.mjs`、`opencode-once-selftest.mjs`；正式 CLI loopback 集成由 `opencode-once-native-mock.py` 驱动。
- 契约位于权限 `0700` 的新隔离目录，绑定完整预期历史角色/正文顺序、精确新提示、原生 session ID、model 和 URL。实际请求的 `x-opencode-session` 必须匹配，不构造或改写该身份 header。
- 正式模式只接受 `https://opencode.ai/zen/v1/chat/completions` 与原先选定的 `big-pickle`；禁止 tools。离线模式仅允许精确 `127.0.0.1` HTTP mock 地址。
- 在任何 fetch 前，以 `wx` 创建一次 token，写入契约及请求哈希、session ID，fsync 文件和父目录。后续并发、进程重启、失败重试均无法再次取得 token。无法读取/写入/同步时不派发；结果不明时保留 token，不重置它。
- 发送已经校验的 `Request`，保留原生 SDK body 和 headers；仅设置 `redirect: error`，禁止 307 等隐式第二次 POST。没有转发器，没有重写 User-Agent 或客户端身份，没有设置假 API key。匿名免费入口的 `public` 值由官方客户端自身提供。
- 磁盘配置的 provider URL 默认是 `http://127.0.0.1:9/blocked`，只允许 `opencode` provider；默认插件、title、compaction 被关闭。只有成功创建守卫后的 hook 才**原子替换** `{baseURL, fetch}`。插件缺失、加载抛错或 config hook 被官方吞掉异常时，仍然只能连接不可用的本机地址。

## 实际离线验证

日志根：`~/Documents/AgentKib-archives/2026-09-30/native-interop/`。所有 mock 都在 loopback；请求使用已有合成导入的隔离副本，没有第三方模型流量。

| 场景 | 结果与证据 |
| --- | --- |
| 官方 CLI 收到 HTTP 500 / 429 | 各 1 个 mock POST，外层 retry 再次进入守卫后被 token 拒绝；`native-once-{500,429}-final` |
| 官方 CLI 收到 307 | 原路径 1 个 POST，redirect 目标 0；客户端直接终止；`native-once-redirect-final` |
| 官方 CLI 网络中断 / SSE 流中断 | 各 1 个 mock POST，重试被守卫拒绝；`native-once-{network,stream}-final` |
| 官方 CLI 插件文件缺失 / 加载 throw / config throw | 允许的 mock 地址均 0 请求，保持磁盘 sink；`native-once-{missing-plugin,throw-plugin,throw-config}-final` |
| 最终原子 config 写法再次验证 | 500 仅 1 个 POST，retry blocked；`native-once-atomic-config` |
| 同进程与重新创建守卫 | 500/429/重定向/流中断/网络中断之后均无第二发；`once-guard-selftest-final/results.json` |
| 6 个独立并发进程 | 共享同一个持久 token，总计 1 个 POST |
| URL string 与 Request 输入 | 正文与测试身份 header 保持一致；Request 输入未因 body 被锁而失败 |
| 契约变化 / token 路径不可写 | 0 个 POST，拒绝执行 |

实际命令：

```text
node qa/probes/opencode-once-selftest.mjs <new-selftest-dir>
python3 qa/probes/opencode-once-native-mock.py <official-opencode> <synthetic-export.json> <new-case> <mode>
```

mode 为 `500`、`429`、`redirect`、`stream`、`network`、`missing-plugin`、`throw-plugin`、`throw-config`。固定安装在 `<logs>/tools/opencode/node_modules/.bin/opencode`。Node 标准库自测 8 类、正式 CLI 集成 8 类均已观察到所述边界；真实 CLI 的失败循环在守卫明确拒绝后按自有 PID 结束，不能把退出码 0 当作唯一通过条件。

准备失败也保留：最初官方 `run` 将含空格的单个 argv 提示包上引号；另 `steps:1` 会在请求追加 max-steps 助手记录。守卫因此拒绝，mock 请求数 0。改用官方 stdin 输入、移除 steps 设置后按精确正文通过，没有放宽历史比较。最初 redirect 测试要求必须出现 retry blocked，但官方直接终止；按 token 已消费、唯一 dispatch、目标路径计数重新只读校验既有证据，通过，没有重发 CLI。`native-once-mock*` 保存这些过程。

## 真实回复前检查

必须先完成独立子代理复核。真实执行继续使用现有已经原生导入的目标 session，不重导入；从原生 export 冻结全部历史建立新契约，提示本身不包含待回忆的随机 marker 与项目决定。保持磁盘 sink、选定 `opencode/big-pickle`、无额外 provider/默认插件/工具，去掉离线 flag。契约一旦派发不得删除 token，也不得失败后换模型、重试或重建目录绕过该回执。

一轮完成后记录真实回复/usage，比较全部导入历史前缀、目标会话数量和原始来源哈希；再独立重开目标与 Runtime 校验。官方拒绝、超时或未知结果均保留现场并报告，不用守卫安全通过替代真实回复通过。

## 首次真实回复结果

独立子代理完成冻结守卫复核后，经主代理明确授权，仅运行既有 `opencode-rpc-v2` 目标一次：

```text
python3 qa/probes/opencode-native-once-live.py \
  ~/Documents/AgentKib-archives/2026-09-30/native-interop/opencode-rpc-v2 \
  /Users/user/.codex/worktrees/main-acceptance-20260930/agentkib/target/debug/agentkib-runtime
```

- 执行时间：`2026-09-30T14:12:02Z`。模型固定 `opencode/big-pickle`；原生 session `ses_256d96587f6e4e29b339a5f3c0d74cf5`。没有重新导入，没有切换模型，没有重试。
- 守卫记录仅 1 次 dispatch，HTTP **403**；官方错误 `FreeTierError`：`OpenCode's free tier can only be used from within OpenCode`。CLI 退出码 1，回复为空，原生记录 input/output/reasoning/cache tokens 均为 0，cost 为 0。
- 实际使用固定官方 CLI、正式本地插件和官方匿名 provider；没有修改客户端身份或补伪造 header。403 的服务端判定原因尚未核实，不能据此宣称整个 OpenCode 免费入口不可用，也不通过改身份规避拒绝。
- 原始合成来源 SHA 保持 `31c3167e0519d34875c5aaf34e469c365b71cdff115ac53b5767a2b8bc2e4a76`；目标原生导入历史对象前缀完全不变。新增 1 个用户提问和 1 个错误助手记录，目标会话总数仍为 1。
- 重启目标执行官方 export，可读同一历史；重启 Runtime 后既有 operation 状态仍为 `launched`，operation ID 与目标 ID 相同，重复恢复回执未新增会话或消息。这里验证的是原生导入回执恢复，不能将 `launched` 解读为真实模型回复成功。
- Runtime 二进制 SHA256：`18f225c179dfc891553a182fd1e922b363ff0a5b4414d809738106236489de16`。
- CLI 自动给隔离配置补充 `$schema`，因此字节比较保护保留了该文件，没有立即覆盖。只读核对确认仅此变化后，保存 `cli-normalized-isolated-config.json`，恢复精确原配置。Runtime 回执验证发生在恢复之前，仍为 sink 配置；未启动模型。后续脚本预先包含该字段；没有重跑本例。
- 本次自有 CLI 和 Runtime 都已经退出；持久一次 token、契约、实际请求正文、原生前后 export、模型错误和 stdout/stderr 均保留。

证据目录：`~/Documents/AgentKib-archives/2026-09-30/native-interop/opencode-rpc-v2/official-big-pickle-once-2026-09-30/`。`result.json` 明确 `realReplyPassed=false`。该方向的原生导入/回读/唯一性及恢复继续通过，真实回复仍未验收；不外推其他来源方向。

事后只读补核：`python3 qa/probes/opencode_once_validation.py <opencode-rpc-v2>` 已通过。该验证将实际派发前保存的 `before-export.json` 完整角色/正文与哈希匹配的 `plan.expected` 比较，并校验既有原生 receipt、operation/workspace/session ID。正文变化、plan 哈希变化、目标 ID 漂移 3 个负例均拒绝。初版 live probe 只以 marker/decision 存在检查历史，当前已补上派发前完整投影与回执校验；本例通过既有证据事后核对，没有重新请求模型。配置原文与 CLI 补 schema 后的双方 SHA256 记录在 `result.json`。
