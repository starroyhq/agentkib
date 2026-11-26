# 常见问题 / Frequently asked questions

[简体中文](#简体中文) · [English](#english)

<a id="简体中文"></a>

## 简体中文

### AgentKib 和 Codex App、Claude Code、T3 Code 有什么不同？

- **Codex App** 是 OpenAI 的 Codex 工作界面，可以使用 Codex CLI 和 IDE 扩展的历史与配置。AgentKib 把这台电脑上可发现的 Codex 会话和其他 Agent 的会话放在同一个列表。符合续接条件的 Codex 会话仍用原线程继续。[Codex App](https://openai.com/index/introducing-the-codex-app/) · [AgentKib 的 Codex 续接](agents/codex-managed.md)
- **Claude Code** 自己可以从终端恢复原会话。AgentKib 会读本机的 Claude Code 历史，可以接着发到已连接、支持发送的终端；空闲会话符合条件时也可以由 AgentKib 启动同一个会话继续。[Claude Code CLI](https://code.claude.com/docs/en/cli-reference) · [AgentKib 的 Claude Code 续接](agents/claude-code-managed.md)
- **T3 Code** 也让你通过一个界面使用多个 Agent。它的文档从在 T3 Code 中启动和管理线程讲起。AgentKib 可以发现 Codex App、Claude Code 终端和 DeepSeek Harness 已经写下的本机会话，支持时按原会话继续，不用先把历史导入 AgentKib。[T3 Code 线程指南](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) · [AgentKib 的功能与兼容矩阵](FEATURES.md)

### 数据存在哪里？

工作区还是电脑上原来的文件夹。原生会话记录保留在各 Agent 的本机数据目录，例如 Codex 的 `~/.codex/sessions/` 和 Claude Code 的 `~/.claude/projects/`。如配置了 `CODEX_HOME` 或 `CLAUDE_CONFIG_DIR`，会话存放在相应目录下。

AgentKib 的本地索引和执行状态默认放在以下目录。

| 系统 | AgentKib 数据目录 |
| --- | --- |
| macOS | `~/Library/Application Support/ai.agentkib/` |
| Windows | `%LOCALAPPDATA%\ai.agentkib\` |
| Linux | `~/.local/share/ai.agentkib/`，或 `$XDG_DATA_HOME/ai.agentkib/` |

部分用户配置和资源库也会使用 `~/.agentkib/`。桌面应用还使用系统应用数据目录下的 `ai.agentkib/electron/`，Windows 上在 `%APPDATA%` 下，Linux 上在 `$XDG_CONFIG_HOME`（默认 `~/.config`）下。备份时分别保留原生 Agent 数据和 AgentKib 数据。参见[升级指南](UPGRADING.md#简体中文)。

### 官方中继能看到什么？

经过官方中继时，手机或浏览器到你电脑的会话控制和文件预览分别使用 HTTPS。中继转发加密流量，TLS 在你电脑上终止。正常转发时，中继能看到连接所用的设备域名、来源 IP 和流量用量，无法解密会话正文或预览内容。这个边界依赖域名、DNS 和证书签发的可信性。[账号与官方中继](remote/account-relay.md#隐私与授权)

账号登录由账号服务单独处理。手动开启的 HTTP 局域网直连仅适合可信网络，电脑与手机之间的流量是明文。[局域网直连](remote/hosted-web-lan.md#使用与安全边界)

### 怎么连手机？

1. 在桌面端打开「设置 → 远程连接 → 连接手机」。使用官方远程访问时，在电脑和手机上登录同一 AgentKib 账号，等电脑显示二维码。
2. 在电脑上选择「完整控制」或「只读」。用手机扫描二维码，在 AgentKib 手机 App 或浏览器里输入八位授权码。授权码五分钟内有效，只能成功使用一次。
3. 保持电脑和 AgentKib 后台运行。可在「远程连接」查看或撤销已配对设备。[手机访问指南](remote/phone-access.md)

### 怎么导出诊断？

在桌面端打开「设置 → 诊断 → 导出诊断」，选择 `agentkib-diagnostics.json` 的保存位置。文件保存在本机，由你决定是否分享。反馈问题时可先检查报告，再附上报告、AgentKib 版本、系统和复现步骤。[反馈问题](https://github.com/starroyhq/agentkib/issues) · [安全问题报告](../SECURITY.md)

---

<a id="english"></a>

## English

### How does AgentKib differ from the Codex app, Claude Code, and T3 Code?

- **The Codex app** is OpenAI's workspace for Codex and can pick up history and configuration from the Codex CLI and IDE extension. AgentKib lists discoverable local Codex sessions alongside sessions from other agents. Eligible Codex sessions continue in their original threads. [The Codex app](https://openai.com/index/introducing-the-codex-app/) · [Codex continuation in AgentKib (Chinese)](agents/codex-managed.md)
- **Claude Code** can resume its existing sessions from the terminal. AgentKib reads local Claude Code history and can send to a connected terminal that supports sending. For an eligible idle session, AgentKib can also start Claude Code to continue the same session. [Claude Code CLI](https://code.claude.com/docs/en/cli-reference) · [Claude Code continuation in AgentKib (Chinese)](agents/claude-code-managed.md)
- **T3 Code** also lets you use multiple agents in one interface. Its thread guide describes starting and managing threads in T3 Code. AgentKib can discover local sessions already saved by the Codex app, Claude Code terminal, and DeepSeek Harness, and continue the same session where supported, with no history import step. [T3 Code thread guide](https://github.com/pingdotgg/t3code/blob/main/docs/user/thread-sidebar.md) · [AgentKib features and compatibility](FEATURES.md#english)

### Where is my data stored?

Workspaces stay in their existing folders. Native session history stays in each agent's local data directory, such as `~/.codex/sessions/` for Codex and `~/.claude/projects/` for Claude Code. If you set `CODEX_HOME` or `CLAUDE_CONFIG_DIR`, the corresponding session directory is under that location.

AgentKib stores its local index and execution state in these directories by default.

| System | AgentKib data directory |
| --- | --- |
| macOS | `~/Library/Application Support/ai.agentkib/` |
| Windows | `%LOCALAPPDATA%\ai.agentkib\` |
| Linux | `~/.local/share/ai.agentkib/` or `$XDG_DATA_HOME/ai.agentkib/` |

Some user configuration and library files use `~/.agentkib/`. The desktop app also uses `ai.agentkib/electron/` under the system app data directory, which is `%APPDATA%` on Windows and `$XDG_CONFIG_HOME` (defaulting to `~/.config`) on Linux. Back up native agent data and AgentKib data separately. See the [Upgrade guide](UPGRADING.md#english).

### What can the official relay see?

When you use the official relay, session controls and file previews use separate HTTPS connections from your phone or browser to your computer. The relay forwards encrypted traffic, and TLS ends on your computer. During normal forwarding the relay can see the device hostname, source IP address, and traffic usage. It cannot decrypt messages or preview contents. This protection depends on trust in the domain, DNS, and certificate issuance. [Accounts and the official relay (Chinese)](remote/account-relay.md#隐私与授权)

The account service handles sign-in separately. If you manually enable direct LAN access over HTTP, traffic between the phone and computer is unencrypted. Use it only on a trusted network. [Direct LAN access (Chinese)](remote/hosted-web-lan.md#使用与安全边界)

### How do I connect my phone?

1. On desktop, open **Settings → Remote connections → Connect phone**. For official remote access, sign in to the same AgentKib account on your computer and phone and wait for the computer to display a QR code.
2. Choose **Full control** or **Read only** on desktop. Scan the QR code with your phone, then enter the eight-digit code in the AgentKib app or browser. The code expires after five minutes and can be used once.
3. Keep the computer and AgentKib running. In **Remote connections**, you can view paired devices and revoke access. [Phone access guide (Chinese)](remote/phone-access.md)

### How do I export diagnostics?

On desktop, choose **Settings → Diagnostics → Export diagnostics** and select where to save `agentkib-diagnostics.json`. The file is saved locally and you decide whether to share it. Review it before attaching it to a report along with your AgentKib version, operating system, and steps to reproduce. [Report an issue](https://github.com/starroyhq/agentkib/issues) · [Report a security issue](../SECURITY.md)
