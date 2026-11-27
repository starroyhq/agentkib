import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  statSync,
  type BigIntStats,
} from "node:fs";
import path from "node:path";
import { isReparseOrSymlink } from "./native-files";

const readFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

type PathKind = "directory" | "database";

function unsafe(kind: PathKind): Error {
  return new Error(
    kind === "directory" ? "Unsafe AgentKib data directory" : "Unsafe AgentKib database file",
  );
}

function skipped(
  kind: PathKind,
  reason: "foreign-owner" | "linked" | "access-failed" | "path-changed" | "shared-directory",
) {
  console.warn(`[storage] Skipped data permission hardening: ${kind} ${reason}`);
}

function attempt<T>(kind: PathKind, operation: () => T): T | null {
  try {
    return operation();
  } catch (error) {
    // SQLite can remove a sidecar before we open it.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") skipped(kind, "access-failed");
    return null;
  }
}

function metadataAt(file: string, kind: PathKind) {
  return attempt(kind, () => lstatSync(file, { bigint: true, throwIfNoEntry: false }));
}

function restrict(file: string, kind: PathKind, metadata: BigIntStats): void {
  const owner = process.getuid?.();
  // Windows keeps the ACL inherited from the current user's application profile.
  if (owner === undefined) return;
  if (metadata.uid !== BigInt(owner)) {
    skipped(kind, "foreign-owner");
    return;
  }
  const directory = kind === "directory";
  const mask = directory ? 0o700n : 0o600n;
  const mode = metadata.mode & 0o7777n;
  if (mode === (mode & mask)) return;
  if (directory && (mode & 0o1000n) !== 0n) {
    // The immediate parent of a caller-selected database can be a shared temporary directory.
    skipped(kind, "shared-directory");
    return;
  }
  attempt(kind, () => {
    const fd = openSync(file, readFlags | (directory ? (constants.O_DIRECTORY ?? 0) : 0));
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        opened.uid !== metadata.uid ||
        (directory
          ? !opened.isDirectory() || (opened.mode & 0o1000n) !== 0n
          : !opened.isFile() || opened.nlink !== 1n)
      ) {
        skipped(kind, "path-changed");
        return;
      }
      fchmodSync(fd, Number(opened.mode & mask));
    } finally {
      closeSync(fd);
    }
  });
}

/** Restrict only the leaf directory chosen for the desktop profile. */
export function protectPrivateDataDirectory(directory: string, create: boolean): boolean {
  const initial = metadataAt(directory, "directory");
  if (initial === undefined) {
    if (!create) return false;
    attempt("directory", () => mkdirSync(directory, { recursive: true, mode: 0o700 }));
  } else if (initial === null) {
    // An inaccessible path is not proof that a profile is missing.
    return true;
  }
  const target = attempt("directory", () => realpathSync(directory));
  if (target) {
    const metadata = metadataAt(target, "directory");
    if (metadata) {
      if (!metadata.isDirectory()) throw unsafe("directory");
      restrict(target, "directory", metadata);
    }
  }
  return true;
}

function protectDatabaseFile(file: string): boolean {
  const metadata = metadataAt(file, "database");
  if (metadata === undefined) return false;
  if (!metadata) return true;

  const linked = attempt("database", () => isReparseOrSymlink(file, metadata));
  if (linked === null) return true;
  if (linked) {
    const target = attempt("database", () => statSync(file));
    if (target && !target.isFile()) throw unsafe("database");
    skipped("database", "linked");
  } else {
    if (!metadata.isFile()) throw unsafe("database");
    if (metadata.nlink !== 1n) skipped("database", "linked");
    else restrict(file, "database", metadata);
  }
  return true;
}

/** Verify SQLite paths and protect the files before opening a connection or writing a journal. */
export function preparePrivateDatabase(file: string): void {
  const directory = path.dirname(file);
  if (directory !== ".") protectPrivateDataDirectory(directory, true);
  for (const suffix of ["-wal", "-shm", "-journal"]) protectDatabaseFile(file + suffix);
  if (protectDatabaseFile(file)) return;
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") protectDatabaseFile(file);
    else skipped("database", "access-failed");
  }
}
