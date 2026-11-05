> Publication note: referenced design files and historical captures are local-only evidence, excluded from public source to protect workspace and session data. Public synthetic screenshots are explicitly allowlisted in `.gitignore`.

# AgentKib v8 Design QA

**Source visual truth**

- Prototype: `designs/agentkib-codex-flow-redesign-v8.pen`
- Home frame export: `qa/home-reference-v8-original.png`
- Normalized home reference: `qa/home-reference-1215.png`

**Rendered implementation**

- Electron home: `qa/home-implementation-final.jpg`
- Workspace overview: `qa/workspace-overview-implementation.jpg`
- Agent inspector: `qa/agent-implementation.jpg`
- Settings light/dark: `qa/settings-light-implementation.jpg`, `qa/settings-dark-implementation.jpg`

**Viewport and normalization**

- Source frame: 1360 × 860 CSS px, exported at 2720 × 1720 px (`@2x`).
- Electron capture: 1215 × 768 px at the active macOS window density.
- For the full-view comparison, the source was downsampled to 1215 × 768 px so source and implementation use the same pixel dimensions and aspect ratio.
- Compared state: light theme, global “Today” page, expanded 256 px contextual sidebar, populated workspace data, no pending issues.

**Full-view comparison evidence**

- Initial comparison: `qa/home-comparison-initial.png`
- Final comparison: `qa/home-comparison.png`
- The final pass verifies the major-region proportions, task-first hierarchy, 360 px recent-workspace rail, neutral surfaces, dark primary buttons, blue links/focus accents, selected navigation weight, and bottom settings entry.

**Focused-region evidence**

- Separate full-window captures were used for the workspace-context sidebar, Agent master/detail inspector, flat settings layout, and neutral dark-theme mapping. A further crop was not required because controls, labels, dividers, and typography are legible in the 1215 × 768 captures.

**Required fidelity surfaces**

- Fonts and typography: Geist/system stack retained; heading, body, label, and muted-text hierarchy match the v8 density. Long paths and names truncate instead of displacing status/actions.
- Spacing and layout rhythm: 52 px toolbar, 256 px sidebar, 24 px content inset, 20 px master/detail gap, 360 px list rail, and 840 px settings content ceiling are implemented. Content expands naturally without viewport-filling placeholder cards.
- Colors and tokens: light surfaces are neutral white/gray; selected state is `#EDEEEE`; primary actions are dark; blue is limited to links/focus/compact status emphasis. Dark mode uses `#181818` and neutral grays without blue-gray large surfaces.
- Image and icon fidelity: existing Agent assets and Lucide icons are reused; no substitute glyphs, CSS drawings, or generated icon assets were introduced.
- Copy and content: navigation is renamed and regrouped to match v8 (“Today”, global asset catalog, quota, insights), while values remain real API/Query data rather than prototype fixtures.

**Comparison history**

1. Initial pass — blocked by P1/P2 differences:
   - P1: Home still used the legacy onboarding card and metric-card stack instead of the v8 task center.
   - P2: stored accent themes colored primary buttons and the sidebar blue.
   - P2: the bottom settings entry was a plain row, recent-workspace navigation was too dense, and the home breadcrumb lacked its parent context.
2. Fixes applied:
   - Rebuilt the populated home state around a compact summary, issue queue, recent workspaces, and natural activity flow.
   - Increased selector specificity so accent preferences no longer tint large surfaces or primary actions.
   - Added the card-style settings entry, reduced recent sidebar workspaces to two, and added `Workspaces / Today` breadcrumb context.
3. Post-fix pass:
   - `qa/home-comparison.png` has no actionable P0/P1/P2 mismatch. Remaining content differences are expected because the app renders live workspace, activity, health, and Agent data instead of prototype fixtures.

**Findings**

- No actionable P0, P1, or P2 visual findings remain in the checked states.

**Open Questions**

- None blocking. Exact native blur appearance varies with the macOS content behind the translucent sidebar; the solid fallback remains neutral.

**Implementation Checklist**

- [x] Global, workspace, Agent, and settings sidebar contexts
- [x] Fully hidden sidebar and toolbar recovery affordance in the implementation and automated coverage
- [x] Task-first home, workspace master/detail, Agent inspector, flat settings groups
- [x] Light and representative dark states
- [x] Loading/empty/error/status behavior retained from existing Query-backed pages
- [x] Same-input source/implementation visual comparison

**Follow-up Polish**

- P3: Real activity action names currently expose internal event identifiers when no localized label exists. This does not alter layout or the core task flow, but future copy cleanup could improve readability.

## Tools & Updates implementation

**Source and rendered evidence**

- Pen direction: `designs/agentkib-settings-tool-updates/direction-2-grid.pen`
- Pen export: `designs/agentkib-settings-tool-updates/direction-2-grid.png`
- Electron light theme: `qa/tools-updates-implementation.png`
- Electron dark theme: `qa/tools-updates-dark.png`
- Electron 1215 × 768 responsive state: `qa/tools-updates-narrow.png`
- Side-by-side comparison: `qa/tools-updates-comparison.png`

**Viewport and state**

