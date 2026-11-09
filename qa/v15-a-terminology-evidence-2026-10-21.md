# v15 A 批术语证据（2026-10-21）

本记录补充 A 批主 QA 的术语证据，不承担颜色、截图或全量测试报告。核对基线为 `5839d16694f2347dc10883e3654d9f38314d9815`，对象是本批最终工作区的用户界面字典、局部文案和调用。设计资料只读，未复制入库。初始定点替换清单只作线索；下列英日文清单重新从当前文件和基线生成，包含后续修正后的 Web 设置指引、协议更新对象、macOS 电脑说明及句式。

## 23 项定稿映射

| # | 原称 → 简体定稿 | 实现位置／键 | 范围与验收 |
| --- | --- | --- | --- |
| 1 | Instructions → 指令 | `assets.instructions`、`catalog.searchPlaceholder`、`overview.contextHealthUncheckedText`、`context.openInstructions` | 资源库、搜索、诊断说明同步；英文自然名称保留，日文英文混用改为“指示”。 |
| 2 | Hooks 与 Profiles → 钩子与配置档 | `assets.hooksProfiles`、`catalog.searchPlaceholder` | 繁体同步；英文 `Hooks & Profiles` 保留，日文改为“フックとプロファイル”。 |
| 3 | 原生资产 → Agent 目录中的资产 | `assets.nativeAssets`、`overview.nativeAssets` | 说明资产所在位置；不更改原生来源判定、只读规则或计数。 |
| 4 | 公共资产源 → 共用资产 | `overview.publicSource`、`assets.summary.sharedConnection` | 共享来源说明同步；不改变共享配置的作用域。 |
| 5 | 可读记录／仅元数据及组合 → 有历史内容／无历史内容 | `sessions.readable`、`sessions.stat.*`、`conversations.filter.metadata`、`conversations.metadataOnly`、`conversations.viewMetadata`、`conversation.metadataOnly`；桌面/Web `catalog-copy.ts` 的 `metadata`、Web i18n `metadataOnly` | 列表、统计、筛选、空态保持同一含义；会话信息、来源缺失原因及发送能力判断保留。 |
| 6 | 未绑定项目 → 未归属工作区 | `sessions.projectless` | 分组名改词；项目归属与工作区模型不变；原有自然英文 `No project`、日文“プロジェクトなし”保留。 |
| 7 | Agent 覆盖矩阵 → 各 Agent 的检查结果 | `doctor.matrix` | 仅诊断表标题；矩阵与检查结果不变。 |
| 8 | 模拟运行环境 → 预览环境 | `context.environment` | 仅上下文预览名称，不变更环境解析。 |
| 9 | MCP Connection → MCP 连接 | `assets.summary.sharedConnection`、`context.noConnection` | 中文去中英混用；英文统一普通名词大小写，日文用“MCP 接続”。 |
| 10 | 补齐到 Agent → 同步到 Agent | `mcp.manage.connect`、`connectHint`、`connection_missing`、`applyConnection` | 仅已审查连接的写入；保留“不启用上游服务、不修改工具分配、不安装 Agent”的说明与独立确认。 |
| 11 | 上下文健康 → 诊断 | `overview.contextHealth` | 诊断入口改词；英文工程名 `Context health` 改为 `Diagnostics`，自然日文“コンテキストの状態”保留。 |
| 12 | Home 资产 → 全局配置 | `assets.summary.homeAsset`、`agents.homeAssets`、`agents.noHomeAssets`、`agents.section.assets`、`agents.homeAssetTypes` | 主入口、空态、类别同步；不改配置路径、作用域或资产数据。 |
| 13 | 已观察 → 已检测到 | `skills.manager.status.observed` | 状态标签改词，内部 `observed` 枚举保留；英文 `Observed` 改为 `Detected`，日文“検出済み”保留。 |
| 14 | Registry／官方 Registry → 官方目录；组合标题 → 高级设置 | `mcp.registry*`、`mcp.checkUpdatesHint`、`mcp.manage.advanced`；新增 `mcp.manage.advancedSections` | 折叠区展开后有“官方目录、运行实例与网络”子标题；搜索、更新、安装和展开行为不变。 |
| 15 | 远控账号 → 账号 | `remote-account-copy.ts` 的 `title`、`intro` 等中文说明 | 简繁同步；英文 `Remote account`、日文“リモートアカウント”是自然用语，保留。 |
| 16 | 生成八位授权码 → 生成授权码 | `web-settings-copy.ts` 的 `generateAccess` | 仅简繁按钮短称；8 位值、有效期、权限档位和信任说明保留；英日的 8 位描述保留。 |
| 17 | 完整远控／完整远控权限 → 完整控制 | `web-settings-copy.ts` 的 `fullAccess`、`codeScope` | 四语权限档位同义改称；完整控制仍含任务控制、审批和上传，不增加权限。 |
| 18 | 暂停公网访问 → 暂停远程访问 | `remote-entry-copy.ts` 的 `pause`、`pauseHint`；`remote-account-copy.ts` 的 `logout`、`unclaimed`、`revokeFailed` | 暂停对象、退出账号影响、后台 Codex 不自动停止的说明保留；英日自然用词保留。 |
| 19 | 托管网页局域网访问／局域网访问（高级） → 局域网直连 | `lan-settings-copy.ts` 的 `title`、`remote-entry-copy.ts` 的 `lanAdvanced` | 四语对应 LAN 直连；风险确认、端口、HTTP 提示、配对与开关不变。 |
| 20 | 桥接服务 → 连接服务 | `remote-entry-copy.ts` 的 `broker`、`switchWarning`；`web-settings-copy.ts` 的 `connectionApplyHint`；Claude 连接服务错误文案 | 只改用户称呼；地址、自建能力、旧凭证不迁移、保存与应用方式不变。 |
| 21 | 附近的 AgentKib → 附近的电脑 | `remote.nearby` | 简繁、英日对象明确为电脑；发现机制与配对不变。 |
| 22 | 一次性配对码／生成一次性连接码 → 配对码／生成连接码 | `remote.code`、桌面/Web `claude-connection-copy.ts` 的 `generate` | 简繁配对短称同步；四语终端按钮去一次性修饰；英语/日语自然配对名称保留“一次性”，有效期和一次性约束均保留。 |
| 23 | 主机 → 电脑（按桌面／Web 上下文） | `remote.*`、`gateway.pairingRequired`、`conversation.*`、会话局部 copy、工作区 Claude 面板、历史搜索提示；新增镜像 `session-surface-copy.ts` | 桌面写这台／其他／对方电脑；Web 的操作明确指向电脑上的 AgentKib，正文索引设置给出页面路径。仅作用于应用静态文案，用户内容和技术详情保持原值。 |

`docs/development/ui-terminology.md` 已同步以上概念，并明确普通界面用“电脑”、技术目标与原始诊断保留 Host。A 批不重排连接终端、远程连接或资源库的布局与步骤；后续 B/C/D 批功能仍保留现有入口和能力。“未分类”保持原称。

## 搜索命令与残留分类

以下命令均在仓库根目录执行。搜索针对用户可见值；键名、类型、API、诊断码和语言自然表达不做机械替换。

### 简体 JSON 的值

```sh
python3 - <<'PY_CHECK'
import json, re
from pathlib import Path
pattern = r"原生资产|公共资产源|可读记录|仅元数据|仅剩元数据|未绑定项目|Agent 覆盖矩阵|模拟运行环境|MCP Connection|补齐到 Agent|上下文健康|Home 资产|已观察|Registry|远控账号|生成八位授权码|完整远控|暂停公网访问|托管网页局域网访问|局域网访问（高级）|桥接服务|附近的 AgentKib|一次性配对码|生成一次性连接码|主机|Hooks 与 Profiles|Instructions"
data = json.loads(Path("apps/desktop/src/locales/zh-CN.json").read_text())
hits = [(key, value) for key, value in data.items() if re.search(pattern, value)]
print("zh-CN value hits:", len(hits))
for hit in hits:
    print(hit)
PY_CHECK
```

实测输出：`zh-CN value hits: 0`。检查包含“仅剩元数据”等组合；不将 `deepseekHarnessInstructions` 等不变的内部键名计作旧文案。

### 桌面和 Web 局部用户文案

```sh
rg -n '原生资产|公共资产源|可读记录|仅元数据|未绑定项目|Agent 覆盖矩阵|模拟运行环境|MCP Connection|补齐到 Agent|上下文健康|Home 资产|已观察|Registry、运行实例与网络设置|远控账号|生成八位授权码|完整远控|暂停公网访问|托管网页局域网访问|局域网访问（高级）|桥接服务|附近的 AgentKib|一次性配对码|生成一次性连接码|主机|Hooks 与 Profiles' \
  apps/desktop/src apps/web/src packages/session-ui/src \
  --glob '*.{ts,tsx,json}' --glob '!*.test.*' --glob '!**/__tests__/**' --glob '!routeTree.gen.ts'
```

实测仅 2 个命中，均为保留的网络技术目标：

| 文件 | 残留 | 分类与保留理由 |
| --- | --- | --- |
| `apps/desktop/src/features/sessions/conversation/features/interactions/native-scope.tsx` | `host: "主机"` | 网络权限详情中的目标主机，与端口、协议等精确字段配套；不能误改成运行 AgentKib 的电脑。 |
| `apps/web/src/features/conversation/features/interactions/native-scope.tsx` | `host: "主机"` | 同一网络权限详情；桌面/Web 技术含义保持一致。 |

