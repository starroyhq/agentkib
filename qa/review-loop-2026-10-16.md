# origin/main 审查修复闭环与回归记录

## 源码与验证身份

- 审查基线：`origin/main @ efb7904e3ce369929708f81d02f3d0b21150d9e5`，本轮开始时重新获取并固定；merge-base 相同。
- 本地：`main @ bfde761ead3ade80fca4ebcaa58e68b2cb99b0ef`，dirty。审查包含基线之后的 26 个提交及当前已完成的 tracked、dirty 和新增文件，Skills 已纳入。
- 提交比较命令：`git diff efb7904e3ce369929708f81d02f3d0b21150d9e5...bfde761ead3ade80fca4ebcaa58e68b2cb99b0ef`；另外保存 merge-base 到当前工作区的完整差异和新增文件差异。
- 本次闭环相对开始时的源码快照修改 55 个文件，另新增本文。保留此前业务改动、`.agents/`、`prototypes/`，未提交、推送、部署或发布，未修改生产依赖、用户 Agent 配置或已安装应用。
- 验证环境：macOS arm64，Node `22.23.3`、pnpm `12.10.1`；使用锁文件离线安装。
- 最终代码快照：`/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/agentkib-loop-review-20261016-ppwjsjt_/source`。安装、测试和构建均在副本运行；构建后核对 1,370 个源码文件，副本和主目录均与冻结 SHA256 一致。

## 已修复的问题

| 问题                                                      | 修复与可观察结果                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Skills 库事务补偿后继续重放同一操作，错误回执隐藏恢复入口 | 识别已恢复的库事务，返回稳定的终态 `recovered`；重复请求不重放，重新预览可创建新操作                              |
| 删除或损坏 `SKILL.md` 后不能解除管理                      | detach 使用完整目录哈希和归属身份检查，不要求仍为有效 Skill；不删除或重写保留的原生文件                           |
| 纳入原生位置时不能显式关联已有库                          | 提供新建独立库或选择稳定库 ID 的入口，内容不同时明确选择库／安装版本                                              |
| 单边变化和有效但未接受的库修改缺少手动处理入口            | 提供明确的覆盖或接受版本选择；修改选择会失效旧预览和 Home 确认；危险、未知状态仍禁用                              |
| 通用私钥脱敏升级后，其他 Agent 的旧搜索缓存仍可见         | 共享 sanitizer 版本进入全部来源指纹和缓存元数据；只读 Worker 拒绝旧缓存，写 Worker 清理派生内容后重建，旧定位失效 |
| Claude 会话探针把目录读取失败当作没有历史                 | 只有首次发现根目录真正不存在才认定新安装；枚举、stat、已知目录／文件消失均拒绝原生导入，不跟随软链接              |
| Claude 全局 projects 超过 10,000 项时丢失当前项目设置     | 在原有 1 MiB 文件预算内准确查找当前项目，保留 local MCP、停用与信任状态，不读取其他项目配置                       |
| 长 `claudeMdExcludes` 被静默丢弃                          | 保留非空字符串，由现有共享计算预算限制求值；超预算明确警告，未确定来源不伪装成已排除                              |
| 长 paths 条件被丢弃，条件规则误作启动上下文               | 保留文件读取预算内的完整非空条件；仅展示层限制条目数量，不把条件规则正文无条件加入上下文                          |
| Windows 已解析仓库根目录后仍只读 cwd 设置                 | 统一仓库根目录、工作树和 cwd 回退优先级，保留 Home 安全边界                                                       |
| 纳入已有库并选安装版本时，零差异预览掩盖库覆盖            | 该分支预览库旧版本 → 安装版本，支持查看库旧正文；选库版本仍预览安装旧版本 → 库版本；四语说明指出修改方向和库 ID   |

相邻回归也已修复：同步面板改用项目 Select 组件；完成 detach 的非活动回执不再错误保留旧流程的文件管理权，未完成操作的保留记录仍受保护。

后续独立审查还修复了两项边界：

