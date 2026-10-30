# Features and compatibility / 功能与兼容矩阵

This document describes AgentKib's current product surfaces and support boundaries. For installation and the product overview, see the [README](../README.md).

本文档描述 AgentKib 当前的产品界面与支持边界。安装方式和产品简介见[中文 README](../README.zh-CN.md)。

Native acceptance is tied to each QA report's revision and Agent version. Current TypeScript backend automation and candidate-package checks are recorded separately in [TypeScript stability QA](../qa/typescript-stability-2026-10-07.md); older Rust evidence is not reused as migration acceptance.

原生验收只适用于各 QA 记录的源码与 Agent 版本。当前 TypeScript 后端自动化和候选包检查单独记入[本轮稳定性 QA](../qa/typescript-stability-2026-10-07.md)，不将旧 Rust 证据当作迁移后的验收结果。

## English

### Native session connection

| Surface | Version / platform | Boundary |
| --- | --- | --- |
| Claude native terminal → desktop / Web | CLI 2.1.301 or later, macOS, opt-in Mods plugin 0.4.0; required capability checks | Existing executor; observation, text messages and current-turn cancellation are enabled. CLI 2.1.301 and 2.1.310 are verified; higher stable versions that pass the checks may connect with a neutral unverified-version notice. A message sent while the terminal is idle starts a turn; while a turn runs it is queued for after the turn or added to it, as each device's "Send while running" setting chooses. Approvals/questions stay in the terminal; attachments and advanced orchestration are disabled. |
| Claude managed | Existing compatibility gates unchanged | AgentKib owns the process; explicit history handoff and existing controls remain separate. |
| Codex Desktop follower / managed | Existing compatibility gates unchanged | Current production paths retained. |
| Codex shared app-server | CLI 0.155.1, isolated macOS probe | Verification only; no new production mode or daemon installation. |

Current native and synthetic results are recorded separately in [connection QA](../qa/native-session-connection-2026-10-16.md). Subsequent Haiku 5.5 and Luna6 checks distinguish model responses from complete-chain acceptance in [real-model QA](../qa/native-session-real-model-2026-10-16.md). See [Claude connection instructions](CLAUDE-NATIVE-CONNECTION.md).

原会话连接与托管执行分别验收。Claude 原连接限 macOS，最低 CLI 2.1.301，需主动安装合约 0.4.0 的插件并通过必需能力检查；目前 2.1.301 和 2.1.310 已验证，更高稳定版通过检查后允许连接并显示中性未验证提示。终端空闲时从 AgentKib 发送会开始新一轮，运行中可以排到本轮之后或加入本轮，默认方式由各设备的“运行中发送”设置决定；审批和问题在原终端处理。Codex 共享 app-server 本轮只验证，不替换现有生产链路。

### Across your machine

| Area | What it provides |
| --- | --- |
| Today | Prioritized local actions and recent workspace activity |
| Workspaces | Discovered and manually added projects, with coverage and warnings |
| Asset catalog | A machine-wide view of Instructions, Skills, MCP, memory, and other agent assets |
| Skill Hub | A local Skill library, existing-installation inspection and batch copy import, reviewed OpenAI/GitHub sources, GitHub version selection, personal/project deployment, updates, rollback, withdrawal, and recoverable library removal |
| Agents | Installation state, configuration homes, capabilities, and discovered assets |
| Quota | Locally available quota windows, balances, and reset times |
| Insights | Token, session, Git activity, heatmaps, and achievements derived locally |
| Settings | Discovery roots, tool updates, integrations, privacy controls, and diagnostics |

Quota diagnostics show the last attempt, last success, automatic-refresh setting and redacted provider failures. Verified Codex/Claude cost-scan timeouts can retain successfully collected quota windows with a partial-data warning. A complete failure retains the last-good snapshot as stale; expired reset times request a refresh instead of showing a future countdown.

Quota collection is separate from Claude Code managed execution, which never reads credentials (see [Claude usage](CLAUDE-WEB.md)). Quotas come from a bundled third-party sidecar (CodexBarCLI 0.49.5 on macOS and Linux, Win-CodexBar 0.60.3 on Windows x64) that runs with your user environment, and only on a manual refresh or after you turn on "Automatically get quota" (off by default). AgentKib itself does not read provider credentials: it parses the sidecar's JSON, keeps the normalized windows, balances, reset times, account email and plan, and redacts credential-like text from errors. The sidecar, however, may read credentials. For Claude, the CodexBar documentation (v0.49.5) lists these sources:

- The claude.ai `sessionKey` cookie, imported from a browser profile (the documented locations are macOS Safari, Chrome-family and Firefox) or supplied as a manual cookie header.
- A probe that runs the `claude` CLI in a pseudo-terminal to read `/usage`.
- Claude Code's OAuth credentials (CodexBar's own cache, `~/.claude/.credentials.json`, or the `Claude Code-credentials` Keychain item), used against `api.anthropic.com`.
- For cost totals, a scan of local Claude Code session logs (`projects/**/*.jsonl`) for per-model token counts.

For the CodexBarCLI bundled on macOS and Linux, the documented automatic order is the cookie source first and the `claude` probe second, and the OAuth source applies when it is selected explicitly in the CodexBar configuration. The same documentation notes that some internal code paths still use a different automatic order, so treat this as upstream's documented behavior, not an AgentKib guarantee. When no CodexBar configuration exists, the one AgentKib generates only enables the installed providers (among Codex, Claude Code and Cursor) and does not choose a source; an existing CodexBar configuration or `CODEXBAR_CONFIG` takes precedence, and the collector diagnostics on the Quota page show which configuration is in use. Win-CodexBar is a separate Windows port: its documentation and source (v0.60.3) also cover browser cookies (Chrome, Edge, Brave, Firefox), the `claude` CLI and OAuth, with the automatic order web cookies, then OAuth, then the `claude` CLI (after an Admin API key, when one is configured). It reads Claude Code's own credential file or credential-manager entry only after a setting that is off by default is enabled.

### Inside a workspace

| Area | What it provides |
| --- | --- |
| Overview | Agent coverage, shared asset state, and workspace signals |
| Continue work | Local session browsing and reviewed cross-agent handoff |
| Assets | Project-scoped Instructions, Skills, MCP, memory, and native configuration |
| Git | Read-only repository status and activity |
| Context | Effective load order, scope, overrides, and conflicts for a selected agent and directory |
| Doctor | Actionable diagnostics across supported agents |
| Changes | Pending and historical ChangeSets with complete diffs |

Generated changes follow a review-first flow:

```text
Discover local workspaces and agent state
                  ↓
Preview effective context and diagnostics
                  ↓
Generate a ChangeSet and complete diff
                  ↓
Write only after explicit approval
```

Browsing, previewing, and diagnostics do not create a manifest or modify agent configuration. A workspace needs no pre-existing `.agentkib/manifest.yaml`; AgentKib adds one to the reviewed ChangeSet only when shared assets are first saved.

### Session history

