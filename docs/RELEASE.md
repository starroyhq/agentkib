# Desktop release workflow

AgentKib desktop releases are built, verified, and published by the
`Desktop Package Artifacts` GitHub Actions workflow. Pull requests and normal
branch pushes run platform checks but do not publish installers.

## Publish a release

1. Update the desktop version in `apps/desktop/package.json`.
2. Merge the version change into `main` and make sure the required checks pass.
3. Run the workflow manually without `release_tag`, then complete the
   pre-release parts of the [Beta acceptance guide](BETA.md) against the
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
6. Complete the release-only signing, notarization, installation, and updater
   checks in the [Beta acceptance guide](BETA.md) against the published,
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