- The Pen and primary Electron captures both use a 1440 × 920 CSS px viewport and a 2× PNG export (2880 × 1840 px).
- The Electron capture uses the real settings shell and live read-only tool detection. It shows eight Agent cards, a Codex path conflict, a Claude Code update, uninstalled tools, a cached-version warning, and partial upstream failures.
- The implementation retains the existing application toolbar and breadcrumb, while the Pen direction omits that application-level chrome. Card hierarchy, four-column density, status treatment, update actions, and the two bottom command panels remain aligned with the selected direction.

**Comparison history**

1. Initial implementation pass:
   - P2: the fixed-size `AgentIcon` overflowed an additional wrapper and visually collided with Agent names.
   - P2: `DeepSeek Harness` was truncated at 1440 px.
   - P2: duplicated cached and partial-error notices pushed the bottom panels below the 920 px viewport.
2. Fixes applied:
   - Sized the existing Agent icon component through its wrapper instead of nesting a second visible icon frame.
   - Reduced only the card-header density needed to keep every Agent name readable.
   - Combined related cached/partial-source notices and tightened card rhythm without removing status, version, channel, path, warning, or action information.
3. Final pass:
   - At 1440 × 920, the page scroll container is 868 px high and its content is exactly 868 px high; no heading is truncated and no child reports overflow.
   - At 1215 × 768, the grid becomes two columns with no horizontal overflow; vertical scrolling is expected for the additional rows.
   - The dark theme preserves readable neutral surfaces and distinct conflict, update, cached, and safe-command states.

**Findings**

- No actionable P0, P1, or P2 visual findings remain in the checked light, dark, and responsive states.
- Live GitHub API rate limiting was handled as designed: cached versions remained visible and four source failures were summarized without blocking local detection.

**Post-handoff interaction verification**

- Fixed the transparent Electron drag layer intercepting the collapse, search, and overflow controls.
- Verified in the running Electron window that collapse, collapsed-state restore, global search, and the overflow menu all respond to pointer input.
- In the collapsed macOS state, the restore control and breadcrumb now clear the native traffic-light area.

final result: passed

### Official-channel and execution pass

- Electron verification: `qa/tools-updates-official-channels.jpg` (1215 × 768).
- The live page renders seven managed Agent cards; DeepSeek Harness is absent while the rest of the application can continue recognizing its historical data.
- Version labels are channel-aware. Verified npm, pnpm, Bun, Homebrew, and native updater actions are executable; remote installer scripts, Yarn, Nix, desktop-app, local, unknown, and conflicting installations remain manual.
- The update confirmation was opened and checked for Agent, channel, current version, target version, executable path, and the fixed command. The final confirmation was cancelled so QA did not modify any installed CLI.
- The card grid, installation-channel selector, conflict state, partial-source warning, sequential batch-update entry, and narrow-window scrolling remain readable without horizontal overflow.

final result: passed

## Settings layout unification

**Scope**

- Checked all six settings destinations in the running Electron app: General, Discovery, Tools & Updates, Integrations, Data & Privacy, and Diagnostics.
- Checked the shared form, management, and workspace widths, section hierarchy, panel borders, notices, statuses, and scroll behavior.
- Checked representative General and Integrations states in both light and dark themes; restored the app to light theme after verification.

**Results**

- General and Data & Privacy retain the compact form layout.
- Discovery, Integrations, and Diagnostics share the wider management layout and consistent panel treatment.
- Tools & Updates keeps its full-width card workbench while sharing the page, notice, and status primitives.
- Integration cards no longer use a separate shadowed/large-icon visual language; diagnostic panels now align to the same title and content rhythm.
- Responsive behavior was checked at the application's minimum-width constraint (`minWidth: 1280`); no horizontal overflow or clipped controls were observed. The settings grid and management columns collapse through their existing responsive breakpoints.

final result: passed

## v14 local session hub — 2026-09-07

**Scope and reference**

- Implemented the approved local-history stage, not the remote-control design: one 360 px directory within the existing navigation rail, filtered local overview, and in-place historical conversation reading.
- References: `designs/agentkib-v14-previews/40-aggregate-default.png` and `41-remote-live-chat.png`.
- Retained the production macOS window controls, breadcrumb, global navigation, tools group, typography tokens and Agent icons. These occupy more vertical space than the simplified Pen shell. Directory and conversation scrolling remain independent.
- Replaced the reference's remote-client selector, running/approval counts, permissions and composer with verified local record states, index statuses, a history notice and the existing workspace-continuation entry. No remote devices, live controls or fabricated execution states were added.

**Real Electron verification**

