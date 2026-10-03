# Development / 开发文档

[English](#english) · [简体中文](#简体中文)

<a id="english"></a>

## English

This guide covers local development, validation, and packaging for the current Electron desktop application. Contributor workflow and pull request expectations remain in [CONTRIBUTING.md](../CONTRIBUTING.md).

### Prerequisites

- Node.js 22
- pnpm 10.8.1, as pinned by the root `packageManager` field
- Git

Platform-native build dependencies:

- **macOS 13.3+**: Xcode Command Line Tools
- **Windows 11**: Visual Studio Build Tools 2022 with Desktop development with C++, and a Windows 10 or 11 SDK. Follow the [Windows guide](WINDOWS.md).
- **Ubuntu 22.04**: `build-essential`, `pkg-config`, `libssl-dev`, and `libgtk-3-dev`
- **Fedora 42**: GCC/G++, Make, OpenSSL and pkg-config development packages, GTK 3 development packages, and RPM packaging tools. The exact CI baseline is in [linux.yml](../.github/workflows/linux.yml).

Enable the pinned pnpm version, then install dependencies from the repository root:

```bash
corepack enable
corepack prepare pnpm@10.8.1 --activate
pnpm install --frozen-lockfile
```

### Architecture

AgentKib is one desktop application assembled from several cooperating parts:

| Part                  | Location                                                      | Responsibility                                                                                                             |
| --------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Electron main process | `apps/desktop/electron/main/`                                 | Window lifecycle, tray, native shell integration, updates, runtime hosting, and privileged IPC                             |
| Electron preload      | `apps/desktop/electron/preload/`                              | Narrow bridge exposed to the renderer                                                                                      |
| React renderer        | `apps/desktop/src/`                                           | Routes, screens, state, and user interaction                                                                               |
| TypeScript backend    | `packages/backend/`, `apps/desktop/electron/backend-entry.ts` | Application settings, workspace/discovery writes and cached reads in an independently restartable Electron utility process |
| Quota sidecar         | Prepared under `apps/desktop/resources/quota/`                | Platform-specific local quota collection                                                                                   |
| Runtime protocol      | `packages/runtime-protocol/src/index.ts`                      | Shared contract generated for Electron                                                                                     |

The Electron main process and packaged application use the TypeScript backend exclusively. `runtime-router.ts` assigns every runtime method to a TypeScript owner and validates renderer access through IPC. The backend owns workspace and discovery data, settings, agent context and assets, sessions and transcripts, insights and quotas, handoff and change application, MCP configuration, and SQLite schema upgrades. Provider readers preserve bounded paging, partial-source retention, last-good data, workspace ownership checks, and sensitive-data redaction. Managed Claude/Codex and remote control features run through the TypeScript owner paths. Workspace writes are serialized and transactional, with crash fencing; failed requests are never replayed to another backend.

`pnpm dev` and packaged applications start only the TypeScript backend. Electron supplies the bundled Node runtime. Native file replacement and rollback use the staged Koffi module, unpacked from ASAR for installed apps. The build commands generate the shared protocol and stage required native artifacts in the order defined in `apps/desktop/package.json`.

### Start development

```bash
pnpm dev
```

This launches **AgentKib Dev** with identifier `ai.agentkib.dev`. Its database, preferences, caches, MCP packages, and other application data are isolated from the stable `ai.agentkib` application. Development startup does not copy, migrate, or merge stable data.

On macOS, development data is stored under:

```text
~/Library/Application Support/ai.agentkib.dev
```

On Windows it is stored under `%LOCALAPPDATA%\ai.agentkib.dev`. Linux uses the corresponding system application-data location.

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

### Package the desktop app

```bash
pnpm dist:electron
```

Packages are written to `apps/desktop/release-electron/`. Packaging prepares and verifies the platform quota sidecar, builds the renderer and Electron processes, and invokes electron-builder. The package uses the TypeScript backend and contains no Rust Runtime.

Windows x64 quota collection uses the pinned Win-CodexBar 0.60.3 prebuilt console CLI. `pnpm quota:prepare` downloads its release ZIP, verifies the pinned SHA-256, and stages `codexbar-cli.exe` as `agentkib-quota-sidecar.exe`. Windows ARM64 quota collection remains unavailable.

Do not publish local packages as official releases. Maintainers should follow the [release process](RELEASE.md), which defines version synchronization, immutable tags, signing, notarization, checksums, and platform artifacts.

---

<a id="简体中文"></a>

## 简体中文

本文说明当前 Electron 桌面应用的本地开发、验证与打包方式。贡献流程和 Pull Request 要求仍保留在根目录的[贡献指南](../CONTRIBUTING.md)中。

### 环境要求

- Node.js 22
- 根目录 `packageManager` 固定的 pnpm 10.8.1
- Git

各平台原生构建依赖：

- **macOS 13.3+**：Xcode Command Line Tools
- **Windows 11**：带“使用 C++ 的桌面开发”工作负载的 Visual Studio Build Tools 2022，以及 Windows 10 或 11 SDK。完整步骤见 [Windows 指南](WINDOWS.md)。
- **Ubuntu 22.04**：`build-essential`、`pkg-config`、`libssl-dev` 和 `libgtk-3-dev`
- **Fedora 42**：GCC/G++、Make、OpenSSL 与 pkg-config 开发包、GTK 3 开发包和 RPM 打包工具。准确的 CI 基线见 [linux.yml](../.github/workflows/linux.yml)。

启用固定的 pnpm 版本，然后在仓库根目录安装依赖：

```bash
corepack enable
corepack prepare pnpm@10.8.1 --activate
pnpm install --frozen-lockfile
```

### 架构

AgentKib 由多个协作部分组成一个桌面应用：

| 部分                  | 位置                                                          | 职责                                                                               |
| --------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Electron main process | `apps/desktop/electron/main/`                                 | 窗口生命周期、托盘、原生系统集成、更新、Runtime 托管和高权限 IPC                   |
| Electron preload      | `apps/desktop/electron/preload/`                              | 向 renderer 暴露收窄后的桥接接口                                                   |
| React renderer        | `apps/desktop/src/`                                           | 路由、界面、状态和用户交互                                                         |
| TypeScript backend    | `packages/backend/`、`apps/desktop/electron/backend-entry.ts` | 在可独立重启的 Electron utility process 中处理应用设置、工作区／发现写入及缓存读取 |
| Quota sidecar         | 准备到 `apps/desktop/resources/quota/`                        | 分平台采集本机额度数据                                                             |
| Runtime protocol      | 由 `apps/desktop/scripts/generate-runtime-protocol.mjs` 生成  | 在开发和构建前生成 Electron 与 TypeScript backend 的共享协议                       |

`pnpm dev` 与正式安装版只启动 TypeScript backend。Electron 自带 Node runtime。原生文件替换和回滚使用暂存的 Koffi 模块，安装版会从 ASAR 解包。build 命令按照 `apps/desktop/package.json` 的顺序生成共享协议并暂存所需原生产物。

`pnpm dev` 和正式安装版只启动 TypeScript backend。Electron 使用自带的 Node runtime。原生文件替换和回滚使用暂存的 Koffi 预编译模块，安装版会从 ASAR 解包。`pnpm dev`、`pnpm build` 和 `pnpm dist:electron` 会按照 `apps/desktop/package.json` 定义的顺序生成共享协议并暂存所需原生产物；不要手工编辑生成协议或其转出文件。

### 启动开发环境

```bash
pnpm dev
```

该命令启动 identifier 为 `ai.agentkib.dev` 的 **AgentKib Dev**。它的数据库、偏好、缓存、MCP 包及其他应用数据与正式版 `ai.agentkib` 隔离。开发启动不会复制、迁移或合并正式版数据。

macOS 开发数据位于：

```text
~/Library/Application Support/ai.agentkib.dev
```

Windows 位于 `%LOCALAPPDATA%\ai.agentkib.dev`，Linux 使用对应的系统应用数据目录。

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

### 打包桌面应用

```bash
pnpm dist:electron
```

产物写入 `apps/desktop/release-electron/`。打包过程会准备并校验当前平台的 Quota sidecar、构建 renderer 与 Electron 进程，最后调用 electron-builder。安装包使用 TypeScript backend。

Windows x64 额度采集使用固定版本的 Win-CodexBar 0.60.3 预编译控制台 CLI。`pnpm quota:prepare` 下载发布版 ZIP、校验固定的 SHA-256，并将 `codexbar-cli.exe` 暂存为 `agentkib-quota-sidecar.exe`。Windows ARM64 的额度采集仍不可用。

不要把本机包作为正式版本发布。维护者应遵循[发布流程](RELEASE.md)，其中定义了版本同步、不可变标签、签名、公证、校验文件和各平台产物。
