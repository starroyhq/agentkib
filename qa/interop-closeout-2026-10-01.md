# Codex、OpenClaw 与 Cursor IDE 会话互通收尾

2026-10-01，隔离工作树实施。Codex 两个新方向的真实回复、OpenClaw 新方向的完整回复审计及两次禁网原生恢复通过。Cursor IDE 的生产接入、来源解析与恢复流程已实现，实际窗口验收与 fixture 分开记录。**不能宣称全 Agent、全部方向互通通过。**

## 源码和范围

- 工作树：`/Users/user/.codex/worktrees/main-acceptance-20260930/agentkib`。
- HEAD：`0440d049647c3862b8e79a06ea14e9b0bbab39dc`，分支 `codex/main-acceptance-20260930`；起点已有 75 条 dirty/untracked 状态，不是干净 main 验收。
- 证据目录：`/Users/user/Documents/AgentKib-archives/2026-10-01/interop-closeout`。修改前保存 `baseline-status.txt`、`baseline.patch` 和 `revision.txt`；状态 SHA256 `ea18514c35972d5168f343616f64b2288719bfc226bfe404dac43b75de4451fd`，patch SHA256 `5db389e3c7eecf2a5a0144ecb26bcb8d3602166fd1aa0ced269ede1ae65424a0`。
- 保留已有 Antigravity、互通、离线 QA 和其他 dirty 工作；本轮生产增量是 Codex 精确 gate、Cursor IDE provider/codec/桥接/导入恢复、桌面 IPC/预览/连接 UI、固定 VSIX 打包，以及版本/方向文档。OpenClaw 本轮仅修改验收执行器与合约，没有调整生产导入逻辑。
- 无提交、推送、部署、发布、用户 Agent 替换、生产依赖新增、数据库迁移、远程控制或鉴权协议修改。

## 三个真实单轮用例

所有用例均为新公共交接操作、新目标和新回执。授权只在验收 relay 进程内读取；没有全局配置改动、自动重试、自动换模型或凭据复制。

| 来源 → 目标 / 版本               | 转换                                                   | 原生导入/恢复                                                          | 真实回复与请求次数                                                                                                               |
| -------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Grok Build → Codex `0.146.1`     | 公共预览/ChangeSet 严格正文通过                        | 原生完整 5 消息、同 UUID、索引唯一、两次独立禁网 read/resume/list 通过 | `deepseek-v4-pro`，HTTP200；admitted=1 / dispatch=1 / blocked=0；随机标记及完整决定准确                                          |
| Claude Code → Codex `0.155.1`    | 公共预览/ChangeSet 严格正文通过                        | 原生完整 5 消息、同 UUID、索引唯一、两次独立禁网 read/resume/list 通过 | 同模型，HTTP200；admitted=1 / dispatch=1 / blocked=0；随机标记及完整决定准确                                                     |
| Grok Build → OpenClaw `2026.9.6` | 公共预览/ChangeSet、官方原生 writer、重复/重启回执通过 | 原生完整 5 消息、同 ID、两次独立禁网 TUI、精确元数据合约通过           | 同模型，HTTP200；admitted=1 / dispatch=1 / blocked=0；完整决定保留，仅连接词变逗号。原严格结果 false 保留，精确整句独立审计 true |

两个 Codex 用例来源、导入前缀、实际正文、唯一目标与所有自有进程退出均通过；实际响应声明元数据与工具执行对象分开检查。工具执行、未知对象、不完整响应仍拒绝。原 `0.146` gate 不变，仅增加精确 `codex-cli 0.155.1`；0.155.0、0.155.2、0.156 及附加输出均拒绝。

Codex 二进制 SHA256：0.146.1 `35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179`；0.155.1 `8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e`。精确命令、usage、原始 SSE、实际脚本身份和旧失败见 [Codex 专项](codex-deepseek-completion-2026-10-01.md)。