- Used an isolated temporary AgentKib Home, Chromium profile and synthetic Codex/Claude records across three registered workspaces, including two workspaces with the same name. No real user transcripts or project paths were used.
- Captured the actual 1360 × 860 window without OS shadows at 2×: `qa/sessions-v14/overview-light-1360.png`, `history-light-1360.png`, and `overview-dark-1360.png`.
- Also inspected the native zoomed 2056 × 1204 dark window: `qa/sessions-v14/overview-dark-wide.png`. Four metrics and the two overview panels remain readable; the directory stays in the original rail.
- Verified current/all filtering (4 current; 6 total, 5 readable, 1 archived, 1 metadata-only), title search, empty results and reset. Excluding the selected record returns to the overview.
- Opened metadata-only history: descriptive empty state, no transcript and no continuation action. Opened readable history: messages, saved tool summaries and an explicit non-live notice, without a composer.
- Opened “More”: Settings is enabled; Remote connection is disabled and exposes “Not available yet.” Settings navigation and switching back preserve the directory state. Restored the isolated app to light theme.
- Activated “Continue in workspace” and verified that the original workspace session page opened with the intended session selected. No continuation command was executed during QA.

**Visual comparison**

- Examined combined reference/implementation images at the same 1360 × 860 layout scale: `qa/sessions-v14/comparison-overview.png` and `comparison-history.png`.
- Examined the focused sidebar/header crop in `qa/sessions-v14/comparison-focus.png`: one rail, aligned directory width, existing neutral tokens and icons, readable 14 px directory/body text, consistent control radii and no overlapping controls.
- The actual history is longer than the Pen sample and correctly scrolls vertically. The overview panels size to real content rather than reserving space for remote approvals.
- The initial exploratory comparison used an OS-shadow capture and is not a valid pixel-alignment reference; only the final no-shadow comparisons above are used for acceptance.

**Problems found and corrected**

- Real refresh initially failed because upstream discovery registered OpenCode while the store accepted only Codex/Claude. Aligned the store check with registered conversation providers and verified a successful refresh in Electron. No RPC or database schema changed.
- Independent data review found two deep-link races: a retry clearing errors before recovery, and the first render after re-enabling indexing. Both were corrected and covered by regression tests.
- Automated tests also cover concurrency capped at four, cached results on partial failure, index-off behavior, stale history/pagination requests, duplicate workspace names, navigation and the disabled remote entry.

**Validation and remaining coverage**

- `pnpm test`: 56 files / 306 tests passed.
- `pnpm typecheck`, `pnpm build`, `cargo fmt --all -- --check`, `cargo test -p agentkib-store` (34 tests), and `git diff --check` passed.
- The checked 1360 px light/dark and native wide-window states pass visual review. Exact 1440 × 920 and sub-1024 drawer viewport captures remain unverified: the native automation did not resize to the requested dimensions, and production Electron retains its existing 1280 px minimum width. Responsive drawer structure has automated coverage, but that is not a substitute for its remaining rendered narrow-viewport acceptance.

final result: implementation and verified desktop states passed; exact-size/narrow visual coverage remains pending

### Session overview header correction — 2026-09-07

- Source: user-annotated `codex-clipboard-19012e84-17cb-4b7e-95c8-565c0f758e49.png` (2560 × 1578), identifying the duplicate page-heading band below the shared “Sessions” toolbar.
- P2 corrected: removed the overview-only title, matching-record subtitle and duplicate content refresh button. The existing window toolbar and directory refresh remain; a selected conversation still has its identifying title, back action and workspace continuation.
- Real Electron capture: `qa/sessions-v14/overview-header-simplified.png`, 1280 × 789 CSS px / 2560 × 1578 at 2×. Compared the same light-theme overview and fixture counts against the supplied image, normalized to 1280 × 789 per side.
- Full comparison: `qa/sessions-v14/comparison-header-simplified.png`; focused header comparison: `qa/sessions-v14/comparison-header-focus.png`.
- Typography, neutral colors, Agent icons, sidebar geometry and metric content are unchanged. The removed band allows the existing content to move upward; no replacement heading or empty spacer was introduced. No new image assets were needed.
- Verified one refresh button in the overview, selected-history title/continuation still present, and successful return to overview. No overlap or clipping was found in this scoped correction.
- Validation: 14 related UI tests passed; `pnpm typecheck` and `git diff --check` passed. This local correction does not close the earlier exact-size/narrow-viewport coverage gap for the broader feature.

final result: passed

### Unified global search and compact session directory — 2026-09-07

