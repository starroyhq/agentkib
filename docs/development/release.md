# Desktop release workflow

AgentKib desktop releases are built, verified, and published by the
`Desktop Package Artifacts` GitHub Actions workflow. Pull requests and normal
branch pushes run platform checks but do not publish installers.

## Publish a release

1. Update the desktop version in `apps/desktop/package.json`.
2. Merge the version change into `main` and make sure the required checks pass.
3. Run the workflow manually without `release_tag`, then complete the
   pre-release parts of the [Beta acceptance guide](beta-checklist.md) against the
   candidate artifacts. Artifact-only runs intentionally produce unsigned
   macOS previews and omit signing/notarization; they cannot
   validate Gatekeeper, notarization, or the end-to-end updater path.
4. Create an annotated version tag on that `main` commit and push only the tag:

   ```bash
   git switch main
   git pull --ff-only origin main
   git tag -a v0.1.0 -m "AgentKib v0.1.0"
   git push origin v0.1.0
   ```

5. Wait for every job in **Desktop Package Artifacts** to pass. The workflow
   creates a draft GitHub Release only after all platform builds complete. It
   verifies the complete asset manifest, SHA-256 checksums, and Electron updater
   metadata, uploads the files, checks their remote names and sizes,
   and then publishes the release.

   Every platform also launches the packaged or installed app with isolated
   application data. The startup probe requires a successful exit after the
   backend handshake, window display, and home-data readiness marks. An error
   window or a process that merely stays alive does not pass. macOS x64 uses
   the native `macos-15-intel` runner, while macOS arm64 uses the Apple Silicon
   runner. Both jobs verify the host architecture before packaging. The
   macOS smoke uses `--use-mock-keychain` only for its empty synthetic profile
   to avoid native login-keychain authorization dialogs; it does not validate
   account login or real secure storage. Production launch options are unchanged.

6. Complete the release-only signing, notarization, installation, and updater
   checks in the [Beta acceptance guide](beta-checklist.md) against the published,
   immutable Release assets. If a defect is found, publish a new patch version;
   do not move or replace the tag.

Do not create an empty GitHub Release before pushing the tag. Stable SemVer
tags such as `v0.1.0` become the latest release. Tags containing a prerelease
suffix, such as `v0.2.0-beta.1`, are published as prereleases.

The workflow refuses to publish when the tag does not exactly match the
desktop version or the tagged commit is not contained in `origin/main`. Every
build job checks out the same resolved commit.

## Retry a failed release

If a run fails because of a transient runner, network, repository setting, or
workflow problem after creating the draft, fix the underlying problem without
publishing the incomplete draft, then run the workflow against the existing
tag:

```bash
gh workflow run release-desktop.yml --ref main -f release_tag=vX.Y.Z
```

The retry rebuilds every platform, resumes an existing draft, and replaces
same-named draft assets. GitHub's release-by-tag API can omit draft releases,
so draft lookup falls back to the authenticated, paginated Releases list and
uses a bounded retry window. Manual retries build the immutable tagged source
but use the reviewed release helpers from the selected workflow revision. The
workflow refuses duplicate tags and will not overwrite a release that is
already public. A product-code fix requires a new version and tag rather than
moving an existing tag. Workflow artifacts remain available for diagnosing
failed builds.

Release-helper tests run in a separate, read-only job on every run, including
artifact-only builds. They use the complete selected workflow checkout and its
frozen dependencies, installed without lifecycle scripts; they do not use the
immutable product tag's checkout or the publisher's sparse script checkout.
Both platform builds and publication require this full helper suite to pass.
This also validates newer helpers when retrying an older tag, without granting
dependency installation or tests the publisher's write token.

### Windows uninstall failures

