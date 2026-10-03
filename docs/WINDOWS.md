# AgentKib Windows 11 x64 构建、安装与使用指南

本文对应 Windows 第一阶段目标：在 Windows 11 x64 上从源码完成环境诊断、开发启动、NSIS 打包、安装和启动。它不代表所有业务功能已经完成与 macOS 的等价验收。

## AgentKib 是什么

AgentKib 是一个本地优先的 Coding Agent 资产中心。它发现 Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes 和 DeepSeek Harness 已使用过的工作区，并集中展示其中的 Instructions、Skills、MCP、记忆和原生配置。

主要页面和功能如下：

- **首页**：查看工作区、Agent、资产、额度和近期活动概况。
- **工作区**：查看自动发现或手动添加的项目；进入项目后可查看概览、资产、有效上下文和待应用变更。
- **资产**：按类型集中查看 Instructions、Skills、MCP、记忆及其他 Agent 配置。
- **Agent**：查看支持的 Agent 是否已安装、配置目录和发现到的资产。
- **额度**：展示本机能够读取到的额度窗口、余额和重置时间；数据源不可用时会明确标记。
- **洞察**：汇总 Token、会话、Git 提交、工作区热度和成就等本地统计。
- **设置**：管理扫描目录、关闭行为、语言、主题、MCP Hub、远程 Gateway 和 Obsidian 集成。

发现和浏览不会直接修改 Agent 配置。需要同步公共资产时，AgentKib 会先生成 ChangeSet 和完整 Diff，确认后才写入。

### Agent 支持矩阵

| Agent            | 发现与盘点 | 上下文诊断与同步 | 会话浏览与交接 |
| ---------------- | ---------- | ---------------- | -------------- |
| Codex            | 支持       | 支持             | 支持           |
| Claude Code      | 支持       | 支持             | 支持           |
| Cursor           | 支持       | 支持             | —              |
| OpenCode         | 支持       | 支持             | —              |
| OpenClaw         | 支持       | 支持             | —              |
| Hermes           | 支持       | 支持             | —              |
| DeepSeek Harness | Beta，只读 | 仅诊断，不写入   | —              |

## 一、安装编译环境

以下命令在 PowerShell 中执行。推荐使用与项目 CI 一致的版本。

### 1. Node.js 22 和 pnpm 10.8.1

```powershell
winget install --exact --id OpenJS.NodeJS.22 --source winget --accept-package-agreements --accept-source-agreements
```

安装后重新打开 PowerShell，再执行：

```powershell
corepack enable
corepack prepare pnpm@10.8.1 --activate
node --version
pnpm --version
```

预期 Node.js 主版本为 `22`，pnpm 为 `10.8.1`。

如果 PowerShell 提示无法加载 `pnpm.ps1`，可只为当前 Windows 用户启用常用的本地脚本策略，然后重新打开 PowerShell：

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

`RemoteSigned` 允许本地脚本运行，但从网络下载且未解除阻止的脚本仍需签名。

### 2. Visual Studio Build Tools 2022 和 Windows SDK

```powershell
winget install --exact --id Microsoft.VisualStudio.2022.BuildTools --source winget --accept-package-agreements --accept-source-agreements --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

该工作负载应包含 MSVC x64/x86 编译工具和 Windows 10/11 SDK。若安装器提示重启，请先重启 Windows。

### 3. 一键诊断

在仓库根目录执行：

```powershell
pnpm diagnose:windows
```

诊断为只读操作，会检查系统架构、Git/Node/pnpm、MSVC、Windows SDK，以及 GitHub 连通性。必需项缺失时会返回非零退出码和修复提示。

## 二、安装项目依赖

在仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
```

首次开发启动或打包时，项目还会下载并校验固定版本的 Windows 额度 Collector sidecar。

## 三、开发模式启动

```powershell
pnpm dev
```

`pnpm dev` 使用 TypeScript backend。启动后会打开带 Windows 原生标题栏的 **AgentKib Dev** 主窗口。开发版 identifier 为 `ai.agentkib.dev`，可以与正式安装版同时运行。

- 停止开发服务：回到运行命令的终端按 `Ctrl+C`。
- 关闭主窗口：首次关闭会询问“隐藏到托盘”或“退出”；选择隐藏后会记住该行为，应用继续在后台运行。
- 恢复窗口：单击托盘图标，或右键托盘图标选择打开应用。
- 完全退出：在托盘菜单选择“退出”。

## 四、基本使用