- Moved global search to the primary sidebar brand row and settings Back row. The settings-only search remains separate; the right toolbar no longer duplicates global search. Verified the visible fallback while the primary sidebar is collapsed.
- The directory now has only its compact label and options menu above workspace groups. Agent/record filters are in submenus, with removable non-default chips. Verified reset from an archived search result returns to the current-record overview.
- Search groups indexed sessions, registered workspaces, logical assets and pages. Verified keyboard selection from Settings into an archived session, same-name workspaces with distinct paths, asset metadata details and return to the unchanged query. No asset file is executed or read by these interactions.
- Read-only search loaders have regression coverage for disabled indexing, max-four concurrency, cached records, partial errors, retry, stale requests and logical asset merging. The backend caps catalog results at 500; reaching that cap now produces a limitation notice instead of claiming complete results.
- Independent review caught popup/portal layers below the floating sidebar, hidden focus restoration targets and directory peek closing while a submenu was open. Search uses overlay/popup layers 100/101; only sidebar menu positioners use 80. Regression tests cover these layers, focus fallback, combobox keyboard behavior and closing mobile drawers when global search opens.
- Real Electron QA used the existing isolated synthetic workspace fixture and its 1280 × 789 window. Light/dark search, asset detail, directory menu and collapsed navigation were inspected; the temporary profile was restored to light mode and the current-record overview. Capture files (2784 × 1802 PNG including the native window shadow): `qa/sessions-v14/search-sidebar-light.png`, `search-dialog-light.png`, `search-dialog-dark.png`, `search-asset-detail.png`, `search-directory-menu.png`.
- A development hot-reload context error (`SessionHubProvider is required`) occurred while editing the shared root/sidebar modules. After full renderer reload, the Settings → global search → archived-session path was retested successfully. This was not treated as a successful HMR test.
- Validation: final `pnpm test`, `pnpm typecheck`, `pnpm build` and `git diff --check` all passed. Existing Node localstorage warnings remain non-failing. No commit, PR, production dependency, Rust RPC or database changes were introduced by this search work.
- Remaining visual coverage: sub-1024 viewport/drawer rendering could not be verified in the native window because `MAIN_WINDOW_MIN_WIDTH` is 1280. Responsive structure, drawer closure and overlay layers have automated/static coverage; this is not a substitute for a rendered narrow-viewport check. Native minimum sizing was not changed just for QA.

final result: implemented and verified at the available desktop size in both themes; narrow-viewport visual acceptance remains pending

### Sidebar search placement and stable width correction — 2026-09-07

- Removed the session-route 360px sidebar override. Sessions now inherits the same 224px width as the other primary pages, including the expanded floating sidebar.
- Search remains in the original sidebar header and hides with it; removed the extra window-navigation search button and its reserved spacing. Keyboard search remains available. When the original search trigger is hidden, closing the dialog can restore focus to the existing sidebar toggle.
- Real Electron QA at 1280 × 789 confirmed matching sidebar boundaries when switching Today → Sessions, no extra search icon when collapsed, successful ⌘K search, and Escape focus restoration to Expand sidebar. Restored the expanded session overview afterward.
- Validation: the full frontend suite passed (59 files, 340 tests); after the focus adjustment, the AppShell/global-search regression tests and typecheck were rerun. No backend, protocol or persisted settings changes; no commit created.
- This supersedes the earlier collapsed-search fallback behavior, not the outstanding narrow-viewport coverage limitation.

final result: passed for this scoped correction

### Session directory final simplification — 2026-09-07

- Session rows retain only the Agent icon and title; Agent/record metadata remains in the hover description.
- Workspace groups use closed/open folder icons without a separate chevron. Full-row activation and accessible expanded state remain intact.
- Selected sessions use only the existing background highlight, without the inset edge. Removed the directory footer refresh action; the history detail refresh remains available.
- Updated directory regression coverage for folder state and removal of the footer action. Directory/history tests (15 tests), typecheck and whitespace checks passed. These scoped changes have automated coverage; no new full visual acceptance is claimed.

### Shared resizable sidebar — 2026-09-07

- All expanded desktop sidebars now share a 250px default and a 250–400px drag range; Sessions does not apply a separate width. The effective maximum also reserves 640px for main content. Collapsed, floating-peek and mobile drawer states do not expose the resize handle.
- The boundary supports pointer dragging, double-click reset, arrow-key adjustment and Home/End. Cancellation restores the saved width. Saving occurs on release, not on every pointer move; failed saves restore the previous value and display a notice.
- Width is stored in the existing `preferences.json`, preserving other preferences, rather than relying on Chromium storage. Protocol version 10 adds the validated width preference and setter. Stale Runtime reads cannot overwrite an in-flight or newer width selection.
- Real Electron QA used an isolated benchmark data directory and Chromium profile at 1360 × 860. Confirmed the initial 250px boundary, dragging beyond the maximum clamps to 400px, disk persistence without changing other preferences, and double-click restoration to 250px. Inspected `output/playwright/sidebar-resize-250.png`; no overlap or horizontal overflow was observed in this state.
- Automated checks cover shared page widths, collapsed/narrow handle visibility, pointer cancellation, keyboard/reset behavior, save serialization/failure, hydration, stale Runtime responses and preserving unrelated preferences. Validation passed: 61 frontend/Electron test files with 368 tests, typecheck, build, 36 relevant Rust runtime/protocol tests, Rust formatting and `git diff --check`.
- Remaining manual coverage: the follow-up Electron automation connection stalled, so a full process restart, dark theme and narrow-window rendering were not accepted by this QA run. Persistence and responsive behavior have automated coverage, not a substitute for those visual checks. Only the isolated QA instance was stopped; the existing user app and development server were left intact.

final result: implemented; scoped light desktop drag/reset and persistence verified, remaining manual coverage documented

### LAN connections and read-only remote history — 2026-09-07

