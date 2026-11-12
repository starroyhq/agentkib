# Devin 只读接入（一期）实施与验收

日期：2026-11-12；分支 `devin-integration`，基于 `origin/main` `bed199da0`（v0.28.0）。macOS arm64，Node v26.13.0。

## 范围

一期只读：发现、会话列表与历史、正文搜索、交接来源和交接文件目标、上下文预览、Skills/MCP 路径、工具链检测。在 AgentKib 里继续或新建 Devin 会话（`devin acp`）属于二期，本批不做。设计与边界见 [docs/agents/devin.md](../docs/agents/devin.md)。

## 关键决定

- 历史只读 `sessions.db`，不启动 `devin acp`。本机核实过：ACP 的 `session/list` 不登录也能用，但读历史要启动进程，还会被正在 Desktop 中打开的会话锁住；直接读库能拿到同样的信息，而且不受会话锁影响。
- 放行条件是必需列存在，且 `schema_compat_version` 为已知值，迁移版本号不拦截。标记值未知时会话降级为只显示元数据，测试覆盖了这条路径。
- Devin 的 Manifest 适配器默认关闭（与 OpenCode、Grok Build、Antigravity 一致）。上下文预览中按需激活的规则不并入常驻内容，并给出提示。
- 洞察（credits/ACU 和 tokens）不在本批范围，留给后续。

## 本机核实

- Devin Desktop 以子进程运行自带的 CLI 3000.12.43：`devin acp`、`acp --agent-type summarizer`、`acp --agent-type codemap`。PATH 上没有独立安装的 `devin`；`devin auth status` 显示未登录。
- 会话库 `~/.local/share/devin/cli/sessions.db`：迁移 v20，`schema_compat_version = 0`。只读查看过表结构和计数，没有读取正文。
- 用临时测试只读跑过真实库（跑完已删除）：6 个可见会话全部可读，没有分页警告；压缩链完整接回（glaz 会话还原出 27 条用户消息，和库里不重复的消息 ID 数一致）；最长会话首屏 2.3 秒，其余在 0.3–0.7 秒；列表耗时 0–2 ms；读完后库文件和辅助文件都没有变化。

## 验证

本机 pnpm 12.10.1 的工具目录没有装完整，自动切换版本时报 `ENOEXEC`。按以往 QA 的做法，改用本机 pnpm 10.8.1，并用临时 userconfig 设置 `manage-package-manager-versions=false`；没有改动依赖或锁文件。

| 命令 | 结果 |
| --- | --- |
| `pnpm format:check` | 通过，1270 个文件 |
| `pnpm lint` | 退出 0，269 条 warning，新增代码没有 warning |
| `pnpm typecheck` | 通过（backend、desktop、web） |
| `pnpm --filter @agentkib/desktop test`（`VITEST_MAX_WORKERS=3`） | 首轮 543 个文件、10448 个用例中有 6 个失败，都是 Agent 枚举类断言（MCP 目标从 8 个变为 9 个，Doctor 多出 Devin 的重复指令警告）；更新后这 6 个文件复跑通过 |
| `pnpm test:web` | 87 个文件、1803 个用例全部通过 |
| `node .github/scripts/verify-ci-quality-partition.mjs` | `exactlyOnce: true`，543 个文件 |
| `pnpm build` | 通过（协议生成、Web、renderer、backend 与 Electron 构建） |

新增 `apps/desktop/test/devin-sessions.test.ts`（8 个用例），用合成库覆盖：隐藏会话与工作区过滤、库未被打开时不产生辅助文件、压缩链与复制去重、回答与过程说明的判定、ACP 工具详情（命令、差异、读取）、分页游标、交接文档的两种模式、图片、搜索记录、未知存储格式、`DEVIN_SESSIONS_DIR`，以及上下文来源和 `read_config_from`。

## 未验证与剩余风险

- Windows 和 Linux 的数据与配置路径按文档实现，没有实机验证；Devin Desktop 在这两个平台上自带 CLI 的位置未知，所以没有检测。
- 会话库是 Devin 的私有格式，Devin 升级可能改变结构。目前依靠兼容标记和必需列做闸门，变化后需要重新核验。
- 交接文件启动 Devin 要求 PATH 上能找到 `devin`；只装了 Devin Desktop 时，这个入口显示为不可用。
