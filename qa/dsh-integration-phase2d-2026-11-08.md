# DeepSeek Harness 二期 2d（交接、正文搜索、Agent 预设）QA — 2026-11-08

本文记录二期 2d 的源码、自动化结果和真实 DSH 沙箱验收：DSH 会话作为交接来源与目标、正文搜索收录 DSH 会话、新建会话时选择 DSH 的 Agent 预设，以及验收中发现并修复的问题。2026-11-08 确认先以 DSH 打开时可用为准，本轮不涉及三期（DSH 未运行时由 AgentKib 启动）。结论只适用于下列源码与版本。方案见[接入方案](../docs/DEEPSEEK-HARNESS-INTEGRATION.md)的“2d 实现”。

## 源码与边界

- AgentKib：`origin/main` `1acf33bd0`（含 #204）之上，分支 `dsh-2d`；验收在提交前的同一份改动上进行。
- agentkib-flutter：`origin/main` `bbb59be`（含 #8）之上，分支 `dsh-2d`。
- DSH：本机安装的 DeepSeek Harness `0.2.2-rc.1`（兼容状态为“未验证”）。所用接口在安装包 `app.asar` 中核对：`sessionQuery.readSurface`（返回当前模型可见范围与读到的序号）、`observeSession`、`agentPresets.remoteExportList`（DSH 自带的预设不带名字）、`sessionController.create` 的 `agentPreset`、压缩检查点消息（`compact-checkpoint`）与助手消息里的 `tool-call` 内容块。
- 模型：本机 OpenAI 兼容的合成 provider（`mock-model`）。DSH 一侧真实模型请求 **0**。
- 沙箱与 2a–2c 相同：AgentKib 桌面开发版、独立 HOME 与数据目录，DSH 用独立的 `DSH_HOME`。桌面界面为简体中文；Web 为 2c 已配对的无头 Chrome profile（简体中文）；手机为 Android 模拟器 `AgentKib_QA_API35`（英文）。没有读取或修改用户真实的 `~/.dsh`、`~/.agentkib`、`~/.claude`、`~/.codex`。Claude Code 交接来源是写在沙箱 Claude 配置目录里的合成会话。
- 没有新增生产依赖，持久化结构不变。插件与 Host 的私有协议新增 `document`、`presets` 命令，`create` 可带 `agentPreset`，插件上报 `documents`、`agentPresets` 两项服务；Host 的 DSH 新建选项多了 `agentPresets`，新建请求可带 `agentPreset`。

## 实现范围

- 插件 0.5.0：`document` 按序号分页读取整个会话（用户消息与图片引用、助手正文与工具调用参数、工具结果、压缩摘要），并按 `readSurface` 标出每条记录是否在当前可见范围及位置；`presets` 列出 Agent 预设。
- 交接来源：DSH 会话生成统一 SessionDocument，在主进程经插件读取。默认交 DSH 模型当前看到的内容（按可见范围顺序），可选“包含压缩前的历史”。会话页判断能否交接只看是否有列出该会话、支持整段读取的运行中 DSH，不读取整个会话。
- 交接目标：交接文件写入 `.agentkib/handoffs/`，“应用并继续”在运行中的 DSH 新建会话并发送指向该文件的引导消息，然后在 AgentKib 中打开；新建与消息按交接文件命名请求 ID，重试不会再建会话或重发。
- 正文搜索：DSH 会话进入同一个全文索引，主进程从 DSH 读取后交给索引 Worker；DSH 列出的会话没变就不再读取，运行中的会话等本轮结束。
- Agent 预设：桌面、Web 的新建任务与手机的新建会话在选择 DSH 时列出预设，按 DSH 的叫法命名，默认选 DSH 的默认预设，不选或选默认时不传。
- 通用修复：规划交接时恢复“能否启动目标”的能力，变更页重新显示“应用并在 … 中继续”（所有目标）。

## 自动化检查

- 类型检查（backend、desktop、web）：通过。oxfmt：通过。oxlint：0 错误，警告都不在本轮改动的行上。
- Web 全量：86 个文件，1796 通过。
- Desktop 全量（全部项目）：521 个文件（1 个跳过），10113 通过、3 跳过。
- agentkib-flutter：`flutter analyze` 无问题；应用测试 1058 通过、1 跳过；`agentkib_client` 包测试 272 通过。
- 新增测试：DSH 会话文档（默认与完整历史、可见范围顺序、精简工具结果、损失、脱敏）、经 SessionReaders 读取、插件整段读取（压缩后的顺序、分页停在首页序号、图片随文档带上、旧插件的不可用原因）、按预设新建、交接新建与重试只发一次、交接到 DSH 的准备—规划—应用—启动、搜索 Worker 的 DSH 来源、搜索主进程（运行中不读、没变不读）、变更页打开 DSH 会话、交接对话框对 DSH 来源提供压缩前历史选项、新建表单的预设（桌面、Web、手机）、Host 转发 `agentPreset`、来源原因说明。
- 撤掉默认交接的可见范围排序，对应测试失败。
- CI 分片校验、发布脚本测试（68 通过）、`pnpm build` 与 `pnpm build:web:hosted`：通过。

## 真实 DSH 沙箱验收

### 桌面端（简体中文）