- Enabled More → Remote connections and added the complete settings section after Tools & updates. Retained the shared 250–400px sidebar and workspace folder animation. Remote records use host-qualified IDs, readonly history and a host filter inside the existing directory menu; there is no remote send/approve/stop/continuation control.
- Electron QA used an isolated data directory and Chromium profile, with synthetic local workspaces and session indexing disabled. Checked the sharing-off settings page at 1440×920 in light/dark themes and at 760×920 in dark theme; inspected `output/playwright/remote-settings-light.png`, `remote-settings-dark.png` and `remote-settings-narrow.png`. Content remained readable and vertically scrollable without horizontal clipping.
- Opened More by keyboard, selected Remote connections and inspected the actual 1360×860 quick panel (`output/playwright/remote-quick-panel-dark.png`): connected-host empty state, discovery, manual address/code, disabled incomplete pairing and full-settings entry. The existing menu exit animation stayed visible in the background of this CDP screenshot; this background Electron session also required forced clicks/keyboard because compositor stability waits stalled. Navigation from Sessions into full settings exposed a provider-lifetime race: the route location changed before the retained session Outlet unmounted. Fixed by keeping the provider stable and pausing its reads/listener outside Sessions, with a regression test. Repeated Sessions → More → Remote connections → full settings successfully with zero console errors after the fix. No full visual acceptance of populated remote history is claimed.
- Two independent Runtime processes used separate temporary data directories and a private IPv4 interface. Verified real TLS, matching verification digits, pre-approval read denial, approved empty catalog, index-off denial, revocation denial and stopping sharing. The initial harness omitted the normal Runtime handshake and failed on the uninitialized MCP hub; after adding the required handshake and separate loopback MCP ports, the complete check passed. Harness: `output/playwright/verify-remote-runtime.mjs`.
- Real TLS fixture tests cover populated history, certificate changes, persistence, expiry/attempt limits, duplicate/unknown operations, limits, and revoke/index-off races while streaming. Independent review identified and fixed listener restart recovery, per-device grant cancellation, slow-response cancellation and the pre-approval TLS grant-binding window. Remote payloads are schema-validated before entering renderer caches.
- Verification: full Rust workspace tests, 18 remote TLS/security tests, workspace Clippy with warnings denied, Rust formatting, 411 frontend/Electron tests (66 files), typecheck and full production build passed. Protocol generation was repeated with an identical generated-file SHA-1. Whitespace validation passed. Build emitted non-failing Vite performance warnings; frontend tests emitted the existing Node localstorage-file warning.
- Remaining acceptance: actual separate-device mDNS, network/firewall prompts, Windows file ACL enforcement and Windows x64/ARM64 execution. Windows full cross-compilation was blocked by the missing local MSVC SDK header `assert.h`; the added ACL API passed an isolated Windows-target metadata check. Same-machine/private-interface tests do not substitute for cross-device LAN acceptance.

final result: implemented and locally verified; cross-device/platform acceptance remains

### Application-wide reactive internationalization — 2026-09-07

- Audited sidebar/navigation, route pages, settings, global search, sessions, assets/Skill Hub, Agent management, workspace diagnostics/continuation, quota, insights and shared dialogs/loading states. The main defect was non-reactive global translation calls: dictionary entries existed, but language changes did not invalidate memoized/compiled views. Added a shared `useI18n` hook and explicit translator/locale dependencies for presentation helpers; no language-key remounting.
- Date/time, relative-time, compact-number and heatmap labels now follow the application's selected locale. Replaced remaining Close/Loading/Not found and diagnostic/Beta labels. Stored structured errors in the affected panels and search/history hooks are translated at render time; original technical details, product names, paths and user content remain unchanged.
- Automated checks cover English, Simplified Chinese, Traditional Chinese and Japanese switching without manually rerendering, retained DOM/input/tab state, live error translation without extra requests, and dictionary/interpolation parity. Full `pnpm test`, `pnpm typecheck`, `pnpm build` and `git diff --check` passed. Existing Node localstorage and Vite plugin-timing warnings were non-failing.
- Playwright CLI inspected an isolated Electron instance using synthetic workspaces and separate preferences/Chromium storage. Its initial MCP port collided with the user's existing Dev instance; only the QA profile's port was changed to an unused loopback port, then Runtime retry succeeded. The user's app/server and preferences were untouched.
- Real UI checks: changed English → Simplified Chinese → Japanese → Traditional Chinese through General settings. Verified translated navigation, the original More-menu report, the remote quick panel/full settings, homepage activity dates, Japanese light-theme settings at 1440×920 and Traditional Chinese settings at 760×920. No language-related clipping or console errors observed in these views. Automated coverage covers the remaining audited pages; this is not a claim that every possible backend error or data-dependent state was manually visited.
- Inspected screenshots: `output/playwright/i18n-settings-zh-CN-dark.png`, `i18n-more-zh-CN-dark.png`, `i18n-remote-zh-CN-dark.png`, `i18n-settings-ja-JP-light.png`, `i18n-settings-zh-TW-narrow.png`. A theme-transition frame was recaptured after settling. Background Electron/CDP refs were unstable, so observed accessible locators and forced clicks/keyboard were used for UI automation.

final result: audited i18n defects fixed and verified; no commit created

### Bounded latest-session history — 2026-09-07

