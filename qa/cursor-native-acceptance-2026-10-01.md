# Cursor IDE 原生桥接补验

2026-10-01，继续使用 `main-acceptance-20260930/agentkib` 隔离工作树，HEAD `0440d049647c3862b8e79a06ea14e9b0bbab39dc`，保留原有 dirty 工作。未提交、推送、发布，未替换用户安装、复制凭据或改动个人 Cursor 实例。

## 当前结论

两个独立工作区的 Claude 合成历史，经生产公共预览、Changes 和第一方扩展，实际导入 Cursor IDE `3.22.12`。唯一目标身份、完整正文/角色、root/blob 字节与哈希、重复操作、两次正常 Cursor 与 Runtime 重启后的原 ID 打开均通过。

**登录后的两个普通 IDE 历史界面可见性通过，首次真实回复的上下文继承失败。** 初期六张截图仍保留登录覆盖页；用户随后自行完成隔离 profile 的官方登录，新截图实际显示完整导入正文。本次仅一次 GUI 发送，固定 Ask / Grok 4.7 High Fast，回答否认历史中存在随机标记和项目决策。独立审计证明转换只填界面 turns，遗漏独立模型提示历史；修复与后续补验另列，不改写旧失败。

修复后的新 A/B 已通过实际导入/原操作恢复、五条模型与界面历史全文核对和可见历史。新 B 两次 Runtime 重启核对通过；随后首次完整客户端退出/重启的数据与回执核对通过。界面工具恢复后，新 B 只发送一次真实请求，准确引用随机标记和完整决策；独立审计确认旧正文、角色、全部 13 个 blob 和来源未变、没有工具执行。官方回复后重排 assistant JSON 键顺序，触发恢复误拒绝；新修复及 10 月 2 日原操作恢复、七条全文可见和再次 Runtime 重启核对通过，见[独立收尾 QA](cursor-postreply-recovery-2026-10-02.md)，不把旧失败改写为通过。新 A 未发送模型。

反向 Cursor IDE→Claude Code `2.1.285` 已完成一次公共 ChangeSet 原生导入及同 UUID 两次禁网 TUI 恢复。它不包含真实模型回复。

两个案例属于同一来源方向，不能外推其他来源、富内容、长历史、CLI、Agents Window、命名 profile 或 Windows/Linux 实机。

## 身份与环境

- 原安装：`/Applications/Cursor.app`；官方 `3.22.12` / commit `3a92974361033b2051526321308c2740fe5912c0` / arm64。
- 为解决电脑操作工具无法选择同名不同进程的问题，将官方应用完整复制到 `/Users/user/.codex/tmp/cursor-native-app-1001/Cursor.app`，未修改 bundle 或资源。两个主二进制 SHA256 均为 `7c85e27a23b7dbe8fbfc738a8876550b10cd57173df7cf7d060de69bb216a075`，两个 package SHA256 均为 `0f043db2fd6975bb60045dcc93a8e402e3dfc1d55aa753e0433067f8b79563fb`，副本 `codesign --verify --deep --strict` exit0。
- 独立 user data：`/Users/user/.codex/tmp/cursor-bridge-1001`；extensions：`/Users/user/.codex/tmp/cursor-bridge-ext-1001`。固定第一方 `agentkib.cursor-bridge@0.1.0`，VSIX SHA256 `671fb182fabc0c086380968b9600bd66f24e4ee73cbfadc7121447beec6ba1ee`；目录亦存在 Cursor 自身的 remote-containers / remote-ssh 扩展，不将目录描述为只含第一方扩展。
- 使用 `--use-inmemory-secretstorage --sync off`；每次完整客户端退出后明确沿用原 binding 生成新挑战。因此本轮不证明实际 OS SecretStorage 跨客户端进程重启的凭据持久性。
- 冻结 debug Runtime SHA256 `88da0d5ac0e76ae46301287c39d8bdc3475c6a64434db0be8756fb9121b0c42b`。独立审计确认它与最终 debug `9b346183…` 的 18 个 section、加载命令、符号表及函数入口完全相同；8,151 个差异字节只属于 N_OSO 调试对象路径及签名。debug 实际验收不能替代 release 二进制验收，详见 `runtime-binary-equivalence.json`。
- 证据：`/Users/user/Documents/AgentKib-archives/2026-10-01/interop-closeout/cursor-native`。原脚本及原始证据保留在新增唯一备份 ZIP；没有重建来源、覆盖旧失败或重新生成已消费操作。

