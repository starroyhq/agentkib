# AgentKib 文档 / Documentation

产品简介和下载见仓库首页的 [README](../README.md)（[简体中文](../README.zh-CN.md)）。下面的文档按主题分组；大部分只有中文，标注 EN 的有英文版本。测试与验收记录在 [`qa/`](../qa) 目录，不在这里列出。

Start with the repository [README](../README.md) for the overview and downloads. Most documents below are in Chinese; those marked EN include English.

## 总览

- [功能与兼容矩阵](FEATURES.md)（EN）：各 Agent、各平台支持什么，以及能力边界。
- [升级指南](UPGRADING.md)（EN）：应用内更新、各安装包的升级方式与历史 macOS 包。

## 会话

- [实时会话](sessions/conversations.md)：在桌面和手机上查看、发送、审批，以及工具详情、斜杠命令、附件与产物。
- [会话互通](sessions/interoperability.md)：把会话交给另一个 Agent，原生导入支持的方向、版本和验收范围。
- [正文搜索与历史引用](sessions/content-search.md)：在本机会话里搜索正文，并把片段引用到当前草稿。
- [跨端阅读状态](sessions/read-state.md)：未读结果怎样在桌面、Web 和手机之间同步。
- [只读子代理](sessions/subagents.md)：查看主会话派出的子代理对话。
- [网页预览](sessions/web-preview.md)：在会话旁查看电脑上运行的网页。
- [发现与历史阅读](sessions/discovery.md)：工作区和会话从哪里来，找不到工作区时怎样排查。

## Agent 接入

- [连接 Claude Code 终端](agents/claude-code-terminal.md)：用插件把正在运行的 Claude Code 终端接到 AgentKib。
- [Claude Code 托管执行](agents/claude-code-managed.md)：由 AgentKib 启动 Claude Code 继续会话，以及审批、高级操作、斜杠命令、登录和额度采集的凭据边界。
- [Codex 托管执行](agents/codex-managed.md)：AgentKib 自己的 app-server、跟随 Codex 桌面端、按原 ID 续接、压缩和斜杠命令。
- [DeepSeek Harness](agents/deepseek-harness.md)：经插件接入运行中的 DSH，接入方案与分期进度。
- [Antigravity](agents/antigravity.md)：ACP 会话的接入范围和官方接口尚不支持的能力。
- [Devin](agents/devin.md)：只读读取 Devin CLI 与 Devin Desktop 共用的会话库，以及规则、Skills 与 MCP 的接入范围。

## 远程访问

- [手机访问](remote/phone-access.md)：用手机 App 或浏览器访问电脑：开通远程访问、授权档位、Codex 远控与产物查看。
- [账号与官方中继](remote/account-relay.md)：AgentKib Remote 账号、中继流量额度和隐私。
- [托管 Web 与局域网直连](remote/hosted-web-lan.md)：同一局域网内由浏览器直连电脑。
- [内置 Web 自部署](remote/self-hosting.md)：不用官方服务，自己配置 HTTPS 访问。
- [连接另一台电脑](remote/desktop-connections.md)（EN）：桌面之间的原生局域网连接。

## 资源库

- [Skill 管理](library/skills.md)（EN）：Skill 库、从本机 Agent 导入、GitHub 版本、部署、更新与撤销。
- [MCP 管理](library/mcp.md)：收录 MCP 服务、补齐到各 Agent，以及按 Agent 分配工具。

## 开发与发布

- [开发文档](DEVELOPMENT.md)（EN）：环境、架构、启动、验证命令和打包。
- [发布流程](development/release.md)（EN）：发布、重试、签名公证和更新元数据。
- [候选版检查清单](development/beta-checklist.md)（EN）：打标签前后的人工检查。
- [Windows 构建](development/windows.md)：在 Windows 11 x64 上从源码构建和打包。
- [额度采集器](development/quota-collector.md)：随应用打包的额度采集器的源码、补丁与构建校验。
- [界面术语](development/ui-terminology.md)：桌面和 Web 界面的用词约定。
- [新增一个 Agent](development/adding-an-agent.md)：接入新 Agent 要改的地方，分只读和受控两档。

## 历史归档

以下文档描述已经移除的 Rust 实现或迁移前的状态，只作历史参考：

- [Codex 原会话实验桥接](archive/codex-bridge.md)
- [Runtime 后端对照实验](archive/runtime-backend-comparison.md)
- [能耗与后台更新](archive/energy.md)