- 旧 ChangeSet 只锁来源工作区，实际 Home／应用数据目标与 Skill 部署可能并行写入。现按实际目标及 Skill 来源统一解析物理 scope、祖先项目和关联库，按路径顺序批量加锁，锁内重新核对，遇新增锁根拒绝执行；不再要求无关来源项目可写。部署、同步和恢复复用相同规则，首次创建 scope 之前保护最近现存祖先，恢复 journal 在等待期间换绑也会拒绝。释放失败保留原始错误并继续释放其他锁。
- Claude 全局配置位置或内容未确认时，仍把未知的信任、停用或 local 覆盖当作有效／不存在的证据。现保留独立 settings 批准和 managed 策略事实，对项目／插件明确标注加载未验证，不据此判断端点替代；覆盖路径歧义、读取失败、损坏、超限、空白和非对象，确认 ENOENT 仍为正常缺省。四语言批准文案不再宣称实际加载。

再一轮独立审查修复了两项 Claude settings 问题：

- hook 命令中的参数名、header、assignment 或 URL 使用合法 shell 字面量拼接／转义／续行时，原有按原始文本匹配会漏出短凭据。复用既有字面量单词遍历，对完整敏感值脱敏；动态或不完整凭据保守隐藏余串，不解释任意动态 shell 或编码。安全参数和正常命令保留，按起点应用替换而不反复排序扫描。
- `enabledPlugins` 每层先取 256 项，会丢失高优先级第 257 项关闭值，使低层启用继续生效。现在在原有每文件读取预算内完整合并布尔开关，插件发现与界面展示预算独立保留。

最后一轮已确认的恢复与性能问题也已修复：

- 接受安装内容／分叉流程在库已提交、部署预留尚未落盘时失败，旧状态允许新的 push／detach 改变目标，导致原操作永久不能恢复。现在正式修改库之前先建立共享预留，旧 journal-only 状态也阻止冲突写入；列表和通用恢复入口显示同一待恢复状态，调用真正的同步恢复流程，继续返回既有部署结果结构。按事务证据保护实际依赖的库，其他不冲突目标仍可更新。
- 补偿完成后释放预留失败，保留稳定的已恢复结果；再次恢复只清理占用，不重放库或目标操作。journal 的创建在锁内受保护，包含 rename 已完成而后续同步失败的情况，损坏 journal 明确拒绝。
- 旧写入流程创建的持久 lease 文件曾可能落入 Skill 包，改变目录哈希并破坏重新纳管。现在先拒绝受管理目标，锁内仍重复核对，并将缺省锁位置移到最外层 Skill 包之外；detach → 旧写入 → 重新纳管回归保持包内字节一致。
- 完整插件开关映射与 65,000 项安装记录求交时，数组逐项查找退化为乘积开销。改用 Set 查询，保留现有每文件预算及发现数量门限。新增真实 Backend 一秒响应看门狗，检查 Context／MCP 与同时发起的普通查询。

R16 独立 Spec 另复现了一个 P1：空格、Unicode 和前导点原生目录会显示可纳管，但生产者写出的同步 journal 被消费者的 ASCII ID 规则拒绝，阻断整个库的读取与恢复。现在合法单目录名与库 ID 分开校验，纳管及已有部署保持原目录名，新的库 ID 仍使用既有规则；部署预览、回执与两种 journal 使用一致合同，写首份 journal 之前先完成自校验。仍拒绝分隔符、父级、控制字符、drive 前缀及目标不匹配，不放宽直接子目录、归属和外部变化保护。

R17 独立审查还确认了三项 P2：旧备份缺入口却被强制建立合法快照，阻止正常回滚后的更新；完整 Context 遗漏共享目录针对 Hermes 等 Agent 的限制证据；受限 MCP Context 把目录存在误报为原生可见，遗漏 OpenCode 项目明确 deny。修复结果如下：

