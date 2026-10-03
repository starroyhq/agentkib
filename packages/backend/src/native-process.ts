import { nativeBindings } from "./native-files";

export interface NativeProcessTree {
  terminate(): void;
  close(): void;
}
function bindings() {
  const ffi = nativeBindings(),
    lib = ffi.load("kernel32.dll");
  const basic = ffi.struct({
    PerProcessUserTimeLimit: "int64_t",
    PerJobUserTimeLimit: "int64_t",
    LimitFlags: "uint32_t",
    MinimumWorkingSetSize: "size_t",
    MaximumWorkingSetSize: "size_t",
    ActiveProcessLimit: "uint32_t",
    Affinity: "uintptr_t",
    PriorityClass: "uint32_t",
    SchedulingClass: "uint32_t",
  });
  const io = ffi.struct({
    ReadOperationCount: "uint64_t",
    WriteOperationCount: "uint64_t",
    OtherOperationCount: "uint64_t",
    ReadTransferCount: "uint64_t",
    WriteTransferCount: "uint64_t",
    OtherTransferCount: "uint64_t",
  });
  const information = ffi.struct({
    BasicLimitInformation: basic,
    IoInfo: io,
    ProcessMemoryLimit: "size_t",
    JobMemoryLimit: "size_t",
    PeakProcessMemoryUsed: "size_t",
    PeakJobMemoryUsed: "size_t",
  });
  return {
    create: lib.func("__stdcall", "CreateJobObjectW", "intptr_t", ["void *", "str16"]),
    open: lib.func("__stdcall", "OpenProcess", "intptr_t", ["uint32_t", "int", "uint32_t"]),
    configure: lib.func("__stdcall", "SetInformationJobObject", "int", [
      "intptr_t",
      "int",
      "void *",
      "uint32_t",
    ]),
    assign: lib.func("__stdcall", "AssignProcessToJobObject", "int", ["intptr_t", "intptr_t"]),
    terminate: lib.func("__stdcall", "TerminateJobObject", "int", ["intptr_t", "uint32_t"]),
    close: lib.func("__stdcall", "CloseHandle", "int", ["intptr_t"]),
    error: lib.func("__stdcall", "GetLastError", "uint32_t", []),
    size: ffi.sizeof(information),
    flagsOffset:
      ffi.offsetof(information, "BasicLimitInformation") + ffi.offsetof(basic, "LimitFlags"),
  };
}
let cached: ReturnType<typeof bindings> | undefined;
/** Closing the last Job Object handle also terminates descendants after the wrapper exits. */
export function windowsProcessTree(pid: number): NativeProcessTree {
  if (process.platform !== "win32") throw new Error("Windows process tree is unavailable");
  const api = (cached ??= bindings());
  const processHandle = api.open(0x0101, 0, pid);
  if (!processHandle) throw new Error(`Cannot open command process (${api.error()})`);
  let job: number | bigint = 0;
  try {
    job = api.create(null, null);
    if (!job) throw new Error(`Cannot create command job (${api.error()})`);
    const information = Buffer.alloc(api.size);
    information.writeUInt32LE(0x2000, api.flagsOffset);
    if (!api.configure(job, 9, information, information.length))
      throw new Error(`Cannot configure command job (${api.error()})`);
    if (!api.assign(job, processHandle))
      throw new Error(`Cannot supervise command process (${api.error()})`);
  } catch (error) {
    if (job) api.close(job);
    throw error;
  } finally {
    api.close(processHandle);
  }
  let closed = false;
  return {
    terminate() {
      if (!closed && !api.terminate(job, 1)) {
        // KILL_ON_JOB_CLOSE still enforces cleanup when termination itself fails.
        this.close();
      }
    },
    close() {
      if (!closed) {
        closed = true;
        api.close(job);
      }
    },
  };
}
