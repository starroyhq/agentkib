# 更换 provider 后的原生互通补验 — 2026-10-01

## 范围与身份

用户更换 provider 后重新授权验收，沿用“已有授权、每例单轮、不自动重试或换模型”。当前 CC Switch 选中官方 DeepSeek，文本模型为 `deepseek-v4-pro`。只在验收父进程内读取现有授权，直接连接官方 Anthropic、Chat Completions 或 Responses 接口；原生 CLI 只接收短期 loopback token。没有修改 CC Switch/CPA 的全局配置，没有复制 Agent 凭据文件，没有提交、推送、合并、部署或发布。

工作树 `/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib`，HEAD `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，保留原 dirty 状态。本次只调整 QA 执行器及文档，未再修改产品代码。原有 continuation、Antigravity 测试及 Runtime 测试源码 SHA 与上一阶段相同；上一阶段产品回归的复用边界见[离线收尾](offline-interop-closeout-2026-10-01.md)。

新证据根 `~/Documents/AgentKib-archives/2026-10-01/provider-retest/`，入口目录0700；探针保存的回执和原始输出0600，原生CLI生成的测试文件/缓存权限另记，不声称所有嵌套文件均为0600。历史403/503、旧模型回复和本次执行器失败均保留，追加审计另建文件。

## 原生恢复补齐

OpenClaw `2026.9.6` 的六个剩余来源各两次独立禁网 TUI 恢复全部通过，12次启动，失败0。完整 notice/user/assistant 正文、角色样式、顺序、目标 ID、会话数及来源均前后核对。agent 数据库全表不变；state 仅精确的 `tui.lastSession.<scope>` 恢复指针更新时间变化，配置不变。所有自有进程组退出。

QA 修复使用严格增量 UTF-8 解码，只有在所有正文已完整匹配后，允许固定 renderer 边框的已知截断尾 `e2`/`e294`；原始字节和哈希完整保留。正文截断、正文损坏和中间非法字节均拒绝。20个正例、12个负例及独立审查通过。新汇总 `offline-openclaw/completion-summary.json`；旧六个失败结果未改成成功。

该补验只提升原生界面及恢复，不能外推真实回复、工具、附件、长历史或其他版本。

## 新 provider 的逐例真实结果

| 方向 / 原生版本                | 实际结果                                                                                   | 身份与证据                                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Codex → Claude Code 2.1.285    | 一次 HTTP200，完整随机标记及存储决策正确；同 UUID 禁网原生 TUI 重启通过                    | 新公共预览/ChangeSet 目标 `f915ec2a-cad0-4826-b07d-4b086ec6bf84`；`Claude/live-attempt-v1/acceptance-audit.json` 及主代理独立重算 |
| Codex → Hermes 0.21.5          | 一次 HTTP200，完整标记和决策正确；原生全文、CLI及禁网官方导出完全相等                      | `20260930_220045_c41fad`；`Hermes/native-live-01/acceptance-audit.json` 及主代理独立重算；原QA false保留                          |
| Grok Build → Codex 0.146.1     | 一次 HTTP200，上游完整标记/决策正确；QA响应元数据误判导致答案未送达CLI，原生真实续聊未通过 | `5818f431-5f55-4d1f-b904-25a12eefcd4b`；`Codex/native-live-01/` 保持false；mock单独标注                                           |
| Grok Build → OpenClaw 2026.9.6 | 一次 HTTP200，标记正确，但只答项目 namespace，遗漏完整存储决策；严格真实回复验收失败       | `4dc8467c-7ec9-4286-99c3-068b35a30963`；`OpenClaw/grok-native-live-01/result.json` 保持false                                      |

Claude 实际用量 input311/output215。原生 CLI 将思考与最终答案保存成两个 assistant 记录，旧 QA gate 把思考记录算作额外可见回复，原 `result.json` 为false。追加只读审计要求无正文项必须全部为已知 thinking 块、唯一非空最终正文与 CLI answer 逐字相等、没有工具/未知块、恰一条新 prompt；禁网重启后完整正文可读。原false及其SHA保留，不重新发送模型请求。主代理另从原生日志、CLI 输出、上游回执、原生屏幕和进程快照独立重算通过。

OpenClaw 实际用量 input2184/output16，CLI 与原生 SQLite 新回复逐字一致，原三条历史完整发送且字节前缀不变，同 ID、唯一目标、两次官方 accessor 新进程回读及配置恢复通过。模型回复为正确随机标记和 `cobalt-lake`，缺少 `append-only SQLite WAL`。不降低“完整项目决定”断言，不重试。CLI 中的配置成本零值不是供应商账单。

Hermes 实际用量 input1028/output150，其中reasoning121；回复为准确随机标记及 `append-only SQLite WAL, namespace cobalt-lake`。相对历史的 `with namespace` 只改变连接语法，append-only、SQLite WAL和具体namespace全保留，没有遗漏或矛盾。原QA要求整句含with而false；追加独立审计只接受这一已观察到的固定等义完整答案，原始SSE/CLI/原生数据库/官方导出仍要求全文逐字相等，不放宽历史正文比较。原false SHA `a184e14026bbdb448db6de1a0909c84f347ff99d7de04405f0baf10883cbf15d` 保留。会话总数1、两原历史全字段前缀、恰一条新prompt和一条assistant、0工具、单派发、配置恢复和外部进程组核对通过。禁网官方CLI导出属于恢复证据，不冒称模型后新TUI恢复。

Codex 实际上游用量 input6020/output84，其中reasoning57，模型为同一 `deepseek-v4-pro`。96个完整Responses SSE事件含正确随机标记和完整决策，未调用工具。QA递归扫描把 `response.text.format.type="text"` 及 `response.tools` 回显的固定函数定义/JSONSchema类型误当执行项，在created帧拦截。原native只保存一次未完成prompt，没有assistant；保留false，不能将上游正确答案补写进原会话，也不能把mock或离线响应审计冒充原生成功。原2092字节前缀、来源、唯一目标及派发回执保留，原始response SHA `1646f3d753cd0504f0faeec63edc12c540be84ffed92a2d5892d7fa96ae0e270`。

最小QA修正只在response对象内精确核对固定tools定义SHA及text格式，然后区分这两处声明元数据；其他字段和所有执行项仍递归拒绝工具调用。12项专项及独立审查额外3个真实响应注入负例通过。原96帧原字节离线通过，`response-validation-addendum.json` 明确 `modelContextProof=true`、`originalNativeAcceptance=false`。官方全禁网read/list读回同一原会话的完整历史和唯一pending prompt，末turn为interrupted；另一次resume因探针额外的原文件写保护被拒，属于探针保护限制，不作为产品缺陷。没有补写assistant、重跑导入或调用模型，原失败和当前原文件SHA保留。

另对OpenClaw这例已保存的五条历史执行一次零输入、OS禁网TUI恢复，完整正文/角色/顺序和全部8个事件、会话数6/唯一ID、agent数据库全表、配置和来源均保持。严格整体验收仍false：state除预期的lastSession指针外，额外更新config-health观测、diagnostic_events和schema_meta元数据。逐行差异另存；不扩大允许表集合。两次0原生启动的QA前置失败（固定枚举和string/text-block表示）留证，修复前实际8events完整dry-run，唯一TUI结果 `OpenClaw/grok-native-live-01/offline-restart-fixed-v3/`。这不改变原完整决策回复失败，也不覆盖先前六方向双TUI成功记录。

OpenCode 的先前 Claude/Codex 两例单轮 CPA/Opus 成功证据继续保留，本次不重复调用；官方免费入口403也仍保留。每例成功只适用于该具体来源、目标、版本及合成纯文本历史，不外推35个方向全部真实回复。

## 执行器与失败恢复证据

- 单次 relay 将 contract、原始请求哈希和当前 provider 指纹绑定；派发前 O_EXCL+fsync 保存 token，同操作换目录或重启也不能重新派发。派发前后核对 provider 未变化，固定 `api.deepseek.com:443`，不改写原始请求，不跟随重定向，不切换凭据或模型。
- 原生子进程由 macOS 沙箱仅允许当前 loopback relay，真 key 仅在父进程内用于官方 HTTPS。输出有界保存在内存，脱敏后落盘；目标和证据另做扫描。退出只清理自有进程组，外部变更下隔离配置恢复采用字节校验。
- 独立审查发现并修复 slow-body 客户端 socket 未关闭、清理期间首次取消被忽略，以及清理结束后取消跳过最终审计等 QA 缺陷。慢连接、半流、重定向、重复请求、并发 token、源码/配置/provider 漂移和多阶段取消均有本地负例。
- 系统 Python 默认 CA 路径不存在，Claude来源的 OpenClaw 首次尝试在 TLS 握手阶段失败，0 POST；已消费回执不重置。已安装 certifi 证书包 SHA `c55b21f907f7f86d48add093552fb5651749ff5f860508ccbb423d6c1fbd80c7` 经固定官方域名 TLSv1.3、CERT_REQUIRED 和 hostname 验证通过，后续仅给 QA 父进程设置 `SSL_CERT_FILE`，没有关闭证书验证或改变系统信任。
- Codex来源的 OpenClaw 另一次启动被严格投影拒绝，0 POST。无原时间戳的冻结载荷使用1970年原生时间，旧 QA 错用固定2026年 envelope；现从已审载荷的实际时间戳推导。旧失败及新增 prompt 保留，该对象没有重跑。
- 首次 Codex mock 复制 SQLite 时残留绝对 rollout 路径，原生 CLI 向旧公共目标追加了零模型的失败执行记录。来源及原始载荷前缀保留，现场不回滚。后续 mock 仅写冻结 renderer 载荷到自身目录，由 CLI 自建索引；新官方回读明确校验原生索引路径归属。旧目标不再用于真实请求，改用另一干净的 Grok 公共目标。不能再将旧目标描述为仍精确等于初始载荷。
- Codex 0.146.1 的 `ToolMode` 没有none；只关闭 shell 不会清空工具。通过官方 `agents.enabled=false`、`multi_agent_v2=false`、`goals=false` 及 plan/question 开关将原生声明限制为固定 `view_image` 普通函数。原生额外 developer/environment 消息列入精确合同；所有历史正文/角色/顺序保持，不能通过忽略正文获得通过。完整 Responses SSE 在传给 CLI 前逐帧及递归拒绝工具调用、错误和不完整响应；不允许 native 执行该函数，不剥离或重写 wire。

## 实际命令与验证

```text
python3 qa/probes/openclaw-offline-tui-selftest.py
python3 -B qa/probes/openclaw-postreply-offline-selftest.py
python3 qa/probes/qa_owned_cli_selftest.py <new-private-directory>
python3 -B qa/probes/deepseek_once_relay_selftest.py
python3 -B qa/probes/deepseek_codex_guard_selftest.py
python3 -B qa/probes/deepseek-hermes-native-once-selftest.py
python3 qa/probes/deepseek-openclaw-native-once.py --selftest

