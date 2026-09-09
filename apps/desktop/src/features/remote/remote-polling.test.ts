// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "@/core/api";
import type { RemoteStatus } from "@/core/remote-types";
import { subscribeRemoteStatus, useRemoteStore } from "./remote-store";
import { requestWebAdmin, subscribeWebStatus } from "./web-status";

const bridge = vi.hoisted(() => ({
  web: vi.fn(),
  activity: undefined as ((active: boolean) => void) | undefined,
}));
vi.mock("@/core/api", () => ({ api: { remoteRequest: vi.fn() } }));
vi.mock("@/core/desktop", () => ({
  desktopApi: () => ({
    web: { request: bridge.web },
    events: {
      onWindowActivity: (listener: (active: boolean) => void) => {
        bridge.activity = listener;
        return () => {
          bridge.activity = undefined;
        };
      },
    },
  }),
}));
const status: RemoteStatus = {
  local: { id: "local", name: "Desk", enabled: false, address: null },
  interfaces: [],
  discovered: [],
  pending: [],
  authorized: [],
  connections: [],
  pairing_code: null,
  pairing_expires_at: null,
};
const releases: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.mocked(api.remoteRequest).mockReset().mockResolvedValue(status);
  bridge.web.mockReset();
  useRemoteStore.setState({
    snapshot: null,
    pairing: null,
    loading: false,
    busy: false,
    error: "",
    operationError: false,
  });
});
afterEach(() => {
  releases.splice(0).forEach((release) => release());
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("shares status requests and stops waking when remote features are idle", async () => {
  releases.push(subscribeRemoteStatus(() => {}));
  releases.push(subscribeRemoteStatus(() => {}, 2_000));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.remoteRequest).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the fastest active remote subscription and returns to catalog cadence on close", async () => {
  vi.mocked(api.remoteRequest).mockResolvedValue({
    ...status,
    local: { ...status.local, enabled: true },
  });
  releases.push(subscribeRemoteStatus(() => {}));
  await vi.advanceTimersByTimeAsync(0);
  expect(api.remoteRequest).toHaveBeenCalledTimes(1);
  const closePanel = subscribeRemoteStatus(() => {}, 2_000);
  releases.push(closePanel);
  await vi.advanceTimersByTimeAsync(0);
  // Opening the panel refreshes once; changing cadence creates no additional request.
  expect(api.remoteRequest).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1_999);
  expect(api.remoteRequest).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(api.remoteRequest).toHaveBeenCalledTimes(3);
  closePanel();
  await vi.advanceTimersByTimeAsync(4_999);
  expect(api.remoteRequest).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(api.remoteRequest).toHaveBeenCalledTimes(4);
});

it("preserves snapshot identity and suspends all UI reads while hidden or locked", async () => {
  const sharing = { ...status, local: { ...status.local, enabled: true } };
  vi.mocked(api.remoteRequest).mockImplementation(async () => structuredClone(sharing));
  releases.push(subscribeRemoteStatus(() => {}));
  releases.push(subscribeRemoteStatus(() => {}));
  await vi.advanceTimersByTimeAsync(0);
  const initial = useRemoteStore.getState().snapshot;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(api.remoteRequest).toHaveBeenCalledTimes(2);
  expect(useRemoteStore.getState().snapshot).toBe(initial);
  bridge.activity?.(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.remoteRequest).toHaveBeenCalledTimes(2);
  bridge.activity?.(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.remoteRequest).toHaveBeenCalledTimes(3);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.remoteRequest).toHaveBeenCalledTimes(3);
});

it("shares Web status subscribers, publishes only changes and gates polling after mutations", async () => {
  const snapshot = {
    config: { enabled: false, port: 1421, externalOrigin: "", experimentalEnabled: false },
    running: false,
    localUrl: "http://127.0.0.1:1421",
    pending: [],
    devices: [],
  };
  bridge.web.mockResolvedValue(snapshot);
  const first = vi.fn();
  const second = vi.fn();
  releases.push(subscribeWebStatus(undefined, { status: first, error: vi.fn() }));
  releases.push(subscribeWebStatus(undefined, { status: second, error: vi.fn() }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(bridge.web).toHaveBeenCalledTimes(1);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  bridge.web.mockResolvedValue({ ...snapshot, running: true });
  await requestWebAdmin({ operation: "generate-code" });
  await vi.advanceTimersByTimeAsync(5_000);
  expect(bridge.web.mock.calls.length).toBeGreaterThan(2);
  expect(first).toHaveBeenCalledTimes(2);
  bridge.activity?.(false);
  const calls = bridge.web.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(bridge.web).toHaveBeenCalledTimes(calls);
});