## 两个实际操作

| 工作区      | binding                                | 操作 UUID                              | Cursor 原生 UUID                       | 结果                                        |
| ----------- | -------------------------------------- | -------------------------------------- | -------------------------------------- | ------------------------------------------- |
| workspace-a | `dd28dbac-9b7c-4212-9379-641b5908f06a` | `ea33fa12-e2a9-49ae-8e95-81269557db4c` | `11e3f845-8dfb-4381-84ca-e4a1dc8e6a87` | 一次实际导入；两次重启和重复请求均沿用原 ID |
| workspace-b | `c1966153-d341-4956-8f37-d7714b77efc2` | `a1e0f8a1-c781-41d3-8a17-4a06a2d84ceb` | `3e172a62-6cd8-4bff-818a-34f185c4d871` | 一次实际导入；两次重启和重复请求均沿用原 ID |

同一 default profile 的 storage URI 实际映射到隔离 `User/globalStorage/state.vscdb`。两个工作区绑定分别选择，未猜测个人默认目录。每个目标为安全提示加四条原始用户/助手消息；保留中文、Unicode、换行、随机标记及完整项目决策。历史中的 `SELECT 1;` 是文本，没有请求执行。

Changes 只准备应用数据目录中的冻结 `plan.json`；扩展调用 Cursor 内置 `developer.bulkImportChats` 导入，不直接写数据库。Cursor 自动生成的原生 UUID 与操作 UUID 分开。只读核对完整 root、所有八个 blob、哈希、角色和全文，确认唯一候选后打开；`composer.getOrderedSelectedComposerIds` 确认实际选中原生 ID。无障碍树同时确认正确工作区、操作标题和后台已加载正文，但登录墙使前景可见性仍未验收。

原始阶段文件：

- `stage-006`–`stage-012`：A 挑战、连接、预览、计划、Changes、导入与原操作重复。
- `stage-013`–`stage-019`：B 同样流程。
- `stage-020`–`stage-021`：两个 IDE 原生会话重新作为来源，向 Claude/Codex/OpenCode/Hermes/OpenClaw 公共预览；全文均保留，未执行这些目标导入。
- `stage-022`–`stage-027`：第一次 Runtime 与正常 Cursor 重启、显式恢复原绑定、两个原 UUID 打开与严格回读。
- `stage-028`–`stage-032`：第二次重启及同样核对。
- `stage-033`–`stage-038`：重启后再重复原操作、再次来源预览及每工作区唯一持久回执。
- `stage-039`：正常停止验收 Runtime；serve exit0，control socket 与临时挑战已移除。

两次 Cursor 正常退出均经实际窗口 `Quit Cursor?` 确认，并核对自有进程退出；个人 Cursor PID `83756` 未停止。最初为了切换到官方副本，只对参数及 socket 已确认的旧隔离 PID `36807` 发送 SIGTERM，退出已确认；当时尚无导入。启动排查曾因完整 ps 输出截断漏看该 PID，后以针对性 ps 和 socket owner 更正，记录在 `gui-access-recovery.json`，未删除仍在使用的锁。

## 命令与检查

```sh
cp -cR /Applications/Cursor.app /Users/user/.codex/tmp/cursor-native-app-1001/Cursor.app
codesign --verify --deep --strict /Users/user/.codex/tmp/cursor-native-app-1001/Cursor.app
/Users/user/.codex/tmp/cursor-native-app-1001/Cursor.app/Contents/Resources/app/bin/cursor --classic --new-window --user-data-dir /Users/user/.codex/tmp/cursor-bridge-1001 --extensions-dir /Users/user/.codex/tmp/cursor-bridge-ext-1001 --use-inmemory-secretstorage --sync off /Users/user/.codex/tmp/cursor-bridge-1001/workspace-a
# workspace-b 使用相同隔离参数。
python3 qa/probes/cursor-bridge-native-acceptance.py serve
python3 qa/probes/cursor-bridge-native-acceptance.py send --json '{"action":"status","workspace":"a"}'
# 后续 exact binding、preview / plan / changes / import / repeat / restart / reopen / source-preview 见各 stage command。
python3 qa/probes/cursor-bridge-native-acceptance.py send --json '{"action":"stop"}'
```

