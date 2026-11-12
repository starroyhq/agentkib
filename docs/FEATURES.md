# Features and compatibility / 功能与兼容矩阵

This document describes AgentKib's current product surfaces and support boundaries. For installation and the product overview, see the [README](../README.md).

本文档描述 AgentKib 当前的产品界面与支持边界。安装方式和产品简介见[中文 README](../README.zh-CN.md)。

Native acceptance is tied to each QA report's revision and Agent version. Current TypeScript backend automation and candidate-package checks are recorded separately in [TypeScript stability QA](../qa/typescript-stability-2026-10-07.md); older Rust evidence is not reused as migration acceptance.

原生验收只适用于各 QA 记录的源码与 Agent 版本。当前 TypeScript 后端自动化和候选包检查单独记入[本轮稳定性 QA](../qa/typescript-stability-2026-10-07.md)，不将旧 Rust 证据当作迁移后的验收结果。

## English

### Native session connection

| Surface | Version / platform | Boundary |
| --- | --- | --- |
| Claude native terminal → desktop / Web | CLI 2.1.301 or later, macOS, opt-in Mods plugin 0.4.0 or later (a terminal keeps connecting after an AgentKib update); required capability checks | Existing executor; observation, text messages and current-turn cancellation are enabled. CLI 2.1.301 and 2.1.310 are verified; higher stable versions that pass the checks connect too, without a standing notice: a feature that depends on the version says so where it is used. A message sent while the terminal is idle starts a turn; while a turn runs it is queued for after the turn or added to it, as each device's "Send while running" setting chooses. Approvals/questions stay in the terminal; attachments and advanced orchestration are disabled. |
| Claude managed | Existing compatibility gates unchanged | AgentKib owns the process; explicit history handoff and existing controls remain separate. |
| Codex managed | Codex CLI 0.147.0 or later | AgentKib's own app-server continues the session when the writer lock is free. |
| Codex Desktop follower | Desktop 26.917.62051 or later, macOS | Used only when another process holds the writer lock and the Desktop IPC reports an owner; send (with attachments), stop and approval are forwarded to the owner. |
| Codex shared app-server | CLI 0.155.1, isolated macOS probe | Verification only; no new production mode or daemon installation. |
| DeepSeek Harness → desktop / Web | DSH 0.2.1-rc.5 or a later 0.2 release, macOS, bridge plugin 0.5.0 or later installed by the user (after an AgentKib update a running DSH stays connected; restarting DSH turns on what the newer plugin adds), or DSH Desktop installed for AgentKib to start DSH in the background | DSH stays the only executor. While it runs, sending (with images), queueing or steering, editing or withdrawing a waiting message, stopping, answering approvals and questions, goals, slash commands, compaction and permission presets go through its own session services; the first answer wins between DSH and AgentKib. 0.2.1-rc.5 is verified; later 0.2 releases connect too, without a standing notice: a feature their DSH lacks says so where it is used. Without a running DSH, AgentKib starts DSH in the background (web profile, DSH Desktop's own command line, the plugin mounted by AgentKib) when a session is opened, sent to or started; it stops after three idle minutes (one while DSH Desktop's window is open), at once when the user's own DSH with the plugin connects, and with AgentKib. With the "Start DeepSeek Harness when needed" setting off, the session is view-only. |

Quitting AgentKib stops the turns that run or wait for an answer in processes it started (managed Codex, Claude Code and Antigravity sessions, and a DeepSeek Harness it started in the background); it lists them and asks first. Turns in a connected terminal, Codex Desktop or the user's own DSH go on.

Current native and synthetic results are recorded separately in [connection QA](../qa/native-session-connection-2026-10-16.md). Subsequent Haiku 5.5 and Luna6 checks distinguish model responses from complete-chain acceptance in [real-model QA](../qa/native-session-real-model-2026-10-16.md). See [Claude connection instructions](agents/claude-code-terminal.md). DeepSeek Harness results are in [DSH phase 1 QA](../qa/dsh-integration-phase1-2026-11-04.md); the design is in the [integration plan](agents/deepseek-harness.md).

原会话连接与托管执行分别验收。Claude 原连接限 macOS，最低 CLI 2.1.301，需主动安装插件（合约 0.4.0 或更新，AgentKib 升级后正在运行的终端照常连接）并通过必需能力检查；目前 2.1.301 和 2.1.310 已验证，更高稳定版通过检查后同样允许连接，不常驻显示未验证提示，确实依赖版本的功能在用到时说明。终端空闲时从 AgentKib 发送会开始新一轮，运行中可以排到本轮之后或加入本轮，默认方式由各设备的“运行中发送”设置决定；审批和问题在原终端处理。Codex 共享 app-server 本轮只验证，不替换现有生产链路。DeepSeek Harness 同样限 macOS，需由用户在所运行的 profile 中安装 AgentKib 插件（0.5.0 或更新）并重启 DSH；AgentKib 升级后已连接的 DSH 继续可用，重启 DSH 后才用上新插件带来的功能；DSH 始终是唯一执行者，审批和问题两边都可以作答，先答者生效；0.2.1-rc.5 已验证，更新的 0.2 版本同样可以连接，不常驻显示未验证提示，它缺少的功能在用到时说明；没有运行的 DSH 时，打开、发送或新建会话会让 AgentKib 在后台启动 DSH（web 配置，用 DSH Desktop 自带的命令行，插件由 AgentKib 加载），空闲 3 分钟（DSH Desktop 的窗口开着时 1 分钟）、用户自己装了插件的 DSH 连上时或 AgentKib 退出时关闭；关掉“需要时自动启动 DeepSeek Harness”后只可查看。退出 AgentKib 会停止在它启动的进程里运行或等你作答的轮次（托管的 Codex、Claude Code、Antigravity 会话，以及它在后台启动的 DeepSeek Harness），退出前先列出并请你确认；接在终端、Codex Desktop 或你自己的 DSH 里的轮次不受影响。

### Across your machine

| Area | What it provides |
| --- | --- |
| Home | Start a new session; this computer's sessions: what needs you (approvals, questions, results to verify), unread results, turns in progress and recent sessions; approvals and questions are answered in their rows; a side column for quota, remote access and upkeep |
| Menu bar | The icon shows state without being opened: a dot and the count while something needs you, a turning ring while a session runs. Its popover lists what needs you, turns in progress and unread results; the first approval is answered in one click ("Allow once" or "Deny"; other options open the session), a running turn can be stopped from its row, and a one-line new session starts in the last workspace and Agent used. Each Agent's quota is a ring that opens its windows; remote access names the paired device that is online and can be paused or resumed. Right-click keeps only "Open" and "Quit"; on Linux the native menu also lists what needs you |
| Workspaces | Discovered and manually added projects, with coverage and warnings |
| Asset catalog | A machine-wide view of Instructions, Skills, MCP, memory, and other agent assets |
| Skill Hub | A local Skill library, existing-installation inspection and batch copy import, reviewed OpenAI/GitHub sources, GitHub version selection, personal/project deployment, updates, rollback, withdrawal, and recoverable library removal |
| Agents | Installation state, configuration homes, capabilities, and discovered assets |
| Quota | Quota windows, balances, reset times, and local Codex/Claude API-price estimates |
| Insights | Token, session, Git activity, heatmaps, and achievements derived locally |
| Settings | Discovery roots, tool updates, integrations, privacy controls, and diagnostics |

The Memory page reads Claude Code project auto memory from workspaces already discovered by AgentKib, including workspaces without an AgentKib manifest. It lists `MEMORY.md` and Markdown topic files in the resolved memory directory, deduplicates shared repository/worktree or custom directories, and keeps native files separate from AgentKib proposals. Native files are read-only and do not require approval to view; viewing them does not mean the current Claude session has loaded them. The index preview is separate from Claude's startup limit (the first 200 lines or 25 KB); Claude reads topic files on demand. `CLAUDE.md`, rules, independent subagent memory and unmapped historical directories are outside this reader's scope. Native text is not shared through MCP, remote Web, other Agents or cloud sync.

The memory browser groups non-empty entries by project and shows filenames without body titles, excerpts or modification dates. Wide windows use independently scrolling list and reader panes; narrow windows open a detail drawer. Source diagnostics are collapsed by default, while errors, stale cache and incomplete scans appear on project rows and in a summary. Preview and raw-text views remain read-only, and shared directories retain their workspace associations.