OpenClaw 只在独立配置中启用 `reasoning:true`，原生 `--thinking medium` 实际投影为 `thinking.enabled`、`reasoning_effort:high`；单次回复上限 4096 tokens。没有整表忽略：配置观察行、指纹、原生会话指针、官方 migration、文件身份及时间均按字段核对；其他状态准确不变。原 live `result.json` 为 false，SHA256 `d2cb72d34598efacb2133bfc9e67f3979147ea09a18783e3fc641d9d25d78b54`；独立审计 SHA256 `0914027daabaee848264bca1971b1f42ee1d921b412e17210f0379c7505b8e28`。详细命令与证据见 [OpenClaw 专项](openclaw-deepseek-completion-v2-2026-10-01.md)。旧遗漏项目决策的失败仍失败。

## Cursor 产品接入与独立审查

固定 Cursor IDE `3.22.12`（commit `3a92974361033b2051526321308c2740fe5912c0` / arm64），可执行文件 SHA256 `7c85e27a23b7dbe8fbfc738a8876550b10cd57173df7cf7d060de69bb216a075`；`package.json` SHA256 `0f043db2fd6975bb60045dcc93a8e402e3dfc1d55aa753e0433067f8b79563fb`。

第一方 VSIX `agentkib.cursor-bridge@0.1.0` SHA256 `671fb182fabc0c086380968b9600bd66f24e4ee73cbfadc7121447beec6ba1ee`。无第三方扩展或新生产依赖；ZIP 手工固定打包，桌面资源和 release 构建步骤同步。受校验的 IPC 只能查看并揭示此固定产物，不接受 Renderer 提供任意路径或执行命令。

实现使用唯一 `SessionDocument` 和独立 IDE 引用命名空间；冻结脱敏载荷经 Changes 确认后才能调用 `developer.bulkImportChats`。Cursor 随机原生 UUID 与操作 UUID 分开；180 秒内核对唯一候选、完整 root/blob 哈希、角色及必要正文后记录目标，打开后检查选中 ID。超时/断连/未知结果只核对，不再次导入；失败不自动降级文件交接。

原有 CLI 分支、12 参数桌面调用和已有 RPC 保留；新增 IDE 可选表面与本机绑定。仅 macOS 本机单文件夹支持；依据真实 storage URI 探测的已知 `User/globalStorage/state.vscdb` 布局，命名 profile 未验证布局拒绝。Windows/Linux 原生桥接关闭，Agents Window/CLI 不因 IDE 接入提升能力。

独立子代理依据 `review-agent` 审查执行服务、扩展、恢复及桌面 IPC；修复并复核：

1. 同 profile 多绑定造成来源重复，现按完整 profile 去重且不同工作区不合并。
2. 旧连接失败误删除新 lease，现条件删除仅作用于原窗口对象，替换连接主动关闭旧 socket。
3. 多扩展宿主覆盖 SecretStorage 绑定数组，现凭据按 binding 独立保存，hint 不承担权威选择；Runtime 检查多绑定并要求显式重连。
4. Runtime 晚启动导致重连永久停止，现 2–30 秒退避；重连不重放导入。
5. Disconnect 删除冻结身份导致无法恢复，现撤销旧凭据与读取能力、关闭 socket，但保留原 binding 供显式重新授权。
6. 来源不可用时缺少连接恢复入口，现恢复面板可对冻结 binding 直接连接，无须新分叉。

Runtime 集成 fixture 8 项通过：真实 Runtime 公共预览/Changes/导入、严格正文来源回读、再向五目标预览、重复请求、延迟 blob 未完整前不打开、丢回执/Runtime 重启不重导入、错 profile/工作区/版本拒绝、多绑定凭据拒绝和显式 ticket 恢复、旧 socket 不误删新窗口、断开撤权后原操作恢复、普通请求 1 秒内响应及 EOF 取消。socket peer 与 SQLite 边界为合成 fixture，**不是 Cursor 窗口验收**。

