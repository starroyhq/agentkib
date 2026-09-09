import { desktopApi } from "@/core/desktop";
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
function channelFor() {
  const key = "local";
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

export function subscribeWebStatus(listener: Listener) {
  const channel = channelFor();
  channel.listeners.add(listener);
  if (channel.snapshot) listener.status(channel.snapshot);
  if (!channel.release)
    channel.release = subscribeVisiblePolling({
      interval: 2_000,
      enabled: () =>
        Boolean(
          channel.snapshot &&
          (channel.snapshot.running || channel.snapshot.pending.length || channel.snapshot.code),
        ),
      run: async () => {
        if (channel.inFlight || channel.busy) return;
        const revision = channel.revision;
        channel.inFlight = true;
        try {
          const snapshot = await desktopApi().web.request({
            operation: "status",
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
      channels.delete("local");
      channel.revision += 1;
    }
  };
}

export async function requestWebAdmin(input: WebAdminRequest) {
  const channel = channelFor();
  channel.revision += 1;
  channel.busy += 1;
  try {
    const snapshot = await desktopApi().web.request(input);
    publish(channel, snapshot);
    return snapshot;
  } finally {
    // Invalidate reads admitted before or during the operation for every subscriber.
    channel.revision += 1;
    channel.busy -= 1;
    updateVisiblePolling();
  }
}
