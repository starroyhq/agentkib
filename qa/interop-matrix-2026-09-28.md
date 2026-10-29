# 原生来源方向矩阵与终端验收（2026-09-28）

本轮在 `/Users/user/.codex/worktrees/all-agent-continuation/agentkib` 实施；源码基线 `057da8b81a3f3c9536a568287175af8e50c12176`，工作区 dirty，保留此前所有改动。没有提交、推送、依赖升级或覆盖用户安装。

## 自动化范围

新增 `crates/agentkib-conversations/src/interop_matrix.rs`，通过各产品的原生记录解析链路生成 `SessionDocument`，随后执行五种已实现目标格式转换。没有用修改 `source.agent` 标签代替来源解析。

| 来源            | 本测试实际入口                          | 固定原生记录                                                |
| --------------- | --------------------------------------- | ----------------------------------------------------------- |
| Claude Code     | `read_claude_document`                  | 带 UUID / parentUuid 的 JSONL 用户和助手正文                |
| Codex           | `read_codex_document`                   | `response_item` / `input_text` / `output_text`              |
| OpenCode        | 官方 export 结构解析器                  | `messages.info` + `parts`，排除 reasoning                   |
| Hermes          | provider 列表及 `read_session_document` | SQLite `sessions/messages`，排除 inactive 分支              |
| Grok Build      | 原始 JSONL 解析器                       | `type` 判别的 user / assistant 原始内容                     |
| Antigravity ACP | 实际 replay 解析器                      | user/agent message chunks，排除 thought chunk               |
| Cursor CLI      | provider 列表及 `read_session_document` | 2026.09.26 serializer fixture，SQLite/protobuf/hash         |
| OpenClaw        | provider 列表及 `read_session_document` | schema 23 SQLite 原始事件与 active projection，排除废弃分支 |

以上 8 来源 × Claude Code、Codex、OpenCode、Hermes、OpenClaw 5 目标，共 **40 格式组合**。断言角色、顺序、正文、脱敏、来源损失保留；Claude/Codex 使用现有原生 roundtrip 校验，OpenCode 使用严格 export 回读校验，Hermes/OpenClaw 比较目标预览投影。额外 Grok 工具/附件回归检查原始 tool call/result ID 关联、源 reasoning 排除、目标工具摘要计数、附件省略计数，以及工具参数/输出不进入新目标载荷。

```sh
cargo test -p agentkib-conversations interop_matrix --lib -- --nocapture
```

结果：2 passed。这里的 40 个组合是解析/转换集成覆盖，不是 40 次官方导入或真实模型回复。CLI 进程、UI、模型、复杂分叉、长历史等需要各自验收；已有单 provider 测试仍承担其细节边界覆盖。

测试通过 `AGENTKIB_LIVE_FIXTURE_DIR=<独立绝对目录>` 可导出新版 OpenClaw SQLite → Claude / OpenCode / Hermes 的实际生产 renderer 载荷、预期文档、独立工作区及 SHA256 清单。该模式保留实际源临时目录，同时复制逐字节快照；普通测试自动清理临时目录。

## 终端与重启读取

全部使用隔离 HOME / XDG / HERMES_HOME、合成历史与固定版本临时安装。只恢复历史，没有给 OpenCode/Hermes 发送模型 prompt；没有读取或复制用户历史、凭据。PTY 内容是目标 CLI 自己实际绘制的历史，不以数据库内容替代界面验收。

- OpenCode `1.18.32`：`opencode --session <id>` 两次独立 PTY 进程都显示用户及助手历史。原先独立 synthetic probe 的日志为 `/tmp/agentkib-tui-acceptance-2026-09-28/opencode-{0,1}.pty`。
- Hermes `0.21.5 (2026.9.24)`：官方 `sessions import --from claude <file>`，随后 `--resume <id>` 两次独立 PTY 都显示 `Previous Conversation` 和导入的随机 marker、项目 storage namespace。日志为同目录 `hermes-{0,1}.pty`。没有授权时 CLI 先停留于 setup 引导；隔离设置 `OPENAI_BASE_URL=http://127.0.0.1:9/v1`，拒绝 provider setup 后即可只读显示历史；此 localhost 地址不可用，没有配置假远程密钥或真实模型。
- Claude Code `2.1.282`：恢复 root 已完成真实单轮回复的 `c8b6dbf7-116d-405c-930d-67a213e3aa4a`。使用隔离 `CLAUDE_CONFIG_DIR` 与用户原 settings 路径，safe mode、禁用 tools/MCP；首次主题设置及自建工作区信任后，实际显示导入正文和之后的真实回复。Ctrl+L 重绘日志 `/tmp/agentkib-tui-acceptance-2026-09-28/claude-native-tty.pty`，随后 Ctrl+C 两次正常退出，本次仅 UI 恢复没有新模型请求。