Native memory uses a separate local SQLite cache containing redacted text. The page shows cached results first, watches file changes and rechecks every five seconds while visible, and reconciles again on focus or manual refresh independently of global refreshes. Read failures retain the last result as stale; confirmed deletions remove files, and excluded workspaces, changed configuration roots or disabled auto memory withdraw the old source. Reads stay within the resolved memory directory and apply sensitive-path filtering. Scans are bounded to 512 files and four subdirectory levels, 512 KiB per file with the existing text limit, and 8 MiB of indexed text per directory; truncation and incomplete scans are explicit. Existing AgentKib proposal approval and Agent-search semantics are unchanged.

Insights defaults to the last 30 local calendar days, including today. Select 7, 30 or 90 days, this year, the last 52 weeks, or a custom range; custom dates must be valid, ordered, no later than today, and span at most 366 days. The selected range is remembered locally. Totals, active days, the heatmap and trend charts follow the same range and Agent/workspace/repository filters. Trends support daily, weekly and monthly aggregation, using shorter intervals for shorter ranges. The current streak is counted backwards from today (or yesterday when today has no activity), independently of the selected dates but with the same filters; the longest streak is for the selected period.

Quota collection runs independently of workspace refreshes and local cost scans, with at most two providers at once. Each provider publishes its result immediately and retains its last-good cache on failure. Unknown usage stays unknown, including Windows placeholder percentages. Diagnostics keep separate provider attempts, successes and errors; expired reset times request a refresh instead of showing a future countdown.

The local usage estimate panel shows today's USD estimate and tokens, a rolling 30-day USD estimate, daily cost/token trends and model details. These are API-price estimates from this machine's native Codex/Claude logs, not the selected quota account's usage or actual bill. It excludes other tools' mirrored/imported histories. Dates use the collector machine's local timezone, shown in the panel. Unpriced models and incomplete history remain visible; missing days are not filled with invented zeroes. Cost cache, progress and errors are independent of quota. See [collector builds and validation](development/quota-collector.md).

Quota collection is separate from Claude Code managed execution, which never reads credentials (see [Claude usage](agents/claude-code-managed.md)). Quotas come from a bundled third-party sidecar (patched CodexBarCLI 0.83.0 on macOS and Linux, patched Win-CodexBar 0.70.0 on Windows x64) that runs with your user environment, and only on a manual refresh or after you turn on "Automatically get quota" (off by default). AgentKib itself does not read provider credentials: it parses the sidecar's JSON, keeps the normalized windows, balances, reset times, account email and plan, and redacts credential-like text from errors. The sidecar, however, may read credentials. Depending on its configuration, the collector may use these Claude sources:

- The claude.ai `sessionKey` cookie, imported from a browser profile (the documented locations are macOS Safari, Chrome-family and Firefox) or supplied as a manual cookie header.
- A probe that runs the `claude` CLI in a pseudo-terminal to read `/usage`.
- Claude Code's OAuth credentials (CodexBar's own cache, `~/.claude/.credentials.json`, or the `Claude Code-credentials` Keychain item), used against `api.anthropic.com`.
- For cost totals, a scan of local Claude Code session logs (`projects/**/*.jsonl`) for per-model token counts.

Provider authentication and source selection remain owned by the upstream collector and its configuration; AgentKib does not select a new credential source during this upgrade. When no CodexBar configuration exists on macOS/Linux, AgentKib only enables installed providers (Codex, Claude Code and Cursor). Existing CodexBar configuration or `CODEXBAR_CONFIG` takes precedence. Windows uses its own settings, including `CODEXBAR_CONFIG` or `%APPDATA%\CodexBar\settings.json`. Diagnostics show the configuration source. Quota uses the patched `dashboard --no-local-costs --provider …` path; unsupported external collectors retain cached data and ask for an update rather than falling back to mixed collection. Local costs use a separate native-only command.

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

The home page and the Workspaces page show each workspace's latest diagnostic result instead of diagnosing every workspace whenever they open. Results are kept across restarts and checked again in the background: while the window is visible, workspaces whose result is older than 30 minutes and newly discovered ones; all of them when you refresh the home or Workspaces page. Refreshing one workspace checks it again at once, and opening a workspace runs a full check, as before. A workspace that has not been checked yet, or whose last check failed, shows "Not diagnosed".

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
- Content adapters cover the eight agents below. Cursor tool records are unsupported; attachments and hidden reasoning are excluded. Damaged, oversized or unsupported source records are marked partial rather than presented as complete. Source changes invalidate old locations and unsent references; Web reads and sends retain separate source/target authorization. See [source matrix, limits and cleanup](sessions/content-search.md). This feature's evidence is TypeScript automation; Windows/Linux native acceptance and model calls were not performed for this round, and historical Rust evidence is not reused.
- DeepSeek Harness sessions are read through a running DSH with the bridge plugin, not from its files: pages hold human prompts (with their images, read from DSH when shown), assistant text and tool summaries. Content search indexes every message, tool input and tool output DSH logged, read from the running DSH once a turn ends; what was indexed stays searchable while DSH is closed. A session can be handed off to another Agent: AgentKib reads it whole from DSH, by default as DSH's model sees it now (each compaction's summary and what followed), or with the history a compaction replaced and a marker at each compaction. Opening a session while no DSH runs starts one in the background to read it; with that setting off, or when DSH cannot start, the session stays listed with history and shows only the pages this AgentKib run has already read, and reads again when DSH returns. Search indexing never starts DSH.