- 历史归档先复用已验证 CAS；健康 legacy v1 缺 CAS 时保留有界首次归档。缺入口／明确结构损坏不再强制成为合法快照，由物理目录和事务补偿保留；真实 I/O、归档中变化和损坏 CAS 仍报错。原生回滚目标与新候选等必需快照继续完整验证。
- 完整 Context 使用已有库存的目标 Agent 诊断，处理 Hermes 配置／信任／Git 根和 OpenClaw 多 Agent allowlist；不把共享目录的公共状态当成各 Agent 都可用。
- 受限请求不新增配置读取，不增加第二套权限解析器；对依赖个人配置的 Codex、OpenCode、OpenClaw、Hermes、Grok 候选省略并明确未验证。Cursor、Claude、Antigravity 的既有项目目录发现保留，legacy manifest 声明独立。补充文档解释这一隐私覆盖门限。

R18 两轴均确认一个 UI P2：持久 personal follow 在同一弹窗切 manual／pinned 再切回 follow 会丢草稿授权，却隐藏确认入口，后端拒绝保存。现仅复用同 owner／target 的持久授权，临时 Home 确认绑定当次待授权目标集合与 revision；集合或身份变化即失效。重新明确确认时，仅将这些 pending personal follow 项绑定到当前身份，未确认和 manual／pinned 项不自动重绑。真实 Backend 保存已覆盖，既有服务端授权校验没有改动。

同轮组合核查确认：description-only 特殊目录虽可预览，却把 fallback 显示名当成 canonical 库 ID 校验，纳管／复制失败；复制到安全 ID 目录后再 fork 也会丢显示名。现显示名与库 ID 分离，原文档字节保留，ID 碰撞后仍不超 64；fork 优先使用可信回执显示名。缺 name 与显式 null／非法值区分，manager 的 can_adopt 与预览写前校验一致，原 64 UTF-8 字节元数据门限与 GitHub 验证不放宽。

R19 两轴确认同一个来源兼容 P2：自动检查把缺少 `ref_type` 的 URL tag／SHA 和旧记录强制解析为 branch，产生 404／退避或查错同名分支。现仅将后台 `#commit` 的类型参数改为 `source.ref_type`，与手动检查一致；显式 tag／commit 仍固定，显式 branch 仍限定 heads，不迁移旧来源记录。中英文说明同步。

## 测试覆盖

本次新增并加强以下回归测试，包含真实 Backend 与共享 UI 边界，未调用真实模型：

- Skills 恢复／detach 15 项、原生保留文件重新进入旧流程 2 项、UI 17 项、真实 Backend + UI 集成 8 项。
- sanitizer 缓存升级 18 项，覆盖八种 Agent、只读／写入启动顺序、真实 Codex 重建与旧定位拒绝、查询 Worker 先启动。
- Claude 原生探针 16 项、超 10,000 项 projects 的真实 MCP 扫描 1 项。
- 长排除条件 5 项、完整 paths 条件 3 项、虚拟 Windows IO／Git／worktree 布局 6 项；已有真实 Runtime + MCP 测试继续要求 1 秒内响应。
- 采用已有库的两种版本选择 2 项，检查新增／修改／删除资源、预览双方正文及最终字节；两个既有真实 UI 集成用例也在确认前检查这些差异。

另新增实际目标锁 18 项与 MCP 全局证据 16 项回归，覆盖真实锁竞争、缺失 scope 创建、归属新增／换绑、统一锁序与释放，以及未知配置下的批准、加载、插件去重和 managed 独立证据。

另新增 shell 字面量脱敏 49 项和插件优先级 6 项，包含真实 Context／MCP 输出、完整参数与安全文字保留。重建 Backend 后相关 13 文件、498 项通过，真实 Backend 的一秒看门狗、长近匹配、marker 和复杂包装回归同样通过。

另新增恢复预留 22 项和大插件目录响应 1 项：覆盖首次纳入无回执、库先提交失败、journal-only 兼容、通用恢复入口、目标及库冲突、无关目标允许更新、损坏 journal、lease 位置、补偿完成而释放失败后的稳定恢复。性能用例的旧实现先触发一秒看门狗，修复后单测通过；完整检查另列下表。

目录名修复新增 19 项测试，覆盖三类名字各自的纳管、重启、更新、回滚、缺失后恢复、撤销、故障恢复，以及恶意／不一致回执、越界 journal、非法新库 ID 和不支持名字不落盘。修前 6 个正例全部失败，修后 19 项及 6 个旧 suite 的 79 项通过。