自动化矩阵为 9 个实际来源表面 × 6 个格式，共 54 个方向：保留原 40，新增 8 源→IDE、IDE→原 5 及 IDE 自分叉。IDE 来源确实从原生 root/blob fixture 经 Provider 读取，用户/助手正文有独立全文 golden；其他来源亦经各自 parser，未改 Agent 标签冒充来源。新增 IDE 目标比较完整正文、角色、损失/脱敏和 root/blob 字节；旧 Hermes/OpenClaw 矩阵验证转换投影，实际存储回读由各自独立 native QA 留证，不能声称 54 个组合都有原生目标回读。真实 Grok 工具/附件 parser→IDE 另验证 4 条正文/角色投影及工具损失 2、附件损失 1、推理排除 1。多角色、Unicode、损坏/未知字段、长历史拒绝等由 codec 邻接回归覆盖，不能外推全部 54 个方向的富内容。该矩阵只证明解析/格式转换，不是 54 次官方客户端导入或真实回复。

## 实际 Cursor 窗口验收

官方 CLI 实际成功安装 VSIX 到独立 extensions 目录，`--list-extensions --show-versions` 返回 `agentkib.cursor-bridge@0.1.0`。安装/启动命令记录在 `cursor-vsix-install.log`、`cursor-window-a-launch.log`、`cursor-window-b-launch.log`：

```sh
/Applications/Cursor.app/Contents/Resources/app/bin/cursor --user-data-dir /Users/user/.codex/tmp/cursor-bridge-1001 --extensions-dir /Users/user/.codex/tmp/cursor-bridge-ext-1001 --install-extension apps/desktop/build/cursor-bridge/agentkib.cursor-bridge.vsix
/Applications/Cursor.app/Contents/Resources/app/bin/cursor --classic --new-window --user-data-dir /Users/user/.codex/tmp/cursor-bridge-1001 --extensions-dir /Users/user/.codex/tmp/cursor-bridge-ext-1001 --use-inmemory-secretstorage --sync off /Users/user/.codex/tmp/cursor-bridge-1001/workspace-a
# 第二个窗口使用相同隔离参数与 workspace-b。
```

初次电脑操作受 macOS 锁屏阻挡；后来已能读 Cursor，但工具只绑定同名既有个人实例的 `Cursor Agents` 窗口，不能选择独立进程的普通窗口；窗口枚举 API 在 macOS 不提供，最后再次锁屏。未退出或改动个人 Cursor 工作。已请求用户解锁及保存后正常退出个人实例，便于继续选隔离窗口。实际生产挑战连接、权威 profile 映射、普通历史界面、两次 Cursor 重启、IDE 再作为来源和真实回复此时保持未验收；旧普通窗口实验不是本轮桥接通过证据。隔离 profile 未复制授权，也不把原 profile 登录状态当作此 profile 授权。

本轮原生验收 harness 为 `qa/probes/cursor-bridge-native-acceptance.py`，SHA256 `d2eeeeddc30b7240a09235103231b64644bd77fb600a8f4e3f8aee40a8c29b07`，独立审查及脱敏 selftest 通过。冻结实际 debug Runtime SHA256 `88da0d5ac0e76ae46301287c39d8bdc3475c6a64434db0be8756fb9121b0c42b`；实际公开 RPC 创建两工作区、唯一新来源、来源哈希与状态查询通过，见 `cursor-native/preparation-audit.json`。尚无窗口绑定，原生导入与模型请求均为 0；未直接改写 Cursor 数据库。最后通过 `send --json '{"action":"stop"}'` 正常退出 Runtime，记录 `stage-005.json`；保留工作区和新证据，后续只恢复此 harness，不重新生成已消费目标。

### 同日继续验收

上段保留初次停止时的状态。后续用未经修改、哈希一致且 `codesign --verify --deep --strict` 通过的官方应用副本，解决同名实例的窗口选择问题；个人实例保持不变。QA harness 只增加固定副本身份校验，保留原脚本与旧证据，新增脚本 SHA256 `7e0d9a54a2fcd51534786d115031cca47a18d0a5faa712ff1a587b8622b641b9`；语法、脱敏、七个身份负例、两实际官方应用校验及独立复核通过。

`stage-006`–`stage-039` 实际完成两个隔离 Claude→Cursor IDE 文本用例的第一方挑战连接、权威 profile 映射、公共预览/Changes、唯一原生导入、全文/root/blob 回读、原操作重复、两次正常客户端与 Runtime 重启后原 UUID 打开，以及 IDE 再作为来源的五目标预览。两个原生 ID 为 `11e3f845-8dfb-4381-84ca-e4a1dc8e6a87` / `3e172a62-6cd8-4bff-818a-34f185c4d871`；每操作只导入一次，来源保持不变。