Claude 命令：

```sh
CLAUDE_CONFIG_DIR=/private/tmp/agentkib-interop-2026-09-28/claude-reply-1 \
  /Users/user/.local/bin/claude --safe-mode \
  --settings /Users/user/.claude/settings.json --setting-sources '' \
  --strict-mcp-config --tools '' \
  --resume c8b6dbf7-116d-405c-930d-67a213e3aa4a
```

工作目录为 `/private/tmp/agentkib-live-matrix-2026-09-28/openclaw/workspace`。随机 marker `bcfda855-8982-4e6d-926f-4a9c134811d5`，项目决策 namespace `56c7e90f-d85f-4c94-aeec-2f83d5884ed1` 均可见。真实回复结果由 root 单独记录，本记录不冒充额外模型调用。

第一次 Claude Python `pty.fork` 捕获停于首次引导，runner 的退出等待出现阻塞；随后改用宿主原生 TTY 完成实际恢复与正常退出。前者不计通过，也不误记为产品丢失历史。该 runner 已停止。OpenCode/Hermes 双次 PTY 和 Claude 原生 TTY 的文本断言汇总：同目录 `results.json`，5/5 可见。

**源码保护证据边界：** 初次 Claude 真实回复使用的 `source.sqlite` 是 provider 读取后的逐字节快照；最初原临时目录当时已自动清理，所以后续 SHA 不变只证明该快照不变。当前测试已另加 provider 读取前后实际源 DB 字节相等断言，并让后续 LIVE 导出保留实际源目录。不能把初次快照的 SHA 校验称作原临时 DB 在模型调用后仍存在且不变。

## 生产转换载荷的 OpenCode / Hermes 完整离线复核

为避免只验旧手写目标 fixture，又执行了以下独立链路：schema 23 SQLite 原始源 → OpenClaw provider → 脱敏 `SessionDocument` → `prepare_native_import` → 官方导入命令 → 两次独立目标 TUI 恢复 → 再次严格回读。

```sh
AGENTKIB_LIVE_FIXTURE_DIR=/tmp/agentkib-tui-rendered-2026-09-28 \
  cargo test -p agentkib-conversations interop_matrix --lib
python3 /tmp/agentkib-tui-acceptance-2026-09-28/rendered-probe.py
```

结果：OpenCode 与 Hermes 的两次 TUI 恢复共 4/4 显示随机 marker `63ebeac9-d720-4321-bce2-f224ba52b8a3` 和 namespace `497c0d19-7ef5-403c-98ff-358c571b1108`。恢复后 OpenCode 官方 export、Hermes SQLite 消息的每条角色/全文与对应 `*-expected.json` 精确一致。Hermes 原生 sessions 表仍只有一个对象；本次保留的实际来源 SQLite 及快照 SHA 均未变化。没有发模型请求，没有 tool 历史重放。

- 输入与目标预览：`/tmp/agentkib-tui-rendered-2026-09-28/openclaw/`
- 日志：`/tmp/agentkib-tui-acceptance-2026-09-28/rendered-{opencode,hermes}-{0,1}.pty`
- 结果：同目录 `rendered-results.json`

这些结果证明指定版本的离线历史显示与进程重启恢复，仍不代替 OpenCode/Hermes 的真实模型续接验收。

## 其他来源的真实验收载荷

新增 ignored 测试 `export_six_native_sources_for_live_acceptance`：为 Claude Code、Codex、OpenCode、Hermes、Grok Build、Antigravity ACP 分别生成独立随机 marker/namespace、原生格式文件、真实解析后的文档和现有 Claude renderer 产物。原始文件保留到验收结束；manifest 记录实际文件路径及 SHA。输出目录已存在 case 时直接拒绝覆盖。此测试自身不调用模型。

```sh
AGENTKIB_LIVE_FIXTURE_DIR=/tmp/agentkib-live-matrix-six-2026-09-28 \
  cargo test -p agentkib-conversations export_six_native_sources_for_live_acceptance \
  --lib -- --ignored --nocapture
```

Cursor 未包含在该随机 live 载荷导出中；当前固定 protobuf fixture 只进入前述 40 格式组合自动化测试。不能因此宣称 Cursor 已通过随机上下文真实回复验收。
