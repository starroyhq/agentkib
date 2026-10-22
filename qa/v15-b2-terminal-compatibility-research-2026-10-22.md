# v15 B2：连接终端版本兼容调研（2026-10-22）

## 范围与当前决定

以下为 B 合入前完成的调研阶段记录，保留当时的基线与限制。B 合入后的实施、最新 CLI 2.1.308、最终检查及未覆盖项见 [B2 实施与验证](v15-b2-terminal-compatibility-2026-10-22.md)。

- 设计交接要求先调研、记录证据，再修改兼容逻辑。用户本轮明确选择：**先完成 B2 调研，待 B 合入 main 后实施**。
- 调研基线为最新 main `9ca76bf11c46090b6a832e1ad141e7e4d11a1745`，研究分支 `codex/v15-b2-terminal-compatibility`。B 的 PR #141 尚未合入；其 `ca67da7c7abff471c961eda82a0b591d47bd6e52` 与本基线的插件、私有协议及后端桥接源码相同。
- 本轮只新增本记录，不修改生产代码、四语文案、设计文件或依赖声明/锁文件，不提交、推送或合并。后续实施须重新读取已合入 B 的最新 main，保留 B 的界面补充及审查修复。
- 不修改跨 Agent 继续、`handoff.*`、Codex follower、C/D，也不放宽锁、原生指纹、权限、会话匹配、连接码、凭据或发送保护。

## 初步结论

1. **没有发现“2.1.307 已知与只读同步不兼容”的证据。** 两版官方 CLI 均能静态验证当前插件，原有官方插件测试也通过；但这些测试含固定版本的模拟对象，不能据此宣布 2.1.307 已完成真实连接验收。
2. **精确锁版是验证范围，而不是已证实的跨版本破坏。** 首次接入只验证了 2.1.301 的本机声明与原生行为。发送排队及停止回执风险不能直接推导为只读同步必须永久锁在该版本。
3. 不能仅删除版本相等判断。身份、凭据、后端 schema、重连和公开状态都重复写入固定版本；已有 `capabilities` 也不是 Mods API 可用性报告。
4. 暂未找到能替代 CLI 版本的独立 Mods API 合约版本。`$.session.version()` 返回引擎版本/基础版本/构建时间，不是 API 版本。需要采用最低 CLI 版本、明确的插件/私有协议合约、成功的只读能力探测及已验证版本清单，且仍需区分静态检查与真实同步证据。
5. 现有证据支持继续验证“最低版本 + 能力检测”的方向，**尚不足以宣布所有未来版本兼容**，也没有足够证据触发设计中“接口经常破坏、改走 AgentKib 启动终端”的备选方案。本轮不改方案、不开放新能力。

## 接口清单

下表来自 `packages/claude-bridge-plugin/hooks/register.js`，不是从网页推断的接口集合。

| Host 调用                  | 实际依赖                                                                | 只读兼容中的作用                                                 |
| -------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `$.session.id()` / `cwd()` | UUID、绝对工作目录                                                      | 必需；身份改变立即失效，不能降级为猜测                           |
| `$.session.version()`      | 当前代码读取 `.version`                                                 | 必需；后续应保留真实观测值，不伪报最低版本                       |
| `$.session.messages()`     | `role/text`，`toolUses` 的 `tool_use_id/tool/input/text/isError/result` | 当前快照预览必需；不是完整历史来源                               |
| `$.session.usage()`        | `context.tokens/window/percent`                                         | 语义上可降级，但当前失败会使整个 snapshot 失败，不能声称已有降级 |
| `$.http.fetch()`           | 本地 UDS 的 POST、headers/body；返回 `ok/status/text`                   | 必需；不能替换为公网或放宽路径检查                               |
| `$.command.register()`     | `name/description/immediate/argumentHint`                               | 连接与状态命令注册                                               |
| `$.clock.every()`          | 250ms 回调                                                              | 事件提交、心跳与命令轮询                                         |
| `$.store.get()` / `set()`  | 只保存凭据文件路径                                                      | 自动重连；不存 token 本身                                        |
| `$.fs.read()`              | 后端给出的私有凭据文件                                                  | 重连；不读取个人 CLI 登录配置                                    |
| `$.turn.abort()`           | 精确 `turnId`                                                           | 仅内部停止实现；不能用作无副作用能力探针，不开启界面停止         |
| `$.prompt.submit()`        | `text/asUser`、返回 `drop/text` 及轮次关联                              | 仅发送实验；生产常量保持关闭                                     |

共 **13 种 host 调用**。另依赖 `crypto.randomUUID`、`TextEncoder.encode`、严格 UTF-8 `TextDecoder`、`atob`、Map 及异步生成器转发；不能把这些 JS 运行时能力遗漏于探测范围。