- Desktop and Web offer opt-in keyword search over the current host's user/assistant text and readable tool input/output, with workspace, agent, text/tool and archive filters. Search snippets lead to bounded source passages; selected quotations enter the current draft without changing its target and are sent only on explicit user action. Other paired hosts remain title-search only. The local owner controls enable/clear/rebuild, and the global session-index switch also clears the derived body cache.
- Content adapters cover the eight agents below. Cursor tool records are unsupported; attachments and hidden reasoning are excluded. Damaged, oversized or unsupported source records are marked partial rather than presented as complete. Source changes invalidate old locations and unsent references; Web reads and sends retain separate source/target authorization. See [source matrix, limits and cleanup](SESSION-CONTENT-SEARCH.md). This feature's evidence is TypeScript automation; Windows/Linux native acceptance and model calls were not performed for this round, and historical Rust evidence is not reused.

- The directory shows interactive conversations and user-created forks. Auxiliary/subagent records are retained in the index but excluded from directories, search, recent conversations, counts, and continuation choices on desktop and Remote; old links return to the directory with an explanation. Unknown sources and ordinary untitled conversations remain visible.
- Sessions started by a program are execution records and are hidden from the directory by default: ordinary Codex `exec` runs, and Claude Code sessions whose entrypoint is `sdk-cli`, `sdk-ts` or `sdk-py` (Agent SDK and `-p` runs, such as Pen's), background `daemon` sessions and `/loop` runs. These follow the rules Claude Code 2.1.311 uses to keep such sessions out of its own resume list; the working directory and tool names are not used. The directory option "Show program-started sessions" lists them on desktop and Web with a robot icon and counts as an active filter; it is off by default, is not saved, and the sessions stay view only. Claude Code sessions that AgentKib runs itself remain ordinary conversations. After the upgrade, the next refresh reclassifies cached Claude Code sessions and records each session's working directory.
- A session belongs to the deepest registered workspace that contains its working directory. Refreshing an enclosing workspace, such as the home folder, no longer takes sessions from a workspace registered inside it; the enclosing workspace gets them back only when the inner one stops listing them.
- Checkouts of one git repository share a directory group named after the main checkout; the heading adds "· N worktrees" and its tooltip lists them. A session that ran in a worktree joins its repository's group even when a wider workspace holds it, provided some workspace on the same computer is registered for that repository. When the main checkout is not registered, the group takes its folder name; when even that is unknown, the group shows a worktree icon with "This is a git worktree". Worktree rows carry only a worktree icon (lucide `Split`, distinct from the fork indicator), and hovering or a screen reader gives the worktree name, branch, path and status; a deleted worktree's icon is dimmed and its text says so. The session page shows "Worktree {name} · {branch}", or "· deleted" / "· status unknown". Recent-session lists (the overview, "Continue recent work" on the desktop home page and "Recent sessions" on the Web home page) name a session after its directory group. The Workspaces page and the sidebar list worktrees indented under their main checkout.
- Worktree facts are read from `.git`, `gitdir`, `commondir`, `HEAD`, `config` and `worktrees/*` without running git; a checkout is a linked worktree when its common git directory is not its own `.git`. Sessions in a deleted worktree are placed by git's own worktree record, by a `.claude/worktrees` path inside the repository, or, for a pruned Codex worktree, by matching the thread's recorded `git_origin_url` with the main checkout's `origin` (left ungrouped when two clones share that remote). Unreadable metadata shows as "status unknown". Their history stays readable; continuing needs the folder back (see [live sessions](CONVERSATIONS.md)). Grouping is presentation only: ownership, authorization and control checks still use the session's own workspace.
- AgentKib-managed conversations keep their ledger-backed directory entry, with duplicate native index aliases removed. The paired desktop Remote directory verifies existing managed ownership without creating or migrating its ledger, and preserves the native index ID for history reads. Legacy Codex history imports remain visible only when their complete AgentKib import header matches the indexed session identity and workspace; this recognition grants no control permissions. The TypeScript backend advances classification revision to 3 and invalidates old Codex workspace and conversation-collection caches once; the first directory read recalculates Codex origins before exposing cached entries, without changing native histories. An incomplete upgrade scan shows records that were successfully reclassified, while unclassified cached records remain stored and hidden until they can be read. Once all cached records have been reclassified, ordinary reads stop repeating the upgrade scan even if a source remains unavailable. Clearing the index also clears pending classification markers, while retaining the classification revision. Both the host and Remote frontend must be updated for this directory policy to take effect.
- Native alias checks in local and paired directories require a complete ledger within the 20,000-record read limit and check ownership before filtering workspaces. Larger ledgers retain the native execution classification and skip alias mapping and deduplication; local managed entries keep their ledger identities, and ordinary conversations remain readable. If paired-directory ownership projection fails, the indexed records remain readable with their original classifications, and Runtime emits a diagnostic without ledger contents or paths; control ledger checks still fail on errors.
- Forks keep their own identity and title, with a small fork indicator and source information. Spawned-parent and fork-source relationships are independent; identical titles are never merged. Successful source refreshes reconcile archived/deleted records, while unavailable or unsupported sources retain the last cached snapshot.
- History opens with the latest 50 records (messages and tool summaries), displayed chronologically. Load earlier records on demand. Normal pagination does not show an incomplete-turn warning; actual read errors and truncated content remain visible.
- Local Codex and Claude Code sessions show typed tool rows on the desktop Sessions page and in Web: commands with status, non-zero exit code, duration and the end of their output; file edits with added/removed line counts and a bounded diff preview; MCP calls, searches and sub-agent actions. Turns show how long they took, and a turn that edited files ends with a per-file summary whose diffs open in place. Previews are redacted with the content-search rules, capped at 32 KiB per item, and visible to read-only browsers too. Reasoning, Claude's `originalFile` and the file contents of read tools are never sent. Sessions on other computers viewed from the desktop, Antigravity and the other agents still show tool names and status only. See [tool details and turn durations](CONVERSATIONS.md).
- Desktop and Remote display the latest native context report independently of settings support. Compaction blocks sending, steering, settings, goals, and ownership transfer until the native phase ends; unconfirmed post-compaction usage does not extend the send lock. See [conversation state and report sources](CONVERSATIONS.md).
- Codex and Claude Code JSONL histories are read from the tail with bounded scanning and memory, rather than loading the entire transcript before pagination. Antigravity ACP histories are replayed through the official ACP server with bounded pages and update budgets. OpenCode is read through its bounded export command; OpenClaw, Hermes, and Grok Build use their verified local history sources. Page byte limits may return fewer than 50 records; an empty scan window can still offer earlier records.
- Damaged or oversized log records produce a warning. Very distant message/tool associations or ambiguous legacy metadata may be shown conservatively with a warning instead of requiring a full-file scan.
- History pagination is read-only. All eight listed agents have source adapters with per-session validation; Cursor uses verified CLI stores or explicitly connected macOS IDE profiles, and OpenClaw supports schema-23 SQLite plus legacy JSONL when no authoritative SQLite store exists. Compressed or incomplete histories that cannot preserve required text are refused. OpenCode 1.18.32, Hermes 0.21.5, and offline OpenClaw 2026.9.6 native imports prepare a reviewed payload, reconcile durable operation records, and verify target content before launch. Historical QA records offline storage, native UI, restart, and representative text-reply results for specific directions. These do not cover all source/target pairs, rich content, or the migrated TypeScript backend. See [direction/version compatibility](SESSION-INTEROPERABILITY.md).

### MCP Hub and client connections

- HTTP MCP OAuth credentials are bound to the authorization server that issued them. After the MCP SDK security update to 1.31.0, saved credentials without this binding require a new sign-in; authorize the service again from its MCP entry.
- The desktop MCP page separates service collection/editing, batch Agent connection setup, and per-Agent tool rules. It accepts reviewed native/pasted formats (including `mcpServers`) as disabled definitions, without starting services or copying native credentials. For Claude Code the scan also shows the current project's local scope and the managed `managed-mcp.json` read-only (never collected or migrated), marks same-named servers that a higher-priority scope overrides, shows the approval state of `.mcp.json` servers, the `managedMcpServers` of managed settings and the effect of the allow and deny lists from the settings files, lists the servers of enabled plugins read-only, and says what it cannot see (claude.ai connectors, policy delivered by MDM, the Windows registry or the claude.ai console). Reviews that write Claude Code's global file (`.claude.json`) ask you to close running Claude Code sessions first, because a running session keeps its own copy of the file and may write it back over the change; AgentKib does not look for Claude Code processes. After a migration the next scan marks a server that was taken out of the file but is back while the file no longer matches what AgentKib wrote. See [MCP management](MCP-MANAGEMENT.md).
- “Connect an Agent to the Hub” lets you choose a registered workspace and one of the eight writable agents, inspect the complete local Hub URL and native configuration path, copy the URL or configuration, or review a connection-only ChangeSet before writing it. A workspace does not need an existing manifest.
- New connections use the workspace's unique registered ID. Legacy manifest URLs remain valid when they identify one physical workspace; ambiguous aliases are rejected. Rewriting a connection with its registered ID restores ordinary Hub access. Continuation archives keep their existing manifest namespace, so shared or conflicting ownership still blocks archive reads, long-history handoffs, and operation recovery; changing the URL alone does not resolve that ambiguity. The Hub rechecks ownership on every archive read.
- Codex and Grok Build use TOML; Claude Code, Cursor, OpenCode, Antigravity and OpenClaw use their native JSON structures; Hermes uses YAML. Existing OpenCode configuration selection and JSONC/JSON5 compatibility are preserved. OpenClaw and Hermes write to Agent Home and require separate approval; their connection points to the selected workspace. OpenClaw honors its effective Home, profile, state directory, and config-path overrides; Hermes uses `HERMES_HOME` and the selected `active_profile` (or a directly selected profile Home). Planning and applying share the same path resolution, and a changed profile or config target requires a new plan.
- A connection-only ChangeSet preserves other servers and client settings. It refuses conflicting same-name entries and unsafe paths, uses the normal hash/backup protections, and updates an existing tracked configuration hash when necessary. It does not generate Instructions or Skills.
- After copying or writing, reload the target agent's MCP configuration and confirm that its tools are visible. AgentKib and the client must run on the same machine for the displayed loopback URL to work. Enabled global services are defaults; workspace services can override them, and each service's allowed-agent list controls publication.
- “Verify Hub” performs an HTTP MCP handshake and reads the tool catalog without calling tools or probing upstream services. It distinguishes AgentKib built-in tools from external tools, whose directory comes from the most recent service probe. “Configuration written,” “Hub reachable,” and a successful service probe do not confirm that another agent has loaded the connection. An empty external directory suggests checking enabled services, allowed agents, and service probing.

### Skill Hub

- A Skill is represented as one directory-level package rooted at `SKILL.md`; supporting files remain inside that package.
- The library lives under the AgentKib Home and does not automatically distribute or enable Skills in an Agent Home or workspace.
- Discovery supports the reviewed OpenAI catalog and public GitHub repository, tree, or `SKILL.md` URLs.
- Installation previews an immutable commit, package metadata, file list, executable resources, compatibility, license, and content changes without running package code.
- GitHub packages use API-downloaded snapshots and support selecting a tag, branch or commit during installation or later. Ordinary updates follow the recorded reference; rollback restores the previous contents and reference together. Only one previous version is retained.
- Managed Skills support update checks, local-drift warnings, one-version rollback, recoverable removal, and restore. Unmanaged local packages remain inspectable but cannot be updated online.
- Local-agent batch import supports filtering, select all, one reviewed batch and per-item results. Shared physical sources are merged; the same source and content already in the library are skipped, while different sources and changed snapshots remain independent. Native visibility restrictions do not prevent copying readable packages or change native settings.
- Skill management adds existing-installation inspection and copy import, bounded content previews, and reviewed personal/project deployments for all eight writable agents. Deployments have independent update, rollback and withdrawal; native visibility and shared-directory effects are reported separately from file installation. See [Skill management](SKILLS.md).
- Ownership checks cover ancestor project records across library homes and delayed Home-only ChangeSets. OpenCode's Claude compatibility visibility respects its disable flags and keeps its default source independent of Claude Home overrides.
- OpenCode inspection includes native configuration directories and effective `skills.paths`, with project-disable settings and independent sources evaluated together. Deployment lists refresh current native readers without rewriting ownership receipts.
- Local copy import preserves Skills that use their directory name instead of an explicit `name`. OpenCode compatibility inspection includes hidden, nested and ancestor sources without adding write targets.

Skill operations run sequentially in a dedicated Worker, with one active request and at most eight waiting requests. Network work has a 180-second total deadline from admission; a full queue fails immediately. Started local writes finish or roll back before shutdown completes. Slow catalog and file work does not occupy the Runtime request loop.

### Tools and updates

- Managed tools: Codex, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, and Grok Build. Antigravity CLI is detected and links to official installation documentation; its remote-script installer is not executed automatically. DeepSeek Harness is not exposed because it has no supported stable tool-management channel.
- Each installation reports its executable and resolved paths, version, runnable state, installation source, runtime environment, matching manager, and whether it is the PATH default.
- Version comparison follows the detected installation channel instead of treating a GitHub or npm release as universal.
- Automatic actions are bound to the detected installation and a pinned target version. Supported executable actions use verified npm, pnpm, bun, or Volta arguments without invoking a shell or requesting elevation. Homebrew and official updater channels that cannot pin an exact target fall back to a command for the user to review and run.
- Multiple physical installations, unverified sources, unavailable managers, privileged operations, remote scripts, and unsupported channels block automatic execution and fall back to an official command or documentation.
- An operation succeeds only after the target installation is re-detected, runnable, and verified at the expected version.

### Agent support

| Agent | Discovery and inventory | Context diagnostics and sync | Session history | Handoff source | Tool management |
| --- | --- | --- | --- | --- | --- |
| Codex | Yes | Yes | Yes | Yes | Yes |
| Claude Code | Yes | Partial | Yes | Yes | Yes |
| Antigravity | Yes | Yes | ACP sessions | ACP source only | Detect/docs |
| Cursor           | Yes                     | Yes                          | Verified CLI stores / connected macOS IDE profiles | CLI / IDE, per-session check | Yes             |
| OpenCode | Yes | Yes | Yes | Yes | Yes |
| OpenClaw | Yes | Yes | Read-only | Per-session check | Yes |
| Hermes | Yes | Yes | Read-only | Per-session check | Yes |
| Grok Build | Yes | Yes | Read-only | Per-session check | Yes |
| DeepSeek Harness | Beta, read-only | Diagnostics only | — | — | — |

Claude Code context diagnostics are partial. Covered, in the order Claude Code loads them: the managed policy `CLAUDE.md`; the user's `CLAUDE.md` and `rules` folder in the configuration folder; the instruction files of the parent directories of the workspace root (the fixed names `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`, plus `AGENTS.md` and `.claude/AGENTS.md` when the fallback applies, and their `.claude/rules`, which Claude Code 2.1.299 was seen loading at startup; the nearest 32 levels); the project `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` files from the workspace root down to the working directory, with `.claude/rules` read recursively in every one of those directories (within a directory: `CLAUDE.md`, `.claude/CLAUDE.md`, the rules, then `CLAUDE.local.md`); the `AGENTS.md` fallback that Claude Code applies when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or any parent (version 2.1.277 and later); rules with a `paths` field, which are listed with their patterns and not merged because they load only when a matching file is read; auto memory (the first 200 lines or 25 KB of `MEMORY.md` at its default location, left out when `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`); the removal of block-level HTML comments from `CLAUDE.md` files; and `@import` expansion up to four hops, with imports outside the workspace root read through a sensitive-file filter and redaction, and imports outside the working directory flagged because Claude Code asks for approval first. Sources outside the workspace are read-only and bounded, filtered and redacted before they are shown; the MCP tool returns only their sizes and counts, never their text or paths, and the Doctor does not evaluate sources outside the workspace. The same holds for the files of `~/.claude` that OpenCode and Grok Build read: the app shows them as before, the MCP tool returns only their number and size. Claude Code settings are read, read-only, from the managed files (`managed-settings.json` and `managed-settings.d/*.json`), the project's `.claude/settings.json`, the repository's `.claude/settings.local.json` and the user's `settings.json`, in Claude Code's precedence (managed, command line, local, project, user; lists merge across layers). The Context page shows each file, its keys and the effective values with the layer they come from; `env` shows names only, credential helpers (`apiKeyHelper` and similar) show only that they are configured, and commands, rules and URLs are redacted before they are shown. Exclusion matching has a shared computation budget per preview. If a rule exceeds that budget or the supported matching limits, the preview keeps sources whose exclusion could not be determined and reports the incomplete evaluation; existing privacy and redaction boundaries still apply. The settings change what is listed: `claudeMdExcludes` leaves out user, project and local files and the rule files of the project and its parent directories (never the managed ones; whether it reaches the user's own rules is not checked, so those stay listed), the managed `claudeMd` key loads like the managed `CLAUDE.md`, "Project instructions" (`pluginConfigs` of the built-in AGENTS.md plugin, read from managed and user settings only) switches between the AGENTS.md fallback, always reading it, never reading it and managed-only, `autoMemoryEnabled` and a user or managed `autoMemoryDirectory` change auto memory (a project or local `autoMemoryDirectory` is not applied, because Claude Code honors it only in a trusted folder). The MCP tool returns the project file's plain values and counts, and only the layer, parse state and key names of every other file. The Context page also lists, read-only, the plugins that settings enable (from `enabledPlugins` and the install records in the plugins folder, with the commands, agents, skills, output styles, hooks and MCP servers each one provides), the commands, agents, output styles and workflows of the project and the user (name, description, tools and model from the front matter, redacted), and the hooks of every settings layer and plugin (commands redacted). The MCP tool lists the project's own items and gives only counts for the user's items and for plugins. Skills, LSP servers, monitors, themes, channels and executables of plugins are not listed. Not visible to AgentKib: settings given with `--settings` or `--setting-sources`, policy delivered by MDM, a configuration profile or the Windows registry, and server-managed settings. Not modeled yet: `CLAUDE.md` files and rules in subdirectories that Claude Code loads on demand, `--add-dir` directories and nested work trees, and the environment variables that turn `CLAUDE.md` loading off, or set in a settings `env` block (they are only noted). Before Claude Code 2.1.281, some sessions (for example Bedrock or telemetry disabled) still read only CLAUDE.md. AgentKib only sees `CLAUDE_CONFIG_DIR` in its own process environment (an app started from Finder or the Dock does not see a shell `export`, a per-command alias or the `env` block of a settings file). The value must be an absolute path without `..`; otherwise AgentKib reads the default directory and refuses to write.

