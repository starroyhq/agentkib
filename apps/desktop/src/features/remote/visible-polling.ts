import { desktopApi } from "@/core/desktop";

type Poll = {
  interval: number | (() => number);
  enabled(): boolean;
  run(): Promise<void>;
  lastRunAt: number;
};
const polls = new Set<Poll>();
let timer: ReturnType<typeof setTimeout> | undefined;
let active = true;
let releaseActivity: (() => void) | undefined;

function visible() {
  return active && document.visibilityState !== "hidden";
}
function dueAt(poll: Poll) {
  return poll.lastRunAt + (typeof poll.interval === "function" ? poll.interval() : poll.interval);
}

export function updateVisiblePolling() {
  clearTimeout(timer);
  timer = undefined;
  if (!visible()) return;
  const due = [...polls].filter((poll) => poll.enabled()).map(dueAt);
  if (!due.length) return;
  timer = setTimeout(
    () => {
      const now = Date.now();
      for (const poll of polls) {
        if (!poll.enabled() || dueAt(poll) > now) continue;
        poll.lastRunAt = now;
        void poll.run().finally(updateVisiblePolling);
      }
      updateVisiblePolling();
    },
    Math.max(0, Math.min(...due) - Date.now()),
  );
}

function resume() {
  if (visible()) {
    for (const poll of polls) {
      poll.lastRunAt = Date.now();
      void poll.run().finally(updateVisiblePolling);
    }
  }
  updateVisiblePolling();
}

/** One wake-up timer shared by remote panels, catalogs and Web settings. */
export function subscribeVisiblePolling(options: Omit<Poll, "lastRunAt">) {
  if (!polls.size) {
    active = true;
    document.addEventListener("visibilitychange", resume);
    try {
      releaseActivity = desktopApi().events?.onWindowActivity?.((value) => {
        const changed = active !== value;
        active = value;
        if (changed) resume();
      });
    } catch {
      // Browser-only previews have no Electron activity bridge.
    }
  }
  const poll = { ...options, lastRunAt: Date.now() };
  polls.add(poll);
  if (visible()) void poll.run().finally(updateVisiblePolling);
  updateVisiblePolling();
  return () => {
    polls.delete(poll);
    if (!polls.size) {
      document.removeEventListener("visibilitychange", resume);
      releaseActivity?.();
      releaseActivity = undefined;
    }
    updateVisiblePolling();
  };
}

export function isRemoteViewActive() {
  return visible();
}