- Local and remote history now request the latest 50 messages/tool records by default, in chronological order, with earlier pages on demand. Codex and Claude JSONL reading starts at the file tail; full-context handoff/export retains its separate 256 MiB limit.
- Added bounded scan windows, oversized/damaged-record warnings, retryable opaque cursors and finite association/cache state. Older-page reads can return an empty window with a continuation cursor instead of incorrectly reporting that no history exists. Ambiguous old-format mirrors and distant tool/context associations are handled conservatively with a warning; no claim of perfect full-file association or arbitrary mid-file mutation detection is made.
- Both history views show localized explanations and collapsed diagnostic details using the existing Collapsible primitive. Four-language tests cover live error/warning translation. No page layout redesign or manual screenshot acceptance was performed in this scoped fix.
- Regression fixtures cover transcripts larger than 256 MiB, a giant line crossing scan budgets, 21,000-message pagination, Codex mirrored records with differing timestamps, Claude multi-block records, cross-page tool results, append/retry/truncate, and preserving handoff limits. Independent read-only review found and resolved mirror matching and unbounded association/EOF-wait defects.
- Validation passed: Rust formatting, full workspace tests, workspace/all-targets Clippy with warnings denied, `pnpm test` (73 files, 445 tests), `pnpm typecheck`, production `pnpm build`, and `git diff --check`. Node localstorage and Vite plugin-timing notices remain non-failing. Existing user app and dev server were not stopped; the running instance must be restarted to load the rebuilt Runtime.

final result: implemented and automatically verified; no commit created

### Session provenance and duplicate-title clarification — 2026-09-07

- Native session IDs remain the identity; identical titles are never merged or renamed. Codex structured source metadata distinguishes interactive/manual forks from auxiliary subagents; missing or unrecognized sources remain visible. Claude sidechains retain their existing semantics. Parent-spawn and fork relationships are independent and use hashed IDs, with host namespaces for remote records.
- A shared, process-local “Show auxiliary sessions” option controls directory, workspace, search and home recents. The default synthetic fixture now shows 3 interactive sessions (one original and two forks); enabling the option shows all 13 including 10 auxiliary records. Forks retain their title, have a small icon, and expose separate source links/details without reinstating row subtitles.
- Schema 11 retains old cache rows as unknown and invalidates freshness for reclassification. Migration version reading and all schema steps now share an immediate transaction; concurrent schema-9/new-database opens are covered. Desktop IPC is 12; remote protocol remains 1 with optional compatible provenance fields. Unsupported upstream schemas preserve the last successful cache; successful refreshes reconcile native archives/deletions. Remote deleted/unreadable history is pruned and late responses cannot refill it.
- Isolated real-Runtime fixture `output/playwright/prepare-session-origin-qa.mjs` passed classification (3/13), hashed identifiers, schema-failure retention, archive/delete reconciliation and recovery checks. It writes only temporary synthetic data; no user Codex records or preferences were changed.
- Playwright CLI inspected the isolated Electron app at 1360×860 (light/dark) and 760×860 (dark). Verified default/all counts, small fork icons, unchanged titles, a source link navigating to its parent, readable historical messages and narrow responsive layout. Inspected `session-origin-default-light.png`, `session-origin-all-light.png`, `session-origin-fork-light.png`, `session-origin-fork-dark.png`, and `session-origin-fork-narrow.png` under `output/playwright/`; no clipping or overlap was observed in these states. A background-window click waiting on animation was retried with a forced click against the observed accessible control.
- Validation passed: `cargo fmt --all -- --check`, `cargo test --workspace` (540 tests), `cargo clippy --workspace --all-targets -- -D warnings`, repeat protocol generation with an unchanged SHA-256, `pnpm test` (74 files / 463 tests), `pnpm typecheck`, `pnpm build`, and `git diff --check`. After removing unused source-helper exports, the affected tests (23) and typecheck passed again. Existing Node localstorage/plugin timing notices were non-failing.
- Remote compatibility, unavailable parents, dual relationships, search/workspace visibility and async selection boundaries have automated coverage; this run did not add a physical cross-device LAN acceptance test. The running user application was left untouched and requires a restart to load the rebuilt Runtime. No commit or PR created.

final result: implemented and verified for this scope

### Dual Electron pairing acceptance — 2026-09-07

- Ran two isolated headed Electron clients with real Runtime/preload/renderer, synthetic indexed history and a private IPv4 interface. Used UI controls for discovery selection/manual address, invalid code, matching verification digits, rejection, approval, history selection, disconnect/reconnect, revoke/re-pair, sharing off/on, index off and host removal. No user data or existing client was modified.
- Pairing, approved remote history and read-only controls passed. Both clients restarted with trust intact; no live code survived. Revocation, sharing off and index off cleared remote history after the existing polling converged. Test sharing/grants/connections were removed and both owned clients exited; listener cleanup was verified.
- Re-ran 19 remote TLS/security tests successfully; rebuilt Electron successfully; no uncaught renderer page errors in either pass. Full inventory, assertions, screenshots and limits: `output/playwright/remote-pairing-qa.md`.
- Found an unresolved P2: wrong/consumed pairing codes surface raw English IPC/Runtime errors (`REMOTE_PAIRING_INVALID`) in the Chinese UI. Rejection itself is correct; map remote error codes to localized user-facing feedback. This testing task did not change production code.
- Inspected light pairing/history and dark error states at 1360×860 and native minimum 1280×860. A 760px resize request was clamped to 1280px, so no 760px signoff. The revoked-panel screenshot is transitional, not a stable visual signoff artifact.
- Physical cross-device mDNS/firewall/OS permission and Windows acceptance remain unverified. Same-machine dual-client testing does not replace those checks. No commit or push.

