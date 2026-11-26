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
   For a Store release, complete the
   [installed MSIX checks](#validate-an-installed-package) with the candidate.
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
7. The Partner Center account owner follows
   [the Store submission steps](#submit-through-partner-center) for a Store release.

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
- `agentkib-windows-store-x64`: unsigned Microsoft Store MSIX and
  checksum when [the Store identity is configured](#microsoft-store-windows-x64).
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

## Microsoft Store (Windows x64)

Microsoft Store signs the MSIX and delivers its updates. Direct-download
Windows installers use the GitHub Release updater. The x64 Store package is
available separately in the workflow artifacts for manual submission.

The Store manifest uses `uap10:RuntimeBehavior="win32App"` with
`uap10:TrustLevel="mediumIL"` and requires Windows 10 build `10.0.19041.0`
or later. This runtime behavior gives the desktop app package identity while
keeping ordinary Win32 file and registry access, including the native data
directories needed by the background service and external tools. Its only
restricted capability is `runFullTrust`. See the
[Application manifest reference](https://learn.microsoft.com/en-us/uwp/schemas/appxpackage/uapmanifestschema/element-f-application)
and the [MSIX runtime behavior guide](https://devblogs.microsoft.com/insidemsix/types-of-packaged-applications/).

Windows activates a separate backend entry in the installed package so the
backend can load its native libraries. External CLIs use normal Windows
child-process rules. The desktop connects through the existing authenticated
named pipe.

### Configure the Store identity

The Partner Center account owner opens **Apps and games**, selects the AgentKib
MSIX product, and opens **Product management → Product identity**. If a product
record is needed, create the MSIX product and reserve the AgentKib name first.
Copy the three manifest values verbatim into **GitHub repository Settings →
Secrets and variables → Actions → Variables**.

| Partner Center field | GitHub Actions variable |
| --- | --- |
| `Package/Identity/Name` | `WINDOWS_STORE_IDENTITY_NAME` |
| `Package/Identity/Publisher` (the complete value, including `CN=`) | `WINDOWS_STORE_PUBLISHER` |
| `Package/Properties/PublisherDisplayName` | `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME` |

Set all three together. With all three absent, candidate builds report that
the Store artifact was skipped and continue building the direct installers.
Stable tagged releases starting with 1.0.0 require the Store identity.
Partial configuration fails the workflow. See
[View product identity details](https://learn.microsoft.com/en-us/windows/apps/publish/view-app-identity-details).

### Validate an installed package

Download the x64 Store artifact from the candidate workflow and compare its
SHA-256 checksum. Use two successive versions with the same identity.
The upload uses a four-part package version with the final part set to zero,
which Microsoft Store reserves. See
[MSIX package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-package-requirements).

Pull request CI uses a test-only package identity and certificate on an
isolated Windows x64 runner. It launches pinned Claude Code and Codex CLIs
with `--version`, without signing in. For release acceptance, use the Store
identity and candidate artifacts.

On a disposable Windows x64 VM with a fresh test account, sign copies of both
packages with a development certificate whose subject exactly matches the
manifest publisher. Trust that certificate on the VM, then install version A
with `Add-AppxPackage`, confirm its identity and version with
`Get-AppxPackage -Name <identity>`, and launch AgentKib from Start as the
test user. Run the Windows App Certification Kit against the candidate. Keep
the original workflow MSIX for Partner Center. See
[MSIX signing and local testing](https://learn.microsoft.com/windows/msix/package/sign-msix-package-guide).

| Check | Expected evidence |
| --- | --- |
| File and registry virtualization | From outside the package, confirm that backend data in `%LOCALAPPDATA%\ai.agentkib` and app data in `%APPDATA%\ai.agentkib\electron` are visible and that the Windows named pipe accepts an authenticated runtime connection. Repeat with existing NSIS data and with a clean profile. Verify that test registry writes are visible in the normal user hive. |
| CLI and plugins | Use separately installed Claude Code and Codex to start short managed sessions from AgentKib. For any plugin installation supported on the tested Windows build, verify the plugin files are visible to the native agent from a normal terminal. |
| Upgrade, uninstall, reinstall | Create a test workspace and session with an attachment, and change an app setting in version A. Exit AgentKib, install version B over A, and confirm the data and host connection are present. Uninstall B normally, confirm the data is still visible outside the package, then reinstall B and verify the workspace, session, attachment, and setting. |
| Update channels | Verify that the Store build leaves app updates to Microsoft Store. On the separate direct-download install, check that the normal in-app GitHub Release updater still works. |

The Claude Code and DeepSeek Harness terminal bridges are macOS-only. Record
terminal bridge auto-installation as unavailable on Windows and verify the
existing platform restriction. See the
[Claude Code terminal connection guide](../agents/claude-code-terminal.md).

Record the Windows build, package versions, and results. The installed checks
require running the registered package under a Windows test user. See the
[Microsoft desktop package behavior guide](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes).

### Submit through Partner Center

1. The account owner verifies the installed-package checks and downloads
   the original unsigned MSIX from the tagged workflow's
   `agentkib-windows-store-x64` artifact. Verify its checksum.
2. Open the AgentKib MSIX product in Partner Center. Start a submission, upload
   the MSIX in **Packages**, and confirm validation. Complete pricing and
   availability, properties and privacy policy, age ratings, and the Store
   listing. In **Submission options**, explain why the full-trust desktop app
   starts a per-user backend, launches installed agent CLIs, and connects to
   the local named pipe. Address the restricted capability shown in that section.
   Follow the [MSIX submission guide](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/create-app-submission)
   and the [package upload instructions](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/upload-app-packages).
3. For a first Store-signed test, select **Private audience** with a known
   tester group. Submit for certification. Once available to the group,
   install from Microsoft Store and confirm the signed build opens, launches
   the agents, and connects to the local backend. For an existing listing, use
   a [package flight](https://learn.microsoft.com/en-us/windows/apps/publish/package-flights)
   to verify the Store-delivered update and retained data. See
   [visibility options](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/visibility-options)
   and the [certification process](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/app-certification-process).
4. Once the acceptance checks pass, the account owner submits the public
   release or changes the tested product's visibility as appropriate.
   Store updates use the same identity and a higher package version.
   See [Publish an MSIX update](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msix/publish-update-to-your-app-on-store).

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
and earlier remain unsigned historical packages. The direct-download Windows
EXE is unsigned, so Windows SmartScreen may display a warning. The Microsoft
Store signs the Windows x64 MSIX for distribution. The project ships separate
macOS binaries for Apple Silicon and Intel.

v0.3.1 is the first updater-capable release. Clients older than v0.3.1 require
one manual upgrade; later stable releases can be installed in-app on macOS,
direct-download Windows, and Linux AppImage. DEB and RPM installations check
for updates but continue through the GitHub Release page so their system
package state is not modified behind the package manager.

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
