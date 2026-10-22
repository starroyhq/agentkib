import { desktopApi } from "@/core/desktop";
import { useSyncExternalStore } from "react";
import type { WebAdminRequest, WebAdminStatus } from "../../../electron/main/web/service";
import { subscribeVisiblePolling, updateVisiblePolling } from "./visible-polling";

type Listener = { status(value: WebAdminStatus): void; error(): void; success?(): void };
type Channel = {
  listeners: Set<Listener>;
  snapshot?: WebAdminStatus;
  revision: number;
  busy: number;
  inFlight: boolean;
  release?: () => void;
};
const channels = new Map<string, Channel>();
type AdminState = { busy: boolean; configurationUncertain: boolean };
const adminListeners = new Set<() => void>();
let requests = 0;
let localAdminState: AdminState = { busy: false, configurationUncertain: false };
let lanAdminState: AdminState = { busy: false, configurationUncertain: false };
function updateAdminState(target?: "lan", configurationUncertain?: boolean) {
  const update = (previous: AdminState, matches: boolean): AdminState => {
    const next = {
      busy: requests > 0,
      configurationUncertain:
        matches && configurationUncertain !== undefined
          ? configurationUncertain
          : previous.configurationUncertain,
    };
    return next.busy === previous.busy &&
      next.configurationUncertain === previous.configurationUncertain
      ? previous
      : next;
  };
  const previousLocal = localAdminState;
  const previousLan = lanAdminState;
  localAdminState = update(localAdminState, target !== "lan");
  lanAdminState = update(lanAdminState, target === "lan");
  if (previousLocal !== localAdminState || previousLan !== lanAdminState)
    adminListeners.forEach((listener) => listener());
}
export function getWebAdminState(target?: "lan") {
  return target === "lan" ? lanAdminState : localAdminState;
}
function subscribeAdminState(listener: () => void) {
  adminListeners.add(listener);
  return () => {
    adminListeners.delete(listener);
  };
}
/** Pending writes and failed configure results outlive every settings controller. */
export function useWebAdminState(target?: "lan") {
  return useSyncExternalStore(subscribeAdminState, () => getWebAdminState(target));
}
function channelFor(target?: "lan") {
  const key = target ?? "local";
  let channel = channels.get(key);
  if (!channel) {
    channel = { listeners: new Set(), revision: 0, busy: 0, inFlight: false };
    channels.set(key, channel);
  }
  return channel;
}
function publish(channel: Channel, snapshot: WebAdminStatus) {
  channel.listeners.forEach((listener) => listener.success?.());
  if (JSON.stringify(channel.snapshot) === JSON.stringify(snapshot)) return;
  channel.snapshot = snapshot;
  channel.listeners.forEach((listener) => listener.status(snapshot));
}

export function subscribeWebStatus(target: "lan" | undefined, listener: Listener) {
  const channel = channelFor(target);
  channel.listeners.add(listener);
  if (channel.snapshot) listener.status(channel.snapshot);
  if (!channel.release)
    channel.release = subscribeVisiblePolling({
      interval: 2_000,
      enabled: () =>
        Boolean(
          // LAN settings need fresh interface choices even before the listener is enabled.
          // The shared scheduler still suspends hidden/locked views and unsubscribes on close.
          target === "lan" ||
          !channel.snapshot ||
          channel.snapshot.running ||
          channel.snapshot.pending.length ||
          channel.snapshot.code,
        ),
      run: async () => {
        if (channel.inFlight || channel.busy) return;
        const revision = channel.revision;
        channel.inFlight = true;
        try {
          const snapshot = await desktopApi().web.request({
            operation: "status",
            ...(target ? { target } : {}),
          });
          if (revision === channel.revision) publish(channel, snapshot);
        } catch {
          if (revision === channel.revision) channel.listeners.forEach((item) => item.error());
        } finally {
          channel.inFlight = false;
        }
      },
    });
  return () => {
    channel.listeners.delete(listener);
    if (!channel.listeners.size) {
      channel.release?.();
      channels.delete(target ?? "local");
      channel.revision += 1;
    }
  };
}

export async function requestWebAdmin(input: WebAdminRequest) {
  const channel = channelFor(input.target);
  channel.revision += 1;
  channel.busy += 1;
  requests += 1;
  updateAdminState();
  try {
    const snapshot = await desktopApi().web.request(input);
    if (input.operation === "configure") updateAdminState(input.target, false);
    publish(channel, snapshot);
    return snapshot;
  } catch (error) {
    // Configure can change the service's in-memory config before persistence rejects.
    // Status reads cannot prove that config reached disk, even after every view closes.
    if (input.operation === "configure") updateAdminState(input.target, true);
    throw error;
  } finally {
    // Invalidate reads admitted before or during the operation for every subscriber.
    channel.revision += 1;
    channel.busy -= 1;
    requests -= 1;
    updateAdminState();
    updateVisiblePolling();
  }
}
