import { lstatSync } from "node:fs";
import path from "node:path";
import { dshHome } from "./dsh-managed-runtime";
import { existingFileLeaseBusy } from "./managed-session-lock";

export type DshWriterStatus = "held" | "free" | "unknown";

function encodeSegment(value: string): string {
  // DSH encodes UTF-16 code units in its JSONL persistence paths.
  return value.replace(
    /[^A-Za-z0-9._-]/g,
    (unit) => `~${unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`,
  );
}

/** Resolve a native POSIX session directory under DSH's standard storage root. */
export function dshSessionDirectory(
  nativeId: string,
  cwd: string | null | undefined,
  home = dshHome(),
): string | null {
  const owner = process.getuid?.();
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    owner === undefined ||
    !cwd ||
    !path.isAbsolute(cwd) ||
    cwd.includes("\0") ||
    !path.isAbsolute(home) ||
    !nativeId
  ) {
    return null;
  }

  const slug = encodeSegment(cwd.replace(/[/\\:]+/g, "-")).replace(/^-+/, "") || "root";
  const project = `--${slug.slice(0, 251)}--`;
  const session =
    nativeId === "." || nativeId === ".."
      ? "~002E".repeat(nativeId.length)
      : encodeSegment(nativeId);
  if (session.length > 255) return null;

  let directory = home;
  try {
    for (const component of ["", "sessions", project, session]) {
      directory = path.join(directory, component);
      const stat = lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== owner) return null;
    }
  } catch {
    // A catalog entry alone doesn't prove it resides under this storage root and path.
    return null;
  }
  return directory;
}

/** Inspect the native POSIX writer lease before attempting to resume an existing session. */
export function probeDshWriter(
  nativeId: string,
  cwd: string | null | undefined,
  home = dshHome(),
): DshWriterStatus {
  const directory = dshSessionDirectory(nativeId, cwd, home);
  const owner = process.getuid?.();
  if (!directory || owner === undefined) return "unknown";
  const lockPath = path.join(directory, "session.lock");
  let lock;
  try {
    lock = lstatSync(lockPath, { bigint: true });
  } catch (error) {
    // DSH acquires its own kernel lease if a writer arrives after this probe.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "free" : "unknown";
  }
  try {
    if (!lock.isFile() || lock.uid !== BigInt(owner) || lock.nlink !== 1n) return "unknown";
    const busy = existingFileLeaseBusy(lockPath);
    const current = lstatSync(lockPath, { bigint: true });
    if (lock.dev !== current.dev || lock.ino !== current.ino) return "unknown";
    // DSH keeps the lock file after release, so its presence cannot establish ownership.
    return busy ? "held" : "free";
  } catch {
    return "unknown";
  }
}
