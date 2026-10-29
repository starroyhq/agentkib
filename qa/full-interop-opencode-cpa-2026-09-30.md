# OpenCode → 已有 CPA/Opus 授权准备 — 2026-09-30

用户已明确选择后续新用例使用现有 CPA 的 `relay/claude-opus-5-5` 映射，并允许短命验收进程读取已有授权；不向其他 Agent 的凭据文件复制。此前官方 `opencode/big-pickle` 的 403 请求保留，不重试该用例。已完成本地 mock 和一个新的 Claude → OpenCode 真实回复用例；结果通过，其他方向不外推。

## 正式客户端接入

固定官方 OpenCode `1.18.32` 使用正式 custom provider：

- provider ID `agentkib-cpa`，npm `@ai-sdk/openai-compatible`。
- model `relay/claude-opus-5-5`，真实 endpoint 精确为 `http://127.0.0.1:8317/v1/chat/completions`。
- 隔离磁盘配置只启用该 provider，默认 URL 为不可用的 `http://127.0.0.1:9/blocked`。不存 key；只有正式插件成功加载并创建守卫后，内存注入真实 URL、`fetch` 和短命进程环境中的 key。
- 官方 custom provider 原本生成 `X-Session-Id` 和 `x-session-affinity`，守卫核对两者与原生 session ID 相同。没有设置免费层的 `x-opencode-client`，守卫反而拒绝它；不冒充免费入口或借用其身份。
- 单次 token 的排他创建、fsync、请求正文/全部历史校验、禁止重定向、并发与重启拒绝重发，复用此前已审查逻辑，但放在独立 CPA 文件，未修改冻结的官方免费实验。

相关文件为 `qa/probes/opencode-cpa-once-{guard,plugin,selftest}.mjs` 与 `opencode-cpa-once-native-mock.py`。

## 离线结果

日志根 `~/Documents/AgentKib-archives/2026-09-30/native-interop/`。

正式未修改 CLI + 本地插件的 `cpa-native-{500,429,redirect,network,stream}` 各仅 1 个 loopback POST；重试被 token 阻止，307 目标 0 个请求。`cpa-native-{missing-plugin,throw-plugin,throw-config}` 均 0 个允许地址请求，磁盘 sink 保持生效。测试只向 loopback mock 提供明确的假测试凭据，不使用真实授权；断言 SDK 按 Bearer 传递该值且没有免费层身份 header。

`cpa-once-selftest/results.json`：Node 22 标准库 8 类通过，包含 6 个并发进程总共 1 个请求、重建守卫不能重发、原始 Request 正文保持、契约变化和 token 写入失败拒绝。mock 脚本扫描所有常规文件（分块带重叠）验证假测试凭据没有落盘，不只检查配置文件。

命令形式：

```text
node qa/probes/opencode-cpa-once-selftest.mjs <new-evidence-dir>
python3 qa/probes/opencode-cpa-once-native-mock.py <official-cli> <synthetic-export> <new-evidence-dir> <mode>
```

独立审查与本机 CPA/CC Switch 重试关闭的实际生效窗口仍为真实调用前置条件。单次客户端派发不代表上游 CPA 只派发一次；必须同时核验代理层。上述 mock 阶段没有修改用户全局配置，没有持久化用户授权；后续实际窗口临时调整与恢复见下文。

## 真实执行器门槛

`qa/probes/opencode-cpa-native-once-live.py` 必须运行于独立 retry-window 执行器子进程：读取 `AGENTKIB_RETRY_WINDOW` 指向的 `0700` 目录内 regular journal，校验 schema 1、status open、精确 endpoint/model、未来至少 180 秒期限，以及 requestRetry 0 / maxRetryCredentials 1 / streamBootstrapRetries 0 / credentialOverrides false / CC Switch rectifier 和 failover false。直接读取 CPA YAML 再检查 `routing.retry.request-retry=0`、`routing.retry.max-retry-credentials=1`、`requests.streaming.bootstrap-retries=0`。守卫在初始化和 token 创建前重验窗口。

正式请求前验证现有 plan SHA、原 import receipt、operation/session/workspace ID、完整预览投影与目标历史相等、全部来源文件及元数据 SHA。已有免费请求失败的目标已经多出一轮错误历史，不能再作为此执行器的新干净用例；本执行器不会删除或覆盖它。每个新 case 只允许一个固定 attempt 目录。