- The directory shows interactive conversations and user-created forks. Auxiliary/subagent records are retained in the index but excluded from directories, search, recent conversations, counts, and continuation choices on desktop and Remote; old links return to the directory with an explanation. Unknown sources and ordinary untitled conversations remain visible.
- Sessions started by a program are execution records and are hidden from the directory by default: ordinary Codex `exec` runs, and Claude Code sessions whose entrypoint is `sdk-cli`, `sdk-ts` or `sdk-py` (Agent SDK and `-p` runs, such as Pen's), background `daemon` sessions and `/loop` runs. These follow the rules Claude Code 2.1.311 uses to keep such sessions out of its own resume list; the working directory and tool names are not used. The directory option "Show program-started sessions" lists them on desktop and Web with a robot icon and counts as an active filter; it is off by default, is not saved, and the sessions stay view only. Claude Code sessions that AgentKib runs itself remain ordinary conversations. After the upgrade, the next refresh reclassifies cached Claude Code sessions and records each session's working directory.
- A session belongs to the deepest registered workspace that contains its working directory. Refreshing an enclosing workspace, such as the home folder, no longer takes sessions from a workspace registered inside it; the enclosing workspace gets them back only when the inner one stops listing them.
- Checkouts of one git repository share a directory group named after the main checkout; the heading adds "· N worktrees" and its tooltip lists them. A session that ran in a worktree joins its repository's group even when a wider workspace holds it, provided some workspace on the same computer is registered for that repository. When the main checkout is not registered, the group takes its folder name; when even that is unknown, the group shows a worktree icon with "This is a git worktree". Worktree rows carry only a worktree icon (lucide `Split`, distinct from the fork indicator), and hovering or a screen reader gives the worktree name, branch, path and status; a deleted worktree's icon is dimmed and its text says so. The session page shows "Worktree {name} · {branch}", or "· deleted" / "· status unknown". Session lists (the overview, the desktop home page and "Recent sessions" on the Web home page) name a session after its directory group. The Workspaces page and the sidebar list worktrees indented under their main checkout.
- Worktree facts are read from `.git`, `gitdir`, `commondir`, `HEAD`, `config` and `worktrees/*` without running git; a checkout is a linked worktree when its common git directory is not its own `.git`. Sessions in a deleted worktree are placed by git's own worktree record, by a `.claude/worktrees` path inside the repository, or, for a pruned Codex worktree, by matching the thread's recorded `git_origin_url` with the main checkout's `origin` (left ungrouped when two clones share that remote). Unreadable metadata shows as "status unknown". Their history stays readable; continuing needs the folder back (see [live sessions](sessions/conversations.md)). Grouping is presentation only: ownership, authorization and control checks still use the session's own workspace.
- AgentKib-managed conversations keep their ledger-backed directory entry, with duplicate native index aliases removed. The paired desktop Remote directory verifies existing managed ownership without creating or migrating its ledger, and preserves the native index ID for history reads. Legacy Codex history imports remain visible only when their complete AgentKib import header matches the indexed session identity and workspace; this recognition grants no control permissions. The TypeScript backend advances classification revision to 3 and invalidates old Codex workspace and conversation-collection caches once; the first directory read recalculates Codex origins before exposing cached entries, without changing native histories. An incomplete upgrade scan shows records that were successfully reclassified, while unclassified cached records remain stored and hidden until they can be read. Once all cached records have been reclassified, ordinary reads stop repeating the upgrade scan even if a source remains unavailable. Clearing the index also clears pending classification markers, while retaining the classification revision. Both the host and Remote frontend must be updated for this directory policy to take effect.
- Native alias checks in local and paired directories require a complete ledger within the 20,000-record read limit and check ownership before filtering workspaces. Larger ledgers retain the native execution classification and skip alias mapping and deduplication; local managed entries keep their ledger identities, and ordinary conversations remain readable. If paired-directory ownership projection fails, the indexed records remain readable with their original classifications, and Runtime emits a diagnostic without ledger contents or paths; control ledger checks still fail on errors.
- Forks keep their own identity and title, with a small fork indicator and source information. Spawned-parent and fork-source relationships are independent; identical titles are never merged. Successful source refreshes reconcile archived/deleted records, while unavailable or unsupported sources retain the last cached snapshot.
- History opens with the latest 50 records (messages and tool summaries), displayed chronologically. Load earlier records on demand. Normal pagination does not show an incomplete-turn warning; actual read errors and truncated content remain visible.
- Local Codex and Claude Code sessions show typed tool rows on the desktop Sessions page and in Web: commands with status, non-zero exit code, duration and the end of their output; file edits with added/removed line counts and a bounded diff preview; MCP calls, searches and sub-agent actions. Turns show how long they took, and a turn that edited files ends with a per-file summary whose diffs open in place. Previews are redacted with the content-search rules, capped at 32 KiB per item, and visible to read-only browsers too. Reasoning, Claude's `originalFile` and the file contents of read tools are never sent. Sessions on other computers viewed from the desktop, Antigravity and the other agents still show tool names and status only. See [tool details and turn durations](sessions/conversations.md).
- Desktop and Remote display the latest native context report independently of settings support. Compaction blocks sending, steering, settings, goals, and ownership transfer until the native phase ends; unconfirmed post-compaction usage does not extend the send lock. See [conversation state and report sources](sessions/conversations.md).
- Codex and Claude Code JSONL histories are read from the tail with bounded scanning and memory, rather than loading the entire transcript before pagination. Antigravity ACP histories are replayed through the official ACP server with bounded pages and update budgets. OpenCode is read through its bounded export command; OpenClaw, Hermes, and Grok Build use their verified local history sources. Page byte limits may return fewer than 50 records; an empty scan window can still offer earlier records.
- Damaged or oversized log records produce a warning. Very distant message/tool associations or ambiguous legacy metadata may be shown conservatively with a warning instead of requiring a full-file scan.
- History pagination is read-only. All eight listed agents have source adapters with per-session validation; Cursor uses verified CLI stores or explicitly connected macOS IDE profiles, and OpenClaw supports schema-23 SQLite plus legacy JSONL when no authoritative SQLite store exists. Compressed or incomplete histories that cannot preserve required text are refused. OpenCode 1.18.32, Hermes 0.21.5, and offline OpenClaw 2026.9.6 native imports prepare a reviewed payload, reconcile durable operation records, and verify target content before launch. Historical QA records offline storage, native UI, restart, and representative text-reply results for specific directions. These do not cover all source/target pairs, rich content, or the migrated TypeScript backend. See [direction/version compatibility](sessions/interoperability.md).

### MCP Hub and client connections

- HTTP MCP OAuth credentials are bound to the authorization server that issued them. After the MCP SDK security update to 1.31.0, saved credentials without this binding require a new sign-in; authorize the service again from its MCP entry.
- The desktop MCP page separates service collection/editing, batch Agent connection setup, and per-Agent tool rules. It accepts reviewed native/pasted formats (including `mcpServers`) as disabled definitions, without starting services or copying native credentials. For Claude Code the scan also shows the current project's local scope and the managed `managed-mcp.json` read-only (never collected or migrated), marks same-named servers that a higher-priority scope overrides, shows the approval state of `.mcp.json` servers, the `managedMcpServers` of managed settings and the effect of the allow and deny lists from the settings files, lists the servers of enabled plugins read-only, and says what it cannot see (claude.ai connectors, policy delivered by MDM, the Windows registry or the claude.ai console). Reviews that write Claude Code's global file (`.claude.json`) ask you to close running Claude Code sessions first, because a running session keeps its own copy of the file and may write it back over the change; AgentKib does not look for Claude Code processes. After a migration the next scan marks a server that was taken out of the file but is back while the file no longer matches what AgentKib wrote. See [MCP management](library/mcp.md).
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
- Skill management adds existing-installation inspection and copy import, bounded content previews, and reviewed personal/project deployments for all eight writable agents. Deployments have independent update, rollback and withdrawal; native visibility and shared-directory effects are reported separately from file installation. See [Skill management](library/skills.md).
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
| DeepSeek Harness | Beta | Diagnostics only | Through a running DSH with the bridge plugin (macOS) | While DSH runs, or started by AgentKib in the background | — |
| Devin | Yes | Yes (always-on rules) | Read-only, Devin CLI and Devin Desktop | Per-session check | Detect / official installer |

Claude Code context diagnostics are partial. Covered, in the order Claude Code loads them: the managed policy `CLAUDE.md`; the user's `CLAUDE.md` and `rules` folder in the configuration folder; the instruction files of the parent directories of the workspace root (the fixed names `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`, plus `AGENTS.md` and `.claude/AGENTS.md` when the fallback applies, and their `.claude/rules`, which Claude Code 2.1.299 was seen loading at startup; the nearest 32 levels); the project `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md` files from the workspace root down to the working directory, with `.claude/rules` read recursively in every one of those directories (within a directory: `CLAUDE.md`, `.claude/CLAUDE.md`, the rules, then `CLAUDE.local.md`); the `AGENTS.md` fallback that Claude Code applies when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in the working directory or any parent (version 2.1.277 and later); rules with a `paths` field, which are listed with their patterns and not merged because they load only when a matching file is read; auto memory (the first 200 lines or 25 KB of `MEMORY.md` at its default location, left out when `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`); the removal of block-level HTML comments from `CLAUDE.md` files; and `@import` expansion up to four hops, with imports outside the workspace root read through a sensitive-file filter and redaction, and imports outside the working directory flagged because Claude Code asks for approval first. Sources outside the workspace are read-only and bounded, filtered and redacted before they are shown; the MCP tool returns only their sizes and counts, never their text or paths, and the Doctor does not evaluate sources outside the workspace. The same holds for the files of `~/.claude` that OpenCode and Grok Build read: the app shows them as before, the MCP tool returns only their number and size. Claude Code settings are read, read-only, from the managed files (`managed-settings.json` and `managed-settings.d/*.json`), the project's `.claude/settings.json`, the repository's `.claude/settings.local.json` and the user's `settings.json`, in Claude Code's precedence (managed, command line, local, project, user; lists merge across layers). The Context page shows each file, its keys and the effective values with the layer they come from; `env` shows names only, credential helpers (`apiKeyHelper` and similar) show only that they are configured, and commands, rules and URLs are redacted before they are shown. Exclusion matching has a shared computation budget per preview. If a rule exceeds that budget or the supported matching limits, the preview keeps sources whose exclusion could not be determined and reports the incomplete evaluation; existing privacy and redaction boundaries still apply. The settings change what is listed: `claudeMdExcludes` leaves out user, project and local files and the rule files of the project and its parent directories (never the managed ones; whether it reaches the user's own rules is not checked, so those stay listed), the managed `claudeMd` key loads like the managed `CLAUDE.md`, "Project instructions" (`pluginConfigs` of the built-in AGENTS.md plugin, read from managed and user settings only) switches between the AGENTS.md fallback, always reading it, never reading it and managed-only, `autoMemoryEnabled` and a user or managed `autoMemoryDirectory` change auto memory (a project or local `autoMemoryDirectory` is not applied, because Claude Code honors it only in a trusted folder). The MCP tool returns the project file's plain values and counts, and only the layer, parse state and key names of every other file. The Context page also lists, read-only, the plugins that settings enable (from `enabledPlugins` and the install records in the plugins folder, with the commands, agents, skills, output styles, hooks and MCP servers each one provides), the commands, agents, output styles and workflows of the project and the user (name, description, tools and model from the front matter, redacted), and the hooks of every settings layer and plugin (commands redacted). The MCP tool lists the project's own items and gives only counts for the user's items and for plugins. Skills, LSP servers, monitors, themes, channels and executables of plugins are not listed. Not visible to AgentKib: settings given with `--settings` or `--setting-sources`, policy delivered by MDM, a configuration profile or the Windows registry, and server-managed settings. Not modeled yet: `CLAUDE.md` files and rules in subdirectories that Claude Code loads on demand, `--add-dir` directories and nested work trees, and the environment variables that turn `CLAUDE.md` loading off, or set in a settings `env` block (they are only noted). Before Claude Code 2.1.281, some sessions (for example Bedrock or telemetry disabled) still read only CLAUDE.md. AgentKib only sees `CLAUDE_CONFIG_DIR` in its own process environment (an app started from Finder or the Dock does not see a shell `export`, a per-command alias or the `env` block of a settings file). The value must be an absolute path without `..`; otherwise AgentKib reads the default directory and refuses to write.