上述登录前阶段仅修改 QA harness 的固定官方副本身份校验，没有改生产实现。当时脚本 SHA256 `7e0d9a54a2fcd51534786d115031cca47a18d0a5faa712ff1a587b8622b641b9`；Python 语法检查、脱敏检查、七个身份负例、两个实际官方应用哈希/签名检查通过，独立子代理复核无明确缺陷。数据库范围、只读事务、完整内容比较和一次导入保护未削弱。登录后生产修复与新检查见下文；原全量 Rust/前端检查见 [收尾 QA](interop-closeout-2026-10-01.md)，不将旧检查冒充新增模型或可见界面通过。

## 后续分项

以下新增记录分别提升可见历史和反向恢复证据；五目标预览不等同于五个原生方向通过。不复制凭据、换模型或重试失败请求。

## 登录后真实回复与确定缺陷

`gui-window-{a,b}-visible-after-login.{txt,png}` 新证据证明两个普通 IDE 中完整正文真实可见；旧六张登录墙截图及旧 `audit.json` 保持原样。A 的 `live-a/dispatch-intent.json` 在按 Return 前持久化；提示本身没有随机标记及决策，要求仅根据导入历史回答，不使用工具。一次 GUI 发送终态后停止，无第二次发送、Auto 路由或模型切换。厂商内部网络重试不可观测，因此不能把一次 GUI 发送写成一次上游请求。

实际模型 `grok-4.7`，high / fast，Ask。回答为“历史中未包含完整随机标记。 历史中未包含项目存储决策及命名空间。”原目标 UUID、三条 turn 引用、全部八个 blob、五条历史正文未变；新增一问一答及思考步骤，工具步骤与 prompt tool-call 均为 0。`usageData` 为空，20040 / 256000 是上下文估计，不作为收费 token 用量。截图和终态见 `live-a/result-visible.*` / `outcome.json`，安全独立审计 `audit-postreply.json` SHA256 `53aab583aaa162548f0d3a81ef288136d1b08d576e16b193ecdd0ba8e187ccdc`。

固定官方 `3.22.12` schema 将 `ConversationStateStructure.field1` 定义为 `root_prompt_messages_json`，field8 为界面 turns；其 JSON blob hydration 独立读取前者。旧投影仅有 field8×3 和 field9，field1 数量为 0；回复后四个 prompt blob 中也没有导入的完整标记/决策。确定根因为目标转换遗漏模型提示历史，不仅依赖模型回答推断；没有服务端抓包证据，仍区分本地提示记录与实际服务端请求。

已在 `cursor_ide.rs` 让两种表示消费同一冻结、脱敏的正文投影；回读覆盖模型专属 blob、角色及完整正文，恢复拒绝丢失或调换模型历史。新增回归复现“界面完整但模型历史为空”、错误正文、模型 blob 缺失，以及连续角色/Unicode/换行。旧操作和旧载荷不自动重写，旧失败仍失败。此阶段尚未验证修复后的真实回复；后续新 B 单轮结果另列如下。

## 登录后空窗口记录与修复复核

首个修复后独立准备目录 `cursor-contextfix` / `harness-contextfix-1001` 在连接阶段停止，未执行计划、导入或模型。官方登录过程留下 `empty-state-draft` 及两个 UUID 空窗口记录；原读取器要求全部 header 都有 UUID 和文件夹 URI，使有效工作区的桥接也因列表不完整而拒绝。旧 11 个阶段和 Runtime SHA `e9ba243bdd4327a3ed6f70d80f7c7350f04b5d907d4a0442821d61542a126e18` 保留，不覆盖为最终修复结果。

生产读取器现在仅排除固定 `3.22.12` 官方 bundle 和隔离数据库共同核实的空窗口形状：已知 sentinel，或 canonical UUID 加 13 位空窗口 id；还需 header/index/composer 归属一致、v18、无正文/历史/图数据。真实工作区、未知 ID、损坏记录及索引漂移仍 fail closed。未删除或修改这些原生行。两个独立子代理复核模型投影及此空窗口修复；13 个 Cursor 测试通过，含 50 个空窗口负例。

