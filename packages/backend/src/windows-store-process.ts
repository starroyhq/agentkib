import { nativeBindings } from "./native-files";

const APPLICATION_ACTIVATION_MANAGER = "{45BA127D-10A8-46EA-8AB7-56EA9078943C}";
const IAPPLICATION_ACTIVATION_MANAGER = "{2E941141-7F97-4756-BA1D-9DECDE894A3D}";
const RUNTIME_APPLICATION = "AgentKibRuntime";

function windowsError(operation: string, code: number): Error {
  return new Error(operation + " (0x" + (code >>> 0).toString(16) + ")");
}

/** Activate the package's private backend application with its own package identity. */
export function activatePackagedWindowsRuntime(): void {
  if (process.platform !== "win32") throw new Error("Windows Store activation is unavailable");
  const ffi = nativeBindings();
  const kernel = ffi.load("kernel32.dll");
  const currentApplicationId = kernel.func(
    "__stdcall",
    "GetCurrentApplicationUserModelId",
    "int32_t",
    ["void *", "void *"],
  );
  const length = Buffer.alloc(4);
  const sizing = currentApplicationId(length, null);
  const characters = length.readUInt32LE();
  if (sizing !== 122 || characters < 2 || characters > 256)
    throw windowsError("Could not read the current Windows application identity", sizing);
  const identity = Buffer.alloc(characters * 2);
  const readIdentity = currentApplicationId(length, identity);
  if (readIdentity !== 0)
    throw windowsError("Could not read the current Windows application identity", readIdentity);
  const current = identity.toString("utf16le").split("\0", 1)[0]!;
  const separator = current.indexOf("!");
  if (separator <= 0) throw new Error("Could not locate the current Windows package family");
  const runtimeId = current.slice(0, separator + 1) + RUNTIME_APPLICATION;

  const ole = ffi.load("ole32.dll");
  const initialize = ole.func("__stdcall", "CoInitializeEx", "int32_t", ["void *", "uint32_t"]);
  const uninitialize = ole.func("__stdcall", "CoUninitialize", "void", []);
  const guidFromString = ole.func("__stdcall", "CLSIDFromString", "int32_t", ["str16", "void *"]);
  const createInstance = ole.func("__stdcall", "CoCreateInstance", "int32_t", [
    "void *",
    "void *",
    "uint32_t",
    "void *",
    "void *",
  ]);
  const activationPrototype = ffi.proto("__stdcall", "int32_t", [
    "void *",
    "str16",
    "str16",
    "uint32_t",
    "void *",
  ]);
  const releasePrototype = ffi.proto("__stdcall", "uint32_t", ["void *"]);
  const pointerSize = ffi.sizeof("void *");
  // Electron may already have selected a single-threaded COM apartment.
  const initialized = initialize(null, 0);
  if (initialized < 0 && initialized !== (0x80010106 | 0))
    throw windowsError("Could not initialize Windows application activation", initialized);
  try {
    const classId = Buffer.alloc(16);
    const interfaceId = Buffer.alloc(16);
    const classResult = guidFromString(APPLICATION_ACTIVATION_MANAGER, classId);
    const interfaceResult = guidFromString(IAPPLICATION_ACTIVATION_MANAGER, interfaceId);
    if (classResult < 0 || interfaceResult < 0)
      throw windowsError(
        "Could not prepare Windows application activation",
        classResult < 0 ? classResult : interfaceResult,
      );
    const output = Buffer.alloc(pointerSize);
    // CLSCTX_INPROC_SERVER is sufficient while the long-lived desktop remains active.
    const created = createInstance(classId, null, 1, interfaceId, output);
    if (created < 0) throw windowsError("Could not create Windows application activation", created);
    const manager = ffi.decode(output, "void *");
    if (!manager) throw new Error("Windows application activation did not return an interface");
    const table = ffi.decode(manager, "void *");
    const release = ffi.decode(table, 2 * pointerSize, "void *");
    try {
      const activate = ffi.decode(table, 3 * pointerSize, "void *");
      const processId = Buffer.alloc(4);
      // AO_NOERRORUI prevents Windows from opening a dialog for a backend activation failure.
      const result = ffi.call(
        activate,
        activationPrototype,
        manager,
        runtimeId,
        "--agentkib-store-runtime",
        2,
        processId,
      );
      if (result < 0 || !processId.readUInt32LE())
        throw windowsError("Could not activate the Windows Store backend", result);
    } finally {
      ffi.call(release, releasePrototype, manager);
    }
  } finally {
    if (initialized >= 0) uninitialize();
  }
}