```sh
rg -n 'Registry|MCP Connection|Instructions' \
  apps/desktop/src/features apps/desktop/src/routes apps/web/src/features packages/session-ui/src \
  --glob '*.{ts,tsx}' --glob '!*.test.*' --glob '!**/__tests__/**'
```

实测 42 行，均为内部类型、方法、状态或翻译键引用，例如 `McpRegistryEntry`、`searchMcpRegistry`、`registryRequest`、`ArtifactViewerRegistry`、`assets.sharedInstructions`、`installInstructions`。这些不是简体可见值，保持原名。英文 `Instructions` 及 `Hooks & Profiles` 是该语言自然用词，明确保留；日文原有“プロジェクトなし”“検出済み”“コンテキストの状態”也保留。技术协议、第三方产品名、日志事件名、路径、命令、真实文件内容及用户输入均不参与替换。

## 四语键与跨 Agent 文案保护

保护集采用键名包含 `handoff` 的大小写不敏感筛选，覆盖 `handoff.*` 及其他入口/恢复键；不是仅统计前缀。

```sh
python3 - <<'PY_CHECK'
import json, subprocess
from pathlib import Path
base = "5839d16694f2347dc10883e3654d9f38314d9815"
key_sets = []
for locale in ("zh-CN", "zh-TW", "en-US", "ja-JP"):
    path = f"apps/desktop/src/locales/{locale}.json"
    before = json.loads(subprocess.check_output(["git", "show", f"{base}:{path}"]))
    after = json.loads(Path(path).read_text())
    select = lambda data: {k: v for k, v in data.items() if "handoff" in k.lower()}
    print(locale, "keys", len(after), "handoff", len(select(after)),
          "unchanged", select(before) == select(after))
    key_sets.append(set(after))
print("same keys:", all(keys == key_sets[0] for keys in key_sets))
PY_CHECK
```

```text
zh-CN keys 2359 handoff 135 unchanged True
zh-TW keys 2359 handoff 135 unchanged True
en-US keys 2359 handoff 135 unchanged True
ja-JP keys 2359 handoff 135 unchanged True
same keys: True
```

各语言新增 `mcp.manage.advancedSections` 一键，其他键名不变。当前字典值相对基线变更（含新增）如下：

| 语言 | 既有值修改 | 新增值 | 合计 |
| --- | --- | --- | --- |
| zh-CN | 68 | 1 | 69 |
| zh-TW | 68 | 1 | 69 |
| en-US | 57 | 1 | 58 |
| ja-JP | 60 | 1 | 61 |

跨 Agent 的“在其他 Agent 中继续”“交接文件”“在工作区续接”及其四语键值保持基线一致。本批只调整同 Agent 会话/连接环境的应用说明，不改跨 Agent 行为、交接文件或 Codex follower。

## 桌面/Web 镜像与技术详情证据

根目录对应前缀：桌面 `apps/desktop/src/features/sessions/conversation/features/sessions/`，Web `apps/web/src/features/conversation/features/sessions/`。

| 同名文件 | 实测结果 |
| --- | --- |
| `claude-handoff.ts` | 字节一致 |
| `managed-control-copy.ts` | 仅 Locale 类型导入路径不同；去掉该导入后完全一致 |
| `session-display-state.ts` | 字节一致 |
| `claude-session-banner.ts` | 字节一致 |
| `codex-copy.ts` | 字节一致 |
| `session-surface-copy.ts` | 字节一致 |
| `claude-connection-copy.ts` | 字节一致 |
| `managed-copy.ts` | 仅 Locale 类型导入路径不同；去掉该导入后完全一致 |
| `managed-error-copy.ts` | 仅 Locale 类型导入路径不同；去掉该导入后完全一致 |
| `context-usage-copy.ts` | 仅 Locale 类型导入路径不同；去掉该导入后完全一致 |

逐文件直接读取比较；仅四份文件有各端 `Locale` 的类型导入路径差异。可复现检查：

```sh
python3 - <<'PY_CHECK'
from pathlib import Path
import re
desktop = Path("apps/desktop/src/features/sessions/conversation/features/sessions")
web = Path("apps/web/src/features/conversation/features/sessions")
names = ("claude-handoff.ts", "managed-control-copy.ts", "session-display-state.ts",
         "claude-session-banner.ts", "codex-copy.ts", "session-surface-copy.ts",
         "claude-connection-copy.ts", "managed-copy.ts", "managed-error-copy.ts",
         "context-usage-copy.ts")
def normalize(source):
    return re.sub(r'^import type \{ (?:SupportedLocale as )?Locale \} from [^\n]+;\n',
                  '', source, flags=re.M)
for name in names:
    a, b = (desktop / name).read_text(), (web / name).read_text()
    assert normalize(a) == normalize(b), name
    print(name, "byte-equal" if a == b else "equal except Locale import")
PY_CHECK
```

Web 调用显式传入 `"web"`；共享实现的默认仍为桌面。`surfaceText`/`surfaceCopy` 仅处理应用拥有的静态提示，技术错误原文、未知原因、已知 Claude 原因后的原始详情不做替换。回归测试使用含 `this computer / 主机 / ホスト` 的原始技术错误验证其保留，并检查缓存后的文案引用稳定性。后端锁、指纹、权限、占用和发送前检查没有被本次命名修改替代或放宽。

## 英文和日文保留项与理由

| 词／键 | 保留理由 |
| --- | --- |
| 英文 `Instructions`、`Hooks & Profiles`（及搜索中的 Instructions/Skills/Hooks） | 这几项本身就是自然英文，不因中文去中英混排而重译。 |
| 英文 `sessions.projectless = No project`；日文同键“プロジェクトなし” | 既有自然分组名保留；A 批不迁移项目/工作区归属数据模型。 |
| 英文 `mcp.manage.connect = Connect Agents`；日文“Agent に接続”及原说明 | 原有自然动作保留；不误称安装 Agent 或直接启用上游工具。 |
| 日文 `overview.contextHealth = コンテキストの状態` | 既有自然日文，不是 Home/Registry 之类工程名或混排。 |
| 日文 `skills.manager.status.observed = 検出済み` | 已符合“检测到”的意义，保留。 |
| 英文 `Remote account`；日文“リモートアカウント” | 自然说明账号用途，保留；中文标题按定稿简化。 |
| 英文 `Generate 8-digit access code`；日文“8 桁の認証コードを生成” | 自然说明仍真实存在的 8 位格式；中文短称不要求抹掉其他语言的有用信息。 |
| 英文 `Pause public access`；日文“インターネット経由のアクセスを一時停止” | 既有自然表达准确区分公网与 LAN 直连，不强行重译。 |
| 英文 `One-time pairing code`；日文“使い捨てペアリングコード” | 自然且准确说明一次性性质，保留；终端连接的生成按钮另按定稿缩短。 |
| 诊断码、`hostDisconnected`/`registry`/`observed` 等键、协议字段、第三方命令 | 内部名称与技术精确性保留；只修改用户可见值。 |

以下是逐项英日修改清单。`locales` 逐键列出最终值；局部文案列出文件与字段/位置，镜像副本分别列出。Web 行写最终渲染值：当共享字典存放桌面措辞时，已经应用 `surfaceText(..., "web", locale)`，因此不会把早期机械替换的中间句式当作交付值。行号仅帮助定位，后续编辑可能移动。

### 桌面 `locales` 英文逐键清单

