<p align="center">
  <img src="apps/desktop/resources/assets/app-icon-white.png" width="104" alt="AgentKib" />
</p>

<h1 align="center">AgentKib</h1>

<p align="center"><strong>Inspect, organize, and safely maintain coding-agent context, Skills, sessions, and local toolchains.</strong></p>

<p align="center">
  <a href="https://agentkib.com">Website</a> ·
  <a href="https://github.com/starroyhq/agentkib/releases/latest">Download</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/starroyhq/agentkib/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/starroyhq/agentkib?label=release" /></a>
  <a href="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/starroyhq/agentkib/actions/workflows/ci.yml/badge.svg" /></a>
  <img alt="Local first" src="https://img.shields.io/badge/data-local_first-16a34a" />
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/badge/license-MIT-111827" /></a>
</p>

[![AgentKib home dashboard showing today's actions and recent workspaces](docs/assets/agentkib-home.png)](docs/assets/agentkib-home.png)

## Why AgentKib

Coding agents build up useful local state across project instructions, Skills, MCP connections, native configuration, and conversation history. That state is fragmented between different tools, making it hard to know what an agent can actually see, reuse trusted assets, or continue work safely elsewhere.

AgentKib brings that state into one local, inspectable desktop surface. Core discovery, diagnostics, Skill management, and session handoff do not require an AgentKib account, cloud database, or model API. **KIB** stands for **Knowledge & Instruction Base**.

## What AgentKib does

### Inspect effective context

See the Instructions, Skills, MCP connections, memory, and native configuration available to each agent in a workspace. Diagnose missing, drifted, invalid, or duplicated assets, then review a complete ChangeSet and diff before anything is written.

### Manage reusable Skills

Browse reviewed OpenAI Skills or inspect a public GitHub repository before adding a package to the local library. AgentKib pins managed packages to immutable commits, previews files and executable resources, detects updates and local drift, and supports rollback and recoverable removal. Library Skills are not enabled for an agent automatically.

[![AgentKib Skill Hub showing curated Skills and auditable source information](docs/assets/agentkib-skill-hub.png)](docs/assets/agentkib-skill-hub.png)

### Continue across agents

Browse Codex, Claude Code, Antigravity ACP, OpenCode, supported Cursor CLI stores and explicitly connected Cursor IDE 3.22.12/3.23.12 profiles, OpenClaw schema-23 SQLite and legacy JSONL, Hermes, and Grok Build session history. Reviewed handoff availability is checked against the selected native history, including format and completeness checks. OpenCode 1.18.32, Hermes 0.21.5, and OpenClaw 2026.9.6 have experimental native-import adapters with durable recovery records; offline import/readback is verified, with OpenCode and Hermes also checked in their native terminal UIs after restart. September 30 Claude-to-OpenCode and Codex-to-OpenCode text cases each completed one real reply through the user-selected CPA/Opus provider, correctly recalling imported context and preserving the same session after Runtime restart. This does not validate every source, tool record, attachment, or other target. One OpenClaw-to-Claude synthetic history has produced a correct real reply; full per-direction acceptance is still pending. See the [direction and version matrix](docs/SESSION-INTEROPERABILITY.md). AgentKib preserves useful timeline context, redacts common sensitive values, and requires confirmation before writing or importing handoff artifacts. Antigravity's current native-import and Desktop/CLI interoperability limits are documented in [Antigravity integration](docs/ANTIGRAVITY.md).

The October 1 [offline acceptance closeout](qa/offline-interop-closeout-2026-10-01.md) records all 35 representative text directions across the five existing targets. Claude native TUI recovery and Codex official-interface recovery are verified for seven available sources. The subsequent [provider retest](qa/full-interop-provider-retest-2026-10-01.md) verifies two independent offline OpenClaw TUI restores for each of its six remaining sources and a real Codex-to-Claude reply using the newly selected DeepSeek provider. Exact source, target identity and full-history checks remain separate from model-answer acceptance; unsuccessful replies and unverified release gates remain open.

The October 1 closeout adds an exact Codex 0.155.1 compatibility gate while preserving the 0.146 contract. New Grok→Codex 0.146.1, Claude→Codex 0.155.1, and Grok→OpenClaw 2026.9.6 cases each made one DeepSeek request and recovered the full native history twice offline. Original failed results remain intact; the OpenClaw punctuation difference has a separate exact full-sentence audit. Cursor IDE 3.22.12 now has an experimental local first-party VSIX bridge, explicit profile/window pairing, reviewed native import, full readback, durable recovery, and a separate source namespace. Two isolated Claude→Cursor IDE text cases pass native storage import, full content checks, same-ID recovery, and visible history after official login. The first real reply failed context inheritance: the converter populated UI history but omitted separate model prompt history. That defect is fixed with strict readback regressions. Two corrected cases independently verify all five model/UI messages and thirteen blobs, with complete visible history and unique native identities. One case recovers its original operation after vendor protobuf field grouping and reopens the same ID after two Runtime restarts; the other imports the canonical format directly. A new B case made one GUI submission and correctly recalled the complete historical marker and storage decision. Both histories remained visible after a second normal client restart. Post-reply recovery exposed a fixed-version assistant JSON key-order change; the narrow compatibility fix passes tests and actual same-operation reopening after a Runtime restart. October 2 checks also preserve all seven messages when this native history becomes a source again for five target previews; these previews do not represent five native imports. The old failures remain intact. Cursor IDE→Claude also passes one native file import and two offline native TUI restores, without a model call. CLI and Agents Window capabilities remain separate. Actual Cursor results are recorded independently from fixtures in the [native acceptance QA](qa/cursor-native-acceptance-2026-10-01.md) and [closeout QA](qa/interop-closeout-2026-10-01.md).

### Keep local tools current

Inspect Codex, Claude Code, Antigravity, Cursor, OpenCode, OpenClaw, Hermes, and Grok Build installations. AgentKib reports each installation's version, source, executable path, PATH default, and conflicts. Verified package-manager actions can run with a pinned target; channels that cannot pin an exact version, along with ambiguous, privileged, or remote-script flows, fall back to a command or official documentation.

[![AgentKib Tools and updates showing versions, installation sources, and diagnostics](docs/assets/agentkib-tools-updates.png)](docs/assets/agentkib-tools-updates.png)

## Built-in Web (development preview)

This monorepo includes a separately built Web client bundled with Electron. In **Settings → Remote connections**, use the phone-access setup action and complete invitation registration and device pairing. The default registration API is `https://api.agentkib.com`; `https://remote.agentkib.com` remains the hosted Web entry and trusted LAN origin. Local/LAN Web access is a separate, optional route that does not require the hosted service. Native connections to another desktop have their own pairing flow; see [native LAN connections](docs/REMOTE.md). The desktop application must remain running. Read access is separate from control permissions. Verified macOS Claude Code installations (`2.1.263` / `2.1.285`) have a shared desktop/Web managed-session implementation for new sessions, confirmed same-UUID continuation, images/files, approvals, and durable receipt recovery. Native and device acceptance is tracked separately in the [current Claude QA](qa/claude-managed-2026-09-30.md); Web control requires host and per-browser permissions; Codex owner control remains acceptance-gated. See the [local Web setup guide (Chinese)](docs/WEB-SELF-HOSTING.md), [Claude continuation boundary](docs/CLAUDE-WEB.md), and [QA status](qa/WEB-V1.md). This preview is not a claim that the current published release includes Web access.

The invitation-test implementation adds Codex app-server task creation and explicit same-ID handoff, separately granted project files/artifacts and read-only Git diffs, isolated interactive HTML bundles, and streamed media previews. AgentKib Remote is an invitation-test hosted-access implementation; its server implementation and deployment configuration are not included in this repository. Public launch and pricing are not announced here. Previously configured `https://remote.agentkib.com` broker identities require explicit migration and new registration; credentials are not copied to the new API origin. The desktop connector keeps browser business TLS termination on the desktop. This repository contains the desktop connector, Web client and local agent/artifact services. See the [Codex and artifact setup](docs/REMOTE-CODEX-WEB.md) and [hosted remote service guide](docs/REMOTE-RELAY.md). The implementation remains in invitation testing; public connectivity and physical iOS/Android acceptance are still pending.

## Download

Download the current stable package from the [Latest Release](https://github.com/starroyhq/agentkib/releases/latest):

- macOS 13.3+: `.dmg` for Apple Silicon or Intel
- Windows 11: x64 `.exe`; ARM64 remains Preview
- Linux: Ubuntu `.deb` or AppImage, or Fedora `.rpm`; ARM64 remains Preview

Only use files from the official release and verify the matching `.sha256` checksum. Windows installers are not yet Authenticode-signed and may trigger SmartScreen. See [Upgrading](docs/UPGRADING.md) for in-app updates, package-specific upgrade paths, and historical macOS packages.

## Local-first safety

- Ordinary discovery and diagnostics do not invoke a model or upload project assets.
- Credentials, cookies, tokens, private keys, environment files, and message databases are not cataloged as assets or written to logs.
- Generated writes validate path boundaries and original hashes, create backups, and require review before applying.
- Agent Home changes use a separate high-risk confirmation flow; remote integrations retain their own permission boundaries.

## Support at a glance

- **Discovery and context:** Codex, Claude Code, Antigravity, Cursor, OpenCode, OpenClaw, Hermes, Grok Build, and read-only DeepSeek Harness diagnostics.
- **Session browsing:** Codex, Claude Code, Antigravity ACP, OpenCode, supported Cursor CLI stores and explicitly connected Cursor IDE 3.22.12/3.23.12 profiles, OpenClaw schema-23 SQLite and legacy JSONL, Hermes, and Grok Build. Reading never modifies the original history.
- **Reviewed handoff:** all eight sources above, subject to per-session parsing. Native import, context-file handoff, and Web control are separate capabilities; see the [compatibility matrix](docs/SESSION-INTEROPERABILITY.md) for restrictions and acceptance status.
- **Tool management:** Codex, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, and Grok Build. Antigravity is detected and linked to official update guidance, but has no automatic package action. DeepSeek Harness is intentionally excluded.
- **Interface:** English, Simplified Chinese, Traditional Chinese, and Japanese; light, dark, and system themes.
- **Platforms:** macOS 13.3+, Windows 11, Ubuntu 22.04, and Fedora. ARM64 Windows and Linux packages remain Preview.

See the [complete feature and compatibility matrix](docs/FEATURES.md) for global views, workspace capabilities, agent support, and platform status.

For development-only read-only sources and missing-workspace troubleshooting, see the [discovery and history guide (Chinese)](docs/DISCOVERY-HISTORY.md) and [layered QA record](qa/MULTI-AGENT-HISTORY.md). These additions are not a claim about released packages.

## Documentation and community

- [Feature matrix](docs/FEATURES.md)
- [Development guide](docs/DEVELOPMENT.md)
- [Upgrade guide](docs/UPGRADING.md)
- [Release process](docs/RELEASE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [GitHub Issues](https://github.com/starroyhq/agentkib/issues)

Report security vulnerabilities privately according to the [security policy](SECURITY.md), not through a public issue. AgentKib is released under the [MIT License](LICENSE).