**前景历史界面及真实回复此时仍未验收。** 无障碍树含后台已加载的全部正文，但六张实际截图前景均为登录覆盖页，不能按无障碍正文判定可见界面通过。隔离 profile 未复制官方授权，模型请求为 0；用户已选择自行登录后继续，登录完成须另行核实。`--use-inmemory-secretstorage` 下显式恢复原 binding，不证明 OS SecretStorage 跨客户端进程的凭据持久性。五目标预览不等同于五个反向原生导入。具体命令、身份、原始阶段及限制见 [Cursor 原生补验](cursor-native-acceptance-2026-10-01.md)。

### 官方登录后追加验收

用户自行完成隔离 Cursor 官方登录后，两个普通 IDE 新截图确认完整历史真正可见；初期登录墙截图和初期“未验收”记录保留。A 使用固定 Ask / Grok 4.7 High Fast，仅一次 GUI 发送，回答未继承标记和决策。独立原生审计证实转换遗漏 `root_prompt_messages_json`，仅写界面 turns；已经补齐同一冻结正文到独立模型历史及严格回读/恢复校验。旧失败及一次发送回执均保存，修后真实回复仍待新用例，不自动重发；一次 GUI 发送不能外推厂商内部上游请求次数。

实际 Cursor IDE→Claude `2.1.285` 通过一次公共预览/Changes 原生文件写入和原 UUID `b45fcc17-078f-45d0-afb9-fae8d1f112f5` 两次独立禁网恢复。原始严格 TUI matcher 因 inline code 两个反引号的展示差异而 false，保留原结果；新固定展示合约的补审计不改变源/目标正文、角色或字节。旧十份证据 SHA、Cursor B 完整源图/公共 fingerprint、Claude 目标全文件字节均未变，无再次 apply、新会话或模型。新恢复 runner 与 Runtime exit0，原生自有进程经监督清理为 -9，均已确认退出。细节及证据见 [Cursor 原生补验](cursor-native-acceptance-2026-10-01.md)。

登录后追加的修复后 B 用例已实际导入五条完整模型/界面历史和 13 个 blob。官方 protobuf 字段分组导致的原 `outcome-unknown` 保留；最小格式修复后只核对既有操作并认领原 UUID `47ee1557-d797-4ba1-a9e7-d03bf4f5ce72`，没有再次导入。两次 Runtime 重启后的原 ID 打开、全文核对及唯一回执通过，来源和原计划/hash 不变。两个独立子代理实码复核与独立原生图/回执审计通过。修复后全量 Rust 为 1040 passed / 0 failed / 9 ignored，fmt、all-targets Clippy 和 debug build exit0；对应 `cursor-contextfix-v2/vendor-order-final-*.log`。此追加不把下表的旧 release/前端二进制冒充新 debug 验收。

再次解锁后，新 A 按 canonical 格式完成一次导入与原操作重复，唯一 UUID `783272bb-80cf-4c5b-8560-60599dca6402`；实际 root 原字节、全部 13 个 blob、五条模型/界面历史及来源未变均独立核对通过。修复后 A/B 普通窗口完整历史可见。隔离 Cursor 正常退出并重新启动、Runtime stage035 重启，B 原绑定重连及同 UUID 回读通过；进一步窗口操作出现 `native pipe startup failed` / `noWindowsAvailable` 和 AX/截图不同步，已请求用户手动聚焦 B、设置 Ask。此时系统确认未锁定，模型请求为 0，第二次完整客户端恢复和真实回复尚未验收。stage042 正常停止 Runtime、serve exit0，control socket 与自有 Runtime 进程均消失；本段保留当时结果。