最终 `cursor_ide.rs` SHA `0ca12f4ad598e91bd96bef27dd5b46117713e2747bb28fc71a447807eb632ff8`。`cargo fmt --all -- --check` 通过；最终 `cargo test --workspace` 为 45 个 suite、1038 passed、0 failed、9 ignored，原始输出为 `live-a/final-workspace-tests.log`。`cargo clippy --workspace --all-targets -- -D warnings` 和 `cargo build -p agentkib-runtime` 均 exit0；对应 `live-a/final-clippy.log` / `final-debug-build.log`。`pnpm format:check` 的 418 个文件通过。

修复后新准备目录为 `cursor-contextfix-v2` / `harness-contextfix-v2`；原冻结 debug Runtime SHA `c65b2640685f6a6fe4c2f5504af9a9279dc4b8eb5d34fbb3ec1375e58562124c`，准备时的源状态及命令日志 SHA 在 `source-and-checks.json`。该记录生成时 GUI 工具报告 Mac 锁定，尚未连接、导入或发送新模型请求；prepare 不计为原生或模型通过。解锁后的实际结果另列如下，不改写原记录。

QA harness 增加可选、全新 `--fixture-name`，禁止覆盖既有案例；完整 Unix socket 路径在任何目录创建前限制为 103 字节。独立审查实际确认超长 prepare 拒绝且不创建 root/evidence/fixture。最终脚本 SHA `b99e1dab25ce7f79ca0639a4c66669584e7459371edf210fb01d53b1948053a3`，固定官方应用签名/哈希、脱敏及名字负例 selftest 通过。新修复后实际导入使用全新操作和证据，旧失败不重跑。

## 修复后 B 的实际导入与同操作核对

用户解锁后，通过普通 workspace-b 窗口的第一方连接命令，取得新 binding `e8dd42b3-9f46-4e51-88a2-3ee62f99de3a`。公共 preview / plan / Changes 后仅执行一次原生导入，操作 `687ba192-eba5-4ef5-9aa5-56e06737c6e1`，计划 SHA `15bdca8a7026d84e8783031fbd94681aee4da487bc6d930a90a25f5ca1b06704`，唯一 Cursor UUID `47ee1557-d797-4ba1-a9e7-d03bf4f5ce72`。本例模型调用为 0。

这次发现额外序列化问题：旧投影在 root 中交错写 field1 / field8，官方 protobuf writer 按 descriptor 字段号分组，并保持每字段内部顺序。实际 13 个 blob、所有引用及正文逐字节相同，root SHA 从预览 `e85b0ab8b98949319a1e58ab0dba93ced49e524ef7a4e5579dc7a4a5b3c8d3d5` 变为 `5455d82e856b173ef95acb28c0ff07b78d421e2b378926182e6e25732ecbef0f`；stage006 / 007 保留原 `outcome-unknown`，不能说原字节回读通过。

转换器现在直接生成官方 1→8→9 顺序。对既有冻结计划只在内存中计算唯一已核实的 vendor 字节编码，再与 actual 原字节比较；不排序同字段引用、不去重、不改 URI、不归一化正文。未知字段、错误 wire / 引用长度、重复 workspace、非最短 varint 与正文/blob 修改均拒绝。Runtime 计划校验同样仅允许冻结 root 的这一分组差异；其余生成 payload、expected、原操作/计划哈希均不变。

原 manifest、二进制、计划及失败结果保持原样；显式 QA `serve --runtime-update target/debug/agentkib-runtime` 另冻 Runtime `51b94b9eb96aa1c7524331bc2a1d1fb4a56ff9fde03e4b66eba58890e10031f7`，身份记录在 exclusive `runtime-update-51b94b9e…json`。stage010 / 011 通过已有 operation 的公共入口只核对并打开原 UUID，未再次调用 importer。13 个 blob、五条全文/角色、来源 SHA、唯一身份及持久回执通过；五个反向公共预览完整，无新增目标导入。