The installer smoke copies the NSIS uninstaller into a private temporary
directory outside the installation, then runs that copy with `/S` and a final,
unquoted `_?=<installation path>` argument. This follows the
[NSIS exit-code contract](https://nsis.sourceforge.io/Docs/AppendixD.html):
the original self-copying launcher's exit code does not report the real
uninstall result. Preparation, execution and the executable-removal check share
the existing two-minute budget, measured with a monotonic clock. Diagnostic
snapshots run outside that supervised operation; failures terminate the owned
uninstaller before collecting read-only diagnostics. A nonzero real exit, a residual `AgentKib.exe`, or missing
user data still fails the smoke.

The tracked NSIS include preserves electron-builder's atomic upgrade and
rollback behavior, including its in-place uninstaller fallback. Ordinary
uninstall checks actual installation-directory removal and retries failed
removal for at most five seconds, within the smoke budget. Persistent failure
aborts with exit code 2 before uninstall registration is removed. Before deletion,
it backs up the registered uninstaller and restores a removed copy on failure
so the retained entry remains usable. Backup failure aborts before deletion.
Directory enumeration failures, including access denial, cannot count as proof
of removal. It does not defer deletion to a reboot or remove application data.

On failure, the diagnostics artifact includes the real process result, failure
stage, file attributes, a read-only DELETE-access probe's Win32 error code, and
Restart Manager owners of that one executable. The probe does not delete,
change attributes, terminate owners, or collect command lines or credentials.
A failed collection is explicitly marked incomplete; an empty owner list
does not prove that another process never held the file earlier.

Windows platform checks run the PowerShell control and diagnostic regressions,
then require the native NSIS policy suite on both architectures using the same
checksum-pinned compiler. Its fixtures use PowerShell 7, matching the Actions
shell, so inherited module paths cannot load incompatible Windows PowerShell
5.1 security modules. See Microsoft's
[PSModulePath inheritance documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath).
After packaging, both Windows release jobs require native NSIS tests for
temporary/persistent file locks and atomic upgrade rollback; these tests cannot
silently skip for a missing compiler. The sole legacy exception is an explicitly
requested, preflight-verified immutable stable tag at or before v0.20.1 whose
source predates the tracked hook. That retry skips only the unavailable product
policy tests; the real installer smoke and uninstall/user-data assertions still
run. A missing hook in branch builds or newer tags remains a failure. See the
[v0.20.1 failure investigation](../../qa/windows-uninstall-2026-10-21.md) for the
original evidence and Windows CI verification.

## Build artifacts without publishing

To create packages for a branch without creating a GitHub Release, open
**Actions**, select **Desktop Package Artifacts**, choose **Run workflow**, pick
the branch, and leave `release_tag` empty.

These packages are intended for pre-release functional checks only. macOS
artifacts from this path are unsigned previews, and the workflow does not
perform release signing or notarization. Release signing, notarization, and
end-to-end update checks must use the assets produced by the tagged release
run.

The run produces these downloadable workflow artifacts:

- `agentkib-desktop-macos-arm64`: DMG, ZIP, updater metadata, and checksums.
- `agentkib-desktop-macos-x64`: DMG, ZIP, updater metadata, and checksums.
- `agentkib-desktop-windows-x64`: NSIS installer and checksum.
- `agentkib-desktop-windows-arm64-preview`: preview NSIS installer and checksum.
- `agentkib-desktop-linux-ubuntu-x64`: Deb, AppImage, and checksums.
- `agentkib-desktop-linux-ubuntu-arm64-preview`: preview Deb, AppImage, and checksums.
- `agentkib-desktop-linux-fedora-x64`: RPM and checksum.

Each checksum file is named after its package with the `.sha256` suffix. Verify
a downloaded package before installing it, for example:

```bash
shasum -a 256 -c AgentKib_0.1.0_macos-arm64.dmg.sha256
```

On Linux, use `sha256sum -c`. On Windows, compare the value in the checksum
file with `Get-FileHash <installer> -Algorithm SHA256`.

## Electron updater metadata

Electron releases publish `latest-mac.yml`, `latest.yml`,
`latest-linux.yml`, and `latest-linux-arm64.yml` together with the installer
files and their blockmaps. The metadata contains SHA-512 checksums used by
`electron-updater`; the workflow also publishes SHA-256 files for manual
verification.

## macOS signing and notarization

Published tags also require these GitHub Actions Secrets:

- `APPLE_CERTIFICATE`: base64-encoded Developer ID Application `.p12` file.
- `APPLE_CERTIFICATE_PASSWORD`: password used when exporting the `.p12` file.
- `APPLE_SIGNING_IDENTITY`: full Developer ID Application identity.
- `APPLE_TEAM_ID`: Apple Developer team ID.
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, and `APPLE_API_PRIVATE_KEY`: App Store
  Connect team API credentials used only for notarization.

The macOS jobs write the API private key to an owner-only temporary file, pass
its path to electron-builder, and remove it after the build. electron-builder
signs the application, submits it to Apple, waits for approval, and staples the
notarization ticket.
The workflow then verifies the Developer ID authority, team identifier,
stapled ticket, and Gatekeeper assessment before staging release assets. A
missing credential or failed verification prevents the Release from being
published.

The `.p12`, its password, and the App Store Connect `.p8` key must be backed up
outside GitHub and shared only with authorized release maintainers. Rotate or
revoke credentials deliberately; revoking them immediately blocks new macOS
releases, but does not invalidate packages that were already signed and
notarized.

## Preview limitations

Releases newer than v0.3.1 include signed and notarized macOS packages. v0.3.1
and earlier remain unsigned historical packages. Windows packages are still
not Authenticode-signed, and the project does not yet provide MSI packages or a
macOS universal binary. Windows SmartScreen may therefore display warnings.

v0.3.1 is the first updater-capable release. Clients older than v0.3.1 require
one manual upgrade; later stable releases can be installed in-app on macOS,
Windows, and Linux AppImage. DEB and RPM installations check for updates but
continue through the GitHub Release page so their system package state is not
modified behind the package manager.

For v0.3.1 and earlier only, after verifying the downloaded DMG against its
`.sha256` file and copying AgentKib into Applications, macOS users must remove
the quarantine attributes before opening the app:

```bash
xattr -cr /Applications/AgentKib.app
```

This command bypasses Gatekeeper's quarantine check. It must only be used for
an AgentKib package downloaded from the official GitHub Release whose checksum
has been verified.

ARM64 Windows and Linux packages remain preview-only until they have been
verified on representative hardware.
