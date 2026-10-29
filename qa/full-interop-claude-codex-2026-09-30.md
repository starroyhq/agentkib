# Claude Code / Codex 原生目标验收可行性复核（2026-09-30）

当前决定：用户要求保留所有未通过结果，停止真实模型与登录尝试，继续离线验收。Claude 首次真实请求被上游 403 拒绝、Codex 独立登录失败均保留；后续离线回读或编译通过不改变这两项状态。

## 本轮范围与身份

起始源码为 `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，工作树 `main-acceptance-20260930`。初始调查后，在独立官方 Codex 0.146.1 原生回读实验发现并修复 renderer 缺陷（详见下节），没有调整生产 gate，没有读取原用户会话、输出或迁移凭据。初始探测未启动模型或修改全局配置；后续明确授权的临时窗口与首次真实失败见末尾。用户后续已允许使用已有授权；每例单轮、不自动重试的约束继续有效。

在空的独立 HOME/配置目录执行版本、help 和 schema 生成；进程环境按白名单构造，没有继承模型凭据环境变量。证据保存在本机 `~/Documents/AgentKib-archives/2026-09-30/full-interop-claude-codex/`。

| 项目 | 实际结果 |
| --- | --- |
| Claude 可执行文件 | `/Users/user/.local/share/claude/versions/2.1.285`，版本输出 `2.1.285 (Claude Code)` |
| Codex 可执行文件 | `/opt/homebrew/Caskroom/codex/0.155.1/bin/codex`，版本输出 `codex-cli 0.155.1` |
| AgentKib 原生写入 gate | Claude major/minor `2.1`；Codex `0.146`；要求版本匹配，已有 schema 匹配不能绕过版本 |
| 本机 Codex app-server schema | `generate-json-schema --experimental` 成功；其 0.155.1 未启动 app-server；随后独立安装 0.146.1 进行离线原生实验 |
| 本地免费模型候选 | 未发现 `ollama`、`lms` 命令，系统/用户 Applications 无对应应用；11434/1234 默认回环端口不可连接 |

## Claude 初始调查：隔离与重试策略（后续窗口实证已更新）

以下记录首次只读调查时的状态；后续临时窗口已执行并恢复，正式 guard 的设置读取方式与实际 403 结果见后文。

初始候选使用的方式：独立 `CLAUDE_CONFIG_DIR`，通过 CLI 的 `--settings /Users/user/.claude/settings.json` 只读引用原设置。由原生 CLI 读取所需身份，无需导出 key 或复制配置。安全模式、空 setting sources、关闭工具/MCP 可限制合成验收上下文；原设置文件需在前后核对 SHA。

只输出允许的配置元信息后发现：当前配置已经不是旧 DeepSeek。原 settings 的 `model=opus`，请求指向 `http://127.0.0.1:15721`；CC Switch `3.20.4` 当前 Claude provider 名为 `cpa`，上游为本机 `8317`，Opus 映射为 `relay/claude-opus-5-5`，Sonnet 映射为 `relay/claude-sonnet-5`。此映射不证明上游可用或会完成真实回复，本轮未请求验证。

重试必须分层判断：