独立 `cursor-model-context-audit.py` 从原合成 JSONL 派生安全提示加四条源消息，分别解析实际 field1 模型 JSON 与 field8 界面图，两条链都准确得到五条完整消息（user/user/assistant/user/assistant）。它不依赖生产 renderer 自证、不保存 system/private prompts 或整个 composer。`model-context-b-pending.json` SHA `dd557ab7faca48ee4dff93482a1e90f5c316682932110ca47de6c578e9bb675b` 明确区分 raw root 不相等与 vendor 重编码精确相等，不改变当时的待核对状态。

最终生产 `cursor_ide.rs` SHA `2fc4abde0de8015af2e9abbefdecddabdea7ea427ab1bcba61272083406ac376`、`native_import.rs` SHA `a6d605bbf807ba0366757493177b735b5ca334cb981e643d839d7d9848994928`。两个独立子代理实码复核无明确问题；15 个 Cursor 单测通过。追加全量 Rust 为 45 suites、1040 passed、0 failed、9 ignored，fmt / workspace all-targets Clippy / debug build 全部 exit0，原日志为 `cursor-contextfix-v2/vendor-order-final-*.log`。QA harness SHA `26692f828580c641b996cdec332c2b44df213ba6d4806b7ed520ffa90b10c15c` 的字段顺序及 10 个 root 负例、升级身份保存和已消费动作锁独立复核通过。

上述阶段的原生核对不等同于新窗口可见性、两次完整 Cursor 进程重启或真实回复通过。Mac 当时自动锁定，A 新案例尚未执行导入；后续解锁验收单独追加如下。本轮不改系统锁屏设置，旧 A 真实回复失败仍保留。

stage014 / 019 实际正常重启 Runtime 后，原绑定重新认证连接；stage017 / 018 / 021 / 022 按原 UUID 打开、重复原操作及完整回读通过，图/body/source/唯一身份不变。这里是两次 Runtime 重启，Cursor 进程没有退出。独立 `model-context-b-recovered.json`（SHA `1dc2e6be2430b308eff5e630eb0b78eb73c4390b160c9202b875602d7c84dd3b`）及 `model-context-b-recovered-receipts.json`（SHA `140be53667bbc6fc9feaadb5dc39f43fc4a58f132d9eb75c993f487dd7f7e3d5`）再次验证原计划字节/hash、已消费 attempt、原 UUID 回执和源字节不变。

验收等待解锁时正常停止 Runtime；随后实际验证 `serve --runtime-update` 能严格校验并复用既有独立冻结二进制/升级回执。stage025 仍只有原会话的 launched 回执；stage026 再次正常停止，serve exit0、control socket 删除。原 manifest SHA `bf80ee0c28edddc121367e639a8229280f50f72bc33d29ef1ca2e45f05f99407` 与升级回执 SHA `ed077575e107f9d5704a8164f72a29afb1a3eb89d10ff44028eb91fe2d35cfd6` 保持不变。新 QA resume 脚本 SHA `f67f72fa67022e41a599aa3d28f8e2d57dccd44a496a0543aed74bbbe8795300`；未留下验收 Runtime 常驻，未操作个人 Cursor。

最终 resume 分支亦由独立子代理复核：无明确问题，内存编译及一个复用正例、14 个缺失/身份漂移/socket 占用负例通过。旧 manifest/原冻结二进制 SHA、升级路径/哈希、标志及 immutable receipt 逐项核对；复用不得重新写 receipt/manifest/frozen 文件。后续解锁使用上述显式 resume 命令、原 B operation 和 UUID，不能再发 `import`。

## 再次解锁后的新 A 导入与客户端恢复

沿用上述 final debug Runtime，stage028–034 完成新 A 的独立连接、公共预览、计划、Changes 审查、一次导入和原操作重复。binding `5fcf307a-d9f6-456a-9afd-41089f1b6b21`，操作 `55fedfe0-b010-4c27-8f91-79addf62f01a`，计划 SHA `bdb06d822be5bf9da1e7a65ebf91e879befb59a01b2df78ba715e984853d53d9`；唯一原生 UUID `783272bb-80cf-4c5b-8560-60599dca6402`。本次直接使用官方字段顺序，实际 root SHA `988389ee4cb2836a48689e0f6f3a8a60caa8c03326a0e4976165e90eadcce216` 与冻结载荷原字节精确相等，全部 13 个 blob 精确；五条模型/界面历史、角色、Unicode 和换行独立核对通过。

