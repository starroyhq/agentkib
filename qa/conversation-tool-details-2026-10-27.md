# 对话工具详情（第 1 步）— 2026-10-27

## 源码与范围

- 分支 `feat/conversation-tool-details`，独立 worktree，基于 `origin/main` `c5abfed36`（v0.21.0）。主 checkout 未改动；未推送、未开 PR、未合并。
- Node v26.12.0，macOS arm64。没有新增或升级依赖。本机 pnpm 12.10.1 无法执行（ENOEXEC），依赖目录从主 checkout 克隆，命令直接调用各包 `node_modules/.bin` 中的 vitest、tsc、vite、oxlint 和 oxfmt。
- 范围：Codex 与 Claude Code 的历史和实时工具条目带结构化详情与轮次时长；桌面会话页与 Web 共用 `@agentkib/session-ui` 的组件显示。规则见 [CONVERSATIONS.md](../docs/CONVERSATIONS.md) 的「工具详情与轮次时长」，术语见 [UI-TERMINOLOGY.md](../docs/UI-TERMINOLOGY.md)。

## 依据

读取本机会话记录时只统计条目类型、字段名和数量，没有读取或复制内容。

- 抽查 33 份 Codex 记录，全部使用 `event_msg/item_completed`，没有一份含 `exec_command_end` 或 `patch_apply_end`。原解析器只认后两种，所以只能显示一排 `exec`。
- 代码模式下，命令条目的 ID 与 `exec` 调用的 ID 不一致。抽样中有 4736 个命令条目所在的轮次恰好只有一个未配对的 `exec`，另有 308 个所在轮次有两个，无法确定归属，按设计保持独立行、不标父子。
- Claude Code 2.1.310 的 `toolUseResult`：Bash 为 `stdout`、`stderr`、`interrupted`；Edit 为 `structuredPatch` 加整份 `originalFile`；Write 带 `type`；Read 为 `file.filePath`、`numLines`。`system/turn_duration` 行带 `durationMs`。
- app-server 的实时形状以本机 `codex app-server generate-ts`（CLI 0.163.0）生成的定义为准。

测试夹具全部为合成数据，只沿用上述字段名。

## 验证结果

| 实际命令/检查 | 结果 |
| --- | --- |
| 归一化模块 `test/conversation-tools.test.ts`（kind 映射、状态、diff 计数、路径、脱敏、各项上限、32 KiB 截断） | 13/13 通过 |
| Codex 历史 `test/codex-history-tool-details.test.ts`（新旧格式、包装与子条目、ID 合并、失败命令、多文件改动、轮次时长、页预算） | 6/6 通过；去掉关联逻辑后对应用例失败（变异检查） |
| Claude 历史 `test/claude-history-tool-details.test.ts`（Bash、Edit、Write、Read，`turn_duration`，`originalFile` 不外泄） | 3/3 通过 |
| 实时 `test/live-tool-details.test.ts`（Codex `item/completed` 与 hydrate，Claude managed） | 3/3 通过 |
| session-ui 组件 `tool-details.test.tsx`（展开与读屏名称、diff 纯文本渲染、文件汇总、四语文案键、时长格式） | 11/11 通过 |
| 桌面与 Web 生产 `SessionTranscript` | 各 15/15 通过，各新增 1 项 |
| 桌面全量 `vitest run`（先构建 backend） | 441 个文件通过、1 个跳过；8783 项通过、3 项跳过 |
| Web 全量 `vitest run` | 69 个文件、1493 项通过 |
| backend `tsc --noEmit`、desktop `tsc -b`、web `tsc --noEmit` | 通过 |
| `oxfmt --check`（仓库格式范围） | 通过 |
| `oxlint` | 0 个错误；警告都在本轮未改动的文件中 |
| `git diff --check` | 通过 |

第一次桌面全量与 Web 全量、类型检查同时运行，`electron/main/web/relay/manager.test.ts` 中“frpc 忽略 SIGTERM 时被强制结束”一项失败（收到 SIGTERM 而非 SIGKILL）。该用例依赖真实子进程和 300 ms 计时，本轮没有改动 relay 代码；单独运行整个文件 63/63 通过，该项重复 3 次均通过，单独重跑桌面全量即为上表结果。worktree 未构建 backend 时，history-search worker 等 7 个文件会失败，构建后通过，这是改动前就有的前提。

## 视觉检查

用 playwright-cli 打开 Chromium，加载一个临时页面：Web 生产 `SessionTranscript` 加 `style.css`，输入为合成的一轮对话（读取、搜索、两次修改、失败与成功的命令、MCP、子代理、网页、被拒绝的命令和一个代码模式包装调用），另有一轮不带详情的旧记录。不启动 Backend 或模型，临时页面用后已删除。

- 900 px 浅色（zh-CN、en-US）和 390 px 深色下：包装行隐藏，过程标题为“用时 2 分 7 秒 10 次工具调用 · 1 失败”；失败的命令默认展开；轮末的“已修改 2 个文件 +7 -1”可就地展开着色的 diff；旧记录保持原来的“执行过程”行。
- 390 px 下页面宽度保持 390 px；长命令以省略号截断，状态、退出码和耗时仍然可见；diff 在预览框内横向滚动。
- 检查中发现并修复了三处：展开内容重复显示退出码；文件汇总中可展开的行没有箭头；横向滚动时较短行的增删底色断开。修复后每行宽度都等于预览框的滚动宽度。
- Tab 可以聚焦工具行，焦点环可见；读屏名称是组合好的标签，例如“Show details: Create test/parser.test.ts, 4 lines added, 0 lines removed”。

## 未验证与限制

- 没有用真实的 Codex、Claude Code 会话做端到端验收，也没有调用模型；结论只覆盖合成夹具和本机记录的字段统计。
- Claude stream-json 帧是否带结构化工具结果，尚未用真机帧核实。没有时实时行退回文本预览，轮次结束后由历史替换。
- 桌面查看其他电脑上的会话时走原生桌面远程，`remote-payload.ts` 的 schema 会去掉新字段，仍只显示工具名和状态；该路径的只读渲染器 `ConversationTranscript.tsx` 未改。
- 并行的代码模式调用无法确定归属时，`exec` 包装行仍会显示（上文 308 例的情形）。
- Antigravity 和其他 Agent 未接入；完整输出与完整 diff、撤销、进行中的条目与输出增量留到第 2 步。
- 没有执行 Windows、Linux、手机实机或打包安装验收。