AgentKib distinguishes an installed app or CLI from local data left behind after uninstalling it. Agent Home writes require separate approval. Antigravity ACP sessions are not claimed to be the complete Desktop/IDE or CLI history store, and current stable interfaces cannot import foreign history into an Antigravity-native session. DeepSeek Harness is a Beta target. AgentKib never writes its profile, configuration or session files itself, configures MCP for it, or includes it in tool management: the user installs the bridge plugin into a DSH they run, a DSH that AgentKib starts in the background gets the plugin through a command-line overlay that changes no profile, and session actions run inside the running DSH through its own services (see Web access and continuation).

### Web access and continuation

- Pairing grants read access first. Sending and approvals are separate per-browser permissions and also require the host control switch.
- The Web home follows the desktop home. On a wide screen it has the new-session composer (hidden when this browser cannot send) and what needs you, unread results and turns in progress beside the session directory; "Home" at the top of the sidebar and the bell both count what needs you, and the AgentKib mark returns home. At phone width the home comes first, with "Home | All sessions", a "+" for a new session and the three most recent sessions; the authorized browser and sign-out stay under All sessions. Approvals and questions are answered in their rows with the session page's card and checks; a decision whose outcome is unknown is never sent again and its row asks you to verify the result. While disconnected the lists stay readable, and answering and new sessions wait. New sessions use the desktop's composer: workspace, Agent, permissions in each Agent's own words, model and effort, and files; Codex policies other than "Ask for approval" need a full-access browser.
- Claude Code desktop/Web control shares one execution service on macOS CLI versions at least `2.1.263`, with foreground Bash support at least `2.1.285`: prepare new sessions without a model call, or explicitly adopt an existing UUID after stopping its terminal. Native identities, protocol shapes, and receipts remain validated; accepting a newer version does not imply real-device acceptance. Managed sessions run the CLI with background tasks switched off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`) so sub-agents run in the foreground, tolerate frames and requests they do not know without ending the session (an unknown request is refused, never allowed), and are verified through `2.1.299`: synthetic frames plus one real-CLI acceptance run on 2026-10-14 (start-up, idle, Bash approval, one foreground sub-agent, one MCP approval, resume with the same UUID; see [live acceptance QA](../qa/claude-live-acceptance-2026-10-14.md)). LAN uploads remain disabled; Windows/Linux control remains unavailable. See [Claude usage](agents/claude-code-managed.md) and [historical native QA](../qa/claude-managed-2026-09-30.md) and [current TypeScript QA](../qa/typescript-stability-2026-10-07.md).
- Codex Web control continues sessions through AgentKib's own app-server. When Codex Desktop holds a session's writer lock, AgentKib follows the Desktop owner instead (macOS, Desktop `26.917.62051` or later) and offers only send, stop and approval. Unknown or malformed versions, unsupported platforms, missing owners and incompatible native protocols show the existing in-use choice; satisfying the version threshold does not replace native validation or acceptance testing.
- Antigravity Web control manages only sessions returned by the official ACP server. It negotiates ACP v1 capabilities, checks the indexed session and workspace again, and requires exact revision, turn, request, and offered permission option matches.
- DeepSeek Harness control (macOS) runs through a DSH with the AgentKib bridge plugin. When none of the user's runs, AgentKib starts one in the background with DSH Desktop's own command line and the web profile, the profile DSH Desktop's sessions continue in, with the user's Desktop settings layered on top and the plugin mounted for that run only. It stops after three idle minutes, after one while DSH Desktop's window is open, and at once when a DSH of the user's with the plugin connects (a DSH keeps a session it resumed until it exits), and when AgentKib quits; quitting first lists the turns it would stop. The setting "Start DeepSeek Harness when needed" is in the session's actions dialog. To control a DSH the user runs, install the plugin in the profile it runs and restart DSH: in DSH Desktop, paste the plugin directory into "Add plugin"; on the command line, `dsh plugin --profile <name> add <directory>` (the session's actions dialog on the desktop shows both). A session that the user's DSH Desktop holds without the plugin cannot be continued from AgentKib until Desktop quits; AgentKib says so. The plugin calls DSH's session services and never starts a second executor. Send, queue or steer while a turn runs (per the "Send while running" setting), editing or withdrawing a waiting message, stop, and approvals and questions are available; on desktop and Web, waiting messages sit in a strip above the composer. The first answer wins between DSH and AgentKib, and the other side withdraws its card. When AgentKib cannot confirm a result, it checks the request ID against DSH's record, or the current state after two minutes, and never sends again. The session's actions also rename, fork, archive and unarchive it, and the composer switches its model and reasoning effort from DSH's own model catalog (archive and model changes wait until the turn ends); a new DSH session can be started in an authorized workspace when at most one of the user's DSH runs (with none, in the one AgentKib starts), with the Agent preset chosen for it, as on DSH's own new-session screen (a preset cannot change once the session starts). Images (PNG, JPEG, WebP, GIF) go with a message, including one queued or added to the running turn, and the session's history shows them; other files reach DSH as a path in the message, as for other agents. When the session's model takes no images, or an image is outside DSH's limits, DSH refuses the message and AgentKib says why and keeps the draft; a waiting message with attachments can be withdrawn but not edited. The goal panel sets, pauses, resumes and clears the session's goal through DSH's goal service, also during a turn; DSH bounds a goal by rounds, not tokens, and a goal in a session DSH has just resumed waits for a resume. The composer's `/` menu lists DSH's own slash commands, and a message naming one runs it in DSH, as DSH's window does, also during a turn; the history shows the command and DSH's answer, except a successful permission preset switch, which DSH's window leaves out too (the preset shows as the execution policy); a failed one stays to show why. `/goal`, `/permission` and commands from other DSH plugins need a full-access device, and `/export` works only in DSH's window. Compaction runs DSH's own `/compact` when the session is idle, and messages wait while it runs. The settings dialog switches DSH's permission presets (sandbox mode with approval policy) as the execution policy, also during a turn; it needs a full-access device. On the phone, a session's subagents can be read, as in DSH's window. Another Agent's conversation can be handed to DSH: the reviewed handoff file is written to `.agentkib/handoffs/`, and "Apply and continue" starts a new session in the running DSH with a message pointing it at the file, then opens it in AgentKib. Pinning is not available yet.
- Phone notifications (iOS, for a phone app paired through the official relay and signed in to this computer's account): an alert when a session starts waiting for an approval, an answer or a check, or when a turn seen running completes or fails, and a Live Activity on the Lock Screen and in the Dynamic Island once sessions work for a minute, with the session title when only one works. Alerts wait while someone uses the computer and go out after they leave, if still true. Alert text is encrypted on the computer for the phone, so the relay and Apple carry it unread; Live Activity content is plain, as Apple requires, and holds only counts, times and at most one title. The relay needs its APNs configuration.
- A request receipt does not mean a turn or approval completed. Disconnects and uncertain outcomes are never retried automatically.

### Platform status

| Platform | Status |
| --- | --- |
| macOS 13.3+ (Apple Silicon / Intel) | Primary development and acceptance platform; releases are signed and notarized |
| Windows 11 x64 | Release workflow builds and smoke-tests NSIS; installers are not yet Authenticode-signed |
| Ubuntu 22.04 x64 | Core CI platform; releases include verified `.deb` and AppImage packages |
| Fedora x64 | Platform checks run on pull requests; releases include verified `.rpm` packages |
| Windows ARM64 / Linux ARM64 | Preview packages with limited native regression coverage |

Platform setup and known limitations are documented in the [Windows guide](development/windows.md), [upgrade guide](UPGRADING.md), and [release guide](development/release.md).

## 简体中文

### 全局视图

| 区域 | 提供的能力 |
| --- | --- |
| 首页 | 新建会话；这台电脑上的会话：需要你处理（审批、问题、结果待核对）、进行中的轮次、待查看的新结果和最近会话；审批和问题在行里直接作答；右栏的额度、远程和维护提醒 |
| 菜单栏 | 不打开也能看出状态：有事等你处理时图标右上角一个小圆点、旁边写数量；有会话在运行时图标外一圈转动。点开的浮窗列出需要你处理、进行中和待查看；第一条审批展开后一键“允许一次”或“拒绝”（其余选项打开会话）；进行中的会话可以在行里停止；一行输入就用上次的工作区和 Agent 新建会话。每个 Agent 的额度是一个小圆环，点开看各窗口；远程访问写出在线的已配对设备，可以暂停或恢复。右键只有“打开”和“退出”；Linux 的原生菜单另外列出需要你处理的数量 |
| 工作区 | 自动发现或手动添加的项目，以及覆盖情况和警告 |
| 全局资产目录 | 跨工作区查看 Instructions、Skills、MCP、记忆和其他 Agent 资产 |
| Skill Hub | 本地 Skill 资源库、已有安装查看与批量复制入库、OpenAI 精选及 GitHub 导入与版本选择、个人/项目部署、更新、回滚、撤销部署和资源库可恢复移除 |
| Agent | 安装状态、配置 Home、能力和已发现资产 |
| 额度 | 额度窗口、余额、重置时间，以及本机 Codex/Claude API 价格估算 |
| 洞察 | 本地派生的 Token、会话、Git 活动、热力图和成就 |
| 设置 | 发现目录、工具更新、集成、隐私控制和诊断 |

“记忆”页只读获取 AgentKib 已发现工作区的 Claude Code 项目自动记忆，工作区无需先建立 AgentKib manifest。页面列出解析所得记忆目录中的 `MEMORY.md` 和 Markdown 专题文件，对主仓库／worktree 共享目录及自定义共用目录去重，并将原生文件与 AgentKib 提议分开展示。原生文件无需审核即可查看；可查看不代表当前 Claude 会话已加载。文件预览与 Claude 启动读取上限（前 200 行或 25 KB）分开，专题文件由 Claude 按需读取。`CLAUDE.md`、rules、子代理独立记忆及无法归属的历史目录不在本轮范围内。原生正文不通过 MCP、远控网页、其他 Agent 或云同步共享。

记忆浏览按项目分组，仅将有内容的条目放入列表，列表仅显示文件名，不展开正文标题与摘要。宽窗口使用列表与正文双栏并分别滚动，窄窗口打开详情抽屉；正文可切换预览与原始文本。来源诊断默认折叠，异常、缓存过期或扫描不完整在项目行及汇总处提示，共用目录保留关联工作区信息，原生正文继续只读。

原生记忆使用独立的本机 SQLite 脱敏文本缓存。页面先显示缓存，可见时监听文件变化并每五秒合并核对，回前台或手动刷新时再次检查，不等待全局刷新。普通读取失败保留上次结果并标注过期；确认删除后移除文件，工作区排除、配置来源变化或关闭自动记忆后撤下旧来源。读取限定在解析所得记忆目录内，沿用敏感路径过滤。每目录最多遍历 512 个文件和 4 层子目录，单文件最多读取 512 KiB 并沿用现有文本长度限制，每目录正文索引预算为 8 MiB；截断或扫描不完整均明确标示。原有 AgentKib 提议审核与 Agent 检索语义保持不变。

目录解析沿用现有 Claude 配置可见范围：支持应用进程环境中的配置目录覆盖，以及用户／managed 设置中的自定义记忆目录。项目设置指定自定义目录但无法确认 Claude 的工作区信任状态时，显示“路径无法确定”，不读取项目指定的外部目录，也不冒充默认目录的内容。逐会话的命令行覆盖不在本机配置解析范围内。接口、缓存边界和隔离测试入口见[原生记忆说明](NATIVE-MEMORY.md)。

洞察默认展示包含今天的近 30 个本地自然日，可切换近 7／30／90 天、今年、近 52 周或自定义日期。自定义范围须为有效日期，开始不晚于结束、不能选择未来日期，最长 366 天；所选范围会在本机记住。总量、活跃天数、热力图和趋势图遵循相同时间范围及 Agent／工作区／仓库筛选。趋势可按日、周、月汇总，短范围默认采用更细粒度。当前连续活跃独立于所选日期，保留同样的筛选条件，从今天（今天无活动时从昨天）向前统计；最长连续活跃仅统计所选期间。

额度采集不等待工作区刷新或本机费用扫描，最多并发两个 Provider，每个完成后立即显示。失败保留上次成功数据，未知用量保持未知，包括 Windows 的占位百分比。诊断分别保存各 Provider 的尝试、成功时间与错误；已过期的重置时间提示刷新。

“本机用量估算”显示今日 USD 估算费用和 Token、近 30 天费用、每日费用／Token 趋势和模型明细。数据仅来自本机原生 Codex/Claude 日志，排除其他工具镜像和导入记录；不归属当前额度账号，不是实际账单。日期按采集机器自然日计算，页面标明时区；未定价模型、不完整历史和未知值明确展示，缺失日期不补零。费用与额度分别缓存、更新和报错。构建与隔离验证见[采集器说明](development/quota-collector.md)。

额度采集与 Claude Code 托管执行是两条独立路径，托管执行不读取凭据（见 [Claude 使用说明](agents/claude-code-managed.md)）。额度由随应用打包的第三方 sidecar 采集（macOS 与 Linux 为带补丁的 CodexBarCLI 0.83.0，Windows x64 为带补丁的 Win-CodexBar 0.70.0），它以你的用户环境运行，只在手动刷新或你开启“自动获取额度”（默认关闭）后启动。AgentKib 自身不读取各 Provider 的凭据：它解析 sidecar 输出的 JSON，保留标准化后的额度窗口、余额、重置时间、账号邮箱与套餐，并对错误信息脱敏；但 sidecar 可能读取凭据。依照采集器配置，Claude 可能使用以下来源：

- claude.ai 的 `sessionKey` Cookie，从浏览器配置文件导入（文档列出的位置是 macOS 的 Safari、Chrome 系浏览器和 Firefox），或使用手动提供的 Cookie 头。
- 在伪终端中运行 `claude` CLI 读取 `/usage` 的探测。
- Claude Code 的 OAuth 凭据（CodexBar 自己的缓存、`~/.claude/.credentials.json`，或 Keychain 项 `Claude Code-credentials`），用于访问 `api.anthropic.com`。
- 为统计费用，扫描本地 Claude Code 会话日志（`projects/**/*.jsonl`）里按模型记录的 Token 数量。

Provider 的认证与来源选择继续由上游采集器及其配置决定，本次升级不替用户选择新的凭据来源。macOS/Linux 没有配置时，AgentKib 只启用已安装的 Codex、Claude Code、Cursor；已有配置或 `CODEXBAR_CONFIG` 优先。Windows 使用其设置，包括 `CODEXBAR_CONFIG` 或 `%APPDATA%\CodexBar\settings.json`，诊断显示实际配置来源。额度使用带补丁的 `dashboard --no-local-costs --provider …`；外部采集器不支持时保留缓存并提示更新，不退回混合采集。费用通过独立的严格原生来源命令统计。

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

首页和工作区页显示每个工作区最近一次的诊断结果，不再每次打开都把所有工作区诊断一遍。结果在重启后保留，并在后台重新检查：窗口显示时，检查结果超过 30 分钟的工作区和新发现的工作区；在首页或工作区页刷新时检查全部工作区。刷新单个工作区会立即重新检查它，打开工作区时照旧完整检查一次。尚未检查过或上次检查失败的工作区显示为“未诊断”。

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
- 下表八个 Agent 均有正文来源适配器；Cursor 工具记录尚未支持，附件正文与隐藏推理不在范围内。超限、损坏或不支持的记录明确显示部分覆盖；原文变化会使旧位置及未发送引用失效，Web 来源读取与目标发送分别授权。详见[来源矩阵、上限与清理行为](sessions/content-search.md)。本轮仅有 TypeScript 自动化证据，未执行 Windows/Linux 本机验收或模型调用，不复用历史 Rust 证据。
- DeepSeek Harness 会话经运行中的 DSH 及插件读取，不读它的文件：分页只含用户消息（其中的图片显示时再从 DSH 读取）、助手正文和工具摘要。正文搜索收录 DSH 记录的每条消息、工具输入和工具输出，每轮结束后从运行中的 DSH 读取；DSH 关闭后，已收录的内容仍可搜索。会话可以交接给其他 Agent：AgentKib 从 DSH 读取整个会话，默认按 DSH 模型当前看到的内容（每次压缩的摘要和之后的消息），也可以带上压缩替换掉的历史，并标出每个压缩点。没有运行的 DSH 时，打开会话会在后台启动 DSH 来读取；关闭了这项设置或 DSH 无法启动时，会话仍按有历史内容列出，只显示本次 AgentKib 运行中已经读过的分页，DSH 回来后重新读取。正文搜索不会为收录而启动 DSH。

- 本机 Codex、Claude Code 与 Antigravity 支持在会话页原地聊天，共用 Remote 的完整操作组件和原生事件流；具体控制按平台、版本、归属及授权开放。附件、设置、审批、队列、目标与产物入口见 [实时会话](sessions/conversations.md)。打开会话不自动接管任务。

- 目录显示用户对话和用户创建的分叉。辅助/子代理记录保留在索引中，但从桌面与 Remote 的目录、搜索、最近会话、计数和续接来源中排除；旧链接返回目录并说明原因。无法识别的来源和正常未命名对话仍保留显示。
- 程序启动的会话属于执行记录，目录默认不显示：普通 Codex `exec` 运行，以及入口为 `sdk-cli`、`sdk-ts`、`sdk-py`（Agent SDK 与 `-p` 运行，例如 Pen）、后台 `daemon` 会话和 `/loop` 运行的 Claude Code 会话。判断规则与 Claude Code 2.1.311 在自身恢复列表中隐藏这类会话的规则一致，不按工作目录或工具名判断。目录选项“显示程序启动的会话”打开后，桌面和 Web 的目录列出这些会话，行上带机器人图标，并计入筛选数量；该选项默认关闭、不保存，会话仍只可查看。AgentKib 自己运行的 Claude Code 会话照常显示。升级后的下一次刷新会重新分类已缓存的 Claude Code 会话，并记下每个会话的工作目录。
- 会话归属于包含其工作目录的最深一层登记工作区。主目录这类外层工作区刷新时，不再抢走登记在其内部的工作区的会话；内层工作区不再列出某个会话时，才交还外层。
- 同一个 git 仓库的检出在目录中合为一组，组名用主检出的名称，组头写“· N 个工作树”，悬停列出名称。在工作树里运行的会话即使归属更外层的工作区，只要这台电脑登记了该仓库的某个工作区，就回到仓库那一组。主检出没有登记时，组名取主检出的文件夹名；连主检出也找不到时，组名旁加工作树图标，悬停提示“这是 git 工作树”。工作树会话行只放一个工作树图标（lucide `Split`，与分叉标识不同），悬停和读屏给出工作树名称、分支、路径和状态；工作树已删除时图标变淡，说明里写明已删除。会话页显示“工作树 {名称} · {分支}”，已删除或无法检查时写“· 已删除”“· 状态未知”。概览、桌面首页的会话和 Web 首页的“最近会话”按会话所在的目录分组命名。工作区页和侧栏把工作树缩进列在主检出下面。
- 工作树信息只读 `.git`、`gitdir`、`commondir`、`HEAD`、`config` 和 `worktrees/*`，不运行 git；git 公共目录不是检出自己的 `.git` 时判定为分出来的工作树。工作树已删除时，按 git 自己的工作树记录、仓库内的 `.claude/worktrees` 路径归组；已被清理的 Codex 工作树按线程记录的 `git_origin_url` 匹配主检出的 `origin`，两个克隆共用同一远程地址时不归组。元数据读取失败时显示“状态未知”。这些会话的历史照常可读，继续前需要恢复文件夹（见[实时会话](sessions/conversations.md)）。分组只影响显示：归属、授权和控制检查仍按会话自己的工作区。
- AgentKib 托管会话沿用持久归属记录展示，并去除重复的原生索引别名。桌面配对 Remote 的目录只读校验已有托管归属，不创建或迁移归属账本，保留用于读取历史的原生索引 ID。旧 Codex 历史导入仅在完整导入标记、会话身份及工作目录均匹配时保留显示，此识别不授予控制权限。TypeScript 后端将分类版本更新为 3，一次性使旧 Codex 工作区及会话集合缓存失效，首次目录读取先重新分类再展示缓存，不改写原生历史；扫描不完整时，已重新分类的记录继续显示，尚未重算的旧记录保留在索引中，待来源可读后再显示。旧缓存全部重新分类后，即使某个来源仍不可用，普通读取也不再重复升级扫描；清空索引同时清除待分类标记，保留分类版本。主机和 Remote 前端均需更新才能完整生效。
- 本机与配对目录的原生别名校验要求账本在 20,000 条读取上限内保持完整，并先判断归属唯一性再过滤工作区；超限时保留原生执行记录分类，跳过别名映射及去重。本机托管条目继续使用账本身份，普通对话仍可读取。配对目录的归属投影失败时，索引记录保持原分类和可读性，Runtime 输出不含账本内容或路径的诊断；控制账本校验仍按原规则拒绝错误。
- 分叉保留独立身份和原标题，通过小型分叉标识及来源信息区分；子代理父关系与历史分叉关系独立，不按同名合并。成功刷新会同步归档、删除状态；来源不可用或结构不支持时保留上次缓存快照。
- 默认加载最新 50 条记录（消息和工具摘要），按时间正序展示；更早记录按需加载。正常分页不提示轮次不完整，真实读取错误与内容截断仍显示。
- 本机 Codex 与 Claude Code 会话在桌面会话页和 Web 显示结构化的工具行：命令带状态、非零退出码、耗时和输出末尾；文件改动带增删行数与有界的差异预览；另有 MCP、搜索和子代理动作。每轮显示用时，有文件改动的轮次在回复下方按文件汇总，可就地展开差异。预览按正文搜索的规则脱敏，单项不超过 32 KiB，只读浏览器同样可见；推理内容、Claude 的 `originalFile` 和读取类工具的文件正文不下发。桌面查看其他电脑上的会话、Antigravity 及其他 Agent 仍只显示工具名和状态。详见[工具详情与轮次时长](sessions/conversations.md)。
- 桌面与 Remote 独立于设置能力显示最近原生上下文报告。压缩期间阻止发送、steer、设置、目标修改与归属转移，直到原生阶段结束；压缩后用量未确认不会延长发送锁。详见[实时状态与报告来源](sessions/conversations.md)。
- Codex 与 Claude Code 的 JSONL 历史从文件尾部开始有界读取，不再先读取完整文件才分页。Antigravity ACP 历史通过官方 ACP server 有界回放。OpenCode 通过有界导出命令读取；OpenClaw、Hermes 和 Grok Build 使用各自经过校验的本机历史来源。单页体积限制可能使结果少于 50 条；本次扫描窗口为空时，仍可能继续加载更早记录。
- 损坏或超大的日志记录会显示提示；距离过远的消息/工具关联，以及无法明确判断的旧格式元数据，会保守展示并提示，而非要求扫描完整文件。
- 历史分页只读，不修改原记录。表中八个 Agent 均有来源适配器，能否交接取决于具体会话解析；Cursor 使用已验证 CLI 格式或显式连接的 macOS IDE profile，OpenClaw 支持 schema-23 SQLite，并在不存在权威 SQLite 存储时兼容旧 JSONL。无法保留必要正文的压缩或不完整历史会被拒绝。OpenCode 1.18.32、Hermes 0.21.5 与离线 OpenClaw 2026.9.6 新增原生导入：审查临时载荷、保存操作记录、核对目标全文后才启动。历史 QA 分别记录了特定方向的离线存储、原生界面、重启与代表性文本回复结果，不代表所有来源×目标、富内容或迁移后的 TypeScript 后端均已验收，详见[方向与版本兼容矩阵](sessions/interoperability.md)。

### MCP Hub 与客户端接入

- HTTP MCP 的 OAuth 凭据会绑定签发它们的授权服务器。升级到 MCP SDK 1.31.0 安全修复版本后，缺少此绑定的旧凭据需要重新登录；请从对应 MCP 服务条目重新授权。
- 桌面 MCP 页区分服务收录／编辑、Agent 批量接入和按 Agent 分配具体工具。已验证原生／粘贴格式（包括 `mcpServers`）收录为停用定义，不启动服务、不复制原生凭据。对 Claude Code，读取时还会只读显示当前项目的 local 作用域与 managed 的 `managed-mcp.json`（不收录、不迁移），标出被更高优先级作用域覆盖的同名服务，还会按 settings 文件显示 `.mcp.json` 服务的批准状态、managed settings 的 `managedMcpServers` 以及允许与拒绝列表的影响，只读列出已启用插件提供的 MCP 服务，并说明看不到的内容（claude.ai 连接器、经 MDM、Windows 注册表或 claude.ai 控制台下发的策略）。写入 Claude Code 全局文件（`.claude.json`）的审查界面会提示先关闭正在运行的 Claude Code 会话：运行中的会话在内存里保留着这个文件的副本，可能整份写回、覆盖这次改动；AgentKib 不检测 Claude Code 进程。迁移之后的下一次扫描会标出“被迁出的服务又出现、而文件已不是 AgentKib 写入的内容”的情况。参见 [MCP 管理说明](library/mcp.md)。
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
- Skill 管理支持查看并复制已有安装、限长内容预览，以及八种可写 Agent 的个人/项目部署。部署可独立更新、回滚和撤销；原生可见性和共享目录影响与文件落盘状态分别展示。参见 [Skill 管理说明](library/skills.md)。
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
| DeepSeek Harness | Beta | 仅诊断 | 经运行中的 DSH 及插件读取（macOS） | DSH 运行时，或由 AgentKib 在后台启动 | — |
| Devin | 支持 | 支持（常驻规则） | 只读，含 Devin CLI 与 Devin Desktop | 逐会话核验 | 检测 / 官方安装器 |

Claude Code 的上下文诊断目前是部分支持。已覆盖，按 Claude Code 的加载顺序：managed 策略的 `CLAUDE.md`；配置目录里的用户级 `CLAUDE.md` 与 `rules` 目录；工作区根的各级上级目录里的指令文件（固定文件名 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md`，回退时加 `AGENTS.md` 与 `.claude/AGENTS.md`，以及它们的 `.claude/rules`——Claude Code 2.1.299 真机确认会在启动时加载；最近的 32 层）；从工作区根到工作目录的项目 `CLAUDE.md`、`.claude/CLAUDE.md` 与 `CLAUDE.local.md`，以及这些目录里递归读取的 `.claude/rules`（同一目录内依次是 `CLAUDE.md`、`.claude/CLAUDE.md`、规则、`CLAUDE.local.md`）；工作目录及其上级目录里都没有 `CLAUDE.md`、`.claude/CLAUDE.md`、`CLAUDE.local.md` 时 Claude Code 回退读取的 `AGENTS.md`（2.1.277 及以后的版本）；带 `paths` 字段的规则只在读取匹配文件时才加载，所以只列出匹配模式，不并入常驻内容；自动记忆（默认位置的 `MEMORY.md` 的前 200 行或 25 KB，`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` 时不显示）；`CLAUDE.md` 文件中块级 HTML 注释的剥离；最多四跳的 `@import` 展开，其中工作区根之外的导入经过敏感文件过滤与脱敏，工作目录之外的导入因 Claude Code 会先请求批准而加以标注。工作区外的来源只读、有上限，显示前经过过滤与脱敏；MCP 工具对它们只返回大小与数量，不返回正文与路径；Doctor 不评估工作区外的来源。OpenCode 与 Grok Build 读取的 `~/.claude` 个人文件同样如此：应用里照常显示，MCP 工具只返回数量与大小。Claude Code 的设置按只读方式读取：managed 文件（`managed-settings.json` 与 `managed-settings.d/*.json`）、项目的 `.claude/settings.json`、仓库根的 `.claude/settings.local.json` 和用户的 `settings.json`，优先级沿用 Claude Code 的顺序（managed、命令行、local、project、user；列表跨层合并）。上下文页显示每个文件、它设置了哪些键，以及生效值和来源层；`env` 只显示键名，`apiKeyHelper` 等凭据助手只显示“已配置”，命令、规则和 URL 先脱敏再显示。一次预览内的排除规则匹配共用计算预算。规则超过计算预算或受支持的匹配上限时，预览保留无法确认是否应排除的来源，并明确提示匹配未完成；原有隐私和脱敏边界仍然生效。设置会改变列出的内容：`claudeMdExcludes` 排除用户、项目和 local 的文件，以及项目和上级目录的规则文件（不会排除 managed 的；它是否作用于用户自己的规则未核对，所以那些规则仍列出）；managed 的 `claudeMd` 键与 managed 的 `CLAUDE.md` 一样加载；“Project instructions”（内置 AGENTS.md 插件的 `pluginConfigs`，只读取 managed 与用户设置）在 AGENTS.md 回退、始终读取、从不读取和仅 managed 之间切换；`autoMemoryEnabled`，以及用户或 managed 设置里的 `autoMemoryDirectory`，会改变自动记忆（项目或 local 设置里的 `autoMemoryDirectory` 不会应用，因为 Claude Code 只在受信任的文件夹里采用它）。MCP 工具对项目文件只返回不含私密的普通值与数量，对其他文件只返回所在层、能否解析和键名。上下文页还只读列出：settings 启用的插件（来自 `enabledPlugins` 和插件目录里的安装记录，以及每个插件提供的 commands、agents、skills、输出样式、hooks 和 MCP 服务），项目与用户的 commands、agents、输出样式和 workflows（来自 front matter 的名称、描述、tools 与 model，经脱敏），以及各层 settings 与插件的 hooks（命令脱敏）。MCP 工具只列出项目自己的条目，对用户级条目和插件只给数量。插件的 skills、LSP 服务、monitors、主题、channels 和可执行文件不列出。AgentKib 看不到：通过 `--settings` 或 `--setting-sources` 传入的设置、经 MDM、配置描述文件或 Windows 注册表下发的策略，以及服务端托管的设置。尚未建模：Claude Code 按需加载的子目录里的 `CLAUDE.md` 与规则、`--add-dir` 目录与嵌套 work tree，以及会关闭 `CLAUDE.md` 加载的环境变量，或设置在 settings 的 `env` 块里的这些变量（只给出提示）。Claude Code 2.1.281 之前的部分会话（如 Bedrock 或关闭遥测）仍只读 CLAUDE.md。AgentKib 只认自己进程环境里的 `CLAUDE_CONFIG_DIR`（从 Finder 或 Dock 启动的应用看不到 shell 里的 export、逐次设置的 alias，也看不到 settings 的 `env` 块）；值须是不含 `..` 的绝对路径，否则读取使用默认目录，写入会被拒绝。

AgentKib 会区分“已安装”和“卸载后仍留有本地数据”。涉及 Agent Home 的写入会单独请求授权。Antigravity ACP 会话不代表完整的 Desktop/IDE 或 CLI 历史；当前稳定接口也不能把外部历史导入 Antigravity 原生会话。DeepSeek Harness 是 Beta 目标。AgentKib 自身不写入它的 profile、配置或会话文件，不为它配置 MCP，也不纳入工具管理：用户自己运行的 DSH 由用户安装插件；AgentKib 在后台启动的 DSH 经命令行叠加层加载插件，不改任何 profile；会话操作在运行中的 DSH 内经它自己的服务执行（见“Web 访问与续接”）。

### Web 访问与续接

- 配对首先授予读取权限；发送和审批是单独的浏览器权限，同时还需要打开主机控制开关。
- Web 首页与桌面首页一致。宽屏时上面是新建会话（这次访问不能发送时隐藏），下面是需要你处理、进行中和待查看，左侧是会话目录；侧栏最上面的“首页”和右上角铃铛都显示需要你处理的数量，点 AgentKib 标志回到首页。手机宽度先显示首页，用“首页 | 全部会话”切换，右上角“+”新建会话，下面列最近 3 个会话；“已授权浏览器”和退出留在“全部会话”里。审批和问题在行里用会话页的同一张卡片直接作答，检查也相同；结果不明时不重发，该行改为“结果待核对”。断线时列表保留，作答和新建会话不可用。新建会话与桌面用同一个输入框：工作区、Agent、各 Agent 自己说法的权限、模型和强度、附件；Codex 选“请求批准”以外的策略需要完整访问的浏览器。
- Claude Code 桌面/Web 在 macOS CLI ≥ `2.1.263` 上共用执行服务，前台 Bash 契约要求 ≥ `2.1.285`：准备新会话不调用模型，停止原终端并确认后可续接原 UUID。仍核验原生身份、协议结构和回执，新版通过最低门槛不代表真实设备验收通过。托管会话启动 CLI 时关闭后台任务（`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`），子代理在前台运行；对不认识的帧与请求不再终止会话（不认识的请求只会被拒绝，绝不放行）；对帧的处理验证到 `2.1.299`：合成帧加 2026-10-14 的一次真机验收（启动、空闲、Bash 审批、一个前台子代理、一次 MCP 审批、同一 UUID 续接；见[真机验收 QA](../qa/claude-live-acceptance-2026-10-14.md)）。LAN 仍禁上传，Windows/Linux 控制保持不可用。详见 [Claude 使用说明](agents/claude-code-managed.md) 与[历史原生 QA](../qa/claude-managed-2026-09-30.md) 及[当前 TypeScript QA](../qa/typescript-stability-2026-10-07.md)。
- Codex Web 控制默认由 AgentKib 自己的 app-server 续接；写锁被 Codex 桌面端持有时改为跟随桌面端的 owner（仅 macOS，Desktop ≥ `26.917.62051`），只开放发送（可带附件）、停止和审批。版本未知或格式异常、平台不支持、没有 owner 或原生协议不兼容时显示原有的占用选择条；满足门槛不能代替原生校验和真实验收。
- Antigravity Web 控制只管理官方 ACP server 返回的会话。运行时协商 ACP v1 能力，重新核验索引会话和工作区，并要求 revision、turn、request 与服务端提供的权限选项全部精确匹配。
- DeepSeek Harness 控制（macOS）经装有 AgentKib 插件的 DSH 进行。用户自己的 DSH 都没有运行时，AgentKib 用 DSH Desktop 自带的命令行在后台启动 web 配置（DSH Desktop 的会话在这个配置里继续），叠加用户在 Desktop 里的设置，插件只为这次运行加载；空闲 3 分钟后（DSH Desktop 的窗口开着时 1 分钟）、用户自己装了插件的 DSH 连上时（DSH 恢复过的会话会一直占着，直到它退出）以及 AgentKib 退出时关闭，退出前先列出会被停止的轮次。“需要时自动启动 DeepSeek Harness”在该会话的“会话操作”里设置。要从这里控制用户自己运行的 DSH，在它运行的 profile 中装好插件并重启 DSH：DSH Desktop 在“添加插件”里粘贴插件目录；命令行执行 `dsh plugin --profile <name> add <目录>`（桌面端该会话的“会话操作”里两种都给出）。用户的 DSH Desktop 没装插件却占着某个会话时，要等 Desktop 退出才能从 AgentKib 继续，AgentKib 会说明。插件调用 DSH 的会话服务，不另起执行者。可以发送，运行中按“运行中发送”设置排队或加入本轮，编辑或撤回待发消息，停止，以及作答审批和问题；桌面与 Web 的待发消息显示在输入框上方的待发条中。DSH 与 AgentKib 先答者生效，另一边随即撤下卡片。结果无法确认时，按请求 ID 核对 DSH 的记录，或在两分钟后按当前状态判定，从不重发。会话操作还可以重命名、分叉、归档和取消归档，输入框可按 DSH 自己的模型目录切换模型与推理强度（归档和改模型要等本轮结束）；用户自己的 DSH 最多只有一个在运行时（一个也没有时在 AgentKib 启动的那个里），可在已授权的工作区新建 DSH 会话，并像 DSH 自己的新建页面一样选择 Agent 预设（会话开始后不能再改）。消息可以带图片（PNG、JPEG、WebP、GIF），排队或加入本轮的消息也可以，会话历史中显示这些图片；其他文件与别的 Agent 一样以路径写进消息交给 DSH。当前模型不收图片、或图片超出 DSH 的限制时，DSH 拒收，AgentKib 说明原因并保留草稿；带附件的待发消息可以撤回，不能编辑。目标面板经 DSH 的目标服务设置、暂停、继续和清除会话目标，运行中也可以；DSH 按轮次而不是 token 限制目标，DSH 刚恢复的会话里的目标要点继续才会接着运行。输入框的 `/` 菜单列出 DSH 自己的斜杠命令，消息以其中某个命令开头时由 DSH 执行，与 DSH 窗口一致，运行中也可以；历史中显示命令和 DSH 的回答；成功切换权限预设的命令与 DSH 窗口一样不显示，预设只显示在执行策略中，失败的照常显示原因。`/goal`、`/permission` 和其他 DSH 插件的命令需要完整访问的设备，`/export` 只能在 DSH 窗口使用。压缩在会话空闲时执行 DSH 自己的 `/compact`，压缩期间消息要等它结束。设置对话框把 DSH 的权限预设（沙箱模式加审批策略）作为执行策略切换，运行中也可以，需要完整访问的设备。手机上可以查看会话的子代理，与 DSH 窗口一样只读。其他 Agent 的会话可以交接给 DSH：审查后的交接文件写入 `.agentkib/handoffs/`，“应用并继续”在运行中的 DSH 新建会话，发一条消息让它读这个文件，然后在 AgentKib 中打开该会话。置顶暂不提供。
- 手机通知（iOS；经官方中继配对、并登录这台电脑所在账号的手机 App）：会话开始等待批准、回答或核对时，以及看到在运行的一轮完成或失败时发提醒；会话持续工作 1 分钟后在锁屏和灵动岛显示实时活动，只有一个会话时显示它的标题。有人正在用这台电脑时提醒先不发，离开后仍然成立才发。提醒文字在电脑上加密给手机，中继和 Apple 只转发密文；实时活动内容按 Apple 的规定为明文，只含数量、时间和至多一个标题。中继需要配置 APNs。
- 请求回执不代表轮次或审批已经完成。断线或结果不明确时不会自动重试。

### 平台状态

| 平台 | 状态 |
| --- | --- |
| macOS 13.3+（Apple Silicon / Intel） | 主要开发与验收平台；发布包已签名并通过 Apple 公证 |
| Windows 11 x64 | 发布工作流构建并烟测 NSIS；安装包尚未进行 Authenticode 签名 |
| Ubuntu 22.04 x64 | 核心 CI 平台；发布包包含经过验证的 `.deb` 与 AppImage |
| Fedora x64 | PR 运行平台检查；发布包包含经过验证的 `.rpm` |
| Windows ARM64 / Linux ARM64 | Preview 包，原生回归覆盖有限 |

平台配置和已知限制见 [Windows 指南](development/windows.md)、[升级指南](UPGRADING.md)和[发布指南](development/release.md)。