| 键 | 基线 | 最终值 | 修改理由 |
| --- | --- | --- | --- |
| `remote.error.pairing` | The pairing code is invalid, expired, or already used. Generate a new code on the host and try again. | The pairing code is invalid, expired, or already used. Generate a new code on the other computer and try again. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.offline` | Cannot reach the host. Check its address, local network connection, and sharing settings. | Cannot reach the other computer. Check its address, local network connection, and sharing settings. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.disconnected` | The connection is closed. Reconnect to the host. | The connection is closed. Reconnect to the other computer. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.revoked` | Access was revoked. Ask the host to approve a new pairing. | Access was revoked. Pair again and approve the request on the other computer. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.identity` | The host's identity has changed. Verify the host and pair again; the new identity has not been trusted automatically. | The other computer’s identity has changed. Verify the computer and pair again; the new identity has not been trusted automatically. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.sharing` | The host has stopped sharing. Ask it to enable local network access. | The other computer has stopped sharing. Enable local network access there. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.index` | The host's session indexing is off. Ask it to enable indexing before viewing history. | Session indexing on the other computer is off. Enable indexing there before viewing history. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.approval` | Pairing has not been approved. Compare the verification digits and wait for the host to approve. | Pairing has not been approved. Compare the verification digits and wait for approval on the other computer. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.self` | This address belongs to this device. Enter the other AgentKib host's address. | This address belongs to this computer. Enter the address of another computer running AgentKib. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.enableSharing` | Enable local network access on this host before generating a pairing code. | Enable local network access on this computer before generating a pairing code. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.pair` | Pair a host | Pair a computer | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.address` | Host IPv4 address and port | Computer IPv4 address and port | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.connections` | Connected hosts | Connected computers | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.noConnections` | No remote hosts. Local sessions remain available. | No remote computers. Local sessions remain available. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.remove` | Remove host | Remove computer | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.removeConfirm` | Remove this host and clear its cached session history? Pair again to reconnect. | Remove this computer and clear its cached session history? Pair again to reconnect. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.nearby` | Nearby AgentKib hosts | Nearby computers | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.noNearby` | No hosts found. Enable sharing on the other device, or enter its local address below. | No computers found. Enable sharing on the other device, or enter its local address below. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.expired` | Pairing expired. Generate a new code on the host. | Pairing expired. Generate a new code on the computer. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.waitApproval` | Waiting for the host to approve. | Waiting for the computer to approve. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.disabled` | Sharing is off. You can still connect to another host. | Sharing is off. You can still connect to another computer. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.allHosts` | All hosts | All computers | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.hostFilter` | Host | Computer | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.state.index-disabled` | Host indexing is off | Computer indexing is off | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.state.identity-changed` | Host identity changed — pair again | Computer identity changed — pair again | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `sessions.readable` | Readable | History available | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `sessions.stat.readable` | Readable records | History available | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `sessions.stat.metadata` | Metadata only | No history content | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `gateway.pairingRequired` | Approve this device on the OpenClaw host | Approve this device on the OpenClaw computer | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `sessions.continuation.remote` | Remote history is read-only. Continue in the Agent on the original host. | Remote history is read-only. Continue in the Agent on the original computer. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `assets.nativeAssets` | Native assets | Assets in Agent folders | 明确资产来自 Agent 目录，避免原生一词歧义。 |
| `assets.summary.homeAsset` | {{agent}} Home asset (read-only) | {{agent}} global settings (read-only) | 以配置作用域代替 Home 目录工程名。 |
| `assets.summary.sharedConnection` | Shared MCP Connection | Shared MCP connection | 统一 MCP 连接的自然用词与普通名词大小写。 |
| `agents.homeAssets` | Home Assets | Global settings | 以配置作用域代替 Home 目录工程名。 |
| `agents.noHomeAssets` | No Home assets available for inventory | No global settings available for inventory | 以配置作用域代替 Home 目录工程名。 |
| `overview.nativeAssets` | {{count}} native assets | {{count}} assets in Agent folders | 明确资产来自 Agent 目录，避免原生一词歧义。 |
| `overview.publicSource` | Public Asset Source | Shared assets | 描述共用资产，去掉来源模型术语。 |
| `context.environment` | Simulated Runtime | Preview environment | 描述预览用途，避免被误解为运行环境模拟。 |
| `context.noConnection` | No MCP Connection | No MCP connection | 统一 MCP 连接的自然用词与普通名词大小写。 |
| `mcp.registry` | Official Registry | Official directory | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `skills.manager.status.observed` | Observed | Detected | Detected 明确为检测结果，内部 observed 状态不变。 |
| `mcp.registryEmpty` | Search the official Registry to find a server. | Search the official directory to find a server. | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.registrySearching` | Searching the Registry… | Searching the official directory… | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.registryNoResults` | No MCP services matched this Registry search. Try another search term. | No MCP services matched this directory search. Try another search term. | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.registrySearchFailed` | Registry search failed. Try the search again. | Directory search failed. Try the search again. | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `overview.contextHealth` | Context health | Diagnostics | 普通入口直接说明诊断用途。 |
| `agents.section.assets` | Home Assets | Global settings | 以配置作用域代替 Home 目录工程名。 |
| `agents.homeAssetTypes` | Home Asset Types | Global setting types | 以配置作用域代替 Home 目录工程名。 |
| `conversations.filter.metadata` | Metadata only | No history content | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `conversations.metadataOnly` | Metadata only | No history content | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `conversations.viewMetadata` | View metadata | View session info | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `doctor.matrix` | Agent coverage | Checks by Agent | 描述按 Agent 展示的检查结果，去掉覆盖率工程术语。 |
| `mcp.manage.advanced` | Registry, runtimes and network | Advanced settings | 折叠区改为通用高级设置标题，细分内容移入子标题。 |
| `conversation.localExecution` | Execution environment: the host (the computer running the Agent) | Execution environment: this computer | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `conversation.unverifiedInstallation` | The host Agent installation or version could not be verified. Control is disabled. Check the installation in the desktop app. | The Agent installation or version on this computer could not be verified. Control is disabled. Check the installation. | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `conversation.metadataOnly` | Metadata only · No readable history | No history content | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `mcp.checkUpdatesHint` | Search the Registry to check for updates. | Search the official directory to check for updates. | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.manage.advancedSections` | （新增） | Official directory, runtimes and network | 补齐高级设置展开后的语义子标题。 |

### 桌面 `locales` 日文逐键清单

