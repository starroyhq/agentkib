import { execFile } from "node:child_process";
import { availableParallelism, loadavg, platform } from "node:os";
import { recentLocalRuntimeStalls } from "./local-runtime-activity";

type MemoryPressure = "normal" | "warning" | "critical" | "unknown";

export interface HostResourceSummary {
  load1m: number | null;
  cpuCores: number;
  memoryPressure: MemoryPressure;
  backendStalls: { count: number; longestMs: number };
  runningSessions: number;
  level: "normal" | "strained" | "severe";
}

let pressureRead: Promise<MemoryPressure> | undefined;

function readMacMemoryPressure(): Promise<MemoryPressure> {
  // Share the probe across simultaneous worker_list calls.
  pressureRead ??= new Promise<MemoryPressure>((resolve) => {
    execFile(
      "/usr/sbin/sysctl",
      ["-n", "kern.memorystatus_vm_pressure_level"],
      { encoding: "utf8", timeout: 1_000, killSignal: "SIGKILL", maxBuffer: 1_024 },
      (error, stdout) => {
        // XNU's sysctl returns dispatch pressure masks (1, 2, 4), as defined in sys/event.h.
        switch (error ? "" : stdout.trim()) {
          case "1":
            return resolve("normal");
          case "2":
            return resolve("warning");
          case "4":
            return resolve("critical");
          default:
            resolve("unknown");
        }
      },
    );
  })
    .catch(() => "unknown" as const)
    .finally(() => {
      pressureRead = undefined;
    });
  return pressureRead;
}

function resourceLevel(host: Omit<HostResourceSummary, "level">): HostResourceSummary["level"] {
  const loadPerCore = (host.load1m ?? 0) / host.cpuCores;
  const { count, longestMs } = host.backendStalls;
  // Load can include I/O waits. A severe rating needs direct pressure or sustained impact.
  if (host.memoryPressure === "critical" || longestMs >= 15_000 || (loadPerCore >= 2 && count >= 2))
    return "severe";
  if (host.memoryPressure === "warning" || loadPerCore >= 1.25 || count >= 2 || longestMs >= 5_000)
    return "strained";
  return "normal";
}

export async function readHostResourceSummary(
  runningSessions: number,
): Promise<HostResourceSummary> {
  const system = platform();
  const memoryPressure = system === "darwin" ? await readMacMemoryPressure() : "unknown";
  // Node has no load-average measurement on Windows.
  const load1m = system === "win32" ? null : (loadavg()[0] ?? null);
  const host = {
    load1m,
    cpuCores: availableParallelism(),
    memoryPressure,
    backendStalls: recentLocalRuntimeStalls(),
    runningSessions,
  };
  return { ...host, level: resourceLevel(host) };
}
