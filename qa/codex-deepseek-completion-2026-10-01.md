# Codex 新批次真实续聊与 0.155.1 精确兼容验收

2026-10-01，本批次两个新公共目标均通过一次官方 DeepSeek `deepseek-v4-pro` 请求、CLI 完整回复及两个独立禁网原生恢复。共两次上游 POST，没有自动重试、换模型、登录、安装或复制凭据。旧失败记录不覆盖。

证据根：`/Users/user/Documents/AgentKib-archives/2026-10-01/codex-completion-batch`。主执行器与 guard 经 OpenClaw 子代理交叉审查、主代理抽查后才发送真实请求；本子代理随后直接重算原始 SSE、持久化全文、公共计划、来源和两个 app-server RPC 日志，结果另存 `independent-audit.json`。

| 方向 | 固定版本 | 新目标 ID | 唯一请求 | 原生完整恢复 |
| --- | --- | --- | --- | --- |
| Grok Build → Codex | 0.146.1 | `9f9bb8c3-62fd-427b-b6a3-a503a6aa467d` | admitted=1 / dispatch=1 / HTTP200 / blocked=0 | 两次五消息全文、同 ID、唯一列表通过 |
| Claude Code → Codex | 0.155.1 | `12f8ef90-b5d8-4e73-8db2-91da2cbc2dd0` | admitted=1 / dispatch=1 / HTTP200 / blocked=0 | 两次五消息全文、同 ID、唯一列表通过 |

公共预览、ChangeSet、首次操作回执、重复应用拒绝及 Runtime 重启后 reopen 回执分别保存在 `public-grok-codex146`、`public-claude-codex155`。mock 使用冻结 renderer JSONL 建立自身原生索引，不复制含绝对路径的 SQLite；真实执行直接使用各自公共目标，不消费旧批次 marker。

## 二进制与生产 gate

- 原有 0.146 major/minor gate 保持不变。0.146.1 原生二进制 SHA256：`35d248101b211d6248ad4e6b8c1d441fe81236da87afb9f3e9ea51a049e9f179`。
- 本机原安装 `/opt/homebrew/Caskroom/codex/0.155.1/bin/codex` 被冻结为 `tools/codex-0.155.1`，SHA256：`8eaf1ad12fe6bf89b1710330f58900014322c7c5af677e43be116d8ac5fc0a9e`。`binary-freeze.json` 记录安装不变、无凭据复制。
- 先用实际 Rust renderer 产物完成 `offline-155` 的两次官方全文回读，随后完成固定请求捕获、合成响应与两次恢复，才在生产 gate 中增加输出恰为 `codex-cli 0.155.1` 的精确 profile。0.155.0、0.155.2、0.156、附加输出均拒绝。
- renderer 的 `cli_version: 0.146.1` 继续表示生成器格式；新版实际原生恢复和续聊已证明接受该格式，没有把元数据伪改成安装版本。

## 精确请求与响应合同

0.146.1 与 0.155.1 分别固定原生 instructions/developer/environment 投影、根字段集合和工具声明 SHA。最新版仅增加已实测的 `parallel_tool_calls: true` 及 root/agent/context/window/sandbox/auto-review 元数据；所有未知字段与版本混用 fail closed。历史完整角色、正文和顺序不做模糊匹配。

原生仅声明固定 `view_image` 函数；QA 在任何 SSE 字节到达 CLI 前缓冲并检查完整响应，拒绝工具调用、错误、不完整输出和未知执行对象。`response.tools` 的固定声明回显及 `response.text.format` 的固定声明按精确路径验证；原始 wire 不剥离、不重写。两个真实响应均没有工具调用，增量正文、最终响应、CLI 和原生持久化全文一致。

新 prompt 不含随机标记或决策。真实结果：

