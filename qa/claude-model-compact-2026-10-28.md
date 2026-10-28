# `/model`、`/effort`、命令输出与 `/` 菜单（2026-10-28）

分支 `fix/claude-model-and-compact`，基于 `main` 的 `23b808e25`。先处理[斜杠命令验收](claude-code-slash-commands-2026-10-27.md)“未验证”里的两条，再按 `/` 菜单的逐条核对修了四处。

| 提交 | 内容 |
| --- | --- |
| `ccba889d9` | 宿主：`/model` 接受不分大小写的别名和完整模型 ID；列表里没有的模型、不支持的思考强度说明原因 |
| `fb9141e6b` | 桌面工作区的 Claude 面板接上“压缩上下文” |
| `331481020` | 电脑上的 AgentKib 服务也按同一规则匹配模型名（更正，见下） |
| `e29f6d676` | 被拒说明改为：限制来自下一轮设置 |
| `92669d3eb` | `/effort` 跟不支持的级别时，输入框说明可用的级别 |
| `ac4fd79a9` | 两端设置被拒的测试跟上新文案 |
| `aa46d68f9` | Claude Code 自己写的输出保留换行和 `<…>` 占位 |
| `f87fd5768` | `/` 菜单不再列出 `/fast`、`/focus`、`/color` |

本轮没有调用模型，也没有使用真实 API key。CLI 行为来自本机 CLI 2.1.311 对本地 API 桩的离线运行，做法同 [2026-10-27 QA](claude-code-followups-2026-10-27.md)：桩只监听 `127.0.0.1`，CLI 在只放行 localhost 的 `sandbox-exec` 里运行，`HOME` 与 `CLAUDE_CONFIG_DIR` 指向空的临时目录，用假 key。

## CLI 2.1.311 的模型列表与 `set_model`

以 stream-json 启动 CLI，依次发送 `initialize` 和 4 个 `set_model`，共运行两次：一次桩正常回复，一次桩对 `no-such-model-xyz` 回 404。另外在 `initialize` 后单独发送 `set_model haiku`、`set_model claude-haiku-5-5` 各一次，核对桩收到的请求来自哪条命令。

| 请求 | 回复 |
| --- | --- |
| `initialize` | `models`：`default` → `claude-opus-5-5`、`opus` → `claude-opus-5-5`、`fable` → `claude-fable-5-1`、`sonnet` → `claude-sonnet-5-5`、`haiku` → `claude-haiku-5-5`，都支持 low、medium、high、xhigh、max |
| `set_model haiku` | 成功，`model: claude-haiku-5-5`，桩没有收到请求 |
| `set_model claude-haiku-5-5` | 成功；桩收到一次该模型的非流式请求 |
| `set_model no-such-model-xyz` | 桩正常回复时也是成功；桩回 404 时回复错误 `Model 'no-such-model-xyz' not found` |
| `set_model default` | 成功，`model: claude-opus-5-5` |

CLI 对别名以外的名称先发一次请求来确认，结果取决于 API。所以 AgentKib 先按列表找到别名，交给 CLI 的总是别名。

## 宿主的改动（`ccba889d9`）

- `settings` 先按列表找 `/model` 的名称，依次尝试：完全相同、不分大小写的别名、完整模型 ID。完整 ID 同时对应 `default` 和具名别名时取具名别名，只有 `default` 指向它时取 `default`。保存并交给 CLI 的是找到的别名。恢复默认设置时不检查模型。
- 预检回执的原因：`unsupported-model`、`unsupported-effort` 不再记为 `control-preflight-rejected`。
- 客户端：Claude 会话把这两个原因显示为 Claude 自己的说明（四种语言）。完整访问的设备在输入框控件上方显示说明和“更改下一轮模型”，会话页不再重复；其他设备在会话页显示。草稿保留。
- 桌面工作区的 Claude 面板：用量对话框接上“压缩上下文”，与会话页的按钮一致；只用于托管会话，空闲、可发送、不在压缩、会话有消息时可用，单独发送 `/compact`，草稿和附件不变。

## 更正：服务先按 id 精确检查模型

上一版记录说 `/model` 已接受完整模型 ID 和大小写不同的别名，这在真实链路里不成立。电脑上的 AgentKib 服务（`WebAccessService` 的 `/managed/action`）在转给宿主之前，先读 `settings-state`，按 `models[].id` 精确检查模型和思考强度，不匹配时回 400 `unsupported_model`、`unsupported_effort`。所以 `/model claude-haiku-5-5`、`/model HAIKU` 到不了宿主；客户端只认宿主带连字符的原因，显示的仍是通用的“操作未执行”。当时的测试直接调用宿主，没有经过服务。

修复（`331481020`）：名称匹配移到 `runtime-protocol` 的 `claudeModelOption`，服务和宿主共用。Claude 会话的服务先找到列表里的别名，再按这个别名检查思考强度并转给宿主；Codex 仍按 id 精确匹配。客户端把服务的 `unsupported_model`、`unsupported_effort` 也显示为 Claude 的说明。

## `/` 菜单逐条核对

用同样的离线方式，把这台电脑的菜单里的 39 条命令各不带参数运行一次，记录回复、模型请求和写入的文件；远程设备的菜单有 25 条。终端专用的命令（`/help`、`/resume`、`/permissions` 等 25 条）CLI 回复不可用，本来就不在菜单里。核对出四处问题：