AgentKib distinguishes an installed app or CLI from local data left behind after uninstalling it. Agent Home writes require separate approval. Antigravity ACP sessions are not claimed to be the complete Desktop/IDE or CLI history store, and current stable interfaces cannot import foreign history into an Antigravity-native session. DeepSeek Harness remains a read-only Beta target and is never written to, configured for MCP, or included in tool management.

### Web access and continuation

- Pairing grants read access first. Sending and approvals are separate per-browser permissions and also require the host control switch.
- Claude Code desktop/Web control shares one execution service on macOS CLI versions at least `2.1.263`, with foreground Bash support at least `2.1.285`: prepare new sessions without a model call, or explicitly adopt an existing UUID after stopping its terminal. Native identities, protocol shapes, and receipts remain validated; accepting a newer version does not imply real-device acceptance. Managed sessions run the CLI with background tasks switched off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`) so sub-agents run in the foreground, tolerate frames and requests they do not know without ending the session (an unknown request is refused, never allowed), and are verified through `2.1.299`: synthetic frames plus one real-CLI acceptance run on 2026-10-14 (start-up, idle, Bash approval, one foreground sub-agent, one MCP approval, resume with the same UUID; see [live acceptance QA](../qa/claude-live-acceptance-2026-10-14.md)). LAN uploads remain disabled; Windows/Linux control remains unavailable. See [Claude usage](CLAUDE-WEB.md) and [historical native QA](../qa/claude-managed-2026-09-30.md) and [current TypeScript QA](../qa/typescript-stability-2026-10-07.md).
- Codex Web control follows an already-open official owner session, with minimum Desktop versions `26.917.62051` for base control and `26.924.22138` for settings. Unknown or malformed versions, unsupported platforms, missing owners, and incompatible native protocols remain read-only; satisfying the version threshold does not replace native validation or acceptance testing.
- Antigravity Web control manages only sessions returned by the official ACP server. It negotiates ACP v1 capabilities, checks the indexed session and workspace again, and requires exact revision, turn, request, and offered permission option matches.
- A request receipt does not mean a turn or approval completed. Disconnects and uncertain outcomes are never retried automatically.

### Platform status

| Platform | Status |
| --- | --- |
| macOS 13.3+ (Apple Silicon / Intel) | Primary development and acceptance platform; releases are signed and notarized |
| Windows 11 x64 | Release workflow builds and smoke-tests NSIS; installers are not yet Authenticode-signed |
| Ubuntu 22.04 x64 | Core CI platform; releases include verified `.deb` and AppImage packages |
| Fedora x64 | Platform checks run on pull requests; releases include verified `.rpm` packages |
| Windows ARM64 / Linux ARM64 | Preview packages with limited native regression coverage |

Platform setup and known limitations are documented in the [Windows guide](WINDOWS.md), [upgrade guide](UPGRADING.md), and [release guide](RELEASE.md).

## 简体中文

### 全局视图

| 区域 | 提供的能力 |
| --- | --- |
| 今日任务 | 排好优先级的本地行动项和近期工作区活动 |
| 工作区 | 自动发现或手动添加的项目，以及覆盖情况和警告 |
| 全局资产目录 | 跨工作区查看 Instructions、Skills、MCP、记忆和其他 Agent 资产 |
| Skill Hub | 本地 Skill 资源库、已有安装查看与批量复制入库、OpenAI 精选及 GitHub 导入与版本选择、个人/项目部署、更新、回滚、撤销部署和资源库可恢复移除 |
| Agent | 安装状态、配置 Home、能力和已发现资产 |
| 额度 | 本机可读取的额度窗口、余额和重置时间 |
| 洞察 | 本地派生的 Token、会话、Git 活动、热力图和成就 |
| 设置 | 发现目录、工具更新、集成、隐私控制和诊断 |

额度诊断显示最近尝试、最近成功、自动刷新设置及脱敏后的 Provider 错误。已验证的 Codex/Claude 费用统计超时不会丢弃成功取得的额度窗口，同时保留部分数据失败提示。完全失败时保留并标记上次成功快照；已过期的重置时间提示刷新，不再显示未来倒计时。

额度采集与 Claude Code 托管执行是两条独立路径，托管执行不读取凭据（见 [Claude 使用说明](CLAUDE-WEB.md)）。额度由随应用打包的第三方 sidecar 采集（macOS 与 Linux 为 CodexBarCLI 0.49.5，Windows x64 为 Win-CodexBar 0.60.3），它以你的用户环境运行，只在手动刷新或你开启“自动获取额度”（默认关闭）后启动。AgentKib 自身不读取各 Provider 的凭据：它解析 sidecar 输出的 JSON，保留标准化后的额度窗口、余额、重置时间、账号邮箱与套餐，并对错误信息脱敏；但 sidecar 可能读取凭据。对 Claude，CodexBar 文档（v0.49.5）列出的来源有：

- claude.ai 的 `sessionKey` Cookie，从浏览器配置文件导入（文档列出的位置是 macOS 的 Safari、Chrome 系浏览器和 Firefox），或使用手动提供的 Cookie 头。
- 在伪终端中运行 `claude` CLI 读取 `/usage` 的探测。
- Claude Code 的 OAuth 凭据（CodexBar 自己的缓存、`~/.claude/.credentials.json`，或 Keychain 项 `Claude Code-credentials`），用于访问 `api.anthropic.com`。
- 为统计费用，扫描本地 Claude Code 会话日志（`projects/**/*.jsonl`）里按模型记录的 Token 数量。

对 macOS 与 Linux 上打包的 CodexBarCLI，文档记载的自动顺序是先用 Cookie 来源、再用 `claude` 探测，OAuth 来源在 CodexBar 配置里显式选择时才生效；文档同时说明个别内部代码路径仍使用不同的自动顺序，所以这是上游文档记载的行为，不是 AgentKib 的保证。没有 CodexBar 配置时，AgentKib 生成的配置只启用已安装的 Provider（Codex、Claude Code、Cursor 之中），不选择数据源；已有的 CodexBar 配置或 `CODEXBAR_CONFIG` 优先，额度页的采集器诊断会显示实际使用的配置。Win-CodexBar 是独立的 Windows 移植版：其文档和源码（v0.60.3）同样涉及浏览器 Cookie（Chrome、Edge、Brave、Firefox）、`claude` CLI 和 OAuth，自动顺序为网页 Cookie、OAuth、`claude` CLI（已配置 Admin API 密钥时先用它）；只有启用一项默认关闭的设置后，才会读取 Claude Code 自己的凭据文件或凭据管理器条目。

### 工作区内

| 区域 | 提供的能力 |
| --- | --- |
| 概览 | Agent 覆盖、共享资产状态和工作区信号 |
| 继续工作 | 本地会话浏览和经过审查的跨 Agent 交接 |
| 资产 | 工作区范围的 Instructions、Skills、MCP、记忆和原生配置 |
| Git | 只读的仓库状态和活动 |
| 上下文 | 指定 Agent 与目录的有效加载顺序、作用域、覆盖和冲突 |
| 诊断 | 跨受支持 Agent 的可执行诊断 |
| 变更 | 待处理和历史 ChangeSet，以及完整 Diff |

生成的变更遵循先审查、后写入的流程：

```text
发现本机工作区与 Agent 状态
              ↓