`model-context-a-recovered.json` SHA `0eff6e4416eb079e5263b02b394c4bc62cf60a9223d92a31cbe8f1cde3b921c4`，`model-context-a-recovered-receipts.json` SHA `76f6812bdf58780a05931d363d9ae125e7c8d0a8806056aabf7b7ead48912067`。源文件 SHA `a38a16c3891c62765d3acfcec88ef273ad4c189f177a43b4f8fada5f28aaeae0` 未变；attempt 与持久回执绑定同一新 UUID，重复请求没有第二次导入。

`gui-{a,b}-visible.{txt,png}` 已实际显示修复后两例各自的操作标题和完整历史。新 A 首次打开时界面刷新晚于原生回执，后续实际画面显示正确的新标记 `AKIB-CURSOR-da5cb89907264a4fad`，没有把旧 A 的失败会话计入通过。

随后通过隔离 Cursor 的 `Quit Cursor?` 正常退出，核对自有旧 PID `44045` 消失、个人 Cursor PID `83756` 保留。stage035 正常重启 Runtime（新 PID `48891`），官方隔离 CLI 重新启动 Cursor（PID `49043`）及两个原工作区；A 恢复到了原操作标题和全部历史。B stage037–039 显式重连原 binding、按原 UUID 打开及完整只读核对通过，没有再次导入。

本阶段界面工具出现 `Sky Computer Use native pipe startup failed`、`noWindowsAvailable`、剪贴板超时，并出现 AX 状态与截图不同步。不能把后台回读或旧画面作为第二次客户端恢复、实际 Ask 模式或真实回复通过。已请用户将隔离 workspace-b 前台切到 Ask；新 A/B 均未发送模型请求。此阻塞属于验收界面工具，不据此推断产品模型链路失败；验收 Runtime 在等待时仍由本次 harness 管理，后续停止结果另记。

root 的逐项观察记录为 `gui-client-restart-1-observations.json` SHA `dbf4c6d33ed87583ad357438d6393a7daae2d68ea18dba61c7c6027750529520`。独立 `model-context-client-restart-1-receipts.json` SHA `c563ee7036182b6bd68548b09a2b47d51c3836829984f027ba2a292ebe437a8b` 及 A/B 同阶段图审计核对原 source / plan / attempt / verified-launched 回执、同 UUID、全 13 个 blob 与五条完整消息不变；明确 `GUI_verified=false`，不以数据证据替代窗口验收。stage040 新 B 的五目标公共预览通过，未写入任何目标；stage041 的 A binding 尚未重连，不能说两窗口桥接恢复都已完成。

系统只读状态查询确认 `IOConsoleLocked=false`、会话登录且位于 console；没有修改锁屏或安全设置。界面操作多次失败后，stage042 正常停止 Runtime，serve exit0，control socket 已移除、验收 Runtime PID `48891` 不存在；官方隔离 Cursor 保留，未触碰个人应用。可复用既有 `serve --runtime-update` 恢复核对及后续单轮，不能重新导入已消费操作。文档使用项目 `oxfmt` 验证；误用 `prettier` 的命令因项目无该工具失败，未安装新工具。

## 新 B 单轮真实回复与回复后恢复缺陷

用户继续验收后，实际 workspace-b 已显示 Ask / Grok 4.7 High Fast、原操作标题及完整历史。独立发送前报告 `model-context-b-independent-before-live.json` 确认原五条模型/界面消息、13 个 blob、无额外 turn。恢复既有冻结 Runtime 时，stage043 报原窗口未连接，原文保留；stage044 明确重新挑战原 B binding 后，stage045 公共 `sessions.launchHandoff` 按原 UUID 打开与严格初始回读通过。

`live-b/dispatch-intent.json` 在 Return 前以 exclusive / 0600 保存；提示不含标记和决策，只要求从导入历史回答，不使用工具。实际只发送一次，固定 Ask / Grok，2 秒完成；`live-b/result-visible.{txt,png}` 保存终态，思考保持折叠。独立核对实际原生回复全文为：

```text
AKIB-CURSOR-2f61aa1c2147498aa7
append-only SQLite WAL with namespace cobalt-lake
```

