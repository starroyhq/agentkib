import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";

const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

function unsafe(directory: boolean): Error {
  return new Error(directory ? "Unsafe AgentKib data directory" : "Unsafe AgentKib database file");
}

function inspect(file: string, directory: boolean) {
  const metadata = lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (!metadata) return undefined;
  const owner = process.getuid?.();
  if (
    (directory ? !metadata.isDirectory() : !metadata.isFile() || metadata.nlink !== 1n) ||
    isReparseOrSymlink(file, metadata) ||
    (owner !== undefined && metadata.uid !== BigInt(owner))
  )
    throw unsafe(directory);
  return metadata;
}

function protect(file: string, directory: boolean): boolean {
  const metadata = inspect(file, directory);
  if (!metadata) return false;
  // Windows keeps the ACL inherited from the current user's application profile.
  if (process.getuid === undefined) return true;
  const mode = metadata.mode & 0o7777n;
  const privateMode = mode & (directory ? 0o700n : 0o600n);
  if (mode === privateMode) return true;

  let fd: number;
  try {
    fd = openSync(file, readFlags | (directory ? (constants.O_DIRECTORY ?? 0) : 0));
  } catch (error) {
    // SQLite can clean up a sidecar while another process is opening the store.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    const opened = fstatSync(fd, { bigint: true });
    if (
      opened.dev !== metadata.dev ||
      opened.ino !== metadata.ino ||
      opened.uid !== metadata.uid ||
      (directory ? !opened.isDirectory() : !opened.isFile() || opened.nlink !== 1n)
    )
      throw unsafe(directory);
    fchmodSync(fd, Number(opened.mode & (directory ? 0o700n : 0o600n)));
    const current = inspect(file, directory);
    if (!current) return false;
    if (current.dev !== opened.dev || current.ino !== opened.ino) throw unsafe(directory);
    return true;
  } finally {
    closeSync(fd);
  }
}

/** Restrict only the leaf directory chosen for the desktop profile. */
export function protectPrivateDataDirectory(directory: string, create: boolean): boolean {
  if (create) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const exists = protect(directory, true);
  if (create && !exists) throw unsafe(true);
  return exists;
}

/** Verify SQLite paths and protect the files before opening a connection or writing a journal. */
export function preparePrivateDatabase(file: string): void {
  const directory = path.dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = inspect(directory, true);
  // A caller can name an existing data directory, so never chmod its parent here.
  if (!parent || (process.getuid !== undefined && (parent.mode & 0o022n) !== 0n))
    throw unsafe(true);
  for (const suffix of ["-wal", "-shm", "-journal"]) protect(file + suffix, false);
  if (protect(file, false)) return;
  try {
    closeSync(
      openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600,
      ),
    );
  } catch (error) {
    // Another startup can create the database after the first inspection.
    if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !protect(file, false)) throw error;
  }
}