1. Claude `2.1.285` 二进制包含 `CLAUDE_CODE_MAX_RETRIES` 非负值配置逻辑，可对验收进程设置 `0`；还应设置 `CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0`。这不约束外部代理。
2. CC Switch 数据库的 `max_retries=6` **当前并不启用跨 provider 重试**：官方 `v3.20.4` 的 `handler_context.rs` 明确在 `auto_failover_enabled=false` 时强制派生为 `0`；本机该开关确实为 false。不能仅凭存储数值 6 判定实际重试次数。
3. CC Switch 另有 thinking signature、thinking budget、媒体降级的响应后整流重试，与上述 failover 上限不同。当前没有持久化 rectifier 设置；官方该版本默认 `enabled=true`。严格单派发仍需关闭“设置 → 高级 → 整流器”的总开关，或使用已验证且不经过此重试层的直连。这是全局设置，本轮尚未修改。
4. `8317` 由现有 `cli-proxy-api` Docker 容器提供。只读配置元信息：`routing.retry.request-retry=3`、`routing.retry.max-retry-credentials=0`、`routing.retry.max-retry-interval=30`。本地 CPA 源码 `acdace936fa7df2905500c7f5e0a97d683138dea` 的示例明确：0 额外轮次仍可能在初始轮次尝试多份凭据，`max-retry-credentials=0` 表示遍历所有候选。严格单派发至少需要额外轮次为 0、每轮凭据上限为 1、stream bootstrap retries 为 0，并核对目标 provider/auth 的覆盖项不会重新增加轮次。
5. CPA 镜像为本机现有 `eceasy/cli-proxy-api:latest`，image ID `sha256:72bca07ebd7b8139649500501579296193b5503369c5dfe4eb472a8f4b4421c8`；镜像没有版本/revision labels。本地源码不能冒充运行镜像完整对应证据。未读取 auth 文件；其单凭据 retry override 是否存在尚未核验。

在已检查的 CC Switch 官方该版本 handler/forwarder 和本地 CPA handler 中，未发现已建立契约的“本次请求禁用所有重试” header。`Idempotency-Key` 在 CPA handler 中用于关联元数据，不构成防止上游重复派发的保证。仅改变 Claude 环境变量不够；目前不发真实请求。用户随后明确授权临时关闭代理重试并恢复；尚未实际修改，等待完整可恢复执行窗口。

下面是等待上述条件满足后的候选单轮命令，**本轮未执行**。需先使用完整 preview → ChangeSet 链路生成目标 UUID，不能直接向 CLI 编造一段摘要代替导入。

```sh
CLAUDE_CONFIG_DIR=<独立验收根>/claude \
CLAUDE_CODE_MAX_RETRIES=0 \
CLAUDE_CODE_NONSTREAMING_TIMEOUT_RETRIES=0 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
DISABLE_AUTOUPDATER=1 \
/Users/user/.local/bin/claude \
  --settings /Users/user/.claude/settings.json \
  --safe-mode --setting-sources '' --strict-mcp-config --tools '' \
  --permission-mode plan --max-turns 1 --max-budget-usd 0.50 \
  --resume <已核验目标UUID> --print --output-format json \
  '<只询问导入历史里的随机标记与项目决策>'
```

执行器还应使用一次性启动标记拒绝同一用例第二次启动，超时后只核对回执与已存在历史，不重新发送。命令使用原 `opus` 配置，不静默切换模型。供应商回复失败保留原始结果。CLI 自身隐藏的恢复分支及代理生效配置应先以本地失败 fixture 验证，再请求真实模型。

## Codex：重新官方登录可解决凭据复制问题，版本与单轮请求仍独立验收

复核固定 `rust-v0.155.1` 官方 config schema 与源码，旧 QA 对存储绑定的判断仍成立：`CODEX_HOME` 决定 auth 文件与会话根，Keychain 项按规范化目录区分；`sqlite_home` 和 `log_dir` 不能独立重定向全部 rollout 与索引。原登录不会自动出现在新的空目录。

本机实际 schema 的 `thread/resume.path` 仍标记 unstable；`thread/resume.history` 明确仅 Codex Cloud 使用，`chatgptAuthTokens` 登录参数明确仅 OpenAI 内部使用。均不作为绕过隔离、提取现有 token 的方案。

一个不迁移凭据的官方路径是：用户在独立 `CODEX_HOME` 新完成一次 browser/device login。CLI 自己在新目录保存新登录，不接触原来的 auth 文件或历史；应保持原登录不 logout。这需要用户交互，不能由代理复制或读取原 token 代劳。

后续实验顺序：

