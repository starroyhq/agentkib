import { BrowserWindow, dialog } from "electron";
import { execFile } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdtemp, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { isReparseOrSymlinkAsync } from "@agentkib/backend/native-files";
import { restrictRemotePath } from "@agentkib/backend/remote-tls";
import { readRuntimeDiagnostics } from "../runtime-diagnostics-report";
import type { IpcRegistrar } from "./registrar";

const CREATE_PRIVATE =
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);

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

function restrictReportAcl(file: string, directory: boolean) {
  if (process.platform === "win32") restrictRemotePath(file, directory, { allowUnsupported: true });
  if (process.platform !== "darwin") return;
  return new Promise<void>((resolve, reject) => {
    execFile(
      "/bin/chmod",
      ["-h", "-N", file],
      { timeout: 2_000, env: { ...process.env, LC_ALL: "C" } },
      (error, _stdout, stderr) => {
        // chmod returns a generic exit status. Match only the system's unsupported error.
        const unsupported =
          error?.code === 1 && /: Operation not supported(?: on socket)?$/.test(stderr.trimEnd());
        if (error && !unsupported) reject(error);
        else resolve();
      },
    );
  });
}

async function unlinkIfOwned(file: string, entry: BigIntStats) {
  const current = await inspectDestination(file);
  if (current && sameEntry(entry, current)) await unlink(file);
}

async function createPrivateReport(file: string, content: string) {
  const handle = await open(file, CREATE_PRIVATE, 0o600);
  let entry: BigIntStats | undefined;
  try {
    try {
      entry = await handle.stat({ bigint: true });
      await restrictReportAcl(file, false);
      if (process.platform !== "win32") {
        try {
          await handle.chmod(0o600);
        } catch (error) {
          // Volumes without Unix permissions can disregard the creation mode as well.
          if (
            !["ENOTSUP", "EOPNOTSUPP", "ENOSYS"].includes(
              (error as NodeJS.ErrnoException).code ?? "",
            )
          )
            throw error;
        }
      }
      const current = await inspectDestination(file);
      if (!current || !sameEntry(entry, current))
        throw new Error("diagnostics-destination-changed");
      await handle.writeFile(content);
    } finally {
      await handle.close();
    }
    return entry;
  } catch (error) {
    if (entry) await unlinkIfOwned(file, entry).catch(() => {});
    throw error;
  }
}

async function saveDiagnostics(filePath: string, dataDir: string): Promise<void> {
  const directory = await realpath(path.dirname(filePath));
  const directoryEntry = await inspectDirectory(directory);
  const target = path.join(directory, path.basename(filePath));
  const previous = await inspectDestination(target);
  const report = await readRuntimeDiagnostics(dataDir);
  const content = JSON.stringify(report, null, 2) + "\n";
  await inspectDirectory(directory, directoryEntry);

  if (!previous) {
    // O_EXCL keeps the new target safe even on volumes without an exclusive rename.
    await createPrivateReport(target, content);
    return;
  }

  const tempDirectory = await mkdtemp(path.join(directory, ".agentkib-diagnostics-"));
  const tempDirectoryEntry = await inspectDirectory(tempDirectory);
  const temporary = path.join(tempDirectory, "report.json");
  let staged: BigIntStats | undefined;
  try {
    await restrictReportAcl(tempDirectory, true);
    await inspectDirectory(tempDirectory, tempDirectoryEntry);
    staged = await createPrivateReport(temporary, content);
    const candidate = await inspectDestination(temporary);
    await inspectDirectory(tempDirectory, tempDirectoryEntry);
    await inspectDirectory(directory, directoryEntry);
    const current = await inspectDestination(target);
    if (
      !candidate ||
      !sameEntry(candidate, staged) ||
      !current ||
      !sameEntry(previous, current) ||
      previous.ctimeNs !== current.ctimeNs
    )
      throw new Error("diagnostics-destination-changed");

    // Replace the directory entry so the destination gets the new file's permissions.
    await rename(temporary, target);
  } finally {
    try {
      await inspectDirectory(tempDirectory, tempDirectoryEntry);
      if (staged) await unlinkIfOwned(temporary, staged);
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
