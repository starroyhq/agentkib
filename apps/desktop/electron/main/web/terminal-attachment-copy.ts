import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { extname, isAbsolute, join, normalize } from "node:path";
import { imageDimensions } from "./attachment-images";

type AttachmentFile = { id: string; name: string; size: number; version: string };

export type TerminalAttachmentCopy = {
  cwd: string;
  directory: string;
  file: string;
  dev: string;
  ino: string;
};

const IGNORE = Buffer.from("*\n");
const IGNORE_HASH = createHash("sha256").update(IGNORE).digest("hex");
const PREFIX = ".agentkib-attachment-";
const DIRECTORY = /^\.agentkib-attachment-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const EXTENSION = /^\.[a-z0-9]{1,12}$/i;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

function localCwd(cwd: unknown): cwd is string {
  return (
    typeof cwd === "string" &&
    cwd.length <= 4096 &&
    isAbsolute(cwd) &&
    !cwd.includes("\0") &&
    !(process.platform === "win32" && /^[\\/]{2}/.test(cwd))
  );
}

function samePath(a: string, b: string): boolean {
  return process.platform === "win32"
    ? normalize(a.replace(/^\\\\\?\\/, "")).toLowerCase() ===
        normalize(b.replace(/^\\\\\?\\/, "")).toLowerCase()
    : a === b;
}

export function validTerminalCopy(copy: TerminalAttachmentCopy, id: string): boolean {
  return (
    !!copy &&
    localCwd(copy.cwd) &&
    typeof copy.directory === "string" &&
    DIRECTORY.test(copy.directory) &&
    typeof copy.file === "string" &&
    (copy.file === id ||
      (copy.file.startsWith(id) && EXTENSION.test(copy.file.slice(id.length)))) &&
    typeof copy.dev === "string" &&
    /^\d+$/.test(copy.dev) &&
    typeof copy.ino === "string" &&
    /^\d+$/.test(copy.ino)
  );
}

async function canonicalDirectory(directory: string) {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || !samePath(await realpath(directory), directory))
    throw new Error("attachment_workspace_changed");
  return info;
}

async function checkedDirectory(copy: TerminalAttachmentCopy): Promise<string> {
  const directory = join(copy.cwd, copy.directory);
  const info = await canonicalDirectory(directory);
  if (String(info.dev) !== copy.dev || String(info.ino) !== copy.ino)
    throw new Error("attachment_workspace_changed");
  return directory;
}

async function matchesFile(file: string, size: number, version: string): Promise<boolean> {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile() || info.size !== BigInt(size) || info.nlink !== 1n) return false;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size)
      return false;
    const bytes = Buffer.allocUnsafe(size + 1);
    let count = 0;
    while (count < bytes.length) {
      const { bytesRead } = await handle.read(bytes, count, bytes.length - count, count);
      if (!bytesRead) break;
      count += bytesRead;
    }
    return (
      count === size &&
      createHash("sha256").update(bytes.subarray(0, count)).digest("hex") === version
    );
  } finally {
    await handle.close();
  }
}

async function writeExclusive(copy: TerminalAttachmentCopy, name: string, bytes: Buffer) {
  const file = join(await checkedDirectory(copy), name);
  const handle = await open(file, "wx", 0o600);
  let info: BigIntStats | undefined;
  try {
    try {
      info = await handle.stat({ bigint: true });
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Only an inode just created by this attempt can be a partial write.
    try {
      await checkedDirectory(copy);
      const current = await lstat(file, { bigint: true });
      if (info && current.dev === info.dev && current.ino === info.ino) await unlink(file);
    } catch {}
    throw error;
  }
}

export async function terminalAttachmentPath(
  copy: TerminalAttachmentCopy,
  item: AttachmentFile,
  cwd: string,
): Promise<string> {
  if (!validTerminalCopy(copy, item.id) || copy.cwd !== cwd)
    throw new Error("attachment_workspace_changed");
  const directory = await checkedDirectory(copy);
  const file = join(directory, copy.file);
  if (
    !(await matchesFile(join(directory, ".gitignore"), IGNORE.length, IGNORE_HASH)) ||
    !(await matchesFile(file, item.size, item.version))
  )
    throw new Error("attachment_workspace_changed");
  await checkedDirectory(copy);
  return file;
}

export async function stageTerminalAttachment(
  cwd: string,
  item: AttachmentFile,
  bytes: Buffer,
): Promise<{ copy: TerminalAttachmentCopy; path: string }> {
  if (!localCwd(cwd)) throw new Error("attachment_workspace_changed");
  await canonicalDirectory(cwd);
  const directory = PREFIX + randomUUID();
  const image = imageDimensions(bytes);
  const extension = extname(item.name);
  const file =
    item.id +
    (image ? (IMAGE_EXTENSIONS[image.mime] ?? "") : EXTENSION.test(extension) ? extension : "");
  const path = join(cwd, directory);
  await mkdir(path, { mode: 0o700 });
  const info = await canonicalDirectory(path);
  const copy = { cwd, directory, file, dev: String(info.dev), ino: String(info.ino) };
  try {
    // An ignore file in the new directory excludes itself and the data without
    // changing a Git checkout's configuration or any existing ignore rules.
    await writeExclusive(copy, ".gitignore", IGNORE);
    await writeExclusive(copy, file, bytes);
    await checkedDirectory(copy);
    return { copy, path: join(path, file) };
  } catch (error) {
    await removeTerminalAttachment(copy, item);
    throw error;
  }
}

export async function removeTerminalAttachment(
  copy: TerminalAttachmentCopy,
  item: AttachmentFile,
): Promise<void> {
  if (!validTerminalCopy(copy, item.id)) return;
  try {
    const directory = await checkedDirectory(copy);
    const file = join(directory, copy.file);
    if (await matchesFile(file, item.size, item.version).catch(() => false)) {
      await checkedDirectory(copy);
      await unlink(file);
    }
    const entries = await readdir(directory);
    if (entries.length === 1 && entries[0] === ".gitignore") {
      const marker = join(directory, ".gitignore");
      if (!(await matchesFile(marker, IGNORE.length, IGNORE_HASH))) return;
      await checkedDirectory(copy);
      await unlink(marker);
    } else if (entries.length) return;
    await checkedDirectory(copy);
    await rmdir(directory);
  } catch {
    // A missing, moved or replaced copy is no longer safe for the store to remove.
  }
}
