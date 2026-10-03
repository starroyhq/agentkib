import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { get } from "node:https";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const releases = {
  "aarch64-apple-darwin": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-macos-arm64.tar.gz",
    sha256: "bdc7469cb37db9354a51b0404e30ba00f12dd548dcdca10e50b283e7af1d370c",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-macos-arm64.tar.gz",
    format: "tar",
  },
  "x86_64-apple-darwin": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-macos-x86_64.tar.gz",
    sha256: "d5006a70e131010cc6ec997633e8e897f106a645dbef363201f15675262ebca4",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-macos-x86_64.tar.gz",
    format: "tar",
  },
  "aarch64-unknown-linux-gnu": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-linux-musl-aarch64.tar.gz",
    sha256: "6486f199d3f176c5d6f981840bf2a97b6d2744e259ec49e37f8f3d1b6b5eac14",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-linux-musl-aarch64.tar.gz",
    format: "linux-tar",
  },
  "x86_64-unknown-linux-gnu": {
    version: "0.49.5",
    asset: "CodexBarCLI-v0.49.5-linux-musl-x86_64.tar.gz",
    sha256: "87153677de7193dd4d0e1907d9a8412cfc70472ec4d331c83564202237ec7af8",
    url: "https://github.com/steipete/CodexBar/releases/download/v0.49.5/CodexBarCLI-v0.49.5-linux-musl-x86_64.tar.gz",
    format: "linux-tar",
  },
  "x86_64-pc-windows-msvc": {
    version: "0.60.3",
    asset: "CodexBarCLI-v0.60.3-windows-x64.zip",
    sha256: "2f61a448e340de2b87d2a5ca3d155da5fb3bddeac890c4896ba0bdd49325f020",
    url: "https://github.com/nesszer/Win-CodexBar/releases/download/v0.60.3/CodexBarCLI-v0.60.3-windows-x64.zip",
    format: "zip",
  },
};

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, "..");
const quotaResourcesDirectory = join(desktopDirectory, "resources/quota/resources");
const quotaBinariesDirectory = join(desktopDirectory, "resources/quota/binaries");
const target =
  process.env.AGENTKIB_QUOTA_TARGET ?? hostQuotaTarget();
const release = releases[target];

if (!release) {
  if (target.endsWith("-windows-msvc")) {
    await rm(join(quotaResourcesDirectory, "windows/agentkib-quota-sidecar.exe"), {
      force: true,
    });
  }
  process.stdout.write(`AgentKib quota sidecar: ${target} is reserved but not bundled yet.\n`);
  process.exit(0);
}

const cacheRoot = process.env.XDG_CACHE_HOME
  ? resolve(process.env.XDG_CACHE_HOME, "agentkib/codexbar", release.version)
  : process.env.LOCALAPPDATA
    ? resolve(process.env.LOCALAPPDATA, "AgentKibBuild/cache/quota", release.version)
    : join(homedir(), ".cache/agentkib/codexbar", release.version);
const archive = join(cacheRoot, release.asset);
await mkdir(cacheRoot, { recursive: true });

if (!(await hasExpectedHash(archive, release.sha256))) {
  await rm(archive, { force: true });
  const temporary = `${archive}.download`;
  await rm(temporary, { force: true });
  await download(release.url, temporary);
  if (!(await hasExpectedHash(temporary, release.sha256))) {
    await rm(temporary, { force: true });
    throw new Error(`Quota collector ${release.version} checksum mismatch`);
  }
  await rename(temporary, archive);
}

