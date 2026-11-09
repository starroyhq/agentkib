# AgentKib Beta acceptance guide

This guide is for maintainers and testers validating a release candidate. AgentKib does not automatically collect telemetry, upload diagnostics, or send workspace and conversation content. Feedback is submitted deliberately through [GitHub Issues](https://github.com/starroyhq/agentkib/issues).

## Before tagging: candidate checks

Run the artifact-only desktop workflow against the release commit and use its
packages for the checks in this section. These candidate artifacts validate the
application behavior and packaging shape, but they are not the final release
artifacts: macOS candidates are unsigned, and release notarization is not
performed until the tagged release run.

### Five-minute core path

Use a disposable or backed-up workspace. Do not use production secrets for the first pass.

- [ ] Install AgentKib and confirm that it opens without bypass commands or elevated privileges.
- [ ] Add an authorized scan directory and confirm that at least one expected workspace appears.
- [ ] Open that workspace, run Context Doctor, and review its evidence paths and severity counts.
- [ ] If repairable issues exist, generate a ChangeSet, inspect every diff, and apply it. If no repairable issue exists, record the workspace as healthy.
- [ ] Return to Context Doctor and confirm that AgentKib automatically reruns the diagnosis and reports the remaining repairable count.

Applying a ChangeSet is optional. A tester may reject it or close the getting-started guide without changing project files.

### Candidate platform checks

- [ ] Confirm every expected platform artifact is present and its SHA-256 file verifies successfully.
- [ ] Confirm the package launches on representative test systems, accounting for the unsigned macOS candidate limitation.
- [ ] Complete the five-minute core path on at least one supported platform.

## After publishing: release-asset checks

Create the immutable version tag only after the candidate checks pass. The
tagged workflow builds a different set of release artifacts with Electron
updater metadata and signed/notarized macOS packages. Complete every check below
against the assets attached to the published GitHub Release, not against the
artifact-only candidate run.

### Platform installation checks

### macOS

- [ ] Test the matching Apple Silicon or Intel DMG.
- [ ] Confirm Gatekeeper opens the app normally. Releases from v0.3.2 onward must be Developer ID signed and Apple notarized.
- [ ] Confirm the installed app reports the expected version in Settings → General.

### Windows

- [ ] Test the x64 installer; treat ARM64 packages as Preview.
- [ ] Record any SmartScreen prompt. Windows installers are not yet Authenticode signed.
- [ ] Confirm uninstall and reinstall do not silently delete AgentKib's local data.

### Linux

- [ ] Test the x64 AppImage and the package appropriate for the distribution; ARM64 packages are Preview.
- [ ] Confirm executable permissions and desktop integration for the AppImage.
- [ ] Confirm DEB/RPM upgrades remain under the system package manager rather than the in-app installer.

### Update checks

- [ ] Start from the latest supported stable version and use Settings → General → Check for updates.
- [ ] Confirm the displayed version and release notes match the target GitHub Release.
- [ ] For macOS, Windows, and Linux AppImage, complete download, updater checksum verification, installation, and restart.
- [ ] For DEB/RPM, confirm AgentKib opens the matching Release page instead of replacing the system package.
- [ ] After restart, confirm workspaces, preferences, local indexes, and the getting-started acknowledgement remain intact.

### Rollback checks

The updater does not perform downgrades. To test rollback:

1. Back up the AgentKib data directory shown in Settings before changing versions.
2. Close AgentKib and install the previous package from its immutable GitHub Release.
3. Open the previous version and confirm it can read the existing workspaces and preferences.
4. If a regression affects local indexes, preserve the backup and report the exact upgrade and rollback versions rather than deleting evidence.

Never move or overwrite a published tag. Release defects use a new patch version, such as `v0.4.1`.

## Reporting feedback safely

Use the repository's Bug report or Feature request form. Include the AgentKib version, operating system and architecture, related Agent, and minimal reproduction steps.

Before submitting:

- Replace user names, workspace names, and absolute paths with neutral placeholders.
- Remove API keys, tokens, Authorization or Cookie values, environment secrets, and private repository URLs.
- Do not attach complete Codex or Claude Code transcripts.
- Crop screenshots to the relevant UI and inspect visible terminal, path, and notification content.
- Prefer a small disposable reproduction over uploading real project configuration.

AgentKib does not upload this information on your behalf. The tester controls exactly what is shared in GitHub Issues.
