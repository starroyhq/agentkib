import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync, renameSync, rmSync, lstatSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type * as Koffi from "koffi";
let bindings: typeof Koffi | undefined;
export function nativeBindings(): typeof Koffi {
  if (bindings) return bindings;
  const directory =
    typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const load = createRequire(path.join(directory, "backend.cjs")),
    staged = path.join(directory, "native/koffi");
  bindings = load(existsSync(staged) ? staged : "koffi") as typeof Koffi;
  return bindings;
}
let windows:
  | {
      replace: (...args: any[]) => number;
      move: (...args: any[]) => number;
      error: () => number;
      attributes: (file: string) => number;
    }
  | undefined;
function windowsApi() {
  if (windows) return windows;
  const lib = nativeBindings().load("kernel32.dll");
  windows = {
    replace: lib.func("__stdcall", "ReplaceFileW", "int", [
      "str16",
      "str16",
      "str16",
      "uint",
      "void *",
      "void *",
    ]),
    move: lib.func("__stdcall", "MoveFileExW", "int", ["str16", "str16", "uint"]),
    error: lib.func("__stdcall", "GetLastError", "uint", []),
    attributes: lib.func("__stdcall", "GetFileAttributesW", "uint", ["str16"]),
  };
  return windows;
}
let identityApi:
  | {
      open: (...args: any[]) => number | bigint;
      query: (...args: any[]) => number;
      close: (...args: any[]) => number;
      error: () => number;
    }
  | undefined;
/** Match the native database cursor identity, including the Windows volume/file index pair. */
export function nativeFileIdentity(file: string): [bigint, bigint] {
  if (process.platform !== "win32") {
    const metadata = statSync(file, { bigint: true });
    return [metadata.dev, metadata.ino];
  }
  if (!identityApi) {
    const lib = nativeBindings().load("kernel32.dll");
    identityApi = {
      open: lib.func("__stdcall", "CreateFileW", "intptr_t", [
        "str16",
        "uint",
        "uint",
        "void *",
        "uint",
        "uint",
        "intptr_t",
      ]),
      query: lib.func("__stdcall", "GetFileInformationByHandle", "int", ["intptr_t", "void *"]),
      close: lib.func("__stdcall", "CloseHandle", "int", ["intptr_t"]),
      error: lib.func("__stdcall", "GetLastError", "uint", []),
    };
  }
  const api = identityApi,
    handle = api.open(file, 0x80000000, 7, null, 3, 0x80, 0);
  if (handle === -1 || handle === -1n)
    throw new Error(`Cannot open database identity (${api.error()})`);
  try {
    // BY_HANDLE_FILE_INFORMATION is thirteen DWORDs; FILETIME members each occupy two.
    const info = Buffer.alloc(52);
    if (!api.query(handle, info))
      throw new Error(`Cannot query database identity (${api.error()})`);
    return [
      BigInt(info.readUInt32LE(28)),
      (BigInt(info.readUInt32LE(44)) << 32n) | BigInt(info.readUInt32LE(48)),
    ];
  } finally {
    api.close(handle);
  }
}
function retryWindows(run: () => number): void {
  let code = 0;
  for (const delay of [0, 25, 50, 100, 200]) {
    if (delay) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    if (run()) return;
    code = windowsApi().error();
  }
  throw new Error(`Windows file operation failed (${code})`);
}
export function isReparseOrSymlink(
  file: string,
  metadata: { isSymbolicLink(): boolean } = lstatSync(file),
): boolean {
  if (metadata.isSymbolicLink()) return true;
  if (process.platform !== "win32") return false;
  const value = windowsApi().attributes(file);
  if (value === 0xffffffff)
    throw new Error(`Unable to inspect Windows file attributes (${windowsApi().error()})`);
  return (value & 0x400) !== 0;
}
/** Windows replacement preserves native metadata and retries temporary sharing violations. */
export function replaceFile(source: string, target: string): void {
  if (process.platform !== "win32") {
    renameSync(source, target);
    return;
  }
  const api = windowsApi(),
    existing = existsSync(target),
    backup = `${target}.agentkib-backup-${process.pid}-${randomUUID()}`;
  try {
    retryWindows(() =>
      existing
        ? api.replace(target, source, backup, 1, null, null)
        : api.move(source, target, 1 | 8),
    );
    try {
      rmSync(backup, { force: true });
    } catch {}
  } catch (error) {
    if (!existsSync(target) && existsSync(backup))
      try {
        retryWindows(() => api.move(backup, target, 1 | 8));
      } catch {}
    throw error;
  }
}
let exclusiveMove: ((source: string, target: string) => number) | undefined;
export function moveNoReplace(source: string, target: string): void {
  if (process.platform === "win32") {
    retryWindows(() => windowsApi().move(source, target, 8));
    return;
  }
  if (!exclusiveMove) {
    const lib = nativeBindings().load(
      process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
    );
    if (process.platform === "darwin") {
      const move = lib.func(
        "int renamex_np(const char *source, const char *target, unsigned int flags)",
      );
      exclusiveMove = (source, target) => move(source, target, 4);
    } else if (process.platform === "linux") {
      const move = lib.func(
        "int renameat2(int sourceDir, const char *source, int targetDir, const char *target, unsigned int flags)",
      );
      exclusiveMove = (source, target) => move(-100, source, -100, target, 1);
    } else throw new Error("Exclusive atomic file moves are unavailable on this platform");
  }
  if (exclusiveMove(source, target) !== 0)
    throw new Error(`Exclusive atomic file move failed (${nativeBindings().errno()})`);
}
