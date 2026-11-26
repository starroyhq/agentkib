import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.68.0";
// Pinned from the upstream v0.68.0 frp_sha256_checksums.txt. Updating the
// connector requires review of both this manifest and the relay protocol tests.
export const ARCHIVES = {
  darwin_amd64: "0ef747a7c31ef5c8bc70494bf2a9ec5a1c69d73bff684b4e8b2947c0d1e4f887",
  darwin_arm64: "9f344774971dfb9ae90ee1f633de68d1755c98510227a67289ec78081fc5c8fa",
  linux_amd64: "3cf934477f4fb1ee9e19e49c31fb33f5ffe3283300076f59afad8b8ccf1e1621",
  linux_arm64: "8855bd3537adf6f456b4073a1fb6f119885060f3c8b714fd56a842db42b4c097",
  windows_amd64: "959f13d0d5f17040c3e79c3d9885dc0f43e5503619ea81b123babc3daf4dbeb6",
  windows_arm64: "cecce25382188a3d0db237d616c2da1ad044db1cab462fc87c824e938cd492c9",
};
export function archiveFor(platform, arch) {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "amd64" : arch;
  const hash = ARCHIVES[`${os}_${cpu}`];
  if (!hash) throw new Error(`Unsupported frpc target: ${platform}/${arch}`);
  const stem = `frp_${VERSION}_${os}_${cpu}`;
  return { stem, filename: `${stem}.${os === "windows" ? "zip" : "tar.gz"}`, hash };
}
export function verifyArchive(bytes, expected) {
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("frpc archive checksum mismatch; refusing to stage executable");
}
async function stage() {
  const platform = process.env.AGENTKIB_PACKAGE_PLATFORM || process.platform;
  const arch = process.env.AGENTKIB_PACKAGE_ARCH || process.arch;
  const archive = archiveFor(platform, arch);
  const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const build = path.join(desktop, "build");
  const cache = path.join(build, "frpc-cache");
  const destination = path.join(build, "frpc");
  await mkdir(cache, { recursive: true });
  const cached = path.join(cache, archive.filename);
  let bytes;
  try { bytes = await readFile(cached); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const response = await fetch(`https://github.com/fatedier/frp/releases/download/v${VERSION}/${archive.filename}`, {
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok) throw new Error(`frpc download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    verifyArchive(bytes, archive.hash);
    await writeFile(`${cached}.tmp`, bytes);
    await rename(`${cached}.tmp`, cached);
  }
  verifyArchive(bytes, archive.hash);
  const temporary = await mkdtemp(path.join(build, "frpc-stage-"));
  const executable = platform === "win32" ? "frpc.exe" : "frpc";
  try {
    // The verified upstream archive is extracted into an isolated build directory.
    if (platform === "win32" && process.platform === "win32") {
      // Git Bash may put GNU tar ahead of Windows bsdtar; GNU tar cannot read ZIP.
      // Use the installed .NET ZIP API so Windows PowerShell does not load a PowerShell 7 archive module.
      // Environment arguments keep paths out of PowerShell source code.
      execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory($env:AGENTKIB_FRPC_ARCHIVE, $env:AGENTKIB_FRPC_EXTRACT)"], {
        env: { ...process.env, AGENTKIB_FRPC_ARCHIVE: cached, AGENTKIB_FRPC_EXTRACT: temporary },
      });
    } else if (platform === "win32") {
      execFileSync("unzip", ["-q", cached, `${archive.stem}/${executable}`, `${archive.stem}/LICENSE`, "-d", temporary]);
    } else {
      execFileSync("tar", ["-xf", cached, "-C", temporary, `${archive.stem}/${executable}`, `${archive.stem}/LICENSE`]);
    }
    await mkdir(destination, { recursive: true });
    await copyFile(path.join(temporary, archive.stem, executable), path.join(destination, executable));
    if (platform !== "win32") await chmod(path.join(destination, executable), 0o755);
    await mkdir(path.join(destination, "licenses"), { recursive: true });
    await copyFile(path.join(temporary, archive.stem, "LICENSE"), path.join(destination, "licenses/frp-LICENSE"));
    await writeFile(path.join(destination, "frpc-manifest.json"), JSON.stringify({ version: VERSION, platform, arch, archiveSha256: archive.hash }, null, 2));
    process.stdout.write(`Staged checksum-verified frpc ${VERSION} for ${platform}/${arch}\n`);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  stage().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