| 事件                        | 插件读取的关键字段与语义                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `session.start`             | 注册命令、计时器、重连，再原样传递启动                                                                                                |
| `command.run`               | `args`；连接和状态各一项注册                                                                                                          |
| `ui.render`                 | `AbovePrompt.props.isWorking`；`ToolProgress.props.kind/tool_use_id`，两项注册                                                        |
| `prompt.submit`             | `origin.kind/name`、`text`、错误链；生产发送仍关闭                                                                                    |
| `turn.start`                | 主会话 `agentId` 缺省、`turnId/text`                                                                                                  |
| `turn.step`                 | `agentId/turnId`，只观察 `kind === "text"` 的 chunk；原样转发流和最终返回值                                                           |
| `turn.complete`             | `agentId/turnId/answer/isAborted`                                                                                                     |
| `tool.call`                 | `agentId/tool_use_id/tool` 及原生结果；工具预览不代表执行许可                                                                         |
| `classic.PermissionRequest` | `tool_name/tool_input`；该 hook 的返回只有明确 allow/deny 才直接清除等待，空返回或异常保留 unknown；匹配原生进度/完成证据也能结束等待 |
| `session.append`            | `agentId/door/message.content/origin`；历史变化及发送实验关联                                                                         |
| `session.end`               | 立即失效旧连接                                                                                                                        |

共 **11 种事件名、13 项事件注册**。工具/用量/UI 增强若要改为可选，需要单独实现和缺失测试，不能默默吞掉失败或推断 idle/已批准。

## 原锁版依据与仍须保留的保护

- 初次接入提交 `91eb554c6c073da04bb14a76d09ffb82705dfb5c` 同时引入插件精确比较、私有 identity/credential 的 literal 类型与后端 `z.literal`。后续 `a3391c2df38b0fc51e3ba192b8f6f0038c0551a1` 将错误单独命名为 `bridge-version-mismatch`，没有扩展兼容范围。
- [初次接入记录](native-session-connection-2026-10-16.md)依据固定 2.1.301 二进制、本机生成的声明和原生实验；未记录 2.1.307 的负向实证。不能把“未验证”写成“确定不支持”。
- **发送风险**：`$.prompt.submit` 可能等待空闲，没有原子 idle/CAS，并会跳过同插件的重入 hook；生产发送继续关闭。此前隔离发送实验不构成开放能力的依据。
- **停止风险**：流更新可能使 revision 过期，原生完成回执曾观察不稳；现有内部精确 turn/revision 保护保留，不借 B2 恢复跟随态停止入口。
- **只读也有风险**：事件缺口、首快照前事件、热加载错过 turn.start、原生日志异步落盘、隐藏推理分类以及 UUID/cwd/instance/lease 变化，均不能靠 CLI 最低版本解决。相关证据见[接入复审](native-session-review-loop-2026-10-16.md)与[真实模型补验](native-session-real-model-2026-10-16.md)。
- 配对仍验证一次性 ticket，且需所选 UUID 与已注册工作目录精确相同；challenge 120 秒有效。重连验证 token、binding 与当前身份并换发 lease，后续认证请求继续校验 token、binding、lease、nativeId、cwd 与 instance。UDS/目录 owner/type/符号链接检查及 0600/0700 保持；未经确认的操作保持未知，不由 idle 推断成功。

## 官方资料与能力信息

