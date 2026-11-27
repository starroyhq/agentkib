// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readHostResourceSummary,
  type HostResourceSummary,
} from "../../../packages/backend/src/host-resource-summary";

type ProbeCallback = (error: Error | null, stdout: string) => void;
const probes = vi.hoisted(() => ({
  execFile: vi.fn<(file: string, args: string[], options: unknown, done: ProbeCallback) => void>(),
  platform: vi.fn<() => NodeJS.Platform>(),
  availableParallelism: vi.fn<() => number>(),
  loadavg: vi.fn<() => number[]>(),
  recentLocalRuntimeStalls: vi.fn<() => HostResourceSummary["backendStalls"]>(),
}));

vi.mock("node:child_process", () => ({ execFile: probes.execFile }));
vi.mock("node:os", () => ({
  platform: probes.platform,
  availableParallelism: probes.availableParallelism,
  loadavg: probes.loadavg,
}));
vi.mock("../../../packages/backend/src/local-runtime-activity", () => ({
  recentLocalRuntimeStalls: probes.recentLocalRuntimeStalls,
}));

beforeEach(() => {
  vi.resetAllMocks();
  probes.platform.mockReturnValue("darwin");
  probes.availableParallelism.mockReturnValue(8);
  probes.loadavg.mockReturnValue([2.5, 4, 6]);
  probes.recentLocalRuntimeStalls.mockReturnValue({ count: 1, longestMs: 2_120.5 });
});

describe("worker host resources", () => {
  it.each([
    ["1", "normal", "normal"],
    ["2", "warning", "strained"],
    ["4", "critical", "severe"],
    ["3", "unknown", "normal"],
  ])(
    "reads macOS pressure %s and reports the measured host values",
    async (raw, pressure, level) => {
      probes.execFile.mockImplementation((_file, _args, _options, done) => done(null, `${raw}\n`));

      await expect(readHostResourceSummary(19)).resolves.toEqual({
        load1m: 2.5,
        cpuCores: 8,
        memoryPressure: pressure,
        backendStalls: { count: 1, longestMs: 2_120.5 },
        runningSessions: 19,
        level,
      });
      expect(probes.execFile).toHaveBeenCalledExactlyOnceWith(
        "/usr/sbin/sysctl",
        ["-n", "kern.memorystatus_vm_pressure_level"],
        expect.objectContaining({ timeout: 1_000 }),
        expect.any(Function),
      );
    },
  );

  it("reports unknown pressure if the system cannot provide it", async () => {
    probes.execFile.mockImplementation((_file, _args, _options, done) =>
      done(new Error("sysctl unavailable"), ""),
    );
    await expect(readHostResourceSummary(3)).resolves.toMatchObject({ memoryPressure: "unknown" });
  });

  it("does not report Windows' unsupported load average as zero", async () => {
    probes.platform.mockReturnValue("win32");
    await expect(readHostResourceSummary(3)).resolves.toMatchObject({
      load1m: null,
      cpuCores: 8,
      memoryPressure: "unknown",
      level: "normal",
    });
    expect(probes.execFile).not.toHaveBeenCalled();
  });

  it.each([
    { load1m: 10, count: 0, longestMs: 0, level: "strained" },
    { load1m: 16, count: 0, longestMs: 0, level: "strained" },
    { load1m: 2, count: 2, longestMs: 2_100, level: "strained" },
    { load1m: 2, count: 1, longestMs: 5_000, level: "strained" },
    { load1m: 16, count: 2, longestMs: 2_100, level: "severe" },
    { load1m: 2, count: 1, longestMs: 15_000, level: "severe" },
  ])("rates load $load1m and stalls $count/$longestMs ms as $level", async (sample) => {
    probes.platform.mockReturnValue("linux");
    probes.loadavg.mockReturnValue([sample.load1m, 0, 0]);
    probes.recentLocalRuntimeStalls.mockReturnValue({
      count: sample.count,
      longestMs: sample.longestMs,
    });
    await expect(readHostResourceSummary(3)).resolves.toMatchObject({
      memoryPressure: "unknown",
      level: sample.level,
    });
  });

  it("shares one pressure probe across simultaneous reads", async () => {
    const started = Promise.withResolvers<ProbeCallback>();
    probes.execFile.mockImplementation((_file, _args, _options, done) => started.resolve(done));
    const first = readHostResourceSummary(4);
    const complete = await started.promise;
    const second = readHostResourceSummary(5);
    complete(null, "1\n");

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { memoryPressure: "normal", runningSessions: 4 },
      { memoryPressure: "normal", runningSessions: 5 },
    ]);
    expect(probes.execFile).toHaveBeenCalledTimes(1);
  });
});