final result: pairing and read-only flow verified on two same-machine Electron clients; one feedback-localization defect remains

### Remote error localization follow-up — 2026-09-07

- Resolved the pairing QA feedback defect with a shared remote error description for the quick panel, full settings and session catalog failures. Known wire codes and local validation errors map to four-language guidance; unknown errors use a generic localized summary. Raw diagnostics are collapsed by default and limited to 4096 characters. Structured translations and their parameters remain supported.
- Tests cover wrapped Electron errors, expired/consumed codes, offline/revoked/identity/protocol/limit failures, invalid addresses, unknown errors, dynamic four-language switching, bounded diagnostics and disclosure reset. All frontend tests passed (75 files / 491 tests). Corrected a new session-page test fixture to use its actual string error type, then re-ran that suite (11 tests) and the TypeScript/renderer production build successfully. Whitespace validation passed. Existing Node localstorage and Vite performance notices remain non-failing.
- Used the isolated two-Electron QA driver with real TLS to submit an invalid code again. The quick panel showed the Chinese recovery message without IPC text, expanding technical details showed the original error, and navigating into full settings preserved the localized/collapsed summary. Inspected `output/playwright/remote-pairing-error-localized.png` at 1360×860; no text clipping or overlap observed. No uncaught renderer page errors. Both owned clients exited and test sharing was disabled.
- No pairing authorization, networking, persistence or protocol changes. Physical cross-device/Windows acceptance remains a separate unverified boundary. No commit or push.

final result: pairing error localization defect fixed and verified

### Session reader and reliable turn grouping — 2026-09-07