| 键 | 基线 | 最终值 | 修改理由 |
| --- | --- | --- | --- |
| `remote.error.pairing` | ペアリングコードが無効、期限切れ、または使用済みです。ホストで新しいコードを生成して再試行してください。 | ペアリングコードが無効、期限切れ、または使用済みです。コンピューターで新しいコードを生成して再試行してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.offline` | ホストに接続できません。アドレス、ローカルネットワーク接続、共有設定を確認してください。 | コンピューターに接続できません。アドレス、ローカルネットワーク接続、共有設定を確認してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.disconnected` | 接続が切断されました。ホストに再接続してください。 | 接続が切断されました。コンピューターに再接続してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.revoked` | アクセス権が取り消されました。再度ペアリングし、ホストの承認を待ってください。 | アクセス権が取り消されました。再度ペアリングし、コンピューターの承認を待ってください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.identity` | ホストの識別情報が変更されました。ホストを確認して再度ペアリングしてください。新しい識別情報は自動的には信頼されません。 | コンピューターの識別情報が変更されました。コンピューターを確認して再度ペアリングしてください。新しい識別情報は自動的には信頼されません。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.sharing` | ホストが共有を停止しました。ホストでローカルネットワークアクセスを有効にしてください。 | コンピューターが共有を停止しました。コンピューターでローカルネットワークアクセスを有効にしてください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.index` | ホストの会話索引が無効です。履歴を表示するにはホストで索引を有効にしてください。 | コンピューターの会話索引が無効です。履歴を表示するにはコンピューターで索引を有効にしてください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.approval` | ペアリングはまだ承認されていません。両端の確認番号を照合し、ホストの承認を待ってください。 | ペアリングはまだ承認されていません。両端の確認番号を照合し、コンピューターの承認を待ってください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.self` | このアドレスはこの端末のものです。別の AgentKib ホストのアドレスを入力してください。 | このアドレスはこの端末のものです。別の AgentKib コンピューターのアドレスを入力してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.error.enableSharing` | ペアリングコードを生成する前に、このホストでローカルネットワークアクセスを有効にしてください。 | ペアリングコードを生成する前に、このコンピューターでローカルネットワークアクセスを有効にしてください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.pair` | ホストとペアリング | コンピューターとペアリング | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.address` | ホストの IPv4 アドレスとポート | コンピューターの IPv4 アドレスとポート | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.connections` | 接続済みホスト | 接続済みコンピューター | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.noConnections` | リモートホストはありません。ローカル会話は引き続き利用できます。 | リモートコンピューターはありません。ローカル会話は引き続き利用できます。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.remove` | ホストを削除 | コンピューターを削除 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.removeConfirm` | ホストと会話キャッシュを削除しますか？再接続には再ペアリングが必要です。 | コンピューターと会話キャッシュを削除しますか？再接続には再ペアリングが必要です。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.nearby` | 近くの AgentKib | 近くのコンピューター | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.noNearby` | ホストが見つかりません。相手の共有を有効にするか、下にローカルアドレスを入力してください。 | コンピューターが見つかりません。相手の共有を有効にするか、下にローカルアドレスを入力してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.expired` | ペアリングが期限切れです。ホストで新しいコードを発行してください。 | ペアリングが期限切れです。コンピューターで新しいコードを発行してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.waitApproval` | ホストの承認を待っています。 | コンピューターの承認を待っています。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.disabled` | 共有はオフです。他のホストには接続できます。 | 共有はオフです。他のコンピューターには接続できます。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.allHosts` | すべてのホスト | すべてのコンピューター | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.hostFilter` | ホスト | コンピューター | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.state.index-disabled` | ホスト索引オフ | コンピューター索引オフ | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `remote.state.identity-changed` | ホストの識別情報が変更されました — 再ペアリングが必要 | コンピューターの識別情報が変更されました — 再ペアリングが必要 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `sessions.readable` | 閲覧可能 | 履歴あり | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `sessions.stat.readable` | 閲覧可能 | 履歴あり | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `sessions.stat.metadata` | メタデータのみ | 履歴なし | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `gateway.pairingRequired` | OpenClaw ホストでこのデバイスを承認してください | OpenClaw コンピューターでこのデバイスを承認してください | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `assets.instructions` | Instructions | 指示 | 去掉日文中的英文混排，使用自然日文。 |
| `assets.hooksProfiles` | Hooks と Profiles | フックとプロファイル | 去掉日文中的英文混排，使用自然日文。 |
| `sessions.continuation.remote` | リモート履歴は閲覧専用です。元のホストの Agent で続行してください。 | リモート履歴は閲覧専用です。元のコンピューターの Agent で続行してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `assets.nativeAssets` | ネイティブアセット | Agent フォルダー内のアセット | 明确资产来自 Agent 目录，避免原生一词歧义。 |
| `assets.summary.homeAsset` | {{agent}} Home アセット（読み取り専用） | {{agent}} のグローバル設定（読み取り専用） | 以配置作用域代替 Home 目录工程名。 |
| `assets.summary.sharedConnection` | 共有 MCP Connection | 共有 MCP 接続 | 统一 MCP 连接的自然用词与普通名词大小写。 |
| `agents.homeAssets` | Home アセット | グローバル設定 | 以配置作用域代替 Home 目录工程名。 |
| `agents.noHomeAssets` | 一覧表示可能な Home アセットはありません | 一覧表示可能なグローバル設定はありません | 以配置作用域代替 Home 目录工程名。 |
| `catalog.searchPlaceholder` | Instructions、Skills、MCP、Hooks を検索… | 指示、スキル、MCP、フックを検索… | 去掉日文中的英文混排，使用自然日文。 |
| `overview.nativeAssets` | ネイティブアセット {{count}} 件 | Agent フォルダー内のアセット {{count}} 件 | 明确资产来自 Agent 目录，避免原生一词歧义。 |
| `overview.publicSource` | 公共アセットソース | 共有アセット | 描述共用资产，去掉来源模型术语。 |
| `context.environment` | ランタイムをシミュレート | プレビュー環境 | 描述预览用途，避免被误解为运行环境模拟。 |
| `context.noConnection` | MCP Connection なし | MCP 接続なし | 统一 MCP 连接的自然用词与普通名词大小写。 |
| `mcp.registry` | 公式 Registry | 公式ディレクトリ | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.registryEmpty` | 公式 Registry を検索して Server を探します。 | 公式ディレクトリを検索して MCP サービスを探します。 | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.registrySearching` | Registry を検索中… | 公式ディレクトリを検索中… | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.registryNoResults` | この Registry 検索に一致する MCP サービスはありません。別の検索語をお試しください。 | このディレクトリ検索に一致する MCP サービスはありません。別の検索語をお試しください。 | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.registrySearchFailed` | Registry の検索に失敗しました。再検索してください。 | ディレクトリの検索に失敗しました。再検索してください。 | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `overview.contextHealthUncheckedText` | 各 Agent が実際に参照できる Instructions、Skills、MCP を確定的に検査します。 | 各 Agent が実際に参照できる指示、スキル、MCP を確定的に検査します。 | 去掉日文中的英文混排，使用自然日文。 |
| `agents.section.assets` | Home アセット | グローバル設定 | 以配置作用域代替 Home 目录工程名。 |
| `agents.homeAssetTypes` | Home アセット種別 | グローバル設定の種類 | 以配置作用域代替 Home 目录工程名。 |
| `context.openInstructions` | Instructions を開く | 指示を開く | 去掉日文中的英文混排，使用自然日文。 |
| `conversations.filter.metadata` | メタデータのみ | 履歴なし | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `conversations.metadataOnly` | メタデータのみ | 履歴なし | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `conversations.viewMetadata` | メタデータを表示 | 会話情報を表示 | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `doctor.matrix` | Agent カバレッジ | Agent ごとの検査結果 | 描述按 Agent 展示的检查结果，去掉覆盖率工程术语。 |
| `mcp.manage.advanced` | Registry・実行インスタンス・ネットワーク | 詳細設定 | 折叠区改为通用高级设置标题，细分内容移入子标题。 |
| `conversation.localExecution` | 実行環境：ホスト（Agent を実行するコンピューター） | 実行環境：このコンピューター | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `conversation.unverifiedInstallation` | ホストの Agent のインストールまたはバージョンを確認できないため、制御は無効です。デスクトップアプリでインストールを確認してください。 | このコンピューターの Agent のインストールまたはバージョンを確認できないため、制御は無効です。インストールを確認してください。 | 去掉 Host/ホスト 工程称呼，明确执行/共享电脑；保留原检查与恢复条件。 |
| `conversation.metadataOnly` | メタデータのみ · 閲覧可能な履歴なし | 履歴なし | 直接说明历史有无；不把信息可见性当成执行权限。 |
| `mcp.checkUpdatesHint` | Registry を検索すると更新を確認できます。 | 公式ディレクトリを検索すると更新を確認できます。 | 官方目录采用用户可理解的名称，搜索与更新行为不变。 |
| `mcp.manage.advancedSections` | （新增） | 公式ディレクトリ・実行インスタンス・ネットワーク | 补齐高级设置展开后的语义子标题。 |

### 局部文案的英文／日文逐项清单

#### `apps/desktop/src/features/remote/lan-settings-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / title | Hosted Web LAN access | LAN direct connection | 去掉 Hosted Web 工程表达，采用 LAN 直接连接。 |
| ja-JP / title | ホスト型 Web の LAN アクセス | LAN 直接接続 | 去掉 Hosted Web 工程表达，采用 LAN 直接连接。 |

#### `apps/desktop/src/features/remote/remote-entry-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / switchWarning | Changing bridge service stops the old connection and clears browser grants. Pair your phone again; old service credentials are not transferred. | Changing connection service stops the old connection and clears browser grants. Pair your phone again; old service credentials are not transferred. | 连接服务采用用户称呼；地址、凭据迁移与应用方式不变。 |
| en-US / broker | Bridge service (official or self-hosted) | Connection service (official or self-hosted) | 连接服务采用用户称呼；地址、凭据迁移与应用方式不变。 |
| en-US / lanAdvanced | LAN access (advanced) | LAN direct connection | 去掉 Hosted Web 工程表达，采用 LAN 直接连接。 |
| ja-JP / broker | ブリッジサービス（公式またはセルフホスト） | 接続サービス（公式またはセルフホスト） | 连接服务采用用户称呼；地址、凭据迁移与应用方式不变。 |
| ja-JP / lanAdvanced | LAN アクセス（詳細） | LAN 直接接続 | 去掉 Hosted Web 工程表达，采用 LAN 直接连接。 |

#### `apps/desktop/src/features/remote/web-settings-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / connectionApplyHint | Apply bridge service and executable changes using the remote access button above. “Save settings” does not apply them. | Apply connection service and executable changes using the remote access button above. “Save settings” does not apply them. | 连接服务采用用户称呼；地址、凭据迁移与应用方式不变。 |
| en-US / codeScope | A valid access code authorizes all AgentKib workspaces at the selected level without another desktop confirmation. Read-only allows session history and files; full remote access adds task control, approvals and uploads. Change the level or revoke access below at any time. Share only with trusted devices. | A valid access code authorizes all AgentKib workspaces at the selected level without another desktop confirmation. Read-only allows session history and files; full control adds task control, approvals and uploads. Change the level or revoke access below at any time. Share only with trusted devices. | 完整控制采用自然用词；授权范围、信任和撤销说明保持。 |
| en-US / fullAccess | Full remote access | Full control | 完整控制采用自然用词；授权范围、信任和撤销说明保持。 |
| en-US / warning | Experimental controls require a verified host and session. Stopping interrupts a turn; background commands may still run. | Experimental controls require a verified computer and session. Stopping interrupts a turn; background commands may still run. | 电脑代替 host；日文同时补齐后台命令不保证结束的原有安全含义。 |
| ja-JP / codeScope | 有効な認証コードで、選択したレベルに応じて全 AgentKib ワークスペースへのアクセスを許可します。デスクトップでの再確認は不要です。「閲覧のみ」は会話履歴とファイルの閲覧、「完全なリモートアクセス」はタスク操作・承認・アップロードも含みます。レベルの変更や取り消しは下でいつでも行えます。信頼できる端末にのみ共有してください。 | 有効な認証コードで、選択したレベルに応じて全 AgentKib ワークスペースへのアクセスを許可します。デスクトップでの再確認は不要です。「閲覧のみ」は会話履歴とファイルの閲覧、「フルコントロール」はタスク操作・承認・アップロードも含みます。レベルの変更や取り消しは下でいつでも行えます。信頼できる端末にのみ共有してください。 | 完整控制采用自然用词；授权范围、信任和撤销说明保持。 |
| ja-JP / fullAccess | 完全なリモートアクセス | フルコントロール | 完整控制采用自然用词；授权范围、信任和撤销说明保持。 |
| ja-JP / warning | 実験的な操作は検証済みのホストと会話のみで利用できます。停止は現在のターンを中断します。 | 実験的な操作は検証済みのこのコンピューターと会話のみで利用できます。停止は現在のターンを中断しますが、バックグラウンドコマンドの終了を保証するものではありません。 | 电脑代替 host；日文同时补齐后台命令不保证结束的原有安全含义。 |

#### `apps/desktop/src/features/sessions/conversation/features/catalog/catalog-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / metadata | Metadata only | No history content | 直接说明没有历史内容，不改变会话信息或能力。 |
| ja-JP / metadata | メタデータのみ | 履歴なし | 直接说明没有历史内容，不改变会话信息或能力。 |

#### `apps/desktop/src/features/sessions/conversation/features/history/history-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / local | This host only | This computer only | 明确索引所属电脑；Web 不把浏览器设备当成本地执行端。 |
| ja-JP / local | このホストのみ | このコンピューターのみ | 明确索引所属电脑；Web 不把浏览器设备当成本地执行端。 |