1. 在独立安装目录取得官方 `0.146.1`，先检查 `--version`、`login --help`、`exec resume --help`、实际 schema 与重试配置支持；不升级用户 `0.155.1`，也不扩大生产版本 gate。
2. 以该固定 CLI 和独立空 `CODEX_HOME` 进行新官方登录，用户亲自完成浏览器授权；既有 CLI 支持 `login --device-auth`，固定旧版是否同样支持需按其实际 help 确认。
3. 在纯合成目录运行生产 preview → ChangeSet → 回读 → 明确 UUID 续接。重试配置先用无凭据本地失败 fixture 验证，保证非流式与流式重连均关闭；只在身份、版本和请求次数均明确后发一轮真实回复。
4. 不使用 `--ephemeral` 来替代重启恢复，不借原始用户 `CODEX_HOME` 初始化 app-server，也不将一次代表来源成功外推其他来源。

CLI 官方支持 `--oss --local-provider ollama|lmstudio`，Ollama 官方也提供 Claude Code Anthropic 兼容接入；但本机未发现可复用服务或模型。引入服务/下载模型不在当前执行授权内，本轮没有执行。用户允许已有授权后，这一替代路线并非必须。

## 官方依据与边界

- [Codex authentication](https://learn.chatgpt.com/docs/auth)：登录存储、独立配置与 device code 登录。
- [Codex advanced configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)：本地 OSS provider 与 provider 重试参数。
- [Codex pricing](https://learn.chatgpt.com/docs/pricing)：本轮读取时 Free 明列桌面 Luna，CLI 列在 Plus；不能由“包含 Codex”概括推断免费 CLI 已对该用户可用。用户后续已有授权允许消除了必须免费这一约束。
- [Claude authentication](https://code.claude.com/docs/en/authentication)：独立 `CLAUDE_CONFIG_DIR` 分离历史、配置和登录；个人接入列 Pro/Max 或 Console。
- [Claude settings](https://code.claude.com/docs/en/settings)：显式设置文件和配置目录语义。
- [Ollama Claude Code integration](https://docs.ollama.com/integrations/claude-code)：官方本地 Anthropic 兼容方案，本轮未安装或使用。
- [CC Switch v3.20.4 handler](https://github.com/farion1231/cc-switch/blob/v3.20.4/src-tauri/src/proxy/handler_context.rs)、[forwarder](https://github.com/farion1231/cc-switch/blob/v3.20.4/src-tauri/src/proxy/forwarder.rs)、[rectifier defaults](https://github.com/farion1231/cc-switch/blob/v3.20.4/src-tauri/src/proxy/types.rs)：区分 failover 和响应后整流重试。

上述网页为当日实际读取；固定源码、help/schema 和元信息证据另存本机档案。Python 直接下载 GitHub raw 首次因 TLS 环境失败，改用系统 curl 正常验证 TLS 后成功，未使用跳过证书校验。两目标本轮真实回复次数均为 **0**；本记录不提升原生互通通过等级。

## Codex 0.146.1 原生离线实验与确定修复

后续已独立安装官方 npm `@openai/codex@0.146.1`，精确版本和 npm integrity 写入隔离目录的 package-lock.json；没有覆盖用户 0.155.1。安装目录为 `~/Documents/AgentKib-archives/2026-09-30/full-interop/tools-codex146/`，原生 darwin-arm64 可执行 SHA256 为 `35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179`。其 `login --help` 已确认正式支持 `--device-auth`，尚未启动登录。

实验用 macOS `sandbox-exec` 明确拒绝全部网络；空 HOME、CODEX_HOME、工作区及白名单环境，无凭据继承。仅允许 `initialize`、`thread/read`、`thread/resume` 和 `thread/list`，不允许 `turn/start`。每例启动 app-server 两次，验证退出重启后的同 UUID 回读；未调用任何模型。原始失败与修正实验都保留，不能由后续成功覆盖。

证据均在上述归档日期的 `full-interop/` 下：

| 独立目录 | 实际结果 |
| --- | --- |
| `codex146-offline-readback-1` | 旧 production 记录形状：`history_mode=save-all`。两次启动均在 read/resume 报未知 variant，官方接受 legacy/paginated；原始脚本当时未将 RPC error 转退出码，结果文件原始错误仍保留，不能按进程 exit 0 记通过 |
| `codex146-offline-readback-legacy` | 只改 legacy，RPC 无错但正文 turns 为空，失败 |
| `codex146-offline-readback-legacy-events` | 合成 legacy+事件投影，原生正文可见；当时默认 list 未含 exec，所以只作为格式探索，不标完整通过 |
| `codex146-offline-production-fixed` | 直接消费修正后的 Rust production renderer 输出字节，read/resume/read 的两次进程轮次全部通过完整角色/顺序/正文逐项比较，包含中文、多行、同文重复出现；同 UUID/工作区、每次 list 恰一项、恰一份 rollout、原始字节前缀保留且无 auth.json |

修复仅位于 `crates/agentkib-conversations/src/continuation.rs`：使用已经固定版本实测的 legacy 模式；每条 Text 同时写模型上下文 response_item 和原生 UI 的 user_message/agent_message 事件；通用校验允许已知 legacy/paginated 和官方省略模式；仅生成载荷 roundtrip 校验拒绝事件遗漏、角色或正文漂移，避免将合法 CLI 追加 developer context 或 multipart 消息误判。工具调用与结果没有伪造为已执行 UI 事件；此前 Tool 角色下的纯 Text→user 映射保持不变。复杂工具/附件的原生 UI 和真实模型行为仍未验收，不因本次文本成功外推。

固定官方源码依据：[history builder](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/app-server-protocol/src/protocol/thread_history.rs) 只用事件构建普通消息展示；[官方 rollout fixture](https://github.com/openai/codex/blob/rust-v0.146.1/codex-rs/app-server/tests/common/rollout.rs) 同样并存 response_item 与 user_message。`thread/list` 的实际 schema 说明缺省仅 interactive 来源；本次保留既有 `source=exec`，显式 `sourceKinds=["exec"]` 检查可发现性，没有宣称默认互动列表可见。

实际执行命令：

```sh
npm install --prefix "$ARCHIVE/full-interop/tools-codex146" --ignore-scripts --no-audit --no-fund
cargo fmt --package agentkib-conversations
cargo test -p agentkib-conversations codex_native_
AGENTKIB_CODEX_PROBE_OUTPUT="$ARCHIVE/full-interop/codex146-renderer-fixed.jsonl" \
AGENTKIB_CODEX_PROBE_CWD="$ARCHIVE/full-interop/codex146-offline-production-fixed/workspace" \
cargo test -p agentkib-conversations export_codex_native_projection_probe -- --ignored
python3 qa/probes/codex-isolated-readback.py "$CODEX146_BINARY" \
  "$ARCHIVE/full-interop/codex146-offline-production-fixed" \
  "$ARCHIVE/full-interop/codex146-renderer-fixed.jsonl"
cargo test -p agentkib-conversations
cargo clippy -p agentkib-conversations --all-targets -- -D warnings
```

其中 ARCHIVE 为 `~/Documents/AgentKib-archives/2026-09-30`；CODEX146_BINARY 为隔离安装内 `node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`。首次全包测试 178 单元+4集成通过、6 项显式 ignored（随后新增合法 CLI 追加历史回归，针对性重跑 3 项通过）；其中新增导出 probe 另以明确输出路径单独运行通过。新增去重回归经过真正 read_codex_document；同文两次保留两次，没有因为双轨记录变四次。Clippy（all-targets，-D warnings）通过；Python probe 语法检查和 git diff --check 通过。未重建 runtime 二进制；完整 AgentKib RPC 预览/确认/应用链路由主任务后续用新构建验证，本实验不冒充该路径或真实回复。

## 临时禁重试窗口准备与首窗恢复实证

运行容器本身执行无效 `--version` 旗标时先输出 `CLIProxyAPI Version: v8.0.4, Commit: d33f63f, BuiltAt: 2026-09-29T00:13:12Z`，随后 usage 退出 2，没有启动另一服务。已下载对应公开 commit 的管理/重载/执行器源码，后续不再用宿主 HEAD 代替镜像证据。只读扫描 auths 的允许元字段：仅一份 `type=relay`、`disabled=false`，无 request_retry 或 request-retry 覆盖；未输出令牌内容或身份文件名。现有管理 secret 为 bcrypt，容器无 MANAGEMENT_PASSWORD，不能拿客户端 key 冒充管理 key。

准备 `qa/probes/temporary-retry-window.py`：由 root 授权的正式窗口命令调用，子进程取得 AGENTKIB_RETRY_WINDOW 指向 0600 journal；status=open 仅在 Docker 挂载内容及当前 watcher 字段变化+成功 reload 日志核对完成后写出。只改 CC Switch rectifier.enabled 与 CPA 三个 retry 字段；完整私有配置备份不入仓库。CPA 保持文件 inode（单文件 Docker bind），SQLite 用事务。恢复只还原自身字段，保留其他并发修改；自身字段被外部改动则保留并报告。独立恢复命令使用持久 journal；不承诺 SIGKILL/断电后自动恢复。

自测仅使用临时 SQLite/YAML 和无模型子进程，最终6项通过：正常/失败退出、无关并发字段保留、同字段冲突不覆盖但恢复其他字段、恢复reload超时不可凭磁盘原值冒充成功、进程退出竞态、恢复期间重复graceful信号与handler还原。独立审查修正了上述恢复确认、全局互斥及信号边界。


主任务随后执行首个真实窗口 `full-interop/retry-window-opencode-cpa-1`。本子任务在窗口结束后只读独立核对：status=restored；CPA 配置 SHA256 与原始完整一致，为 `1f625c3c36d7c260da70beffd665f4447ce495b7f5c6788ce40a025d6bd873bf`；request-retry=3、max-retry-credentials=0；临时 streaming 块删除恢复原缺省；CC Switch rectifier 行精确恢复原先不存在。运行容器日志确认 `request-retry: 0 -> 3`、`max-retry-credentials: 1 -> 0` 和 config successfully reloaded。对应 OpenCode 单轮业务结果由该方向 QA 记录，不将其计为 Claude/Codex 模型验收。

## Claude 单次 guard 的实际 CLI 验证

原候选 `--settings 原文件` 配合环境覆盖 BASE_URL 的方式不可直接用于 guard：本机 2.1.285 会优先应用 settings 内 env，合成测试中指向不可用9端口且沙箱阻止外联，0派发。改为仅进程内读取原 settings 的 ANTHROPIC_* 与 model，认证值只进入短命子进程环境；`--settings`只传无秘密的 model JSON，BASE_URL 指向临时 loopback guard。未复制到其他 Agent auth 文件，原设置不写入。本节替代上面尚未执行的旧候选命令。

`qa/probes/claude-native-once.py` 使用本机固定 CLI SHA256 `51f09bd1e021d9fa8a1864c179799bd37cb39962a937935c5cf6823398e86db4`；CLI 仅能连接被 macOS sandbox 放行的单一 loopback 端口。真实 guard 转发现有15721代理，无其他上游可达。凭据不进入命令参数或持久配置；stdout/stderr先内存删去已知认证值再0600存档。启动标记采用独占创建+fsync（含父目录），丢失回执也不重跑同一用例。

合成失败实验（所有上游真实请求数为0）：

| 情况 | CLI 可观察结果 |
| --- | --- |
| 401/429/500、400 thinking signature、接受请求后断连接 | CLI 失败退出，guard接受1次、无重复 |
| 不完整 SSE | 即使 MAX_RETRIES=0，CLI仍产生额外恢复尝试；guard仅接受第1次、后续拒绝。不能声称CLI开关已禁用全部恢复 |
| 实际合成续接（production导入内容复制到另一隔离case） | 完整 notice/用户/助手/新提示的角色、顺序与正文经真实请求逐项校验，模型alias为claude-opus-5，tools为空，1次请求命中合成500，0重复；原public-v3不改动 |

唯一格式归一化由实测限定：固定CLI把相邻user消息合并时，给第一条导入notice加一个换行；其他正文不trim、不容忍缺失/增文/改角色。CC Switch v3.20.4 `model_mapper.rs:88-91` 对包含opus的alias优先映射当前provider DEFAULT_OPUS_MODEL；真实preflight同时固定原alias=claude-opus-5与目标映射=relay/claude-opus-5-5，避免映射漂移。

最终合成CLI证据目录 `full-interop/claude-once-mock-resume-final-v2`，probe SHA256 `91a45da6fa2d949b8632a3bc868d072c5d56566ded63dfa7ab1cbf2ef0d2afe2`。guard还通过纯mock：7个错误模型/工具/正文/角色/提示负例，connect迟返时禁止派发，HTTPResponse持有socket时仍可取消。使用共享 `qa_owned_cli` 清理仅自有进程组（含leader先退出留下的后代），额外graceful信号不能跳过清理。

上述准备后已获独立review放行，由主任务执行了一次监督窗口（结果见下一节）。成功判据仍要求CLI正常终态、完整marker和decision、原UUID、单条真实派发、无额外请求、原source不变、目标历史前缀不变、只1份会话文件。失败不自动换模型或重试。

## Codex 独立登录补充事实

固定0.146.1的默认浏览器回调1455无CLI/config/env覆盖项；官方代码有1457后备，但切换前会向占用1455的服务发一次GET /cancel。因此不能用默认login保证不触碰占用1455的既有Docker服务。正式 `--device-auth` 不需要该监听端口；独立目录显式 `cli_auth_credentials_store="file"` 让CLI自己保存新授权，不读取/复制旧auth。主任务后续实际设备登录初始取得码，但轮询网络错误退出且未产生auth文件；已停止，没有自动重新发起。此部分仍是授权环境阻塞，不把离线回读升级成真实回复通过。


## Codex → Claude 首次真实单轮：渠道拒绝，未通过

主任务执行 `temporary-retry-window.py run .../retry-window-claude-1 -- python3 qa/probes/claude-native-once.py live .../codex-to-claude-public-v3` 前，精确停止该合成case旧TUI的两个自有进程并验证退出，证据为 `pre-live-tui-cleanup.json`。没有接管或停止用户原终端。

实际结果：

- 请求完整历史、原生 UUID、workspace、模型 alias `claude-opus-5` 与空工具集合均通过派发前校验。真实上游派发1次；CLI随后尝试恢复1次，guard拒绝且没有额外上游派发。CLI exit 1；marker/decision没有回复，不通过。
- 不能用最终 CLI 的 `400 One-shot guard rejected...` 冒充第一次失败原因。只读追查同一 UUID/时间窗口：CC Switch记录外层HTTP200、模型映射 `relay/claude-opus-5-5`；CPA对应原始错误日志 RESPONSE 为 **403**，SSE `event:error` / `permission_error`，原因是 `relay upstream error (permission_denied): Your request was blocked by our content policy`。是渠道对该原生请求的拒绝，当前证据不支持归因于模型回答能力，也不是正文guard失配。
- CLI `modelUsage={}`，原生usage全0；代理日志input_tokens=1743、output_tokens=0。这两种计量分别记录，不把代理输入统计当已确认生成用量或账单。未更换模型、调整提示绕过拒绝、重置auth健康或自动重试。
- 原 UUID `14bd1bbc-4361-452f-aad2-e0f9c85ac668` 保持；所有source SHA不变、原target字节前缀保持、仅1份原生会话文件、原settings SHA不变，自有CLI进程组清理完成。
- `retry-window-claude-1` 的status=restored、errors=[]；只读独立核对CPA完整文件SHA等于原始，CC rectifier行恢复原先不存在；运行reload日志确认0→3、1→0及success。原started token保留，禁止重跑此case。

脱敏首失败证据保存在 `codex-to-claude-public-v3/first-upstream-diagnosis.json`，只提取403/error事件与代理计量，并记录原始日志SHA；**没有复制包含Authorization的完整请求日志**。`provider-metadata-readonly.json` 仅记录允许元字段：一份relay身份、disabled=false，磁盘无可读cooldown字段。磁盘元信息不能替代运行中scheduler状态，也不能从这一个403推断整条渠道永久不可用。后续所有真实CPA尝试由主任务暂缓，等待授权/渠道条件解决；本次失败不会被另一个来源成功掩盖。

按用户最新要求，所有真实模型与登录操作现已停止；保留上述未通过结果，后续仅做离线验收。
