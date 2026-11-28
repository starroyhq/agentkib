# Changelog

## 0.36.5

### Conversation interface

- Sent messages show image thumbnails that open a full preview, and file cards with names and sizes. Attachment-only messages have no empty text bubble.
- Remove the permission-mode notice above the composer. The toolbar still shows the current permission mode.
- Keep long titles, paths, and URLs inside desktop and Web dialogs. Long Worker candidate titles leave room for icons, status labels, and controls.
- Move connection status next to the session title, simplify message bubbles and composer controls, and fold extra questions in Worker reports.

### Sessions and notifications

- Assign Claude Code sessions that AgentKib has taken over as Workers. The model menu shows “Choose model in terminal” only while the terminal is connected.
- Project Agents can change an idle Worker’s model, reasoning effort, and speed where supported. Changes apply to the next turn.
- Allow new authorized work to restart an iPhone Live Activity after the previous one is lost. A dismissed activity stays quiet when the same turn temporarily disappears from the directory and returns. Diagnostic exports include push delivery results and fixed failure codes.
- Confirm an accepted Codex stop request from the targeted turn's native interruption record.
- Keep already displayed history and a healthy live connection when another history read fails. Retain the specific read failure reason and retry a stale history page once.

### Desktop

- Improve Settings navigation and make session titles and running durations easier to read in the menu bar.
- The first-use page shows recent local conversations with a Resume button so you can pick up where you left off.

### Release tooling

- A manually triggered desktop release build can force a fresh build of the quota collectors from the selected revision with `force_rebuild_collectors`. Verified artifacts are still reused by default.

## 0.36.4

### Security

- Restore workspace scope checks for legacy restricted pairings. Affected devices could read conversation lists and histories outside their authorized workspaces. If you still use a legacy pairing, update to 0.36.4.

### Session reliability

- The backend retains specific failure reasons for stop, approval, answer, queue, attachment, and remote-read operations. Short explanations in the interface will follow in a later release.
- Confirmed managed Claude Code actions keep their receipts when a later status read fails, so they no longer appear as unexecuted.
- After a terminal Claude Code session is assigned as a Project Agent, terminal plugin 0.5.14 reports whether its tools are ready.
- You can add a note to questions with option previews in the desktop app. In 0.36.3, the note field was available only in paired Web.

## 0.36.3

### Conversations and delegation

- Open a conversation in AgentKib and scroll to the bottom to clear its unread dot. This includes Claude Code sessions connected through the terminal plugin. Previously unread conversations need to be opened and read to the bottom once.
- Claude Code terminal conversations show the final reply and clear the running indicator sooner in the conversation view. Renaming a session from the terminal updates the sidebar and conversation title.
- Use an eligible Codex desktop app conversation as a Project Agent after the app releases its write lock. Assign managed Claude Code conversations and connected Claude Code terminals that support sending as Workers.
- The Project Agent can set Worker responsibilities through its tools. Conversation records now retain details about sent attachments. Worker role controls and the improved display of sent attachments are planned for a later release.

### Interface and reliability

- The model button shows recognizable Claude Code model names. Supported question cards show option previews and accept answer notes when the connected host supports them.
- Simplify conversation tooltips and permission controls. Fix attachment focus and the extra scrollbar in paired Web.
- Fix incorrect Devin and Antigravity history availability notices after restart.

### Known limitations

- Read detection can still be incorrect for some older Devin conversation records. A fix is planned for the next release.
- The backend supports manually marking a conversation as read or unread. The menu actions are planned for the next release.

## 0.36.2

### Conversations and delegation

- Continue terminal Claude Code sessions in automatic approval mode when AgentKib can verify the mode. Large histories keep the same bounded takeover reads. ([#416](https://github.com/starroyhq/agentkib/pull/416), [#424](https://github.com/starroyhq/agentkib/pull/424))
- Managed Claude Code questions retain their option previews. DeepSeek Harness controls stay with the active connection. ([#429](https://github.com/starroyhq/agentkib/pull/429), [#420](https://github.com/starroyhq/agentkib/pull/420))
- After an upgrade, eligible long-running Codex Worker turns resume and then process their queued messages in order. Checkpoints from older versions that omitted the history can also resume. ([#434](https://github.com/starroyhq/agentkib/pull/434))
- Reject an individual managed Claude Code question with unsupported fields so its turn can continue. The paired API exposes `answerNotesVersion`. ([#431](https://github.com/starroyhq/agentkib/pull/431))
- Return six specific refusal reasons to clients when a Claude Code terminal takeover is declined. ([#433](https://github.com/starroyhq/agentkib/pull/433))
- Worker reports use cards and group related updates. Workers appear under their Project Agent in the sidebar, and an unchanged quota reset time produces a single alert. ([#408](https://github.com/starroyhq/agentkib/pull/408), [#411](https://github.com/starroyhq/agentkib/pull/411), [#426](https://github.com/starroyhq/agentkib/pull/426))
- Desktop and Web show paged questions in terminal-held sessions, make takeover easier to spot on approval cards, preview attachments in the composer, and improve the light theme, Markdown and conversation layout. ([#425](https://github.com/starroyhq/agentkib/pull/425), [#427](https://github.com/starroyhq/agentkib/pull/427), [#428](https://github.com/starroyhq/agentkib/pull/428), [#410](https://github.com/starroyhq/agentkib/pull/410), [#412](https://github.com/starroyhq/agentkib/pull/412))

### Privacy and reliability

- Update `body-parser` to 2.4.0 for a security fix. ([#430](https://github.com/starroyhq/agentkib/pull/430), [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828))
- Existing local data remains usable after upgrading. New diagnostic exports and local storage use private file permissions where supported. ([#417](https://github.com/starroyhq/agentkib/pull/417), [#418](https://github.com/starroyhq/agentkib/pull/418))
- Protect the credentials used by managed Claude Code Project Agents. Revalidate accounts during pairing, end access on revocation, and scope remote Project Agent data and Live Activities to the granted workspaces. ([#413](https://github.com/starroyhq/agentkib/pull/413), [#415](https://github.com/starroyhq/agentkib/pull/415), [#419](https://github.com/starroyhq/agentkib/pull/419), [#421](https://github.com/starroyhq/agentkib/pull/421), [#422](https://github.com/starroyhq/agentkib/pull/422), [#423](https://github.com/starroyhq/agentkib/pull/423))
- Stabilize CI tests. ([#414](https://github.com/starroyhq/agentkib/pull/414))

See [earlier releases](https://github.com/starroyhq/agentkib/releases) for previous versions.