- Grok 回复：`AKIB-dae9b80a1d554046bb; append-only SQLite WAL with namespace cobalt-lake`。原生用量 input6018 / output26 / reasoning0。
- Claude 回复：`AKIB-a7215b693de54cf9a5`，下一行完整为 `append-only SQLite WAL with namespace cobalt-lake`。原生用量 input4950 / output99 / reasoning73。

两例 CLI 均正常 exit0、仅完成一轮；原生只追加一个精确 prompt 和一个完整 assistant。原始导入字节前缀、来源文件和来源元数据保持；会话索引指向各自唯一 rollout，未创建 auth.json。结束时 relay socket/client/handler 清零，所有自有 CLI/app-server 进程组退出。执行器在随机 loopback token 销毁前完成证据和原生目录扫描，真实 provider 凭据仅由父 relay 在内存读取。

Codex 报一条精确已知警告：缺少 `deepseek-v4-pro` 内建模型元数据并使用 fallback metadata。HTTP 响应与原生身份仍绑定该模型；这不是对其默认上下文预算或性能的认证。

## 验证与证据

- `cargo test -p agentkib-conversations codex_`：26 passed，1 ignored（显式 renderer 导出测试另外执行通过）。
- `cargo test -p agentkib-runtime native_version_`：3 passed，覆盖版本解析及超时子进程树清理。
- `cargo build -p agentkib-runtime`：通过。
- `python3 qa/probes/deepseek_codex_guard_selftest.py`：13 unittest 通过，包含旧版及最新精确字段、工具/错误 SSE、错版本、错误类型和未知字段负例。
- `codex-isolated-readback.py` 固定 0.155.1 + `renderer-fixture/fixture-155.jsonl`：禁网两次完整回读/恢复/列表通过，包含中文、多行、重复文本。
- `compat-155-native-capture`：0 POST 的原生请求捕获；`compat-155-native-success`、`grok146-mock`、`claude155-mock`：合成成功及两次完整原生恢复通过，真实请求数均 0。
- 新真实执行命令使用 `deepseek-codex-native-once.py ATTEMPT --mode live --public-case CASE --profile VERSION --source-agent SOURCE`，CA 固定为本机 certifi 文件；`grok146-live/result.json` 与 `claude155-live/result.json` 均 `passed=true`、`realReplyPassed=true`。
- 执行时 runner SHA256：`dcfedb6ded68ea48cf136d40d30cfebf7373b85b6948158ba5c177a90518024a`；guard SHA256：`1ce8197eff874a78aa16f8eaeac4eaef49cb53a718b9734dcf87c4f16b356122`。每例保留当时脚本、命令、二进制、公共计划和原始响应 SHA，避免用后来脚本冒充实际执行版本。
- `independent-audit.json`：0 模型请求、0 原生进程启动的重算通过。两个请求的原始 wire hash 在 exclusive dispatch-token 与 dispatch 事件中一致；规范化 JSON 证据另保留，原始响应字节 SHA 独立重算。

## 结论边界与旧失败

新 Grok→Codex 与 Claude→Codex 是本批次两个独立成功用例。先前 `provider-retest/Claude/live-attempt-v1/acceptance-audit.json` 已有 Codex→Claude 的完整真实回复和禁网原生恢复通过，本批次不重复调用；与本次 Claude→Codex 合起来形成这两个固定版本目标、合成纯文本历史的双向证据。

旧 `provider-retest/Codex/native-live-01/result.json` 仍为 false：上游虽返回正确答案，旧 QA 错将 Responses 声明元数据识别为执行对象，未把答案交付原生。不能用本批次成功或离线 guard 修复改写该结论。更早登录失败、SQLite 绝对路径 mock 失败和原目标追加的失败记录同样保留。

这不证明所有 CLI 版本、所有 provider、富媒体/工具历史或全部 Agent 对。新版本仍需离线精确验证后才扩 gate。失败停止规则为：请求、原生回复、完整决策、身份、前缀、来源、恢复或清理任何一项不通过，保留当次产物并停止该目标，不自动重试、换模型或重 import。