另新增损坏历史归档 20 项，以及 Context／MCP 原生可见性 28 项。前者包含缺入口回滚后的第三版 pull、更新／版本切换、卸载／trash／恢复、六处提交失败补偿及重试、schema1 删除 CAS 后迁移、已有 CAS 时 obsolete 资源零读取、CAS 损坏与 I/O 严格拒绝；最终相关 5 文件 157 项通过。后者包含 Hermes/OpenClaw 限制及允许分支、受限项目显式 deny、Home 与 alias 隐私、manifest 声明独立、复杂策略不求值，以及真实 Backend／MCP／普通查询的一秒并发看门狗；新增 28 项通过。

UI 授权另新增／加强模式往返、多目标、撤销临时选择、身份变化失效、明确重新确认绑定新身份等回归；两个真实组件／Backend 测试文件最终 34 项通过，UI 约束 2 项通过。description-only 组合新增 24 项，native directory suite 共 43 项；覆盖复制／纳管／分叉／部署／重启／移除恢复、显示名与字节、64 字节碰撞、显式非法元数据和 GitHub 缺名拒绝；最终关联 6 文件 204 项通过。

后台缺省引用类型新增 8 项，包含 URL tag／SHA、schema1 旧分支、generic tag 与同名 branch 两种误报方向、显式 branch／tag／commit 控制；验证默认调度、持久检查回执、到期节流及原锁／来源／包字节不变。修前 5 红／3 绿，修后 8 项通过；相关定向 18 项通过，90 项按名称过滤未执行，未把它们计为通过，完整执行结果见最终表。

POSIX 权限和软链接测试仅在适用平台执行；Windows 路径测试使用受控 IO，不冒充 Windows 实机验收。本机完整套件的跳过数仍为 2。

## 最终实际命令与结果

命令通过以下 PATH 使用已准备的固定工具链：

```sh
export PATH=/Users/user/.codex/tmp/agentkib-quota-tools-20261009:/Users/user/.codex/tmp/node-v22.23.3-darwin-arm64/bin:$PATH
```

以下命令在最终快照中按顺序执行，整体 exit 0；测试与构建没有并行修改同一输出目录：

| 命令                                                                                                                                                                                             | 结果                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `pnpm install --offline --frozen-lockfile`                                                                                                                                                       | 通过                                                                                                           |
| `pnpm --filter @agentkib/desktop protocol:generate`                                                                                                                                              | 通过                                                                                                           |
| `pnpm format:check`                                                                                                                                                                              | 830 文件通过                                                                                                   |
| 本轮 `loop-files.json` 中 55 文件显式 `oxfmt --check`                                                                                                                                            | 通过                                                                                                           |
| `pnpm lint`                                                                                                                                                                                      | 通过，无错误；仍有 React/compiler 等非阻断警告，不宣称零警告                                                   |
| `pnpm typecheck`                                                                                                                                                                                 | Backend、桌面、Web 通过                                                                                        |
| `pnpm test`                                                                                                                                                                                      | 桌面 288 文件、5,450 项通过、2 项跳过；Web 37 文件、765 项通过                                                 |
| `pnpm build`                                                                                                                                                                                     | 桌面、Electron、Backend 及随附 Web 构建通过                                                                    |
| `pnpm build:web:hosted`                                                                                                                                                                          | 通过                                                                                                           |
| `env -u ELECTRON_RUN_AS_NODE /Users/user/Documents/data/agentkib/apps/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron apps/desktop/scripts/verify-backend-workers.cjs` | Electron `44.0.0`／Node `24.18.1` 下三项 PASS：FTS5 索引／查询 Worker、持久 Skills Worker、Handoff 只读 Worker |
| `pnpm exec oxfmt --check qa/review-loop-2026-10-16.md`                                                                                                                                           | 通过（报告另行格式化检查）                                                                                     |
| `git diff --check`                                                                                                                                                                               | 通过                                                                                                           |
| 冻结源码 SHA256 核对                                                                                                                                                                             | 1,370 文件、副本及主目录全部一致                                                                               |