新 user 全文等于发送意图，新增一个 assistant、一个 thinking 步骤；工具步骤和 pending tool calls 均为 0。`usageData={}`；7246 / 256000 是上下文估计，不代表计费 token。只能证明一次 GUI 发送，无法观察厂商内部上游请求次数。没有自动重试、切换模型或再次导入。

首份 `live-b/independent-postreply-audit.json` 严格按原 model 引用判断为 false，SHA `fe66198e2c22328d09de6cb0e2fcc76b6e497f533c57fc4c0356f882b7529e8a`；未覆盖。独立追加 `independent-postreply-serialization-audit.json` SHA `d103bbda53f61dc5c04a69c3e6b78502cbda54ce9c3ddff480bf2ef9f00482af` 准确区分全文通过与原引用变化：官方仅重序列化两条历史 assistant JSON 的已知键顺序，正文、角色、值、顺序及全部 13 个原 blob 不变，原三条 UI turn 引用亦不变；来源 SHA `599c52356fccce33f115a789fb461d3ca6dccc0b95670578d73cacf117e00686` 精确不变。该次探针 SHA `4e4d357534464b4ae393541779834884f86b0109db872dc08d62aa702ea5a527`，两个正例、16 个负例通过；没有调用 Runtime / 模型或写数据库，也未输出私有提示或思考正文。独立审查随后指出它仍读取新增私有 model JSON、模型元数据未精确白名单投影及新提示匹配过宽，故旧报告不能作为收紧后读取边界的通过证据。新版改为仅核已知公开历史编码，三个新增 model 引用只查长度和计数，不读取正文；新问答全文与无工具结论限定为原生 UI graph，另行追加新报告。

stage046–047 恢复 A 原绑定并完整回读通过；同 Runtime 的 stage048 实际复现新 B 生产恢复拒绝 `Cursor IDE recovered model history differs from preview`，不是旧 QA 严格 root matcher 的误报。生产恢复此前要求旧 model 引用为子序列，对官方键重排后的等值 JSON 过于严格。此明确缺陷仅修固定版本的已核实编码边界，不忽略正文差异或重发模型。

随后第二次通过 `Quit Cursor?` 正常退出隔离 Cursor，自有 PID `49043` 消失、个人 PID `83756` 留存；stage049 正常停止 Runtime。官方隔离启动参数不变，重新启动 Cursor PID `77493` 及 A/B 原工作区；`gui-client-restart-2-{a,b}-before-bridge.{txt,png}` 实际显示 A 原完整历史及 B 原历史和同一次回复，没有新增发送。此处先验证 Cursor 自身恢复，生产原操作的修复后打开另行核对。`live-b/outcome-before-recovery-fix.json` SHA `33b8c8c4e5b2ab4d6277ce7b29f926eea9027f4605062baea758bbdb2e24ea5e` 保留修前结论。

QA harness 增加仅用于此后续阶段的 `reopen-existing`：仍调用已有公共 `sessions.launchHandoff`，明确 `full_readback_performed=false`，需要独立回复后图审计和实际界面核对。原 `reopen` / `readback` 的严格初始全文、root、blob 和回执比较没有削弱，不把合法新增问答说成初始图原字节不变。

生产最小修复仅在固定 `3.22.12` 恢复分支接受已核实的 assistant compact JSON 键顺序；旧生成原字节、对应 alternate SHA/字节、全部原 blob、正文、角色、顺序与重复计数仍严格校验，不采用一般 JSON 等值比较。生产 `cursor_ide.rs` SHA `ebe5b34cca53e321923252bbf1bd82a512d06316f03bc4ffabfd48078c73b56c`。独立子代理实码审查未发现明确问题；17 个定向测试和 workspace 45 suites / 1042 passed / 0 failed / 9 ignored 通过，`cargo fmt --all -- --check`、workspace all-targets Clippy `-D warnings`、debug build 均 exit0。实际日志为 `postreply-final-{workspace-tests,fmt,clippy,build}.log`。