const extracted = await mkdtemp(join(tmpdir(), "agentkib-codexbar-"));
try {
  if (release.format === "tar" || release.format === "linux-tar") {
    const result = spawnSync("tar", ["-xzf", archive, "-C", extracted], { stdio: "inherit" });
    if (result.status !== 0) throw new Error("Failed to extract CodexBarCLI archive");

    const binaryDirectory = quotaBinariesDirectory;
    const binary = join(binaryDirectory, `agentkib-quota-sidecar-${target}`);
    await mkdir(binaryDirectory, { recursive: true });
    if (release.format === "linux-tar") {
      const resourcesDirectory = join(quotaResourcesDirectory, "linux");
      const resourceBundle = join(resourcesDirectory, "CodexBar_CodexBarCore.bundle");
      const collector = join(resourcesDirectory, "CodexBarCLI");
      await mkdir(resourcesDirectory, { recursive: true });
      await copyFile(join(extracted, "CodexBarCLI"), collector);
      const strip = spawnSync("strip", ["--strip-unneeded", collector], { stdio: "inherit" });
      if (strip.status !== 0) throw new Error("Failed to strip CodexBarCLI debug symbols");
      await chmod(collector, 0o755);
      await rm(resourceBundle, { recursive: true, force: true });
      await cp(join(extracted, "CodexBar_CodexBarCore.bundle"), resourceBundle, {
        recursive: true,
      });
      // The source-controlled shell launcher locates the packaged CLI and its
      // adjacent Swift resource bundle.
      await access(binary);
      await chmod(binary, 0o755);
    } else {
      await copyFile(join(extracted, "CodexBarCLI"), binary);
      await chmod(binary, 0o755);

      const resourcesDirectory = quotaResourcesDirectory;
      const resourceBundle = join(resourcesDirectory, "CodexBar_CodexBarCore.bundle");
      await mkdir(resourcesDirectory, { recursive: true });
      await rm(resourceBundle, { recursive: true, force: true });
      await cp(join(extracted, "CodexBar_CodexBarCore.bundle"), resourceBundle, {
        recursive: true,
      });
    }
  } else if (release.format === "zip") {
    const unpack =
      process.platform === "win32"
        ? spawnSync(
            "powershell.exe",
            [
              "-NoLogo",
              "-NoProfile",
              "-NonInteractive",
              "-Command",
              "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:AGENTKIB_QUOTA_ARCHIVE, $env:AGENTKIB_QUOTA_DESTINATION)",
            ],
            {
              env: {
                ...process.env,
                AGENTKIB_QUOTA_ARCHIVE: archive,
                AGENTKIB_QUOTA_DESTINATION: extracted,
              },
              stdio: "inherit",
            },
          )
        : spawnSync("unzip", ["-q", archive, "-d", extracted], { stdio: "inherit" });
    if (unpack.status !== 0) throw new Error("Failed to extract the Win-CodexBar CLI archive");

    const source = join(extracted, "codexbar-cli.exe");
    await access(source);
    const resourceDirectory = join(quotaResourcesDirectory, "windows");
    await mkdir(resourceDirectory, { recursive: true });
    await copyFile(source, join(resourceDirectory, "agentkib-quota-sidecar.exe"));
  } else {
    throw new Error(`Unsupported quota archive format: ${release.format}`);
  }
  process.stdout.write(
    `AgentKib quota sidecar: prepared collector ${release.version} for ${target}.\n`,
  );
} finally {
  await rm(extracted, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

function hostQuotaTarget() {
  const arch = { arm64: "aarch64", x64: "x86_64" }[process.arch];
  const platform = {
    darwin: "apple-darwin",
    linux: "unknown-linux-gnu",
    win32: "pc-windows-msvc",
  }[process.platform];
  if (!arch || !platform) {
    throw new Error(`Unsupported quota host: ${process.platform}/${process.arch}`);
  }
  return `${arch}-${platform}`;
}

async function hasExpectedHash(path, expected, algorithm = "sha256") {
  try {
    const digest = createHash(algorithm)
      .update(await readFile(path))
      .digest("hex");
    return digest === expected;
  } catch {
    return false;
  }
}

async function download(url, destination, redirects = 0) {
  if (redirects > 8) throw new Error("Too many redirects while downloading CodexBarCLI");
  await new Promise((resolveDownload, reject) => {
    const request = get(url, { headers: { "User-Agent": "AgentKib-build" } }, (response) => {
      if (
        response.statusCode &&
        response.statusCode >= 300 &&
        response.statusCode < 400 &&
        response.headers.location
      ) {
        response.resume();
        download(
          new URL(response.headers.location, url).toString(),
          destination,
          redirects + 1,
        ).then(resolveDownload, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}`));
        return;
      }
      const output = createWriteStream(destination, { mode: 0o600 });
      response.pipe(output);
      output.on("finish", () => output.close(resolveDownload));
      output.on("error", reject);
    });
    request.on("error", reject);
  });
  await access(destination);
}
