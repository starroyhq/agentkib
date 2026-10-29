# Grok / Cursor / Antigravity 原生目标缺口复核

日期：2026-09-30；起点源码 `0440d04`。本轮只读产品代码、官方文档及 CLI help/version；未读取用户会话或凭据，未调用模型，未运行安装器，未升级用户安装，未写入任何未知原生存储。下载和日志保存在私有 `~/Documents/AgentKib-archives/2026-09-30/full-interop/target-gaps/`，目录权限 `0700`。

## 本次新增证据

| 产品表面 | 本次实际版本与入口 | 原生目标当前结论 |
| --- | --- | --- |
| Grok Build CLI | 官方 stable `1.0.44 (5b807183dd79)`；`--resume <UUID>`、`export <UUID>` | 官方文档仍列 import，但本次 `grok help import` 实际 exit 2 / unrecognized；`sessions restore` 同样不存在。不能把 `grok import payload` 当作受支持调用，可能落入 prompt 分支。 |
| Cursor CLI | 用户安装仍 `2025.09.18-7ae6800`；另下载隔离 `2026.09.28-64d2043` | 新版 help 仍仅 create-chat/resume，没有外来历史导入。官方 ACP new/load 只能创建空会话或载入已有身份，不提供任意历史恢复。 |
| Cursor IDE | 本机已为 `3.22.12`，旧实验为 `3.22.7` | 官方安装包仍注册 `developer.bulkImportChats`、`composer.openComposer`；源码确认 bulk 调用接受目录并只返回成功/失败数量。随后以两个隔离普通窗口实测各导入一次，完整 root/blob 回读及按 ID 选中通过；同 profile 重启后两个原 ID 与完整内容保持；视觉 UI 和模型回复仍未验收，详见末节。 |
| Cursor Agents Window | 与 IDE 同一应用版本，独立 `workbench.glass.main.js` | 保留 Claude Code session registry、界面 import 和 bulk 命令；不能把 IDE 的成功实验当作 Agents Window 路由/身份恢复已验收。 |
| Antigravity Desktop | 本机 `2.12.2`，只读应用 Info.plist | 本轮未发现可供外部 SessionDocument 调用的受测导入入口；官方 Desktop→CLI 迁移不证明 Desktop 接受外来历史。 |
| Antigravity CLI | 官方 manifest `1.2.14`；下载 SHA512 与 manifest 相符 | `--conversation <ID>` 恢复；`/resume` 提供官方 Desktop 克隆。help 明确 stream-json 每行执行一轮 prompt，因此不能拿它回填历史或工具记录。未发现外来原生 import。 |
| Antigravity ACP | 项目使用官方 `agy_acp_server.par/.exe`，协商 list/load | 当前 PATH 未发现这两个 server；现有来源适配支持 ACP 回放。new/load 并不等于写入历史，不能推导 Desktop/CLI 能恢复该外部会话。 |

本轮继续维持上述原生目标禁用。原因是写入/身份恢复契约尚未验证；不是笼统断言产品没有任何导入能力。

## 可安全执行的下一项实验