- [Mods reference](https://code.claude.com/docs/en/plugins/mods/reference)：列出事件、host 调用及 validate/test；并提示网页与 GitHub 声明可能落后于本机版本。
- [创建插件及本机声明](https://code.claude.com/docs/en/plugins/mods/create#get-type-definitions-for-your-version)：交互加载会写入该版本声明；静态分析要求完整字面量调用，不能简单反射 `$`、把命名空间作为值或动态索引。因此“先 typeof 检查全部方法”不是已经证实可行的实现。
- [官方测试工具](https://code.claude.com/docs/en/plugins/mods/test)：可以在不登录、不联网、不调用模型的引擎测试环境触发事件和模拟返回；测试成功不等于真实 TUI/网络/模型链路成功。
- [官方 GitHub 类型文件](https://github.com/anthropics/claude-code/blob/main/mods/types/claude-code.d.ts)本次读取的头部仍为 2.1.277，不能用它替代 2.1.301/307 的声明。其 `SessionVersion` 只有 `version/base/builtAt`；已查资料没有独立 API 版本或可直接采用的完整能力枚举。

## 隔离版本实测

2026-10-22 11:52（Asia/Taipei）查询官方 npm registry：`latest=2.1.307`、`next=2.1.307`、`stable=2.1.306`。本轮最新版与要求至少覆盖的 2.1.307 相同，无需另装第三版。

两版均使用临时 npm prefix/cache/userconfig，安装官方 `@anthropic-ai/claude-code` 及对应 darwin-arm64 包；`--ignore-scripts`，没有修改仓库依赖。运行时白名单环境、独立五目录及 AGENTKIB_HOME；Seatbelt 禁止网络、真实个人目录和 Keychain 服务。私有临时日志不入库，只记录以下白名单结果。

官方原生二进制 SHA256：2.1.301 为 `1f04c69e1c24e4d0a716a863af0aad8fc64d49a499334c29701f073700276b99`；2.1.307 为 `5b113a7752119470f1da419cb0e608af3361cae25b614216b13022093958fb2a`。

| 检查                                  | 2.1.301                    | 2.1.307                                      |
| ------------------------------------- | -------------------------- | -------------------------------------------- |
| 安装及 `--version`                    | 成功，实际 2.1.301         | 成功，实际 2.1.307                           |
| `plugin validate <插件副本> --strict` | exit 0                     | exit 0                                       |
| 原有 `plugin test <插件副本>`         | 5 pass / 0 fail            | 5 pass / 0 fail                              |
| 现有连接流测试的身份来源              | 固定模拟版本 2.1.301       | 同样固定模拟版本 2.1.301，不能证明新版本连接 |
| 未登录 `-p /plugin-types`             | exit 1，未登录，无声明产物 | exit 1，未登录，无声明产物                   |
| `--init-only --plugin-dir <插件副本>` | exit 0，但无声明产物       | exit 0，但无声明产物                         |

2.1.307 额外给出目录上架建议 `LICENSE_MISSING` / `ICON_MISSING`，不改变上述 validate 的成功判定；临时副本未包含仓库根 LICENSE，不能据此认定原仓库缺许可证。这些建议与只读接口兼容无关，不在本轮扩充发布资产。网络拒绝和真实个人目录拒绝均另行做过负向探针；网络 socket 操作明确得到 `EPERM`。

### 两版声明及无登录能力探针对比

从官方原生二进制的 Zstd frame 只读提取 `claude-code.d.ts`，每版均找到一份完整声明。这是**二进制内嵌文本**，不是交互式加载实际生成的文件；不将其当作运行行为证明。

| CLI     | 声明字节数 | 声明 SHA256                                                        |
| ------- | ---------- | ------------------------------------------------------------------ |
| 2.1.301 | 651852     | `8afa71883ecfa52901eb7a04cf31fef700d8ba565eaad244f4884cc620f8d56e` |
| 2.1.307 | 662636     | `a434904958dfc8a996a4456c60eeaee70e4ed5f382c3d8cc6ae2759bc804b2da` |

对比结果：

- `CoreEngineInterface` 中 `clock/command/fs/http/prompt/session/store/turn` 八个完整命名空间逐字一致。
- 选取的 22 个关联声明逐字一致：`SessionVersion`、`SessionMessage`、`SessionMessagesCall`、`SessionMessagesArgs`、`SessionUsage`、`SessionUsageArgs`、`PromptSubmitInput`、`PromptSubmitResult`、`TurnStartInput`、`TurnStartResult`、`TurnStepInput`、`TurnStepChunk`、`TurnStepResult`、`TurnCompleteInput`、`TurnCompleteResult`、`SessionStartInput`、`SessionEndInput`、`SessionAppendInput`、`ToolCallInput`、`ToolCallResult`、`HttpInit`、`HttpResponse`。
- 整份声明仍有其它变更，涉及 `settings.read`、`tool.check`、UI 和 testing kit；不能写成整个 Mods API 没有变化。两版声明均未找到 `apiVersion` 或完整 `capabilities` 字段，`SessionVersion` 只有 `version/base?/builtAt?`。
- 单独临时插件使用 `typeof $.session.id === "function"`，两版 strict validate 都 exit 1，明确拒绝把 `$.session.id` 当作值。**反射式能力检测不可采用**，需要显式只读调用及形态验证。
- 另一临时插件显式调用 `$.session.version()`，两版 strict validate 都通过，但两版 testkit 执行都报告 `no implementation for session.version`。这是测试宿主没有默认原生身份实现，**不是 CLI 缺少 API**；更不能把它误归为新版本不兼容。

复现形式（每版目录和插件副本相互独立，`QA_ROOT` 为专用临时目录；白名单不继承账号变量）：

```sh
env -i <每版独立目录及工具路径的白名单变量> \
  npm install --prefix "$QA_ROOT/npm-prefix" --ignore-scripts \
  --registry https://registry.npmjs.org "@anthropic-ai/claude-code@$VERSION"

env -i <每版独立五目录、AGENTKIB_HOME 及工具路径> \
  /usr/bin/sandbox-exec -f "$QA_ROOT/deny-network-and-personal.sb" \
  "$CLI_BINARY" plugin validate "$PLUGIN_COPY" --strict

env -i <相同隔离白名单> \
  /usr/bin/sandbox-exec -f "$QA_ROOT/deny-network-and-personal.sb" \
  "$CLI_BINARY" plugin test "$PLUGIN_COPY"
```

这是命令模板，尖括号处需展开为明确的 `KEY=value` 环境白名单，不能原样当作 shell 重定向运行。安装可访问官方 registry；CLI 执行阶段禁止全部网络和真实个人目录。临时安装/验证/声明提取/对比脚本及 JSON 证据保留在本机专用研究目录，未复制到仓库；插件副本与源码逐文件 SHA256 相同，未为新版本替换常量或弱化断言。

## 后续实施边界（待 B 合入后执行）

1. 先从届时最新 main 核对 B 的最终向导和镜像，再改 B2，不回退入口、折叠、状态或审查修复。
2. 将最低 CLI 版本和已验证清单放入单一配置数据源，插件产物与后端从同一来源读取/生成，附一致性测试；记录验证级别，不能将 validate 成功自动提升为真实同步已验证。
3. 私有协议/插件合约仍明确校验；CLI 改为真实观测元数据。统一处理 pair、snapshot、credential 重连与 live/status 的固定值，避免部分放宽后另一处继续拒绝或伪报版本。
4. 只探测无副作用的必需读取能力及返回形态，不执行 submit/abort 来探测；先证实静态分析可接受的写法。事件语义需故障注入和原生测试，不能只检查方法名存在。
5. 区分已验证、新但未验证、明确不兼容；未知新版本成功只读连接后使用中性提示，不能放宽 send/stop/approve/answer。低版本、插件过旧、缺必需能力使用独立原因和当前版本；不兼容时隐藏连接命令，桌面/Web 四语同步。
6. 旧凭据重连仍核对当前身份与能力，不继承旧进程能力；保留过期、一次消费、断开撤销、未知结果和派发前权限围栏。
7. 自动检查采用隔离的版本矩阵及可手动触发 CI：官方 CLI validate、测试工具、实际能力/返回形态、安全回归与合成原生链路分开报告。缺能力时报告具体名称；不登录、不调用真实模型、不自动修改验证清单或发布产物。

若关键引导 API 本身缺失而导致插件不能加载/读取身份，插件可能无法把当前版本与错误安全地报告给应用。实施时须验证可行的诊断路径；不能假装后端已知失败终端版本，也不能用读取个人配置或绕过插件加载保护来填补。

## 现有回归及未覆盖项

在调研基线安装已有锁文件依赖（offline、frozen），于独立五目录、AGENTKIB_HOME 与白名单环境中运行：

```sh
pnpm --filter @agentkib/desktop exec vitest run \
  test/claude-bridge-plugin.test.ts \
  test/claude-bridge.test.ts \
  test/claude-bridge-runtime.test.ts \
  test/claude-bridge-auto-continue.test.ts
```

结果：**4 文件、101/101 通过，8.71 秒**。覆盖当前生产发送恒关、错误版本拒绝、UDS/凭据权限、身份匹配、旧 lease、事件缺口/重连及外部/托管占用保护；部分用例明确是临时发送实验，不能据其成功宣称生产开放发送。这是当前桥接基线，不是尚未实现的 B2 兼容矩阵。

`pnpm typecheck`：backend / desktop / Web 全部通过。仅有项目已有的路由生成 circular dependency 提醒，没有类型错误。`git diff --check` 通过，依赖声明和锁文件无修改。本轮没有业务代码变更，未重跑桌面/Web 全量和构建，不将上一批结果当作本轮执行记录。

调研结果经只读核对，已纠正 pair/reconnect/后续请求安全检查的概括，以及权限等待的结束证据表述。最终结论是：**可以继续按最低版本与显式能力探测方向实施验证，但目前不能宣称 2.1.307 已完成真实只读同步验收。** B 合入前仅保留此研究记录，不修改兼容规则。

全部研究命令已退出，未遗留研究 CLI 进程，未启动 tmux；源码插件目录没有 CLI 生成的类型文件，所有运行都使用临时副本，无需改写或重建仓库插件产物。没有更改真实配置、账号或 Codex 系统技能。研究分支仅有本 QA 未跟踪文件，原工作区无关改动保留。

未运行真实账户、真实模型或真实会话的连接/一轮回复/断开，也未生成这些场景的截图。共同约束禁止使用真实账号，本轮没有测试账号；现有原生套件又精确断言 2.1.301。未修改该断言或插件常量来把 2.1.307 伪装为旧版本。后续需要受控测试账号/原生合成 provider 的验收分别记录，不能与无登录检查混称为完成 B2 验收。
