# 安装与首次使用 / Installation and first use

[简体中文](#简体中文) · [English](#english)

<a id="简体中文"></a>

## 简体中文

从 [AgentKib 官方发布页](https://github.com/starroyhq/agentkib/releases/latest) 下载适合这台电脑的安装包和对应的 `.sha256` 文件。安装前核对文件的 SHA-256。macOS 用 `shasum -a 256 -c`，Linux 用 `sha256sum -c`，都以校验文件为参数，在下载目录运行。Windows 可用 PowerShell 的 `Get-FileHash` 查看安装包的 SHA-256，与校验文件里的值比对。两者不一致时重新从官方发布页下载。

### macOS 13.3 或更新版本

1. 打开苹果菜单 →「关于本机」。显示 Apple「芯片」的 Mac 下载以 `macos-arm64.dmg` 结尾的文件。显示 Intel「处理器」的 Mac 下载 `macos-x64.dmg`。
2. 打开 DMG，将 AgentKib 拖入「应用程序」，从「应用程序」打开 AgentKib。
3. 正式发布的 Mac 安装包已签名并通过 Apple 公证。首次打开时，macOS 可能让你确认打开从互联网下载的应用。若系统报告无法验证应用，核对下载来源和校验值。[Apple 的打开应用说明](https://support.apple.com/zh-cn/102445)

### Windows 11 x64

1. 下载并运行以 `windows-x64.exe` 结尾的安装包，按安装向导操作。
2. 从官方发布页下载的直装版目前未签名，安装或首次打开时可能出现 SmartScreen 提示。核对官方来源和校验值，按设备的安全设置处理提示。[Microsoft 的 SmartScreen 说明](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)
3. 从「开始」菜单打开 AgentKib。

### Linux（Beta）

- **Ubuntu 22.04 x64** 使用 `linux-amd64.deb`，用系统软件安装器或 `apt install` 安装下载的本地包。
- **Fedora x64** 使用 `linux-x86_64.rpm`，用系统软件安装器或 `dnf install` 安装下载的本地包。
- **AppImage** 下载 `linux-x86_64.AppImage`，在文件属性里允许执行，再打开。如果系统提示缺少 FUSE，可使用发行版对应的安装包，或按 AppImage 的说明处理。[FUSE 排查指南](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
- 安装 Deb 或 RPM 后，从应用菜单打开 AgentKib。Linux ARM64 安装包为预览版。

### 打开已有会话

在本机查看会话不用注册 AgentKib 账号。运行 Agent 时仍用该 Agent 自己的登录或凭据。

1. 打开后，AgentKib 会查找已有的 Agent、工作区和会话。进「会话」可按 Agent 或工作区找之前的对话。工作区没出现时，在「工作区」添加项目文件夹，或查看[发现与历史阅读](sessions/discovery.md)。
2. 打开一条已有会话。输入框可发送时，直接发一条消息就能继续原会话。只读会话也可以查看历史。各 Agent 的能力见[功能与兼容矩阵](FEATURES.md#简体中文)。
3. 还没有会话时，选择「新建会话」，挑一个工作区和可用的 Agent。「设置 → 工具与更新 → 本地 Agent 环境」可以查看已识别的工具和官方安装说明。也可直接查看 [Codex](https://developers.openai.com/codex/cli) 和 [Claude Code](https://code.claude.com/docs/zh-CN/quickstart) 的安装文档。

在支持终端连接的 macOS 上，AgentKib 检测到兼容的 Claude Code 后，默认在用户范围安装桥接插件。已经打开的 Claude Code 终端可以重新加载插件或重开会话。安装状态和设置入口见 [Claude Code 终端指南](agents/claude-code-terminal.md#首次连接)。

[常见问题](FAQ.md#简体中文) · [升级指南](UPGRADING.md#简体中文)

---

<a id="english"></a>

## English

Download the package for your computer and its matching `.sha256` file from the [official AgentKib release page](https://github.com/starroyhq/agentkib/releases/latest). Verify the package before installing it. On macOS run `shasum -a 256 -c`, or on Linux run `sha256sum -c`, with the checksum filename as the argument in your download directory. On Windows, use PowerShell's `Get-FileHash` to get the installer's SHA-256 and compare it with the checksum file. If the values differ, download the package again from the official release page.

### macOS 13.3 or later

1. Open Apple menu → **About This Mac**. If it shows an Apple **Chip**, choose `macos-arm64.dmg`. If it shows an Intel **Processor**, choose `macos-x64.dmg`.
2. Open the DMG, drag AgentKib into **Applications**, and open AgentKib from there.
3. Stable Mac releases are signed with the AgentKib Developer ID and notarized by Apple. macOS may ask you to confirm opening a downloaded app the first time. If macOS reports that it cannot verify the app, check the download source and checksum. [Apple's guide to opening apps](https://support.apple.com/en-us/102445)

### Windows 11 x64

1. Download the installer ending in `windows-x64.exe` and follow the setup wizard.
2. The direct-download installer is currently unsigned. SmartScreen may show a warning during installation or first launch. Verify the official source and checksum, then follow your device's security settings. [Microsoft's SmartScreen guide](https://support.microsoft.com/en-us/windows/security/windows-security/app-browser-control-in-the-windows-security-app)
3. Open AgentKib from **Start**.

### Linux (Beta)

- On **Ubuntu 22.04 x64**, install `linux-amd64.deb` using your software installer or `apt install` with the local package file.
- On **Fedora x64**, install `linux-x86_64.rpm` using your software installer or `dnf install` with the local package file.
- To use **AppImage**, download `linux-x86_64.AppImage`, allow it to run as a program in the file properties, then open it. If your system reports missing FUSE support, use the package for your distribution or follow AppImage's troubleshooting steps. [FUSE troubleshooting](https://docs.appimage.org/user-guide/troubleshooting/fuse.html)
- For Deb or RPM installs, open AgentKib from your applications menu. Linux ARM64 packages are previews.

### Open an existing session

You can view your sessions locally without an AgentKib account. Each agent uses its own sign-in or credentials when it runs.

1. On launch, AgentKib looks for existing agents, workspaces, and sessions. Go to **Sessions** and use the agent or workspace to find an earlier conversation. If a workspace is missing, add the project folder from **Workspaces** or see [discovery troubleshooting (Chinese)](sessions/discovery.md).
2. Open an existing session. If the composer allows sending, send a message to continue that session. Read-only sessions still show history. See [Features and compatibility](FEATURES.md#english) for the available controls.
3. If you have no sessions, choose **New session**, a workspace, and an available agent. **Settings → Tools & updates → Local Agent environment** lists detected tools and their official installation instructions. You can also check the [Codex](https://developers.openai.com/codex/cli) and [Claude Code](https://code.claude.com/docs/en/quickstart) documentation.

On macOS, AgentKib installs its bridge plugin in the user scope by default when it detects compatible Claude Code for terminal connections. If Claude Code is already open, reload plugins or reopen the session. See the [Claude Code terminal guide (Chinese)](agents/claude-code-terminal.md#首次连接) for installation status and settings.

[FAQ](FAQ.md#english) · [Upgrade guide](UPGRADING.md#english)
