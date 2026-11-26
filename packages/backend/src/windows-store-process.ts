import { nativeBindings } from "./native-files";

// STARTUPINFOEXW adds the attribute list after the standard STARTUPINFOW fields.
function windowsProcessApi() {
  const ffi = nativeBindings();
  const kernel = ffi.load("kernel32.dll");
  const startupInfo = ffi.struct({
    cb: "uint32_t",
    lpReserved: "void *",
    lpDesktop: "void *",
    lpTitle: "void *",
    dwX: "uint32_t",
    dwY: "uint32_t",
    dwXSize: "uint32_t",
    dwYSize: "uint32_t",
    dwXCountChars: "uint32_t",
    dwYCountChars: "uint32_t",
    dwFillAttribute: "uint32_t",
    dwFlags: "uint32_t",
    wShowWindow: "uint16_t",
    cbReserved2: "uint16_t",
    lpReserved2: "void *",
    hStdInput: "void *",
    hStdOutput: "void *",
    hStdError: "void *",
  });
  const extendedStartup = ffi.struct({ startupInfo, attributeList: "void *" });
  const processInformation = ffi.struct({
    hProcess: "void *",
    hThread: "void *",
    dwProcessId: "uint32_t",
    dwThreadId: "uint32_t",
  });
  return {
    create: kernel.func("__stdcall", "CreateProcessW", "int", [
      "str16",
      "void *",
      "void *",
      "void *",
      "int",
      "uint32_t",
      "void *",
      "str16",
      "void *",
      "void *",
    ]),
    initializeAttributes: kernel.func("__stdcall", "InitializeProcThreadAttributeList", "int", [
      "void *",
      "uint32_t",
      "uint32_t",
      "void *",
    ]),
    updateAttribute: kernel.func("__stdcall", "UpdateProcThreadAttribute", "int", [
      "void *",
      "uint32_t",
      "uintptr_t",
      "void *",
      "size_t",
      "void *",
      "void *",
    ]),
    deleteAttributes: kernel.func("__stdcall", "DeleteProcThreadAttributeList", "void", ["void *"]),
    close: kernel.func("__stdcall", "CloseHandle", "int", ["void *"]),
    lastError: kernel.func("__stdcall", "GetLastError", "uint32_t", []),
    encodeStartup(attributes: Buffer) {
      const startup = Buffer.alloc(ffi.sizeof(extendedStartup));
      startup.writeUInt32LE(startup.length, ffi.offsetof(startupInfo, "cb"));
      ffi.encode(startup, ffi.offsetof(extendedStartup, "attributeList"), "void *", attributes);
      return startup;
    },
    allocateProcess: () => Buffer.alloc(ffi.sizeof(processInformation)),
    processHandles: (info: Buffer): { hProcess: unknown; hThread: unknown } =>
      ffi.decode(info, processInformation),
    allocateAttributeSize: () => Buffer.alloc(ffi.sizeof("size_t")),
    attributeSize: (size: Buffer): number => Number(ffi.decode(size, "size_t")),
  };
}

let cached: ReturnType<typeof windowsProcessApi> | undefined;

function quoteWindowsArgument(argument: string): string {
  if (argument.includes("\0")) throw new Error("Invalid Windows process argument");
  // The Win32 C runtime doubles backslashes before a literal quote or a closing quote.
  return '"' + argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1") + '"';
}

function windowsEnvironment(environment: NodeJS.ProcessEnv): Buffer {
  const entries = new Map<string, string>();
  for (const key of Object.keys(environment).sort()) {
    const value = environment[key];
    if (value === undefined) continue;
    if (!key || /[=\0]/.test(key) || value.includes("\0"))
      throw new Error("Invalid Windows process environment");
    const folded = key.toUpperCase();
    if (!entries.has(folded)) entries.set(folded, key + "=" + value);
  }
  const values = [...entries.keys()].sort().map((key) => entries.get(key));
  return Buffer.from(values.join("\0") + "\0\0", "utf16le");
}

/** Launch the packaged backend inside this app's package graph without tying it to the GUI process. */
export function launchPackagedWindowsProcess(
  executablePath: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
): void {
  if (process.platform !== "win32") throw new Error("Windows Store process launch is unavailable");
  const command = Buffer.from(
    [executablePath, ...args].map(quoteWindowsArgument).join(" ") + "\0",
    "utf16le",
  );
  const env = windowsEnvironment(environment);
  const api = (cached ??= windowsProcessApi());
  const size = api.allocateAttributeSize();
  const sizingResult = api.initializeAttributes(null, 1, 0, size);
  const sizingError = api.lastError();
  const bytes = api.attributeSize(size);
  if (sizingResult || sizingError !== 122 || !Number.isSafeInteger(bytes) || bytes < 1)
    throw new Error("Cannot size Windows process attributes (" + sizingError + ")");
  const attributes = Buffer.alloc(bytes);
  if (!api.initializeAttributes(attributes, 1, 0, size))
    throw new Error("Cannot initialize Windows process attributes (" + api.lastError() + ")");
  try {
    // PROC_THREAD_ATTRIBUTE_DESKTOP_APP_POLICY, BREAKAWAY_OVERRIDE applies only to this child.
    const policy = Buffer.alloc(4);
    policy.writeUInt32LE(0x04);
    if (!api.updateAttribute(attributes, 0, 0x00020012, policy, policy.length, null, null)) {
      throw new Error("Cannot set Windows package launch policy (" + api.lastError() + ")");
    }
    // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_UNICODE_ENVIRONMENT |
    // EXTENDED_STARTUPINFO_PRESENT. The child gets no inherited handles.
    const flags = 0x00000008 | 0x00000200 | 0x00000400 | 0x00080000;
    const information = api.allocateProcess();
    if (
      !api.create(
        executablePath,
        command,
        null,
        null,
        0,
        flags,
        env,
        null,
        api.encodeStartup(attributes),
        information,
      )
    ) {
      throw new Error("Cannot start Windows Store backend (" + api.lastError() + ")");
    }
    const { hThread, hProcess } = api.processHandles(information);
    api.close(hThread);
    api.close(hProcess);
  } finally {
    api.deleteAttributes(attributes);
  }
}