预览有效上下文并进行诊断
              ↓
生成 ChangeSet 和完整 Diff
              ↓
只有明确确认后才写入
```

浏览、预览和诊断不会创建 manifest，也不会修改 Agent 配置。工作区不需要预先存在 `.agentkib/manifest.yaml`；只有首次保存共享资产时，AgentKib 才会把它加入待审查的 ChangeSet。

### 会话历史

- 桌面与 Web 支持默认关闭的本机正文关键字搜索，覆盖用户/助手文字与可读取的工具输入输出，可按工作区、Agent、正文/工具及归档状态筛选。命中片段可定位并选段引用到当前草稿，保持目标会话不变，只有用户明确发送才带入引用；其他配对主机仍只搜索标题。启用、清理、重建限本机所有者操作，会话索引总开关也会清除派生正文缓存。
- 下表八个 Agent 均有正文来源适配器；Cursor 工具记录尚未支持，附件正文与隐藏推理不在范围内。超限、损坏或不支持的记录明确显示部分覆盖；原文变化会使旧位置及未发送引用失效，Web 来源读取与目标发送分别授权。详见[来源矩阵、上限与清理行为](SESSION-CONTENT-SEARCH.md)。本轮仅有 TypeScript 自动化证据，未执行 Windows/Linux 本机验收或模型调用，不复用历史 Rust 证据。

- 本机 Codex、Claude Code 与 Antigravity 支持在会话页原地聊天，共用 Remote 的完整操作组件和原生事件流；具体控制按平台、版本、归属及授权开放。附件、设置、审批、队列、目标与产物入口见 [实时会话](CONVERSATIONS.md)。打开会话不自动接管任务。

- 目录显示用户对话和用户创建的分叉。辅助/子代理记录保留在索引中，但从桌面与 Remote 的目录、搜索、最近会话、计数和续接来源中排除；旧链接返回目录并说明原因。无法识别的来源和正常未命名对话仍保留显示。
- 程序启动的会话属于执行记录，目录默认不显示：普通 Codex `exec` 运行，以及入口为 `sdk-cli`、`sdk-ts`、`sdk-py`（Agent SDK 与 `-p` 运行，例如 Pen）、后台 `daemon` 会话和 `/loop` 运行的 Claude Code 会话。判断规则与 Claude Code 2.1.311 在自身恢复列表中隐藏这类会话的规则一致，不按工作目录或工具名判断。目录选项“显示程序启动的会话”打开后，桌面和 Web 的目录列出这些会话，行上带机器人图标，并计入筛选数量；该选项默认关闭、不保存，会话仍只可查看。AgentKib 自己运行的 Claude Code 会话照常显示。升级后的下一次刷新会重新分类已缓存的 Claude Code 会话，并记下每个会话的工作目录。
- 会话归属于包含其工作目录的最深一层登记工作区。主目录这类外层工作区刷新时，不再抢走登记在其内部的工作区的会话；内层工作区不再列出某个会话时，才交还外层。
- 同一个 git 仓库的检出在目录中合为一组，组名用主检出的名称，组头写“· N 个工作树”，悬停列出名称。在工作树里运行的会话即使归属更外层的工作区，只要这台电脑登记了该仓库的某个工作区，就回到仓库那一组。主检出没有登记时，组名取主检出的文件夹名；连主检出也找不到时，组名旁加工作树图标，悬停提示“这是 git 工作树”。工作树会话行只放一个工作树图标（lucide `Split`，与分叉标识不同），悬停和读屏给出工作树名称、分支、路径和状态；工作树已删除时图标变淡，说明里写明已删除。会话页显示“工作树 {名称} · {分支}”，已删除或无法检查时写“· 已删除”“· 状态未知”。概览、桌面首页的“继续最近工作”和 Web 首页的“最近会话”按会话所在的目录分组命名。工作区页和侧栏把工作树缩进列在主检出下面。
- 工作树信息只读 `.git`、`gitdir`、`commondir`、`HEAD`、`config` 和 `worktrees/*`，不运行 git；git 公共目录不是检出自己的 `.git` 时判定为分出来的工作树。工作树已删除时，按 git 自己的工作树记录、仓库内的 `.claude/worktrees` 路径归组；已被清理的 Codex 工作树按线程记录的 `git_origin_url` 匹配主检出的 `origin`，两个克隆共用同一远程地址时不归组。元数据读取失败时显示“状态未知”。这些会话的历史照常可读，继续前需要恢复文件夹（见[实时会话](CONVERSATIONS.md)）。分组只影响显示：归属、授权和控制检查仍按会话自己的工作区。
- AgentKib 托管会话沿用持久归属记录展示，并去除重复的原生索引别名。桌面配对 Remote 的目录只读校验已有托管归属，不创建或迁移归属账本，保留用于读取历史的原生索引 ID。旧 Codex 历史导入仅在完整导入标记、会话身份及工作目录均匹配时保留显示，此识别不授予控制权限。TypeScript 后端将分类版本更新为 3，一次性使旧 Codex 工作区及会话集合缓存失效，首次目录读取先重新分类再展示缓存，不改写原生历史；扫描不完整时，已重新分类的记录继续显示，尚未重算的旧记录保留在索引中，待来源可读后再显示。旧缓存全部重新分类后，即使某个来源仍不可用，普通读取也不再重复升级扫描；清空索引同时清除待分类标记，保留分类版本。主机和 Remote 前端均需更新才能完整生效。
- 本机与配对目录的原生别名校验要求账本在 20,000 条读取上限内保持完整，并先判断归属唯一性再过滤工作区；超限时保留原生执行记录分类，跳过别名映射及去重。本机托管条目继续使用账本身份，普通对话仍可读取。配对目录的归属投影失败时，索引记录保持原分类和可读性，Runtime 输出不含账本内容或路径的诊断；控制账本校验仍按原规则拒绝错误。
- 分叉保留独立身份和原标题，通过小型分叉标识及来源信息区分；子代理父关系与历史分叉关系独立，不按同名合并。成功刷新会同步归档、删除状态；来源不可用或结构不支持时保留上次缓存快照。
- 默认加载最新 50 条记录（消息和工具摘要），按时间正序展示；更早记录按需加载。正常分页不提示轮次不完整，真实读取错误与内容截断仍显示。
- 本机 Codex 与 Claude Code 会话在桌面会话页和 Web 显示结构化的工具行：命令带状态、非零退出码、耗时和输出末尾；文件改动带增删行数与有界的差异预览；另有 MCP、搜索和子代理动作。每轮显示用时，有文件改动的轮次在回复下方按文件汇总，可就地展开差异。预览按正文搜索的规则脱敏，单项不超过 32 KiB，只读浏览器同样可见；推理内容、Claude 的 `originalFile` 和读取类工具的文件正文不下发。桌面查看其他电脑上的会话、Antigravity 及其他 Agent 仍只显示工具名和状态。详见[工具详情与轮次时长](CONVERSATIONS.md)。
- 桌面与 Remote 独立于设置能力显示最近原生上下文报告。压缩期间阻止发送、steer、设置、目标修改与归属转移，直到原生阶段结束；压缩后用量未确认不会延长发送锁。详见[实时状态与报告来源](CONVERSATIONS.md)。
- Codex 与 Claude Code 的 JSONL 历史从文件尾部开始有界读取，不再先读取完整文件才分页。Antigravity ACP 历史通过官方 ACP server 有界回放。OpenCode 通过有界导出命令读取；OpenClaw、Hermes 和 Grok Build 使用各自经过校验的本机历史来源。单页体积限制可能使结果少于 50 条；本次扫描窗口为空时，仍可能继续加载更早记录。
- 损坏或超大的日志记录会显示提示；距离过远的消息/工具关联，以及无法明确判断的旧格式元数据，会保守展示并提示，而非要求扫描完整文件。
- 历史分页只读，不修改原记录。表中八个 Agent 均有来源适配器，能否交接取决于具体会话解析；Cursor 使用已验证 CLI 格式或显式连接的 macOS IDE profile，OpenClaw 支持 schema-23 SQLite，并在不存在权威 SQLite 存储时兼容旧 JSONL。无法保留必要正文的压缩或不完整历史会被拒绝。OpenCode 1.18.32、Hermes 0.21.5 与离线 OpenClaw 2026.9.6 新增原生导入：审查临时载荷、保存操作记录、核对目标全文后才启动。历史 QA 分别记录了特定方向的离线存储、原生界面、重启与代表性文本回复结果，不代表所有来源×目标、富内容或迁移后的 TypeScript 后端均已验收，详见[方向与版本兼容矩阵](SESSION-INTEROPERABILITY.md)。

### MCP Hub 与客户端接入

- HTTP MCP 的 OAuth 凭据会绑定签发它们的授权服务器。升级到 MCP SDK 1.31.0 安全修复版本后，缺少此绑定的旧凭据需要重新登录；请从对应 MCP 服务条目重新授权。
- 桌面 MCP 页区分服务收录／编辑、Agent 批量接入和按 Agent 分配具体工具。已验证原生／粘贴格式（包括 `mcpServers`）收录为停用定义，不启动服务、不复制原生凭据。对 Claude Code，读取时还会只读显示当前项目的 local 作用域与 managed 的 `managed-mcp.json`（不收录、不迁移），标出被更高优先级作用域覆盖的同名服务，还会按 settings 文件显示 `.mcp.json` 服务的批准状态、managed settings 的 `managedMcpServers` 以及允许与拒绝列表的影响，只读列出已启用插件提供的 MCP 服务，并说明看不到的内容（claude.ai 连接器、经 MDM、Windows 注册表或 claude.ai 控制台下发的策略）。写入 Claude Code 全局文件（`.claude.json`）的审查界面会提示先关闭正在运行的 Claude Code 会话：运行中的会话在内存里保留着这个文件的副本，可能整份写回、覆盖这次改动；AgentKib 不检测 Claude Code 进程。迁移之后的下一次扫描会标出“被迁出的服务又出现、而文件已不是 AgentKib 写入的内容”的情况。参见 [MCP 管理说明](MCP-MANAGEMENT.md)。
- “连接 Agent 到 Hub”可选择已注册工作区和八个可写 Agent 之一，查看完整本机 Hub URL 与原生配置路径、复制地址或配置，或先审查仅包含连接变更的 ChangeSet 再写入。工作区无需已有 manifest。
- 新连接使用工作区的唯一注册 ID。旧 manifest 地址只有在能唯一定位物理工作区时才兼容；存在歧义时拒绝。改用注册 ID 重写连接可恢复普通 Hub 访问。续接归档仍沿用旧 manifest namespace，共享或冲突归属会阻止归档读取、长历史交接和操作恢复；只改 URL 不能解决归档歧义。Hub 每次读取归档都会重新核对归属。
- Codex、Grok Build 使用 TOML；Claude Code、Cursor、OpenCode、Antigravity、OpenClaw 使用各自原生 JSON 结构；Hermes 使用 YAML。沿用已有 OpenCode 配置选择规则与 JSONC/JSON5 兼容行为。OpenClaw、Hermes 写入 Agent Home，需单独确认，连接会指向所选工作区。OpenClaw 遵循有效的 Home、profile、state directory 和 config-path 覆盖配置；Hermes 使用 `HERMES_HOME` 与所选 `active_profile`，也支持直接选择 profile Home。规划与应用共用路径解析，profile 或配置目标变化后须重新规划。
- 接入 ChangeSet 保留其他服务及客户端设置，拒绝同名冲突和不安全路径，并复用哈希检查与备份保护；必要时同步已跟踪配置的哈希，不生成 Instructions 或 Skills。
- 复制或写入后，在目标 Agent 重新加载 MCP 配置并确认工具可见。页面显示的 loopback URL 要求 AgentKib 与客户端运行在同一台机器。已启用的全局服务作为默认配置，工作区服务可覆盖它们，各服务的允许 Agent 范围控制工具发布。
- “验证 Hub”通过 HTTP 完成 MCP 握手并读取工具目录，不调用工具、不探测上游。结果区分 AgentKib 内置工具与外部工具，外部目录来自最近一次服务探测。“配置已写入”“Hub 可达”及服务探测成功均不代表其他 Agent 已加载连接。外部目录为空时，可检查服务启用状态、允许 Agent 范围并执行服务探测。

### Skill Hub

- 一个 Skill 以 `SKILL.md` 所在目录作为包级入口，支持文件保留在包内，不会成为重复的顶层资产。
- 资源库位于 AgentKib Home，不会自动向 Agent Home 或工作区分发或启用 Skill。
- 发现支持 OpenAI 精选目录，以及公开 GitHub 仓库、Tree 目录或 `SKILL.md` URL。
- 安装前会预览固定到不可变 Commit 的包元数据、文件列表、可执行资源、兼容性、许可证和内容变化，不执行包内代码。
- GitHub 包通过 API 下载快照，安装时及安装后均可选择 tag、分支或 commit。普通更新沿用已记录的引用，回滚同时恢复上一版本的内容和引用；只保留上一版本。
- 受管 Skill 支持更新检查、本地漂移提醒、上一版本回滚、可恢复移除与恢复；本地未托管包可以检查，但不能在线更新。
- 从本机 Agent 批量导入支持筛选、全选、统一预览及逐项结果。同一物理来源合并，已入库且来源与内容相同的包跳过，不同来源及变化快照分别保留。原生可见性限制不阻止复制可读包，也不会因复制改变原生设置。
- Skill 管理支持查看并复制已有安装、限长内容预览，以及八种可写 Agent 的个人/项目部署。部署可独立更新、回滚和撤销；原生可见性和共享目录影响与文件落盘状态分别展示。参见 [Skill 管理说明](SKILLS.md)。
- 所有权检查覆盖跨资源库的祖先项目记录，以及延迟应用的纯 Home ChangeSet。OpenCode 的 Claude 兼容可见性遵循禁用开关，其默认来源独立于 Claude Home 覆盖配置。
- OpenCode 查看范围包含原生配置目录及生效的 `skills.paths`，综合项目禁用配置和独立来源判断可见性。部署列表刷新当前原生读取方，不重写所有权记录。
- 本地复制入库支持以目录名代替显式 `name` 的 Skill。OpenCode 兼容来源扫描包含隐藏、嵌套和祖先目录，不增加写入目标。

Skill 操作由独立 Worker 顺序处理，允许 1 个执行中请求和最多 8 个等待请求。网络任务从入队起采用 180 秒总期限，队列满立即返回错误。已启动的本地写入完成或回滚后才结束退出；慢目录请求和文件处理不占用 Runtime 主请求循环。

### 工具与更新

- 管理 Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes 和 Grok Build。Antigravity CLI 支持检测并提供官方安装文档，但不会自动执行远程脚本安装器。DeepSeek Harness 没有受支持的稳定工具管理渠道，因此不在此处展示。
- 每处安装展示可执行路径与解析后路径、版本、可运行状态、安装来源、运行环境、对应管理器和 PATH 默认项。
- 版本比较遵循检测到的安装渠道，不会把 GitHub 或 npm 的版本通用于所有安装。
- 自动操作绑定实际安装与固定目标版本，通过经过验证的 npm、pnpm、bun 或 Volta 参数执行，不经过 Shell，也不请求提权。Homebrew 或官方更新器无法固定精确目标版本时，只提供供用户审查并自行运行的命令。
- 多个物理安装、来源不明、管理器不可用、需要提权、远程脚本或不支持的渠道会阻止自动执行，改为提供官方命令或文档。
- 命令退出后只有重新检测到目标安装可运行且达到预期版本，才会报告成功。

### Agent 支持

| Agent | 发现与盘点 | 上下文诊断与同步 | 会话历史 | 交接来源 | 工具管理 |
| --- | --- | --- | --- | --- | --- |
| Codex | 支持 | 支持 | 支持 | 支持 | 支持 |
| Claude Code | 支持 | 部分支持 | 支持 | 支持 | 支持 |
| Antigravity | 支持 | 支持 | ACP 会话 | 仅作来源 | 检测/文档 |
| Cursor           | 支持       | 支持             | 已验证 CLI 存储 / 已连接的 macOS IDE profile | CLI / IDE，逐会话核验 | 支持      |
| OpenCode | 支持 | 支持 | 支持 | 支持 | 支持 |
| OpenClaw | 支持 | 支持 | 只读 | 逐会话核验 | 支持 |
| Hermes | 支持 | 支持 | 只读 | 逐会话核验 | 支持 |
| Grok Build | 支持 | 支持 | 只读 | 逐会话核验 | 支持 |
| DeepSeek Harness | Beta，只读 | 仅诊断 | — | — | — |

Claude Code 的上下文诊断目前是部分支持。已覆盖，按 Claude Code 的加载顺序：managed 策略的 `CLAUDE.md`；配置目录里的用户级 `CLAUDE.md` 与 `rules` 目录；工作区根的各级上级目录里的指令文件（固定文件名 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`，回退时加 `AGENTS.md` 与 `.claude/AGENTS.md`，以及它们的 `.claude/rules`——Claude Code 2.1.299 真机确认会在启动时加载；最近的 32 层）；从工作区根到工作目录的项目 `CLAUDE.md`、`.claude/CLAUDE.md` 与 `CLAUDE.local.md`，以及这些目录里递归读取的 `.claude/rules`（同一目录内依次是 `CLAUDE.md`、`.claude/CLAUDE.md`、规则、`CLAUDE.local.md`）；工作目录及其上级目录里都没有 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 时 Claude Code 回退读取的 `AGENTS.md`（2.1.277 及以后的版本）；带 `paths` 字段的规则只在读取匹配文件时才加载，所以只列出匹配模式，不并入常驻内容；自动记忆（默认位置的 `MEMORY.md` 的前 200 行或 25 KB，`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 时不显示）；`CLAUDE.md` 文件中块级 HTML 注释的剥离；最多四跳的 `@import` 展开，其中工作区根之外的导入经过敏感文件过滤与脱敏，工作目录之外的导入因 Claude Code 会先请求批准而加以标注。工作区外的来源只读、有上限，显示前经过过滤与脱敏；MCP 工具对它们只返回大小与数量，不返回正文与路径；Doctor 不评估工作区外的来源。OpenCode 与 Grok Build 读取的 `~/.claude` 个人文件同样如此：应用里照常显示，MCP 工具只返回数量与大小。Claude Code 的设置按只读方式读取：managed 文件（`managed-settings.json` 与 `managed-settings.d/*.json`）、项目的 `.claude/settings.json`、仓库根的 `.claude/settings.local.json` 和用户的 `settings.json`，优先级沿用 Claude Code 的顺序（managed、命令行、local、project、user；列表跨层合并）。上下文页显示每个文件、它设置了哪些键，以及生效值和来源层；`env` 只显示键名，`apiKeyHelper` 等凭据助手只显示“已配置”，命令、规则和 URL 先脱敏再显示。一次预览内的排除规则匹配共用计算预算。规则超过计算预算或受支持的匹配上限时，预览保留无法确认是否应排除的来源，并明确提示匹配未完成；原有隐私和脱敏边界仍然生效。设置会改变列出的内容：`claudeMdExcludes` 排除用户、项目和 local 的文件，以及项目和上级目录的规则文件（不会排除 managed 的；它是否作用于用户自己的规则未核对，所以那些规则仍列出）；managed 的 `claudeMd` 键与 managed 的 `CLAUDE.md` 一样加载；“Project instructions”（内置 AGENTS.md 插件的 `pluginConfigs`，只读取 managed 与用户设置）在 AGENTS.md 回退、始终读取、从不读取和仅 managed 之间切换；`autoMemoryEnabled`，以及用户或 managed 设置里的 `autoMemoryDirectory`，会改变自动记忆（项目或 local 设置里的 `autoMemoryDirectory` 不会应用，因为 Claude Code 只在受信任的文件夹里采用它）。MCP 工具对项目文件只返回不含私密的普通值与数量，对其他文件只返回所在层、能否解析和键名。上下文页还只读列出：settings 启用的插件（来自 `enabledPlugins` 和插件目录里的安装记录，以及每个插件提供的 commands、agents、skills、输出样式、hooks 和 MCP 服务），项目与用户的 commands、agents、输出样式和 workflows（来自 front matter 的名称、描述、tools 与 model，经脱敏），以及各层 settings 与插件的 hooks（命令脱敏）。MCP 工具只列出项目自己的条目，对用户级条目和插件只给数量。插件的 skills、LSP 服务、monitors、主题、channels 和可执行文件不列出。AgentKib 看不到：通过 `--settings` 或 `--setting-sources` 传入的设置、经 MDM、配置描述文件或 Windows 注册表下发的策略，以及服务端托管的设置。尚未建模：Claude Code 按需加载的子目录里的 `CLAUDE.md` 与规则、`--add-dir` 目录与嵌套 work tree，以及会关闭 `CLAUDE.md` 加载的环境变量，或设置在 settings 的 `env` 块里的这些变量（只给出提示）。Claude Code 2.1.281 之前的部分会话（如 Bedrock 或关闭遥测）仍只读 CLAUDE.md。AgentKib 只认自己进程环境里的 `CLAUDE_CONFIG_DIR`（从 Finder 或 Dock 启动的应用看不到 shell 里的 export、逐次设置的 alias，也看不到 settings 的 `env` 块）；值须是不含 `..` 的绝对路径，否则读取使用默认目录，写入会被拒绝。

AgentKib 会区分“已安装”和“卸载后仍留有本地数据”。涉及 Agent Home 的写入会单独请求授权。Antigravity ACP 会话不代表完整的 Desktop/IDE 或 CLI 历史；当前稳定接口也不能把外部历史导入 Antigravity 原生会话。DeepSeek Harness 仍是只读 Beta 目标，不会被写入、配置 MCP 或纳入工具管理。

### Web 访问与续接

- 配对首先授予读取权限；发送和审批是单独的浏览器权限，同时还需要打开主机控制开关。
- Claude Code 桌面/Web 在 macOS CLI ≥ `2.1.263` 上共用执行服务，前台 Bash 契约要求 ≥ `2.1.285`：准备新会话不调用模型，停止原终端并确认后可续接原 UUID。仍核验原生身份、协议结构和回执，新版通过最低门槛不代表真实设备验收通过。托管会话启动 CLI 时关闭后台任务（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`），子代理在前台运行；对不认识的帧与请求不再终止会话（不认识的请求只会被拒绝，绝不放行）；对帧的处理验证到 `2.1.299`：合成帧加 2026-10-14 的一次真机验收（启动、空闲、Bash 审批、一个前台子代理、一次 MCP 审批、同一 UUID 续接；见[真机验收 QA](../qa/claude-live-acceptance-2026-10-14.md)）。LAN 仍禁上传，Windows/Linux 控制保持不可用。详见 [Claude 使用说明](CLAUDE-WEB.md) 与[历史原生 QA](../qa/claude-managed-2026-09-30.md) 及[当前 TypeScript QA](../qa/typescript-stability-2026-10-07.md)。
- Codex Web 控制跟随官方客户端中已打开的 owner 会话，Desktop 基础控制要求 ≥ `26.917.62051`，会话设置要求 ≥ `26.924.22138`。版本未知或格式异常、平台不支持、没有 owner 或原生协议不兼容时保持只读；满足门槛不能代替原生校验和真实验收。
- Antigravity Web 控制只管理官方 ACP server 返回的会话。运行时协商 ACP v1 能力，重新核验索引会话和工作区，并要求 revision、turn、request 与服务端提供的权限选项全部精确匹配。
- 请求回执不代表轮次或审批已经完成。断线或结果不明确时不会自动重试。

### 平台状态

| 平台 | 状态 |
| --- | --- |
| macOS 13.3+（Apple Silicon / Intel） | 主要开发与验收平台；发布包已签名并通过 Apple 公证 |
| Windows 11 x64 | 发布工作流构建并烟测 NSIS；安装包尚未进行 Authenticode 签名 |
| Ubuntu 22.04 x64 | 核心 CI 平台；发布包包含经过验证的 `.deb` 与 AppImage |
| Fedora x64 | PR 运行平台检查；发布包包含经过验证的 `.rpm` |
| Windows ARM64 / Linux ARM64 | Preview 包，原生回归覆盖有限 |

平台配置和已知限制见 [Windows 指南](WINDOWS.md)、[升级指南](UPGRADING.md)和[发布指南](RELEASE.md)。