- 显示：本地命令的输出按 Markdown 渲染，单个换行合并成空格，`<name>` 这类占位被当成 HTML 去掉。`/model` 的用法显示为 “Usage: /model .”，`/rename` 为 “Usage: /rename ”，`/mcp` 为 “[reconnect|enable|disable [|all]]”，`/usage` 的 5 行挤成一段。
- `/model`：CLI 的帮助列出 `best`、`opusplan`、`sonnet[1m]`、`opus[1m]`、`fable[1m]` 等名称，下一轮设置只接受 initialize 列出的 5 个。决定不接受其余名称：它们无法事先核对，交给 `set_model` 会先发 API 请求，失败时设置无法确认；设置对话框也显示不了这些名称。原说明“Claude Code 的模型列表里没有这个模型”不准确，改为限制来自下一轮设置。
- `/effort`：CLI 的用法是 `<low|medium|high|xhigh|max|auto|ultracode [on|off]>`，下一轮设置只有前五档。`/effort auto` 原来显示“带参数的 /model 和 /effort 只影响当前进程……”，读起来像 AgentKib 不保留思考强度；改为说明可用的级别。`auto` 是否等于“默认”没有核实，所以没有映射过去。
- `/fast` 回复 “Fast mode is not available in the Agent SDK”，`/focus` 回复 “/focus isn't available here yet”，`/color` 只改终端提示栏的颜色（回复 “Session color set to: pink”），AgentKib 里都没有效果。菜单不再列出这三条，直接输入仍会发送，由 CLI 的回复说明。

## 命令输出的显示（`aa46d68f9`）

- 后端给 Claude Code 自己写的文字加 `cli_output`：历史里的 `system/local_command` 行、`/compact` 的输出行和 model 为 `<synthetic>` 的助手行（例如 API 或登录错误）；实时轮次里 model 为 `<synthetic>` 的助手帧和回放的命令输出。同一项之后被重发时也带上。
- 客户端按原样显示带 `cli_output` 的消息：每个换行都换行，HTML 显示为文字，代码、标题和表格照常渲染。Web 和桌面的会话页用 `SafeMarkdown` 的 `literal`（一个 remark 插件），桌面会话记录和工作区 Claude 面板用 `MarkdownContent` 的 `literal`（一个 `@tanstack/markdown` 扩展）。模型的回复不变，原始 HTML 照旧去掉。
- 没有在后端转义 `<`：那样会弄坏 `` `/goal <condition>` `` 这样的行内代码。也没有用 `white-space: pre-wrap`：Markdown 硬换行生成的 `<br>` 后面还有换行符，会换两次行。没有新增依赖。

## 验证

- 新增或更新的测试：
  - 真实 Service → Backend → 合成 CLI：`/model` 的大小写别名、完整模型 ID 保存为别名；列表外的模型、模型不支持的思考强度回 400，不发控制请求，设置不变。本地命令的输出在实时项和经服务读取的历史里都带 `cli_output`，用户消息不带。
  - 服务单测：转发给宿主的是列表里的别名（`OPUS` → `opus`，`claude-opus-5-5` → `opus`）；`best`、拼错的名称、模型不支持的级别在服务被拒；Codex 仍按 id 精确匹配。
  - 两端会话控制器：服务的 400 和宿主的 409 都得到 Claude 的说明。
  - 两端输入框：`/effort auto`、`/effort ultracode on`、拼错的级别显示可用级别的说明，草稿保留、不发请求；设备不能改设置时，可用级别仍显示原来的说明。
  - 历史与实时：本地命令输出、`/compact` 输出、`<synthetic>` 助手行带标记，模型回复、命令本身不带；实时帧之后重发的同一项仍带标记，之后流式输出的模型文字不带。登录失败的说明带标记。
  - 显示：用 2.1.311 的真实输出（`/model`、`/rename`、`/mcp`、`/usage`、`/context`）核对：占位保留、每行一个 `<br>`、行内代码、标题和表格照常、Markdown 硬换行不会变成两个；`<img onerror>`、`<script>` 只显示为文字。两端会话页、桌面会话记录和工作区面板都按标记切换。
  - 菜单：两类设备都不列出 `/fast`、`/focus`、`/color`，直接输入不被拒绝。
- 变异检查：第一轮 29 处，28 处被发现，没被发现的空白名称检查已删除。本轮 45 处，起初 44 处被发现；没被发现的是“之后重发的同一项不带标记”，补了断言后被发现。
- 全量（`f87fd5768` 的代码）：后端构建，后端、桌面、Web 类型检查，`oxfmt --check`、`git diff --check` 通过；`oxlint` 警告数与基线相同（276）；Web 73 个文件 1615 项通过。桌面跑了两次，当时机器负载在 20 到 40 之间（另有虚拟机和其他任务）：
  - 第一次 450 个文件中 446 个通过、1 个跳过，9015 项通过、3 项跳过，6 项失败：`skill-sync-manager.test.ts` 4 项超时，集成测试里一项目标自动化用例超时（单独跑 1.7 秒），终端连接对话框一项显示了另一条说明。
  - 第二次（`--maxWorkers=6`）448 个通过、1 个跳过，9020 项通过、3 项跳过，1 项失败：`claude-permission-mode.test.ts` 里进程清理在 1 秒内没有确认。
  - 这 4 个文件单独重跑全部通过，两次失败的用例互不重合，都与本轮改动无关。
- 一处疏漏：`e29f6d676` 提交前没跑两端的 `claude-settings-prepare` 测试，它们按旧句子查找，由 `ac4fd79a9` 修正。

## 未验证

- 没有用真实 CLI 走一遍服务 → 宿主 → CLI 的 `/model`；集成测试用合成 CLI，名称匹配用的是上面实测的 2.1.311 列表。
- 没有截图核对新的显示方式，只在 jsdom 里核对了 DOM：换行变为 `<br>`，占位是文字，代码、标题、表格照常。
- 历史里 `<synthetic>` 的 API 错误行按 2.1.311 登录失败的实时帧推断，没有用真实的 API 错误核对 JSONL。
- `/effort auto` 与默认强度是否等价。