1. 首次启动后等待自动发现完成。AgentKib 只从支持的 Agent 元数据和显式扫描目录发现工作区，不会默认扫描整块磁盘。
2. 打开“工作区”，确认项目路径、来源、资产数量和警告；没有自动发现时，可手动添加工作区或扫描目录。
3. 在“资产”和“Agent”中查看现有 Instructions、Skills、MCP、Hooks、Profiles 和配置。
4. 进入工作区的“上下文”，选择 Agent 和工作目录，检查实际加载顺序、作用域、覆盖关系和潜在冲突。
5. 需要同步公共资产时，在变更页查看完整 Diff。确认目标路径和内容后再应用；涉及 Agent Home 的写入会单独请求授权。
6. 在“设置”中按需配置 MCP Hub、Obsidian 或 OpenClaw/Hermes Remote Gateway。这些集成默认不会自动启用。
7. 在“额度”和“洞察”中查看本机可获得的数据。数据源缺失或不完整时，界面会显示不可用或部分覆盖，而不是推测结果。

DeepSeek Harness 当前为 Beta 只读目标，不会被写入或配置 MCP。

## 五、构建 NSIS 安装包

```powershell
pnpm dist:electron
```

构建成功后，安装包位于：

```text
apps\desktop\release-electron\AgentKib_*_windows-*.exe
```

双击安装包，完成后可从 Windows 开始菜单搜索并打开 **AgentKib**。当前内部测试包未做代码签名，Windows SmartScreen 可能显示未知发布者；请确认文件确实来自自己的本机构建后再选择继续。

## 六、本地数据位置

正式安装版数据默认存放在：

```text
%LOCALAPPDATA%\ai.agentkib
```

`pnpm dev` 启动的开发版使用独立目录：

```text
%LOCALAPPDATA%\ai.agentkib.dev
```

两个目录分别保存 SQLite 数据库、偏好、缓存、备份、会话索引、额度与 Obsidian 配置以及 MCP 包。开发版不会复制、迁移或合并正式版数据。卸载前如需保留数据，请备份对应目录；不要把这些目录、`node_modules`、`target` 或安装包提交到 Git。

从旧预览版首次启动正式版时，如果新目录尚不存在，AgentKib 会将旧数据目录一次性迁移到正式版目录；开发版不会执行该迁移。

## 七、常见问题

### 浏览器能打开 GitHub，但 Git 无法 clone

先检查 Git 是否仍指向已经变化的 Clash 端口：

```powershell
git config --global --get-urlmatch http.proxy https://github.com/starroyhq/agentkib.git
Get-NetTCPConnection -State Listen | Where-Object LocalAddress -eq "127.0.0.1"
```

确认 Clash 当前 HTTP/Mixed 端口后，只给 GitHub 更新代理，例如：

```powershell
git config --global http.https://github.com.proxy http://127.0.0.1:7897
git ls-remote https://github.com/starroyhq/agentkib.git refs/heads/main
```

端口 `7897` 只是示例，必须以本机 Clash 实际配置为准。

### Sidecar 下载失败

只在当前构建会话设置代理，不要把本机端口写进仓库：

```powershell
$env:HTTP_PROXY = "http://127.0.0.1:7897"
$env:HTTPS_PROXY = "http://127.0.0.1:7897"
pnpm dev
```

### 找不到 `link.exe`、MSVC 或 Windows SDK

重新打开 Visual Studio Installer，确认 Build Tools 2022 已安装“使用 C++ 的桌面开发”，并包含 MSVC x64/x86 与 Windows 10/11 SDK；安装完成后重开终端，必要时重启 Windows。

### `localhost:1420` 端口被占用

开发服务器默认使用端口 `1420`。先结束占用该端口的旧 Vite/Node 进程，再重新运行 `pnpm dev`。

```powershell
Get-NetTCPConnection -LocalPort 1420 -ErrorAction SilentlyContinue
```

### SmartScreen 阻止安装

当前安装包未签名，可能触发 SmartScreen。只对从 AgentKib GitHub Releases 下载且 SHA-256 校验一致，或自己刚构建并确认路径、时间和文件名无误的安装包选择“更多信息”并继续；后续正式签名版本应移除这项限制。

## 当前阶段限制

- 已验收目标仅为 Windows 11 x64 的编译、开发启动、NSIS 安装和启动。
- Windows ARM64 仅提供 Preview 安装包，尚未完成与 x64 等价的原生回归。
- GitHub Release 已由版本标签自动发布；具体升级方式见[升级指南](UPGRADING.md)。Windows 安装包仍未进行代码签名，ARM64 仍为 Preview。
- macOS/Linux 行为通过平台隔离和现有 CI 保持，本机无法替代对应平台的原生回归。
- 完整 Windows 功能等价测试仍需后续阶段逐项完成。
