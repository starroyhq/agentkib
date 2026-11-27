import { BrowserWindow, dialog } from "electron";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isReparseOrSymlinkAsync, moveNoReplace } from "@agentkib/backend/native-files";
import { restrictRemotePath } from "@agentkib/backend/remote-tls";
import { readRuntimeDiagnostics } from "../runtime-diagnostics-report";
import type { IpcRegistrar } from "./registrar";

const execFileAsync = promisify(execFile);

function sameEntry(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function inspectDirectory(directory: string, expected?: BigIntStats) {
  const entry = await lstat(directory, { bigint: true });
  if (
    !entry.isDirectory() ||
    (expected && !sameEntry(entry, expected)) ||
    (await isReparseOrSymlinkAsync(directory, entry))
  )
    throw new Error("invalid-diagnostics-directory");
  return entry;
}

async function inspectDestination(file: string) {
  let entry: BigIntStats;
  try {
    entry = await lstat(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (
    !entry.isFile() ||
    entry.nlink !== 1n ||
    (process.getuid && entry.uid !== BigInt(process.getuid())) ||
    (await isReparseOrSymlinkAsync(file, entry))
  )
    throw new Error("invalid-diagnostics-destination");
  return entry;
}

async function saveDiagnostics(filePath: string, dataDir: string): Promise<void> {
  const selectedDirectory = path.dirname(filePath);
  const directoryEntry = await inspectDirectory(selectedDirectory);
  const directory = await realpath(selectedDirectory);
  await inspectDirectory(directory, directoryEntry);
  const target = path.join(directory, path.basename(filePath));
  const previous = await inspectDestination(target);
  const report = await readRuntimeDiagnostics(dataDir);
  const tempDirectory = await mkdtemp(path.join(directory, ".agentkib-diagnostics-"));
  const tempDirectoryEntry = await inspectDirectory(tempDirectory);
  const temporary = path.join(tempDirectory, "report.json");
  let staged: BigIntStats | undefined;

  try {
    // The file is private before any diagnostic data is written, including on Windows.
    if (process.platform === "win32") restrictRemotePath(tempDirectory, true);
    // An inherited macOS ACL can grant access beyond the POSIX mode bits.
    if (process.platform === "darwin")
      await execFileAsync("/bin/chmod", ["-N", tempDirectory], { timeout: 2_000 });
    await inspectDirectory(tempDirectory, tempDirectoryEntry);
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      staged = await file.stat({ bigint: true });
      if (process.platform === "win32") restrictRemotePath(temporary);
      else await file.chmod(0o600);
      await file.writeFile(JSON.stringify(report, null, 2) + "\n");
      await file.sync();
    } finally {
      await file.close();
    }

    const candidate = await inspectDestination(temporary);
    await inspectDirectory(tempDirectory, tempDirectoryEntry);
    await inspectDirectory(directory, directoryEntry);
    if (!candidate || !sameEntry(candidate, staged))
      throw new Error("diagnostics-destination-changed");

    // Replace the directory entry so the destination inherits the new file's permissions.
    if (previous) {
      const current = await inspectDestination(target);
      if (!current || !sameEntry(previous, current) || previous.ctimeNs !== current.ctimeNs)
        throw new Error("diagnostics-destination-changed");
      await rename(temporary, target);
    } else {
      moveNoReplace(temporary, target);
    }
  } finally {
    try {
      await inspectDirectory(tempDirectory, tempDirectoryEntry);
      const candidate = await inspectDestination(temporary);
      if (candidate && staged && sameEntry(candidate, staged)) await unlink(temporary);
      await rmdir(tempDirectory);
    } catch {
      // Leave entries whose ownership is no longer known untouched.
    }
  }
}

export function registerDiagnosticsIpc(handle: IpcRegistrar["handle"], dataDir: string): void {
  let exporting = false;
  handle("agentkib:diagnostics:export", async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame)
      throw new Error("diagnostics-export-unavailable");
    if (exporting) return;
    exporting = true;
    try {
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: "agentkib-diagnostics.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!canceled && filePath) await saveDiagnostics(filePath, dataDir);
    } catch {
      // IPC errors must not send the selected path or filesystem errors to the renderer.
      throw new Error("diagnostics-export-failed");
    } finally {
      exporting = false;
    }
  });
}
