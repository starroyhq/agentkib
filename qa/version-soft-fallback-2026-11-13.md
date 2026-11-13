# 版本软回退：核对记录（2026-11-13）

## 为什么改

几处版本判断会把用户直接挡在外面：

- Codex：只认 PATH 找到的那一份 `codex`。没装 CLI、只装了 Codex 桌面端，或者 PATH 上是一份旧的 npm 安装，托管 Codex 会话就整个变成只读；`--version` 的写法稍有变化（不是 `codex-cli X.Y.Z`），所有人同时变成只读。
- DeepSeek Harness：插件的 `engines.dsh` 写着 `<0.3.0`。DSH 在范围外会停用插件，AgentKib 也不会在后台启动它，DSH 一升到 0.3.0 就连不上。
- Claude Code：PATH 上那份低于 `2.1.263` 时报“没找到 Claude Code”，别处装着的新版本也不用。

改法见 [Codex 托管执行](../docs/agents/codex-managed.md)的“执行策略与版本适配”、[DeepSeek Harness](../docs/agents/deepseek-harness.md) 和 [Claude Code 托管执行](../docs/agents/claude-code-managed.md)。

## 用真实程序核对的事实

都只读，或在临时目录里运行，没有登录、没有模型请求，不读写用户的 `~/.codex`、`~/.claude`。

| 项目 | 结果 |
| --- | --- |
| Homebrew 的 `codex --version` | `codex-cli 0.167.0` |
| ChatGPT.app 26.1106 自带的 CLI | 在 `Contents/Resources/codex-cli/bin/codex`，是一个 shell 启动脚本，转到同目录上一级的 `CodexCLI.app/Contents/MacOS/codex`；旁边的 `codex-package.json` 写着 `layoutVersion: 1`、`version: 0.167.0-alpha.4.1`、`entrypoint: bin/codex`；`--version` 输出 `codex-cli 0.167.0-alpha.4.1` |
| 两份 CLI 的 `app-server --stdio`，临时 `CODEX_HOME`，只发 `initialize` | 回包都有 `userAgent`，格式是 `<clientInfo.name>/<版本> (<系统>; <架构>) …`，例如 `agentkib/0.167.0 (Mac OS …; arm64) …`；桌面端那份是 `…/0.167.0-alpha.4.1 (…)`。runner 用它在第一轮之前再核一次版本 |
| DSH Desktop 自带的 `dsh --version` | `0.2.2-rc.1`，在原来的范围里；去掉上限后同样能启动 |

Agents Anywhere 的参考实现里，旧版独立 Codex.app 的 CLI 在 `Contents/Resources/codex`，这个位置也列入了候选；独立 Codex.app 新版本的布局没有核对过（本机没有安装），按 ChatGPT.app 的 `codex-cli/bin/codex` 一并列入。

## 自动测试

- `apps/desktop/test/codex-runtime-preflight.test.ts`：PATH 上那份过旧时改用桌面端那份；PATH 上那份能用时不运行其他的；能确认版本的优先于读不出版本的，没有能确认的时才试用读不出的；都不能用时保持只读，原因取最前那份；找到桌面端自带 CLI 的位置（只收可执行文件）；`--version` 与 `userAgent` 的版本解析。
- `apps/desktop/test/codex-auto-continue.test.ts`：app-server 报告的版本低于 `0.147.0` 时，第一轮之前停下，返回 `codex-cli-version-too-old`，没有发出 `turn/start`；报告的是新版本时照常发送。
- `apps/desktop/test/claude-version.test.ts`：PATH 上那份够新时用它；过旧时改用常见位置里够新的那份；都过旧时原因是“版本过低”而不是“没找到”。`claude-background-setting.test.ts` 覆盖后台任务开关在这种情况下的说明。
- `apps/desktop/test/dsh-managed-runtime.test.ts`：插件 `engines.dsh` 只有下限；0.3.0、1.0.0 都能启动；低于最低版本仍然不启动。

## 没有覆盖的

- 用桌面端自带的 CLI 真正跑一轮：需要用户的 Codex 登录并消耗额度，没有做。`--version` 和 `initialize` 已在真实二进制上核对。
- DSH 0.3.0 还没有发布，去掉上限后在真实 0.3.0 上的表现没有验证；DSH 那时若因别的原因停用插件，AgentKib 仍按 stderr 里的停用记录报原因。
- 已经装在用户 DSH profile 里的 0.7.0 及更早插件仍带着 `<0.3.0`，到 DSH 0.3.0 时需要重新安装 AgentKib 随附的插件（0.7.1）。
- Claude Code 的版本格式仍按 `X.Y.Z (Claude Code)` 严格识别，没有放宽。