- Implemented the approved global-reader hierarchy: one window toolbar, compact source/read-only context with keyboard-accessible details, a centered 900px reading column, plain Agent replies, and right-aligned user bubbles. Existing workspace history keeps its previous cards and controls. No composer, bridge control, approval, stop, undo or review capability was added.
- Added optional `turn_id`/`message_phase` metadata and desktop protocol 13. Codex reverse paging derives identities only from explicit fields, validated local boundaries and tool associations within existing read budgets. Unknown phases, ambiguous mirrors, incomplete pages and missing starts do not hide commentary. Event identity, body/order, latest-50 paging and existing cursors remain intact. Remote response validation explicitly preserves these optional fields, tolerates missing/future phases and continues stripping untrusted extra fields; no remote methods, authorization, database migration or persisted history cache changed.
- Complete reliable turns collapse commentary/tools while final replies remain visible. Legacy records only collapse contiguous tools. Failed tools default open; user expansion overrides are session-scoped and survive prepending. Keyboard-triggered pagination measured a reading-anchor delta of approximately 0.2px. Added Simplified Chinese, Traditional Chinese, English and Japanese labels.
- Verification passed: `cargo test --workspace` (577 tests), `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `pnpm test` (77 files / 510 tests), `pnpm typecheck`, `pnpm build`, targeted Oxfmt checks and `git diff --check`. Generating the protocol twice produced identical SHA-256 `ce548c63ce96948297bff577af428c7ccc9527f53917f63874bc187829c06579`. Existing Node localstorage and Vite size/transform notices remain non-failing.
- Headed macOS Electron synthetic-data verification: 50/50 checks passed in light and dark themes at 1360×860, 1440×920, native-minimum 1280×680 and isolated-QA 760×860. Inspected screenshots for the collapsed reader, failed/open process, focused details/time, compact action menu and long fenced code. Long code scrolls within its own block; no outer horizontal clipping observed. Local continuation navigation, refresh/back, remote metadata rendering and absence of remote continuation were exercised without sending any messages.
- QA setup corrections: aligned Playwright's render viewport with native content size; measured the anchor after keyboard focus instead of before Playwright's automatic click scrolling; mocked the synthetic workspace opener lookup as well as history. One light-theme instance unexpectedly closed during navigation; the subsequent complete light/dark rerun passed. These setup failures were not treated as successful product checks.
- Evidence and repeatable local driver: `output/playwright/session-reader/session-reader-qa.md`, `.json`, `.mjs`, plus screenshots in that directory. The driver uses the existing local Playwright installation and an already-running Vite server; it owns isolated data/user directories and closes only its own Electron clients. The user's running development client, history and existing QA/design artifacts were preserved.
- Limits: 760px uses a temporary minimum-size override only in the isolated QA process; the product minimum remains unchanged. Render viewport synchronization validates responsive Electron layout, not the native manual-drag resize event chain. Remote UI used synthetic IPC responses, not a new TLS/LAN acceptance run. Windows/Linux, physical multi-device networking and screen-reader validation were not performed. No commit, PR, push or release.

final result: global session reader and reliable metadata grouping implemented; automated and isolated Electron acceptance passed

---

# Composer controls design QA

Source visual truth: `/var/folders/sn/js11_0t91mg_bf1m2fr_38780000gn/T/codex-clipboard-7154de39-e296-4f7a-961f-e1c7d24c9c18.png`; original six screenshots and subsequent user instructions override prior UI behavior.

Implementation: real `ComposerModelPicker` and `ContextUsageIndicator`, mounted with synthetic settings in an isolated Vite preview at http://127.0.0.1:1430/. Production settings and permissions are separately exercised by integration tests; this preview does not mutate real sessions.

- Desktop viewport: 900 × 500 CSS px, screenshot 900 × 500, device density 1.
- Narrow viewport: 375 × 500 CSS px, screenshot 375 × 500; `/tmp/agentkib-composer-model-narrow.png`.
- Source: 554 × 262 px screenshot, popup crop 512 × 194 px at inferred density 2.
- Focused normalized comparison: `/tmp/agentkib-composer-comparison.png`, implementation popup crop 256 × 105 scaled 2× beside the source popup.
- Full-view evidence: `/tmp/agentkib-composer-model-static-points.png`, `/tmp/agentkib-composer-model-fast.png`, `/tmp/agentkib-composer-model-ultra-fast.png`, `/tmp/agentkib-composer-model-list.png`.
- Context tooltip: `/tmp/agentkib-composer-context-hover.png`.
- Light mode: `/tmp/agentkib-composer-model-light.png`.

## Fidelity checks

Typography uses the existing application font and actual provider model names. Numeric context content uses actual reported values; fixture values are 173K / 475K. The model and effort labels retain accessible names and truncation on narrow windows. Layout retains the requested context → model → send order, upper popover, centered effort/model, Fast on the left, reset on the right, and discrete slider. The model menu scrolls within the available viewport. Colors use blue for ordinary effort and a blue-to-lilac spectrum at the final supported stop. Static particles stay visible with Fast off; Fast starts from rest with a 0.6s acceleration and then 200px/s cruise. Reduced-motion CSS disables animation. No bitmap assets are required: library icons and data visualization primitives implement these controls. Model/effort choices come from runtime metadata; the number of fixture options intentionally differs from the reference.

## Comparison history

1. Initial pass: [P2] the popover was too tall and light-mode effort text lacked contrast. Reduced model-row height and slider gap; light-mode title colors now use darker blue/purple. Post-fix evidence: light screenshot and normalized comparison.
2. Motion pass: [P2] repeating the one-way spectrum produced a hard seam. The Fast spectrum now uses a cyclic gradient with matching endpoints; post-fix evidence: Ultra Fast screenshot.
3. User follow-up: dots now remain visible when Fast is disabled; enabling Fast ramps up to a faster constant speed. Browser-computed animation values verified `composer-fast-launch, composer-fast-flow`, durations `0.6s, 0.5s`, delay `0s, 0.6s`. Disabled Fast verified animation `none` while particle background remains present.

## Interaction evidence

Real browser interaction covered two-level model selection, selected model checkmark, keyboard effort changes, Fast toggling, context keyboard-focus tooltip, light/dark switching, and narrow layout. Context is a focusable image rather than a clickable button, with no click dialog. The final clean reload produced no console errors; earlier temporary preview HMR root warnings were fixed in the isolated harness and are not production changes.

No remaining actionable P0/P1/P2 findings. Native API dispatch and identity/CAS boundaries remain covered by separate repository tests. No claim is made that fixture interaction calls a real model.

final result: passed


## Latest animation iteration (2026-11-06)

The user's latest requirement supersedes static particles: opening changes the trigger label to “Select reasoning effort”; normal mode has a slow shimmer and floating particles, Fast accelerates both continuously, and disabling it decelerates while preserving phase. The popover has entry/exit and height expansion animations. Final visual verification completed in the in-app browser at 900 × 500 CSS px. `/tmp/agentkib-composer-model-final.png` shows the latest irregular particle field and expanded trigger label; `/tmp/agentkib-composer-model-final-menu.png` shows the model-list expansion. Normal/Fast toggles were exercised while reading the rendered particle-layer transforms, confirming faster continuous movement without resetting the layer. Popup CSS transitions include height, opacity and transform; normal and Fast share the same particle DOM. The fixed seed generates 18 distinct positions, sizes, opacities and bob phases across the full track, repeated only after an entire track width, rather than a short 100px tile. Browser console check returned no new errors. Temporary viewport override was reset and the preview remains available.

A local Codex 0.163.0 process with an isolated temporary home and no provider credentials confirmed the actual Fast catalog ID `priority`, native tier clearing, and the difference between inherited top-level effort and explicit collaboration-mode effort replacement. No model turn or production session was invoked by that probe. Repository tests separately cover consecutive turn dispatch, default/Plan preservation, unsupported mode rejection and restart persistence.

No remaining actionable P0/P1/P2 findings.

final result: passed