- **Grok**：在隔离目录研究官方 ACP 能力声明和当前二进制的持久化事件类型。先用 initialize 确认扩展方法，只有出现明确离线 import/restore 接口后才生成合成载荷。现有 `chat_history.jsonl` 来源解析能力不证明权威 `updates.jsonl` 可写；不再重复旧的猜测文件布局实验。
- **Cursor CLI**：对固定 `2026.09.28-64d2043` 包查找官方 checkpoint/blob writer 与 schema，建立 synthetic-only roundtrip。必须验证工作区归属、完整正文、独立 ID、重启恢复；缺契约保持禁用。SDK 的自定义 checkpoint store 是另一运行表面，不能冒充 CLI/IDE 会话。
- **Cursor IDE**：优先复验固定 `3.22.12` 的离线官方 bulk import，再在隔离普通 profile 中通过官方扩展命令测试“两个窗口、不同活动会话、指定目标 ID”的路由。使用独立 user-data/extensions/workspace，不关闭或修改用户窗口，不将开发宿主选中状态当作普通窗口按 ID 打开契约。
- **Cursor Agents Window**：单独验证界面 import 的工作区选择、生成 ID、原生回读以及重启后指定 ID；IDE 部分只复用载荷转换研究。bulk 返回 `{imported:0,failed:0}` 必须失败，不能自动重跑未知结果。
- **Antigravity Desktop/CLI**：官方 Desktop→CLI 只能用隔离合成 Desktop 会话实验；此前仍需建立 Desktop 空会话/导入与独立目录方案。CLI 新版本可先核验初始化与配置目录隔离，不把 `--print`/stream-json 当导入。SDK 的 save_dir/conversation_id 是 SDK 的持久会话接口，目前没有证据证明其存储等价于 Desktop 或 CLI。
- **Antigravity ACP**：先取得可冻结身份的官方 server 及其隔离状态配置，只做 initialize；无扩展导入能力就保留来源端，不通过 session/prompt 重放历史。来源 list/load 的现有测试不扩大为目标端通过。

以上均为下一实验设计，本轮没有执行这些写入实验，也没有提高兼容矩阵门限。

## 授权与既有登录边界

用户已允许使用既有可用授权，不再仅限免费模型；仍要求每例单轮、不自动重试、不迁移凭据。该授权变化不解决缺失的原生导入与恢复契约。