Electron smoke 输出一次 macOS `sandbox_extension_issue_file_to_process` 警告，但三项实际协议断言均 PASS、进程 exit 0。该测试不启动已安装 AgentKib、不使用个人钥匙串或模型授权。

### 保留的失败证据与修正

- R19 快照本身的 5,442 项桌面、765 项 Web、两种构建和 Worker 检查通过；最后的主目录一致性校验准确发现下一轮修复已经修改 `vite.config.ts` 和中英文文档，命令链因此 exit 1。没有把旧快照通过冒充当前工作区通过；最终重新冻结源码、独占串行验证并再次核对。

- Context 相关组合检查出现过 154 项通过、1 项既有 nested-negation 一秒看门狗超时；保留原日志与阈值。未改变源码或断言后单独复跑该文件，3 项通过（总 3.08 秒），这只是独立通过证据，不把首次失败直接归因环境或忽略。最终在独占快照串行完整重跑的结果见上表。日志 `/tmp/agentkib-r17-context-skills-suite.log`、`/tmp/agentkib-r17-context-skills-runtime-isolated.log`。

- R17 完整桌面测试出现 1 项失败、5,356 项通过、2 项跳过，后续 Web／构建按 `set -e` 停止。原因是锁后改绑测试只修改 journal 的目标路径，未同步新合同要求的 `package_name`，从而被 schema 更早拒绝。已同步攻击夹具的名字，继续要求在锁后身份检查拒绝，并保持目标不写、预留不变的断言；原 18 项测试通过，日志 `/tmp/agentkib-r17-target-rebind-fixture.log`。完整重跑另列最终结果。

- 初次全量测试中，深目录 Context 读取与大量文件测试并行竞争，`claude-context-memory` 的原有 5 秒断言超时。将该文件和事务密集的 Skills 文件纳入独立顺序 `filesystem` Vitest 项目；保持测试断言与超时不变，现有 1 秒 MCP 组继续独立运行。最终全套通过。
- 一次验证错误地同时启动测试与构建，构建重置 `dist-electron/native` 导致四项 native-send 测试 ENOENT。这是本轮命令编排错误。原始失败日志保留；此后全部检查严格串行，前一快照与最终快照均完整通过，没有通过吞错或削弱测试处理。
- 采用已有库的预览问题保留了独立后端及 UI 先红后绿日志；修复后 3 文件 38 项针对性检查与最终全量检查通过。

- 后续显式检查本轮全部文件时，发现项目默认 format 范围未覆盖的两份修改文档有格式问题，已格式化；最终额外检查全部 55 个修改文件。
- 一次后续构建在下载固定 frpc 归档时 `fetch failed`（`agentkib-loop-review-20261016-0i28gsh_/build.log`）。复用前一已验证快照的相同归档，SHA256 为 `9f344774971dfb9ae90ee1f633de68d1755c98510227a67289ec78081fc5c8fa`，放入新快照缓存；仍由原 staging 脚本重新校验，不绕过构建校验或更换版本。

## 独立审查

按 `code-review` 技能分别启动全新上下文的 Standards／Spec 子代理，固定比较基线，包含全部已完成改动。Standards 依据项目工程与安全文档及十二项 smell 启发；Spec 依据 Skills、Claude、MCP、互通、内容搜索及远程功能说明。疑点先核实，未将纯命名偏好或历史 QA 当作 finding。

前几轮分别发现脱敏缓存失效、Claude 读取与设置边界、采用预览方向、实际目标锁与 MCP 生效证据、同步失败占用保护，以及正常原生目录名破坏库状态等问题；每轮修复并补测后冻结新快照，再启动独立子代理。最终独立复核：`/root/loop_r20_standards` 为 **0 finding**（硬违规 0，有实际影响的 smell 0）；`/root/loop_r20_spec` 为 **0 finding**。两轴均为全新上下文、只读静态审查，不以历史 QA 的通过结论代替当前判断；当前动态结果由主代理单独运行并记录。

## 证据位置与验证边界

