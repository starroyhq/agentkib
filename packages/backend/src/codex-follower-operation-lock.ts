import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { nativeBindings } from "./native-files";

const active = new Set<string>();

/** Matches the lock identity and private-file checks used by the Rust desktop follower. */
export function acquireCodexFollowerOperationLock(
  endpoint: string,
  conversation: string,
): () => void {
  if (process.platform !== "darwin" || typeof process.getuid !== "function")
    throw new Error("platform-unsupported");
  if (!path.isAbsolute(endpoint) || !conversation)
    throw new Error("invalid-follower-lock-identity");

  const identity = `${endpoint}:${conversation}`;
  if (active.has(identity)) throw new Error("session operation already in flight");
  active.add(identity);
  let directoryFd: number | undefined;
  let lockFd: number | undefined;
  let flock: ((fd: number, operation: number) => number) | undefined;
  try {
    const directory = path.join(homedir(), ".agentkib-bridge-locks");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const directoryStat = lstatSync(directory);
    if (
      directoryStat.isSymbolicLink() ||
      !directoryStat.isDirectory() ||
      directoryStat.uid !== process.getuid() ||
      (directoryStat.mode & 0o077) !== 0
    )
      throw new Error("unsafe bridge lock directory");
    directoryFd = openSync(
      directory,
      constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
    );
    const openedDirectory = fstatSync(directoryFd);
    if (
      openedDirectory.dev !== directoryStat.dev ||
      openedDirectory.ino !== directoryStat.ino ||
      openedDirectory.uid !== process.getuid() ||
      (openedDirectory.mode & 0o077) !== 0
    )
      throw new Error("bridge lock directory changed");

    let hash = 0xcbf29ce484222325n;
    for (const byte of Buffer.from(identity, "utf8"))
      hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    const lockPath = path.join(directory, `${hash.toString(16).padStart(16, "0")}.lock`);
    lockFd = openSync(
      lockPath,
      constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const lockStat = fstatSync(lockFd);
    if (
      !lockStat.isFile() ||
      lockStat.uid !== process.getuid() ||
      (lockStat.mode & 0o077) !== 0 ||
      lockStat.nlink !== 1
    )
      throw new Error("unsafe bridge process lock");
    flock = nativeBindings()
      .load("/usr/lib/libSystem.B.dylib")
      .func("int flock(int fd, int operation)");
    if (flock(lockFd, 2 | 4) !== 0) throw new Error("session operation already in flight");

    let released = false;
    return () => {
      if (released) return;
      released = true;
      try {
        flock?.(lockFd!, 8);
      } finally {
        closeSync(lockFd!);
        closeSync(directoryFd!);
        active.delete(identity);
      }
    };
  } catch (error) {
    if (lockFd !== undefined) closeSync(lockFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    active.delete(identity);
    throw error;
  }
}
