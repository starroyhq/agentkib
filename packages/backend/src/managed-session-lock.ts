import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import path from "node:path";
import { isReparseOrSymlink, nativeBindings } from "./native-files";
import { restrictRemotePath } from "./remote-tls";

let lockApi:
  | {
      lock: (fd: number, operation: number) => number;
    }
  | undefined;
let windowsLockApi:
  | {
      fileHandle: (fd: number) => number | bigint;
      lock: (
        handle: number | bigint,
        flags: number,
        reserved: number,
        bytesLow: number,
        bytesHigh: number,
        overlapped: Buffer,
      ) => number;
      unlock: (
        handle: number | bigint,
        reserved: number,
        bytesLow: number,
        bytesHigh: number,
        overlapped: Buffer,
      ) => number;
      error: () => number;
    }
  | undefined;

function flockApi() {
  if (lockApi) return lockApi;
  const library = nativeBindings().load(
    process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
  );
  lockApi = { lock: library.func("int flock(int fd, int operation)") };
  return lockApi;
}

function win32Api() {
  if (windowsLockApi) return windowsLockApi;
  const bindings = nativeBindings();
  const crt = bindings.load("ucrtbase.dll");
  const kernel = bindings.load("kernel32.dll");
  windowsLockApi = {
    fileHandle: crt.func("intptr_t _get_osfhandle(int fd)"),
    lock: kernel.func("__stdcall", "LockFileEx", "int", [
      "intptr_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "void *",
    ]),
    unlock: kernel.func("__stdcall", "UnlockFileEx", "int", [
      "intptr_t",
      "uint32_t",
      "uint32_t",
      "uint32_t",
      "void *",
    ]),
    error: kernel.func("__stdcall", "GetLastError", "uint32_t", []),
  };
  return windowsLockApi;
}

function acquireWindowsLock(fd: number): () => void {
  const api = win32Api();
  const handle = api.fileHandle(fd);
  if (handle === -1 || handle === -1n) throw new Error("invalid-managed-ledger-lock");
  // OVERLAPPED is two pointer-sized fields followed by the 8-byte offset union
  // and event handle; supported Windows targets are x64 and ARM64.
  const overlapped = Buffer.alloc(32);
  const locked = api.lock(handle, 0x3, 0, 0xffffffff, 0xffffffff, overlapped);
  if (!locked) {
    const code = api.error();
    if (code === 33) throw new Error("session-managed-by-another-runtime");
    throw new Error(`Cannot acquire managed session lock (${code})`);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (!api.unlock(handle, 0, 0xffffffff, 0xffffffff, overlapped))
      throw new Error(`Cannot release managed session lock (${api.error()})`);
  };
}

/** Acquire a cross-process advisory lock on the whole file at a shared lock path. */
export function acquirePortableFileLease(lockPath: string): () => void {
  if (!["darwin", "linux", "win32"].includes(process.platform))
    throw new Error("platform-unsupported");
  const directory = path.dirname(lockPath);
  const directoryStat = lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory())
    throw new Error("invalid-managed-lock-directory");
  restrictRemotePath(directory, true);

  const fd = openSync(
    lockPath,
    constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile() || isReparseOrSymlink(lockPath, lstatSync(lockPath)))
      throw new Error("invalid-managed-lock-file");
    restrictRemotePath(lockPath);
    if (process.platform === "win32") {
      const releaseLock = acquireWindowsLock(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          releaseLock();
        } finally {
          closeSync(fd);
        }
      };
    }
    if (flockApi().lock(fd, 2 | 4) !== 0) throw new Error("session-managed-by-another-runtime");
  } catch (error) {
    closeSync(fd);
    throw error;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      flockApi().lock(fd, 8);
    } finally {
      closeSync(fd);
    }
  };
}

/** Acquire the advisory lease shared by local managed-session owners. */
export function acquireManagedSessionLease(dataDir: string, sessionId: string): () => void {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(sessionId)) throw new Error("invalid-session");
  return acquirePortableFileLease(path.join(dataDir, "codex-managed", `managed-${sessionId}.lock`));
}
