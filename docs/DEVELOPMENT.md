# Development / 开发文档

[English](#english) · [简体中文](#简体中文)

<a id="english"></a>

## English

This guide covers local development, validation, and packaging for the current Electron desktop application. Contributor workflow and pull request expectations remain in [CONTRIBUTING.md](../CONTRIBUTING.md).

### Prerequisites

- Node.js 22.22.2 or later in the 22.x series (Node.js 24.15+ and 26+ are also supported by the test dependencies)
- pnpm 12.10.1, as pinned by the root `packageManager` field
- Git

Platform-native build dependencies:

- **macOS 13.3+**: Xcode Command Line Tools
- **Windows 11**: Visual Studio Build Tools 2022 with Desktop development with C++, and a Windows 10 or 11 SDK. Follow the [Windows guide](development/windows.md).
- **Ubuntu 22.04**: `build-essential`, `pkg-config`, `libssl-dev`, and `libgtk-3-dev`
- **Fedora 42**: GCC/G++, Make, OpenSSL and pkg-config development packages, GTK 3 development packages, and RPM packaging tools. The exact CI baseline is in [linux.yml](../.github/workflows/linux.yml).

Enable the pinned pnpm version, then install dependencies from the repository root:

```bash
corepack enable
corepack prepare pnpm@12.10.1 --activate
pnpm install --frozen-lockfile
```

### Architecture

The Electron main process owns the native shell, trusted preload IPC and remote HTTP access. It connects to a shared TypeScript backend for workspace data, session Providers, control receipts and Project Agent orchestration. Electron supplies the bundled Node runtime. File replacement and rollback use the staged Koffi module, unpacked from ASAR in installed apps.

The desktop renderer and remote Web app share session components from `packages/session-ui` and inject their platform services through `session-platform`. New session operations use `session.request` and the Provider interface. Shared runtime methods, schemas and capabilities live in `packages/runtime-protocol`. See the full request path and rules in the [architecture guide](development/architecture.md) (Chinese).

The build commands generate the Electron protocol entry and stage native artifacts in the order defined in `apps/desktop/package.json`. See [quota collector build and verification](development/quota-collector.md) for the separate quota and local cost sidecar.

Quota RPC compatibility: `quota.snapshot` and `quota.collectorStatus` remain available; `quota.refresh` accepts an optional `{provider}` and refreshes every enabled provider when omitted. Each completed provider emits `quota.updated` immediately. Local estimates use `quota.costSnapshot`, `quota.costStatus`, `quota.refreshCost` with `{provider: "codex" | "claude", force?: boolean}`, and `quota.observeCosts` with `{provider: "codex" | "claude" | null}`. The `force` flag bypasses application scheduling only; it does not request an upstream full rescan. `quota.costUpdated` carries normalized snapshot/status data. Renderer observation IPC is trusted-desktop-only and is cleared on navigation, destruction, hiding and runtime restart; clients cannot select log roots or identities. The existing private SQLite receives additive cache tables without changing schema 15, so prior quota caches remain readable.

`apps/desktop/electron.vite.config.ts` configures electron-vite for the main process, preload, and React renderer. `pnpm dev` builds main and preload once and runs renderer HMR. Renderer changes, including those in shared UI packages, keep the Electron client connected to the local runtime. Restart Dev to apply changes to main or preload. The backend and its workers use an independent Vite build in `vite.backend.config.ts`, followed by native-module staging. Vitest configuration lives in `vitest.config.ts`. Release jobs can still build the renderer (`build:web`) and Electron processes (`electron:build`) separately, and electron-builder packages the existing `dist/` and `dist-electron/` output directories.

### Start development

```bash
pnpm dev
```

This launches **AgentKib Dev** with its own Electron window profile. Dev and stable on the same application version share the per-user TypeScript runtime and its Agent session events. The runtime uses the existing stable application data directory and one authenticated local socket or pipe. A different desktop version waits for the previous runtime to finish shutting down, including saving any confirmed work to continue, before starting a replacement. Close older desktop clients that are still connected, or use isolated Dev mode to run two versions side by side.

Close any older standalone AgentKib version before launching the shared runtime. Existing stable terminal credentials are reused. The runtime also reuses eligible legacy Dev Claude credentials when the native session and registered workspace match and outstanding commands are settled. The old Dev database remains available in isolated mode.

To test backend or database changes with the isolated Dev profile, use:

```bash
AGENTKIB_DEV_ISOLATED=1 pnpm dev
```

Restart all clients and let the shared runtime exit before starting it with rebuilt backend code. On macOS the old Dev profile is under `~/Library/Application Support/ai.agentkib.dev`. On Windows it is under `%LOCALAPPDATA%\ai.agentkib.dev`. Linux uses the corresponding system application-data location.

### Validation commands

Run the smallest checks relevant to the change. The full local baseline is:

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

Useful focused commands:

```bash
# Apply the configured TypeScript/React formatter
pnpm format

# Diagnose the Linux build environment without changing it
apps/desktop/scripts/diagnose-linux.sh --strict

# Diagnose Windows tools and network access from PowerShell
pnpm diagnose:windows
```

The read-only workspace CLI is available through pnpm:

```bash
pnpm --silent agentkib scan <project>
pnpm --silent agentkib context <project> <agent> [cwd]
pnpm --silent agentkib plan <project>
pnpm --silent agentkib validate <project>
pnpm --silent agentkib manifest <project>
```

The CLI builds the TypeScript backend on first use and keeps its temporary validation database outside the project.

`pnpm test` builds the TypeScript backend before running Vitest. `pnpm build` produces application code for the current platform but does not create an installer.

### Pull request CI

The quality workflow runs ordinary desktop tests in two shards, the serial filesystem/MCP projects in a separate job, Web tests in another job, and formatting/lint/type checks/builds/helper tests in another. Each job has its own checkout and build output; do not run a backend build concurrently with tests in the same checkout. The filesystem and MCP projects retain their serial file execution and group order. `node .github/scripts/verify-ci-quality-partition.mjs` verifies that the two shards and safety projects cover every desktop test file exactly once

The existing required check, **Test, lint and build**, waits for every quality job and rejects failures, cancellations, missing results, or unexpected skips. Only pull requests whose complete merge-base diff consists of ordinary additions/modifications to the four root documents (`README.md`, `README.zh-CN.md`, `CONTRIBUTING.md`, `SECURITY.md`) or directly contained `docs/*.md` / `qa/*.md` use the documentation fast path. Renames, deletions, copies, executable/symlink changes, nested files, probes, assets, and uncertain classification run full validation. Pushes to `main` always run full validation

The documentation fast path applies only to this quality workflow. Both Linux and both Windows checks, including native backend stability and Windows uninstall/rollback assertions, retain their existing behavior. Local validation and production build commands are unchanged

### Package the desktop app

```bash
pnpm dist:electron
```

Packages are written to `apps/desktop/release-electron/`. Packaging prepares and verifies the platform quota sidecar, builds the renderer and Electron processes, and invokes electron-builder. The package uses the TypeScript backend and contains no Rust Runtime.

Windows x64 quota collection uses the pinned Win-CodexBar 0.60.3 prebuilt console CLI. `pnpm quota:prepare` downloads its release ZIP, verifies the pinned SHA-256, and stages `codexbar-cli.exe` as `agentkib-quota-sidecar.exe`. Windows ARM64 quota collection remains unavailable.

Do not publish local packages as official releases. Maintainers should follow the [release process](development/release.md), which defines version synchronization, immutable tags, signing, notarization, checksums, and platform artifacts.

---

<a id="简体中文"></a>

## 简体中文

本文说明当前 Electron 桌面应用的本地开发、验证与打包方式。贡献流程和 Pull Request 要求仍保留在根目录的[贡献指南](../CONTRIBUTING.md)中。

### 环境要求

- Node.js 22.22.2 或更新的 22.x 版本（测试依赖也支持 Node.js 24.15+ 和 26+）
- 根目录 `packageManager` 固定的 pnpm 12.10.1
- Git

各平台原生构建依赖：

- **macOS 13.3+**：Xcode Command Line Tools
- **Windows 11**：带“使用 C++ 的桌面开发”工作负载的 Visual Studio Build Tools 2022，以及 Windows 10 或 11 SDK。完整步骤见 [Windows 指南](development/windows.md)。
- **Ubuntu 22.04**：`build-essential`、`pkg-config`、`libssl-dev` 和 `libgtk-3-dev`
- **Fedora 42**：GCC/G++、Make、OpenSSL 与 pkg-config 开发包、GTK 3 开发包和 RPM 打包工具。准确的 CI 基线见 [linux.yml](../.github/workflows/linux.yml)。

启用固定的 pnpm 版本，然后在仓库根目录安装依赖：

```bash
corepack enable
corepack prepare pnpm@12.10.1 --activate
pnpm install --frozen-lockfile
```

### 架构

Electron 主进程负责原生窗口和系统集成、可信 preload IPC 及远程 HTTP 访问。共享 TypeScript 后台负责工作区数据、会话 Provider、控制回执和项目 Agent 编排。Electron 自带 Node Runtime，原生文件替换和回滚使用暂存并从 ASAR 解包的 Koffi 模块。

桌面 renderer 和远程 Web 在 `packages/session-ui` 共用会话界面，通过 `session-platform` 注入平台服务。新会话操作走 `session.request` 和 Provider 接口。Runtime 方法、数据结构和能力声明集中在 `packages/runtime-protocol`。完整请求路径、代码放置和检查规则见[架构约定](development/architecture.md)。

开发与构建命令按 `apps/desktop/package.json` 中的顺序生成 Electron 的协议入口并暂存原生产物。额度和本机费用由独立的采集器提供，构建和校验见[额度采集器说明](development/quota-collector.md)。

`apps/desktop/electron.vite.config.ts` 统一配置 electron-vite 的主进程、preload 和 React renderer。`pnpm dev` 在启动时构建主进程和 preload，运行期间热更新 renderer。界面和共享 UI 包的改动会保留当前 Electron 客户端与本地服务的连接。主进程或 preload 改动需要重启 Dev。Backend 及其 worker 通过 `vite.backend.config.ts` 独立编译，再暂存原生模块。Vitest 配置位于 `vitest.config.ts`。发布流程仍可通过 `build:web` 和 `electron:build` 分别构建 renderer 与 Electron 进程，electron-builder 继续打包现有的 `dist/` 和 `dist-electron/` 目录。

桌面 preload 的 `paths.displayContext()` 经可信 renderer 校验后返回本机主目录，供界面缩写路径。它是无参数的只读 IPC。

### 启动开发环境

```bash
pnpm dev
```

该命令启动 **AgentKib Dev**，它保留独立的 Electron 窗口配置。同版本的 Dev 和正式版共享该系统用户的 TypeScript 运行时和会话事件。运行时使用正式版原有数据目录，通过认证的本地 socket 或命名管道通信。异版本桌面会等上一个运行时结束，包括保存已确认要继续的任务，然后启动替代后台。旧版桌面仍连接时，先关闭它，或用隔离模式同时运行两个版本。

升级后先退出还在运行的旧版独立后端。正式版终端沿用现有凭据。旧 Dev 的 Claude 凭据在原生会话和已登记工作区一致、且历史命令已确认时自动续用。旧 Dev 数据库可通过隔离模式查看。

需要验证后端或数据库改动时，可用隔离模式启动 Dev。

```bash
AGENTKIB_DEV_ISOLATED=1 pnpm dev
```

要以新构建启动共享后端，退出两个客户端并等共享服务结束。旧 Dev 数据目录在 macOS 为 `~/Library/Application Support/ai.agentkib.dev`，Windows 为 `%LOCALAPPDATA%\ai.agentkib.dev`，Linux 使用对应的系统应用数据目录。

### 验证命令

优先运行与改动范围最相关的最小检查。完整本地验证基线为：

```bash
pnpm format:check
pnpm lint
pnpm test
pnpm typecheck
pnpm build
```

常用专项命令：

```bash
# 按项目配置格式化 TypeScript/React
pnpm format

# 只读诊断 Linux 构建环境
apps/desktop/scripts/diagnose-linux.sh --strict

# 在 PowerShell 中诊断 Windows 工具和网络
pnpm diagnose:windows
```

原有工作区 CLI 现通过 pnpm 调用 TypeScript backend：

```bash
pnpm --silent agentkib scan <project>
pnpm --silent agentkib context <project> <agent> [cwd]
pnpm --silent agentkib plan <project>
pnpm --silent agentkib validate <project>
pnpm --silent agentkib manifest <project>
```

首次调用时 CLI 会构建 TypeScript backend；验证数据库保存在项目目录之外的临时目录。

`pnpm test` 会先构建 TypeScript backend，再运行 Vitest。`pnpm build` 只构建当前平台的应用代码，不生成安装包。

### Pull Request CI

质量工作流把普通桌面测试拆成两个分片，将串行文件系统／MCP 项目、Web 测试、格式／Lint／类型检查／构建／辅助脚本测试分别放到独立任务。每个任务使用独立检出目录和构建产物；本地不要在同一检出目录并发执行后端构建和测试。文件系统及 MCP 项目的文件串行和组顺序保持不变，`node .github/scripts/verify-ci-quality-partition.mjs` 会核对两个分片和安全项目对全部桌面测试文件恰好覆盖一次

原必需检查 **Test, lint and build** 等待全部质量任务，失败、取消、缺失结果或意外跳过都会拒绝通过。只有完整 merge-base 差异仅包含四个根文档（`README.md`、`README.zh-CN.md`、`CONTRIBUTING.md`、`SECURITY.md`）或 `docs/`、`qa/` 直接子目录内 Markdown 文件的普通新增／修改时，PR 才走文档快路。重命名、删除、复制、可执行文件／符号链接变更、嵌套文件、探针、资源文件和无法确认的分类均执行完整检查，推送到 `main` 始终完整检查

文档快路只作用于质量工作流，两个 Linux 和两个 Windows 检查仍按原规则运行，包含原生后端稳定性及 Windows 卸载／回滚断言。本地验证和生产构建命令不变

### 打包桌面应用

```bash
pnpm dist:electron
```

产物写入 `apps/desktop/release-electron/`。打包过程会准备并校验当前平台的 Quota sidecar、构建 renderer 与 Electron 进程，最后调用 electron-builder。安装包使用 TypeScript backend。

Windows x64 额度采集使用固定版本的 Win-CodexBar 0.60.3 预编译控制台 CLI。`pnpm quota:prepare` 下载发布版 ZIP、校验固定的 SHA-256，并将 `codexbar-cli.exe` 暂存为 `agentkib-quota-sidecar.exe`。Windows ARM64 的额度采集仍不可用。

不要把本机包作为正式版本发布。维护者应遵循[发布流程](development/release.md)，其中定义了版本同步、不可变标签、签名、公证、校验文件和各平台产物。