#### `apps/desktop/src/features/sessions/conversation/features/sessions/claude-connection-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / connectionRejected | The connection request was rejected. Check the terminal and host, then reconnect. | The connection request was rejected. Check the terminal and computer, then reconnect. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / hostDisconnected | Host connection lost | Computer connection lost | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / hostDisconnectedInfo | The terminal's state cannot be checked. Restore the connection to the host before continuing. | The terminal's state cannot be checked. Restore the connection to this computer before continuing. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / platformUnsupported | Connecting the terminal requires macOS. Use a macOS host. | Connecting the terminal requires macOS. Use a macOS computer. | 保留 macOS 限制，并明确到 macOS 电脑操作；Web 指向该电脑上的 AgentKib。 |
| en-US / bridgeUnavailable | The terminal bridge could not start. Check the host logs and restart AgentKib before retrying. | The terminal bridge could not start. Check the logs on this computer and restart AgentKib before retrying. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / disconnected | The terminal is not connected. Open the desktop connection guide and connect from the target Claude Code session. | The terminal is not connected. Open the connection guide in AgentKib on this computer and connect from the target Claude Code session. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / generate | Generate one-time connection code | Generate connection code | 生成连接码采用短称；一次性和有效期规则不变。 |
| en-US / failed | The connection operation failed. Check the host state and try again. | The connection operation failed. Check the state of this computer and try again. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / localOnly | Plugin installation and connection management are available on the local desktop only. | Plugin installation and connection management are only available in AgentKib on this computer. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / connectionRejected | 接続要求が拒否されました。ターミナルとホストを確認して再接続してください。 | 接続要求が拒否されました。ターミナルとこのコンピューターを確認して再接続してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / hostDisconnected | ホストとの接続が切れました | このコンピューターとの接続が切れました | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / hostDisconnectedInfo | ターミナルの状態を確認できません。ホストとの接続を復旧してから操作してください。 | ターミナルの状態を確認できません。このコンピューターとの接続を復旧してから操作してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / platformUnsupported | ターミナルへの接続は macOS のみ対応です。macOS ホストで操作してください。 | ターミナルへの接続は macOS のみ対応です。macOS のコンピューターで操作してください。 | 保留 macOS 限制，并明确到 macOS 电脑操作；Web 指向该电脑上的 AgentKib。 |
| ja-JP / bridgeUnavailable | ターミナルブリッジを起動できません。ホストのログを確認し、AgentKib を再起動して再試行してください。 | ターミナルブリッジを起動できません。このコンピューターのログを確認し、AgentKib を再起動して再試行してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / disconnected | ターミナルに未接続です。デスクトップの接続ガイドを開き、対象の Claude Code 会話から接続してください。 | ターミナルに未接続です。このコンピューター上の AgentKib で接続ガイドを開き、対象の Claude Code 会話から接続してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / generate | 一回限りの接続コードを生成 | 接続コードを生成 | 生成连接码采用短称；一次性和有效期规则不变。 |
| ja-JP / failed | 接続操作に失敗しました。ホストの状態を確認して再試行してください。 | 接続操作に失敗しました。このコンピューターの状態を確認して再試行してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / localOnly | プラグインのインストールと接続管理はローカルのデスクトップでのみ利用できます。 | プラグインのインストールと接続管理は、このコンピューター上の AgentKib でのみ利用できます。 | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/desktop/src/features/sessions/conversation/features/sessions/codex-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / capabilities | Host capabilities | Computer capabilities | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / unavailable | The host does not provide or has not verified this capability | The computer does not provide or has not verified this capability | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / default | Host default | Computer default | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / restoreDefaults | Restore host defaults | Restore computer defaults | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / contextUnknown | The host has not reported context-window usage | The computer has not reported context-window usage | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / settingsSaved | The host confirmed these settings | The computer confirmed these settings | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / goalUnavailable | The host does not provide goal management | The computer does not provide goal management | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / resourceUnavailable | The host does not provide controlled context references | The computer does not provide controlled context references | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / capabilities | ホストの機能 | このコンピューターの機能 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / unavailable | ホストで未提供または未検証の機能です | このコンピューターで未提供または未検証の機能です | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / default | ホストの既定値 | このコンピューターの既定値 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / restoreDefaults | ホストの既定値に戻す | このコンピューターの既定値に戻す | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / contextUnknown | ホストからコンテキストウィンドウの使用量が提供されていません | このコンピューターからコンテキストウィンドウの使用量が提供されていません | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / settingsSaved | ホストが設定を確認しました | このコンピューターが設定を確認しました | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / goalUnavailable | ホストは目標管理を提供していません | このコンピューターは目標管理を提供していません | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / resourceUnavailable | ホストは制御されたコンテキスト参照を提供していません | このコンピューターは制御されたコンテキスト参照を提供していません | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / unsupported-model | The current model is not in the host's verified model list. This message was not sent. Change the next-turn model before sending again. | The current model is not in the model list verified on this computer. This message was not sent. Change the next-turn model before sending again. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / codex-session-directory-not-directory | The session path is not a directory. This session is view only. Check that path on the host. | The session path is not a directory. This session is view only. Check that path on this computer. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / codex-session-directory-unavailable | The session directory could not be read. This session is view only. Check its permissions on the host, then retry. | The session directory could not be read. This session is view only. Check its permissions on this computer, then retry. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / codex-context-outside-workspace | The session directory is outside the registered workspace. This session is view only. Check the workspace and session directory on the host. | The session directory is outside the registered workspace. This session is view only. Check the workspace and session directory on this computer. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / codex-connection-failed | Codex could not be reached. Check the host and retry. | Codex could not be reached. Check this computer and retry. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / collaboration-modes-unavailable | The host has not provided a verified Codex collaboration mode list. | The computer has not provided a verified Codex collaboration mode list. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / permission_denied | This browser needs the corresponding desktop permission. | This browser needs the corresponding permission. Grant it in AgentKib on this computer. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / unsupported-model | 現在のモデルはホストで検証済みのモデル一覧にありません。このメッセージは送信されていません。次のターンのモデルを変更してから送信してください。 | 現在のモデルはこのコンピューターで検証済みのモデル一覧にありません。このメッセージは送信されていません。次のターンのモデルを変更してから送信してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / codex-session-directory-not-directory | 会話のパスがディレクトリではないため、閲覧のみです。ホスト上の該当パスを確認してください。 | 会話のパスがディレクトリではないため、閲覧のみです。このコンピューター上の該当パスを確認してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / codex-session-directory-unavailable | 会話のディレクトリを読み取れないため、閲覧のみです。ホスト上のアクセス権を確認してから再試行してください。 | 会話のディレクトリを読み取れないため、閲覧のみです。このコンピューター上のアクセス権を確認してから再試行してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / codex-context-outside-workspace | 会話のディレクトリが登録済みワークスペースの外にあるため、閲覧のみです。ホスト上のワークスペースと会話のディレクトリを確認してください。 | 会話のディレクトリが登録済みワークスペースの外にあるため、閲覧のみです。このコンピューター上のワークスペースと会話のディレクトリを確認してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / codex-connection-failed | Codex に接続できません。ホストの状態を確認して再試行してください。 | Codex に接続できません。このコンピューターの状態を確認して再試行してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / collaboration-modes-unavailable | ホストは検証済みの Codex 協調モード一覧を提供していません。 | このコンピューターは検証済みの Codex 協調モード一覧を提供していません。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / permission_denied | このブラウザーにはデスクトップで対応する権限を付与する必要があります。 | このブラウザーには対応する権限が必要です。このコンピューター上の AgentKib で権限を付与してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/desktop/src/features/sessions/conversation/features/sessions/context-usage-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / pendingDetail | The host has not reported context usage for this turn yet. | The computer has not reported context usage for this turn yet. | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/desktop/src/features/sessions/conversation/features/sessions/managed-control-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / tool | The execution tool is unavailable. Check its installation and connection on the host, then refresh the session. | The execution tool is unavailable. Check its installation and connection on this computer, then refresh the session. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / fingerprintUnavailable | Claude Code history could not be verified. Check the source on the host, then reopen Session actions to retry. Handoff remains disabled. | Claude Code history could not be verified. Check the source on this computer, then reopen Session actions to retry. Handoff remains disabled. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / capability | This session is not currently eligible for handoff. Refresh it and check the host Agent; continue in the original client if it remains unavailable. | This session is not currently eligible for handoff. Refresh it and check the Agent on this computer; continue in the original client if it remains unavailable. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / access | Access is not approved. Reconnect and approve access in the desktop app. | Access is not approved. Reconnect and approve access in AgentKib on this computer. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / protocol | The connection protocol is incompatible. Update the host and reconnect. | The connection protocol is incompatible. Update AgentKib on this computer and reconnect. | 更新对象明确为 AgentKib，不再含糊要求更新主机。 |
| en-US / experimental | Execution management is not enabled. Enable it in desktop Web settings, then refresh. | Execution management is not enabled. Enable it in Web settings in AgentKib on this computer, then refresh. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / management | This device lacks management permission. Authorize it in desktop Web settings, then reconnect. | This device lacks management permission. Authorize it in Web settings in AgentKib on this computer, then reconnect. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / offline | The host is offline. Reconnect and wait for the session status to refresh before handing over. | The computer is offline. Reconnect and wait for the session status to refresh before handing over. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / tool | 実行ツールは現在利用できません。ホストでインストールと接続を確認し、会話を更新してください。 | 実行ツールは現在利用できません。このコンピューターでインストールと接続を確認し、会話を更新してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / fingerprintUnavailable | Claude Code の履歴を検証できません。ホストのソースを確認し、会話の操作を開き直してください。検証前は引き渡せません。 | Claude Code の履歴を検証できません。このコンピューターのソースを確認し、会話の操作を開き直してください。検証前は引き渡せません。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / capability | この会話は現在引き渡せません。会話を更新してホストの Agent を確認してください。利用できない場合は元のクライアントで続けてください。 | この会話は現在引き渡せません。会話を更新してこのコンピューターの Agent を確認してください。利用できない場合は元のクライアントで続けてください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / access | アクセスが未承認です。再接続し、デスクトップアプリで承認してください。 | アクセスが未承認です。再接続し、このコンピューター上の AgentKib で承認してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / protocol | 接続プロトコルに互換性がありません。ホストを更新して再接続してください。 | 接続プロトコルに互換性がありません。このコンピューター上の AgentKib を更新して再接続してください。 | 更新对象明确为 AgentKib，不再含糊要求更新主机。 |
| ja-JP / experimental | 実行管理が無効です。デスクトップの Web 設定で有効にし、更新してください。 | 実行管理が無効です。このコンピューター上の AgentKib の Web 設定で有効にし、更新してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / management | このデバイスには管理権限がありません。デスクトップの Web 設定で許可し、再接続してください。 | このデバイスには管理権限がありません。このコンピューター上の AgentKib の Web 設定で許可し、再接続してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / offline | ホストがオフラインです。再接続して会話の状態が更新されるのを待ってから引き渡してください。 | このコンピューターがオフラインです。再接続して会話の状態が更新されるのを待ってから引き渡してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/desktop/src/features/sessions/conversation/features/sessions/managed-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| ja-JP / copy（日文）@ 30 | AgentKib をホスト（Agent を実行するコンピューター）で起動しておく必要があります。タスクはワークスペースの権限を使用し、必要に応じて承認を待ちます。 | AgentKib をこのコンピューターで起動しておく必要があります。タスクはワークスペースの権限を使用し、必要に応じて承認を待ちます。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / copy（日文）@ 45 | 先にデスクトップの Web 設定でワークスペースを許可してください。 | 先にこのコンピューター上の AgentKib の Web 設定でワークスペースを許可してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / copy（日文）@ 48 | ホストの既定値 | このコンピューターの既定値 | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / copy（日文）@ 54 | 既定ではホストの Claude Code のモデルとツール権限を使用します。タスクを作成してもモデルは呼び出しません。 | 既定ではこのコンピューターの Claude Code のモデルとツール権限を使用します。タスクを作成してもモデルは呼び出しません。 | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/desktop/src/features/sessions/conversation/features/sessions/managed-error-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / failed | The operation failed. Refresh the session and check the host before retrying. | The operation failed. Refresh the session and check this computer before retrying. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / failed | 操作に失敗しました。会話を更新し、ホストの状態を確認してから再試行してください。 | 操作に失敗しました。会話を更新し、このコンピューターの状態を確認してから再試行してください。 | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/desktop/src/features/sessions/conversation/features/sessions/managed-tasks.tsx`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / managedText @ 349 | AgentKib must stay running on the host (the computer running the Agent). Tasks use workspace access and request approval when needed. | AgentKib must stay running on this computer (the computer running the Agent). Tasks use workspace access and request approval when needed. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / managedText @ 436 | Authorize a workspace in desktop Web settings first. | Authorize a workspace in Web settings in AgentKib on this computer first. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / managedText @ 514 | Uses the host Claude Code model and tool permissions by default. Creating a task does not start a model request. | Uses the Claude Code model and tool permissions from this computer by default. Creating a task does not start a model request. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| en-US / managedText @ 459 | Host default | Computer default | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/desktop/src/features/workspace/ClaudeSessionPanel.tsx`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / text @ 947 | Uses the host CLI model and tool permissions. After you leave, the background process ends when the current turn finishes. | Uses the CLI model and tool permissions on this computer. After you leave, the background process ends when the current turn finishes. | Host/ホスト 改为电脑，安全与运行含义不变。 |
| ja-JP / text @ 949 | ホスト CLI のモデルとツール権限を使用します。離れた後は、現在のターンの完了を待ってバックグラウンドプロセスを終了します。 | このコンピューターの CLI のモデルとツール権限を使用します。離れた後は、現在のターンの完了を待ってバックグラウンドプロセスを終了します。 | Host/ホスト 改为电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/features/catalog/catalog-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / metadata | Metadata only | No history content | 直接说明没有历史内容，不改变会话信息或能力。 |
| ja-JP / metadata | メタデータのみ | 履歴なし | 直接说明没有历史内容，不改变会话信息或能力。 |

