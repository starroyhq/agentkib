# Changelog

## 0.36.3

### Conversations and delegation

- In supported conversations, scrolling to the bottom clears the unread dot once the latest result is visible. This also works for Claude Code terminal replies recorded by older bridge plugins.
- Claude Code terminal conversations show the final reply and clear the running indicator sooner in the conversation view. Renaming a session from the terminal updates the sidebar and conversation title.
- Use an eligible Codex desktop app conversation as a Project Agent after the app releases its write lock. Assign managed Claude Code conversations and connected Claude Code terminals that support sending as Workers.
- The Project Agent can set Worker responsibilities through its tools. Conversation records now retain details about sent attachments. Worker role controls and the improved display of sent attachments are planned for a later release.

### Interface and reliability

- The model button shows recognizable Claude Code model names. Supported question cards show option previews and accept answer notes when the connected host supports them.
- Simplify conversation tooltips and permission controls. Fix attachment focus and the extra scrollbar in paired Web.
- Fix incorrect Devin and Antigravity history availability notices after restart.
- Preserve confirmed stop, approval and answer outcomes when a follow-up refresh fails.

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