- 最终快照上层保存 `identity.json`、`commits.txt`、`committed.diff`、`tracked-current.diff`、`untracked.diff`、`changed.txt`，以及本次 55 文件增量 `loop-files.json`、`loop-fixes.patch`、`source-match.json`。
- 同目录的 `review-standards.txt`、`review-spec.txt` 保存最终独立轴结论；`artifact-hashes.json` 保存桌面／Backend／hosted 入口五个构建产物的 SHA256。
- 同目录的 `install.log`、`protocol.log`、`format.log`、`loop-format.log`、`lint.log`、`typecheck.log`、`test.log`、`build.log`、`hosted.log`、`electron-worker.log` 是最终实际日志。
- 深目录超时：`/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/agentkib-fix-r10-20261016-37egst25/test.log`。
- 并行构建导致的 ENOENT：`/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/agentkib-loop-review-20261016-0g3dg987/test.log`。
- 采用预览的先红后绿：`/tmp/agentkib-adopt-delta-red.log`、`/tmp/agentkib-adopt-delta-ui-red.log`、`/tmp/agentkib-adopt-delta-all-green.log`。

shell／插件修复的命令与原始日志见 `/tmp/agentkib-r14-settings-commands.txt` 及同前缀 `-red.log`、`-build.log`、`-suite-final.log`、`-typecheck-final.log`、`-format-final.log`。

目标锁新增回归的先红后绿原始输出仅保留于子代理工具回执，未重定向为磁盘日志：初版红 `560997`、绿 `74fe9d`，缺失 scope 故障注入 `33e274`，相关 195 项 `4ff9e8`、最终 57 项 `b6e3a5`。这些标识不是文件路径；最终全量日志覆盖修复后的全部测试。MCP 全局证据的命令与原始日志另见 `/tmp/agentkib-r13-mcp-gate-v3-verification.txt` 与同前缀 `-red.log`、`-green.log`、`-related.log`。

恢复预留的实际红／绿／关联验证见 `/tmp/agentkib-r15-sync-gate-red.log`、`-green-initial.log`、`-green-expanded.log`、`-green-final.log`、`-related-final.log`、`-typecheck.log`、`-format-check.log`（同一前缀）。插件性能的实际命令与输出见 `/tmp/agentkib-r15-plugin-perf-commands.txt` 及同一前缀日志。

目录名 P1 的独立无故障注入复现为 `/tmp/agentkib-r16-spec-adopt-name.mjs` 与同前缀 `.log`。修复的实际红／绿与关联验证为 `/tmp/agentkib-r16-native-names-{red,green-initial,green,related,typecheck,format,format-check}.log`（花括号表示各独立文件）。

损坏备份回归的实际红／绿／最终关联检查见 `/tmp/agentkib-r17-damaged-backup-red.log`、`-green.log`、`-final-new.log`、`-final-related.log`、`-typecheck.log`、`-format-check.log`（同一前缀）。Context 的命令与日志索引为 `/tmp/agentkib-r17-context-skills-commands.txt`，包括初始 15 红／4 绿、最终新增 28 项及真实 Backend 的证据。

UI 授权的红／绿日志见 `/tmp/agentkib-r18-policy-ui-red.log`、`/tmp/agentkib-r18-policy-backend-red.log`、`/tmp/agentkib-r18-policy-green.log`、`/tmp/agentkib-r18-policy-identity-red.log`、`/tmp/agentkib-r18-policy-identity-green.log`、`/tmp/agentkib-r18-policy-identity-renewed-green.log`。description-only 的实际红／绿与最终关联为 `/tmp/agentkib-r18-description-only-red.log`、`-green.log`、`-final-related.log`、`-typecheck.log`、`-format-check.log`（同一前缀）。

缺省引用检查的实际红／绿／关联日志为 `/tmp/agentkib-r19-legacy-ref-red.log`、`-green.log`、`-related.log`、`-typecheck.log`、`-format-check.log`（同一前缀）。

本轮完成源码、合成行为及 macOS Electron Worker 验证；没有执行真实模型、实体 Windows/Linux、手机、签名安装包或公网部署验收，不据此提升相应能力等级。临时证据目录可能被系统清理，本文是结果摘要，不替代完整原始日志。
