import { afterEach, describe, expect, it, vi } from "vitest";
import { ElectronRefreshCoordinator, type QuotaScheduleState } from "./refresh-coordinator";
import { RUNTIME_METHODS as M } from "../generated/runtime-protocol";
import type { DesktopRuntimeHost } from "./runtime-host";

const coordinators: ElectronRefreshCoordinator[] = [];
afterEach(() => {
  coordinators.forEach((item) => item.stop());
  coordinators.length = 0;
  vi.useRealTimers();
});
function setup(saved?: QuotaScheduleState, missingCache = false) {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
  const state = {
    visible: true,
    enabled: true,
    quota: true,
    failQuota: false,
    noCache: missingCache,
    failLocal: false,
  };
  const request = vi.fn(async (method: string): Promise<unknown> => {
    if (method === M.runtimeInfo)
      return { local_auto_refresh_enabled: state.enabled, quota_auto_refresh_enabled: state.quota };
    if (method === M.discoveryReport)
      return state.noCache ? undefined : { finished_at: new Date().toISOString() };
    if (method === M.insightsStatus)
      return state.noCache ? {} : { refreshed_at: new Date().toISOString() };
    if (method === M.quotaCollectorStatus) return { last_success_at: "2026-09-09T00:00:00Z" };
    if (method === M.quotaSnapshot) return { freshness: "stale", providers: [] };
    if (method === M.listRemoteGateways) return [];
    if (state.failLocal && (method === M.refreshDiscovery || method === M.refreshInsights))
      throw new Error("read failed");
    if (method === M.refreshQuota && state.failQuota) throw new Error("all providers failed");
    return undefined;
  });
  const save = vi.fn(async (_state: QuotaScheduleState) => undefined);
  const coordinator = new ElectronRefreshCoordinator({
    runtime: () => ({ request }) as unknown as DesktopRuntimeHost,
    isMainWindowVisible: () => state.visible,
    onStatus: vi.fn(),
    onQuotaSnapshot: vi.fn(),
    loadQuotaSchedule: async () => saved,
    saveQuotaSchedule: save,
  });
  coordinators.push(coordinator);
  coordinator.start();
  return { coordinator, request, state, save };
}
const calls = (request: ReturnType<typeof vi.fn>, method: string) =>
  request.mock.calls.filter(([value]) => value === method).length;

describe("energy-aware refresh scheduling", () => {
  it("keeps the foreground discovery and statistics intervals", async () => {
    const { request } = setup();
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(calls(request, M.refreshDiscovery)).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(calls(request, M.refreshDiscovery)).toBe(1);
    expect(calls(request, M.refreshInsights)).toBe(0);
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(calls(request, M.refreshInsights)).toBe(1);
  });
  it("honors both failed-quota backoff and the background minimum after runtime recovery", async () => {
    const { coordinator, request, state } = setup();
    await vi.advanceTimersByTimeAsync(0);
    state.failQuota = true;
    await expect(coordinator.request("quota", true)).rejects.toThrow();
    state.visible = false;
    coordinator.setRuntimeAvailable(false);
    coordinator.setRuntimeAvailable(true);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    expect(calls(request, M.refreshQuota)).toBe(1);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(calls(request, M.refreshQuota)).toBe(2);
  });

  it("initializes a missing local cache once even when auto refresh is off, without retrying failures", async () => {
    const { request, state } = setup(undefined, true);
    state.noCache = true;
    state.enabled = false;
    state.failLocal = true;
    await vi.advanceTimersByTimeAsync(35 * 60_000);
    expect(calls(request, M.refreshDiscovery)).toBe(1);
    expect(calls(request, M.refreshInsights)).toBe(1);
  });
  it.each([false, true])(
    "upgrades queued automatic work for manual requests (force=%s)",
    async (force) => {
      const { coordinator, request, state } = setup();
      await vi.advanceTimersByTimeAsync(0);
      let release!: () => void;
      request.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const blocking = coordinator.request("storage", true);
      await vi.advanceTimersByTimeAsync(0);
      const queued = coordinator.request("discovery", false, true);
      state.visible = false;
      expect((await coordinator.request("discovery", force)).disposition).toBe("already-running");
      release();
      await blocking;
      await queued;
      expect(calls(request, M.refreshDiscovery)).toBe(1);
    },
  );

  it("does not let stale quota bypass five minutes; hidden quota waits fifteen minutes", async () => {
    const { request, state } = setup();
    await vi.advanceTimersByTimeAsync(181_000);
    expect(calls(request, M.refreshQuota)).toBe(0);
    state.visible = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(calls(request, M.refreshQuota)).toBe(0);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(calls(request, M.refreshQuota)).toBe(1);
  });
  it("pauses local refresh hidden or disabled and merges delayed window checks", async () => {
    const { coordinator, request, state } = setup();
    state.visible = false;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(calls(request, M.refreshDiscovery)).toBe(0);
    expect(calls(request, M.refreshInsights)).toBe(0);
    state.visible = true;
    state.enabled = false;
    coordinator.activityChanged();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls(request, M.refreshInsights)).toBe(0);
    state.enabled = true;
    coordinator.activityChanged();
    coordinator.activityChanged();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls(request, M.refreshInsights)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls(request, M.refreshInsights)).toBe(1);
    expect(calls(request, M.refreshDiscovery)).toBe(1);
  });
  it("stops timers during suspension while allowing explicit manual refresh", async () => {
    const { coordinator, request } = setup();
    await vi.advanceTimersByTimeAsync(31_000);
    coordinator.setSuspended(true);
    request.mockClear();
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(request).not.toHaveBeenCalled();
    await coordinator.request("insights", true);
    expect(calls(request, M.refreshInsights)).toBe(1);
    coordinator.setSuspended(false);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls(request, M.refreshDiscovery)).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls(request, M.refreshDiscovery)).toBe(1);
  });
  it("restores backoff and last attempt across coordinator restarts", async () => {
    const { coordinator, request, state, save } = setup({
      failures: 2,
      lastAttemptAt: "2026-09-09T00:00:00Z",
      nextAllowedAt: "2026-09-09T00:30:00Z",
    });
    await vi.advanceTimersByTimeAsync(16 * 60_000);
    expect(calls(request, M.refreshQuota)).toBe(0);
    state.failQuota = true;
    await expect(coordinator.request("quota", true)).rejects.toThrow("all providers failed");
    expect(save.mock.calls.at(-1)?.[0]).toMatchObject({
      failures: 3,
      nextAllowedAt: "2026-09-09T00:46:00.000Z",
    });
  });
  it("rechecks queued automatic work before it starts and deduplicates manual requests", async () => {
    const { coordinator, request, state } = setup();
    await vi.advanceTimersByTimeAsync(0);
    let release!: () => void;
    request.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const blocking = coordinator.request("storage", true);
    await vi.advanceTimersByTimeAsync(0);
    const queued = coordinator.request("discovery", false, true);
    expect((await coordinator.request("discovery", false, true)).disposition).toBe(
      "already-running",
    );
    state.visible = false;
    release();
    await blocking;
    await queued;
    expect(calls(request, M.refreshDiscovery)).toBe(0);
  });
});