新验收 Runtime SHA `5d18e7fc36a4e0a6eb3766e28b4ca27e8914dfd7febf4bc6ee2d80bd04c46abc`，显式升级回执 SHA `92f723b6fe42334fecee5455e5b6f123d712536ad0c6bffa9a072d186d3e1f4f`，原 manifest、冻结二进制、计划与已消费动作保留。harness SHA `25bacea881a7a3834f690d11042c1272781f33ed96bd88cf083d4186731e98d3`；独立纯 fake Runtime 2 正 5 负核对 `reopen-existing` 只调用唯一原 launch RPC、状态不变、无 importer/model；旧 `reopen` 仍执行严格回读。新 Runtime 已启动，界面工具返回 Mac 锁定，已请求解锁；修后原操作恢复仍待实际验收。

收紧后的 QA 探针 SHA `c24a54bcfcda9a76a164984c19ed9de29c225dc8adf032148496e49e3a80bedf`，5 正 33 负 selftest 通过，独立审查复核 helper hash 在执行前校验、原生成 compact UTF-8 限定、SQLite 类型/字节预算及 root 前缀拒绝。新版实际只读 `live-b/independent-before-reopen-hardened-audit.json` SHA `0c90113e9dbc644832d7bb55b60569e18837b712e1ed0e99cdd774f79db751ea` 通过：原五条模型/界面正文与角色、13 blob、源/计划/原 UUID 均核对；新增精确 user 和完整 assistant 回复形成七条 UI 消息，无 UI 工具步骤与 pending 调用。三个新增模型上下文只查存在/长度、不读取正文、不重新计算其内容哈希，也不将其模型 JSON 全文或工具字段宣称已验收。stage050 公共原生操作列表仍唯一返回原 B operation 与 UUID、`launched`；没有导入、打开或模型派发。

独立回执/输入保护报告 `live-b/independent-stage050-receipts-inputs-audit.json` SHA `54644bece31e56b96796e1ba9a491fed25c0c7d4ef2262940292909155d62d79` 再核 18 项保护输入、原 manifest / binary、A/B source / plan / attempt / receipt、两原生 ID 与标题唯一，以及 stage050 原身份和 `launched`。该列表回执不代替实际 reopen 或 GUI。因 Mac 锁定尚无解锁答复，stage051 正常停止自有验收 Runtime，serve exit0；保留隔离 Cursor 和原数据，后续只用 final `--runtime-update` 恢复既有 operation，不重新导入或发送模型。待完成项是修后原 UUID 产品打开/选中、同次问答恢复及七条历史再次作为来源的五目标公共预览。

## Cursor IDE→Claude 原生反向恢复

使用 B 的实际 IDE 来源 `73e12ebf6c2b0abc30ac7943f7f04940543fe6ae3dd2f7c1642ff17a7ff1a480`，原 Cursor UUID `3e172a62-6cd8-4bff-818a-34f185c4d871`。公共预览、计划和显式审查后只执行一次 `changes.apply`；新增独立 Claude UUID `b45fcc17-078f-45d0-afb9-fae8d1f112f5`，一个 JSONL，六条消息（新安全提示及全部五条来源消息），没有启动用户 Terminal、模型、工具或复制授权。

首个 TUI matcher 因官方 Markdown 展示移去 `SELECT 1;` 两个反引号而原始 false，立即停止且保留 `reverse-claude/result.json`，未执行原计划第二次启动。新 `cursor-ide-claude-native-recovery.py` / `reverse-claude-recovery` 只允许固定第5条 user 这一处展示样式差异；源图、角色、UTF-8、换行、原生文件字节和正文仍精确一致。旧 ANSI 逐终端格重放及十份旧证据 SHA 均复核不变。

对已创建原 UUID 两次独立 OS 禁网 TUI 恢复通过，完整六条历史可见，输入列表为空，未再次 apply、创建会话或调用模型。目标全文件 SHA `a6452c68faadafd3eb26838a79e3bc53eabeb0cc7fbb5f76a7e091eb68da1557` 未变；B 完整源图/events/公共 fingerprint 前后相同。监督清理确认两个自有进程组消失；原生子进程清理退出为 -9，不声称自然 exit0。新 runner 和 Runtime shutdown exit0，独立审计通过，`reverse-claude-recovery/result.json` SHA `fae924cdfe7288aa7d9e89e8e11ee58378b4481ec8880972e03ebdf265af50e4`。