# 唯一真实执行；SSL_CERT_FILE仅对该QA父进程设置为已核验的本机CA路径
python3 qa/probes/deepseek-claude-native-once.py live <new-public-case> <new-attempt>
python3 -B qa/probes/deepseek-hermes-native-once.py <codex-to-hermes-no-update> <new-attempt> --mode live
python3 -B qa/probes/deepseek-codex-native-once.py <new-attempt> --mode live
python3 qa/probes/deepseek-openclaw-native-once.py <grok-build-to-openclaw> <new-attempt>
```

relay12项、Codex修正后12项、Hermes10项、OpenClaw14个投影负例、生命周期取消及UTF-8自检通过。后回复TUI自检另含20个分块正例、15个损坏正文/尾部负例，以及原生string/text-block和错误角色/未知块检查。各真实执行的精确命令、二进制、执行器与helper SHA保存到独立attempt；mock和live分别标注，不用后续脚本SHA冒充先前运行。实际独立复核后才派发真实请求。

本阶段没有产品代码变更，不把以前的Rust/前端测试记录冒充今天新执行；沿用源码SHA相同的既有回归结果。当前脚本AST、局部Markdown格式及`git diff --check`另核对，最终命令结果/源码指纹和证据文件SHA保存到 `provider-retest/final-validation/`，不以根目录HEAD覆盖dirty源码身份。

Claude执行器、共享relay、Hermes及Codex执行/回读边界均经独立子代理审查；主代理另重算Claude/Hermes的原始证据和回复、OpenClaw的完整屏幕/官方事件及失败元数据。Claude真实执行器SHA与后来thinking gate修正SHA分别记录；Hermes原false和追加审计SHA分别记录；Codex原拒绝guard与修正guard分别记录。原始result均未被覆盖。

## 尚未完成的边界

仍不能声明全 Agent / 所有方向完整原生互通。Grok、Cursor、Antigravity 外来原生目标保持禁用门限，Antigravity ACP 来源仍缺环境；其他来源的逐方向真实回复、工具/附件本体及长历史没有因代表例成功提升。OpenClaw 的本次完整决策回复失败不因历史链路正常而改成通过。真实手机、Windows/Linux实机、账号生产、签名公证和发布不在本次通过范围内。