1. **Agent 预设**：新建任务选 DeepSeek Harness 后，工作区下方出现“Agent 预设”，列出 DSH 返回的四个预设：标准模式（默认）、PTC 模式、极简模式、创造模式。选极简模式创建后，DSH 的会话投影记录 `agentPreset: "minimal"`，AgentKib 打开新会话。
2. **从 DSH 交接出去**：在这个会话里发两条消息，运行 `/compact`（DSH 压缩 4 项），再发一条。会话工具栏的“在其他 Agent 中继续”可用。目标选 Codex：
   - 预览按 DSH 模型当前的顺序：上下文摘要（带 AgentKib 的固定标注）、压缩留下的那条回复、之后的一问一答；“最近一次压缩之前的 3 个时间线节点未包含”需要确认；全部直接导入，不需要归档。
   - 勾选“包含压缩前的历史”：按日志顺序带上全部消息，在压缩点插入“DeepSeek Harness compacted the conversation here (compaction 1 of 1)”标记和摘要，没有损失。
   - “查看导入变更”重新读取 DSH，来源指纹一致；变更页列出交接文件与 `.gitignore`，并显示“应用并在 Codex 中继续”。拒绝了这份变更，没有启动 Codex。
3. **交接到 DSH**：合成的 Claude Code 会话交接，目标列表中有 DeepSeek Harness。预览：原生续接不支持，说明为“该 Agent 无法导入其他 Agent 的历史，将改用交接文件。”；文件交接、交互式启动支持。生成变更后点“应用并在 DeepSeek Harness 中继续”：
   - 交接文件写入工作区的 `.agentkib/handoffs/`，`.gitignore` 加入该目录；
   - DSH 新建会话（DSH 默认预设 `standard`），日志中第一条用户消息是指向交接文件的引导消息，DSH 随即作答；
   - AgentKib 打开这个会话，状态为“在 DeepSeek Harness 中运行 · 已连接”。
4. **正文搜索**：开启后约 20 秒内 14/14 就绪（13 个 DSH 会话、1 个 Claude Code 会话）。搜索压缩前的消息命中 DSH 的用户与助手两条；按 Agent 筛选 DSH 后，Claude 的内容不出现。桌面“搜索会话正文”显示 DeepSeek Harness 的正文与工具记录都支持。关闭 DSH 后仍能搜到这两条，覆盖仍为 14/14。
5. **DSH 关闭时**：重新检查后，DSH 会话不再提供“在其他 Agent 中继续”；对话框里的原因为“DeepSeek Harness 没有在运行，打开 DSH 后才能读取这个会话。”。

### Web 客户端（无头 Chrome，2c 已配对的 profile）

- 新建任务选 DeepSeek Harness，出现同样四个预设；选创造模式创建后，DSH 记录 `cordis`，页面打开新会话。

### 手机（Android 模拟器，英文）

本轮 agentkib-flutter 工作树构建的 dev 版 debug 包，连接方式与之前相同（本机回环 Web 服务、本次生成的两天自签证书 TLS 转发、`adb reverse`），以完整授权码配对；结束后卸载、移除转发、关闭模拟器、删除私钥。

- 新建对话选 DeepSeek Harness 后出现 “Agent preset · Standard mode”，菜单为 Standard mode、PTC mode、Minimal mode、Creator mode；选 PTC mode 后 Start，DSH 记录 `ptc`，手机打开新会话（“Running in DeepSeek Harness · Connected”）。
- Search › Full text 搜索压缩前的消息：两条 DSH 命中（Assistant、User），“Indexed 15 of 15 conversations”。

## 发现的问题（均已修复并复验）

1. **默认交接的顺序不对**：DSH 压缩时把摘要放在被替换范围的位置，排在它留下的最后一条回复之前。文档按日志序号排列，把这条回复放到了摘要前面，窗口规划又把它当作不完整的轮次放进归档（预览提示目标未连接 AgentKib MCP）。插件改为报告每条记录在可见范围中的位置，默认交接按位置排序；复验顺序正确、全部直接导入。
2. **变更页没有“应用并在 … 中继续”**：TypeScript 后端迁移后，规划交接时不再带上能否启动目标的能力（旧 Runtime 带），所有目标都只能“仅应用”。规划时重新判断；复验 Codex 与 DSH 都显示这一步。
3. **DSH 不在交接目标里**：安装检测只看 PATH 上的 `dsh`，而 DSH Desktop 不把自带的 CLI 放进 PATH。加入 macOS 的 `DeepSeek Harness.app`；发现刷新后复验目标列表出现 DSH。
4. **原因显示为代码**：交接对话框把 `native-history-import-unsupported`、`dsh-runtime-offline` 原样显示。补了四种语言的说明，复验显示中文说明。

## 观察（非本轮问题）

- 会话工具栏的来源检查结果会缓存：DSH 刚退出的几秒内读到的结果可能仍是可交接，打开对话框后会重新检查并说明原因，“检查可迁移内容”不可用。
- 合成模型不调用工具，交接到 DSH 后只验证了引导消息送达和会话打开；真实模型是否读取交接文件取决于 DSH 与模型。
- 验收期间 macOS 清理 `/private/tmp` 删除了沙箱工作区目录与部分测试脚本（约三天前的文件），重建后继续，与产品无关。

## 已知限制

- 交接与正文搜索都需要 DSH 运行；没收录过的 DSH 会话在 DSH 关闭时显示为不可用。
- 交接到 DSH 要求恰好一个运行中的 DSH；内容超出历史预算需要窗口化时不可用（DSH 没有接 AgentKib MCP）。DSH 收到引导消息即开始一轮，不同于 Codex、Claude 在终端里等用户的第一条消息。
- Agent 预设只在新建时选择。DSH 关闭“开发者工具”时它自己的窗口会隐藏 PTC 与极简模式，AgentKib 仍全部列出（该偏好存于 DSH 另一插件的配置，插件读不到）。
- iOS 模拟器与真机未验收。
