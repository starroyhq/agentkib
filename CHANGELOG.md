# Changelog

## 0.36.2

### Conversations and delegation

- Continue terminal Claude Code sessions in automatic approval mode when AgentKib can verify the mode. Large histories keep the same bounded takeover reads. ([#416](https://github.com/starroyhq/agentkib/pull/416), [#424](https://github.com/starroyhq/agentkib/pull/424))
- Managed Claude Code questions retain their option previews. DeepSeek Harness controls stay with the active connection. ([#429](https://github.com/starroyhq/agentkib/pull/429), [#420](https://github.com/starroyhq/agentkib/pull/420))
- Worker reports use cards and group related updates. Workers appear under their Project Agent in the sidebar, and an unchanged quota reset time produces a single alert. ([#408](https://github.com/starroyhq/agentkib/pull/408), [#411](https://github.com/starroyhq/agentkib/pull/411), [#426](https://github.com/starroyhq/agentkib/pull/426))
- Desktop and Web show paged questions in terminal-held sessions, make takeover easier to spot on approval cards, preview attachments in the composer, and improve the light theme, Markdown and conversation layout. ([#425](https://github.com/starroyhq/agentkib/pull/425), [#427](https://github.com/starroyhq/agentkib/pull/427), [#428](https://github.com/starroyhq/agentkib/pull/428), [#410](https://github.com/starroyhq/agentkib/pull/410), [#412](https://github.com/starroyhq/agentkib/pull/412))

### Privacy and reliability

- Existing local data remains usable after upgrading. New diagnostic exports and local storage use private file permissions where supported. ([#417](https://github.com/starroyhq/agentkib/pull/417), [#418](https://github.com/starroyhq/agentkib/pull/418))
- Protect the credentials used by managed Claude Code Project Agents. Revalidate accounts during pairing, end access on revocation, and scope remote Project Agent data and Live Activities to the granted workspaces. ([#413](https://github.com/starroyhq/agentkib/pull/413), [#415](https://github.com/starroyhq/agentkib/pull/415), [#419](https://github.com/starroyhq/agentkib/pull/419), [#421](https://github.com/starroyhq/agentkib/pull/421), [#422](https://github.com/starroyhq/agentkib/pull/422), [#423](https://github.com/starroyhq/agentkib/pull/423))
- Stabilize CI tests. ([#414](https://github.com/starroyhq/agentkib/pull/414))

See [earlier releases](https://github.com/starroyhq/agentkib/releases) for previous versions.