`opencode-cpa-window-selftest.mjs` 在注入的纯假 fetch 上验证：closed、expired、model 变化、retry 启用及初始化后关闭窗口均拒绝，合格窗口才放行；5 个负例、1 次纯 stub fetch，真实网络 0。证据 `cpa-window-selftest/result.json`。

独立审查额外扫描 8 个 mock case 的全部常规文件约 1.23 GB，假凭据标记 0 次落盘，证据 `~/Documents/AgentKib-archives/2026-09-30/full-interop/cpa-independent-credential-scan.json`。此扫描不能替代真实执行后的证据核对。

## 首个实际 CPA 用例通过

主代理在独立审查通过后通过 `temporary-retry-window.py` 打开临时禁重试窗口，仅执行 `full-interop/claude-to-opencode-cpa` 一例，随后立即恢复。窗口证据 `full-interop/retry-window-opencode-cpa-1/journal.json` 标记已恢复；未等待其他 Agent 准备，也未保持全局设置常驻。

```text
<tools/hermes-env/bin/python> qa/probes/opencode-cpa-native-once-live.py \
  <archives>/full-interop/claude-to-opencode-cpa \
  <worktree>/target/debug/agentkib-runtime
```

- 原生 session `ses_4935bf8757414ee2bb8c50e53aa4af15`；目标 plan 原本已选定 `agentkib-cpa/relay/claude-opus-5-5`，没有在失败的免费层目标上重试或改模型。
- 官方 CLI 通过受审查 custom provider 向本机 CPA 派发 **1 次**，HTTP **200**；CLI 正常退出，工具关闭，没有历史工具重放。
- 泛化提示中没有答案。新助手正文为 `AKIB-f715d3ce4b3649329d` 和 `append-only SQLite WAL with namespace cobalt-lake`，与导入历史完整一致。
- 原生回报用量 input 4、output 41、total 45、reasoning 0、cache read/write 0。自定义 provider 原生 cost 字段为 0，**不代表实际账单免费或已核实计费**。
- 导入原始角色/全文严格匹配 `plan.expected`；实际回复后全部旧原生消息对象前缀不变、来源 SHA 不变、目标总数仍为 1。目标与 Runtime 重启读取、同 operation 恢复回执没有新增消息或新会话。
- 原隔离配置精确恢复，自有 CLI 退出；启动前已按完整命令、UUID 和 cwd 确认并停止之前只读 TUI PID 23100，没有处理其他会话。
- 独立子代理事后仅只读复核现有 plan/receipt、before/after export、dispatch/status、来源 SHA 和恢复回执，未产生新请求；结果 `independent-live-evidence-review.json`。

证据：`~/Documents/AgentKib-archives/2026-09-30/full-interop/claude-to-opencode-cpa/cpa-opus-once-2026-09-30/`。其中 `result.json` 为 `realReplyPassed=true`。目前只提升这个指定来源、目标版本、模型映射与 macOS 条件下的用例，不据此宣称全部方向、免费模型或其他平台通过。

清理补充验证：`qa_owned_cli_selftest.py` 对 SIGTERM、SIGINT、SIGHUP 均验证独立 CLI 退出、隔离配置恢复、一次 token 保留以及清理后无继续派发；另模拟退出竞态与 KILL 后 wait 超时，仍执行独立配置恢复 finally。证据 `native-interop/cpa-supervisor-cancellation-final`。CPA YAML 解析异常只输出固定错误，不将原始私有行写入日志。

真实回复后补原生界面验证：`opencode-offline-tui.py <claude-to-opencode-cpa>` 使用原隔离 sink 配置、不提供凭据，以 macOS `deny network*` 两次启动官方 TUI；无任何输入。两次均显示随机 marker 和完整项目决定，之后官方 export 全部消息对象仍与真实回复后快照一致。自有 PID 74972、75633 经 TERM 后有界 KILL 并回收。证据 case 下 `cpa-native-tui-{0,1}.ansi` 与 `cpa-native-tui-result.json`。

最新决定：用户选择保留未通过，继续离线验收。后续不再发送真实模型或登录请求；此前免费层 403 与 Hermes 503 的失败证据保持不变。
