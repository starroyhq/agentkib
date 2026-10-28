# `/model` 的模型名与工作区面板的压缩按钮（2026-10-28）

分支 `fix/claude-model-and-compact`，基于 `main` 的 `23b808e25`。处理[斜杠命令验收](claude-code-slash-commands-2026-10-27.md)“未验证”里的两条：

| 提交 | 内容 |
| --- | --- |
| `ccba889d9` | `/model` 接受不分大小写的别名和完整模型 ID；列表里没有的模型、不支持的思考强度说明原因 |
| `fb9141e6b` | 桌面工作区的 Claude 面板接上“压缩上下文” |

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

也就是说，CLI 对别名以外的名称先发一次请求来确认，结果取决于 API。此前宿主只按 `value` 匹配，所以完整模型 ID 和拼错的名称都在预检被拒，客户端只看到通用的“操作未执行”。

## 改动

- 宿主的 `settings` 先按列表找 `/model` 的名称，依次尝试：完全相同、不分大小写的别名、完整模型 ID。完整 ID 同时对应 `default` 和具名别名时取具名别名，只有 `default` 指向它时取 `default`。保存并交给 CLI 的是找到的别名，所以 `claude-haiku-5-5` 保存为 `haiku`，不会再向 API 发确认请求。恢复默认设置时不检查模型。
- 预检回执的原因：`unsupported-model`、`unsupported-effort` 不再记为 `control-preflight-rejected`。电脑上的 AgentKib 原本就允许这两个原因传给客户端（`continuation-reason.ts`）。
- 客户端：Claude 会话把这两个原因显示为 Claude 自己的说明（四种语言），不用 Codex“本次消息尚未发送”的说明。
  - 完整访问的设备：说明和“更改下一轮模型”显示在输入框控件上方，点击打开下一轮设置，不提交任何操作；会话页不再重复显示。
  - 其他设备：说明显示在会话页。
  - 草稿保留，改正后可以直接再发。
- 桌面工作区的 Claude 面板：用量对话框接上“压缩上下文”，与会话页的按钮一致。
  - 只用于托管会话，连接的终端不显示。
  - 空闲、可发送、不在压缩、会话有消息时可用；轮次运行中禁用并提示“当前轮次结束后可以压缩”。
  - 单独发送 `/compact`，草稿和附件不变；历史记录到它之前，待发消息显示 `/compact` 而不是草稿。

## 验证

- 新增或更新的测试：
  - `claude-model-option.test.ts`：用 2.1.311 的列表核对名称匹配，包括大小写、完整 ID、`claude-opus-5-5` 取 `opus`、只有 `default` 时取 `default`，以及找不到、空白名称。
  - 托管会话 parity：`/model fixture-actual-model`、`FIXTURE-ALIAS` 等保存为别名、发给 CLI 的也是别名；列表外的模型、模型不支持的思考强度、不存在的思考强度，回执分别为 `unsupported-model`、`unsupported-effort`，不发控制请求，设置不变；恢复默认设置时附带列表外的模型仍然恢复。
  - 两端会话控制器：Claude 设置被拒时得到 `claude-model-unsupported`、`claude-effort-unsupported`，其他拒绝仍是通用说明。
  - 两端输入框控件：两个原因显示说明和“更改下一轮模型”，点击打开下一轮设置、不提交；Codex 的原因和命令拒绝原因不显示这个入口。
  - 两端会话页：完整访问时不重复显示说明，没有完整访问时显示。
  - 工作区面板：压缩后发送 `/compact` 且 `attachmentIds` 为空、对话框关闭、草稿保留、待发消息为 `/compact`；运行中、不能发送、正在压缩、没有消息时禁用；连接的终端不显示。
- 变异检查：共 29 处，每处单独改坏后跑相关测试，28 处被发现。没被发现的是名称查找里的空白检查：宿主在查找之前已经拒绝空白名称，CLI 列出的名称也不会是空的，所以删掉了这项检查。
- 全量：后端构建，后端、桌面、Web 类型检查，`oxfmt --check`、`git diff --check` 通过；`oxlint` 警告数与基线相同（276）；Web 72 个文件 1598 项通过；桌面 450 个文件中 449 个通过、1 个跳过，9001 项通过、3 项跳过。第一次全量时，工作区面板的“连接的终端不显示压缩”测试失败一次，失败时页面上没有用量对话框。用量对话框只在打开时的观察范围内显示，范围一变就会关闭，所以这个测试和同组测试都改为等输入框可用后再打开。之后同时跑这个测试文件 3 份，都通过；上面的数字来自第二次全量。

## 未验证

- 没有用真实 CLI 走一遍宿主的 `/model`。宿主逻辑由 parity 的合成 CLI 覆盖，名称匹配用的是上面实测的 2.1.311 列表。
- 没有做新的视觉检查。设置说明沿用 Codex 已有的说明和按钮样式，换了文字；压缩按钮是会话页已经检查过的同一个组件。
- `/effort` 后面跟不存在的级别时，输入框仍显示“带参数的 /model 和 /effort……”这条拒绝说明，不发请求。设置对话框只提供有效级别，宿主遇到无效级别时会回 `unsupported-effort`。