后续界面恢复，新 B 仅一次 Ask / Grok 4.7 High Fast GUI 发送，准确回复完整标记 `AKIB-CURSOR-2f61aa1c2147498aa7` 及 `append-only SQLite WAL with namespace cobalt-lake`。新 UI user 全文和唯一问答、无工具步骤、原 13 个 blob / source / plan / native UUID 不变均独立核对；厂商内部上游次数不可观察，不声称仅一次上游。第二次正常 Cursor 退出/重启后，A 完整原历史和 B 原历史加同次回复均实际可见。stage048 又证明官方 assistant JSON 键重排导致生产原操作恢复误拒；最小修复通过 17 定向测试、workspace 1042 passed / 0 failed / 9 ignored、fmt / Clippy / debug build，以及独立子代理实码复核。新 Runtime SHA `5d18e7fc36a4e0a6eb3766e28b4ca27e8914dfd7febf4bc6ee2d80bd04c46abc` 已另冻，原失败均保留；10 月 2 日最终原操作产品打开、实际全文及再次 Runtime 重启恢复已通过，见[独立收尾 QA](cursor-postreply-recovery-2026-10-02.md)。回复后审计探针亦按独立意见收紧私有 JSON 读取和模型元数据投影边界，旧报告与新报告分别留证，不能互相替代。完整证据及限制见 [Cursor QA](cursor-native-acceptance-2026-10-01.md)。

## 检查

使用 Node `22.23.2` 和 pnpm `10.8.1`，已有按锁文件依赖不升级。OpenClaw 原生执行另外使用其要求的 Node `26.9.0`。证据目录保存实际 stdout/stderr，命令工作目录均为本隔离工作树。

| 命令                                                                                                                                         | 结果与日志                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cargo fmt --all -- --check`                                                                                                                 | 通过；`rust-format-after-golden.log`                                                                                                                                                                                                           |
| `cargo test --workspace`                                                                                                                     | 1035 passed / 0 failed / 9 ignored；`rust-workspace-tests-after-golden.log`                                                                                                                                                                    |
| `cargo clippy --workspace --all-targets -- -D warnings`                                                                                      | 通过；`rust-clippy-after-matrix.log`                                                                                                                                                                                                           |
| `pnpm format:check` / `pnpm lint` / `pnpm typecheck`                                                                                         | 全部 exit0；对应 `frontend-*-final.log`；lint 84 条 warning，非 warning-free；Web 路由生成器有 circular-dependency warning                                                                                                                     |
| `pnpm test`                                                                                                                                  | 扩展 Node 11 passed；桌面 959 passed / 7 skipped；Web 230 passed；`frontend-test-final.log`                                                                                                                                                    |
| `pnpm build`                                                                                                                                 | 桌面/宿主/预加载/嵌入 Web 构建通过；`desktop-build.log`；最后 Runtime release 增量构建通过，SHA256 `e981902af6e3b045ee13d1407f41b89506b5205098a027de8de8406545cfd37a`，命令记录 `runtime-release-final.log`，身份另存 `binary-identities.json` |
| `pnpm build:web:hosted`                                                                                                                      | 通过；`hosted-build-final.log`                                                                                                                                                                                                                 |
| `python3 qa/probes/deepseek_codex_guard_selftest.py`                                                                                         | 13 passed，含固定版本响应元数据/工具负例；`codex-guard-tests.log`                                                                                                                                                                              |
| `python3 qa/probes/deepseek-openclaw-native-once.py --selftest`                                                                              | 22 投影负例通过；`openclaw-projection-tests.log`                                                                                                                                                                                               |
| `cargo clippy --locked -p agentkib-runtime -p agentkib-conversations --target {x86_64,aarch64}-pc-windows-msvc --all-targets -- -D warnings` | 环境阻塞 exit101：本机 clang 缺 Windows C SDK，libsqlite3/ring/aws-lc 缺 stdlib.h/assert.h/windows.h；未到项目检查，不能声称 Windows Clippy 通过                                                                                               |

全量检查发现并修复本轮测试接入问题：Node test 文件被 Vitest 重复收集、日文遗漏新键、几处 Clippy needless-borrow/collapsible-if。旧失败日志保留，未削弱断言。

Grok 与 Antigravity 外来目标仍禁用，已有具体接口探测边界保留；Cursor CLI、Agents Window、新版/命名 profile、Windows/Linux 实机、未列入三个新在线用例的方向和真实手机仍未验收。未满足这些门限不能以本轮三例或 54 个纯转换组合外推“全互通”。
