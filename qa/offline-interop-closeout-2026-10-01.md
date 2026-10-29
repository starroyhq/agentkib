# 五个目标离线互通验收收尾 — 2026-10-01

## 范围与源码身份

按用户收紧后的目标，仅收尾 Claude Code、Codex、OpenCode、Hermes、OpenClaw 五个已有目标、七个可用来源的35个代表纯文本方向。沿用固定版本和已通过证据；剩余用例执行一轮，确定缺陷最多一轮最小修复及针对性复验。Grok、Cursor、Antigravity 目标端保持既有禁用门限。没有新模型请求、登录、供应商配置修改或版本扩展。

工作树 `/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib`，分支 `codex/main-acceptance-20260930`，HEAD `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，保留已有dirty改动。HEAD不能独自代表本轮源码，最终文件SHA清单另存私有证据。没有提交、推送、合并、部署、发布或覆盖已安装应用。

| 目标 | 本机固定版本 | 原生核对方式 |
| --- | --- | --- |
| Claude Code | 2.1.285 | 官方禁网bare TUI、同UUID独立重启、原始字节前缀与元记录核对 |
| Codex | 0.146.1 | 官方禁网app-server的read/resume/list，两个独立进程；显式exec来源过滤 |
| OpenCode | 1.18.32 | 官方export/list与两次禁网原生TUI |
| Hermes | 0.21.5 / release v2026.9.24 | 官方SQLite全文与两次禁网原生TUI |
| OpenClaw | 2026.9.6 / schema23 | 官方SQLite accessor、官方sessions list、本地禁网TUI及原生元数据核对 |

Codex核对证明官方接口历史及恢复，不宣称默认桌面界面显示。原生UI、回读、Runtime回执及真实回复分别取证。

## 复用证据与追加工作

- 35个公开方向的预览、确认、导入或ChangeSet、重复请求、Runtime重启、完整目标文本投影和来源保护，复用9月30日各case原始记录。文件目标重复continue报目标已存在；命令导入目标复用同操作回执，均未重复导入。
- Codex七个来源的官方双进程read/resume/list复用既有证据。修复的`history_mode=legacy`及原生`event_msg`投影未被后续修改。
- OpenCode/Hermes六个剩余来源共12方向、24次原生TUI恢复已经补齐；Claude来源的两个目标证据复用先前专项，不重跑。
- Grok→Claude同一公开目标两次禁网恢复通过，原1883字节载荷前缀不变，仅新增已知同UUID空atis-latch；第二次全SHA不变。
- OpenClaw六方向官方sessions list各运行两次，均准确识别唯一目标；列表证明和完整TUI恢复分别报告。

OpenClaw剩余六方向均取得一次完整TUI原始显示，前后agent全表不变，只有恢复指针的时间戳变化；双TUI结果均阻塞。旧runner提前停止已做一次最小修复，修复后PTY尾部截断UTF-8触发严格解码失败、第二次启动未执行。所有失败与原始字节保留，按一轮上限不再修复或重跑。

剩余Claude六方向的唯一批次全部通过，各两次同UUID禁网恢复。当前屏幕完整角色及正文、源SHA、原生产载荷和完整既有baseline均核对一致；只追加已知空atis-latch，Codex原403失败完整保留。独立审查后主代理又复核原始ANSI、输入前帧和进程；没有追加模型请求。

## 最终逐方向离线矩阵

所有35格已有公开预览/确认/导入或写入、严格目标投影、唯一身份及来源保护证据。下表分别列出原生恢复结果，不能把格中的通过解释为真实模型回复或发布通过。

| 来源 | Claude 2.1.285 | Codex 0.146.1 | OpenCode 1.18.32 | Hermes 0.21.5 | OpenClaw 2026.9.6 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | 双TUI通过 | 双app-server通过 | 既有双TUI通过 | 既有双TUI通过 | 旧专项Gateway历史/重启及TUI通过 |
| Codex | 双TUI通过；旧403保留 | 双app-server通过 | 双TUI通过 | 双TUI通过 | 双列表/回读通过；双TUI阻塞 |
| Grok Build | 双TUI通过 | 双app-server通过 | 双TUI通过 | 双TUI通过 | 双列表/回读通过；双TUI阻塞 |
| Hermes JSONL | 双TUI通过 | 双app-server通过 | 双TUI通过 | 双TUI通过 | 双列表/回读通过；双TUI阻塞 |
| Cursor固定blob | 双TUI通过 | 双app-server通过 | 双TUI通过 | 双TUI通过 | 双列表/回读通过；双TUI阻塞 |
| OpenCode | 双TUI通过 | 双app-server通过 | 双TUI通过 | 双TUI通过 | 双列表/回读通过；双TUI阻塞 |
| OpenClaw SQLite | 双TUI通过 | 双app-server通过 | 双TUI通过 | 双TUI通过 | 双列表/回读通过；双TUI阻塞 |

OpenClaw六个阻塞格各有一次完整TUI原始显示和严格前后回读，未执行第二次TUI。Claude来源的OpenClaw旧专项证明Gateway重启和历史恢复，不把它另称双TUI通过。Codex七格仅证明官方app-server且显式exec来源过滤。原生恢复方式不同，不能汇总成35个完全相同的客户端验收。

Claude→OpenCode的双TUI复用既有CPA公开交接代表用例，其目标UUID与早期纯离线`opencode-rpc-v2`不同。方向索引分别记录两个对象和证据，不能拼接为同一个会话的生命周期；不会因此新增方向或本轮模型请求。

执行器缺陷修复次数和证据原文均保留。OpenClaw双TUI阻塞、旧预览指纹疑点、跨平台及在线缺口单列，相关能力未标为完整通过，也不进入发布。

## 已修复问题与回归

本轮累计产品修复为Codex原生历史格式：原`save-all`不被固定CLI接受，且只有模型上下文记录时官方read缺少可见消息。现生成合法history mode并同步UI文本事件，生成载荷校验要求上下文与可见正文一致；已有官方追加历史继续沿用通用JSONL校验。独立审查与真实禁网官方回读通过。

后续Antigravity截止时间调整仅涉及测试及`cfg(test)`观察点：精确核对共享截止时间，并由load-ready事件触发实际超时测试，消除固定sleep与进程启动竞争。预览fixture补强初始能力诊断，未确认旧指纹失败根因，不能称根因已修复。

本次原生恢复补验仅新增QA脚本与文档。执行器清理期间丢失取消已修复，可复现自检3项通过；其余执行器修复及原始失败见[本轮原生界面记录](full-interop-native-ui-2026-10-01.md)。

| 验证 | 实际结果与范围 |
| --- | --- |
| `cargo test --workspace -- --test-threads=1` | 复用Codex修复后旧阶段结果：1009通过、0失败、7 ignored；不冒充后续新增测试后的全workspace结果 |
| `cargo test --offline -p agentkib-conversations --lib` | 后续最终默认并行180通过、8 ignored；等价Clippy断言写法调整后实际load单项再次通过 |
| `cargo test --offline -p agentkib-runtime --test native_import -- --test-threads=1` | 7通过 |
| `cargo test --offline -p agentkib-antigravity-bridge scoped_deadline_caps_an_unresponsive_acp_wait` | 1通过 |
| Rust fmt、workspace Clippy及后续相关crates Clippy | 各对应阶段通过，源码SHA与保存日志核对一致 |
| Node22.23.2 / pnpm10.8.1：format、lint、typecheck、test、desktop build、hosted Web build | 复用原阶段全退出0；桌面942通过/7 skipped，Web230通过；后续无前端源码变更 |
| Windows x64/ARM64、Linux x64交叉检查 | 阻塞：SQLite bundled所需C工具链/标准头缺失，未记通过，未绕过依赖 |

私有 `offline-native-ui/reused-regression-audit.json` 已核对当前continuation、Antigravity测试及Runtime测试源码与相应阶段保存的SHA一致，并核对旧workspace结果和稳定性日志哈希。QA脚本的最终语法、自检及diff检查单独记录，不替代产品测试。

## 保留的限制与阻塞

- 在线验收停止。Claude首次请求403 permission_denied、Hermes首次CPA请求503 auth_unavailable、OpenCode官方免费入口403均保持失败，不重试；Codex独立授权未完成，OpenClaw真实回复未验收。已有两例OpenCode CPA成功仅适用于具体方向及合成纯文本用例。
- 新目标不支持已拒绝的长历史完整续接；工具/附件按现有专项报告降级、摘要化或省略，不扩为35方向全组合成功。富历史Grok→OpenCode/Hermes官方禁网导入的4项实际运行及负例复用，原生附件本体与工具执行能力未提升。
- Antigravity ACP来源缺少官方server，未纳入35个已实现代表方向；其五个目标方向保留未验收。Grok、Cursor、Antigravity目标端不开放写入。
- 预览指纹历史失败未复现且根因未确证。新的fixture只改善诊断，能力探测稳定性仍需后续验证，不作为本次发布通过依据。
- OpenClaw六个方向双TUI恢复因执行器截断尾字节解码失败而阻塞，不能用官方双列表或单次完整显示将该验收项标为通过。后续若另行开展验收，需先修复QA执行器增量解码与停止时收尾；本轮不再追加修复。
- 手机、Windows/Linux实机、账号生产上线、签名/公证及正式发布均在本轮范围外或未验收。

本报告只收尾有限离线范围。任何未通过或证据不足项均不标为原生互通完整通过，也不进入发布。

最终证据根：`~/Documents/AgentKib-archives/2026-10-01/offline-native-ui/`。`closeout/` 保存35方向索引、准确源码/dirty清单、各专项证据SHA和最终检查结果；旧证据沿用9月30日目录，未覆盖已有result或失败日志。

最终独立子代理只读审计确认35个唯一方向及证据SHA、Claude12次新TUI、OpenClaw六个阻塞格、Codex显式过滤及不同CPA目标UUID边界与记录一致。最终5个新增/调整Python脚本AST检查、3项既有回执/正文负例及`git diff --check`通过；这些只证明对应QA检查，不把OpenClaw已知解码缺陷消除。所有本轮自有进程退出。