Antigravity [官方安装/授权文档](https://www.antigravity.google/docs/cli/install/) 明确 CLI 自身可从系统 keyring 静默使用已有登录。后续可以核验由官方 CLI 自行访问登录且把测试数据隔离的方法；本轮未启动登录流程或读取 keyring。不能把隔离 HOME 自动视作已隔离所有会话与凭据。

Cursor [官方 ACP 文档](https://cursor.com/docs/cli/acp) 支持已有 CLI 登录或显式 API key；本轮未检查用户是否已登录，也未复制 auth 文件。固定新 CLI 与现有登录是否能独立配置会话存储，仍须在实现前核验。Cursor SDK 的认证/本地存储接口属于 SDK，不能作为 CLI/IDE 已打通证据。

## 实际命令与可核对产物

只下载官方安装脚本文本以读取发布 URL，没有执行脚本：

```text
curl -fL https://x.ai/cli/install.sh
curl -fL https://x.ai/cli/stable
curl -fL https://cursor.com/install
curl -fL https://antigravity.google/cli/install.sh
curl -fL https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json
<isolated>/grok-1.0.44 --version
<isolated>/grok-1.0.44 --help
<isolated>/grok-1.0.44 help import
<isolated>/grok-1.0.44 help sessions
<isolated>/grok-1.0.44 help sessions restore
<isolated>/grok-1.0.44 help agent
<isolated>/cursor/dist-package/cursor-agent --version
<isolated>/cursor/dist-package/cursor-agent --help
<isolated>/agy/antigravity --version
<isolated>/agy/antigravity --help
```

下载的 Grok 单文件与 Cursor/Antigravity tar 包只在私有目录 chmod/安全解压；help 进程使用新的 HOME/配置目录和无凭据环境。最初 Python urllib 使用本机证书库失败，改用系统 curl 正常 TLS 验证，未关闭证书检查。该失败不涉及模型。

| 下载产物 | SHA256 |
| --- | --- |
| Grok 1.0.44 macOS arm64 | `b637a934c22ee480cc133a783712f5abd845ae87f7b0aa646c220af3d67f7c28` |
| Cursor 2026.09.28 macOS arm64 tar | `c0d7e9cd2e62438610b886d3439907dc1f98c2923b07b3a41416cc919aaf53c7` |
| Antigravity 1.2.14 macOS arm64 tar | `468edcc454b6bb1c321d8d42591a16ace4d1a1d628a4f1ce95ad236c9ee4cc19` |

`help-commands.json` 保存 argv、退出码和版本；完整 help 独立保存。`cursor-bulk-handler.json` 保存本机已安装产品的只读研究片段；处理器仍在空工作区返回 0/0，并未增加目标 ID 回执。`evidence-manifest.json` 保存版本与产物哈希。专有程序包/研究片段只保留本机，不加入仓库。

官方资料：[Grok CLI](https://docs.x.ai/build/cli/reference)、[Cursor CLI 参数](https://cursor.com/docs/cli/reference/parameters)、[Cursor SDK](https://cursor.com/docs/sdk/typescript)、[Cursor deeplinks](https://cursor.com/docs/reference/deeplinks)、[Antigravity resume](https://www.antigravity.google/docs/cli/commands/resume/)、[Antigravity SDK 持久化](https://antigravity.google/docs/sdk/lifecycle)。文档与实际固定二进制冲突时以上述实际命令为能力证据；未知版本不自动开放。

## 后续实际实验：Cursor IDE 3.22.12 普通窗口

本轮随后实际执行了两个隔离工作区的普通 IDE 实验，没有使用 `--extensionDevelopmentPath`。临时 fixture 扩展通过官方 `--install-extension <本地VSIX>` 安装到独立 `--extensions-dir`；扩展只调用官方 `developer.bulkImportChats`、`composer.openComposer`、`composer.getOrderedSelectedComposerIds`，未写 Cursor 原生数据库、未发送模型消息。扩展源码为 `qa/probes/cursor-ide-offline-extension.js`。每次动作先独占创建并 fsync 本地 token，同一动作不自动重放；回执保存实际工作区与 `extensionMode`。

证据目录为 `~/Documents/AgentKib-archives/2026-09-30/full-interop/cursor-ide-3.22.12-normal/`。首次以该长路径作为 userdata 启动时，macOS Unix socket 路径超过 103 字符，两个进程在扩展激活之前返回 `listen EINVAL`；没有提交导入动作。随后使用全新的短路径 `/Users/user/.codex/tmp/cursor-ide-0930`，HOME、Cursor 配置与扩展目录仍全部独立，无复制登录。参数包括 `--classic --new-window --use-inmemory-secretstorage --sync off`，关闭隔离配置中的更新、遥测，并使用不可用回环代理；未登录或调用模型。

| 检查 | 实际结果 |
| --- | --- |
| 两个普通工作区同时存在 | 扩展分别报告正确的 A/B 绝对路径、不同 sessionId，`extensionMode=1`（Production），均非开发宿主 |
| 向 A/B 分别执行官方导入 | 每个工作区恰执行一次，各返回 `imported:1, failed:0`；没有重跑 |
| 身份关联 | 每个随机 marker 恰匹配一个新 composerHeaders 项，workspaceIdentifier 精确对应 A/B；B 导入前后 header 集合新增一个目标 |
| 完整原生正文 | 最终两个目标的 conversationState 原始 protobuf 字节与各自载荷相等；全部三个引用 blob 字节及 SHA256 相等，用户/助手角色为 `[1,2]`；未用摘要替代全文 |
| 普通窗口按 ID 打开 | 在各自原普通窗口执行 `composer.openComposer(id)`，`getOrderedSelectedComposerIds` 精确返回对应新 ID，另一个工作区的 ID 未混入；扩展仍为 Production |
| 视觉 UI | 未计通过：Computer Use 按应用名绑定了另一已有 Cursor 进程，未进行任何 UI 动作；停止该观察，不将其它窗口画面用于验收 |
| 重启与真实回复 | 首轮未做重启；下方追加了同 profile 重启检查。真实回复仍未验收，无登录或模型调用 |
| 清理 | 只向本轮创建且命令行包含独立 userdata 的 PID 86333 发送 SIGTERM，确认退出；未关闭用户窗口。短 userdata 保留，`User/` 与 `logs/` 另复制到证据目录 |

目标 A ID 为 `82eda5ea-dc14-445e-b2e8-f1055816ffae`，目标 B ID 为 `5f3c16cc-ae26-458d-853e-f594387678ab`。原始回执、payload、expected、版本启动参数和最终严格字节比较结果分别保存在工作区子目录、`*-launch.json`、`verified-result.json` 中。

**发现了比单纯命令返回更严格的恢复要求：** A 返回导入成功后，header 已有正确身份和名称，但 composerData 暂时仍为空 root/空正文；连续 25 秒只读等待未补齐。后来完成了落盘，最终精确比较通过（不能证明由 open 触发；B 在 open 前也已完整）。因此生产桥接不能将 `{imported:1, failed:0}` 当作可立即安全续接的完成回执，必须等待完整 root/blob/身份核对，超时保留“待核对”而非重导入。

本次缩小了旧“普通窗口没有执行契约”的缺口：安装在隔离普通 profile 的扩展可按工作区执行官方命令并精确选中会话。它仍只是 QA fixture，不是生产适配器；生产扩展安装范围、操作恢复、资料丢失报告及真实 UI/模型验收尚未完成，Cursor 目标门限保持不变。

### 同 profile 重启恢复追加验收

在前一自有进程已退出的基础上，以相同官方二进制、同一个短 userdata 与原来的两个工作区重新启动普通窗口。没有重新导入，也没有发送模型请求。A/B 扩展分别产生新的进程 ID 与 sessionId，仍报告 `extensionMode=1` 和精确工作区路径；排除了误读重启前回执。

向各自窗口发送新的、仅包含既有 UUID 的 `composer.openComposer` 动作。两个窗口的选中列表均精确等于对应原 UUID；启动恢复时的 `before` 也已为原 UUID。本次证明同一 profile 能恢复并重新按 ID 打开，未用“从另一个会话切换”的结果替代这一结论。

随后以只读 SQLite 连接再次逐字节核对两个目标：根 conversationState、各自全部三个 blob 与导入载荷完全相等，blob SHA256 正确，完整用户/助手正文与角色 `[1,2]` 保留，workspaceIdentifier 不变。重启前后 header ID 集合均为 6 项、composerData 键集合均为 4 项，未新增目标；两个源 payload 与 expected 文件的 SHA256 均不变。

原始证据在上述目录的 `restart/`：新旧激活信息、启动参数、两份打开回执、启动前 ID 集合和源哈希、`verified-result.json`、`cleanup.json`。本轮仅停止已核对命令行与 userdata 的自有主进程 PID 10939，确认退出，并把隔离 User/logs 另存到 `restart/userdata-*`。未操作用户窗口。

结论限于 **Cursor IDE 3.22.12、此普通 profile、两个合成纯文本会话的离线导入及重启恢复**。独立视觉 UI、真实回复、AgentKib 生产适配器仍未验收；不外推 CLI 或 Agents Window，不扩大生产门限。

### Grok Build 1.0.44 ACP initialize 离线核验

对固定 SHA 的官方 1.0.44 二进制执行 `grok agent --no-leader stdio`，使用全新 HOME/GROK_HOME、合成空工作区、无任何认证环境，并通过 macOS sandbox 明确禁止全部网络。仅发送一次 ACP `initialize`（协议版本 1），没有 `session/new`、`session/load`、prompt 或工具调用。收到正常 initialize 回执后关闭 stdin，进程退出 0。原始 request/stdout/stderr/argv 保存在 `full-interop/target-gaps/grok-acp-initialize/`。

回执声明 `loadSession:true`，session capabilities 包含 `list/resume/close`，以及 embeddedContext 提示能力；image/audio 为 false。没有声明外来历史 import 能力。`loadSession` 与 `resume` 可恢复已有 Grok 会话，不证明能将 `SessionDocument` 的用户/助手轮次写入新原生会话；embeddedContext 同样不能替代导入。因此 ACP 初始化可用的缺口已缩小，外来历史原生导入契约仍未得到证据，目标门限不变。没有猜测并调用私有 RPC，也没有写入权威会话存储。

最新执行边界：用户已选择“先保留未通过，继续离线验收”。本轮停止所有真实模型和登录请求；上述 Cursor/Grok 离线结论不改变该边界。
