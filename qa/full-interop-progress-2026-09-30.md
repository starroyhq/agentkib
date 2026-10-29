# 全 Agent 互通持续验收 — 2026-09-30

起点为 `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，工作树 `main-acceptance-20260930/agentkib`。本轮尚在进行，不能将本报告称为全互通通过。用户已建立持续 goal，并明确允许使用已有可用模型授权；仍每例单轮、不自动重试、不自动换模型、不迁移凭据。

## 本轮新增实际导入方向

沿用未修改的主线 debug Runtime，SHA256 `18f225c179dfc891553a182fd1e922b363ff0a5b4414d809738106236489de16`。OpenCode `1.18.32`、Hermes `0.21.5`、OpenClaw `2026.9.6` 均为此前独立安装；无用户 Agent 更新。隔离数据和原始日志位于 `~/Documents/AgentKib-archives/2026-09-30/full-interop/`。

| 实际来源路径 | → OpenCode | → Hermes | → OpenClaw |
| --- | --- | --- | --- |
| Codex 合成 threads SQLite + 原生 rollout | 导入/回读/恢复通过 | 隔离关闭更新检查后通过；首次失败保留 | 导入/回读/恢复通过 |
| Grok Build 合成 summary + ConversationItem JSONL | 通过 | 通过 | 通过 |
| Hermes 合成 sessions JSONL | 通过 | 通过 | 通过 |
| Cursor CLI 固定 2026.09.26 protobuf/blob SQLite | 通过 | 通过 | 通过 |
| OpenCode 官方 1.18.32 import 创建的合成原生来源 | 通过 | 通过 | 通过 |
| OpenClaw 官方 2026.9.6 writer 创建的 SQLite 来源 | 通过 | 通过 | 通过 |

以上为 **18 个新增公开 Runtime 命令导入方向**。加上上一报告 Claude 的3个方向，当前共有21个代表纯文本方向的公开命令导入证据，另有下文 Codex→Claude 文件方向；这些不等于真实模型续接通过，也不是全部40个格式组合的原生验收。

所有新增方向均调用真实 `workspace.refreshSessions`、`sessions.prepareHandoff`、`sessions.planHandoff`、`sessions.continueHandoff` 和 `sessions.nativeImports`，停止 Runtime 后重启再恢复。没有替换中间文档的 Agent 标签。Cursor 只在独立合成目录使用已冻结 serializer fixture 的字段和 hash 图结构生成随机正文，不写用户存储；其结果不验证新版 Cursor 原生目标。

校验包括：来源文件与索引 SHA256 不变；归一化文档的角色、顺序、全部正文严格等于合成输入；目标独立回读严格等于冻结预览；三次继续均为 `launched`；重启前后的完整操作请求、plan hash 与目标身份相同；每个目标仅创建1个新会话。OpenCode→自身为1个来源加1个目标；OpenClaw目标有5个基线fixture，OpenClaw→自身另有1个来源。旧回执只含状态的接口限制与既有验收一致，不捏造不存在的返回ID。

实际命令模式：

```text
python3 qa/probes/main-interop-rpc.py target/debug/agentkib-runtime <pinned-tools> <new-case> <opencode|hermes|openclaw> <codex|grok-build|hermes|cursor>
python3 qa/probes/interop_native_readback.py <existing-case>
```

OpenCode 来源通过固定官方 import 命令播种，导入前后整个原生 export 对象必须相等；OpenClaw 来源由固定官方 transactional writer 播种，导入前后官方只读 accessor 返回的整个 events 和来源 entry_json 必须相等。自己导入自己时仍创建独立 ID；没有要求含有新目标的共享数据库文件字节不变，也没有把仅输入 fixture 的 SHA 当作来源原生数据未变的证据。新探针为 `opencode_source_fixture.py` 和 `openclaw-source-fixture.mjs`。

`source-projection-revalidation.json` 保存新增严格来源全文断言后对成功案例的独立只读复验结果。该复验不重导入、不启动模型。

## Claude 文件目标与授权模型新用例

新增 Codex→Claude 的公共 Runtime 文件写入方向：`codex-to-claude-public-v3`。真实来源 provider、预览、ChangeSet、首次继续均通过，目标 JSONL 字节与预览完全一致；重复应用按已存在目标冲突拒绝，重启 Runtime 后使用 `launchHandoff` 打开同一 UUID，目标仅1个，来源文件与索引 SHA 不变。这与命令导入的回执复用语义不同；尚未证明 Claude 原生界面与真实回复。前两次仅准备阶段失败分别为端口占用及测试错误假设文件目标必有 target_fingerprint，均保留日志。

用户明确选择后续新用例使用当前 CPA / Opus 映射 `relay/claude-opus-5-5`。新 `claude-to-opencode-cpa` 从最初预览即固定该模型，完成公开导入及回读；磁盘配置的地址默认为不可用本机端口，不含密钥。它是已有方向的新模型用例，不新增方向计数，也不重试此前失败的免费模型请求。随后通过独立窗口/取消/单发审查，在受监督窗口完成唯一一次 CPA 请求，HTTP200，原生回复精确包含随机标记和完整项目决定；OpenCode 报输入4、输出41、总45 tokens（客户端可取得的报告，不外推供应商计费），无工具调用。来源及原生前缀不变，1个会话、1条新用户消息，Runtime重启核对和重复恢复未发送或再导入。CC Switch/CPA原值已恢复且运行态重载确认；凭据仅进程内读取。详见 [CPA 实例](full-interop-opencode-cpa-2026-09-30.md)。该结果只覆盖此代表纯文本方向，不能外推所有来源、附件/工具或其他目标。

Hermes 原有 Claude→Hermes 用例已补两次独立原生 TUI 禁网回读：随机标记与项目决定可见，之后重新核对 SQLite 全文、来源及唯一 ID；未提交模型提示，不将其当作真实回复通过。详见 [Hermes TUI 记录](full-interop-hermes-tui-2026-09-30.md)。

## Codex 修复后的公开链路

重新构建 Runtime 后，`claude-to-codex-public-fixed-v2` 通过真实 Claude provider、预览、ChangeSet写入、首次启动、重复应用明确冲突拒绝、Runtime重启后同 UUID 打开。官方固定 Codex 0.146.1 在该**同一目标目录**执行两次独立 app-server 启动，read/resume/read 的角色、顺序、完整正文都等于审查载荷，thread/list 显式过滤 exec 后恰一目标，rollout唯一，来源SHA不变，禁网且无auth文件/模型调用。

新 Runtime SHA256 `e2898474eb22902c61c6ad22a4215493b871117a29bde1f2b876c94869a27b5d`；旧二进制已在私有档案保留，不覆盖已有QA身份。探针 `codex-public-import.py` 与 `codex-isolated-readback.py --existing`；后者不另建、重写或复制目标日志。首个 `claude-to-codex-public-fixed` 的合成来源遗漏 parentUuid，只有准备阶段被拒，日志保留；修正fixture链条后用新case执行，不属于模型请求重试。真实模型与可视界面仍未验收，离线 app-server通过不替代它们。

## 保留失败与配置边界

首次 `codex-to-hermes` 在预览阶段被拒绝，未产生原生导入。原因是官方 `hermes --version` 同步查询 GitHub 更新；同一隔离环境直接测得3.406秒，超过现有生产版本探测3秒期限。官方 `hermes_cli/banner.py::check_for_updates(passive=True)` 支持 `updates.check: false`。探针仅在自己创建的 Hermes 配置中关闭该检查；新case `codex-to-hermes-no-update` 通过。没有改生产超时、伪造CLI版本或削弱错误断言，首次日志仍保留。

Hermes 此批来源验证为 JSONL，不能替代 SQLite 压缩/分叉的专项实机验收。全部来源仅两条随机标记/项目决定纯文本，没有历史工具或附件；本轮不增加这些边界的真实验收结论。终端启动回执不等于新方向已逐个观察原生界面。

## 尚在推进

- 模型回复：OpenCode 官方插件单派发守卫已经独立复核通过。已有 Claude→OpenCode 会话使用官方 `opencode/big-pickle` 发出唯一一次真实请求，HTTP403、`FreeTierError`，无回复、tokens0；未重试、未切换模型。原生前缀、来源SHA、唯一目标及Runtime重启核对仍通过，真实回复未通过。详见[单派发与真实请求记录](full-interop-opencode-2026-09-30.md)。
- 用户已额外授权验收期间临时关闭 CC Switch/CPA 重试并恢复；已为已授权实例开启有限窗口并恢复；具体次数与结果见下方当前真实回复记录，原始与恢复日志均保留。CC Switch 禁用故障转移时存储的重试次数不生效，应处理错误整流与CPA实际重试，而非只改CLI重试环境变量。
- Codex 官方 `0.146.1` 禁网原生验收发现生产 renderer 的 `history_mode="save-all"` 不合法；仅改 `legacy` 后，原生历史仍缺少 `event_msg` 文本投影。已修复并通过独立审查；生产生成的载荷在两个独立 app-server 进程中完整回读5条文本（含中文、多行及重复正文），来源前缀与唯一目标保持不变。测试使用显式 exec 来源过滤，不宣称默认界面可见或真实模型验收已通过。
- Claude/Codex 隔离及授权：[专项调查](full-interop-claude-codex-2026-09-30.md)。
- Grok/Cursor/Antigravity 禁用目标的新版本接口和下一实验：[专项调查](full-interop-target-gaps-2026-09-30.md)。
- Antigravity ACP 来源的新增公开 Runtime 方向，以及Claude/Codex目标的逐方向本机验收尚未补齐。现有40组合解析/转换测试不替代这些证据。

## 按用户要求追加的离线文件方向

用户选择停止真实模型/登录后，再补12个纯文本公开文件方向：Claude→Claude，以及 Grok/Hermes/Cursor/OpenCode/OpenClaw→Claude；Codex/Grok/Hermes/Cursor/OpenCode/OpenClaw→Codex。加上既有Codex→Claude、Claude→Codex文件方向，当前7个可用来源到5个已实现目标共有 **35个代表纯文本方向** 的公开预览、导入/写入、严格正文及来源保护证据；Runtime重启后的操作回执或同一启动请求也已核对。这不是35个原生客户端恢复/界面验收通过。Antigravity ACP缺官方server，另5方向仍未验收；此35不含真实模型普遍通过的含义。

新增文件方向均首次continue确认写入，重复continue精确报目标文件已存在冲突，重启后相同launch请求被接受且磁盘目标UUID未变；Claude回执只含Agent名称，不能据此宣称其原生客户端确实恢复。每次仅新增1个目标，自己→自己时保留来源和独立新UUID。Claude自分叉的初次pure checker遗漏已知`last-prompt`元数据，先报失败；后按生产固定契约要求空lastPrompt且leafUuid等于末消息UUID，仅对已有载荷只读补核通过，未重写或重导。

对应脚本为main-interop-rpc.py文件目标分支、interop_file_readback.py；额外6个Codex方向在同一已写入目录用官方固定0.146.1完成禁网双进程read/resume/list，对完整角色和正文比较，不复制/重写payload。证据以 `additional-file-directions-results.json` 和 `additional-codex-native-readback-results.json` 为准。Claude文件方向不将启动Terminal回执冒充已观察原生UI；未声明完成全部工具/附件/长历史实机覆盖。

## 当前真实回复结果及授权阻塞

| 方向/用例 | 本机上游派发 | 实际结果 |
| --- | --- | --- |
| Claude→OpenCode，用户选定CPA/Opus | 1 | HTTP200，随机标记与完整决定准确，1个目标，恢复不重发；其后两次禁网原生TUI显示全文且原生导出不变 |
| Codex→OpenCode，同映射新用例 | 1 | HTTP200，随机标记与完整决定准确，输入4/输出40/总44 tokens（客户端报告），来源/前缀/身份与恢复通过 |
| Codex→Claude，原CC Switch配置 | 1 | 已校验请求alias `claude-opus-5` 映射用户当前通道。流打开后首上游返回403 permission_denied；CLI第二次请求被守卫拦截，最后显示guard400。未重试、未取得上下文回复，不能把最终guard错误当首次供应商错误 |
| Claude→Hermes CPA新v2用例 | 1 | CPA503 auth_unavailable，附上游permission_denied错误；0 tokens，无正确回复。来源/完整原生前缀/唯一会话/恢复/退出与配置还原均通过，真实回复未通过 |

Hermes首个准备用例在模型前因SQLite BLOB无法JSON序列化而退出；未加载请求凭据、未启动CLI/relay、0模型派发。已保留失败目录，改为显式带类型的base64快照编码并以实际两BLOB及变更负例独立验证；内存原始字段/bytes前后比较不变。新v2是首次模型请求，不删除或重置旧attempt。

五个临时重试窗口均恢复，最后独立核对CPA整文件SHA与各窗口原值相同、CC Switch原row精确恢复、运行态reload确认，证据 `global-retry-restoration-audit.json`。后续已经准备但尚未调用的其他OpenCode来源用例暂缓，不自动换模型、重试失败用例或修改供应商拒绝状态。供应商返回403/503不等于已证明产品转换失败，也不等于已证明整个通道永久不可用。用户随后明确选择“先保留未通过，继续离线验收”；所有后续真实模型和登录请求停止，离线验证继续。

Codex官方隔离登录因1455由既有Docker占用而未启动浏览器callback登录；改用官方device-auth取得临时代码，但授权轮询网络发送错误后退出1，没有生成auth文件，也没有发模型请求。旧码流程已结束并已通知用户；不复制现有凭据、不操作Docker占用、不自动再登录。

## OpenClaw离线故障与收尾

用户停止后续真实请求后，固定OpenClaw2026.9.6官方CLI仅连接本机mock：500、429、307、断连及SSE中断五类均仅1次模拟上游派发，9个传输投影负例通过。不能因此声明真实模型通过。回读/进程重启/持久token拒绝重发按各用例实际步骤分别记录，见[OpenClaw专项](full-interop-openclaw-offline-2026-09-30.md)；独立扫描109个文件未发现模拟密钥落盘。

本轮新增QA TUI在收尾按唯一隔离工作目录及进程身份重新核对，31个残留自有进程已退出，未操作用户会话；退出后12个新增文件方向再次只读严格回读均通过。文件方向proof不再使用含糊的sameIdentityAfterRestart，而明确Runtime重启接受相同启动请求、磁盘ID未变以及nativeResumeVerified:false；Codex独立原生回读另行报告。所有模型/登录实验已停止，global-retry-restoration-audit及各mock清理记录保留。

## 修复后的自动化验证

- `cargo build -p agentkib-runtime`：通过。
- `cargo test --workspace -- --test-threads=1`：44组结果汇总1009通过、0失败、7 ignored；ignored未计通过。
- `cargo fmt --all -- --check`、`cargo clippy --workspace --all-targets -- -D warnings`：通过。
- Windows x64/ARM64 与 Linux x64 各一次 `cargo check --locked -p agentkib-conversations --target ... --tests`：分别因缺stdlib.h、setjmp.h及x86_64-linux-gnu-gcc退出101，不能记通过；未改源码规避。见[跨平台记录](full-interop-cross-platform-2026-09-30.md)。
- 前端使用 Node22.23.2/pnpm10.8.1，format/lint/typecheck/test/build/hosted build全部退出0；桌面942通过/7 skipped，Web230通过。日志为 `full-interop/frontend-validation/`，skipped不计通过。

没有提交、推送、合并、部署或发布本轮修改。持续目标尚未完成。

## 继续离线验收的追加结果

独立覆盖审查发现35个公开方向为纯文本，原有工具/附件测试未经过官方导入器。因此补充合成 Grok 原生富历史→OpenCode/Hermes 的生产解析、脱敏、目标降级与官方导入回读。两个新增用例及两个纯文本对照在操作系统禁网下4项通过，目标无可执行工具字段；不增加35个公开方向计数，不外推真实回复。普通并行 conversations 出现既有 Antigravity 截止时间测试失败，串行复核179项通过；原失败日志保留。详见[富历史离线补验](full-interop-rich-offline-2026-09-30.md)。

另补公开RPC的损失确认、长历史能力门限拒绝及独立分叉计划身份三个测试，所在target最后7项通过。fixture初始化修正前失败和既有用例一次未复现的预览指纹变化均保留记录；未放宽生产校验。当前追加范围仅测试/文档，未重新宣称全workspace或默认并行全部通过。

10月1日继续处理该次并行截止时间测试的调度竞争：改为精确阶段deadline观察，并新增收到load就绪事件后实际超时的测试；最终默认并行conversations为180通过、8 ignored，RPC为7通过。预览指纹历史失败尚未确证根因，只补强原始原因诊断；详见[离线稳定性复核](full-interop-offline-stability-2026-10-01.md)。没有改变真实模型验收状态。

随后对六个来源→OpenCode/Hermes共12个已有公开方向补齐24次独立原生TUI禁网恢复，原生全文投影、来源、唯一目标在前后核对一致，所有自有进程退出；详见[原生界面补验](full-interop-native-ui-2026-10-01.md)。这些是原35个方向的证据补全，不新增方向计数或模型通过数。

## 用户收紧范围后的最终交付

10月1日目标改为五个已有目标/35个纯文本方向的有限离线收尾，停止在线及目标扩展。Claude七个来源的同UUID双TUI恢复、Codex七来源官方双接口、OpenCode/Hermes既有及新增原生恢复已留证。OpenClaw六个剩余方向双列表及回读/来源/身份通过，各一次完整TUI显示；第二次TUI因QA执行器截断UTF-8尾字节失败未执行，六方向双TUI全部保留阻塞。按一轮修复上限不再追加探针或替代实现。

最新矩阵、源码身份、回归复用范围及遗留缺陷见[五目标离线收尾报告](offline-interop-closeout-2026-10-01.md)。原始403/503、免费入口失败、Codex授权缺口、跨平台工具链及旧预览指纹疑点均保留；有限收尾完成不表示全方向真实互通或发布通过。