#### `apps/web/src/features/conversation/features/history/history-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / disabled | Conversation content indexing is off. Ask the host owner to enable it in the desktop app under Settings → Privacy → Conversation content search. | Conversation content indexing is off. Ask the owner of the computer running AgentKib to enable it in AgentKib under Settings → Privacy → Conversation content search. | 明确电脑所有者及 AgentKib 内的设置路径，避免误指手机设置。 |
| en-US / local | This host only | Only the computer running AgentKib | 明确索引所属电脑；Web 不把浏览器设备当成本地执行端。 |
| ja-JP / disabled | 本文のインデックスは無効です。ホストの所有者に、ホスト側デスクトップアプリの「設定 → プライバシー → 会話本文の検索」で有効にするよう依頼してください。 | 本文のインデックスは無効です。コンピューターの所有者に、コンピューター上の AgentKib の「設定 → プライバシー → 会話本文の検索」で有効にするよう依頼してください。 | 明确电脑所有者及 AgentKib 内的设置路径，避免误指手机设置。 |
| ja-JP / local | このホストのみ | AgentKib を実行しているコンピューターのみ | 明确索引所属电脑；Web 不把浏览器设备当成本地执行端。 |

#### `apps/web/src/features/conversation/features/sessions/claude-connection-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / connectionRejected | The connection request was rejected. Check the terminal and host, then reconnect. | The connection request was rejected. Check the terminal and computer, then reconnect. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / hostDisconnected | Host connection lost | Computer connection lost | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / hostDisconnectedInfo | The terminal's state cannot be checked. Restore the connection to the host before continuing. | The terminal's state cannot be checked. Restore the connection to the computer running AgentKib before continuing. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / platformUnsupported | Connecting the terminal requires macOS. Use a macOS host. | Connecting the terminal requires macOS. Use AgentKib on a macOS computer. | 保留 macOS 限制，并明确到 macOS 电脑操作；Web 指向该电脑上的 AgentKib。 |
| en-US / bridgeUnavailable | The terminal bridge could not start. Check the host logs and restart AgentKib before retrying. | The terminal bridge could not start. Check the logs on the computer running AgentKib and restart AgentKib before retrying. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / disconnected | The terminal is not connected. Open the desktop connection guide and connect from the target Claude Code session. | The terminal is not connected. Open the connection guide in AgentKib on your computer and connect from the target Claude Code session. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / generate | Generate one-time connection code | Generate connection code | 生成连接码采用短称；一次性和有效期规则不变。 |
| en-US / failed | The connection operation failed. Check the host state and try again. | The connection operation failed. Check the state of the computer running AgentKib and try again. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / localOnly | Plugin installation and connection management are available on the local desktop only. | Plugin installation and connection management are only available in AgentKib on your computer. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / connectionRejected | 接続要求が拒否されました。ターミナルとホストを確認して再接続してください。 | 接続要求が拒否されました。ターミナルとAgentKib を実行しているコンピューターを確認して再接続してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / hostDisconnected | ホストとの接続が切れました | AgentKib を実行しているコンピューターとの接続が切れました | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / hostDisconnectedInfo | ターミナルの状態を確認できません。ホストとの接続を復旧してから操作してください。 | ターミナルの状態を確認できません。AgentKib を実行しているコンピューターとの接続を復旧してから操作してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / platformUnsupported | ターミナルへの接続は macOS のみ対応です。macOS ホストで操作してください。 | ターミナルへの接続は macOS のみ対応です。macOS のコンピューター上の AgentKib で操作してください。 | 保留 macOS 限制，并明确到 macOS 电脑操作；Web 指向该电脑上的 AgentKib。 |
| ja-JP / bridgeUnavailable | ターミナルブリッジを起動できません。ホストのログを確認し、AgentKib を再起動して再試行してください。 | ターミナルブリッジを起動できません。AgentKib を実行しているコンピューターのログを確認し、AgentKib を再起動して再試行してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / disconnected | ターミナルに未接続です。デスクトップの接続ガイドを開き、対象の Claude Code 会話から接続してください。 | ターミナルに未接続です。コンピューター上の AgentKib で接続ガイドを開き、対象の Claude Code 会話から接続してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / generate | 一回限りの接続コードを生成 | 接続コードを生成 | 生成连接码采用短称；一次性和有效期规则不变。 |
| ja-JP / failed | 接続操作に失敗しました。ホストの状態を確認して再試行してください。 | 接続操作に失敗しました。AgentKib を実行しているコンピューターの状態を確認して再試行してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / localOnly | プラグインのインストールと接続管理はローカルのデスクトップでのみ利用できます。 | プラグインのインストールと接続管理は、コンピューター上の AgentKib でのみ利用できます。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/features/sessions/codex-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / capabilities | Host capabilities | Computer capabilities | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / unavailable | The host does not provide or has not verified this capability | The computer does not provide or has not verified this capability | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / default | Host default | Computer default | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / restoreDefaults | Restore host defaults | Restore computer defaults | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / contextUnknown | The host has not reported context-window usage | The computer has not reported context-window usage | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / settingsSaved | The host confirmed these settings | The computer confirmed these settings | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / goalUnavailable | The host does not provide goal management | The computer does not provide goal management | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / resourceUnavailable | The host does not provide controlled context references | The computer does not provide controlled context references | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / capabilities | ホストの機能 | AgentKib を実行しているコンピューターの機能 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / unavailable | ホストで未提供または未検証の機能です | AgentKib を実行しているコンピューターで未提供または未検証の機能です | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / default | ホストの既定値 | AgentKib を実行しているコンピューターの既定値 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / restoreDefaults | ホストの既定値に戻す | AgentKib を実行しているコンピューターの既定値に戻す | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / contextUnknown | ホストからコンテキストウィンドウの使用量が提供されていません | AgentKib を実行しているコンピューターからコンテキストウィンドウの使用量が提供されていません | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / settingsSaved | ホストが設定を確認しました | AgentKib を実行しているコンピューターが設定を確認しました | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / goalUnavailable | ホストは目標管理を提供していません | AgentKib を実行しているコンピューターは目標管理を提供していません | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / resourceUnavailable | ホストは制御されたコンテキスト参照を提供していません | AgentKib を実行しているコンピューターは制御されたコンテキスト参照を提供していません | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / unsupported-model | The current model is not in the host's verified model list. This message was not sent. Change the next-turn model before sending again. | The current model is not in the model list verified on the computer running AgentKib. This message was not sent. Change the next-turn model before sending again. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / codex-session-directory-not-directory | The session path is not a directory. This session is view only. Check that path on the host. | The session path is not a directory. This session is view only. Check that path on the computer running AgentKib. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / codex-session-directory-unavailable | The session directory could not be read. This session is view only. Check its permissions on the host, then retry. | The session directory could not be read. This session is view only. Check its permissions on the computer running AgentKib, then retry. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / codex-context-outside-workspace | The session directory is outside the registered workspace. This session is view only. Check the workspace and session directory on the host. | The session directory is outside the registered workspace. This session is view only. Check the workspace and session directory on the computer running AgentKib. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / codex-connection-failed | Codex could not be reached. Check the host and retry. | Codex could not be reached. Check the computer running AgentKib and retry. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / collaboration-modes-unavailable | The host has not provided a verified Codex collaboration mode list. | The computer has not provided a verified Codex collaboration mode list. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / permission_denied | This browser needs the corresponding desktop permission. | This browser needs the corresponding permission. Grant it in AgentKib on your computer. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / unsupported-model | 現在のモデルはホストで検証済みのモデル一覧にありません。このメッセージは送信されていません。次のターンのモデルを変更してから送信してください。 | 現在のモデルはAgentKib を実行しているコンピューターで検証済みのモデル一覧にありません。このメッセージは送信されていません。次のターンのモデルを変更してから送信してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / codex-session-directory-not-directory | 会話のパスがディレクトリではないため、閲覧のみです。ホスト上の該当パスを確認してください。 | 会話のパスがディレクトリではないため、閲覧のみです。AgentKib を実行しているコンピューター上の該当パスを確認してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / codex-session-directory-unavailable | 会話のディレクトリを読み取れないため、閲覧のみです。ホスト上のアクセス権を確認してから再試行してください。 | 会話のディレクトリを読み取れないため、閲覧のみです。AgentKib を実行しているコンピューター上のアクセス権を確認してから再試行してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / codex-context-outside-workspace | 会話のディレクトリが登録済みワークスペースの外にあるため、閲覧のみです。ホスト上のワークスペースと会話のディレクトリを確認してください。 | 会話のディレクトリが登録済みワークスペースの外にあるため、閲覧のみです。AgentKib を実行しているコンピューター上のワークスペースと会話のディレクトリを確認してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / codex-connection-failed | Codex に接続できません。ホストの状態を確認して再試行してください。 | Codex に接続できません。AgentKib を実行しているコンピューターの状態を確認して再試行してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / collaboration-modes-unavailable | ホストは検証済みの Codex 協調モード一覧を提供していません。 | AgentKib を実行しているコンピューターは検証済みの Codex 協調モード一覧を提供していません。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / permission_denied | このブラウザーにはデスクトップで対応する権限を付与する必要があります。 | このブラウザーには対応する権限が必要です。コンピューター上の AgentKib で権限を付与してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/features/sessions/context-usage-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / pendingDetail | The host has not reported context usage for this turn yet. | The computer has not reported context usage for this turn yet. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/features/sessions/managed-control-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / tool | The execution tool is unavailable. Check its installation and connection on the host, then refresh the session. | The execution tool is unavailable. Check its installation and connection on the computer running AgentKib, then refresh the session. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / fingerprintUnavailable | Claude Code history could not be verified. Check the source on the host, then reopen Session actions to retry. Handoff remains disabled. | Claude Code history could not be verified. Check the source on the computer running AgentKib, then reopen Session actions to retry. Handoff remains disabled. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / capability | This session is not currently eligible for handoff. Refresh it and check the host Agent; continue in the original client if it remains unavailable. | This session is not currently eligible for handoff. Refresh it and check the Agent on the computer running AgentKib; continue in the original client if it remains unavailable. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / access | Access is not approved. Reconnect and approve access in the desktop app. | Access is not approved. Reconnect and approve access in AgentKib on your computer. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / protocol | The connection protocol is incompatible. Update the host and reconnect. | The connection protocol is incompatible. Update AgentKib on your computer and reconnect. | 更新对象明确为 AgentKib，不再含糊要求更新主机。 |
| en-US / experimental | Execution management is not enabled. Enable it in desktop Web settings, then refresh. | Execution management is not enabled. Enable it in Web settings in AgentKib on your computer, then refresh. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / management | This device lacks management permission. Authorize it in desktop Web settings, then reconnect. | This device lacks management permission. Authorize it in Web settings in AgentKib on your computer, then reconnect. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / offline | The host is offline. Reconnect and wait for the session status to refresh before handing over. | The computer is offline. Reconnect and wait for the session status to refresh before handing over. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / tool | 実行ツールは現在利用できません。ホストでインストールと接続を確認し、会話を更新してください。 | 実行ツールは現在利用できません。AgentKib を実行しているコンピューターでインストールと接続を確認し、会話を更新してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / fingerprintUnavailable | Claude Code の履歴を検証できません。ホストのソースを確認し、会話の操作を開き直してください。検証前は引き渡せません。 | Claude Code の履歴を検証できません。AgentKib を実行しているコンピューターのソースを確認し、会話の操作を開き直してください。検証前は引き渡せません。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / capability | この会話は現在引き渡せません。会話を更新してホストの Agent を確認してください。利用できない場合は元のクライアントで続けてください。 | この会話は現在引き渡せません。会話を更新してAgentKib を実行しているコンピューターの Agent を確認してください。利用できない場合は元のクライアントで続けてください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / access | アクセスが未承認です。再接続し、デスクトップアプリで承認してください。 | アクセスが未承認です。再接続し、コンピューター上の AgentKib で承認してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / protocol | 接続プロトコルに互換性がありません。ホストを更新して再接続してください。 | 接続プロトコルに互換性がありません。コンピューター上の AgentKib を更新して再接続してください。 | 更新对象明确为 AgentKib，不再含糊要求更新主机。 |
| ja-JP / experimental | 実行管理が無効です。デスクトップの Web 設定で有効にし、更新してください。 | 実行管理が無効です。コンピューター上の AgentKib の Web 設定で有効にし、更新してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / management | このデバイスには管理権限がありません。デスクトップの Web 設定で許可し、再接続してください。 | このデバイスには管理権限がありません。コンピューター上の AgentKib の Web 設定で許可し、再接続してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / offline | ホストがオフラインです。再接続して会話の状態が更新されるのを待ってから引き渡してください。 | AgentKib を実行しているコンピューターがオフラインです。再接続して会話の状態が更新されるのを待ってから引き渡してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/features/sessions/managed-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| ja-JP / copy（日文）@ 30 | AgentKib をホスト（Agent を実行するコンピューター）で起動しておく必要があります。タスクはワークスペースの権限を使用し、必要に応じて承認を待ちます。 | コンピューター上の AgentKib を起動したままにしてください。タスクはワークスペースの権限を使用し、必要に応じて承認を待ちます。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / copy（日文）@ 45 | 先にデスクトップの Web 設定でワークスペースを許可してください。 | 先にコンピューター上の AgentKib の Web 設定でワークスペースを許可してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / copy（日文）@ 48 | ホストの既定値 | AgentKib を実行しているコンピューターの既定値 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / copy（日文）@ 54 | 既定ではホストの Claude Code のモデルとツール権限を使用します。タスクを作成してもモデルは呼び出しません。 | 既定ではAgentKib を実行しているコンピューターの Claude Code のモデルとツール権限を使用します。タスクを作成してもモデルは呼び出しません。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/features/sessions/managed-error-copy.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / failed | The operation failed. Refresh the session and check the host before retrying. | The operation failed. Refresh the session and check the computer running AgentKib before retrying. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / failed | 操作に失敗しました。会話を更新し、ホストの状態を確認してから再試行してください。 | 操作に失敗しました。会話を更新し、AgentKib を実行しているコンピューターの状態を確認してから再試行してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/features/sessions/managed-tasks.tsx`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / managedText @ 355 | AgentKib must stay running on the host (the computer running the Agent). Tasks use workspace access and request approval when needed. | Keep AgentKib running on the computer running the Agent. Tasks use workspace access and request approval when needed. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / managedText @ 449 | Authorize a workspace in desktop Web settings first. | Authorize a workspace in Web settings in AgentKib on your computer first. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / managedText @ 528 | Uses the host Claude Code model and tool permissions by default. Creating a task does not start a model request. | Uses the Claude Code model and tool permissions from the computer running AgentKib by default. Creating a task does not start a model request. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / managedText @ 473 | Host default | Computer default | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |

#### `apps/web/src/features/conversation/i18n/index.ts`

| 语言／字段或行 | 基线 | 最终显示 | 修改理由 |
| --- | --- | --- | --- |
| en-US / localExecution | Execution environment: the host (the computer running the Agent) | Execution environment: the computer running AgentKib (the computer running the Agent) | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / unavailable | Live control is unavailable. Check the connection in the desktop app. | Live control is unavailable. Check the connection in AgentKib on your computer. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / unverifiedInstallation | The host Agent installation or version could not be verified. Control is disabled. Check the installation in the desktop app. | The Agent installation or version on the computer running AgentKib could not be verified. Control is disabled. Check the installation in AgentKib on that computer. | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| en-US / metadataOnly | Metadata only · No readable history | No history content | 直接说明没有历史内容，不改变会话信息或能力。 |
| ja-JP / localExecution | 実行環境：ホスト（Agent を実行するコンピューター） | 実行環境：AgentKib を実行しているコンピューター | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / unavailable | リアルタイム制御は利用できません。デスクトップアプリで接続状態を確認してください。 | リアルタイム制御は利用できません。コンピューター上の AgentKib で接続状態を確認してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / unverifiedInstallation | ホストの Agent のインストールまたはバージョンを確認できないため、制御は無効です。デスクトップアプリでインストールを確認してください。 | AgentKib を実行しているコンピューターの Agent のインストールまたはバージョンを確認できないため、制御は無効です。コンピューター上の AgentKib でインストールを確認してください。 | Host/ホスト 改为电脑；Web 操作指向运行 AgentKib 的电脑，安全与运行含义不变。 |
| ja-JP / metadataOnly | メタデータのみ · 閲覧可能な履歴なし | 履歴なし | 直接说明没有历史内容，不改变会话信息或能力。 |


## 本证据对应的回归验证

均使用仓库现有 Vitest/mock，没有新增 fixture 框架，没有放宽超时或删除原安全断言。运行前使用临时 userconfig 关闭 pnpm 自动版本管理，不改依赖。

```sh
PATH=/tmp/agentkib-v15-a-tools:$PATH NPM_CONFIG_USERCONFIG=/tmp/agentkib-v15-a-tools/userconfig pnpm --filter @agentkib/web test src/features/conversation/features/history/history-search-settings.test.tsx src/features/sessions/composer-layout.test.tsx --maxWorkers=2
PATH=/tmp/agentkib-v15-a-tools:$PATH NPM_CONFIG_USERCONFIG=/tmp/agentkib-v15-a-tools/userconfig pnpm --filter @agentkib/web test src/features/sessions/claude-handoff.test.ts src/features/sessions/managed-copy.test.ts --maxWorkers=2
PATH=/tmp/agentkib-v15-a-tools:$PATH NPM_CONFIG_USERCONFIG=/tmp/agentkib-v15-a-tools/userconfig pnpm --filter @agentkib/desktop test src/features/sessions/conversation/features/sessions/session-surface-copy.test.ts --maxWorkers=2
PATH=/tmp/agentkib-v15-a-tools:$PATH NPM_CONFIG_USERCONFIG=/tmp/agentkib-v15-a-tools/userconfig pnpm exec oxfmt --check apps/web/src/features/conversation/features/history/history-search-settings.test.tsx apps/web/src/features/sessions/composer-layout.test.tsx
```

| 检查 | 实测结果 | 关键覆盖 |
| --- | --- | --- |
| Web 正文搜索设置＋输入区 | 2 文件、56 测试通过 | 四语索引关闭完整路径与电脑范围；无无效导航、无索引配置/清理/重建/搜索请求；协议不兼容说明更新 AgentKib，发送禁用、无控制动作、草稿保留。 |
| Web 交接判定镜像＋managed-copy 实际调用 | 2 文件、39 测试通过 | 原安全/权限/匹配判定保留；镜像一致；现有 managedText 调用可解析且显式使用 Web surface，四语不回落。 |
| 桌面 surface copy | 1 文件、18 测试通过 | 镜像、已知/未知技术详情不改写、Web 场景、macOS 平台指引、缓存引用稳定。 |
| 两份 Web 渲染测试 `oxfmt --check` | 通过 | 保持项目格式。 |
| 本记录中的值/保护集/镜像搜索比较 | 通过 | 结果见前文；不依赖截图判断原始技术数据是否被替换。 |

这些结果不代替主 QA 的 typecheck、lint、全量测试、颜色对比度及合成沙盒截图。没有因此声明 Windows、真实手机、真实 CLI 或外网账号已验收。未读取或改动真实用户凭据、会话、Agent 配置或安装目录。

## 最后定点复核：电脑上的 AgentKib 指引

在实际 Web 展开后的文案清单中，发现日文背景说明重复 `AgentKib を`、部分“桌面”操作指引仍不明确应用入口，按 A 批术语范围修正，保持原流程：

- `session-surface-copy.ts` 对应用固定背景说明采用四语完整短句转换，避免把“保持 AgentKib 运行”机械展开为重复应用名。Web 分别为“请让电脑上的 AgentKib 保持运行。”“請讓電腦上的 AgentKib 保持執行。”、“Keep AgentKib running on the computer running the Agent.”、“コンピューター上の AgentKib を起動したままにしてください。”；后续工作区权限与审批说明保留。
- `managed-control-copy.ts` 的未授权、执行管理未启用、无管理权限，以及 `managed-copy.ts`/`managed-tasks.tsx` 的工作区授权指引，桌面四语明确“这台电脑上的 AgentKib”；Web 自然转换为“电脑上的 AgentKib”。翻译键、英文调用和繁日词条同步，避免回落到简体。
- `codex-copy.ts` 的 `permission_denied` 明确在哪里授权；`claude-connection-copy.ts` 的 `disconnected`、`localOnly` 仅改位置称呼，保留目标 Claude 会话、连接指引、插件安装和连接管理的现有入口与流程，未提前实施 B 批布局。
- 所有同名共享副本一致；日文品牌名周围保留自然空格。未知错误技术详情、跨 Agent 的四语 135 键与 follower 不变。

先添加四语回归，修复前实际得到 **4 失败、14 通过**（未授权操作仍指向旧“桌面”句）；修复后扩大检查同一用例中的所有操作指引和完整背景句，并保留原未知结果、技术详情、缓存与镜像断言。

```sh
PATH=/tmp/agentkib-v15-a-tools:$PATH NPM_CONFIG_USERCONFIG=/tmp/agentkib-v15-a-tools/userconfig pnpm --filter @agentkib/desktop test src/features/sessions/conversation/features/sessions/session-surface-copy.test.ts src/features/sessions/conversation/features/sessions/managed-copy.test.ts src/features/sessions/conversation/features/sessions/managed-handoff-feedback.test.tsx src/features/sessions/conversation/features/sessions/claude-bridge-panel.test.tsx --maxWorkers=2
PATH=/tmp/agentkib-v15-a-tools:$PATH NPM_CONFIG_USERCONFIG=/tmp/agentkib-v15-a-tools/userconfig pnpm --filter @agentkib/web test src/features/sessions/codex-copy.test.ts src/features/sessions/claude-handoff.test.ts src/features/sessions/managed-copy.test.ts src/features/sessions/managed-handoff-feedback.test.tsx src/features/sessions/composer-layout.test.tsx src/features/sessions/claude-parity.test.tsx src/features/sessions/codex-features.test.tsx src/features/sessions/session-stability.test.tsx src/features/sessions/session-display-state.test.ts src/features/conversation/features/sessions/claude-session-banner.test.ts --maxWorkers=2
```

最终定向结果：桌面 **4 文件、93 测试通过**，Web **10 文件、300 测试通过**。Web 管理对话框的四语实际渲染断言改为检查完整背景句，不再仅检查一段也可能出现在其他说明里的“电脑”字样；发送、权限、草稿、未知结果等原断言全部保留。两端本次定点改动的 12 份生产文件和 2 份测试文件均通过 `oxfmt --check`；本记录重新执行保护集和镜像比较，结果仍与前文一致。上述英日清单已按这些最终值重生成。
